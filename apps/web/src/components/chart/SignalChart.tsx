"use client";

/**
 * График карточки сигнала (план 3.5, 5.6): свечи H4/D1, зона входа, стоп и цели, PDH/PDL/PWH/PWL,
 * swing-точки, линии BOS/CHoCH, равные уровни, снятия ликвидности, маркеры событий трекера.
 * Тема — из CSS-токенов; без градиентов и свечений. Lightweight Charts грузится только в браузере.
 */
import { useEffect, useRef, useState } from "react";
import type { IChartApi, IPriceLine, ISeriesApi, SeriesMarker, Time, UTCTimestamp } from "lightweight-charts";
import { BoxPrimitive } from "./BoxPrimitive";
import s from "./SignalChart.module.css";

export type ChartCandle = { t: number; o: string; h: string; l: string; c: string; v: string };

export type Analysis = {
  swings: { time: string; price: string; kind: "high" | "low" }[];
  events: { time: string; type: "bos" | "choch"; direction: "up" | "down"; level: string; from_time: string }[];
  zones: { kind: string; direction: string; top: string; bottom: string; from_time: string; status: string }[];
  levels: { pdh: string | null; pdl: string | null; pwh: string | null; pwl: string | null };
  equal_levels: { kind: string; price: string; from_time: string; to_time: string | null; swept: boolean }[];
  sweeps: { time: string; kind: "high" | "low"; level: string }[];
};

export type ChartSignal = {
  direction: "long" | "short";
  candle_close_time: string;
  entry: string | null;
  stop_loss: string | null;
  tp1: string | null;
  tp2: string | null;
  tp3: string | null;
  zone: { top: string; bottom: string; kind?: string } | null;
};

export type ChartEvent = { type: string; price: string | null; at: string };

/** Слои, которые можно подсветить из обоснования. */
export type Layer = "zone" | "entry" | "sl" | "tp" | "bos" | "choch" | "levels" | "eq" | "sweep" | "swing" | "events";

type Props = {
  candles: ChartCandle[];
  tf: "4h" | "1d";
  signal: ChartSignal;
  analysis: Analysis | null;
  events: ChartEvent[];
  highlight: Layer | null;
  tick: string | null;
  lastPrice?: string | null;
  height?: number;
};

const EVENT_LABEL: Record<string, string> = {
  created: "сигнал",
  activated: "вход",
  tp1: "TP1",
  tp2: "TP2",
  tp3: "TP3",
  be: "б/у",
  sl: "стоп",
  time_stop: "время",
  expired: "истёк",
};

function tokens(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    bg: v("--surface"),
    grid: v("--border"),
    text: v("--text-2"),
    muted: v("--text-3"),
    up: v("--up"),
    down: v("--down"),
    accent: v("--accent"),
    warn: v("--warn"),
    font: cs.fontFamily,
  };
}

function alpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; // color-ok: из токена
}

function ts(iso: string): UTCTimestamp {
  return Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;
}

/** Время свечи, в которую попадает момент (для маркеров на D1). */
function snap(t: UTCTimestamp, step: number): UTCTimestamp {
  return (Math.floor(t / step) * step) as UTCTimestamp;
}

function precisionOf(tick: string | null): { precision: number; minMove: number } {
  if (!tick) return { precision: 2, minMove: 0.01 };
  const t = tick.replace(/0+$/, "");
  const i = t.indexOf(".");
  const p = i < 0 ? 0 : t.length - i - 1;
  return { precision: p, minMove: Number(tick) || 0.01 };
}

export function SignalChart({ candles, tf, signal, analysis, events, highlight, tick, lastPrice, height = 380 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<Map<string, IPriceLine[]>>(new Map());
  const auxRef = useRef<Map<string, ISeriesApi<"Line">[]>>(new Map());
  const boxRef = useRef<BoxPrimitive | null>(null);
  const [ready, setReady] = useState(false);
  const [themeKey, setThemeKey] = useState(0);

  // смена темы → пересобрать цвета
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeKey((k) => k + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onMq = () => setThemeKey((k) => k + 1);
    mq.addEventListener("change", onMq);
    return () => {
      obs.disconnect();
      mq.removeEventListener("change", onMq);
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || candles.length === 0) return;
    let disposed = false;
    let chart: IChartApi | null = null;
    let ro: ResizeObserver | null = null;
    const lines = linesRef.current;
    const aux = auxRef.current;

    (async () => {
      const lwc = await import("lightweight-charts");
      if (disposed) return;
      const c = tokens(el);
      const { precision, minMove } = precisionOf(tick);
      chart = lwc.createChart(el, {
        width: el.clientWidth,
        height,
        layout: {
          background: { type: lwc.ColorType.Solid, color: c.bg },
          textColor: c.text,
          fontFamily: c.font,
          fontSize: 11,
          attributionLogo: false,
        },
        grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
        rightPriceScale: { borderColor: c.grid, scaleMargins: { top: 0.08, bottom: 0.08 } },
        timeScale: { borderColor: c.grid, timeVisible: true, secondsVisible: false, rightOffset: 4 },
        crosshair: {
          mode: lwc.CrosshairMode.Normal,
          vertLine: { color: c.muted, labelBackgroundColor: c.accent },
          horzLine: { color: c.muted, labelBackgroundColor: c.accent },
        },
        handleScale: { axisPressedMouseMove: true },
        localization: { locale: "ru-RU" },
      });
      chartRef.current = chart;
      const series = chart.addSeries(lwc.CandlestickSeries, {
        upColor: c.up,
        downColor: c.down,
        borderUpColor: c.up,
        borderDownColor: c.down,
        wickUpColor: c.up,
        wickDownColor: c.down,
        priceFormat: { type: "price", precision, minMove },
        priceLineVisible: false,
        lastValueVisible: true,
      });
      seriesRef.current = series;
      series.setData(
        candles.map((k) => ({
          time: k.t as UTCTimestamp,
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
        })),
      );
      const step = tf === "4h" ? 14400 : 86400;
      const sigTime = snap(ts(signal.candle_close_time) - 1 as UTCTimestamp, step);
      const firstTime = candles[0].t as UTCTimestamp;
      const lastTime = candles[candles.length - 1].t as UTCTimestamp;
      const inRange = (t: UTCTimestamp) => t >= firstTime && t <= lastTime;

      const addLine = (layer: string, price: number, color: string, style: number, title: string, width: 1 | 2 = 1) => {
        const line = series.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title });
        const arr = linesRef.current.get(layer) ?? [];
        arr.push(line);
        linesRef.current.set(layer, arr);
      };
      const addSeg = (layer: string, from: UTCTimestamp, to: UTCTimestamp, price: number, color: string, style: number) => {
        const a = snap(from, step);
        const b = snap(to, step);
        if (!inRange(a) && !inRange(b)) return;
        const from2 = (Math.max(a, firstTime) as UTCTimestamp);
        const to2 = (Math.min(Math.max(b, from2 + step), lastTime + step) as UTCTimestamp);
        const ls = chart!.addSeries(lwc.LineSeries, {
          color,
          lineWidth: 1,
          lineStyle: style,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        ls.setData([
          { time: from2, value: price },
          { time: to2, value: price },
        ]);
        const arr = auxRef.current.get(layer) ?? [];
        arr.push(ls);
        auxRef.current.set(layer, arr);
      };

      // параметры сделки
      const D = lwc.LineStyle.Dashed;
      const S = lwc.LineStyle.Solid;
      const O = lwc.LineStyle.Dotted;
      if (signal.entry) addLine("entry", Number(signal.entry), c.accent, S, "вход", 1);
      if (signal.stop_loss) addLine("sl", Number(signal.stop_loss), c.down, D, "SL");
      (["tp1", "tp2", "tp3"] as const).forEach((k) => {
        const v = signal[k];
        if (v) addLine("tp", Number(v), c.up, D, k.toUpperCase());
      });
      // уровни
      if (analysis) {
        const L = analysis.levels;
        (["pdh", "pdl", "pwh", "pwl"] as const).forEach((k) => {
          const v = L[k];
          if (v) addLine("levels", Number(v), c.muted, O, k.toUpperCase());
        });
        analysis.events.forEach((e) => {
          addSeg(e.type, ts(e.from_time), ts(e.time), Number(e.level), e.type === "bos" ? c.accent : c.warn, O);
        });
        analysis.equal_levels.forEach((e) => {
          const to = e.to_time ? ts(e.to_time) : lastTime;
          addSeg("eq", ts(e.from_time), to, Number(e.price), c.muted, D);
        });
      }
      // зона входа
      const box = new BoxPrimitive();
      series.attachPrimitive(box);
      boxRef.current = box;
      if (signal.zone) {
        const z = analysis?.zones.find((x) => x.top === signal.zone?.top && x.bottom === signal.zone?.bottom);
        const from = z ? snap(ts(z.from_time), step) : sigTime;
        box.setBoxes([
          {
            id: "zone",
            from: (Math.max(from, firstTime) as Time),
            to: null,
            top: Number(signal.zone.top),
            bottom: Number(signal.zone.bottom),
            fill: alpha(c.accent, 0.12),
            stroke: c.accent,
            label: signal.zone.kind ? signal.zone.kind.toUpperCase() : "зона",
          },
        ]);
      }
      // маркеры: свинги, снятия, события трекера, сигнальная свеча
      const markers: SeriesMarker<Time>[] = [];
      analysis?.swings.forEach((sw) => {
        const t = snap(ts(sw.time), step);
        if (!inRange(t)) return;
        markers.push({
          time: t,
          position: sw.kind === "high" ? "aboveBar" : "belowBar",
          shape: "circle",
          color: c.muted,
          text: sw.kind === "high" ? "H" : "L",
          size: 0,
        });
      });
      analysis?.sweeps.forEach((sw) => {
        const t = snap(ts(sw.time), step);
        if (!inRange(t)) return;
        markers.push({ time: t, position: sw.kind === "low" ? "belowBar" : "aboveBar", shape: "square", color: c.warn, text: "sweep", size: 0 });
      });
      markers.push({ time: sigTime, position: signal.direction === "long" ? "belowBar" : "aboveBar", shape: signal.direction === "long" ? "arrowUp" : "arrowDown", color: c.accent, text: "сигнал", size: 1 });
      events
        .filter((e) => e.type !== "created")
        .forEach((e) => {
          const t = snap(ts(e.at), step);
          if (!inRange(t)) return;
          const bad = e.type === "sl" || e.type === "expired" || e.type === "time_stop";
          markers.push({ time: t, position: bad ? "aboveBar" : "belowBar", shape: "square", color: bad ? c.down : c.up, text: EVENT_LABEL[e.type] ?? e.type, size: 0 });
        });
      markers.sort((a, b) => (a.time as number) - (b.time as number));
      lwc.createSeriesMarkers(series, markers);

      chart.timeScale().fitContent();
      ro = new ResizeObserver(() => chart?.applyOptions({ width: el.clientWidth }));
      ro.observe(el);
      setReady(true);
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      lines.clear();
      aux.clear();
      boxRef.current = null;
      seriesRef.current = null;
      chartRef.current = null;
      chart?.remove();
      setReady(false);
    };
  }, [candles, tf, signal, analysis, events, tick, height, themeKey]);

  // подсветка слоя из обоснования
  useEffect(() => {
    if (!ready) return;
    const el = ref.current;
    if (!el) return;
    const c = tokens(el);
    for (const [layer, lines] of linesRef.current) {
      lines.forEach((l) => l.applyOptions({ lineWidth: layer === highlight ? 3 : 1 }));
    }
    for (const [layer, list] of auxRef.current) {
      list.forEach((ls) => ls.applyOptions({ lineWidth: layer === highlight ? 3 : 1 }));
    }
    const box = boxRef.current;
    if (box && box.boxes.length) {
      box.setBoxes(box.boxes.map((b) => ({ ...b, highlighted: highlight === "zone", fill: alpha(c.accent, highlight === "zone" ? 0.22 : 0.12) })));
    }
  }, [highlight, ready, themeKey]);

  // живая цена
  useEffect(() => {
    if (!ready || !lastPrice) return;
    const series = seriesRef.current;
    if (!series) return;
    const c = tokens(ref.current!);
    const line = series.createPriceLine({ price: Number(lastPrice), color: c.text, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "" });
    return () => series.removePriceLine(line);
  }, [lastPrice, ready]);

  return (
    <div className={s.wrap}>
      <div ref={ref} className={s.chart} style={{ height }} data-testid="signal-chart" />
      {candles.length === 0 && <div className={s.empty}>Нет свечей для графика.</div>}
    </div>
  );
}
