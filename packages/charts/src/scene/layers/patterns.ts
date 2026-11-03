import type { GlyphObject } from "../types";
import type { Built, LayerBuilder } from "./common";
import { emphasize } from "./common";

export const patternId = (p: { id: number }): string => `pat:${p.id}`;

/**
 * Свечные паттерны (план 2A.9, 2B.12): маленькие монохромные значки — направление только формой
 * (▲ под минимумом, ▼ над максимумом, ромб без направления), цвет — только у выбранного (тон выделения).
 * Название — при наведении или выборе. По умолчанию значимые за последние patternRecentBars свечей.
 */
export const buildPatterns: LayerBuilder = (ctx) => {
  const { patternRecentBars, patternsSignificantOnly } = ctx.preset.limits;
  const recentFrom = ctx.lastT - patternRecentBars * ctx.step;
  const text = ctx.text;
  const out: Built[] = [];
  for (const p of ctx.input.patterns) {
    const id = patternId(p);
    const selected = ctx.isSelected(id);
    const eligible = (!patternsSignificantOnly || p.significant) && p.t >= recentFrom && p.t <= ctx.lastT;
    if (!eligible && !selected) continue;
    const up = p.direction === "up";
    const down = p.direction === "down";
    const price = p.price == null ? NaN : Number(p.price);
    const name = text.pattern(p.type, p.title);
    const obj: GlyphObject = {
      kind: "glyph",
      id,
      layer: "patterns",
      tone: selected ? "selection" : "muted",
      priority: 10,
      emphasis: "normal",
      time: ctx.snap(p.t),
      price: Number.isFinite(price) ? price : null,
      side: up ? "below" : "above",
      shape: up ? "triangle-up" : down ? "triangle-down" : "diamond",
      label: { text: name, tone: selected ? "selection" : "muted", priority: 10, slots: up ? ["glyph-below", "glyph-above"] : ["glyph-above", "glyph-below"], font: "sans", show: "hover" },
      hover: { title: name, subtitle: p.significant ? text["hover.patternSignificant"] : text["hover.patternFound"], detail: text.date(p.t), note: text["hover.notAdvice"] },
    };
    out.push({ obj: emphasize(obj, selected), legend: "pattern" });
  }
  return out;
};
