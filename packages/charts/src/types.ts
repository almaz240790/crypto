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
  /** Палитра индикаторов --ind-1…--ind-6 (план 5.3): у каждого индикатора свой цвет. */
  ind: string[];
  fontSans: string;
  fontMono: string;
};

/**
 * Класс поверхности графика (план 2B.2): считается по ширине КОНТЕЙНЕРА, а не по media query —
 * боковая панель и мультичарт меняют ширину области независимо от окна. См. presets.ts deviceFor().
 */
export type Device = "desktop" | "phone" | "cell";

/** Слои разметки, которые пользователь включает в «Слоях» (перенесено из TerminalView.tsx). */
export type LayerKey = "structure" | "zones" | "levels" | "signals" | "patterns" | "figures" | "volume_profile" | "sr" | "liq_map";
export const LAYER_KEYS: readonly LayerKey[] = ["structure", "zones", "levels", "signals", "patterns", "figures", "volume_profile", "sr", "liq_map"];

/** Панели производных под графиком. */
export type PanelKey = "funding" | "oi" | "liq" | "ls";

/**
 * Слой сцены: слой разметки, алерты пользователя и внешние объекты. "topdown" — резерв под «Разбор сверху
 * вниз» (план 2A.11, ветка docs/razbor-plan): объекты старших таймфреймов с сервера; пока всегда пустой список.
 */
export type SceneLayer = LayerKey | "alerts" | "topdown";

/**
 * Один смысл — один цвет (ADR-0008). Объекты сцены несут тон, а не hex: цвет подставляет отрисовка
 * из токенов --chart-*, поэтому смена темы — перерисовка без пересборки сцены.
 */
export type Tone =
  | "up" // поддержка, спрос, рост
  | "down" // сопротивление, предложение, падение
  | "structure" // пробой, смена, снятие, равные макс./мин. — нейтрально
  | "liq" // только оценка ликвидаций (охра)
  | "figure" // графические фигуры: приглушённо, пунктиром
  | "alert" // ценовые алерты пользователя
  | "position" // уровни сигнала (только вошедшим)
  | "selection" // выбранный или наведённый объект; никогда не смысл данных
  | "muted"; // вторичное: макс./мин. дня и недели, паттерны, профиль объёма
export const TONES: readonly Tone[] = ["up", "down", "structure", "liq", "figure", "alert", "position", "selection", "muted"];
