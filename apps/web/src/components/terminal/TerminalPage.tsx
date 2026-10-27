"use client";

import type React from "react";
import { CHART_TYPES, INDICATORS, TOOL_TITLES, defaultParams, positionStats, secondsToClose, tokensFromElement, type Candle, type ChartType, type DrawingType, type ScaleMode, type Timeframe } from "@platform/charts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Badge } from "@/components/ui";
import { getAccessToken } from "@/lib/auth-client";
import { INTRADAY, TIMEFRAMES } from "@/lib/timeframes";
import { formatPct, formatPrice } from "@/lib/format";
import { getInstruments, type Instrument } from "@/lib/user";
import s from "./terminal.module.css";
import { BottomSheet } from "./BottomSheet";
import { DrawToolbar, ObjectsPanel } from "./DesktopPanels";
import { AskBox, FiguresList, FoundList } from "./FoundPanel";
import { download, snapshotPng } from "./snapshot";
import { TEMPLATES } from "./templates";
import { PANELS, TerminalView, type ActiveIndicator, type CrosshairInfo, type LayerKey, type PanelKey, type TerminalControls } from "./TerminalView";
import { useDrawings } from "./useDrawings";
import { deleteLayout, getLayout, listLayouts, putLayout } from "@/lib/drawings";
import { createAlert, getAlerts, type Alert } from "@/lib/alerts";
import { getCandles, toCandle } from "@/lib/chart";
import { useTerminalData } from "./useTerminalData";

const TYPE_LABEL: Record<ChartType, string> = { candles: "Свечи", bars: "Бары", line: "Линия", heikin: "Heikin Ashi" };
const LAYER_LABEL: Record<LayerKey, string> = { structure: "Структура", zones: "Зоны", levels: "Уровни", signals: "Сигналы", patterns: "Паттерны", figures: "Фигуры", volume_profile: "Профиль объёма" };
const DEFAULT_INDICATORS: ActiveIndicator[] = [{ id: "ema", params: { period: 50 } }];
const TOOLS: DrawingType[] = ["hline", "hray", "vline", "trend", "ray", "extended", "channel", "rect", "fib", "position-long", "position-short", "note", "ruler"];
const STORAGE = "pl-terminal";
const OBJECTS_W_KEY = "pl-objects-w";
const OBJECTS_W_DEFAULT = 300;
const OBJECTS_W_MIN = 240;
const OBJECTS_W_MAX = 600;
const clampW = (w: number) => Math.round(Math.min(OBJECTS_W_MAX, Math.max(OBJECTS_W_MIN, w)));

type Saved = { type: ChartType; indicators: ActiveIndicator[]; layers: Record<LayerKey, boolean>; panels: PanelKey[]; scale: ScaleMode; overlay: string | null; updated_at?: number };
const SCALE_LABEL: Record<ScaleMode, string> = { linear: "линейная", log: "логарифмическая", percent: "проценты" };

function load(): Saved {
  const base: Saved = { type: "candles", indicators: DEFAULT_INDICATORS, layers: { structure: true, zones: true, levels: true, signals: true, patterns: true, figures: true, volume_profile: false }, panels: [], scale: "linear", overlay: null };
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<Saved>;
    return { ...base, ...parsed, layers: { ...base.layers, ...(parsed.layers ?? {}) } };
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
  const [sheet, setSheet] = useState<"indicators" | "layers" | "draw" | "found" | "alert" | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertDraft, setAlertDraft] = useState<{ price: string; op: "cross_up" | "cross_down" | "enter_range"; price2: string; frequency: "once" | "every" | "once_per_bar" }>({ price: "", op: "cross_up", price2: "", frequency: "once" });
  const [foundSel, setFoundSel] = useState<number | null>(null);
  const [figureSel, setFigureSel] = useState<number | null>(null);
  const [cross, setCross] = useState<CrosshairInfo | null>(null);
  const controls = useRef<TerminalControls | null>(null);
  const [visibleFrom, setVisibleFrom] = useState<number | null>(null);
  const [bars, setBars] = useState<"shown" | "hidden">("shown");
  const [objects, setObjects] = useState<"shown" | "hidden">("shown");
  // ширина панели объектов (десктоп): 240–600 px, хранится локально
  const [objW, setObjW] = useState(OBJECTS_W_DEFAULT);
  const [objDrag, setObjDrag] = useState(false);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(OBJECTS_W_KEY));
      if (v) queueMicrotask(() => setObjW(clampW(v)));
    } catch {
      /* приватный режим */
    }
  }, []);
  const setObjWidth = useCallback((w: number) => {
    const v = clampW(w);
    setObjW(v);
    try {
      localStorage.setItem(OBJECTS_W_KEY, String(v));
    } catch {
      /* приватный режим */
    }
  }, []);
  const objResize = {
    active: objDrag,
    step: (delta: number) => setObjWidth(objW + delta),
    start: (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = objW;
      setObjDrag(true);
      const move = (ev: PointerEvent) => setObjWidth(startW + (startX - ev.clientX));
      const up = () => {
        setObjDrag(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
  };
  const [layouts, setLayouts] = useState<{ name: string }[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const closeSheet = useCallback(() => setSheet(null), []);
  const dr = useDrawings(symbol, !!user);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const data = useTerminalData(symbol, tf, user ? getAccessToken() : null);
  // «Найдено» — по видимой части графика, а не по всей загруженной истории
  const foundCount = (data.patterns?.items ?? []).filter((p) => visibleFrom === null || p.t >= visibleFrom).length + (data.figures?.items ?? []).filter((f) => visibleFrom === null || f.end_t >= visibleFrom).length;

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
      } else if (e.altKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        dr.setTool("hline");
      } else if (e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        dr.setTool("trend");
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "+" || e.key === "=")) {
        controls.current?.zoom(1.25);
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === "-") {
        controls.current?.zoom(0.8);
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[1-7]$/.test(e.key)) {
        const t = TIMEFRAMES[Number(e.key) - 1];
        if (t) router.push(`/chart/${symbol}/${t}`);
      } else if ((e.key === "Delete" || e.key === "Backspace") && dr.selected && !dr.selected.locked) dr.actions.remove(dr.selected.id);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) dr.actions.undo();
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) dr.actions.redo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dr, router, symbol]);
  useEffect(() => {
    if (!user) return;
    listLayouts()
      .then((r) => setLayouts(r))
      .catch(() => {});
  }, [user]);
  const say = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 2500);
  };
  const loadAlerts = useCallback(() => {
    if (!user) return;
    getAlerts({ symbol, status: "active" })
      .then((r) => setAlerts(r.items))
      .catch(() => {});
  }, [user, symbol]);
  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);
  const addPriceAlert = (price: string, op: "cross_up" | "cross_down" | "enter_range", price2?: string, drawingId?: string, frequency: "once" | "every" | "once_per_bar" = "once") => {
    if (!user) return say("Алерты доступны после входа");
    createAlert({ symbol, type: "price", condition: { op, price, ...(price2 ? { price2 } : {}) }, frequency, drawing_client_id: drawingId ?? null })
      .then((a) => {
        say(`Алерт создан: ${a.text}`);
        loadAlerts();
        setSheet(null);
      })
      .catch((e: Error) => say(e.message));
  };
  const openAlertSheet = () => {
    const p = price == null ? "" : String(price);
    setAlertDraft({ price: p, op: "cross_up", price2: "", frequency: "once" });
    setSheet("alert");
  };
  const applyTemplate = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id);
    if (t) setSaved({ ...(saved ?? load()), indicators: t.indicators, panels: t.panels, updated_at: Date.now() });
  };
  const saveLayout = (name: string) => {
    const cur = saved ?? load();
    putLayout({ type: cur.type, indicators: cur.indicators, layers: cur.layers, panels: cur.panels, symbol, tf }, Date.now(), name)
      .then(() => {
        setLayouts((l) => (l.some((x) => x.name === name) ? l : [...l, { name }]));
        say(`Раскладка «${name}» сохранена`);
      })
      .catch((e: Error) => say(e.message));
  };
  const loadLayout = (name: string) => {
    getLayout(name)
      .then((r) => {
        if (!r.data) return;
        const d = r.data as Partial<Saved> & { symbol?: string; tf?: string };
        setSaved({ ...(saved ?? load()), ...d, updated_at: Date.now() });
        if (d.symbol && d.tf && (d.symbol !== symbol || d.tf !== tf)) router.push(`/chart/${d.symbol}/${d.tf}`);
        say(`Раскладка «${name}» применена`);
      })
      .catch((e: Error) => say(e.message));
  };
  const removeLayout = (name: string) => {
    deleteLayout(name)
      .then(() => setLayouts((l) => l.filter((x) => x.name !== name)))
      .catch((e: Error) => say(e.message));
  };
  const snapshot = () => {
    const canvasHost = areaRef.current?.querySelector('[data-testid="terminal"]') as HTMLElement | null;
    const chart = (canvasHost as (HTMLElement & { __chart?: import("lightweight-charts").IChartApi }) | null)?.__chart;
    if (!chart) return say("график ещё не готов");
    const t = tokensFromElement(canvasHost!);
    const url = snapshotPng(chart, `${symbol} · ${tf === "4h" ? "H4" : tf.toUpperCase()} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, window.location.href, { surface: t.surface, text2: t.text2, fontMono: t.fontMono });
    download(url, `platform-${symbol}-${tf}-${Date.now()}.png`);
  };
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
  // наложенный инструмент (план 2A.3 v2): закрытые свечи цели на том же таймфрейме
  const [overlayCandles, setOverlayCandles] = useState<Candle[] | null>(null);
  const overlaySymbol = st.overlay && st.overlay !== symbol ? st.overlay : null;
  useEffect(() => {
    if (!overlaySymbol) {
      queueMicrotask(() => setOverlayCandles(null));
      return;
    }
    let dead = false;
    getCandles(overlaySymbol, tf)
      .then((r) => !dead && setOverlayCandles(r.candles.filter((c) => !c.open).map(toCandle)))
      .catch(() => !dead && setOverlayCandles(null));
    return () => {
      dead = true;
    };
  }, [overlaySymbol, tf]);
  const last = data.current ?? data.candles?.[data.candles.length - 1] ?? null;
  const prevClose = data.candles && data.candles.length > 1 ? data.candles[data.candles.length - (data.current ? 1 : 2)]!.close : null;
  const price = data.price ? Number(data.price) : last?.close ?? null;
  const change = price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null;
  // копия рисунка на другой инструмент (план 2A.5): цены пропорционально последней цене цели
  const copyDrawing = async (id: string, target: string) => {
    let ratio = 1;
    try {
      const r = await getCandles(target, tf);
      const lastClose = Number((r.current ?? r.candles[r.candles.length - 1])?.c);
      if (price && lastClose > 0) ratio = lastClose / price;
    } catch {
      say(`Не удалось получить цену ${target}`);
      return;
    }
    const copy = dr.actions.copyTo(id, target, ratio);
    if (copy) say(`Рисунок скопирован на ${target}${ratio !== 1 ? " (цены пропорционально)" : ""}`);
  };
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

  const fmtV = (v: number | null) => (v == null ? "—" : Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3));
  return (
    <div className={s.page} data-bars={bars}>
      <button type="button" className={`${s.chip} ${s.fsBtn}`} onClick={() => setBars(bars === "shown" ? "hidden" : "shown")} aria-label={bars === "shown" ? "скрыть панели" : "показать панели"}>
        {bars === "shown" ? "⤢" : "⤡"}
      </button>
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
        <button type="button" className={s.chip} onClick={() => controls.current?.zoom(1.25)} aria-label="приблизить" title="Приблизить (клавиша +, колесо мыши)">
          +
        </button>
        <button type="button" className={s.chip} onClick={() => controls.current?.zoom(0.8)} aria-label="отдалить" title="Отдалить (клавиша −)">
          −
        </button>
        <button type="button" className={s.chip} onClick={() => controls.current?.reset()} aria-label="показать последние свечи" title="Последние 150 свечей (двойной клик по графику)">
          ⟲
        </button>
        <button type="button" className={s.chip} onClick={snapshot} title="Снимок PNG с водяным знаком">
          Снимок
        </button>
        <button type="button" className={`${s.chip} ${s.desktopOnly}`} aria-pressed={objects === "shown"} onClick={() => setObjects(objects === "shown" ? "hidden" : "shown")}>
          Объекты
        </button>
        <Link href="/multichart" className={`${s.chip} ${s.desktopOnly}`} style={{ display: "inline-flex", alignItems: "center" }}>
          Мультичарт
        </Link>
        <select aria-label="тип графика" value={st.type} onChange={(e) => setSaved({ ...st, type: e.target.value as ChartType, updated_at: Date.now() })}>
          {CHART_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <select aria-label="шкала" value={st.scale} onChange={(e) => setSaved({ ...st, scale: e.target.value as ScaleMode, updated_at: Date.now() })} title="Ценовая шкала">
          {(Object.keys(SCALE_LABEL) as ScaleMode[]).map((m) => (
            <option key={m} value={m}>
              {SCALE_LABEL[m]}
            </option>
          ))}
        </select>
        <select aria-label="наложение" className={s.desktopOnly} value={st.overlay ?? ""} onChange={(e) => setSaved({ ...st, overlay: e.target.value || null, scale: e.target.value && st.scale === "linear" ? "percent" : st.scale, updated_at: Date.now() })} title="Наложить второй инструмент (линия закрытий)">
          <option value="">без наложения</option>
          {instruments
            .filter((i) => i.symbol !== symbol)
            .map((i) => (
              <option key={i.symbol} value={i.symbol}>
                + {i.symbol}
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
      {toast && (
        <p role="status" className="caption" style={{ margin: 0, padding: "2px 12px" }}>
          {toast}
        </p>
      )}
      <div className={s.area} ref={areaRef} data-objects={objects} style={{ "--objects-w": `${objW}px` } as React.CSSProperties}>
        <DrawToolbar tool={dr.tool} onTool={(t) => dr.setTool(t)} magnet={dr.magnet} onMagnet={dr.setMagnet} canUndo={dr.canUndo} canRedo={dr.canRedo} onUndo={dr.actions.undo} onRedo={dr.actions.redo} />
        <div className={s.chartCol}>
      {cross && (
        <div className={s.ohlc} data-testid="ohlc" aria-live="polite">
          <span>{new Date(cross.candle.time * 1000).toLocaleString("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} UTC</span>
          <span>
            O <strong>{fmtV(cross.candle.open)}</strong>
          </span>
          <span>
            H <strong>{fmtV(cross.candle.high)}</strong>
          </span>
          <span>
            L <strong>{fmtV(cross.candle.low)}</strong>
          </span>
          <span className={cross.candle.close >= cross.candle.open ? "up" : "down"}>
            C <strong>{fmtV(cross.candle.close)}</strong> {(((cross.candle.close - cross.candle.open) / cross.candle.open) * 100).toFixed(2)} %
          </span>
          <span>
            V <strong>{fmtV(cross.candle.volume)}</strong>
          </span>
          {cross.values.map((v) => (
            <span key={v.label}>
              {v.label} <strong>{fmtV(v.value)}</strong>
            </span>
          ))}
          {cross.candle.open_ && <span className="caption">свеча не закрыта</span>}
        </div>
      )}
        {data.error && !intradayLocked ? (
          <div className={s.empty} role="alert">
            {data.error}
          </div>
        ) : intradayLocked && data.error ? (
          <div className={s.empty}>
            Таймфреймы 1m–15m доступны после входа на тарифе Pro. <Link href="/pricing">Тарифы</Link>
          </div>
        ) : (
          <TerminalView candles={data.candles ?? []} current={data.current} tf={tf} type={st.type} indicators={st.indicators} layersOn={st.layers} layers={data.layers} patterns={data.patterns?.items} highlight={foundSel} figures={data.figures?.items} highlightFigure={figureSel} alertLines={alerts.filter((a) => a.type === "price" && typeof a.condition.price === "string").map((a) => ({ id: a.id, price: Number(a.condition.price), label: a.condition.op === "cross_up" ? "↑" : a.condition.op === "cross_down" ? "↓" : "↔" }))} derivatives={data.derivatives} panels={st.panels} tick={data.tick} onNeedOlder={data.loadOlder} drawings={drawingsProps} onCrosshair={setCross} onVisibleFrom={setVisibleFrom} onReady={(c) => { controls.current = c; }} scale={st.scale} overlay={overlayCandles} />
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
            {(sel.type === "hline" || sel.type === "hray") && sel.points[0] && (
              <button
                type="button"
                className={s.chip}
                onClick={() => {
                  const p = sel.points[0]!.price;
                  addPriceAlert(String(p), price != null && price < p ? "cross_up" : "cross_down", undefined, sel.id);
                }}
              >
                алерт на уровне
              </button>
            )}
            {instruments.length > 1 && (
              <select
                className={s.chip}
                aria-label="скопировать на инструмент"
                value=""
                onChange={(e) => {
                  const target = e.target.value;
                  if (target) void copyDrawing(sel.id, target);
                }}
              >
                <option value="">скопировать на…</option>
                {instruments
                  .filter((i) => i.symbol !== symbol)
                  .map((i) => (
                    <option key={i.symbol} value={i.symbol}>
                      {i.symbol}
                    </option>
                  ))}
              </select>
            )}
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
          <BottomSheet title={sheet === "indicators" ? "Индикаторы" : sheet === "layers" ? "Слои" : sheet === "found" ? "Найдено на графике" : sheet === "alert" ? "Алерт по цене" : "Рисование"} onClose={closeSheet}>
            {sheet === "alert" && (
              <form
                aria-label="новый алерт по цене"
                onSubmit={(e) => {
                  e.preventDefault();
                  addPriceAlert(alertDraft.price, alertDraft.op, alertDraft.op === "enter_range" ? alertDraft.price2 : undefined, undefined, alertDraft.frequency);
                }}
              >
                <label>
                  условие
                  <select aria-label="условие цены" value={alertDraft.op} onChange={(e) => setAlertDraft({ ...alertDraft, op: e.target.value as typeof alertDraft.op })}>
                    <option value="cross_up">пересечение вверх</option>
                    <option value="cross_down">пересечение вниз</option>
                    <option value="enter_range">вход в диапазон</option>
                  </select>
                </label>
                <label>
                  цена
                  <input aria-label="цена алерта" inputMode="decimal" required value={alertDraft.price} onChange={(e) => setAlertDraft({ ...alertDraft, price: e.target.value })} />
                </label>
                {alertDraft.op === "enter_range" && (
                  <label>
                    вторая граница
                    <input aria-label="вторая граница" inputMode="decimal" required value={alertDraft.price2} onChange={(e) => setAlertDraft({ ...alertDraft, price2: e.target.value })} />
                  </label>
                )}
                <label>
                  срабатывание
                  <select aria-label="частота" value={alertDraft.frequency} onChange={(e) => setAlertDraft({ ...alertDraft, frequency: e.target.value as typeof alertDraft.frequency })}>
                    <option value="once">один раз</option>
                    <option value="every">каждый раз</option>
                    <option value="once_per_bar">раз в свечу</option>
                  </select>
                </label>
                <button type="submit" className={s.chip}>
                  Создать алерт
                </button>
                <p className="caption">
                  Проверка по минутным свечам, до 60 с. Активных по инструменту: {alerts.length}. <Link href="/alerts">Все алерты</Link>
                </p>
              </form>
            )}
            {sheet === "found" && (
              <>
                <strong className={s.objHead}>Фигуры</strong>
                <FiguresList items={data.figures?.items ?? []} stats={data.figures?.stats ?? {}} selected={figureSel} onSelect={setFigureSel} />
                <strong className={s.objHead}>Свечные паттерны</strong>
                <FoundList items={data.patterns?.items ?? []} stats={data.patterns?.stats ?? {}} selected={foundSel} onSelect={setFoundSel} tf={tf} symbol={symbol} canExplain={!!user} />
                {user && <AskBox symbol={symbol} tf={tf} />}
              </>
            )}
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
            {sheet === "found" || sheet === "alert"
              ? null
              : sheet === "indicators"
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
          </BottomSheet>
        )}
        </div>
        <ObjectsPanel
          onResize={objResize}
          drawings={dr.items}
          selectedId={dr.state.selectedId}
          onSelect={dr.actions.select}
          onLock={dr.actions.lock}
          onRemove={dr.actions.remove}
          layers={st.layers}
          onLayer={toggleLayer}
          panels={st.panels}
          onPanel={togglePanel}
          onTemplate={applyTemplate}
          layouts={layouts}
          onSaveLayout={saveLayout}
          onLoadLayout={loadLayout}
          onDeleteLayout={removeLayout}
          authed={!!user}
          layoutsLimit={user ? null : 0}
          found={{ count: foundCount, items: data.patterns?.items ?? [], stats: data.patterns?.stats ?? {}, selected: foundSel, onSelect: setFoundSel, tf, symbol, canExplain: !!user, figures: data.figures?.items ?? [], figureStats: data.figures?.stats ?? {}, selectedFigure: figureSel, onSelectFigure: setFigureSel }}
        />
      </div>
      <div className={s.bottom}>
        <button type="button" className={s.chip} aria-pressed={sheet === "indicators"} onClick={() => setSheet(sheet === "indicators" ? null : "indicators")}>
          Индикаторы ({st.indicators.length + st.panels.length})
        </button>
        <button type="button" className={s.chip} aria-pressed={sheet === "layers"} onClick={() => setSheet(sheet === "layers" ? null : "layers")}>
          Слои
        </button>
        <button type="button" className={`${s.chip} ${s.mobileOnly}`} aria-pressed={sheet === "found"} onClick={() => setSheet(sheet === "found" ? null : "found")}>
          Найдено ({foundCount})
        </button>
        <button type="button" className={s.chip} aria-pressed={sheet === "alert"} onClick={() => (sheet === "alert" ? setSheet(null) : openAlertSheet())}>
          Алерт{alerts.length ? ` (${alerts.length})` : ""}
        </button>
        <button type="button" className={s.chip} aria-pressed={sheet === "draw" || dr.tool !== null} onClick={() => setSheet(sheet === "draw" ? null : "draw")}>
          {dr.tool ? `Рисую: ${TOOL_TITLES[dr.tool]}` : "Рисовать"}
        </button>
        {dr.tool && (
          <button type="button" className={s.chip} onClick={() => { dr.setTool(null); dr.setDraft(null); }} aria-label="закончить рисование">
            Готово
          </button>
        )}
        <button type="button" className={`${s.chip} ${s.mobileOnly}`} onClick={dr.actions.undo} disabled={!dr.canUndo} aria-label="отменить">
          ↶
        </button>
        <button type="button" className={`${s.chip} ${s.mobileOnly}`} onClick={dr.actions.redo} disabled={!dr.canRedo} aria-label="повторить">
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
