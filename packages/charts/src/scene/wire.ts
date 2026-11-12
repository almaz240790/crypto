/**
 * Данные слоёв в формате API (/v1/chart/layers, /patterns, /figures) — перенесены без изменений из
 * apps/web/src/lib/chart.ts; там они будут реэкспортироваться. Сцена читает только поля из Scene*-типов ниже,
 * поэтому полные ответы API подходят как есть.
 */
export type Structure = {
  tf: string;
  strategy_version: string | null;
  swings: { t: number; p: string; kind: "high" | "low" }[];
  events: { t: number; type: "bos" | "choch"; dir: "up" | "down"; level: string; from_t: number }[];
  zones: { kind: string; dir: string; top: string; bottom: string; from_t: number; status: string }[];
  levels: Record<string, string | null>;
  equal_levels: { kind: string; p: string; from_t: number; to_t: number | null; swept: boolean }[];
  sweeps: { t: number; kind: "high" | "low"; level: string }[];
  bias: { bias: string; d1_trend: string; w1_trend: string; ema50_d1: string | null } | null;
  atr: string | null;
  /** Начало последней закрытой свечи, по которой построен ответ (unix с; нет у старого API). */
  last_t?: number | null;
  /** false — сервер ещё дописывает закрытую свечу: ответ без неё (не кэшируется). */
  complete?: boolean;
};
/** be — стоп сейчас на цене входа: цель 1 взята, и версия стратегии переносит стоп в безубыток (сервер). */
export type SignalOnChart = { id: string; version: string; dir: "long" | "short"; t: number; status: string; grade: string; entry: string | null; sl: string | null; tp: (string | null)[]; zone: { top: string; bottom: string; kind?: string } | null; events: { type: string; p: string | null; t: number }[]; be?: boolean };
export type PatternOnChart = { id: number; type: string; title: string; direction: "up" | "down" | null; status: string; significant: boolean; t: number; start_t: number; confirm_t: number; price: string | null; atr: string | null; context: Record<string, unknown>; source: string; tf: string };
export type FigureOnChart = { id: number; type: string; title: string; direction: "up" | "down" | null; status: "forming" | "confirmed" | "invalidated"; scale: number; start_t: number; end_t: number; known_t: number; confirm_t: number | null; invalidated_t: number | null; points: [number, string][]; lines: { name: string; a: [number, string]; b: [number, string] }[]; breakout_level: string | null; target: string | null; invalidation: string | null; quality: number; metrics: Record<string, number>; source: string; tf: string };

/** Поля структуры, которые читает сцена (без свингов и тренда). */
export type SceneStructure = Pick<Structure, "events" | "zones" | "levels" | "equal_levels" | "sweeps" | "atr">;
export type SceneSignal = Pick<SignalOnChart, "id" | "dir" | "t" | "status" | "grade" | "entry" | "sl" | "tp" | "be">;
export type ScenePattern = Pick<PatternOnChart, "id" | "type" | "title" | "direction" | "significant" | "t" | "price">;
export type SceneFigure = Pick<FigureOnChart, "id" | "type" | "title" | "status" | "known_t" | "confirm_t" | "end_t" | "points" | "lines" | "target" | "invalidation">;

/** Статусы закрытых сигналов: у них нет линий входа, стопа и целей (как в TerminalView). */
export const CLOSED_SIGNAL_STATUSES: readonly string[] = ["closed_sl", "closed_be", "closed_tp3", "closed_time", "expired", "cancelled"];
/** Сколько целей открытого сигнала уже взято (по статусу трекера). */
export const SIGNAL_TARGETS_HIT: Readonly<Record<string, number>> = { tp1_hit: 1, tp2_hit: 2 };
