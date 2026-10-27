"use client";

import { createTerminal, tokensFromElement, type Candle, type ChartType, type Terminal, type Timeframe } from "@platform/charts";
import { DrawingController, DrawingsPrimitive, INDICATORS, defaultParams, indicatorById, visibleOn, type Drawing, type DrawingType, type DrawingsState, type IndicatorSpec, type Layer, type LayerContext, type Point, TF_SECONDS } from "@platform/charts";
import { LineSeries, createSeriesMarkers, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { BoxPrimitive } from "@/components/chart/BoxPrimitive";
import type { Derivatives, LayersResponse } from "@/lib/chart";
import s from "./terminal.module.css";

export type ActiveIndicator = { id: string; params: Record<string, number> };
export type LayerKey = "structure" | "zones" | "levels" | "signals";
export type PanelKey = "funding" | "oi" | "liq";
export const PANELS: { id: PanelKey; title: string }[] = [
  { id: "funding", title: "Funding" },
  { id: "oi", title: "Open interest" },
  { id: "liq", title: "Ликвидации" },
];

type Props = {
  candles: Candle[];
  current: Candle | null;
  tf: Timeframe;
  type: ChartType;
  indicators: ActiveIndicator[];
  layersOn: Record<LayerKey, boolean>;
  layers: LayersResponse | null;
  derivatives: Derivatives | null;
  panels: PanelKey[];
  tick: string | null;
  onNeedOlder: (before: number) => Promise<{ candles: Candle[]; hasOlder: boolean } | null>;
  drawings?: {
    state: DrawingsState;
    tool: DrawingType | null;
    magnet: boolean;
    draft: Drawing | null;
    onCreate: (d: Drawing) => void;
    onMove: (id: string, points: Point[], final: boolean) => void;
    onSelect: (id: string | null) => void;
    onDraft: (d: Drawing | null) => void;
    onToolDone: () => void;
  };
};

/** Слой-обёртка над примитивом: менеджер слоёв терминала сам переподключает его при смене типа графика. */
class PrimitiveLayer implements Layer {
  private main: LayerContext["main"] | null = null;
  constructor(readonly id: string, private readonly primitive: { attached?: unknown } & object) {}
  attach(ctx: LayerContext): void {
    this.main = ctx.main;
    ctx.main.attachPrimitive(this.primitive as never);
  }
  detach(): void {
    this.main?.detachPrimitive(this.primitive as never);
    this.main = null;
  }
  setVisible(): void {}
}

function precisionOf(tick: string | null): { precision: number; minMove: number } {
  if (!tick) return { precision: 2, minMove: 0.01 };
  const t = tick.replace(/0+$/, "");
  const i = t.indexOf(".");
  return { precision: i < 0 ? 0 : t.length - i - 1, minMove: Number(tick) || 0.01 };
}

type Pane = { spec: IndicatorSpec; paneIndex: number | null; series: Record<string, ISeriesApi<"Line" | "Histogram">> };

/** Обёртка React над Terminal из packages/charts: данные, индикаторы, слои, тема. */
export function TerminalView({ candles, current, tf, type, indicators, layersOn, layers, derivatives, panels, tick, onNeedOlder, drawings }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const tfRef = useRef(tf);
  const panesRef = useRef<Map<string, Pane>>(new Map());
  const cryptoRef = useRef<Map<PanelKey, { paneIndex: number; series: ISeriesApi<"Line" | "Histogram">[] }>>(new Map());
  const auxRef = useRef<ISeriesApi<"Line">[]>([]);
  const boxRef = useRef<BoxPrimitive | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const drawPrimRef = useRef<DrawingsPrimitive | null>(null);
  const ctrlRef = useRef<DrawingController | null>(null);
  const drawingsRef = useRef(drawings);
  const candlesRef = useRef<Candle[]>([]);
  const needOlderRef = useRef(onNeedOlder);
  useEffect(() => {
    needOlderRef.current = onNeedOlder;
    drawingsRef.current = drawings;
    tfRef.current = tf;
  }, [onNeedOlder, drawings, tf]);

  // создание терминала
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const term = createTerminal(el, {
      tokens: tokensFromElement(el),
      type,
      onNeedOlder: (before) => {
        void needOlderRef.current(before).then((r) => {
          if (!r) return;
          term.addOlder(r.candles, r.hasOlder);
        });
      },
    });
    termRef.current = term;
    const box = new BoxPrimitive();
    boxRef.current = box;
    term.layers.add(new PrimitiveLayer("zones", box));
    const prim = new DrawingsPrimitive(tokensFromElement(el));
    prim.touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
    drawPrimRef.current = prim;
    term.layers.add(new PrimitiveLayer("drawings", prim));
    const ctrl = new DrawingController(
      el,
      prim.projector!,
      {
        getDrawings: () => {
          const d = drawingsRef.current;
          return d ? visibleOn(d.state, tfRef.current) : [];
        },
        getCandles: () => candlesRef.current,
        tfSeconds: TF_SECONDS[tfRef.current],
        timeframe: null,
        touch: prim.touch,
        magnet: true,
        newId: () => `d_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      },
      {
        onCreate: (d) => drawingsRef.current?.onCreate(d),
        onMove: (id, pts, final) => drawingsRef.current?.onMove(id, pts, final),
        onSelect: (id) => drawingsRef.current?.onSelect(id),
        onDraft: (d) => drawingsRef.current?.onDraft(d),
        onDone: () => drawingsRef.current?.onToolDone(),
      },
    );
    ctrlRef.current = ctrl;
    const obs = new MutationObserver(() => {
      term.setTheme(tokensFromElement(el));
      prim.update({ tokens: tokensFromElement(el) });
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onMq = () => term.setTheme(tokensFromElement(el));
    mq.addEventListener("change", onMq);
    const onDbl = () => term.resetView(120);
    el.addEventListener("dblclick", onDbl);
    const panes = panesRef.current;
    return () => {
      obs.disconnect();
      mq.removeEventListener("change", onMq);
      el.removeEventListener("dblclick", onDbl);
      panes.clear();
      auxRef.current = [];
      boxRef.current = null;
      markersRef.current = null;
      ctrl.destroy();
      ctrlRef.current = null;
      drawPrimRef.current = null;
      term.destroy();
      termRef.current = null;
    };
    // тип меняется через setType ниже, не пересоздаём
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // данные
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const all = current ? [...candles, current] : candles;
    term.setCandles(all, true);
    term.resetView(150);
    candlesRef.current = all;
    drawPrimRef.current?.projector?.setBars(all.map((c) => c.time), TF_SECONDS[tf]);
    drawPrimRef.current?.update({});
    const { precision, minMove } = precisionOf(tick);
    term.chart.applyOptions({ localization: { priceFormatter: (p: number) => p.toFixed(precision) } });
    void minMove;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, tick]);

  useEffect(() => {
    const term = termRef.current;
    if (term && current) term.update(current);
    if (current) {
      const all = [...candles, current];
      candlesRef.current = all;
      drawPrimRef.current?.projector?.setBars(all.map((c) => c.time), TF_SECONDS[tf]);
    }
  }, [current, candles, tf]);

  // рисунки: синхронизируем примитив и контроллер с внешним состоянием
  useEffect(() => {
    const prim = drawPrimRef.current;
    const ctrl = ctrlRef.current;
    if (!prim || !ctrl) return;
    prim.update({ drawings: drawings ? visibleOn(drawings.state, tf) : [], draft: drawings?.draft ?? null, selectedId: drawings?.state.selectedId ?? null });
    if (ctrl.tool !== (drawings?.tool ?? null)) ctrl.setTool(drawings?.tool ?? null);
    ctrl.setMagnet(drawings?.magnet ?? true);
  }, [drawings, tf]);

  useEffect(() => {
    termRef.current?.setType(type);
    // маркеры привязаны к старой серии — пересоздать при следующем расчёте слоёв
    markersRef.current = null;
  }, [type]);

  // индикаторы: по активному списку создаём панели/серии, считаем на всех свечах
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const tokens = tokensFromElement(ref.current!);
    const color = (k: string) => (({ accent: tokens.accent, up: tokens.up, down: tokens.down, warn: tokens.warn, text2: tokens.text2, text3: tokens.text3 }) as Record<string, string>)[k] ?? tokens.accent;
    const want = new Map(indicators.map((i) => [i.id, i]));
    for (const [id, pane] of panesRef.current) {
      if (!want.has(id)) {
        Object.values(pane.series).forEach((sr) => term.removeSeries(sr));
        panesRef.current.delete(id);
      }
    }
    const all = current ? [...candles, current] : candles;
    for (const ind of indicators) {
      const spec = indicatorById(ind.id);
      if (!spec) continue;
      let pane = panesRef.current.get(ind.id);
      if (!pane) {
        const paneIndex = spec.pane === "separate" ? term.addPane(90) : null;
        const series: Pane["series"] = {};
        for (const sp of spec.series) {
          series[sp.key] = sp.kind === "histogram" ? term.addHistogram(paneIndex ?? 0, color(sp.color)) : term.addLine(paneIndex ?? 0, color(sp.color), sp.width ?? 1);
        }
        pane = { spec, paneIndex, series };
        panesRef.current.set(ind.id, pane);
      }
      const out = spec.compute(all, { ...defaultParams(spec), ...ind.params });
      for (const sp of spec.series) {
        const values = out[sp.key] ?? [];
        const data = all.map((c, i) => ({ time: c.time as UTCTimestamp, value: values[i] })).filter((d) => d.value != null) as { time: UTCTimestamp; value: number }[];
        pane.series[sp.key]!.setData(data as never);
      }
    }
  }, [indicators, candles, current]);

  // крипто-панели (план 2A.4): funding, OI, ликвидации — данные с сервера, выровнены по корзинам tf
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const tokens = tokensFromElement(ref.current!);
    const want = new Set(panels);
    for (const [k, p] of cryptoRef.current) {
      if (!want.has(k)) {
        p.series.forEach((sr) => term.removeSeries(sr));
        cryptoRef.current.delete(k);
      }
    }
    if (!derivatives) return;
    const asLine = (rows: { t: number; v: string }[]) => rows.map((r) => ({ time: r.t as UTCTimestamp, value: Number(r.v) }));
    for (const k of panels) {
      let p = cryptoRef.current.get(k);
      if (!p) {
        const paneIndex = term.addPane(80);
        const series: ISeriesApi<"Line" | "Histogram">[] = [];
        if (k === "funding") series.push(term.addLine(paneIndex, tokens.warn, 1));
        else if (k === "oi") series.push(term.addLine(paneIndex, tokens.accent, 1));
        else series.push(term.addHistogram(paneIndex, tokens.up), term.addHistogram(paneIndex, tokens.down));
        p = { paneIndex, series };
        cryptoRef.current.set(k, p);
      }
      if (k === "funding") p.series[0]!.setData(asLine(derivatives.funding.map((r) => ({ t: r.t, v: String(Number(r.v) * 100) }))) as never);
      else if (k === "oi") p.series[0]!.setData(asLine(derivatives.oi) as never);
      else {
        p.series[0]!.setData(derivatives.liquidations.map((r) => ({ time: r.t as UTCTimestamp, value: Number(r.long), color: tokens.up })) as never);
        p.series[1]!.setData(derivatives.liquidations.map((r) => ({ time: r.t as UTCTimestamp, value: -Number(r.short), color: tokens.down })) as never);
      }
    }
  }, [derivatives, panels]);

  // слои: зоны (прямоугольники), структура (отрезки BOS/CHoCH, свинги), уровни, сигналы
  useEffect(() => {
    const term = termRef.current;
    if (!term || candles.length === 0) return;
    const el = ref.current!;
    const tokens = tokensFromElement(el);
    const alpha = (hex: string, a: number) => {
      const m = /^#([0-9a-f]{6})$/i.exec(hex);
      if (!m) return hex;
      const n = parseInt(m[1]!, 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; // color-ok: из токена
    };
    const main = term.mainSeries;
    auxRef.current.forEach((sr) => term.chart.removeSeries(sr));
    auxRef.current = [];
    if (!boxRef.current) return;
    const first = candles[0]!.time;
    const last = (current ?? candles[candles.length - 1]!).time;
    const step = (candles[1]?.time ?? first + 1) - first;
    const snap = (t: number) => Math.floor(t / step) * step;
    const seg = (from: number, to: number | null, price: number, c: string, style: number, width: 1 | 2 = 1) => {
      const a = Math.max(snap(from), first);
      const b = to === null ? last : Math.min(Math.max(snap(to), a + step), last);
      if (a > last) return;
      const ls = term.chart.addSeries(LineSeries, { color: c, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      ls.setData([{ time: a as UTCTimestamp, value: price }, { time: b as UTCTimestamp, value: price }]);
      auxRef.current.push(ls);
    };
    const st = layers?.structure;
    const boxes = [];
    const markers: SeriesMarker<Time>[] = [];
    if (st && layersOn.zones) {
      // активные зоны — с заливкой и подписью; отработанные — только последние 8, контуром без подписи
      const active = st.zones.filter((z) => z.status === "active");
      const inactive = st.zones.filter((z) => z.status !== "active").slice(-8);
      for (const z of [...inactive, ...active]) {
        const isActive = z.status === "active";
        boxes.push({ id: `${z.kind}-${z.from_t}`, from: Math.max(snap(z.from_t), first) as Time, to: null, top: Number(z.top), bottom: Number(z.bottom), fill: alpha(tokens.accent, isActive ? 0.12 : 0), stroke: isActive ? tokens.accent : alpha(tokens.text3, 0.5), label: isActive ? z.kind.toUpperCase() : undefined });
      }
    }
    if (st && layersOn.structure) {
      for (const e of st.events.slice(-12)) seg(e.from_t, e.t, Number(e.level), e.type === "bos" ? tokens.accent : tokens.warn, 1);
      // свинги маркерами не рисуем: на телефоне LWC делает их крупными кружками и они перекрывают свечи
      for (const sw of st.sweeps.slice(-4)) {
        const t = snap(sw.t);
        if (t < first) continue;
        markers.push({ time: t as Time, position: sw.kind === "low" ? "belowBar" : "aboveBar", shape: "square", color: tokens.warn, text: "sweep", size: 0 });
      }
      for (const e of st.equal_levels.slice(-6)) seg(e.from_t, e.to_t, Number(e.p), tokens.text3, 2);
    }
    if (st && layersOn.levels) {
      for (const k of ["pdh", "pdl", "pwh", "pwl"]) {
        const v = st.levels[k];
        if (v) seg(first, null, Number(v), tokens.text3, 3);
      }
    }
    if (layers && layersOn.signals) {
      for (const sg of layers.signals.slice(0, 20)) {
        const t = snap(sg.t - 1);
        if (t < first) continue;
        const open = !["closed_sl", "closed_be", "closed_tp3", "closed_time", "expired", "cancelled"].includes(sg.status);
        markers.push({ time: t as Time, position: sg.dir === "long" ? "belowBar" : "aboveBar", shape: sg.dir === "long" ? "arrowUp" : "arrowDown", color: open ? tokens.accent : tokens.text3, text: `${sg.grade}${open ? "" : " · " + sg.status}`, size: 1 });
        if (open && sg.entry) seg(t, null, Number(sg.entry), tokens.accent, 0, 1);
        if (open && sg.sl) seg(t, null, Number(sg.sl), tokens.down, 1);
        if (open) for (const tp of sg.tp) if (tp) seg(t, null, Number(tp), tokens.up, 1);
      }
    }
    boxRef.current.setBoxes(boxes);
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    if (!markersRef.current) markersRef.current = createSeriesMarkers(main, markers);
    else markersRef.current.setMarkers(markers);
  }, [layers, layersOn, candles, current, tf, type]);

  return (
    <div className={s.chart}>
      <div ref={ref} className={s.canvas} data-testid="terminal" />
      {candles.length === 0 && <div className={s.empty}>Нет свечей.</div>}
    </div>
  );
}

export { INDICATORS };
