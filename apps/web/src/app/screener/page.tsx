"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import s from "@/components/tools/tools.module.css";
import { Badge, EmptyState, Panel, Table, Td, Th } from "@/components/ui";
import { formatPct, formatPrice, formatTimeUTC } from "@/lib/format";
import { getScreener, type ScreenerRow } from "@/lib/user";

type SortKey = "symbol" | "change_24h" | "volume_24h" | "zone" | "atr_percentile" | "funding" | "oi_change_24h" | "beta_btc";

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
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ k: SortKey; d: 1 | -1 }>({ k: "zone", d: 1 });
  const [bias, setBias] = useState("");
  const [near, setNear] = useState("");

  useEffect(() => {
    getScreener()
      .then((r) => {
        setRows(r.items);
        setAt(r.generated_at);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const list = useMemo(() => {
    if (!rows) return [];
    let out = rows.filter((r) => !r.error);
    if (bias) out = out.filter((r) => r.bias === bias);
    if (near) out = out.filter((r) => r.zone && n(r.zone.distance_atr) !== null && n(r.zone.distance_atr)! <= Number(near));
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
  }, [rows, sort, bias, near]);

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
          <select aria-label="bias" value={bias} onChange={(e) => setBias(e.target.value)}>
            <option value="">любой bias</option>
            <option value="long">bias long</option>
            <option value="short">bias short</option>
            <option value="neutral">нейтральный</option>
          </select>
          <select aria-label="до зоны" value={near} onChange={(e) => setNear(e.target.value)}>
            <option value="">любое расстояние до зоны</option>
            <option value="0">в зоне</option>
            <option value="1">до 1 ATR</option>
            <option value="2">до 2 ATR</option>
            <option value="5">до 5 ATR</option>
          </select>
          <span className="caption">{rows ? `${list.length} из ${rows.length}` : ""}</span>
        </div>
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
                  <Th num>{sortBtn("change_24h", "24 ч")}</Th>
                  <Th num>{sortBtn("volume_24h", "Объём 24 ч")}</Th>
                  <Th>D1</Th>
                  <Th>W1</Th>
                  <Th>Последнее событие H4</Th>
                  <Th>{sortBtn("zone", "Зона · ATR")}</Th>
                  <Th num>{sortBtn("atr_percentile", "ATR p")}</Th>
                  <Th num>{sortBtn("funding", "Funding")}</Th>
                  <Th num>{sortBtn("oi_change_24h", "OI 24 ч")}</Th>
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
