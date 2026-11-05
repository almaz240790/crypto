import type { AxisSpec, SlotKey } from "../scene/types";
import type { SceneLayer, Tone } from "../types";

/** Раскладка подписей и меток шкалы (план 2B.2): чистые функции над прямоугольниками в CSS px. */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  /** Ширина панели цены в CSS px (без шкалы). */
  width: number;
  height: number;
  /** Полоса сверху под OHLC и «?». */
  insetTop: number;
  /** Ниже — гистограмма объёма, подписей там нет. */
  volumeTopY: number;
  /** Свободная зона справа от последней свечи; null — последняя свеча за краем (пользователь смотрит историю). */
  free: { x0: number; x1: number } | null;
  /** Полоса карты ликвидаций и профиля: reserved — в свободной зоне; overlay — поверх свечей, приглушённо и без текста. */
  gutter: { x0: number; x1: number; mode: "reserved" | "overlay" } | null;
}

/** Слой подписи в раскладке: слой сцены или рисунки пользователя (drawings/labels.ts). */
export type LabelLayer = SceneLayer | "drawings";

/** Место подписи: левый верхний угол плашки. clampX — зона: прижать к области, а не выбросить (M09). */
export interface Slot {
  key: SlotKey;
  x: number;
  y: number;
  clampX: boolean;
}

export interface LabelCandidate {
  /** `${objectId}#label` */
  id: string;
  objectId: string;
  layer: LabelLayer;
  text: string;
  font: "sans" | "mono";
  px: number;
  /** Ширина и высота плашки вместе с отступами. */
  w: number;
  h: number;
  priority: number;
  tone: Tone;
  slots: readonly Slot[];
  /** Выбранный объект и подпись значка под курсором — сверх бюджета. */
  bypassBudget: boolean;
  selected?: boolean;
  icon?: "bell";
  /** Порядок внутри объекта при равном приоритете (скопления ликвидаций — по убыванию суммы). */
  rank?: number;
  /** Свой лимит группы подписей (суммы ликвидаций одной стороны): сверх max — «budget». */
  cap?: { key: string; max: number };
  /**
   * Подпись рисунка пользователя (drawings/labels.ts): рисует её примитив рисунков, а не разметка — в результате она
   * в external, а не в placed; подписи разметки обходят её так же, как друг друга.
   */
  external?: boolean;
  /** Плашка с фоном: колонки свечей не обходит. */
  overCandles?: boolean;
  /** Область — вся панель (без полосы OHLC сверху и объёма снизу): подписи рисунков у краёв панели. */
  area?: "pane";
  /**
   * Нет свободного места: fixed — на первом месте всё равно; soft — первое место в области, не задевающее
   * препятствия (легенду, кнопки, полосу цены), даже поверх других подписей. Без force — подпись выброшена.
   */
  force?: "fixed" | "soft";
}

/** Видимые свечи как индекс колонок: проверка пересечения за O(колонок под прямоугольником). */
export interface CandleBand {
  /** x центра первой видимой свечи. */
  x0: number;
  spacing: number;
  /** Полуширина колонки вместе с запасом 1 px. */
  halfWidth: number;
  /** y максимума и минимума по каждой видимой свече (NaN — нет свечи). */
  top: Float32Array;
  bottom: Float32Array;
}

export type ObstacleKind = "lastPrice" | "legend" | "ui" | "label";
export interface Obstacles {
  candles: CandleBand;
  rects: readonly { rect: Rect; kind: ObstacleKind }[];
}

export interface PlacedLabel {
  id: string;
  objectId: string;
  layer: LabelLayer;
  text: string;
  rect: Rect;
  slot: SlotKey;
  tone: Tone;
  font: "sans" | "mono";
  px: number;
  priority: number;
  bypassBudget: boolean;
  selected?: boolean;
  icon?: "bell";
}

export type DropReason = "budget" | "collision" | "offscreen";
export interface LayoutResult {
  placed: readonly PlacedLabel[];
  dropped: readonly { id: string; reason: DropReason }[];
  /** Размещённые подписи рисунков пользователя (кандидаты external): их рисует примитив рисунков. */
  external?: readonly PlacedLabel[];
}

export interface AxisCandidate {
  id: string;
  objectId: string;
  price: number;
  /** Сырой y: priceToCoordinate. */
  y: number;
  text: string;
  tone: Tone;
  style: "outline" | "solid";
  priority: number;
  group: AxisSpec["group"];
  /** Относительно последней цены. */
  side: "above" | "below";
}

/** Метки, которые не двигаются: цена (метка LWC), отсчёт до закрытия под ней, последнее значение наложения. */
export interface AxisFixed {
  id: "last" | "countdown" | "overlay";
  y: number;
  h: number;
}

export interface AxisPlaced {
  id: string;
  objectId: string;
  /** Итоговый центр, его отдаёт fixedCoordinate() вида на шкале. */
  y: number;
  text: string;
  tone: Tone;
  style: "outline" | "solid";
  /** Склеенные id: «83 528» у сопротивления и алерта на той же цене. */
  merged: readonly string[];
}

export interface AxisScale {
  height: number;
  labelH: number;
  gap: number;
  /** Сдвиг от сырого y не больше этого (1.5 · axisLabelPx). */
  maxShift: number;
  /** Шрифт делений: полоса скрытия = центр ± (labelH + tickFontPx) / 2 + 1. */
  tickFontPx: number;
}

export interface AxisLayout {
  placed: readonly AxisPlaced[];
  /** y-полосы, где деления шкалы пустые: каждая размещённая и фиксированная метка ± hideHalf. */
  hiddenBands: readonly (readonly [y0: number, y1: number])[];
  dropped: readonly { id: string; reason: DropReason }[];
}

/** Зазор между подписями и до препятствий, px. */
export const LABEL_GAP = 2;
/** Внутренний отступ области, px. */
export const AREA_PAD = 2;
