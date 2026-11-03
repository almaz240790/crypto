import type { TextKey } from "../text";
import type { AlertLine } from "../input";
import type { Built, LayerBuilder } from "./common";
import { emphasize, hline, lineSlots } from "./common";

export const alertId = (a: Pick<AlertLine, "id">): string => `alert:${a.id}`;

const WORDS: Readonly<Record<AlertLine["op"], { label: TextKey; hover: TextKey }>> = {
  cross_up: { label: "alert.up", hover: "hover.alert.up" },
  cross_down: { label: "alert.down", hover: "hover.alert.down" },
  enter_range: { label: "alert.range", hover: "hover.alert.range" },
};

/** Ценовые алерты пользователя: пунктир на всю ширину с колокольчиком; у «входа в диапазон» — две линии. */
export const buildAlerts: LayerBuilder = (ctx) => {
  const out: Built[] = [];
  const text = ctx.text;
  for (const a of ctx.input.alerts) {
    const id = alertId(a);
    const w = WORDS[a.op];
    const prices = a.op === "enter_range" && a.price2 !== undefined && Number.isFinite(a.price2) ? [a.price, a.price2] : [a.price];
    prices.forEach((price, i) => {
      if (!Number.isFinite(price)) return;
      const lineId = i === 0 ? id : `${id}:${i + 1}`;
      const obj = hline({
        id: lineId,
        groupId: id,
        layer: "alerts",
        tone: "alert",
        priority: 90,
        price,
        from: null,
        to: null,
        style: "dashed",
        label: { text: text[w.label], tone: "alert", priority: 90, slots: lineSlots(price >= ctx.ref), font: "sans", show: "always", icon: "bell" },
        axis: { text: ctx.input.fmt.axis(price), tone: "alert", style: "outline", priority: 90, group: "alert" },
        hover: { title: text[w.hover], price },
      });
      out.push({ obj: emphasize(obj, ctx.isSelected(lineId, id)), legend: "alert" });
    });
  }
  return out;
};
