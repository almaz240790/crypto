import { LAYER_ORDER } from "../scene/build";
import type { LabelBudget } from "../presets";
import type { CandleBand, DropReason, LabelCandidate, LayoutResult, Obstacles, PlacedLabel, Rect, Viewport } from "./types";
import { AREA_PAD, LABEL_GAP } from "./types";

const layerRank = new Map(LAYER_ORDER.map((l, i) => [l, i]));

/** Порядок раскладки: приоритет по убыванию, затем порядок слоёв, затем id — результат детерминирован. */
export function compareCandidates(a: LabelCandidate, b: LabelCandidate): number {
  return b.priority - a.priority || (layerRank.get(a.layer) ?? 99) - (layerRank.get(b.layer) ?? 99) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

/** Задевает ли прямоугольник колонку видимой свечи (от максимума до минимума с хвостами). */
export function hitsCandles(r: Rect, band: CandleBand): boolean {
  const n = band.top.length;
  if (n === 0 || !(band.spacing > 0)) return false;
  const i0 = Math.max(0, Math.ceil((r.x - band.halfWidth - band.x0) / band.spacing));
  const i1 = Math.min(n - 1, Math.floor((r.x + r.w + band.halfWidth - band.x0) / band.spacing));
  const y1 = r.y + r.h;
  for (let i = i0; i <= i1; i++) {
    const top = band.top[i]!;
    const bottom = band.bottom[i]!;
    if (top !== top || bottom !== bottom) continue; // NaN — нет свечи
    if (top <= y1 && bottom >= r.y) return true;
  }
  return false;
}

/** Внутри области: по горизонтали с отступом, по вертикали между полосой OHLC и объёмом. */
function inside(r: Rect, vp: Viewport): boolean {
  return r.x >= AREA_PAD && r.x + r.w <= vp.width - AREA_PAD && r.y >= vp.insetTop && r.y + r.h <= vp.volumeTopY;
}

/**
 * Жадная раскладка подписей на холсте. Кандидаты по порядку compareCandidates; у каждого места по порядку;
 * место свободно, если плашка внутри области и, увеличенная на 2 px, не задевает колонку свечи, препятствие
 * и уже размещённую подпись. Первое свободное место — подпись; бюджеты (всего и по слою) действуют, если
 * не bypassBudget. Нет места — подпись выброшена с причиной. Шрифт не уменьшается никогда.
 */
export function layoutLabels(candidates: readonly LabelCandidate[], obstacles: Obstacles, viewport: Viewport, budget: LabelBudget): LayoutResult {
  const sorted = [...candidates].sort(compareCandidates);
  const placed: PlacedLabel[] = [];
  const dropped: { id: string; reason: DropReason }[] = [];
  const perLayer = new Map<string, number>();
  let total = 0;
  for (const c of sorted) {
    if (!c.bypassBudget) {
      const cap = budget.perLayer[c.layer];
      if (total >= budget.canvas || (cap !== undefined && (perLayer.get(c.layer) ?? 0) >= cap)) {
        dropped.push({ id: c.id, reason: "budget" });
        continue;
      }
    }
    let onScreen = false;
    let at: { rect: Rect; slot: LabelCandidate["slots"][number] } | null = null;
    for (const s of c.slots) {
      const x = s.clampX ? Math.min(Math.max(s.x, AREA_PAD), viewport.width - AREA_PAD - c.w) : s.x;
      const rect = { x, y: s.y, w: c.w, h: c.h };
      if (!Number.isFinite(x) || !Number.isFinite(s.y) || !inside(rect, viewport)) continue;
      onScreen = true;
      const big = inflate(rect, LABEL_GAP);
      if (hitsCandles(big, obstacles.candles)) continue;
      if (obstacles.rects.some((o) => intersects(big, o.rect))) continue;
      if (placed.some((p) => intersects(big, p.rect))) continue;
      at = { rect, slot: s };
      break;
    }
    if (!at) {
      dropped.push({ id: c.id, reason: onScreen ? "collision" : "offscreen" });
      continue;
    }
    placed.push({ id: c.id, objectId: c.objectId, layer: c.layer, text: c.text, rect: at.rect, slot: at.slot.key, tone: c.tone, font: c.font, px: c.px, priority: c.priority, bypassBudget: c.bypassBudget, ...(c.selected ? { selected: true } : {}), ...(c.icon ? { icon: c.icon } : {}) });
    if (!c.bypassBudget) {
      total++;
      perLayer.set(c.layer, (perLayer.get(c.layer) ?? 0) + 1);
    }
  }
  return { placed, dropped };
}
