import type { BoxObject, HLineObject } from "../types";
import type { Built, LayerBuilder } from "./common";
import { emphasize, lineSlots } from "./common";

export const externalId = (id: string): string => `ext:${id}`;

/** Резерв под «Разбор сверху вниз» (план 2A.11): линии и зоны старших таймфреймов от панели-владельца. */
export const buildExternal: LayerBuilder = (ctx) => {
  const out: Built[] = [];
  for (const e of ctx.input.external) {
    const id = externalId(e.id);
    const selected = ctx.isSelected(id);
    const base = { id, layer: "topdown" as const, tone: e.tone, priority: e.priority, emphasis: "normal" as const, hover: e.hover };
    if (e.kind === "hline" && e.price !== undefined && Number.isFinite(e.price)) {
      const obj: HLineObject = {
        ...base,
        kind: "hline",
        price: e.price,
        from: e.from == null ? null : ctx.snap(e.from),
        to: null,
        style: "dashed",
        width: 1,
        label: { text: e.label, tone: e.tone, priority: e.priority, slots: lineSlots(e.price >= ctx.ref), font: "sans", show: "always" },
        axis: { text: ctx.input.fmt.axis(e.price), tone: e.tone, style: "outline", priority: e.priority, group: "topdown" },
      };
      out.push({ obj: emphasize(obj, selected) });
    } else if (e.kind === "box" && e.top !== undefined && e.bottom !== undefined && Number.isFinite(e.top) && Number.isFinite(e.bottom)) {
      const obj: BoxObject = {
        ...base,
        kind: "box",
        top: Math.max(e.top, e.bottom),
        bottom: Math.min(e.top, e.bottom),
        from: e.from == null ? ctx.lastT : ctx.snap(e.from),
        to: null,
        label: { text: e.label, tone: e.tone, priority: e.priority, slots: ["box-top-left", "box-bottom-left", "box-free"], font: "sans", show: "always" },
      };
      out.push({ obj: emphasize(obj, selected) });
    }
  }
  return out;
};
