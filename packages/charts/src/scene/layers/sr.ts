import type { SrLevel } from "../../levels";
import type { Built, LayerBuilder } from "./common";
import { emphasize, hline, lineSlots } from "./common";

/** Id уровня по цене с точностью инструмента: тот же уровень после новой свечи — тот же id. */
export const srId = (l: Pick<SrLevel, "side" | "price">, precision: number): string => `sr:${l.side === "support" ? "S" : "R"}:${l.price.toFixed(precision)}`;

/**
 * Поддержка и сопротивление: линия от первого касания до правого края; сплошная от srStrongTouches касаний.
 * На холсте — srPerSide ближайших на сторону, на шкале — min(srPerSide, axis.srPerSide) (контурная цена).
 */
export const buildSr: LayerBuilder = (ctx) => {
  const { limits, view } = ctx.preset;
  const { fmt, text } = { fmt: ctx.input.fmt, text: ctx.text };
  const axisPerSide = Math.min(limits.srPerSide, view.axis.srPerSide);
  const out: Built[] = [];
  for (const side of ["resistance", "support"] as const) {
    const levels = ctx.input.analytics.sr.filter((l) => l.side === side).sort((a, b) => Math.abs(a.price - ctx.ref) - Math.abs(b.price - ctx.ref));
    levels.forEach((l, i) => {
      const id = srId(l, fmt.precision);
      const selected = ctx.isSelected(id);
      if (i >= limits.srPerSide && !selected) return;
      const sup = side === "support";
      const tone = sup ? ("up" as const) : ("down" as const);
      const word = sup ? (ctx.short ? text["sr.support.short"] : text["sr.support"]) : ctx.short ? text["sr.resistance.short"] : text["sr.resistance"];
      const priority = i === 0 ? 80 : 40;
      const obj = hline({
        id,
        layer: "sr",
        tone,
        priority,
        price: l.price,
        from: ctx.snap(l.firstT),
        to: null,
        style: l.touches >= limits.srStrongTouches ? "solid" : "dashed",
        label: { text: word, tone, priority, slots: lineSlots(!sup), font: "sans", show: "always" },
        ...(i < axisPerSide || selected ? { axis: { text: fmt.axis(l.price), tone, style: "outline" as const, priority, group: "sr" as const } } : {}),
        hover: { title: sup ? text["sr.support"] : text["sr.resistance"], price: l.price, touches: l.touches },
      });
      out.push({ obj: emphasize(obj, selected), legend: side });
    });
  }
  return out;
};
