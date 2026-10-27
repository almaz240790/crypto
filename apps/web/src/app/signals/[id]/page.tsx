"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import type { Analysis, ChartCandle, Layer } from "@/components/chart/SignalChart";
import { SignalChart } from "@/components/chart/SignalChart";
import { Button, DirectionBadge, EmptyState, GradeBadge, Input, Panel, Select, StatusBadge } from "@/components/ui";
import Link from "next/link";
import { api, getAccessToken } from "@/lib/auth-client";
import { getPatterns, type PatternOnChart } from "@/lib/chart";
import { formatDuration, formatPct, formatPrice, formatR, formatTimeUTC } from "@/lib/format";
import { journalFromSignal, unrealizedR, type SignalRow } from "@/lib/signals";
import { useLive } from "@/lib/useLive";
import s from "./page.module.css";

type Detail = SignalRow & {
  facts: string[];
  zone: { kind: string; top: string; bottom: string } | null;
  score_breakdown: Record<string, number> | null;
  events: { type: string; price: string | null; at: string; source: string }[];
};

type AnalysisFull = Analysis & {
  bias: { bias: string; d1_trend: string; w1_trend: string; ema50_d1: string | null };
  trade_params: { split: string[]; be_after_tp1: boolean; limit_expiry_candles: number; time_stop_candles: number };
  atr: string | null;
};

const EVENT_LABEL: Record<string, string> = {
  created: "сигнал создан",
  activated: "вход исполнен",
  tp1: "TP1 достигнут",
  tp2: "TP2 достигнут",
  tp3: "TP3 достигнут",
  be: "стоп в безубыток",
  sl: "стоп сработал",
  time_stop: "закрыт по времени",
  expired: "вход не исполнен, сигнал истёк",
};

const SCORE_LABEL: Record<string, string> = {
  bias: "Контекст D1/W1",
  structure: "Структура H4",
  zone: "Зона",
  bos: "Качество BOS",
  liquidity: "Ликвидность",
  sweep: "Снятие ликвидности",
  volume: "Объём",
  derivatives: "Деривативы",
  volatility: "Волатильность",
  rr: "R:R",
  session: "Сессия",
  correlation: "Корреляция",
};

/** Какой слой графика подсветить для факта из движка (план 3.5: каждый факт кликабелен). */
function layerOf(fact: string): Layer | "none" {
  const f = fact.toLowerCase();
  if (/choch/.test(f)) return "choch";
  if (/bos|слом/.test(f)) return "bos";
  if (/зон|ob\b|fvg|ордер|имбаланс|ретест/.test(f)) return "zone";
  if (/pdh|pdl|pwh|pwl|дневн|недельн/.test(f)) return "levels";
  if (/равн|equal/.test(f)) return "eq";
  if (/снят|sweep|ликвидност/.test(f)) return "sweep";
  if (/tp\d|цел/.test(f)) return "tp";
  if (/стоп|sl\b/.test(f)) return "sl";
  if (/вход/.test(f)) return "entry";
  return "none";
}

function groupOf(fact: string): string {
  const f = fact.toLowerCase();
  if (/^d1|^w1|ema|bias/.test(f)) return "Старший таймфрейм";
  if (/bos|choch|структур|слом|зон|ob\b|fvg|ретест/.test(f)) return "Структура и зона";
  if (/ликвид|снят|равн|pdh|pdl|pwh|pwl/.test(f)) return "Ликвидность";
  if (/tp|цел|стоп|r:r|\br\b/.test(f)) return "Сделка";
  return "Фильтры";
}

export default function SignalPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [d, setD] = useState<Detail | null>(null);
  const [an, setAn] = useState<AnalysisFull | null>(null);
  const [tf, setTf] = useState<"4h" | "1d">("4h");
  const [candles, setCandles] = useState<ChartCandle[]>([]);
  const [patterns, setPatterns] = useState<PatternOnChart[]>([]);
  const [tick, setTick] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Layer | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const [restPrice, setRestPrice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<Detail>(`/v1/signals/${id}`)
      .then((x) => {
        if (!alive) return;
        setD(x);
        api<{ symbol: string; tick_size: string | null }[]>("/v1/instruments", { auth: false })
          .then((rows) => alive && setTick(rows.find((r) => r.symbol === x.symbol)?.tick_size ?? null))
          .catch(() => {});
        api<Record<string, { p: string }>>(`/v1/prices?symbols=${x.symbol}`, { auth: false })
          .then((p) => alive && setRestPrice(p[x.symbol]?.p ?? null))
          .catch(() => {});
      })
      .catch((e: Error) => alive && setError(e.message));
    api<AnalysisFull>(`/v1/signals/${id}/analysis`)
      .then((x) => alive && setAn(x))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    let alive = true;
    api<{ candles: ChartCandle[] }>(`/v1/signals/${id}/candles?tf=${tf}&before=${tf === "4h" ? 160 : 90}&after=${tf === "4h" ? 60 : 20}`)
      .then((x) => alive && setCandles(x.candles))
      .catch(() => alive && setCandles([]));
    return () => {
      alive = false;
    };
  }, [id, tf]);

  // свечные паттерны вокруг сигнальной свечи (план 3.5, 2B.16): ±3 свечи
  useEffect(() => {
    if (!d) return;
    let alive = true;
    const step = tf === "4h" ? 14400 : 86400;
    const close = Math.floor(new Date(d.candle_close_time).getTime() / 1000);
    getPatterns(d.symbol, tf, close - 3 * step, close + 3 * step)
      .then((r) => alive && setPatterns(r.items))
      .catch(() => alive && setPatterns([]));
    return () => {
      alive = false;
    };
  }, [d, tf]);
  const onSignalCandle = useMemo(() => {
    if (!d) return [];
    const close = Math.floor(new Date(d.candle_close_time).getTime() / 1000);
    return patterns.filter((p) => p.confirm_t === close);
  }, [patterns, d]);

  const symbols = useMemo(() => (d ? [d.symbol] : []), [d]);
  const { prices } = useLive(symbols, getAccessToken());
  const price = d ? (prices[d.symbol]?.p ?? restPrice) : null;
  const open = d ? ["pending", "active", "tp1_hit", "tp2_hit"].includes(d.status) : false;

  const chartSignal = useMemo(
    () =>
      d
        ? {
            direction: d.direction,
            candle_close_time: d.candle_close_time,
            entry: d.entry_limit ?? d.entry_market,
            stop_loss: d.stop_loss,
            tp1: d.tp1,
            tp2: d.tp2,
            tp3: d.tp3,
            zone: d.zone,
          }
        : null,
    [d],
  );
  const chartEvents = useMemo(() => (d ? d.events.map((e) => ({ type: e.type, price: e.price, at: e.at })) : []), [d]);

  const act = useCallback(async (fn: () => Promise<unknown>, okText: string) => {
    try {
      await fn();
      setToast({ text: okText, kind: "ok" });
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : "ошибка", kind: "error" });
    }
    setTimeout(() => setToast(null), 4000);
  }, []);

  // калькулятор позиции (план 3.5): значения из профиля, можно менять
  const [depositEdit, setDeposit] = useState<string | null>(null);
  const [riskEdit, setRiskPct] = useState<string | null>(null);
  const [leverageEdit, setLeverage] = useState<string | null>(null);
  const deposit = depositEdit ?? user?.risk.deposit ?? "";
  const riskPct = riskEdit ?? (user?.risk.risk_pct ? String(Number(user.risk.risk_pct)) : "1");
  const leverage = leverageEdit ?? String(user?.risk.default_leverage ?? 3);

  const title = d ? `${d.symbol} ${d.direction === "long" ? "LONG" : "SHORT"}` : "Сигнал";

  if (error) {
    return (
      <AppShell title="Сигнал">
        <Panel>
          <EmptyState text={`Сигнал недоступен: ${error}`} action={<Button href="/signals" size="sm">К ленте</Button>} />
        </Panel>
      </AppShell>
    );
  }
  if (!d) {
    return (
      <AppShell title="Сигнал">
        <Panel>
          <EmptyState text="Загрузка…" />
        </Panel>
      </AppShell>
    );
  }

  const entry = Number(d.entry_limit ?? d.entry_market);
  const sl = Number(d.stop_loss);
  const risk = Math.abs(entry - sl);
  const sign = d.direction === "long" ? 1 : -1;
  const rOf = (p: string | null) => (p && risk > 0 ? ((Number(p) - entry) * sign) / risk : null);
  const pctOf = (p: string | null) => (p ? ((Number(p) - entry) / entry) * 100 : null);
  const pnl = open ? unrealizedR(d, price ?? undefined) : d.result?.realized_r ? Number(d.result.realized_r) : null;
  const exchange = user?.risk.exchange ?? "binance";
  const exchangeUrl = exchange === "bybit" ? `https://www.bybit.com/trade/usdt/${d.symbol}` : `https://www.binance.com/en/futures/${d.symbol}`;
  const dep = Number(deposit.replace(",", "."));
  const rp = Number(riskPct.replace(",", "."));
  const lev = Math.max(1, Number(leverage) || 1);
  const riskUsd = dep > 0 && rp > 0 ? (dep * rp) / 100 : null;
  const size = riskUsd !== null && risk > 0 ? riskUsd / risk : null;
  const notional = size !== null ? size * entry : null;
  const margin = notional !== null ? notional / lev : null;
  const split = an?.trade_params.split ?? ["0.4", "0.4", "0.2"];
  const factsByGroup = new Map<string, string[]>();
  d.facts.forEach((f) => factsByGroup.set(groupOf(f), [...(factsByGroup.get(groupOf(f)) ?? []), f]));
  const copyParams = () =>
    navigator.clipboard.writeText(
      `${d.symbol} ${d.direction.toUpperCase()} (${d.grade}, ${d.score})\nвход ${d.entry_limit ?? d.entry_market}\nстоп ${d.stop_loss}\nTP1 ${d.tp1} / TP2 ${d.tp2} / TP3 ${d.tp3}\n${window.location.href}`,
    );

  return (
    <AppShell
      title={title}
      actions={
        <div className={s.head}>
          <DirectionBadge direction={d.direction} />
          <GradeBadge grade={d.grade} />
          <StatusBadge status={d.status} />
          <a href={exchangeUrl} target="_blank" rel="noreferrer noopener" className="caption">
            Открыть на бирже ↗
          </a>
        </div>
      }
    >
      <div className={s.meta} style={{ marginBottom: 12 }}>
        <span>свеча {formatTimeUTC(d.candle_close_time)}</span>
        <span>стратегия {d.strategy_version}</span>
        <span>балл {d.score}</span>
        {price && (
          <span>
            цена <span className="num">{formatPrice(price, tick)}</span>
          </span>
        )}
        {pnl !== null && (
          <span className={pnl > 0 ? "up" : pnl < 0 ? "down" : ""}>
            {open ? "сейчас" : "итог"} {formatR(pnl)}
          </span>
        )}
        {d.result && <span>длительность {formatDuration(d.result.duration_hours)}</span>}
      </div>

      <div className={s.grid}>
        <div className={s.col}>
          <Panel
            title="График"
            flush
            actions={
              <div className={s.tfs} role="group" aria-label="таймфрейм">
                {(["4h", "1d"] as const).map((x) => (
                  <button key={x} type="button" aria-pressed={tf === x} onClick={() => setTf(x)}>
                    {x.toUpperCase()}
                  </button>
                ))}
                <Link href={`/chart/${d.symbol}/${tf}`} className={s.openTerminal}>
                  Открыть в терминале
                </Link>
              </div>
            }
            footer={
              <>
                Зона входа, стоп, цели, PDH/PDL/PWH/PWL, swing-точки (H/L), линии BOS/CHoCH, снятия ликвидности, свечные паттерны и события трекера. Клик по факту в обосновании подсвечивает элемент.
                {onSignalCandle.length > 0 && (
                  <>
                    {" "}
                    <button type="button" className={s.factBtn} aria-pressed={highlight === "patterns"} onClick={() => setHighlight(highlight === "patterns" ? null : "patterns")} data-testid="signal-patterns">
                      На сигнальной свече: {onSignalCandle.map((p) => `${p.title} (${p.significant ? "значимый" : "найден"})`).join(", ")}
                    </button>
                  </>
                )}
              </>
            }
          >
            {chartSignal && <SignalChart candles={candles} tf={tf} signal={chartSignal} analysis={an} events={chartEvents} patterns={patterns} highlight={highlight} tick={tick} lastPrice={open ? price : null} />}
          </Panel>

          <Panel title="Параметры сделки" flush>
            <table className={s.params}>
              <thead>
                <tr>
                  <th>Уровень</th>
                  <th className="num">Цена</th>
                  <th className="num">От входа</th>
                  <th className="num">R</th>
                  <th className="num">Доля закрытия</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Вход {d.entry_limit ? "лимитный" : "рыночный"}</td>
                  <td className="num">{formatPrice(d.entry_limit ?? d.entry_market, tick)}</td>
                  <td className="num">—</td>
                  <td className="num">0</td>
                  <td className="num">—</td>
                </tr>
                <tr>
                  <td className="down">Стоп</td>
                  <td className="num down">{formatPrice(d.stop_loss, tick)}</td>
                  <td className="num">{formatPct(pctOf(d.stop_loss))}</td>
                  <td className="num">−1.00</td>
                  <td className="num">100 %</td>
                </tr>
                {([
                  ["TP1", d.tp1, split[0]],
                  ["TP2", d.tp2, split[1]],
                  ["TP3", d.tp3, split[2]],
                ] as const).map(([name, v, share]) => (
                  <tr key={name}>
                    <td className="up">{name}</td>
                    <td className="num up">{formatPrice(v, tick)}</td>
                    <td className="num">{formatPct(pctOf(v))}</td>
                    <td className="num">{rOf(v)?.toFixed(2) ?? "—"}</td>
                    <td className="num">{Math.round(Number(share) * 100)} %</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="caption" style={{ padding: "8px 12px" }}>
              {an?.trade_params.be_after_tp1 ? "После TP1 стоп переносится в безубыток. " : "Стоп не переносится. "}
              Лимитный ордер живёт {an?.trade_params.limit_expiry_candles ?? 6} свечей H4, позиция закрывается по времени через {an?.trade_params.time_stop_candles ?? 15} свечей. Если в одной минуте были и цель, и стоп — засчитывается стоп.
            </p>
          </Panel>

          <Panel title="История событий" flush>
            {d.events.length === 0 ? (
              <EmptyState text="Событий пока нет." />
            ) : (
              <table className={s.events}>
                <tbody>
                  {d.events.map((e) => (
                    <tr key={e.at + e.type}>
                      <td className="num" style={{ textAlign: "left" }}>
                        {formatTimeUTC(e.at)}
                      </td>
                      <td>{EVENT_LABEL[e.type] ?? e.type}</td>
                      <td className="num">{e.price ? formatPrice(e.price, tick) : ""}</td>
                      <td className="caption">{e.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        <div className={s.col}>
          <Panel title="Обоснование" footer="Факты сформированы движком по правилам стратегии, не свободным текстом. Клик — подсветка на графике.">
            {d.facts.length === 0 ? (
              <EmptyState text="Факты не записаны." />
            ) : (
              <ul className={s.facts}>
                {an && (
                  <>
                    <li className={s.factGroup}>Контекст</li>
                    <li>
                      <button type="button" data-layer="levels" aria-pressed={highlight === "levels"} onClick={() => setHighlight(highlight === "levels" ? null : "levels")}>
                        D1: {an.bias.d1_trend}, W1: {an.bias.w1_trend}, bias {an.bias.bias}
                        {an.bias.ema50_d1 ? `, EMA50 D1 ${formatPrice(an.bias.ema50_d1, tick)}` : ""}
                        {an.atr ? `, ATR H4 ${formatPrice(an.atr, tick)}` : ""}
                      </button>
                    </li>
                  </>
                )}
                {Array.from(factsByGroup.entries()).map(([g, list]) => (
                  <li key={g}>
                    <div className={s.factGroup}>{g}</div>
                    <ul className={s.facts}>
                      {list.map((f) => {
                        const layer = layerOf(f);
                        return (
                          <li key={f}>
                            <button
                              type="button"
                              data-layer={layer}
                              aria-pressed={layer !== "none" && highlight === layer}
                              onClick={() => layer !== "none" && setHighlight(highlight === layer ? null : layer)}
                            >
                              {f}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={`Скоринг: ${d.score} из 100, градация ${d.grade}`} flush>
            {d.score_breakdown && Object.keys(d.score_breakdown).length ? (
              <table className={s.params}>
                <tbody>
                  {Object.entries(d.score_breakdown).map(([k, v]) => (
                    <tr key={k}>
                      <td>{SCORE_LABEL[k] ?? k}</td>
                      <td className="num">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState text="Разбивка баллов не записана." />
            )}
          </Panel>

          <Panel title="Калькулятор позиции" footer="Размер позиции = риск в USDT / расстояние до стопа. Плечо меняет только маржу, не риск.">
            <div className={s.calc}>
              <div className={s.calcRow}>
                <Input label="Депозит, USDT" mono inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="—" />
                <Input label="Риск, %" mono inputMode="decimal" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} />
                <Select label="Плечо" value={leverage} onChange={(e) => setLeverage(e.target.value)}>
                  {[1, 2, 3, 5, 10, 20].map((x) => (
                    <option key={x} value={x}>
                      {x}×
                    </option>
                  ))}
                </Select>
              </div>
              <dl className={s.calcOut}>
                <dt>Риск в USDT</dt>
                <dd className="num">{riskUsd === null ? "—" : riskUsd.toFixed(2)}</dd>
                <dt>Размер позиции</dt>
                <dd className="num">{size === null ? "—" : `${size.toPrecision(6).replace(/\.?0+$/, "")} ${d.symbol.replace(/USDT$/, "")}`}</dd>
                <dt>Объём позиции</dt>
                <dd className="num">{notional === null ? "—" : `${notional.toFixed(2)} USDT`}</dd>
                <dt>Маржа при {lev}×</dt>
                <dd className="num">{margin === null ? "—" : `${margin.toFixed(2)} USDT`}</dd>
              </dl>
            </div>
          </Panel>

          <Panel title="Действия">
            <div className={s.actions}>
              {open && (
                <Button size="sm" variant="primary" onClick={() => act(() => journalFromSignal(d), "Запись в журнале создана")}>
                  Я вошёл
                </Button>
              )}
              <Button size="sm" onClick={() => act(copyParams, "Параметры скопированы")}>
                Скопировать параметры
              </Button>
              <Button size="sm" onClick={() => act(() => navigator.clipboard.writeText(window.location.href), "Ссылка скопирована")}>
                Поделиться ссылкой
              </Button>
              <Button size="sm" variant="ghost" disabled title="появится вместе с уведомлениями">
                Напомнить при подходе к входу
              </Button>
            </div>
            {toast && (
              <p className={s.toast} data-kind={toast.kind} role="status" style={{ marginTop: 8 }}>
                {toast.text}
              </p>
            )}
            <p className="caption" style={{ marginTop: 12 }}>
              Информация носит образовательный характер и не является индивидуальной инвестиционной рекомендацией. Прошлые результаты не гарантируют будущих.
            </p>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
