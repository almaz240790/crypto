import { LAYER_ORDER } from "../scene/build";
import type { LabelBudget } from "../presets";
import type { SceneLayer } from "../types";
import type { CandleBand, DropReason, LabelCandidate, LayoutResult, Obstacles, PlacedLabel, Rect, Viewport } from "./types";
import { AREA_PAD, LABEL_GAP } from "./types";

const layerRank = new Map<string, number>(LAYER_ORDER.map((l, i) => [l, i]));

/** Порядок раскладки: приоритет по убыванию, затем порядок слоёв, затем id — результат детерминирован. */
export function compareCandidates(a: LabelCandidate, b: LabelCandidate): number {
  return b.priority - a.priority || (layerRank.get(a.layer) ?? 99) - (layerRank.get(b.layer) ?? 99) || (a.rank ?? 0) - (b.rank ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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

/**
 * Внутри области: по горизонтали с отступом, по вертикали между полосой OHLC и объёмом; у подписей рисунков (area
 * "pane") — вся панель: легенда и кнопки для них — препятствия, а не граница.
 */
function inside(r: Rect, vp: Viewport, area?: "pane"): boolean {
  if (area === "pane") return r.x >= 0 && r.x + r.w <= vp.width && r.y >= 0 && r.y + r.h <= vp.height;
  return r.x >= AREA_PAD && r.x + r.w <= vp.width - AREA_PAD && r.y >= vp.insetTop && r.y + r.h <= vp.volumeTopY;
}

/**
 * Жадная раскладка подписей на холсте. Кандидаты по порядку compareCandidates; у каждого места по порядку;
 * место свободно, если плашка внутри области и, увеличенная на 2 px, не задевает колонку свечи, препятствие
 * и уже размещённую подпись. Первое свободное место — подпись; бюджеты (всего и по слою) действуют, если
 * не bypassBudget (и лимит группы cap). Нет места — подпись выброшена с причиной, и место достаётся следующему
 * кандидату (суммы ликвидаций: крупнейшее видимое скопление). Шрифт не уменьшается никогда.
 */
export function layoutLabels(candidates: readonly LabelCandidate[], obstacles: Obstacles, viewport: Viewport, budget: LabelBudget): LayoutResult {
  const sorted = [...candidates].sort(compareCandidates);
  const placed: PlacedLabel[] = [];
  const external: PlacedLabel[] = [];
  const dropped: { id: string; reason: DropReason }[] = [];
  const perLayer = new Map<string, number>();
  const perGroup = new Map<string, number>();
  let total = 0;
  const taken = (big: Rect) => placed.some((p) => intersects(big, p.rect)) || external.some((p) => intersects(big, p.rect));
  for (const c of sorted) {
    if (!c.bypassBudget) {
      const cap = c.layer === "drawings" ? undefined : budget.perLayer[c.layer as SceneLayer];
      if (total >= budget.canvas || (cap !== undefined && (perLayer.get(c.layer) ?? 0) >= cap) || (c.cap && (perGroup.get(c.cap.key) ?? 0) >= c.cap.max)) {
        dropped.push({ id: c.id, reason: "budget" });
        continue;
      }
    }
    let onScreen = false;
    type At = { rect: Rect; slot: LabelCandidate["slots"][number] };
    let at: At | null = null;
    /** Запасное место (force soft): в области и без препятствий, пусть и поверх другой подписи. */
    let spare: At | null = null;
    const first = c.slots[0];
    if (c.force === "fixed" && first && Number.isFinite(first.x) && Number.isFinite(first.y)) {
      at = { rect: { x: first.x, y: first.y, w: c.w, h: c.h }, slot: first };
      onScreen = true;
    }
    for (const s of at ? [] : c.slots) {
      const x = s.clampX ? Math.min(Math.max(s.x, AREA_PAD), viewport.width - AREA_PAD - c.w) : s.x;
      const rect = { x, y: s.y, w: c.w, h: c.h };
      if (!Number.isFinite(x) || !Number.isFinite(s.y) || !inside(rect, viewport, c.area)) continue;
      onScreen = true;
      const big = inflate(rect, LABEL_GAP);
      if (obstacles.rects.some((o) => intersects(big, o.rect))) continue;
      if (!spare && c.force === "soft") spare = { rect, slot: s };
      if (!c.overCandles && hitsCandles(big, obstacles.candles)) continue;
      if (taken(big)) continue;
      at = { rect, slot: s };
      break;
    }
    at ??= spare;
    if (!at) {
      dropped.push({ id: c.id, reason: onScreen ? "collision" : "offscreen" });
      continue;
    }
    const out: PlacedLabel = { id: c.id, objectId: c.objectId, layer: c.layer, text: c.text, rect: at.rect, slot: at.slot.key, tone: c.tone, font: c.font, px: c.px, priority: c.priority, bypassBudget: c.bypassBudget, ...(c.selected ? { selected: true } : {}), ...(c.icon ? { icon: c.icon } : {}) };
    (c.external ? external : placed).push(out);
    if (!c.bypassBudget) {
      total++;
      perLayer.set(c.layer, (perLayer.get(c.layer) ?? 0) + 1);
      if (c.cap) perGroup.set(c.cap.key, (perGroup.get(c.cap.key) ?? 0) + 1);
    }
  }
  return { placed, dropped, external };
}
