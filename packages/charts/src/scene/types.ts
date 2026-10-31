import type { SceneLayer, Tone } from "../types";

/**
 * Сцена (план 2B.2): что нарисовать поверх свечей, в единицах данных (время, цена) и смыслах (тон), без LWC,
 * DOM и hex-цветов. Строит её чистая функция buildScene; координаты считает layout/project.ts в каждом кадре.
 */

export type LineStyleKey = "solid" | "dotted" | "dashed" | "longDashed";
/** Штрихи линий, px: dotted [1,3], dashed [4,4], longDashed [8,6]. */
export const LINE_DASH: Readonly<Record<LineStyleKey, readonly number[]>> = { solid: [], dotted: [1, 3], dashed: [4, 4], longDashed: [8, 6] };

/** Места подписи по порядку попыток (см. layout/project.ts). */
export type SlotKey =
  | "free-above"
  | "free-below" // свободная зона справа от последней свечи — основное место подписей уровней
  | "line-end-above"
  | "line-end-below"
  | "line-start-above"
  | "break-above"
  | "break-below" // структура: у свечи пробоя, в сторону от хвоста
  | "box-top-left"
  | "box-bottom-left"
  | "box-free" // зона: внутри коробки, x прижат к области
  | "glyph-above"
  | "glyph-below"
  | "polyline-end-above"
  | "polyline-start-above"
  | "gutter-mid"; // суммы ликвидаций и POC в полосе справа

/** Подсказка при наведении: строки уже на языке интерфейса, числа форматирует подсказка (fmt.price). */
export interface HoverInfo {
  title: string;
  subtitle?: string;
  price?: number;
  /** Зоны: диапазон от price до priceTo. */
  priceTo?: number;
  touches?: number;
  amountUsd?: number;
  /** Карта ликвидаций — оценка. */
  estimate?: boolean;
  /** Строка с датой: «с 12.10.26 08:00 UTC», «закрытие за уровнем …». */
  detail?: string;
  note?: string;
}

export interface LabelSpec {
  text: string;
  tone: Tone;
  /** 0..100: 95 выбранный, 90 алерты и позиции, 80 ближайшие S/R, … 10 текст значка (architecture §6). */
  priority: number;
  slots: readonly SlotKey[];
  font: "sans" | "mono";
  /** always — всегда; hover — только при наведении или выборе (значки). */
  show: "always" | "hover";
  /** Монохромный значок перед текстом (колокольчик алерта, план 2A.6). */
  icon?: "bell";
}

export interface AxisSpec {
  /** Только цена («83 528»): смысл передают тон и подпись на холсте. */
  text: string;
  tone: Tone;
  /** outline — фон поверхности и текст цветом тона; залитая метка только у цены и отсчёта до закрытия. */
  style: "outline" | "solid";
  priority: number;
  group: "sr" | "alert" | "position" | "topdown";
}

export interface SceneObjectBase {
  /** Стабилен между пересборками: "sr:R:83528.0", "zone:1792000000:99.5", "bos:…", "pat:1", "fig:5", "alert:3". */
  id: string;
  /** Объекты одной сущности (фигура и её цель/слом, линии сигнала): выбор одного выделяет все. */
  groupId?: string;
  layer: SceneLayer;
  tone: Tone;
  priority: number;
  hover: HoverInfo;
  label?: LabelSpec;
  axis?: AxisSpec;
  /** dimmed — только у заливок (тепловая карта, профиль), никогда у линий и текста. */
  emphasis: "normal" | "selected" | "dimmed";
}

export interface HLineObject extends SceneObjectBase {
  kind: "hline";
  price: number;
  /** unix с; null — от левого края. */
  from: number | null;
  /** null — до правого края (через свободную зону). */
  to: number | null;
  style: LineStyleKey;
  width: 1 | 2;
}

export interface BoxObject extends SceneObjectBase {
  kind: "box";
  top: number;
  bottom: number;
  from: number;
  to: number | null;
}

export interface GlyphObject extends SceneObjectBase {
  kind: "glyph";
  time: number;
  /** Цена объекта; положение значка — у хвоста свечи (side), цена — запасной вариант без свечи. */
  price: number | null;
  side: "above" | "below" | "at";
  shape: "dot" | "triangle-up" | "triangle-down" | "diamond" | "ring";
}

export type TimePrice = readonly [time: number, price: number];

export interface PolylineObject extends SceneObjectBase {
  kind: "polyline";
  /** Каждая линия фигуры — отдельный путь. */
  paths: readonly (readonly TimePrice[])[];
  style: LineStyleKey;
  width: 1 | 2;
  /** Точки фигуры — значками, только у выбранной. */
  dots?: readonly TimePrice[];
}

/** Подпись суммы у крупнейшего скопления ликвидаций. */
export interface HeatTop {
  id: string;
  side: "long" | "short";
  price: number;
  amountUsd: number;
  label: LabelSpec;
  hover: HoverInfo;
}

/** Только когда карта ликвидаций построена (покрытие OI ≥ LIQ_MIN_OI_COVERAGE). */
export interface HeatObject extends SceneObjectBase {
  kind: "heat";
  step: number;
  bars: readonly { price: number; long: number; short: number; weight: number }[];
  tops: readonly HeatTop[];
}

/** Строки профиля зависят от видимого участка, поэтому их считает отрисовка. */
export interface ProfileObject extends SceneObjectBase {
  kind: "profile";
  rows: number;
  valueArea: number;
}

export type SceneObject = HLineObject | BoxObject | GlyphObject | PolylineObject | HeatObject | ProfileObject;

export type LegendKey =
  | "price"
  | "resistance"
  | "support"
  | "demand"
  | "supply"
  | "zone"
  | "bos"
  | "choch"
  | "sweep"
  | "eq"
  | "level"
  | "liq"
  | "figure"
  | "pattern"
  | "poc"
  | "alert"
  | "position"
  | "topdown"
  | "selection";

export interface LegendEntry {
  key: LegendKey;
  layer: SceneLayer | null;
  tone: Tone;
  mark: "price" | "line" | "dashed" | "dotted" | "box" | "glyph" | "heat" | "selection";
  /** «Сопротивление» */
  text: string;
  /** Одна строка для окна «?». */
  explain: string;
}

/** Строка «Найдено → Уровни»: каждый объект, который сцена рассмотрела, нарисован он или нет. */
export interface LevelRow {
  /** Совпадает с id объекта сцены, если он нарисован. */
  id: string;
  layer: SceneLayer;
  kind: "support" | "resistance" | "demand" | "supply" | "zone" | "liq-long" | "liq-short" | "pdh" | "pdl" | "pwh" | "pwl";
  price: number;
  priceTo?: number;
  touches?: number;
  amountUsd?: number;
  estimate?: boolean;
  /** Виды исходных зон (ob/sd/fvg) — для подписи в списке. */
  kinds?: readonly string[];
  /** Вид и направление каждой исходной зоны (у смешанной группы — разные): названия в списке словами. */
  parts?: readonly { kind: string; dir: "up" | "down" }[];
  /** От закрытия последней закрытой свечи, %. */
  distancePct: number;
  onChart: boolean;
}

export interface SceneIndex {
  version: number;
  /** По убыванию цены; разделитель «текущая цена» вставляет интерфейс. */
  levels: readonly LevelRow[];
  onChart: ReadonlySet<string>;
  /** Подходили, но отрезаны лимитом (список может предложить «показать на графике»). */
  dropped: ReadonlySet<string>;
  /** Производные загружены, свечи есть, а покрытие OI ниже LIQ_MIN_OI_COVERAGE — независимо от слоя. */
  liqUnavailable: boolean;
}

export interface Scene {
  /** +1 при каждой пересборке с другим ключом. */
  version: number;
  /** Ключ входа: buildScene возвращает prev, если он не изменился. */
  key: string;
  objects: readonly SceneObject[];
  /** По id объекта и id подписей сумм ликвидаций (они ведут к объекту карты). */
  byId: ReadonlyMap<string, SceneObject>;
  legend: readonly LegendEntry[];
  index: SceneIndex;
  selected: string | null;
}
