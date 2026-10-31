import { bucketStart } from "../../live";
import type { ResolvedPreset } from "../../presets";
import { TF_SECONDS } from "../../types";
import type { SceneInput } from "../input";
import type { SceneText } from "../text";
import type { HLineObject, LabelSpec, LegendKey, SceneObject, SlotKey } from "../types";

/** Всё, что нужно построителю слоя: вход сцены, пресет и вычисленные один раз величины. */
export interface LayerCtx {
  input: SceneInput;
  preset: ResolvedPreset;
  text: SceneText;
  /** Закрытие последней закрытой свечи — от него считается «ближайший». */
  ref: number;
  /** Время последней закрытой свечи. */
  lastT: number;
  /** Длительность бара, с. */
  step: number;
  /** Начало свечи таймфрейма (неделя — с понедельника). */
  snap(t: number): number;
  /** Узкий экран (телефон, ячейка мультичарта): короткие подписи. */
  short: boolean;
  /** Выбран ли объект (по id или id группы). */
  isSelected(id: string, groupId?: string): boolean;
}

/** Объект сцены и строка легенды, к которой он относится. */
export interface Built {
  obj: SceneObject;
  legend?: LegendKey;
}

/** Построитель слоя: объекты в пределах лимитов пресета плюс выбранный объект, даже если лимит его отрезал. */
export type LayerBuilder = (ctx: LayerCtx) => readonly Built[];

/** Приоритет подписи выбранного объекта: выше всех, вне бюджета. */
export const SELECTED_PRIORITY = 95;

export function makeCtx(input: SceneInput, preset: ResolvedPreset): LayerCtx | null {
  const last = input.analytics.lastClosed;
  if (!last) return null;
  const sel = input.selection.selected;
  return {
    input,
    preset,
    text: input.text,
    ref: last.close,
    lastT: last.time,
    step: TF_SECONDS[input.tf],
    snap: (t) => bucketStart(input.tf, t),
    short: preset.view.device !== "desktop",
    isSelected: (id, groupId) => sel !== null && (sel === id || (groupId !== undefined && sel === groupId)),
  };
}

/** Выбранный объект: ширина 2, подпись всегда видна с приоритетом 95. */
export function emphasize<T extends SceneObject>(obj: T, selected: boolean): T {
  if (!selected) return obj;
  const label: LabelSpec | undefined = obj.label ? { ...obj.label, priority: SELECTED_PRIORITY, show: "always" } : undefined;
  const width = obj.kind === "hline" || obj.kind === "polyline" ? { width: 2 as const } : {};
  return { ...obj, ...width, emphasis: "selected", ...(label ? { label } : {}) };
}

/** Уникальный id внутри слоя: совпавший получает суффикс «:2», «:3» (порядок входа стабилен). */
export function uniqueIds(): (id: string) => string {
  const seen = new Map<string, number>();
  return (id) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}:${n}`;
  };
}

/** Места подписи горизонтальной линии, открытой вправо: сначала в сторону от цены. */
export function lineSlots(above: boolean): readonly SlotKey[] {
  return above ? ["free-above", "free-below", "line-end-above", "line-end-below"] : ["free-below", "free-above", "line-end-below", "line-end-above"];
}

/** Горизонтальная линия: ширина 1, обычное выделение. */
export function hline(p: Omit<HLineObject, "kind" | "emphasis" | "width">): HLineObject {
  return { kind: "hline", emphasis: "normal", width: 1, ...p };
}

export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
