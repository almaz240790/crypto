"use client";

import { CHART_TYPES, INDICATORS, TOOL_TITLES, defaultParams, positionStats, secondsToClose, type ChartType, type DrawingType, type Timeframe } from "@platform/charts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Badge } from "@/components/ui";
import { getAccessToken } from "@/lib/auth-client";
import { INTRADAY, TIMEFRAMES } from "@/lib/timeframes";
import { formatPct, formatPrice } from "@/lib/format";
import { getInstruments, type Instrument } from "@/lib/user";
import s from "./terminal.module.css";
import { PANELS, TerminalView, type ActiveIndicator, type LayerKey, type PanelKey } from "./TerminalView";
import { useDrawings } from "./useDrawings";
import { getLayout, putLayout } from "@/lib/drawings";
import { useTerminalData } from "./useTerminalData";

const TYPE_LABEL: Record<ChartType, string> = { candles: "Свечи", bars: "Бары", line: "Линия", heikin: "Heikin Ashi" };
const LAYER_LABEL: Record<LayerKey, string> = { structure: "Структура", zones: "Зоны", levels: "Уровни", signals: "Сигналы" };
const DEFAULT_INDICATORS: ActiveIndicator[] = [{ id: "ema", params: { period: 50 } }];
const TOOLS: DrawingType[] = ["hline", "hray", "vline", "trend", "ray", "extended", "channel", "rect", "fib", "position-long", "position-short", "note", "ruler"];
const STORAGE = "pl-terminal";

type Saved = { type: ChartType; indicators: ActiveIndicator[]; layers: Record<LayerKey, boolean>; panels: PanelKey[]; updated_at?: number };

function load(): Saved {
  const base: Saved = { type: "candles", indicators: DEFAULT_INDICATORS, layers: { structure: true, zones: true, levels: true, signals: true }, panels: [] };
  try {
    const raw = localStorage.getItem(STORAGE);
    return raw ? { ...base, ...(JSON.parse(raw) as Partial<Saved>) } : base;
  } catch {
    return base;
  }
}

function fmtCountdown(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

export function TerminalPage({ symbol, tf }: { symbol: string; tf: Timeframe }) {
  const router = useRouter();
  const { user } = useAuth();
  const [saved, setSaved] = useState<Saved | null>(null);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [sheet, setSheet] = useState<"indicators" | "layers" | "draw" | null>(null);
  const dr = useDrawings(symbol, !!user);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const data = useTerminalData(symbol, tf, user ? getAccessToken() : null);

  useEffect(() => {
    queueMicrotask(() => setSaved(load()));
    getInstruments()
      .then((r) => setInstruments(r))
      .catch(() => {});
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") {
        dr.setTool(null);
        dr.setDraft(null);
        dr.actions.select(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && dr.selected && !dr.selected.locked) dr.actions.remove(dr.selected.id);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) dr.actions.undo();
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) dr.actions.redo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dr]);
  useEffect(() => {
    if (saved) {
      try {
        localStorage.setItem(STORAGE, JSON.stringify(saved));
      } catch {
        /* приватный режим */
      }
    }
  }, [saved]);
  // раскладка: при входе берём с сервера, если она новее локальной; изменения отправляем с задержкой
  const layoutPulled = useRef(false);
  useEffect(() => {
    if (!user || layoutPulled.current) return;
    layoutPulled.current = true;
    getLayout()
      .then((r) => {
        if (!r.data) return;
        const local = load();
        if (r.updated_at > (local.updated_at ?? 0)) setSaved({ ...local, ...(r.data as Partial<Saved>), updated_at: r.updated_at });
      })
      .catch(() => {});
  }, [user]);
  useEffect(() => {
    if (!user || !saved || !layoutPulled.current) return;
    const t = setTimeout(() => {
      const { updated_at, ...data } = saved;
      void putLayout(data, updated_at ?? Date.now()).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [saved, user]);

  const st = saved ?? load();
  const last = data.current ?? data.candles?.[data.candles.length - 1] ?? null;
  const prevClose = data.candles && data.candles.length > 1 ? data.candles[data.candles.length - (data.current ? 1 : 2)]!.close : null;
  const price = data.price ? Number(data.price) : last?.close ?? null;
  const change = price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null;
  const countdown = last ? secondsToClose(tf, last.time, now) : null;
  const intradayLocked = !user || (data.error ?? "").includes("тарифе");
  const bias = data.layers?.structure?.bias;

  const toggleIndicator = (id: string) =>
    setSaved((p) => {
      const cur = p ?? load();
      const has = cur.indicators.some((i) => i.id === id);
      const spec = INDICATORS.find((i) => i.id === id)!;
      return { ...cur, indicators: has ? cur.indicators.filter((i) => i.id !== id) : [...cur.indicators, { id, params: defaultParams(spec) }], updated_at: Date.now() };
    });
  const togglePanel = (k: PanelKey) =>
    setSaved((p) => {
      const cur = p ?? load();
      const has = cur.panels.includes(k);
      return { ...cur, panels: has ? cur.panels.filter((x) => x !== k) : [...cur.panels, k], updated_at: Date.now() };
    });
  const toggleLayer = (k: LayerKey) => setSaved((p) => ({ ...(p ?? load()), layers: { ...(p ?? load()).layers, [k]: !(p ?? load()).layers[k] }, updated_at: Date.now() }));
  const indicatorIds = useMemo(() => new Set(st.indicators.map((i) => i.id)), [st.indicators]);
  const sel = dr.selected;
  const pos = useMemo(() => {
    if (!sel || !sel.type.startsWith("position") || sel.points.length < 3) return null;
    const risk = user?.risk;
    const profile = risk?.deposit ? { deposit: Number(risk.deposit), riskPct: Number(risk.risk_pct) } : null;
    return positionStats(sel.type === "position-long" ? "long" : "short", sel.points[0]!.price, sel.points[1]!.price, sel.points[2]!.price, profile);
  }, [sel, user]);
  const drawingsProps = useMemo(
    () => ({
      state: dr.state,
      tool: dr.tool,
      magnet: dr.magnet,
      draft: dr.draft,
      onCreate: dr.actions.create,
      onMove: dr.actions.move,
      onSelect: dr.actions.select,
      onDraft: dr.setDraft,
      onToolDone: () => {
        /* инструмент остаётся выбранным для серии рисунков; Esc — выход */
      },
    }),
    [dr.state, dr.tool, dr.magnet, dr.draft, dr.actions, dr.setDraft],
  );

  return (
    <div className={s.page}>
      <div className={s.top}>
        <select aria-label="инструмент" value={symbol} onChange={(e) => router.push(`/chart/${e.target.value}/${tf}`)}>
          {(instruments.length ? instruments : [{ symbol } as Instrument]).map((i) => (
            <option key={i.symbol} value={i.symbol}>
              {i.symbol}
            </option>
          ))}
        </select>
        <nav className={s.tfs} aria-label="таймфрейм">
          {TIMEFRAMES.map((t) => (
            <Link key={t} href={`/chart/${symbol}/${t}`} aria-current={t === tf ? "page" : undefined} data-primary={t === "4h"} aria-disabled={INTRADAY.includes(t) && !user ? "true" : undefined} title={INTRADAY.includes(t) && !user ? "после входа, тариф Pro" : undefined}>
              {t === "4h" ? "H4" : t.toUpperCase()}
            </Link>
          ))}
        </nav>
        <select aria-label="тип графика" value={st.type} onChange={(e) => setSaved({ ...st, type: e.target.value as ChartType, updated_at: Date.now() })}>
          {CHART_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
      <div className={s.strip} aria-label="состояние">
        <span>
          цена <strong>{formatPrice(price == null ? null : String(price))}</strong>
        </span>
        <span className={change == null ? "" : change >= 0 ? "up" : "down"}>{formatPct(change)}</span>
        <span>
          до закрытия <strong>{countdown == null ? "—" : fmtCountdown(countdown)}</strong>
        </span>
        {bias && (
          <span>
            bias <Badge tone={bias.bias === "long" ? "up" : bias.bias === "short" ? "down" : "muted"}>{bias.bias}</Badge> D1 {bias.d1_trend} · W1 {bias.w1_trend}
          </span>
        )}
        {data.layers?.structure?.atr && <span>ATR {formatPrice(data.layers.structure.atr)}</span>}
        {data.derivatives?.funding_current && (
          <span>
            funding <strong>{(Number(data.derivatives.funding_current) * 100).toFixed(4)} %</strong>
            {data.derivatives.next_funding_t && <> через {fmtCountdown(Math.max(0, data.derivatives.next_funding_t - now))}</>}
          </span>
        )}
        <span className="caption">{data.connected ? "live" : "без связи"}</span>
        {st.type === "heikin" && <span className="caption">Heikin Ashi: паттерны и сигналы считаются по обычным свечам</span>}
      </div>
      <div className={s.area}>
        {data.error && !intradayLocked ? (
          <div className={s.empty} role="alert">
            {data.error}
          </div>
        ) : intradayLocked && data.error ? (
          <div className={s.empty}>
            Таймфреймы 1m–15m доступны после входа на тарифе Pro. <Link href="/pricing">Тарифы</Link>
          </div>
        ) : (
          <TerminalView candles={data.candles ?? []} current={data.current} tf={tf} type={st.type} indicators={st.indicators} layersOn={st.layers} layers={data.layers} derivatives={data.derivatives} panels={st.panels} tick={data.tick} onNeedOlder={data.loadOlder} drawings={drawingsProps} />
        )}
        {sel && (
          <div className={s.card} role="region" aria-label="выбранный рисунок">
            <strong>{TOOL_TITLES[sel.type]}</strong>
            {(sel.type === "note" || sel.type === "rect" || sel.type === "trend") && (
              <input aria-label="текст рисунка" placeholder="подпись (до 140 символов)" maxLength={140} value={sel.text ?? ""} onChange={(e) => dr.actions.patch(sel.id, { text: e.target.value })} />
            )}
            {pos && (
              <span className={s.posStats}>
                R:R <strong>{pos.rr.toFixed(2)}</strong> · риск {pos.riskPct.toFixed(2)} %
                {pos.riskUsd != null && pos.size != null && (
                  <>
                    {" "}· риск <strong>{pos.riskUsd.toFixed(0)} USDT</strong> · размер <strong>{pos.size.toPrecision(4)}</strong>
                  </>
                )}
                {pos.riskUsd == null && <span className="caption"> · задайте депозит и риск в настройках</span>}
                <Link href={`/journal?symbol=${symbol}&direction=${pos.direction}&entry=${pos.entry}&stop=${pos.stop}&tp=${pos.target}`}>в журнал</Link>
                <Link href={`/calculator?symbol=${symbol}&direction=${pos.direction}&entry=${pos.entry}&stop=${pos.stop}&tp=${pos.target}`}>в калькулятор</Link>
              </span>
            )}
            <label className={s.inline}>
              <input type="checkbox" checked={sel.timeframe === null} onChange={(e) => dr.actions.patch(sel.id, { timeframe: e.target.checked ? null : tf })} /> на всех таймфреймах
            </label>
            <button type="button" className={s.chip} onClick={() => dr.actions.lock(sel.id)} aria-pressed={sel.locked}>
              {sel.locked ? "разблокировать" : "заблокировать"}
            </button>
            <button type="button" className={s.chip} onClick={() => dr.actions.remove(sel.id)} disabled={sel.locked}>
              удалить
            </button>
            <button type="button" className={s.chip} onClick={() => dr.actions.select(null)} aria-label="снять выделение">
              ✕
            </button>
          </div>
        )}
        {dr.limitHit && (
          <p className={s.card} role="alert">
            Лимит рисунков на инструмент: {dr.limit}. Удалите лишние{!user ? " или войдите" : " или перейдите на тариф выше"}.{" "}
            <button type="button" className={s.chip} onClick={dr.dismissLimit}>
              понятно
            </button>
          </p>
        )}
        {sheet && (
          <div className={s.sheet} role="dialog" aria-label={sheet === "indicators" ? "Индикаторы" : sheet === "layers" ? "Слои" : "Рисование"}>
            {sheet === "draw" &&
              TOOLS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={s.chip}
                  aria-pressed={dr.tool === t}
                  onClick={() => {
                    dr.setTool(dr.tool === t ? null : t);
                    setSheet(null);
                  }}
                >
                  {TOOL_TITLES[t]}
                </button>
              ))}
            {sheet === "draw" && (
              <>
                <label>
                  <input type="checkbox" checked={dr.magnet} onChange={(e) => dr.setMagnet(e.target.checked)} /> магнит к OHLC
                </label>
                <label>
                  <input type="checkbox" checked={dr.state.hidden} onChange={(e) => dr.actions.hide(e.target.checked)} /> скрыть все рисунки
                </label>
                <button
                  type="button"
                  className={s.chip}
                  disabled={dr.items.length === 0}
                  onClick={() => {
                    if (confirm(`Удалить все рисунки по ${symbol} (${dr.items.length})?`)) dr.actions.clear();
                  }}
                >
                  удалить все
                </button>
              </>
            )}
            {sheet === "indicators"
              ? [
                  ...INDICATORS.map((i) => (
                    <label key={i.id}>
                      <input type="checkbox" checked={indicatorIds.has(i.id)} onChange={() => toggleIndicator(i.id)} /> {i.title}
                      <span className="caption">{i.pane === "overlay" ? "на графике" : "панель"}</span>
                    </label>
                  )),
                  ...PANELS.map((pn) => (
                    <label key={pn.id}>
                      <input type="checkbox" checked={st.panels.includes(pn.id)} onChange={() => togglePanel(pn.id)} /> {pn.title}
                      <span className="caption">{pn.id === "liq" ? "панель · данные публичного потока, не полный объём" : "панель · деривативы"}</span>
                    </label>
                  )),
                ]
              : (Object.keys(LAYER_LABEL) as LayerKey[]).map((k) => (
                  <label key={k}>
                    <input type="checkbox" checked={st.layers[k]} onChange={() => toggleLayer(k)} /> {LAYER_LABEL[k]}
                  </label>
                ))}
            <button type="button" className={s.chip} onClick={() => setSheet(null)}>
              Готово
            </button>
          </div>
        )}
      </div>
      <div className={s.bottom}>
        <button type="button" className={s.chip} aria-pressed={sheet === "indicators"} onClick={() => setSheet(sheet === "indicators" ? null : "indicators")}>
          Индикаторы ({st.indicators.length + st.panels.length})
        </button>
        <button type="button" className={s.chip} aria-pressed={sheet === "layers"} onClick={() => setSheet(sheet === "layers" ? null : "layers")}>
          Слои
        </button>
        <button type="button" className={s.chip} aria-pressed={sheet === "draw" || dr.tool !== null} onClick={() => setSheet(sheet === "draw" ? null : "draw")}>
          {dr.tool ? `Рисую: ${TOOL_TITLES[dr.tool]}` : "Рисовать"}
        </button>
        {dr.tool && (
          <button type="button" className={s.chip} onClick={() => { dr.setTool(null); dr.setDraft(null); }} aria-label="закончить рисование">
            Готово
          </button>
        )}
        <button type="button" className={s.chip} onClick={dr.actions.undo} disabled={!dr.canUndo} aria-label="отменить">
          ↶
        </button>
        <button type="button" className={s.chip} onClick={dr.actions.redo} disabled={!dr.canRedo} aria-label="повторить">
          ↷
        </button>
        <span className="caption" data-testid="drawings-count">
          рисунков: {dr.items.length}
        </span>
        {user && dr.sync !== "off" && (
          <span className="caption" data-testid="drawings-sync">
            {dr.sync === "ok" ? "синхронизировано" : dr.sync === "queued" ? "в очереди" : "ошибка синхронизации"}
          </span>
        )}
        {data.layers?.signals.length ? (
          <Link className="caption" href={`/signals?symbol=${symbol}&tab=all`}>
            сигналов по инструменту: {data.layers.signals.length}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
