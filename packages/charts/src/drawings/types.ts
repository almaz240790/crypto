/** Инструменты рисования (план 2A.5). Точки — в абсолютных значениях время/цена, не в пикселях. */

export type DrawingType =
  | "hline"
  | "hray"
  | "vline"
  | "trend"
  | "ray"
  | "extended"
  | "channel"
  | "rect"
  | "fib"
  | "position-long"
  | "position-short"
  | "note"
  | "ruler";

export type Point = { time: number; price: number };

/**
 * Цвет рисунка — токен темы. По умолчанию нейтральный text2 (как у линий разметки, читается в обеих темах);
 * up/down — у позиций. "accent" — прежний цвет по умолчанию (до 11.2026): выбрать его было нельзя, поэтому такие
 * рисунки рисуются нейтральными (DrawingsPrimitive), а сохранённые данные не переписываются.
 */
export type StyleColor = "accent" | "up" | "down" | "warn" | "text2" | "text3";

/**
 * extend — у Фибоначчи: линии уровней до правого края панели (ADR-0009, «Рисование», дополнение 2026-11-13). Поля нет
 * (рисунки до 11.2026, другие клиенты) — продлены, как и true; false — линии только от A до B, как раньше. Хранится в
 * style: сервер держит style словарём (/v1/drawings), поле проходит синхронизацию без миграции.
 */
export type DrawingStyle = { color: StyleColor; width: 1 | 2; dashed: boolean; extend?: boolean };

export type Drawing = {
  id: string;
  type: DrawingType;
  points: Point[];
  style: DrawingStyle;
  text?: string;
  locked: boolean;
  /** null — на всех таймфреймах. */
  timeframe: string | null;
  /** Уровни Фибоначчи (доли), только для fib. */
  levels?: number[];
  updated_at: number;
  /** Мягкое удаление (unix-мс) — для синхронизации между устройствами; в списках не показывается. */
  deleted_at?: number | null;
};

export const DEFAULT_STYLE: DrawingStyle = { color: "text2", width: 1, dashed: false };
/** Уровни Фибоначчи по умолчанию (план 2A.5): их рисует и рисунок без поля levels — набор не меняется. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1, 1.272, 1.618];
/**
 * Уровни, которые включаются и выключаются у выбранного Фибоначчи (ADR-0009, «Рисование», дополнение 2026-11-11).
 * Цена уровня = B − (B − A) × уровень: 0 — вторая точка (конец движения), 1 — первая (начало). Отрицательные — цели
 * по движению, за второй точкой: −0.272 — 27.2 % хода дальше конца, −0.618 — 61.8 %, −1 — 100 %; больше 1 — за началом.
 */
export const FIB_PRESET_LEVELS: readonly number[] = [-1, -0.618, -0.272, 0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1, 1.272, 1.618, 2.618];
/** Границы хранимого набора — те же, что проверяет сервер (/v1/drawings): не больше 24 уровней, каждый в ±10, 3 знака. */
export const FIB_LEVELS_MAX = 24;
export const FIB_LEVEL_LIMIT = 10;
export const FIB_LEVEL_DECIMALS = 3;
export const NOTE_MAX = 140;
export const HANDLE_PX = 8;
/** Зона касания хэндла на телефоне (план 2A.7). */
export const HANDLE_TOUCH_PX = 28;
export const UNDO_STEPS = 50;
/** Мышь сдвинулась дальше этого (px) — нажатие стало протягиванием, а не кликом. Пальцу и перу — INTERACTION.tapSlopPx. */
export const CLICK_SLOP_PX = 3;
/**
 * Двойной клик, начатый постановкой точки (её отпускание завершило рисунок и сняло инструмент), — тоже рисование:
 * вид не сбрасывается, если dblclick пришёл не позже этого (мс) и не дальше DBLCLICK_SLOP_PX от точки.
 */
export const DBLCLICK_MS = 500;
export const DBLCLICK_SLOP_PX = 12;
/** Ширина имеет смысл (Фибоначчи, прямоугольник): вторая точка на той же свече — не рисунок нулевой ширины. */
export const WIDE_TYPES: readonly DrawingType[] = ["fib", "rect"];
/** Уровни Фибоначчи, выделенные толщиной и непрозрачностью (золотая середина). */
export const FIB_KEY_LEVELS: readonly number[] = [0.5, 0.618];
/** Непрозрачность промежуточных уровней Фибоначчи (0 и 1 и выделенные — непрозрачные). */
export const FIB_MINOR_ALPHA = 0.6;
/**
 * Продлённые уровни Фибоначчи (ADR-0009, «Рисование», дополнение 2026-11-13): за правой точкой линия та же, но
 * бледнее — доля непрозрачности линии внутри A–B; размах A–B выделяется, а линия видна до края панели.
 */
export const FIB_EXTEND_ALPHA = 0.55;
/** Заливка полосы между соседними уровнями разноцветного Фибоначчи (в пределах A–B): доля цвета уровня. */
export const FIB_FILL_ALPHA = 0.08;
/** Плашка подписи уровня: фон цвета области с этой непрозрачностью — свечи под подписью видны. */
export const FIB_PLAQUE_ALPHA = 0.7;
/** Подписи продлённого Фибоначчи — столбцом у шкалы цены: правый край плашки на столько px левее края панели. */
export const FIB_LABEL_EDGE_PX = 4;

/**
 * Направляющая точки (ADR-0009, «Рисование», дополнение 2026-11-13): горизонталь — сплошная GUIDE_WIDTH px салатовым
 * (выбор и действия); вертикаль у пальца — пунктир GUIDE_DASH той же толщины, непрозрачность GUIDE_VERTICAL_ALPHA
 * (вторична: цену ловят по горизонтали), с разрывом над свечой точки и самой точкой (от максимума до минимума свечи и
 * GUIDE_GAP_PX сверху и снизу): вертикаль показывает свечу, но не закрывает её фитиль; точка на краю свечи (магнит) —
 * кружок радиуса GUIDE_SNAP_R с ободком цвета поверхности.
 */
export const GUIDE_WIDTH = 1;
export const GUIDE_DASH: readonly number[] = [4, 4];
export const GUIDE_VERTICAL_ALPHA = 0.7;
export const GUIDE_GAP_PX = 6;
export const GUIDE_SNAP_R = 3;

/**
 * Позиция Long/Short — как в TradingView (ADR-0009, «Рисование», дополнение «Позиция»): одно нажатие на цену входа
 * ставит готовую позицию. Стоп — на POSITION_STOP_ATR × ATR(POSITION_ATR_PERIOD) от входа (ниже у Long, выше у
 * Short), без ATR — POSITION_FALLBACK_PCT % цены; цель — POSITION_RR риска за входом; ширина — POSITION_BARS свечей
 * вправо от свечи входа, но правый край не дальше правого края области свечей (width − POSITION_EDGE_PX): у края
 * позиция уже, до одной свечи. Узкая позиция рисуется шириной POSITION_MIN_PX — но тоже не за этим краем.
 */
export const POSITION_ATR_PERIOD = 14;
export const POSITION_STOP_ATR = 1;
export const POSITION_FALLBACK_PCT = 1;
export const POSITION_RR = 2;
export const POSITION_BARS = 30;
export const POSITION_EDGE_PX = 8;
export const POSITION_MIN_PX = 40;
/** Заливка зон прибыли и риска — та же доля цвета, что у токенов --up-fill / --down-fill (12 %): свечи видны. */
export const POSITION_FILL_ALPHA = 0.12;
/** Ручка позиции под пальцем — цель касания 44 px (половина — радиус попадания). */
export const POSITION_KNOB_TOUCH_PX = 22;
/** Видимый радиус ручки позиции: мышь, палец. */
export const POSITION_KNOB_R = 4;
export const POSITION_KNOB_TOUCH_R = 10;

export const POSITION_TYPES: readonly DrawingType[] = ["position-long", "position-short"];
export const isPosition = (t: DrawingType): t is "position-long" | "position-short" => t === "position-long" || t === "position-short";

/** Сколько точек нужно поставить, чтобы рисунок был завершён. Позиция — одним нажатием (стоп и цель — по ATR). */
export function pointsNeeded(type: DrawingType): number {
  switch (type) {
    case "hline":
    case "hray":
    case "vline":
    case "note":
    case "position-long":
    case "position-short":
      return 1;
    case "channel":
      return 3;
    default:
      return 2;
  }
}

export const TOOL_TITLES: Record<DrawingType, string> = {
  hline: "Горизонтальная линия",
  hray: "Горизонтальный луч",
  vline: "Вертикальная линия",
  trend: "Трендовая линия",
  ray: "Луч",
  extended: "Продлённая линия",
  channel: "Параллельный канал",
  rect: "Прямоугольник",
  fib: "Фибоначчи",
  "position-long": "Позиция Long",
  "position-short": "Позиция Short",
  note: "Заметка",
  ruler: "Измеритель",
};
