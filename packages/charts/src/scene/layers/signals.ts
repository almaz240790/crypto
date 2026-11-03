import { CLOSED_SIGNAL_STATUSES } from "../wire";
import type { GlyphObject } from "../types";
import type { Built, LayerBuilder, LayerCtx } from "./common";
import { capitalize, emphasize, hline, lineSlots } from "./common";
import type { SceneSignal } from "../wire";

export const signalId = (s: Pick<SceneSignal, "id">): string => `sig:${s.id}`;

function levels(ctx: LayerCtx, s: SceneSignal, at: number, selected: boolean, out: Built[]): void {
  const text = ctx.text;
  const subtitle = text.fill(s.dir === "long" ? text["hover.signal.long"] : text["hover.signal.short"], { grade: s.grade });
  const rows: { key: string; raw: string | null; word: string; style: "solid" | "dashed"; axisPriority: number }[] = [
    { key: "entry", raw: s.entry, word: text["signal.entry"], style: "solid", axisPriority: 90 },
    { key: "stop", raw: s.sl, word: text["signal.stop"], style: "dashed", axisPriority: 90 },
    ...s.tp.map((tp, i) => ({ key: `tp${i + 1}`, raw: tp, word: text.fill(text["signal.tp"], { n: i + 1 }), style: "dashed" as const, axisPriority: 90 - (i + 1) })),
  ];
  for (const r of rows) {
    const price = r.raw == null ? NaN : Number(r.raw);
    if (!Number.isFinite(price)) continue;
    const obj = hline({
      id: `${signalId(s)}:${r.key}`,
      groupId: signalId(s),
      layer: "signals",
      tone: "position",
      priority: 90,
      price,
      from: at,
      to: null,
      style: r.style,
      label: { text: r.word, tone: "position", priority: 90, slots: lineSlots(price >= ctx.ref), font: "sans", show: "always" },
      axis: { text: ctx.input.fmt.axis(price), tone: "position", style: "outline", priority: r.axisPriority, group: "position" },
      hover: { title: r.word, subtitle, price },
    });
    out.push({ obj: emphasize(obj, selected), legend: "position" });
  }
}

/**
 * Сигналы стратегии (только вошедшим; гостю слой выключает resolvePreset): значок у свечи сигнала,
 * у открытых — линии «Вход», «Стоп», «Цель n» с контурной ценой на шкале.
 */
export const buildSignals: LayerBuilder = (ctx) => {
  const out: Built[] = [];
  const text = ctx.text;
  ctx.input.signals.forEach((s, i) => {
    const id = signalId(s);
    const selected = ctx.isSelected(id);
    if (i >= ctx.preset.limits.signals && !selected) return;
    const at = ctx.snap(s.t - 1);
    const long = s.dir === "long";
    const subtitle = text.fill(long ? text["hover.signal.long"] : text["hover.signal.short"], { grade: s.grade });
    const entry = s.entry == null ? NaN : Number(s.entry);
    const glyph: GlyphObject = {
      kind: "glyph",
      id,
      groupId: id,
      layer: "signals",
      tone: "position",
      priority: 90,
      emphasis: "normal",
      time: at,
      price: Number.isFinite(entry) ? entry : null,
      side: long ? "below" : "above",
      shape: long ? "triangle-up" : "triangle-down",
      hover: { title: capitalize(subtitle), price: Number.isFinite(entry) ? entry : undefined, detail: text.date(s.t) },
    };
    out.push({ obj: emphasize(glyph, selected), legend: "position" });
    if (!CLOSED_SIGNAL_STATUSES.includes(s.status)) levels(ctx, s, at, selected, out);
  });
  return out;
};
