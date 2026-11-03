import type { ProfileObject } from "../types";
import type { LayerBuilder } from "./common";
import { emphasize } from "./common";

export const PROFILE_ID = "vp";

export type VpCandle = { time: number; high: number; low: number; volume: number };
export type VpRow = { top: number; bottom: number; volume: number; poc: boolean; value: boolean };

/**
 * Профиль объёма по видимым свечам (перенесено без изменений из VolumeProfilePrimitive.ts): объём свечи
 * распределяется поровну по корзинам, которые она покрывает; POC — корзина с наибольшим объёмом, зона стоимости —
 * доля valueArea объёма вокруг POC.
 */
export function volumeProfile(candles: readonly VpCandle[], rows: number, valueArea: number): VpRow[] {
  if (candles.length === 0 || rows <= 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  if (!(hi > lo)) return [];
  const step = (hi - lo) / rows;
  const vol = new Array<number>(rows).fill(0);
  for (const c of candles) {
    const a = Math.min(rows - 1, Math.max(0, Math.floor((c.low - lo) / step)));
    const b = Math.min(rows - 1, Math.max(0, Math.floor((c.high - lo) / step)));
    const share = c.volume / (b - a + 1);
    for (let i = a; i <= b; i++) vol[i]! += share;
  }
  let poc = 0;
  for (let i = 1; i < rows; i++) if (vol[i]! > vol[poc]!) poc = i;
  const total = vol.reduce((s, v) => s + v, 0);
  // зона стоимости: расширяем от POC в сторону большего соседа, пока не наберём долю объёма
  let a = poc;
  let b = poc;
  let acc = vol[poc]!;
  while (acc < total * valueArea && (a > 0 || b < rows - 1)) {
    const up = b < rows - 1 ? vol[b + 1]! : -1;
    const down = a > 0 ? vol[a - 1]! : -1;
    if (up >= down) {
      b++;
      acc += up;
    } else {
      a--;
      acc += down;
    }
  }
  return vol.map((v, i) => ({ bottom: lo + i * step, top: lo + (i + 1) * step, volume: v, poc: i === poc, value: i >= a && i <= b }));
}

/**
 * Профиль объёма — один объект; строки считает отрисовка по видимому участку. Полосу справа занимает карта
 * ликвидаций, если она есть: тогда профиль — поверх свечей, приглушённо и без подписи POC.
 */
export const buildProfile: LayerBuilder = (ctx) => {
  const dimmed = ctx.preset.layers.liq_map && ctx.input.analytics.liq !== null;
  const text = ctx.text;
  const obj: ProfileObject = {
    kind: "profile",
    id: PROFILE_ID,
    layer: "volume_profile",
    tone: "muted",
    priority: 20,
    emphasis: dimmed ? "dimmed" : "normal",
    rows: ctx.preset.limits.vpRows,
    valueArea: ctx.preset.limits.vpValueArea,
    ...(dimmed ? {} : { label: { text: text["vp.poc"], tone: "muted" as const, priority: 20, slots: ["gutter-mid"] as const, font: "sans" as const, show: "always" as const } }),
    hover: { title: text["vp.poc"], subtitle: text["hover.poc"] },
  };
  return [{ obj: emphasize(obj, ctx.isSelected(PROFILE_ID)), legend: "poc" }];
};
