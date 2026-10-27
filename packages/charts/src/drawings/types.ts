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

export type StyleColor = "accent" | "up" | "down" | "warn" | "text2" | "text3";

export type DrawingStyle = { color: StyleColor; width: 1 | 2; dashed: boolean };

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

export const DEFAULT_STYLE: DrawingStyle = { color: "accent", width: 1, dashed: false };
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1, 1.272, 1.618];
export const NOTE_MAX = 140;
export const HANDLE_PX = 8;
/** Зона касания хэндла на телефоне (план 2A.7). */
export const HANDLE_TOUCH_PX = 28;
export const UNDO_STEPS = 50;

/** Сколько точек нужно поставить, чтобы рисунок был завершён. */
export function pointsNeeded(type: DrawingType): number {
  switch (type) {
    case "hline":
    case "hray":
    case "vline":
    case "note":
      return 1;
    case "channel":
    case "position-long":
    case "position-short":
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
