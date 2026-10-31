import type { TextKey } from "./scene/text";
import type { Device, LayerKey, SceneLayer, Timeframe } from "./types";
import { LAYER_KEYS } from "./types";

/**
 * Пресеты разметки и вида (план 2B.2, ADR-0008): все «сколько показать» и «какого размера» — здесь,
 * а не магическими числами по компонентам. Пресет переключает только слои и лимиты; индикаторы и панели
 * не трогает. Параметры анализа (как искать уровни) остаются в levels.ts.
 */

/** Версия сохранённых слоёв: v5 хранит пресет и поправки поверх него; старые сохранения сбрасываются на «Чистый». */
export const LAYERS_VERSION = 5 as const;

export type PresetId = "clean" | "structure" | "levels" | "liquidity" | "detailed" | "compact";
/** Пресеты, которые пользователь выбирает в «Разметке», в порядке показа. «Компактный» — только мультичарт. */
export const SELECTABLE_PRESETS: readonly PresetId[] = ["clean", "structure", "levels", "liquidity", "detailed"];
export const PRESET_IDS: readonly PresetId[] = [...SELECTABLE_PRESETS, "compact"];

export type LevelKey = "pdh" | "pdl" | "pwh" | "pwl";

/** Лимиты показа: сколько объектов каждого слоя попадает на график. */
export interface LayerLimits {
  /** Ближайших активных групп зон (по расстоянию до закрытия последней закрытой свечи). */
  zones: number;
  /** «Уровни и зоны»: ближайший спрос и ближайшее предложение вместо первых `zones` по расстоянию. */
  zonesOnePerSide: boolean;
  /** Последних событий структуры (пробой, смена). */
  structureEvents: number;
  /** «Структура»: последний пробой и последняя смена вместо последних `structureEvents`. */
  structureLastOfEachKind: boolean;
  /** Снятий ликвидности (значки; текст — только при наведении). */
  sweeps: number;
  /** Несснятых равных максимумов и минимумов на сторону. */
  equalLevelsPerSide: number;
  /** Равные уровни — только не дальше этого числа ATR от цены. */
  equalLevelsMaxAtr: number;
  /** Поддержек и сопротивлений на сторону. */
  srPerSide: number;
  /** С этого числа касаний уровень рисуется сплошной линией. */
  srStrongTouches: number;
  /** Сумм ликвидаций на сторону с подписью в полосе справа. */
  liqTopPerSide: number;
  /** Паттерны — только на последних N свечах (выбранный — всегда). */
  patternRecentBars: number;
  patternsSignificantOnly: boolean;
  /** Последних подтверждённых фигур (выбранная — сверх). */
  figures: number;
  signals: number;
  levelKeys: readonly LevelKey[];
  /** Профиль объёма: строк и доля объёма в зоне стоимости (были VP_ROWS и VP_VALUE_AREA). */
  vpRows: number;
  vpValueArea: number;
}

export interface LayerPreset {
  id: PresetId;
  title: TextKey;
  /** false только у «Компактного» (мультичарт). */
  userSelectable: boolean;
  layers: Readonly<Record<LayerKey, boolean>>;
  limits: LayerLimits;
}

/** Бюджет подписей на холсте: всего и по слоям. Выбранный объект и подпись под курсором — сверх бюджета. */
export interface LabelBudget {
  canvas: number;
  perLayer: Readonly<Partial<Record<SceneLayer, number>>>;
}

/** Бюджет меток на ценовой шкале, без цены и отсчёта до закрытия. */
export interface AxisBudget {
  srPerSide: number;
  alerts: number;
  positions: number;
  topdown: number;
  total: number;
  /** Отсчёт до закрытия свечи под ценой. */
  countdown: boolean;
}

export interface ViewPreset {
  device: Device;
  /** Целевой шаг бара при сбросе вида, px. */
  targetBarPx: number;
  /** Шире этого бар не становится, даже если лимит таймфрейма меньше ширины. */
  maxBarPx: number;
  minBars: number;
  maxBars: Readonly<Record<Timeframe, number>>;
  /** timeScale.rightOffsetPixels: свободная зона справа от последней свечи (подписи уровней и полоса). */
  rightOffsetPx: number;
  /** Полоса справа внутри свободной зоны: карта ликвидаций и профиль объёма (0 — нет). */
  gutterPx: number;
  scaleFontPx: number;
  labelFontPx: number;
  /** Высота метки на шкале для раскладки. */
  axisLabelPx: number;
  /** Зазор между метками шкалы. */
  axisGapPx: number;
  /** Допуск попадания мышью и пальцем (pointer: coarse). */
  hitTolerancePx: number;
  touchTolerancePx: number;
  /** Полоса сверху под OHLC и кнопку «?». */
  insetTopPx: number;
  /** Объём занимает нижние (1 − volumeTop) основной панели; подписей там нет. */
  volumeTop: number;
  mainMinShare: number;
  paneIndicatorPx: number;
  paneDerivPx: number;
  paneCollapsedPx: number;
  maxExpandedPanes: number;
  labels: LabelBudget;
  axis: AxisBudget;
}

export type LayerOverrides = Readonly<Partial<Record<LayerKey, boolean>>>;
/** Что хранится: пресет и явные переключения слоёв поверх него. */
export interface MarkupSettings {
  preset: PresetId;
  overrides: LayerOverrides;
}

/** Пресет, разрешённый для одной поверхности: его читают buildScene и отрисовка. */
export interface ResolvedPreset {
  id: PresetId;
  /** Есть поправки поверх пресета → в выборе отмечен «Свой». */
  custom: boolean;
  layers: Readonly<Record<LayerKey, boolean>>;
  limits: LayerLimits;
  view: ViewPreset;
}

/** Лимиты для слоя, включённого поверх пресета, и база для всех пресетов. */
export const DEFAULT_LIMITS: LayerLimits = {
  zones: 1,
  zonesOnePerSide: false,
  structureEvents: 2,
  structureLastOfEachKind: true,
  sweeps: 2,
  equalLevelsPerSide: 1,
  equalLevelsMaxAtr: 1.5,
  srPerSide: 1,
  srStrongTouches: 5,
  liqTopPerSide: 2,
  patternRecentBars: 60,
  patternsSignificantOnly: true,
  figures: 1,
  signals: 20,
  levelKeys: ["pdh", "pdl", "pwh", "pwl"],
  vpRows: 24,
  vpValueArea: 0.7,
};

/** Сколько объектов попадает в «Найдено → Уровни» независимо от слоёв (содержимое списка как до пресетов). */
export const INDEX_LIMITS = { srPerSide: 3, zones: 2, liqPerSide: 3 } as const;

const OFF: Readonly<Record<LayerKey, boolean>> = Object.fromEntries(LAYER_KEYS.map((k) => [k, false])) as Record<LayerKey, boolean>;
const on = (...keys: LayerKey[]): Readonly<Record<LayerKey, boolean>> => ({ ...OFF, ...Object.fromEntries(keys.map((k) => [k, true])) });

export const PRESETS: Readonly<Record<PresetId, LayerPreset>> = {
  clean: { id: "clean", title: "preset.clean", userSelectable: true, layers: on("sr", "zones"), limits: { ...DEFAULT_LIMITS, srPerSide: 1, zones: 1, zonesOnePerSide: false } },
  structure: {
    id: "structure",
    title: "preset.structure",
    userSelectable: true,
    layers: on("structure", "sr", "zones"),
    limits: { ...DEFAULT_LIMITS, structureEvents: 2, structureLastOfEachKind: true, sweeps: 2, equalLevelsPerSide: 1, equalLevelsMaxAtr: 1.5, srPerSide: 1, zones: 1 },
  },
  levels: { id: "levels", title: "preset.levels", userSelectable: true, layers: on("sr", "zones", "levels"), limits: { ...DEFAULT_LIMITS, srPerSide: 2, zones: 2, zonesOnePerSide: true, levelKeys: ["pdh", "pdl", "pwh", "pwl"] } },
  liquidity: { id: "liquidity", title: "preset.liquidity", userSelectable: true, layers: on("liq_map", "sr"), limits: { ...DEFAULT_LIMITS, liqTopPerSide: 2, srPerSide: 1 } },
  detailed: {
    id: "detailed",
    title: "preset.detailed",
    userSelectable: true,
    layers: on("structure", "zones", "sr", "liq_map", "figures"),
    limits: { ...DEFAULT_LIMITS, structureEvents: 4, structureLastOfEachKind: false, sweeps: 2, equalLevelsPerSide: 2, equalLevelsMaxAtr: 3, srPerSide: 3, zones: 2, liqTopPerSide: 2, figures: 1 },
  },
  compact: { id: "compact", title: "preset.compact", userSelectable: false, layers: on("sr", "zones"), limits: { ...DEFAULT_LIMITS, srPerSide: 1, zones: 1 } },
};

/** Пресет по умолчанию — «Чистый»; утверждает владелец (ADR-0008). */
export const DEFAULT_PRESET: PresetId = "clean";

const PANES = { mainMinShare: 0.5, paneIndicatorPx: 90, paneDerivPx: 80, paneCollapsedPx: 24 } as const;

export const VIEW: Readonly<Record<Device, ViewPreset>> = {
  desktop: {
    device: "desktop",
    targetBarPx: 8,
    maxBarPx: 12,
    minBars: 40,
    maxBars: { "1m": 120, "5m": 120, "15m": 96, "1h": 120, "4h": 100, "1d": 120, "1w": 104 },
    rightOffsetPx: 104,
    gutterPx: 48,
    scaleFontPx: 12,
    labelFontPx: 11,
    axisLabelPx: 18,
    axisGapPx: 1,
    hitTolerancePx: 5,
    touchTolerancePx: 12,
    insetTopPx: 32,
    volumeTop: 0.86,
    ...PANES,
    maxExpandedPanes: 99,
    labels: { canvas: 8, perLayer: { sr: 4, zones: 2, structure: 2, levels: 2, liq_map: 2, figures: 3, signals: 3, alerts: 3, volume_profile: 1, topdown: 2, patterns: 0 } },
    axis: { srPerSide: 2, alerts: 3, positions: 3, topdown: 2, total: 9, countdown: true },
  },
  phone: {
    device: "phone",
    targetBarPx: 6,
    maxBarPx: 10,
    minBars: 30,
    maxBars: { "1m": 60, "5m": 60, "15m": 48, "1h": 60, "4h": 54, "1d": 60, "1w": 52 },
    rightOffsetPx: 64,
    gutterPx: 28,
    scaleFontPx: 11,
    labelFontPx: 11,
    axisLabelPx: 16,
    axisGapPx: 1,
    hitTolerancePx: 12,
    touchTolerancePx: 12,
    insetTopPx: 32,
    volumeTop: 0.86,
    ...PANES,
    maxExpandedPanes: 1,
    labels: { canvas: 4, perLayer: { sr: 2, zones: 1, structure: 1, levels: 1, liq_map: 1, figures: 1, signals: 2, alerts: 2, volume_profile: 0, topdown: 1, patterns: 0 } },
    axis: { srPerSide: 1, alerts: 2, positions: 3, topdown: 1, total: 6, countdown: true },
  },
  cell: {
    device: "cell",
    targetBarPx: 6,
    maxBarPx: 10,
    minBars: 30,
    maxBars: { "1m": 60, "5m": 60, "15m": 60, "1h": 60, "4h": 60, "1d": 60, "1w": 52 },
    rightOffsetPx: 48,
    gutterPx: 0,
    scaleFontPx: 11,
    labelFontPx: 11,
    axisLabelPx: 16,
    axisGapPx: 1,
    hitTolerancePx: 5,
    touchTolerancePx: 12,
    insetTopPx: 24,
    volumeTop: 0.86,
    ...PANES,
    maxExpandedPanes: 0,
    labels: { canvas: 3, perLayer: { sr: 2, zones: 1, structure: 1, levels: 0, liq_map: 0, figures: 0, signals: 0, alerts: 1, volume_profile: 0, topdown: 0, patterns: 0 } },
    axis: { srPerSide: 1, alerts: 1, positions: 0, topdown: 0, total: 3, countdown: false },
  },
};

/** Жесты и указатель (бывшие константы TerminalView и terminal.ts, значения те же). */
export const INTERACTION = {
  longPressMs: 300,
  tapSlopPx: 8,
  swipePx: 24,
  visibleDebounceMs: 200,
  wheelZoom: 0.0025,
  wheelScroll: 0.6,
  minVisibleBars: 10,
} as const;

/** Ширина контейнера уже, чем это, — телефон. */
export const PHONE_MAX_WIDTH = 640;
/** Ширина области ещё неизвестна (график не размечен) — столько свечей, в пределах лимитов вида. */
const FALLBACK_BARS = 100;

/**
 * Класс поверхности: мультичарт передаёт forced = "cell"; иначе по ширине контейнера (меньше 640 px — телефон).
 * Грубый указатель класс не меняет, только допуск попадания (hitTolerance).
 */
export function deviceFor(containerWidthPx: number, coarsePointer: boolean, forced?: Device): Device {
  void coarsePointer;
  if (forced) return forced;
  return containerWidthPx > 0 && containerWidthPx < PHONE_MAX_WIDTH ? "phone" : "desktop";
}

/** Допуск попадания по указателю: палец — шире. */
export function hitTolerance(view: ViewPreset, coarsePointer: boolean): number {
  return coarsePointer ? Math.max(view.hitTolerancePx, view.touchTolerancePx) : view.hitTolerancePx;
}

/**
 * Сколько свечей показать при сбросе вида (загрузка, ⟲, двойной клик): свободная ширина без отступа справа,
 * делённая на целевой шаг, в пределах minBars…maxBars[tf]; если свечи выходят шире maxBarPx — больше свечей.
 */
export function barsForWidth(plotWidthPx: number, view: ViewPreset, tf: Timeframe): number {
  const max = view.maxBars[tf];
  const free = plotWidthPx - view.rightOffsetPx;
  if (!(free > 0)) return Math.min(max, Math.max(view.minBars, FALLBACK_BARS));
  let n = Math.min(max, Math.max(view.minBars, Math.round(free / view.targetBarPx)));
  if (free / n > view.maxBarPx) n = Math.round(free / view.maxBarPx);
  return n;
}

const isPreset = (id: unknown): id is PresetId => typeof id === "string" && (PRESET_IDS as readonly string[]).includes(id);
const isLayer = (k: string): k is LayerKey => (LAYER_KEYS as readonly string[]).includes(k);

/** Поправки без неизвестных ключей, не-boolean значений и значений, совпадающих с пресетом. */
export function cleanOverrides(preset: PresetId, raw: unknown): LayerOverrides {
  if (!raw || typeof raw !== "object") return {};
  const base = PRESETS[preset].layers;
  const out: Partial<Record<LayerKey, boolean>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isLayer(k) && typeof v === "boolean" && v !== base[k]) out[k] = v;
  }
  return out;
}

/**
 * Разметка из сохранения: неизвестный или не выбираемый пользователем пресет (в том числе «Компактный») —
 * «Чистый»; поправки очищаются. allowCompact — для мультичарта.
 */
export function normalizeMarkup(raw: unknown, allowCompact = false): MarkupSettings {
  const r = raw && typeof raw === "object" ? (raw as { preset?: unknown; overrides?: unknown }) : {};
  const preset = isPreset(r.preset) && (allowCompact || PRESETS[r.preset].userSelectable) ? r.preset : DEFAULT_PRESET;
  return { preset, overrides: cleanOverrides(preset, r.overrides) };
}

/** Выбор пресета (в том числе повторный клик по тому же) очищает поправки. */
export function selectPreset(preset: PresetId): MarkupSettings {
  return { preset, overrides: {} };
}

/** Переключение слоя поверх пресета: значение, совпавшее с пресетом, убирает поправку. */
export function setLayerOverride(markup: MarkupSettings, key: LayerKey, value: boolean): MarkupSettings {
  const next: Partial<Record<LayerKey, boolean>> = { ...markup.overrides };
  if (PRESETS[markup.preset].layers[key] === value) delete next[key];
  else next[key] = value;
  return { preset: markup.preset, overrides: next };
}

/** Пресет для поверхности: слои пресета с поправками; гостю «Сигналы» всегда выключены (M24). */
export function resolvePreset(markup: MarkupSettings, device: Device, ctx: { authed: boolean }): ResolvedPreset {
  const id = isPreset(markup.preset) ? markup.preset : DEFAULT_PRESET;
  const preset = PRESETS[id];
  const overrides = cleanOverrides(id, markup.overrides);
  const layers: Record<LayerKey, boolean> = { ...preset.layers, ...overrides };
  if (!ctx.authed) layers.signals = false;
  return { id, custom: Object.keys(overrides).length > 0, layers, limits: preset.limits, view: VIEW[device] };
}
