/** Базовые типы графика (план 2A.3). Время — unix-секунды UTC начала свечи. */

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

export const TF_SECONDS: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
};

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Незакрытая (текущая) свеча — рисуется контуром, индикаторы считают её предварительной. */
  open_: boolean;
};

export type ChartType = "candles" | "bars" | "line" | "heikin";

export const CHART_TYPES: ChartType[] = ["candles", "bars", "line", "heikin"];

/** Цвета только из токенов дизайн-системы (план 5.3); пакет не знает про CSS, ему дают значения. */
export type ThemeTokens = {
  bg: string;
  surface: string;
  border: string;
  text: string;
  text2: string;
  text3: string;
  up: string;
  down: string;
  accent: string;
  warn: string;
  fontSans: string;
  fontMono: string;
};
