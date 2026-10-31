import { LayerManager } from "../../layers";
import { DEFAULT_ALPHAS, PLAQUE, type ChartTheme } from "../../theme";
import type { Candle, ThemeTokens } from "../../types";

/**
 * Поддельный LWC для тестов отрисовки и контроллера: шкала времени — логический диапазон и ширина, шкала цены —
 * линейная в заданных границах. Достаточно для OverlayPrimitive (updateAllViews, hitTest, priceAxisViews) и для
 * ChartController (подписки на перекрестие и клик, отступ справа, формат цены).
 */

export type Range = { from: number; to: number };

export const TOKENS: ThemeTokens = { bg: "#101214", surface: "#14171a", border: "#2a2f35", text: "#e8eaed", text2: "#aab1b9", text3: "#8a929b", up: "#2fbf71", down: "#ef5350", accent: "#c6f432", warn: "#d9a441", ind: ["#5b9cff", "#b18cff", "#4dd0e1", "#ffb74d", "#f06292", "#9ccc65"], fontSans: "Manrope", fontMono: "IBM Plex Mono" };

export function makeTheme(version = 1, mode: "light" | "dark" = "dark", tokens: ThemeTokens = TOKENS): ChartTheme {
  return {
    mode,
    version,
    tokens,
    palette: { up: tokens.up, down: tokens.down, structure: tokens.text2, liq: tokens.warn, figure: tokens.text3, alert: tokens.text, position: tokens.text2, selection: tokens.accent, muted: tokens.text3, text: tokens.text, surface: tokens.surface, plaque: tokens.surface, grid: tokens.border, ind: tokens.ind },
    alphas: DEFAULT_ALPHAS,
    type: { sans: tokens.fontSans, mono: tokens.fontMono, labelPx: 11, labelWeight: PLAQUE.weight, axisPx: 12, plaquePadX: PLAQUE.padX, plaquePadY: PLAQUE.padY, plaqueRadius: PLAQUE.radius },
  };
}

export const H = 14400;
export const T0 = 1_790_000_000 - (1_790_000_000 % H);
export const bars = (n: number, from = 0): Candle[] =>
  Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const o = 100 + Math.sin(i / 7) * 4;
    const c = o + Math.cos(i / 5);
    return { time: T0 + i * H, open: o, high: Math.max(o, c) + 0.6, low: Math.min(o, c) - 0.6, close: c, volume: 1000 + (i % 7) * 100, open_: false };
  });

type Primitive = { attached?(p: unknown): void; detached?(): void; updateAllViews?(): void };

export interface FakeEnv {
  chart: ReturnType<typeof makeChart>;
  series: ReturnType<typeof makeSeries>;
}

export function makeSeries(state: { top: number; bottom: number; height: number }) {
  const prims: Primitive[] = [];
  const s = {
    prims,
    updates: 0,
    priceToCoordinate: (p: number) => ((state.top - p) / (state.top - state.bottom)) * state.height,
    coordinateToPrice: (y: number) => state.top - (y / state.height) * (state.top - state.bottom),
    attachPrimitive(p: Primitive) {
      prims.push(p);
      p.attached?.({ chart: chartRef.current, series: s, requestUpdate: () => s.updates++ });
    },
    detachPrimitive(p: Primitive) {
      prims.splice(prims.indexOf(p), 1);
      p.detached?.();
    },
    applyOptions() {},
  };
  const chartRef: { current: unknown } = { current: null };
  return Object.assign(s, { chartRef });
}

export function makeChart(o: { candles: () => readonly Candle[]; width?: number; height?: number; range?: Range; axisWidth?: number }) {
  const state = { width: o.width ?? 800, height: o.height ?? 400, range: o.range ?? { from: 0, to: 110 }, axisWidth: o.axisWidth ?? 60 };
  const moves: ((p: unknown) => void)[] = [];
  const clicks: ((p: unknown) => void)[] = [];
  const applied: unknown[] = [];
  const spacing = () => state.width / (state.range.to - state.range.from);
  const sizeCbs: ((w: number, h: number) => void)[] = [];
  const ts = {
    sizeCbs,
    subscribeSizeChange: (cb: (w: number, h: number) => void) => sizeCbs.push(cb),
    unsubscribeSizeChange: (cb: (w: number, h: number) => void) => sizeCbs.splice(sizeCbs.indexOf(cb), 1),
    width: () => state.width,
    applied: [] as unknown[],
    applyOptions: (x: unknown) => ts.applied.push(x),
    timeToIndex: (time: number) => {
      const c = o.candles();
      const i = c.findIndex((x) => x.time >= time);
      return i < 0 ? (c.length ? c.length - 1 : null) : i;
    },
    logicalToCoordinate: (l: number) => (l - state.range.from) * spacing() + spacing() / 2,
    coordinateToLogical: (x: number) => state.range.from + (x - spacing() / 2) / spacing(),
    getVisibleLogicalRange: () => ({ ...state.range }),
    setVisibleLogicalRange: (r: Range) => {
      state.range = { from: r.from, to: r.to };
    },
    getVisibleRange: () => {
      const c = o.candles();
      if (c.length === 0) return null;
      const at = (l: number) => c[Math.max(0, Math.min(c.length - 1, Math.round(l)))]!.time;
      return { from: at(state.range.from), to: at(state.range.to) };
    },
  };
  const chart = {
    state,
    applied,
    moves,
    clicks,
    timeScale: () => ts,
    paneSize: () => ({ width: state.width, height: state.height }),
    priceScale: () => ({ width: () => state.axisWidth, applyOptions: () => {} }),
    subscribeCrosshairMove: (cb: (p: unknown) => void) => moves.push(cb),
    unsubscribeCrosshairMove: (cb: (p: unknown) => void) => moves.splice(moves.indexOf(cb), 1),
    subscribeClick: (cb: (p: unknown) => void) => clicks.push(cb),
    unsubscribeClick: (cb: (p: unknown) => void) => clicks.splice(clicks.indexOf(cb), 1),
    clearCrosshairPosition: () => {},
    applyOptions: (x: unknown) => applied.push(x),
  };
  return chart;
}

/** Окружение примитива: шкала цены по свечам с запасом. */
export function makeEnv(candles: () => readonly Candle[], o: { width?: number; height?: number; range?: Range; top?: number; bottom?: number } = {}) {
  const chart = makeChart({ candles, ...o });
  const priceState = { top: o.top ?? 110, bottom: o.bottom ?? 90, height: chart.state.height };
  const series = makeSeries(priceState);
  series.chartRef.current = chart;
  return { chart, series, priceState };
}

/** Терминал-подделка для ChartController: записывает вызовы, буфер — массив свечей. */
export class FakeTerminal {
  readonly layers = new LayerManager();
  readonly calls: string[] = [];
  readonly env: ReturnType<typeof makeEnv>;
  candlesArr: Candle[];
  constructor(candles: Candle[], o: { width?: number } = {}) {
    this.candlesArr = candles;
    this.env = makeEnv(() => this.candlesArr, { width: o.width ?? 800 });
    this.layers.attach({ chart: this.env.chart as never, main: this.env.series as never });
  }
  get chart() {
    return this.env.chart as never;
  }
  get mainSeries() {
    return this.env.series as never;
  }
  get candles(): readonly Candle[] {
    return this.candlesArr;
  }
  setTheme(): void {
    this.calls.push("setTheme");
  }
  setFontSize(px: number): void {
    this.calls.push(`setFontSize:${px}`);
  }
  setRightOffsetPx(px: number): void {
    this.calls.push(`setRightOffsetPx:${px}`);
  }
  setPriceFormat(): void {
    this.calls.push("setPriceFormat");
  }
  resetView(n?: number): { from: number; to: number } | null {
    this.calls.push(`resetView:${n}`);
    return { ...this.env.chart.state.range };
  }
  zoom(f: number): void {
    this.calls.push(`zoom:${f}`);
  }
  addOlder(c: Candle[]): void {
    this.candlesArr = [...c, ...this.candlesArr];
    this.calls.push("addOlder");
  }
  olderFailed(): void {
    this.calls.push("olderFailed");
  }
  overlayLastCoordinate(): number | null {
    return null;
  }
  destroy(): void {
    this.calls.push("destroy");
  }
}

/** Элемент-подделка контейнера (vitest без DOM). */
export function fakeElement(width = 1000) {
  const children: unknown[] = [];
  const mkDiv = () => {
    const d = { style: {} as Record<string, string>, dataset: {} as Record<string, string>, textContent: "", setAttribute() {}, remove() {} };
    return d;
  };
  return {
    clientWidth: width,
    children,
    ownerDocument: { createElement: () => mkDiv() },
    appendChild: (c: unknown) => children.push(c),
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLElement & { clientWidth: number; children: unknown[] };
}
