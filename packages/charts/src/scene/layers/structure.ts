import type { SlotKey } from "../types";
import type { Built, LayerBuilder, LayerCtx } from "./common";
import { emphasize, hline, uniqueIds } from "./common";

type Event = { t: number; type: "bos" | "choch"; dir: "up" | "down"; level: string; from_t: number };

/** События для показа: последний пробой и последняя смена или последние N, по времени. */
export function pickEvents(events: readonly Event[], n: number, lastOfEachKind: boolean): Event[] {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  if (!lastOfEachKind) return sorted.slice(Math.max(0, sorted.length - n));
  const lastBos = sorted.filter((e) => e.type === "bos").at(-1);
  const lastChoch = sorted.filter((e) => e.type === "choch").at(-1);
  return sorted.filter((e) => e === lastBos || e === lastChoch);
}

const arrow = (dir: "up" | "down") => (dir === "up" ? "↑" : "↓");

function events(ctx: LayerCtx, out: Built[]): void {
  const st = ctx.input.structure;
  if (!st) return;
  const { structureEvents, structureLastOfEachKind } = ctx.preset.limits;
  const text = ctx.text;
  const uid = uniqueIds();
  const all = [...st.events].sort((a, b) => a.t - b.t).map((e) => ({ e, id: uid(`${e.type}:${e.t}`) }));
  const shown = new Set(pickEvents(st.events, structureEvents, structureLastOfEachKind));
  const lastOf = new Map<string, Event>();
  for (const e of shown) lastOf.set(e.type, e);
  for (const { e, id } of all) {
    const selected = ctx.isSelected(id);
    if (!shown.has(e) && !selected) continue;
    const from = ctx.snap(e.from_t);
    const to = Math.max(ctx.snap(e.t), from + ctx.step);
    const priority = lastOf.get(e.type) === e ? 60 : 45;
    const word = text.fill(e.type === "bos" ? text["structure.bos"] : text["structure.choch"], { dir: arrow(e.dir) });
    const slots: SlotKey[] = e.dir === "up" ? ["break-below", "break-above", "line-end-above", "line-start-above"] : ["break-above", "break-below", "line-end-above", "line-start-above"];
    const title = text[`hover.${e.type}.${e.dir}`];
    const obj = hline({
      id,
      layer: "structure",
      tone: "structure",
      priority,
      price: Number(e.level),
      from,
      to,
      style: "solid",
      label: { text: word, tone: "structure", priority, slots, font: "sans", show: "always" },
      hover: { title, price: Number(e.level), detail: text.fill(text["hover.closeBeyond"], { date: text.date(e.t) }) },
    });
    out.push({ obj: emphasize(obj, selected), legend: e.type });
  }
}

function sweeps(ctx: LayerCtx, out: Built[]): void {
  const st = ctx.input.structure;
  if (!st) return;
  const text = ctx.text;
  const uid = uniqueIds();
  const all = [...st.sweeps].sort((a, b) => a.t - b.t).map((s) => ({ s, id: uid(`sweep:${s.t}`) }));
  const from = Math.max(0, all.length - ctx.preset.limits.sweeps);
  all.forEach(({ s, id }, i) => {
    const selected = ctx.isSelected(id);
    if (i < from && !selected) return;
    const high = s.kind === "high";
    const obj = {
      kind: "glyph" as const,
      id,
      layer: "structure" as const,
      tone: "structure" as const,
      priority: 10,
      emphasis: "normal" as const,
      time: ctx.snap(s.t),
      price: Number(s.level),
      side: high ? ("above" as const) : ("below" as const),
      shape: "ring" as const,
      label: { text: text["structure.sweep"], tone: "structure" as const, priority: 10, slots: high ? (["glyph-above", "glyph-below"] as const) : (["glyph-below", "glyph-above"] as const), font: "sans" as const, show: "hover" as const },
      hover: { title: high ? text["hover.sweep.high"] : text["hover.sweep.low"], price: Number(s.level), detail: text.date(s.t) },
    };
    out.push({ obj: emphasize(obj, selected), legend: "sweep" });
  });
}

function equalLevels(ctx: LayerCtx, out: Built[]): void {
  const st = ctx.input.structure;
  const atr = ctx.input.analytics.atr;
  if (!st) return;
  const { equalLevelsPerSide, equalLevelsMaxAtr } = ctx.preset.limits;
  const text = ctx.text;
  const uid = uniqueIds();
  const all = st.equal_levels.map((e) => ({ e, p: Number(e.p), low: e.kind === "low", id: "" }));
  for (const x of all) x.id = uid(`eq:${x.low ? "L" : "H"}:${x.e.from_t}`);
  const near = (x: (typeof all)[number]) => !x.e.swept && atr !== null && Math.abs(x.p - ctx.ref) <= equalLevelsMaxAtr * atr;
  const shown = new Set<(typeof all)[number]>();
  for (const low of [false, true]) {
    all
      .filter((x) => x.low === low && near(x))
      .sort((a, b) => Math.abs(a.p - ctx.ref) - Math.abs(b.p - ctx.ref) || a.e.from_t - b.e.from_t)
      .slice(0, equalLevelsPerSide)
      .forEach((x) => shown.add(x));
  }
  for (const x of all) {
    const selected = ctx.isSelected(x.id);
    if (!shown.has(x) && !selected) continue;
    const from = ctx.snap(x.e.from_t);
    const obj = hline({
      id: x.id,
      layer: "structure",
      tone: "structure",
      priority: 30,
      price: x.p,
      from,
      to: x.e.to_t === null ? null : Math.max(ctx.snap(x.e.to_t), from + ctx.step),
      style: "dashed",
      label: { text: x.low ? text["structure.eql"] : text["structure.eqh"], tone: "structure", priority: 30, slots: x.low ? ["free-below", "line-end-below"] : ["free-above", "line-end-above"], font: "sans", show: "always" },
      hover: { title: x.low ? text["hover.eql"] : text["hover.eqh"], price: x.p },
    });
    out.push({ obj: emphasize(obj, selected), legend: "eq" });
  }
}

/**
 * Структура рынка: отрезки пробоя и смены направления от уровня до свечи пробоя, значки снятий ликвидности
 * у хвоста свечи (текст — при наведении), несснятые равные максимумы и минимумы рядом с ценой. Тон — нейтральный.
 */
export const buildStructure: LayerBuilder = (ctx) => {
  const out: Built[] = [];
  events(ctx, out);
  sweeps(ctx, out);
  equalLevels(ctx, out);
  return out;
};
