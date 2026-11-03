import type { SceneFigure } from "../wire";
import type { HLineObject, PolylineObject, TimePrice } from "../types";
import type { Built, LayerBuilder, LayerCtx } from "./common";
import { emphasize, hline } from "./common";

export const figureId = (f: Pick<SceneFigure, "id">): string => `fig:${f.id}`;

/** Последние `n` подтверждённых фигур по времени подтверждения. */
export function latestConfirmed(figures: readonly SceneFigure[], n: number): SceneFigure[] {
  const confirmed = figures.filter((f) => f.status === "confirmed").sort((a, b) => (a.confirm_t ?? a.known_t) - (b.confirm_t ?? b.known_t) || a.id - b.id);
  return confirmed.slice(Math.max(0, confirmed.length - n));
}

/** Линии фигуры по началам свечей, обрезанные по последней закрытой свече (правее данных не рисуем). */
function paths(ctx: LayerCtx, f: SceneFigure): TimePrice[][] {
  const out: TimePrice[][] = [];
  for (const ln of f.lines) {
    const a = ctx.snap(ln.a[0]);
    const b = Math.max(ctx.snap(ln.b[0]), a + ctx.step);
    const pa = Number(ln.a[1]);
    const pb = Number(ln.b[1]);
    const t1 = Math.min(b, ctx.lastT);
    if (t1 <= a || !Number.isFinite(pa) || !Number.isFinite(pb)) continue;
    out.push([
      [a, pa],
      [t1, pa + ((pb - pa) * (t1 - a)) / (b - a)],
    ]);
  }
  return out;
}

function statusWord(ctx: LayerCtx, f: SceneFigure): string {
  return f.status === "confirmed" ? ctx.text["figure.confirmed"] : f.status === "forming" ? ctx.text["figure.forming"] : ctx.text["figure.invalidated"];
}

/** Цель и слом подтверждённой фигуры: точками от подтверждения до правого края. */
function levelLine(ctx: LayerCtx, f: SceneFigure, which: "tgt" | "inv", selected: boolean): HLineObject | null {
  const raw = which === "tgt" ? f.target : f.invalidation;
  const price = raw == null ? NaN : Number(raw);
  if (f.status !== "confirmed" || f.confirm_t == null || !Number.isFinite(price)) return null;
  const text = ctx.text;
  const above = price >= ctx.ref;
  const word = which === "tgt" ? text["figure.target"] : text["figure.invalidation"];
  const obj = hline({
    id: `${figureId(f)}:${which}`,
    groupId: figureId(f),
    layer: "figures",
    tone: "figure",
    priority: 50,
    price,
    from: ctx.snap(f.confirm_t),
    to: null,
    style: "dotted",
    label: { text: word, tone: "figure", priority: 50, slots: above ? ["free-above", "line-end-above"] : ["free-below", "line-end-below"], font: "sans", show: "always" },
    hover: { title: which === "tgt" ? text["hover.figureTarget"] : text["hover.figureInvalidation"], price, note: text["hover.notAdvice"] },
  });
  return emphasize(obj, selected);
}

/**
 * Графические фигуры: последняя подтверждённая и выбранная. Подтверждённая — пунктир, «формируется» — точки;
 * выбранная — сплошная 2 px в тоне выделения со значками точек фигуры. Тон — приглушённый, не салатовый.
 */
export const buildFigures: LayerBuilder = (ctx) => {
  const figs = ctx.input.figures;
  const shown = new Set(latestConfirmed(figs, ctx.preset.limits.figures));
  const out: Built[] = [];
  const text = ctx.text;
  for (const f of figs) {
    const id = figureId(f);
    const selected = ctx.isSelected(id);
    if (!shown.has(f) && !selected) continue;
    const ps = paths(ctx, f);
    if (ps.length > 0) {
      const tone = selected ? ("selection" as const) : ("figure" as const);
      const obj: PolylineObject = {
        kind: "polyline",
        id,
        groupId: id,
        layer: "figures",
        tone,
        priority: 55,
        emphasis: "normal",
        paths: ps,
        style: selected ? "solid" : f.status === "confirmed" ? "dashed" : "dotted",
        width: 1,
        ...(selected ? { dots: f.points.map(([t, p]) => [ctx.snap(t), Number(p)] as const).filter(([, p]) => Number.isFinite(p)) } : {}),
        label: { text: text.figure(f.type, f.title), tone, priority: 55, slots: ["polyline-end-above", "polyline-start-above"], font: "sans", show: "always" },
        hover: { title: text.figure(f.type, f.title), subtitle: statusWord(ctx, f), note: text["hover.notAdvice"] },
      };
      out.push({ obj: emphasize(obj, selected), legend: "figure" });
    }
    for (const which of ["tgt", "inv"] as const) {
      const ln = levelLine(ctx, f, which, selected);
      if (ln) out.push({ obj: ln, legend: "figure" });
    }
  }
  return out;
};
