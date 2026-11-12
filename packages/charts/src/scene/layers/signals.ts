import { CLOSED_SIGNAL_STATUSES, SIGNAL_TARGETS_HIT } from "../wire";
import type { GlyphObject, LineStyleKey } from "../types";
import type { Built, LayerBuilder, LayerCtx } from "./common";
import { capitalize, emphasize, hline, lineSlots } from "./common";
import type { SceneSignal } from "../wire";

export const signalId = (s: Pick<SceneSignal, "id">): string => `sig:${s.id}`;

/** Подпись взятой цели — вторична: уступает уровням, которые ещё в силе. */
const HIT_PRIORITY = 60;

function levels(ctx: LayerCtx, s: SceneSignal, at: number, selected: boolean, out: Built[]): void {
  const text = ctx.text;
  const subtitle = text.fill(s.dir === "long" ? text["hover.signal.long"] : text["hover.signal.short"], { grade: s.grade });
  const hits = SIGNAL_TARGETS_HIT[s.status] ?? 0;
  // после цели 1 трекер переносит стоп на цену входа (be_after_tp1 версии; сервер присылает be): одна линия
  // «Стоп → б/у» на цене входа вместо «Вход» и прежнего стопа, который больше не действует
  const be = s.be === true && hits > 0;
  // axisPriority null — без цены на шкале: взятая цель (шкала — уровням, которые ещё в силе; цена — в подсказке)
  const rows: { key: string; raw: string | null; word: string; style: LineStyleKey; axisPriority: number | null; hit?: boolean; note?: string }[] = [
    ...(be
      ? [{ key: "stop", raw: s.entry, word: text["signal.stop.be"], style: "dashed" as const, axisPriority: 90, note: text["hover.signal.be"] }]
      : [
          { key: "entry", raw: s.entry, word: text["signal.entry"], style: "solid" as const, axisPriority: 90 },
          { key: "stop", raw: s.sl, word: text["signal.stop"], style: "dashed" as const, axisPriority: 90 },
        ]),
    ...s.tp.map((tp, i) =>
      i < hits
        ? { key: `tp${i + 1}`, raw: tp, word: text.fill(text["signal.tp.hit"], { n: i + 1 }), style: "dotted" as const, axisPriority: null, hit: true, note: text["hover.signal.tpHit"] }
        : { key: `tp${i + 1}`, raw: tp, word: text.fill(text["signal.tp"], { n: i + 1 }), style: "dashed" as const, axisPriority: 90 - (i + 1) },
    ),
  ];
  for (const r of rows) {
    const price = r.raw == null ? NaN : Number(r.raw);
    if (!Number.isFinite(price)) continue;
    const tone = r.hit ? "muted" : "position";
    const obj = hline({
      id: `${signalId(s)}:${r.key}`,
      groupId: signalId(s),
      layer: "signals",
      tone,
      priority: r.hit ? HIT_PRIORITY : 90,
      price,
      from: at,
      to: null,
      style: r.style,
      label: { text: r.word, tone, priority: r.hit ? HIT_PRIORITY : 90, slots: lineSlots(price >= ctx.ref), font: "sans", show: "always" },
      ...(r.axisPriority === null ? {} : { axis: { text: ctx.input.fmt.axis(price), tone, style: "outline" as const, priority: r.axisPriority, group: "position" as const } }),
      hover: { title: r.word, subtitle, price, ...(r.note ? { note: r.note } : {}) },
    });
    out.push({ obj: emphasize(obj, selected), legend: "position" });
  }
}

/**
 * Сигналы стратегии (только вошедшим; гостю слой выключает resolvePreset): значок у свечи сигнала,
 * у открытых — линии «Вход», «Стоп», «Цель n» с контурной ценой на шкале. После цели 1 (статус трекера) взятые
 * цели приглушены с «✓» и без цены на шкале, а перенесённый в безубыток стоп — «Стоп → б/у» на цене входа.
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
