/**
 * Биты «что устарело» (план 2B.2, architecture §12). Один кадр (rAF) выполняет стадии в фиксированном порядке:
 * Format → Theme → View → Analytics → Scene. Прокрутка и масштаб ничего не отмечают: LWC сам вызывает
 * updateAllViews примитива. Биты данных (Replace…Drawings) заполнит PR D; в B данные идут через notifyCandles.
 */
export const Dirty = {
  Replace: 1,
  Prepend: 2,
  Append: 4,
  Tick: 8,
  Analytics: 16,
  Indicators: 32,
  Panes: 64,
  Scene: 128,
  Theme: 256,
  View: 512,
  Format: 1024,
  Drawings: 2048,
} as const;
export type DirtyMask = number;
