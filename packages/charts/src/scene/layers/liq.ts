import { formatUsd } from "../../format";
import type { LiqBucket, LiqMap } from "../../levels";
import type { HeatObject, HeatTop } from "../types";
import type { LayerBuilder, LayerCtx } from "./common";
import { emphasize } from "./common";

export const LIQ_MAP_ID = "liq:map";
export const liqTopId = (side: "long" | "short", bucket: number): string => `liq:${side === "long" ? "L" : "S"}:${bucket}`;

/**
 * Крупнейшие скопления одной стороны: соседние корзины (|i − j| ≤ 1) склеиваются в одну подпись
 * (сумма — общая, цена — у крупнейшей), затем первые `n` по сумме.
 */
export function mergeTops(m: LiqMap, side: "long" | "short", n: number): { bucket: number; price: number; amount: number }[] {
  const amount = (b: LiqBucket) => (side === "long" ? b.long : b.short);
  const tops = (side === "long" ? m.topLongs : m.topShorts).map((b) => ({ bucket: m.buckets.indexOf(b), price: b.price, amount: amount(b) })).filter((x) => x.bucket >= 0);
  const merged: { bucket: number; price: number; amount: number; members: number[] }[] = [];
  for (const t of tops) {
    const near = merged.find((g) => g.members.some((i) => Math.abs(i - t.bucket) <= 1));
    if (near) {
      near.amount += t.amount;
      near.members.push(t.bucket);
    } else merged.push({ ...t, members: [t.bucket] });
  }
  return merged.slice(0, Math.max(0, n)).map(({ bucket, price, amount: a }) => ({ bucket, price, amount: a }));
}

function tops(ctx: LayerCtx, m: LiqMap, perSide: number): HeatTop[] {
  const text = ctx.text;
  const out: HeatTop[] = [];
  for (const side of ["short", "long"] as const) {
    for (const t of mergeTops(m, side, perSide)) {
      const amountText = text.fill(text["hover.amount"], { amount: formatUsd(t.amount) });
      out.push({
        id: liqTopId(side, t.bucket),
        side,
        price: t.price,
        amountUsd: t.amount,
        label: { text: amountText, tone: "liq", priority: 25, slots: ["gutter-mid"], font: "mono", show: "always" },
        hover: { title: side === "long" ? text["liq.longs"] : text["liq.shorts"], price: t.price, amountUsd: t.amount, estimate: true, note: text["liq.note"] },
      });
    }
  }
  return out;
}

/**
 * Карта ликвидаций — один объект: все корзины с весом (long + short) / max и подписи крупнейших сумм.
 * Рисуется только в полосе справа (gutter); без карты (мало OI) объекта нет.
 */
export const buildLiq: LayerBuilder = (ctx) => {
  const m = ctx.input.analytics.liq;
  if (!m) return [];
  const sel = ctx.input.selection.selected;
  const obj: HeatObject = {
    kind: "heat",
    id: LIQ_MAP_ID,
    layer: "liq_map",
    tone: "liq",
    priority: 25,
    emphasis: "normal",
    step: m.step,
    bars: m.buckets.filter((b) => b.long + b.short > 0).map((b) => ({ price: b.price, long: b.long, short: b.short, weight: (b.long + b.short) / m.max })),
    tops: tops(ctx, m, ctx.preset.limits.liqTopPerSide),
    hover: { title: ctx.text["legend.liq"], estimate: true, note: ctx.text["liq.note"] },
  };
  const selected = sel === LIQ_MAP_ID || (sel !== null && obj.tops.some((t) => t.id === sel));
  return [{ obj: emphasize(obj, selected), legend: "liq" }];
};
