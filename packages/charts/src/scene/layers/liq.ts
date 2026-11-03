import { formatUsd } from "../../format";
import type { LiqBucket, LiqMap } from "../../levels";
import { INDEX_LIMITS } from "../../presets";
import type { HeatObject, HeatTop } from "../types";
import type { LayerBuilder, LayerCtx } from "./common";
import { emphasize } from "./common";

export const LIQ_MAP_ID = "liq:map";
export const liqTopId = (side: "long" | "short", bucket: number): string => `liq:${side === "long" ? "L" : "S"}:${bucket}`;

/**
 * Сколько скоплений на сторону сцена отдаёт раскладке как кандидатов в подписи: крупнейшие за кадром
 * или под объёмом заменяются следующими видимыми (не меньше INDEX_LIMITS.liqPerSide — строки «Найдено»).
 */
export const LIQ_LABEL_CANDIDATES = 8;

/** Скопление ликвидаций одной стороны: крупнейшая корзина и соседние с ней (|i − пик| ≤ 1). */
export interface LiqCluster {
  /** Индекс корзины-пика (id скопления — liqTopId(side, bucket)). */
  bucket: number;
  /** Цена корзины-пика: здесь подпись на графике и строка «Найдено». */
  price: number;
  /** Сумма по корзинам скопления. */
  amount: number;
  /** Цены крайних корзин скопления. */
  lo: number;
  hi: number;
  /** Сколько корзин склеено. */
  n: number;
}

/**
 * Скопления одной стороны — одно определение для подписей на графике, подсказки и «Найдено → Уровни»
 * (одинаковые цена и сумма у одного id). Корзины по убыванию суммы: корзина рядом с уже взятым пиком
 * (|i − пик| ≤ 1) добавляется к нему, иначе становится новым пиком. На выходе — по убыванию суммы.
 */
export function liqClusters(m: LiqMap, side: "long" | "short"): LiqCluster[] {
  const amount = (b: LiqBucket) => (side === "long" ? b.long : b.short);
  const order = m.buckets
    .map((b, i) => ({ i, a: amount(b) }))
    .filter((x) => x.a > 0)
    .sort((x, y) => y.a - x.a || x.i - y.i);
  const out: LiqCluster[] = [];
  for (const { i, a } of order) {
    const price = m.buckets[i]!.price;
    const peak = out.find((c) => Math.abs(c.bucket - i) <= 1);
    if (peak) {
      peak.amount += a;
      peak.lo = Math.min(peak.lo, price);
      peak.hi = Math.max(peak.hi, price);
      peak.n++;
    } else out.push({ bucket: i, price, amount: a, lo: price, hi: price, n: 1 });
  }
  return out.sort((x, y) => y.amount - x.amount || x.bucket - y.bucket);
}

function top(ctx: LayerCtx, side: "long" | "short", c: LiqCluster): HeatTop {
  const text = ctx.text;
  const amountText = text.fill(text["hover.amount"], { amount: formatUsd(c.amount) });
  return {
    id: liqTopId(side, c.bucket),
    side,
    price: c.price,
    lo: c.lo,
    hi: c.hi,
    amountUsd: c.amount,
    label: { text: amountText, tone: "liq", priority: 25, slots: ["gutter-mid"], font: "mono", show: "always" },
    hover: {
      title: side === "long" ? text["liq.longs"] : text["liq.shorts"],
      price: c.lo,
      ...(c.n > 1 ? { priceTo: c.hi, detail: text.fill(text["liq.cluster"], { n: c.n }) } : {}),
      amountUsd: c.amount,
      estimate: true,
      note: text["liq.note"],
    },
  };
}

/**
 * Карта ликвидаций — один объект: все корзины с весом (long + short) / max и кандидаты в подписи сумм —
 * крупнейшие скопления каждой стороны по порядку (раскладка берёт видимые, не больше topsPerSide на сторону).
 * Рисуется только в полосе справа (gutter); без карты (мало OI) объекта нет. Выбор строки «Найдено» или
 * подписи выделяет только это скопление; слой выключен — на графике только оно.
 */
export const buildLiq: LayerBuilder = (ctx) => {
  const m = ctx.input.analytics.liq;
  if (!m) return [];
  const sel = ctx.input.selection.selected;
  const all: HeatTop[] = [];
  for (const side of ["short", "long"] as const) for (const c of liqClusters(m, side).slice(0, Math.max(LIQ_LABEL_CANDIDATES, INDEX_LIMITS.liqPerSide))) all.push(top(ctx, side, c));
  const selectedTop = sel !== null ? (all.find((t) => t.id === sel)?.id ?? null) : null;
  const selected = sel === LIQ_MAP_ID || selectedTop !== null;
  const layerOn = ctx.preset.layers.liq_map;
  const obj: HeatObject = {
    kind: "heat",
    id: LIQ_MAP_ID,
    layer: "liq_map",
    tone: "liq",
    priority: 25,
    emphasis: "normal",
    step: m.step,
    bars: m.buckets.filter((b) => b.long + b.short > 0).map((b) => ({ price: b.price, long: b.long, short: b.short, weight: (b.long + b.short) / m.max })),
    tops: layerOn ? all : all.filter((t) => t.id === selectedTop),
    topsPerSide: ctx.preset.limits.liqTopPerSide,
    selectedTop,
    hover: { title: ctx.text["legend.liq"], estimate: true, note: ctx.text["liq.note"] },
  };
  return [{ obj: emphasize(obj, selected), legend: "liq" }];
};
