import type { Candle } from "../types";
import { atr, bollinger, ema, macd, rsi, sma, stochastic, supertrend, volumeSma, vwapDaily, type Value } from "./core";

/** Описание индикатора для панели настроек и шаблонов (план 2A.4). Цвета — ключи токенов, не hex. */
export type ParamSpec = { key: string; label: string; default: number; min: number; max: number; step?: number };
export type SeriesSpec = { key: string; label: string; kind: "line" | "histogram"; color: "accent" | "up" | "down" | "warn" | "text2" | "text3"; width?: 1 | 2 };
export type IndicatorSpec = {
  id: string;
  title: string;
  pane: "overlay" | "separate";
  params: ParamSpec[];
  series: SeriesSpec[];
  /** Уровни на отдельной панели (RSI 30/70 и т. п.). */
  levels?: number[];
  compute(candles: readonly Candle[], params: Record<string, number>): Record<string, Value[]>;
};

export const INDICATORS: IndicatorSpec[] = [
  {
    id: "ema", title: "EMA", pane: "overlay",
    params: [{ key: "period", label: "Период", default: 50, min: 1, max: 500 }],
    series: [{ key: "value", label: "EMA", kind: "line", color: "accent", width: 1 }],
    compute: (c, p) => ({ value: ema(c, p.period ?? 50) }),
  },
  {
    id: "sma", title: "SMA", pane: "overlay",
    params: [{ key: "period", label: "Период", default: 20, min: 1, max: 500 }],
    series: [{ key: "value", label: "SMA", kind: "line", color: "text2", width: 1 }],
    compute: (c, p) => ({ value: sma(c, p.period ?? 20) }),
  },
  {
    id: "vwap", title: "VWAP (дневной)", pane: "overlay", params: [],
    series: [{ key: "value", label: "VWAP", kind: "line", color: "warn", width: 1 }],
    compute: (c) => ({ value: vwapDaily(c) }),
  },
  {
    id: "supertrend", title: "Supertrend", pane: "overlay",
    params: [{ key: "period", label: "ATR", default: 10, min: 1, max: 100 }, { key: "mult", label: "Множитель", default: 3, min: 0.5, max: 10, step: 0.5 }],
    series: [{ key: "line", label: "Supertrend", kind: "line", color: "accent", width: 2 }],
    compute: (c, p) => {
      const v = supertrend(c, p.period ?? 10, p.mult ?? 3);
      return { line: v.map((x) => x.line), dir: v.map((x) => x.dir) };
    },
  },
  {
    id: "bb", title: "Bollinger Bands", pane: "overlay",
    params: [{ key: "period", label: "Период", default: 20, min: 1, max: 500 }, { key: "mult", label: "σ", default: 2, min: 0.5, max: 5, step: 0.5 }],
    series: [{ key: "mid", label: "Средняя", kind: "line", color: "text3" }, { key: "up", label: "Верхняя", kind: "line", color: "text2" }, { key: "lo", label: "Нижняя", kind: "line", color: "text2" }],
    compute: (c, p) => {
      const v = bollinger(c, p.period ?? 20, p.mult ?? 2);
      return { mid: v.map((x) => x.mid), up: v.map((x) => x.up), lo: v.map((x) => x.lo) };
    },
  },
  {
    id: "rsi", title: "RSI", pane: "separate", levels: [30, 70],
    params: [{ key: "period", label: "Период", default: 14, min: 2, max: 100 }],
    series: [{ key: "value", label: "RSI", kind: "line", color: "accent" }],
    compute: (c, p) => ({ value: rsi(c, p.period ?? 14) }),
  },
  {
    id: "macd", title: "MACD", pane: "separate", levels: [0],
    params: [{ key: "fast", label: "Быстрая", default: 12, min: 1, max: 100 }, { key: "slow", label: "Медленная", default: 26, min: 2, max: 200 }, { key: "signal", label: "Сигнальная", default: 9, min: 1, max: 100 }],
    series: [{ key: "hist", label: "Гистограмма", kind: "histogram", color: "text3" }, { key: "line", label: "MACD", kind: "line", color: "accent" }, { key: "signal", label: "Сигнальная", kind: "line", color: "warn" }],
    compute: (c, p) => {
      const v = macd(c, p.fast ?? 12, p.slow ?? 26, p.signal ?? 9);
      return { line: v.map((x) => x.line), signal: v.map((x) => x.signal), hist: v.map((x) => x.hist) };
    },
  },
  {
    id: "stoch", title: "Stochastic", pane: "separate", levels: [20, 80],
    params: [{ key: "k", label: "%K", default: 14, min: 1, max: 100 }, { key: "d", label: "%D", default: 3, min: 1, max: 50 }, { key: "smooth", label: "Сглаживание", default: 3, min: 1, max: 50 }],
    series: [{ key: "k", label: "%K", kind: "line", color: "accent" }, { key: "d", label: "%D", kind: "line", color: "warn" }],
    compute: (c, p) => {
      const v = stochastic(c, p.k ?? 14, p.d ?? 3, p.smooth ?? 3);
      return { k: v.map((x) => x.k), d: v.map((x) => x.d) };
    },
  },
  {
    id: "atr", title: "ATR", pane: "separate",
    params: [{ key: "period", label: "Период", default: 14, min: 1, max: 100 }],
    series: [{ key: "value", label: "ATR", kind: "line", color: "accent" }, { key: "pct", label: "ATR, % от цены", kind: "line", color: "text3" }],
    compute: (c, p) => {
      const v = atr(c, p.period ?? 14);
      return { value: v, pct: v.map((x, i) => (x === null ? null : (100 * x) / c[i]!.close)) };
    },
  },
  {
    id: "volume", title: "Volume", pane: "separate",
    params: [{ key: "period", label: "MA", default: 20, min: 1, max: 200 }],
    series: [{ key: "volume", label: "Объём", kind: "histogram", color: "text3" }, { key: "ma", label: "MA", kind: "line", color: "warn" }],
    compute: (c, p) => ({ volume: c.map((x) => x.volume), ma: volumeSma(c, p.period ?? 20) }),
  },
];

export const indicatorById = (id: string): IndicatorSpec | undefined => INDICATORS.find((i) => i.id === id);

export function defaultParams(spec: IndicatorSpec): Record<string, number> {
  return Object.fromEntries(spec.params.map((p) => [p.key, p.default]));
}
