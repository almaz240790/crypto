"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import s from "@/components/tools/tools.module.css";
import { Badge, Button, EmptyState, Panel, Table, Td, Th } from "@/components/ui";
import { FREQ_LABEL, STATUS_LABEL, TYPE_LABEL, createAlert, deleteAlert, getAlertTriggers, getAlerts, patchAlert, type Alert, type AlertFrequency, type AlertTrigger, type AlertType, type AlertsList } from "@/lib/alerts";
import { formatTimeUTC } from "@/lib/format";
import { getInstruments, type Instrument } from "@/lib/user";

const PATTERNS = [
  ["engulfing", "поглощение"], ["pin_bar", "пин-бар"], ["doji", "доджи"], ["star", "звезда"], ["three_line", "три солдата / вороны"],
  ["harami", "харами"], ["inside_bar", "внутренний бар"], ["inside_bar_breakout", "пробой внутреннего бара"], ["marubozu", "марубозу"], ["tweezer", "пинцет"],
] as const;
const TFS = ["15m", "1h", "4h", "1d", "1w"];
const FIGURES = [
  ["double_top", "двойная вершина"], ["double_bottom", "двойное дно"], ["head_shoulders", "голова и плечи"], ["inv_head_shoulders", "перевёрнутые голова и плечи"],
  ["triangle_sym", "симметричный треугольник"], ["triangle_asc", "восходящий треугольник"], ["triangle_desc", "нисходящий треугольник"], ["flag", "флаг"], ["pennant", "вымпел"],
  ["wedge_rising", "восходящий клин"], ["wedge_falling", "нисходящий клин"], ["channel_up", "восходящий канал"], ["channel_down", "нисходящий канал"], ["range", "диапазон"], ["cup_handle", "чашка с ручкой"],
] as const;

type Draft = { symbol: string; type: AlertType; timeframe: string; frequency: AlertFrequency; expires_in_days: number; note: string; op: string; price: string; price2: string; indicator: string; period: string; value: string; kind: string; dir: string; event: string; types: string[]; significant_only: boolean };
const EMPTY: Draft = { symbol: "BTCUSDT", type: "price", timeframe: "4h", frequency: "once", expires_in_days: 30, note: "", op: "cross_up", price: "", price2: "", indicator: "rsi", period: "", value: "", kind: "any", dir: "any", event: "any", types: [], significant_only: false };

function toBody(d: Draft) {
  const condition: Record<string, unknown> =
    d.type === "price"
      ? { op: d.op, price: d.price, ...(d.op === "enter_range" ? { price2: d.price2 } : {}) }
      : d.type === "indicator"
        ? { indicator: d.indicator, op: d.op, ...(d.period ? { period: Number(d.period) } : {}), ...(d.op.startsWith("price_") ? {} : { value: d.value }) }
        : d.type === "zone"
          ? { kind: d.kind, dir: d.dir }
          : d.type === "structure"
            ? { event: d.event, dir: d.dir }
            : d.type === "figure"
              ? { types: d.types, dir: d.dir }
              : { types: d.types, dir: d.dir, significant_only: d.significant_only };
  return { symbol: d.symbol || null, type: d.type, timeframe: d.type === "price" ? null : (d.type === "pattern" || d.type === "figure") && d.timeframe === "any" ? null : d.timeframe, condition, frequency: d.frequency, expires_in_days: d.expires_in_days, note: d.note || null };
}

export default function AlertsPage() {
  const [list, setList] = useState<AlertsList | null>(null);
  const [triggers, setTriggers] = useState<(AlertTrigger & { alert: Alert })[]>([]);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [d, setD] = useState<Draft>(EMPTY);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const say = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 3000);
  };
  const load = useCallback(async () => {
    const [l, t] = await Promise.all([getAlerts(), getAlertTriggers(50)]);
    setList(l);
    setTriggers(t.items);
  }, []);
  useEffect(() => {
    queueMicrotask(() => load().catch((e: Error) => say(e.message)));
    getInstruments()
      .then(setInstruments)
      .catch(() => {});
  }, [load]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const onType = (t: AlertType) => setD((p) => ({ ...p, type: t, types: [], op: t === "price" ? "cross_up" : t === "indicator" ? "above" : p.op, timeframe: t === "zone" || t === "structure" ? (["4h", "1d"].includes(p.timeframe) ? p.timeframe : "4h") : t === "figure" ? (["4h", "1d", "1w", "any"].includes(p.timeframe) ? p.timeframe : "4h") : p.timeframe }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const a = await createAlert(toBody(d));
      say(`Алерт создан: ${a.text}`);
      setD((p) => ({ ...p, price: "", price2: "", value: "", note: "" }));
      await load();
    } catch (err) {
      say((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (a: Alert) => {
    try {
      await patchAlert(a.id, { status: a.status === "active" ? "paused" : "active" });
      await load();
    } catch (err) {
      say((err as Error).message);
    }
  };
  const remove = async (a: Alert) => {
    if (!confirm(`Удалить алерт «${a.text}»?`)) return;
    await deleteAlert(a.id);
    await load();
  };
  const tone = (st: Alert["status"]) => (st === "active" ? "up" : st === "triggered" ? "accent" : "muted");
  return (
    <AppShell title="Алерты">
      {toast && (
        <p role="status" className="caption">
          {toast}
        </p>
      )}
      <div className={s.grid}>
        <Panel>
          <h2>Новый алерт</h2>
          <p className="caption">
            Цена проверяется по минутным свечам (до 60 с), индикаторы, зоны и структура — на закрытии свечи таймфрейма, паттерны — после подтверждения на закрытии свечи. Доставка — push и письмо по <Link href="/settings">настройкам уведомлений</Link>.
            {list?.limit != null && ` Активных: ${list.active} из ${list.limit}.`}
          </p>
          <form onSubmit={submit} className={s.form} aria-label="новый алерт">
            <label>
              тип
              <select aria-label="тип алерта" value={d.type} onChange={(e) => onType(e.target.value as AlertType)}>
                {(Object.keys(TYPE_LABEL) as AlertType[]).map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              инструмент
              <select aria-label="инструмент алерта" value={d.symbol} onChange={(e) => set("symbol", e.target.value)}>
                {(d.type === "pattern" || d.type === "figure") && <option value="">вотчлист</option>}
                {(instruments.length ? instruments.map((i) => i.symbol) : ["BTCUSDT", "ETHUSDT"]).map((sym) => (
                  <option key={sym} value={sym}>
                    {sym}
                  </option>
                ))}
              </select>
            </label>
            {d.type !== "price" && (
              <label>
                таймфрейм
                <select aria-label="таймфрейм алерта" value={d.timeframe} onChange={(e) => set("timeframe", e.target.value)}>
                  {(d.type === "pattern" || d.type === "figure") && <option value="any">любой</option>}
                  {(d.type === "zone" || d.type === "structure" ? ["4h", "1d"] : d.type === "figure" ? ["4h", "1d", "1w"] : TFS).map((t) => (
                    <option key={t} value={t}>
                      {t === "4h" ? "H4" : t.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {d.type === "price" && (
              <>
                <label>
                  условие
                  <select aria-label="условие цены" value={d.op} onChange={(e) => set("op", e.target.value)}>
                    <option value="cross_up">пересечение вверх</option>
                    <option value="cross_down">пересечение вниз</option>
                    <option value="enter_range">вход в диапазон</option>
                  </select>
                </label>
                <label>
                  цена
                  <input aria-label="цена" inputMode="decimal" required value={d.price} onChange={(e) => set("price", e.target.value)} />
                </label>
                {d.op === "enter_range" && (
                  <label>
                    вторая граница
                    <input aria-label="вторая граница" inputMode="decimal" required value={d.price2} onChange={(e) => set("price2", e.target.value)} />
                  </label>
                )}
              </>
            )}
            {d.type === "indicator" && (
              <>
                <label>
                  индикатор
                  <select aria-label="индикатор" value={d.indicator} onChange={(e) => { set("indicator", e.target.value); if (e.target.value !== "ema" && d.op.startsWith("price_")) set("op", "above"); }}>
                    <option value="rsi">RSI</option>
                    <option value="ema">EMA</option>
                    <option value="atr">ATR</option>
                  </select>
                </label>
                <label>
                  период
                  <input aria-label="период" inputMode="numeric" placeholder={d.indicator === "ema" ? "50" : "14"} value={d.period} onChange={(e) => set("period", e.target.value)} />
                </label>
                <label>
                  условие
                  <select aria-label="условие индикатора" value={d.op} onChange={(e) => set("op", e.target.value)}>
                    <option value="above">выше порога</option>
                    <option value="below">ниже порога</option>
                    <option value="cross_up">пересёк порог вверх</option>
                    <option value="cross_down">пересёк порог вниз</option>
                    {d.indicator === "ema" && <option value="price_cross_up">цена пересекла EMA вверх</option>}
                    {d.indicator === "ema" && <option value="price_cross_down">цена пересекла EMA вниз</option>}
                  </select>
                </label>
                {!d.op.startsWith("price_") && (
                  <label>
                    порог
                    <input aria-label="порог" inputMode="decimal" required value={d.value} onChange={(e) => set("value", e.target.value)} />
                  </label>
                )}
              </>
            )}
            {d.type === "zone" && (
              <label>
                зона
                <select aria-label="вид зоны" value={d.kind} onChange={(e) => set("kind", e.target.value)}>
                  <option value="any">любая</option>
                  <option value="ob">OB</option>
                  <option value="sd">S/D</option>
                  <option value="fvg">FVG</option>
                </select>
              </label>
            )}
            {d.type === "structure" && (
              <label>
                событие
                <select aria-label="событие структуры" value={d.event} onChange={(e) => set("event", e.target.value)}>
                  <option value="any">BOS или CHoCH</option>
                  <option value="bos">BOS</option>
                  <option value="choch">CHoCH</option>
                </select>
              </label>
            )}
            {d.type === "pattern" && (
              <fieldset className={s.fieldset}>
                <legend>паттерны (пусто — любые)</legend>
                {PATTERNS.map(([id, label]) => (
                  <label key={id} className={s.inline}>
                    <input type="checkbox" checked={d.types.includes(id)} onChange={(e) => set("types", e.target.checked ? [...d.types, id] : d.types.filter((x) => x !== id))} /> {label}
                  </label>
                ))}
                <label className={s.inline}>
                  <input type="checkbox" checked={d.significant_only} onChange={(e) => set("significant_only", e.target.checked)} /> только значимые
                </label>
              </fieldset>
            )}
            {d.type === "figure" && (
              <fieldset className={s.fieldset}>
                <legend>фигуры (пусто — любые)</legend>
                {FIGURES.map(([id, label]) => (
                  <label key={id} className={s.inline}>
                    <input type="checkbox" checked={d.types.includes(id)} onChange={(e) => set("types", e.target.checked ? [...d.types, id] : d.types.filter((x) => x !== id))} /> {label}
                  </label>
                ))}
              </fieldset>
            )}
            {d.type !== "price" && d.type !== "indicator" && (
              <label>
                направление
                <select aria-label="направление" value={d.dir} onChange={(e) => set("dir", e.target.value)}>
                  <option value="any">любое</option>
                  <option value="up">вверх / бычье</option>
                  <option value="down">вниз / медвежье</option>
                </select>
              </label>
            )}
            <label>
              срабатывание
              <select aria-label="частота" value={d.frequency} onChange={(e) => set("frequency", e.target.value as AlertFrequency)}>
                {(Object.keys(FREQ_LABEL) as AlertFrequency[]).map((f) => (
                  <option key={f} value={f}>
                    {FREQ_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              срок, дней
              <input aria-label="срок в днях" inputMode="numeric" value={String(d.expires_in_days)} onChange={(e) => set("expires_in_days", Math.max(1, Math.min(365, Number(e.target.value) || 30)))} />
            </label>
            <label>
              заметка
              <input aria-label="заметка" maxLength={140} value={d.note} onChange={(e) => set("note", e.target.value)} />
            </label>
            <Button type="submit" disabled={busy}>
              Создать алерт
            </Button>
          </form>
        </Panel>
        <Panel>
          <h2>Мои алерты</h2>
          {list === null ? (
            <p className="caption">загрузка…</p>
          ) : list.items.length === 0 ? (
            <EmptyState text="Алертов пока нет. Создайте первый слева или перетащите линию на графике." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>условие</Th>
                  <Th>срабатывание</Th>
                  <Th>статус</Th>
                  <Th>последнее</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {list.items.map((a) => (
                  <tr key={a.id} data-testid="alert-row">
                    <Td>
                      {a.symbol ? <Link href={`/chart/${a.symbol}/${a.timeframe ?? "4h"}`}>{a.text}</Link> : a.text}
                      {a.note && <div className="caption">{a.note}</div>}
                    </Td>
                    <Td mobile="hidden">{FREQ_LABEL[a.frequency]}</Td>
                    <Td>
                      <Badge tone={tone(a.status)}>{STATUS_LABEL[a.status]}</Badge>
                    </Td>
                    <Td mobile="hidden">{a.last_triggered_at ? `${formatTimeUTC(a.last_triggered_at)} (${a.triggers_count})` : "—"}</Td>
                    <Td mobile="right">
                      {(a.status === "active" || a.status === "paused" || a.status === "triggered") && (
                        <button type="button" className={s.linkBtn} onClick={() => toggle(a)} aria-label={`${a.status === "active" ? "пауза" : "включить"} ${a.text}`}>
                          {a.status === "active" ? "пауза" : "включить"}
                        </button>
                      )}{" "}
                      <button type="button" className={s.linkBtn} onClick={() => remove(a)} aria-label={`удалить ${a.text}`}>
                        удалить
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
      <Panel>
        <h2>Журнал срабатываний</h2>
        {triggers.length === 0 ? (
          <EmptyState text="Срабатываний пока не было." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>время (UTC)</Th>
                <Th>условие</Th>
                <Th num>цена</Th>
                <Th>доставка</Th>
              </tr>
            </thead>
            <tbody>
              {triggers.map((t) => (
                <tr key={t.id}>
                  <Td>{formatTimeUTC(t.triggered_at, { withYear: true })}</Td>
                  <Td>
                    {t.alert.text}
                    {typeof t.details.title === "string" ? ` — ${t.details.title}` : ""}
                  </Td>
                  <Td num>{t.price ?? "—"}</Td>
                  <Td mobile="hidden">{t.notified ? "отправлено" : "без уведомления"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </AppShell>
  );
}
