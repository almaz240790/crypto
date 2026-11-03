import type { ZoneGroup } from "../zones";
import type { BoxObject } from "../types";
import type { Built, LayerBuilder, LayerCtx } from "./common";
import { emphasize } from "./common";

export const zoneId = (g: Pick<ZoneGroup, "fromT" | "bottom">, precision: number): string => `zone:${g.fromT}:${g.bottom.toFixed(precision)}`;

/** Сторона группы для «ближайший спрос и ближайшее предложение»: смешанная — по положению от цены. */
export function zoneSide(g: ZoneGroup, ref: number): "demand" | "supply" {
  if (g.dir === "up") return "demand";
  if (g.dir === "down") return "supply";
  return (g.top + g.bottom) / 2 <= ref ? "demand" : "supply";
}

/** Какие группы рисовать: первые `zones` по расстоянию или ближайшая на каждую сторону. */
export function pickZones(ctx: LayerCtx): ZoneGroup[] {
  const { zones, zonesOnePerSide } = ctx.preset.limits;
  const groups = ctx.input.analytics.zones;
  if (!zonesOnePerSide) return groups.slice(0, zones);
  const demand = groups.find((g) => zoneSide(g, ctx.ref) === "demand");
  const supply = groups.find((g) => zoneSide(g, ctx.ref) === "supply");
  return groups.filter((g) => g === demand || g === supply).slice(0, Math.max(zones, 0));
}

/**
 * Зоны: заливка без рамки от начала зоны до правого края. Подпись — одно слово по направлению
 * («Спрос», «Предложение», «Зона»); виды зон словами — в подсказке, в порядке ob → sd → fvg.
 */
export const buildZones: LayerBuilder = (ctx) => {
  const { fmt } = ctx.input;
  const text = ctx.text;
  const shown = pickZones(ctx);
  const sel = ctx.input.selection.selected;
  const extra = sel ? ctx.input.analytics.zones.find((g) => !shown.includes(g) && zoneId(g, fmt.precision) === sel) : undefined;
  const firstAbove = shown.find((g) => g.bottom > ctx.ref);
  const firstBelow = shown.find((g) => g.bottom <= ctx.ref);
  const out: Built[] = [];
  for (const g of extra ? [...shown, extra] : shown) {
    const id = zoneId(g, fmt.precision);
    const tone = g.dir === "up" ? ("up" as const) : g.dir === "down" ? ("down" as const) : ("muted" as const);
    const word = g.dir === "up" ? text["zone.demand"] : g.dir === "down" ? text["zone.supply"] : text["zone.mixed"];
    const priority = g === firstAbove || g === firstBelow ? 70 : 45;
    const subtitle = g.parts.map((p) => text.zoneKind(p.kind, p.dir)).join(" + ");
    const obj: BoxObject = {
      kind: "box",
      id,
      layer: "zones",
      tone,
      priority,
      emphasis: "normal",
      top: g.top,
      bottom: g.bottom,
      from: ctx.snap(g.fromT),
      to: null,
      label: { text: word, tone, priority, slots: ["box-top-left", "box-bottom-left", "box-free"], font: "sans", show: "always" },
      hover: { title: word, subtitle, price: g.bottom, priceTo: g.top, detail: text.fill(text["hover.since"], { date: text.date(g.fromT) }) },
    };
    out.push({ obj: emphasize(obj, g === extra || ctx.isSelected(id)), legend: g.dir === "up" ? "demand" : g.dir === "down" ? "supply" : "zone" });
  }
  return out;
};
