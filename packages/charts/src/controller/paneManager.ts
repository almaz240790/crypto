import { VIEW } from "../presets";
import type { Device } from "../types";

/**
 * Раскладка панелей под графиком (план 2A.7, PaneManager; M19): желаемые высоты дополнительных панелей
 * в пикселях, основной панели — остаток, но не меньше mainMinShare общей высоты (десктоп 0.55, телефон 0.6).
 * Если панели не помещаются, они сжимаются пропорционально. Чистая функция: terminal.layoutPanes задаёт по ней
 * stretch-факторы в пикселях — так панели не «плывут» после сворачивания и добавления.
 */
export interface PanePlan {
  main: number;
  others: number[];
}

export function planPanes(total: number, wants: readonly number[], mainMinShare: number): PanePlan {
  if (total <= 0 || wants.length === 0) return { main: Math.max(0, total), others: [] };
  const want = wants.map((h) => Math.max(1, h));
  const sum = want.reduce((a, b) => a + b, 0);
  const room = total * (1 - Math.min(1, Math.max(0, mainMinShare)));
  const k = sum > room ? room / sum : 1;
  const others = want.map((h) => h * k);
  return { main: total - others.reduce((a, b) => a + b, 0), others };
}

/** Доля основной панели по классу устройства (VIEW). */
export const mainMinShareFor = (device: Device): number => VIEW[device].mainMinShare;

/**
 * «Развернуть» панель (ADR-0009, «Управление панелями»): index-я дополнительная панель получает всю высоту,
 * остальные и основная — свёрнуты до заголовка (collapsedPx). Временный вид, в настройках не хранится.
 */
export function planMaximized(total: number, count: number, index: number, collapsedPx: number): PanePlan {
  if (total <= 0 || count <= 0 || index < 0 || index >= count) return planPanes(total, Array.from({ length: Math.max(0, count) }, () => collapsedPx), 0);
  const rest = Math.max(collapsedPx, total - collapsedPx * count);
  return { main: total - rest - collapsedPx * (count - 1), others: Array.from({ length: count }, (_, i) => (i === index ? rest : collapsedPx)) };
}

/**
 * Сохранённая раскладка панелей (ADR-0009, «Управление панелями»): порядок сверху вниз и высоты, которые задал
 * пользователь. Ключ панели — uid экземпляра индикатора («rsi#1») или панель данных фьючерсов («oi»).
 * Основная панель всегда первая и в порядке не участвует. Высоты — px раскрытой панели; панели без записи —
 * высота по умолчанию (VIEW.paneIndicatorPx / paneDerivPx). Окно другой высоты — та же планировка planPanes.
 */
export interface PaneLayout {
  order: string[];
  heights: Record<string, number>;
}

export const EMPTY_PANE_LAYOUT: PaneLayout = Object.freeze({ order: [], heights: {} }) as PaneLayout;
/** Записей не больше (лимит индикаторов и панелей с запасом): мусор в сохранении не раздувает настройки. */
const PANE_KEYS_MAX = 32;
/** Высота из сохранения не больше этого: защита от мусора; реальную высоту ограничит planPanes по окну. */
export const PANE_MAX_PX = 4000;
const PANE_KEY = /^[a-z][a-z0-9_]{0,23}(#[1-9]\d?)?$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Любое сохранённое значение → PaneLayout (миграция без версии: поле новое, у старых сохранений его нет).
 * Порядок — только строки-ключи без повторов; высоты — конечные числа, округлённые и приведённые к
 * [paneMinPx, PANE_MAX_PX]. Неизвестное — пустая раскладка (высоты по умолчанию, порядок добавления).
 */
export function normalizePaneLayout(raw: unknown, minPx: number = VIEW.desktop.paneMinPx): PaneLayout {
  if (!isObj(raw)) return { order: [], heights: {} };
  const order = Array.isArray(raw.order) ? (raw.order as unknown[]).filter((k, i, a): k is string => typeof k === "string" && PANE_KEY.test(k) && a.indexOf(k) === i).slice(0, PANE_KEYS_MAX) : [];
  const heights: Record<string, number> = {};
  if (isObj(raw.heights)) {
    for (const [k, v] of Object.entries(raw.heights).slice(0, PANE_KEYS_MAX)) {
      if (PANE_KEY.test(k) && typeof v === "number" && Number.isFinite(v)) heights[k] = Math.round(Math.min(PANE_MAX_PX, Math.max(minPx, v)));
    }
  }
  return { order, heights };
}

/** Пустая раскладка (порядок добавления, высоты по умолчанию) — в настройках не хранится. */
export const isEmptyPaneLayout = (l: PaneLayout): boolean => l.order.length === 0 && Object.keys(l.heights).length === 0;

/** Только записи живых панелей: убранный индикатор, вернувшись, встаёт в конец с высотой по умолчанию. */
export function prunePaneLayout(l: PaneLayout, live: readonly string[]): PaneLayout {
  const set = new Set(live);
  const order = l.order.filter((k) => set.has(k));
  const heights = Object.fromEntries(Object.entries(l.heights).filter(([k]) => set.has(k)));
  if (order.length === l.order.length && Object.keys(heights).length === Object.keys(l.heights).length) return l;
  return { order, heights };
}

/** Порядок панелей: сохранённые — в своём порядке, новые — после них в порядке добавления. */
export function orderPaneKeys(keys: readonly string[], order: readonly string[]): string[] {
  const rank = new Map(order.map((k, i) => [k, i] as const));
  const known = keys.filter((k) => rank.has(k)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  return [...known, ...keys.filter((k) => !rank.has(k))];
}

/** «Выше» (−1) и «ниже» (+1): новый порядок или null, если панель уже крайняя (основная — всегда первая). */
export function movePaneKey(keys: readonly string[], key: string, dir: -1 | 1): string[] | null {
  const i = keys.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= keys.length) return null;
  const next = [...keys];
  next[i] = keys[j]!;
  next[j] = key;
  return next;
}

/**
 * Перетаскивание границы (ADR-0009): высоты всех панелей сверху вниз (0 — основная), граница между a и b
 * (a выше b; свёрнутые между ними пропускает вызывающий). a растёт на dy, b — уменьшается на столько же: остальные
 * панели не двигаются. Основная — не меньше minMain (доля устройства), дополнительная — не меньше minPane.
 */
export function dragSeparator(heights: readonly number[], a: number, b: number, dy: number, minMain: number, minPane: number): number[] {
  const next = [...heights];
  const ha = heights[a];
  const hb = heights[b];
  if (ha === undefined || hb === undefined || a === b || !Number.isFinite(dy)) return next;
  const lo = a === 0 ? minMain : minPane;
  const loB = b === 0 ? minMain : minPane;
  const sum = ha + hb;
  if (sum < lo + loB) return next;
  const top = Math.min(sum - loB, Math.max(lo, ha + dy));
  next[a] = top;
  next[b] = sum - top;
  return next;
}
