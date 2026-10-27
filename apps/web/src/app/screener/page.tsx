"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { Sparkline } from "@/components/signals/Sparkline";
import { useAuth } from "@/components/auth/AuthProvider";
import s from "@/components/tools/tools.module.css";
import { Badge, Button, EmptyState, Panel, Table, Td, Th } from "@/components/ui";
import { createAlert } from "@/lib/alerts";
import { getAccessToken } from "@/lib/auth-client";
import { formatPct, formatPrice, formatTimeUTC } from "@/lib/format";
import { EMPTY_FILTERS, deleteScreen, getScreener, getScreens, putScreen, type SavedScreen, type ScreenerFilters, type ScreenerRow } from "@/lib/user";

/** Применение фильтров (план 3.6 v2) — чистая функция, одна на таблицу и экспорт. */
export function applyFilters(rows: ScreenerRow[], f: ScreenerFilters): ScreenerRow[] {
  let out = rows.filter((r) => !r.error);
  if (f.bias) out = out.filter((r) => r.bias === f.bias);
  if (f.near) out = out.filter((r) => r.zone && n(r.zone.distance_atr) !== null && n(r.zone.distance_atr)! <= Number(f.near));
  if (f.d1) out = out.filter((r) => r.d1_trend === f.d1);
  if (f.w1) out = out.filter((r) => r.w1_trend === f.w1);
  if (f.event) out = out.filter((r) => r.last_event && `${r.last_event.type}_${r.last_event.direction}` === f.event);
  if (f.atrp === "low") out = out.filter((r) => n(r.atr_percentile) !== null && n(r.atr_percentile)! < 30);
  if (f.atrp === "high") out = out.filter((r) => n(r.atr_percentile) !== null && n(r.atr_percentile)! > 70);
  if (f.funding === "pos") out = out.filter((r) => (n(r.funding) ?? 0) > 0);
  if (f.funding === "neg") out = out.filter((r) => (n(r.funding) ?? 0) < 0);
  if (f.change === "up3") out = out.filter((r) => (n(r.change_24h) ?? 0) >= 3);
  if (f.change === "down3") out = out.filter((r) => (n(r.change_24h) ?? 0) <= -3);
  if (f.zone_kind) out = out.filter((r) => r.zone?.kind === f.zone_kind);
  return out;
}

type SortKey = "symbol" | "change_24h" | "volume_24h" | "zone" | "atr_percentile" | "funding" | "oi_change_24h" | "ls_ratio" | "beta_btc";

function n(x: string | null | undefined): number | null {
  if (x === null || x === undefined) return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function fmtUsd(x: string | null | undefined): string {
  const v = n(x);
  if (v === null) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} млрд`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} млн`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} тыс`;
  return v.toFixed(0);
}

function TrendBadge({ t }: { t?: string }) {
  if (!t) return <span className="text-3">—</span>;
  return <Badge tone={t === "up" ? "up" : t === "down" ? "down" : "muted"}>{t}</Badge>;
}

export default function ScreenerPage() {
  const [rows, setRows] = useState<ScreenerRow[] | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [sparks, setSparks] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ k: SortKey; d: 1 | -1 }>({ k: "zone", d: 1 });
  const [f, setF] = useState<ScreenerFilters>(EMPTY_FILTERS);
  const { user } = useAuth();
  const [screens, setScreens] = useState<SavedScreen[]>([]);
  const [screenName, setScreenName] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const say = useCallback((t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 3000);
  }, []);
  const setFilter = (k: keyof ScreenerFilters, v: string) => setF((p) => ({ ...p, [k]: v }));
  const active = Object.values(f).some(Boolean);

  useEffect(() => {
    getScreener()
      .then((r) => {
        setRows(r.items);
        setAt(r.generated_at);
        setSparks(r.sparklines ?? {});
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!user) return;
    getScreens().then(setScreens).catch(() => {});
  }, [user]);

  async function saveScreen() {
    const name = screenName.trim();
    if (!name) return;
    try {
      await putScreen(name, f);
      setScreens(await getScreens());
      setScreenName("");
      say(`Скрин «${name}» сохранён`);
    } catch (e) {
      say(e instanceof Error ? e.message : "ошибка");
    }
  }
  async function removeScreen(name: string) {
    await deleteScreen(name).catch(() => {});
    setScreens((p) => p.filter((x) => x.name !== name));
  }
  async function exportCsv(symbols: string[]) {
    const res = await fetch(`/v1/screener/export.csv?symbols=${symbols.join(",")}`, { headers: { authorization: `Bearer ${getAccessToken() ?? ""}` }, credentials: "include" });
    if (!res.ok) {
      say(res.status === 403 ? "Экспорт CSV доступен на тарифе Pro" : `экспорт: ошибка ${res.status}`);
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = "platform-screener.csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  async function zoneAlert(r: ScreenerRow) {
    if (!r.zone) return;
    try {
      await createAlert({ symbol: r.symbol, timeframe: "4h", type: "zone", condition: { kind: r.zone.kind, dir: r.zone.direction }, frequency: "once", note: "из скринера" });
      say(`Алерт создан: ${r.symbol} — возврат в зону ${r.zone.kind.toUpperCase()}`);
    } catch (e) {
      say(e instanceof Error ? e.message : "не удалось создать алерт");
    }
  }

  const list = useMemo(() => {
    if (!rows) return [];
    const out = applyFilters(rows, f);
    const key = (r: ScreenerRow): number | string | null => {
      switch (sort.k) {
        case "symbol":
          return r.symbol;
        case "zone":
          return r.zone ? n(r.zone.distance_atr) : null;
        default:
          return n(r[sort.k] as string | null | undefined);
      }
    };
    return out.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sort.d;
    });
  }, [rows, sort, f]);

  const sortBtn = (k: SortKey, label: string) => (
    <button type="button" className={s.sortBtn} data-active={sort.k === k} onClick={() => setSort({ k, d: sort.k === k ? ((sort.d * -1) as 1 | -1) : k === "symbol" ? 1 : -1 })} aria-label={`сортировать по: ${label}`}>
      {label}
      {sort.k === k ? (sort.d === 1 ? " ↑" : " ↓") : ""}
    </button>
  );

  return (
    <AppShell title="Скринер" actions={at ? <span className="caption">данные на {formatTimeUTC(at)}</span> : undefined}>
      <div className={s.wrap} style={{ maxWidth: "none" }}>
        <div className={s.inline} role="group" aria-label="фильтры">
          <select aria-label="bias" value={f.bias} onChange={(e) => setFilter("bias", e.target.value)}>
            <option value="">любой bias</option>
            <option value="long">bias long</option>
            <option value="short">bias short</option>
            <option value="neutral">нейтральный</option>
          </select>
          <select aria-label="до зоны" value={f.near} onChange={(e) => setFilter("near", e.target.value)}>
            <option value="">любое расстояние до зоны</option>
            <option value="0">в зоне</option>
            <option value="1">до 1 ATR</option>
            <option value="2">до 2 ATR</option>
            <option value="5">до 5 ATR</option>
          </select>
          <select aria-label="вид зоны" value={f.zone_kind} onChange={(e) => setFilter("zone_kind", e.target.value)}>
            <option value="">любая зона</option>
            <option value="ob">OB</option>
            <option value="sd">S/D</option>
            <option value="fvg">FVG</option>
          </select>
          <select aria-label="тренд D1" value={f.d1} onChange={(e) => setFilter("d1", e.target.value)}>
            <option value="">D1 любой</option>
            <option value="up">D1 up</option>
            <option value="down">D1 down</option>
            <option value="flat">D1 flat</option>
          </select>
          <select aria-label="тренд W1" value={f.w1} onChange={(e) => setFilter("w1", e.target.value)}>
            <option value="">W1 любой</option>
            <option value="up">W1 up</option>
            <option value="down">W1 down</option>
            <option value="flat">W1 flat</option>
          </select>
          <select aria-label="событие H4" value={f.event} onChange={(e) => setFilter("event", e.target.value)}>
            <option value="">любое событие</option>
            <option value="bos_up">BOS вверх</option>
            <option value="bos_down">BOS вниз</option>
            <option value="choch_up">CHoCH вверх</option>
            <option value="choch_down">CHoCH вниз</option>
          </select>
          <select aria-label="режим ATR" value={f.atrp} onChange={(e) => setFilter("atrp", e.target.value)}>
            <option value="">любая волатильность</option>
            <option value="low">ATR ниже 30-го перцентиля</option>
            <option value="high">ATR выше 70-го перцентиля</option>
          </select>
          <select aria-label="funding" value={f.funding} onChange={(e) => setFilter("funding", e.target.value)}>
            <option value="">любой funding</option>
            <option value="pos">funding положительный</option>
            <option value="neg">funding отрицательный</option>
          </select>
          <select aria-label="изменение за 24 ч" value={f.change} onChange={(e) => setFilter("change", e.target.value)}>
            <option value="">любое изменение 24 ч</option>
            <option value="up3">рост от 3 %</option>
            <option value="down3">падение от 3 %</option>
          </select>
          {active && (
            <button type="button" className={s.small} onClick={() => setF(EMPTY_FILTERS)}>
              сбросить
            </button>
          )}
          <span className="caption">{rows ? `${list.length} из ${rows.length}` : ""}</span>
        </div>
        <div className={s.inline} role="group" aria-label="скрины">
          {user ? (
            <>
              <select aria-label="сохранённый скрин" value="" onChange={(e) => { const sc = screens.find((x) => x.name === e.target.value); if (sc) setF({ ...EMPTY_FILTERS, ...sc.filters }); }}>
                <option value="">{screens.length ? "применить скрин…" : "сохранённых скринов нет"}</option>
                {screens.map((sc) => (
                  <option key={sc.name} value={sc.name}>
                    {sc.name}
                  </option>
                ))}
              </select>
              <input aria-label="имя скрина" placeholder="имя скрина" maxLength={60} value={screenName} onChange={(e) => setScreenName(e.target.value)} />
              <Button size="sm" onClick={saveScreen} disabled={!screenName.trim() || !active}>
                Сохранить скрин
              </Button>
              {screens.map((sc) => (
                <button key={sc.name} type="button" className={`${s.small} ${s.danger}`} onClick={() => removeScreen(sc.name)} aria-label={`удалить скрин ${sc.name}`}>
                  ✕ {sc.name}
                </button>
              ))}
              <Button size="sm" onClick={() => exportCsv(list.map((r) => r.symbol))} disabled={list.length === 0}>
                CSV
              </Button>
            </>
          ) : (
            <span className="caption">
              <Link href="/login?next=/screener">Войдите</Link>, чтобы сохранять скрины, выгружать CSV и ставить алерты.
            </span>
          )}
        </div>
        {toast && (
          <p className={s.toast} role="status">
            {toast}
          </p>
        )}
        <Panel flush title="Инструменты" footer="Цель скринера — увидеть, что близко к сетапу, до появления сигнала. Расстояние до зоны — в ATR H4. Это не сигнал.">
          {error ? (
            <EmptyState text={`Не удалось загрузить: ${error}`} />
          ) : !rows ? (
            <EmptyState text="Считаем по всем инструментам…" />
          ) : list.length === 0 ? (
            <EmptyState text="По фильтрам ничего нет." />
          ) : (
            <Table compact clickable>
              <thead>
                <tr>
                  <Th>{sortBtn("symbol", "Инструмент")}</Th>
                  <Th num>Цена</Th>
                  <Th>24 свечи H4</Th>
                  <Th num>{sortBtn("change_24h", "24 ч")}</Th>
                  <Th num>{sortBtn("volume_24h", "Объём 24 ч")}</Th>
                  <Th>D1</Th>
                  <Th>W1</Th>
                  <Th>Последнее событие H4</Th>
                  <Th>{sortBtn("zone", "Зона · ATR")}</Th>
                  <Th num>{sortBtn("atr_percentile", "ATR p")}</Th>
                  <Th num>{sortBtn("funding", "Funding")}</Th>
                  <Th num>{sortBtn("oi_change_24h", "OI 24 ч")}</Th>
                  <Th num>{sortBtn("ls_ratio", "L/S")}</Th>
                  <Th num>Ликв. L/S</Th>
                  <Th num>{sortBtn("beta_btc", "β BTC")}</Th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.symbol}>
                    <Td>
                      <Link href={`/signals?symbol=${r.symbol}&tab=all`}>
                        <strong>{r.symbol}</strong>
                      </Link>
                    </Td>
                    <Td num mobile="right">{formatPrice(r.price ?? null)}</Td>
                    <Td mobile="hidden">
                      <Sparkline values={sparks[String(r.instrument_id)] ?? []} up={(n(r.change_24h) ?? 0) >= 0} width={56} height={18} />
                    </Td>
                    <Td num mobile="right" className={(n(r.change_24h) ?? 0) > 0 ? "up" : (n(r.change_24h) ?? 0) < 0 ? "down" : ""}>
                      {formatPct(n(r.change_24h))}
                    </Td>
                    <Td num mobile="hidden">{fmtUsd(r.volume_24h)}</Td>
                    <Td mobile="secondary">
                      <TrendBadge t={r.d1_trend} />
                    </Td>
                    <Td mobile="secondary">
                      <TrendBadge t={r.w1_trend} />
                    </Td>
                    <Td mobile="hidden" className="text-2">
                      {r.last_event ? `${r.last_event.type.toUpperCase()} ${r.last_event.direction} · ${formatTimeUTC(r.last_event.time)}` : "—"}
                    </Td>
                    <Td mobile="secondary">
                      {r.zone ? (
                        <span>
                          {r.zone.kind.toUpperCase()} {r.zone.direction} · <span className="num">{n(r.zone.distance_atr)?.toFixed(2) ?? "—"}</span>
                          {r.zone.status === "touched" ? <span className="caption"> (касание)</span> : null}
                          {user && (
                            <button type="button" className={s.small} onClick={() => zoneAlert(r)} aria-label={`алерт: ${r.symbol} вернётся в зону`} title="Уведомить, когда цена вернётся в зону">
                              🔔
                            </button>
                          )}
                        </span>
                      ) : (
                        <span className="text-3">нет активной</span>
                      )}
                    </Td>
                    <Td num mobile="hidden">{r.atr_percentile ?? "—"}</Td>
                    <Td num mobile="hidden">
                      {r.funding ? `${Number(r.funding).toFixed(4)} %` : "—"}
                      {r.funding_pct ? <span className="caption"> p{r.funding_pct}</span> : null}
                    </Td>
                    <Td num mobile="hidden">{formatPct(n(r.oi_change_24h))}</Td>
                    <Td num mobile="hidden" title={r.ls_top ? `топ-трейдеры ${Number(r.ls_top).toFixed(2)}` : undefined}>{n(r.ls_ratio)?.toFixed(2) ?? "—"}</Td>
                    <Td num mobile="hidden">
                      {fmtUsd(r.liq_long_24h)} / {fmtUsd(r.liq_short_24h)}
                    </Td>
                    <Td num mobile="hidden">{n(r.beta_btc)?.toFixed(2) ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}
