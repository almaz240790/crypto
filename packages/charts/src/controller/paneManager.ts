import { VIEW } from "../presets";
import type { Device } from "../types";

/**
 * Раскладка панелей под графиком (план 2A.7, PaneManager; M19; ADR-0009): у каждой панели — своя строка заголовка,
 * заголовки не налезают друг на друга и на шкалу времени, основная панель держит долю mainMinShare общей высоты
 * (десктоп 0.55, телефон и ячейка 0.6). Чистые функции: Terminal.applyPanePlan задаёт по плану stretch-факторы
 * в пикселях — так панели не «плывут» после сворачивания и добавления.
 *
 * Свёрнутая панель — ровно строка заголовка (rowPx: 24 px, под пальцем 44); раскрытая — желаемая высота, а при
 * нехватке места — меньше по общему множителю k, но не ниже строки заголовка. Если строк на все панели не хватает
 * (телефон боком, низкое окно), свёрнутые панели собираются в одну общую строку «ещё N панелей» (её держит последняя
 * свёрнутая — host), у остальных свёрнутых высота GROUPED_PX и своего заголовка нет; раскрытые, которым не осталось
 * строки, сворачиваются (collapse) — так строк хватает всегда. Сворачиваются раньше раскрытые (меньший rank), при
 * равном — верхние: панель, которую пользователь только что раскрыл, остаётся раскрытой. Это свёртывание — только
 * раскладка: в выбор пользователя и в настройки оно не пишется, и место вернулось — панели снова раскрыты.
 */

/**
 * Желание панели: высота в раскрытом виде (px), свёрнута ли она пользователем и rank — когда её раскрыли или добавили
 * (больше — позже; по умолчанию 0): при нехватке строк последние раскрытые остаются.
 */
export type PaneWant = { want: number; collapsed: boolean; rank?: number };

export interface PanePlan {
  /** Основная панель, px: остаток, не меньше доли mainMinShare. */
  main: number;
  /** Дополнительные панели сверху вниз, целые px. */
  others: number[];
  /** Свёрнутые панели, собранные в общую строку: своего заголовка у них нет (host — тоже здесь). */
  grouped: boolean[];
  /** Индекс панели с общей строкой свёрнутых; null — у каждой панели своя строка. */
  host: number | null;
  /** Индексы раскрытых панелей, которым не хватило строки: на этой раскладке они свёрнуты (по возрастанию). */
  collapse: number[];
  /**
   * Множитель сжатия раскрытых панелей окном (1 — помещаются): панель на экране = желаемая · k, если не упёрлась
   * в строку заголовка. По нему перетаскивание границы пишет высоты в желаемых px (commitPaneHeights).
   */
  k: number;
}

/**
 * Высота свёрнутой панели внутри общей строки, px: меньше LWC не делает (Math.max(…, 2) в раскладке панелей), а
 * лишнее он отнимает у последней панели — та могла оказаться ниже строки заголовка.
 */
export const GROUPED_PX = 2;

/**
 * Высоты раскрытых панелей в бюджете: желаемые, если помещаются (k = 1); иначе общий множитель k, но не ниже min —
 * панели, упёршиеся в min, фиксируются, остаток делится между прочими.
 */
export function fitHeights(want: readonly number[], budget: number, min: number): { heights: number[]; k: number } {
  const sum = want.reduce((a, b) => a + b, 0);
  if (sum <= budget) return { heights: want.slice(), k: 1 };
  const fixed = new Set<number>();
  for (;;) {
    let free = 0;
    want.forEach((w, i) => {
      if (!fixed.has(i)) free += w;
    });
    const k = free > 0 ? Math.max(0, budget - fixed.size * min) / free : 0;
    let changed = false;
    want.forEach((w, i) => {
      if (!fixed.has(i) && w * k < min) {
        fixed.add(i);
        changed = true;
      }
    });
    // все упёрлись в строку: множитель — как если бы делили поровну (сжатие есть, k < 1)
    if (!changed) return { heights: want.map((w, i) => (fixed.has(i) ? min : w * k)), k: free > 0 ? k : Math.min(1, Math.max(0, budget) / sum) };
  }
}

/**
 * План высот: total — высота всех панелей вместе с основной, px; panes — дополнительные панели сверху вниз.
 * Основной панели остаётся total − Σ others ≥ total · mainMinShare. Высоты — целые пиксели (LWC округляет высоты
 * панелей и остаток отдаёт последней — с дробными она «плыла» на 1–2 px): при сжатии остаток округления раздаётся
 * раскрытым панелям, а не основной, — она стоит на своей доле.
 */
export function planPanes(total: number, panes: readonly PaneWant[], o: { mainMinShare: number; rowPx: number }): PanePlan {
  const want = panes.map((p) => Math.max(1, p.want));
  const grouped = panes.map(() => false);
  if (total <= 0 || panes.length === 0) return { main: Math.max(0, total), others: [], grouped: [], host: null, collapse: [], k: 1 };
  const others = want.slice();
  const share = Math.min(1, Math.max(0, o.mainMinShare));
  const room = Math.max(0, Math.floor(total * (1 - share)));
  const rows = Math.floor(room / o.rowPx);
  const collapsed = panes.map((p) => p.collapsed);
  const collapse: number[] = [];
  let host: number | null = null;
  let budget = room;
  if (panes.length > rows) {
    // строк на всех не хватает: одна строка — общая для свёрнутых; раскрытых остаётся столько, чтобы вместе со
    // строкой и полосками остальных (GROUPED_PX) влезть в room; лишние сворачиваются — раньше раскрытые (меньший
    // rank), при равном — верхние
    const expanded = collapsed.flatMap((c, i) => (c ? [] : [i]));
    const keep = Math.max(0, Math.floor((room - o.rowPx - (panes.length - 1) * GROUPED_PX) / Math.max(1, o.rowPx - GROUPED_PX)));
    const byAge = expanded.slice().sort((a, b) => (panes[a]!.rank ?? 0) - (panes[b]!.rank ?? 0) || a - b);
    for (const i of byAge.slice(0, Math.max(0, expanded.length - keep))) {
      collapsed[i] = true;
      collapse.push(i);
    }
    collapse.sort((a, b) => a - b);
    collapsed.forEach((c, i) => {
      if (!c) return;
      grouped[i] = true;
      others[i] = GROUPED_PX;
      budget -= GROUPED_PX;
      host = i;
    });
    if (host !== null) {
      const row = Math.min(o.rowPx, room);
      others[host] = row;
      budget -= row - GROUPED_PX;
    }
  } else {
    collapsed.forEach((c, i) => {
      if (!c) return;
      others[i] = o.rowPx;
      budget -= o.rowPx;
    });
  }
  const open = collapsed.flatMap((c, i) => (c ? [] : [i]));
  const fit = fitHeights(
    open.map((i) => want[i]!),
    budget,
    o.rowPx,
  );
  open.forEach((i, j) => {
    others[i] = Math.floor(fit.heights[j]!);
  });
  if (fit.k < 1) {
    // остаток округления — раскрытым с наибольшей дробной частью, по пикселю
    let left = budget - open.reduce((a, i) => a + others[i]!, 0);
    const order = open.map((i, j) => [i, fit.heights[j]! - others[i]!] as const).sort((a, b) => b[1] - a[1]);
    for (let n = 0; left >= 1 && order.length > 0; n++, left--) others[order[n % order.length]![0]]! += 1;
  }
  return { main: total - others.reduce((a, b) => a + b, 0), others, grouped, host, collapse, k: fit.k };
}

/** Доля основной панели по классу устройства (VIEW). */
export const mainMinShareFor = (device: Device): number => VIEW[device].mainMinShare;

/**
 * «Развернуть» панель (ADR-0009, «Управление панелями»): index-я дополнительная панель получает всю высоту,
 * остальные и основная — свёрнуты до заголовка (rowPx). Временный вид, в настройках не хранится. Если строк на
 * основную и остальные панели не хватает (развёрнутой осталось бы меньше строки — много панелей на низком экране),
 * остальные собираются в одну общую строку «ещё N панелей» с полосками GROUPED_PX, как в planPanes.
 */
export function planMaximized(total: number, count: number, index: number, rowPx: number): PanePlan {
  if (total <= 0 || count <= 0 || index < 0 || index >= count)
    return planPanes(
      total,
      Array.from({ length: Math.max(0, count) }, () => ({ want: rowPx, collapsed: true })),
      { mainMinShare: 0, rowPx },
    );
  const grouped = Array.from({ length: count }, () => false);
  const others = Array.from({ length: count }, () => rowPx);
  let host: number | null = null;
  if (total - count * rowPx < rowPx && count > 1) {
    host = index === count - 1 ? count - 2 : count - 1;
    for (let i = 0; i < count; i++) {
      if (i === index) continue;
      grouped[i] = true;
      others[i] = i === host ? rowPx : GROUPED_PX;
    }
  }
  const main = rowPx;
  others[index] = Math.max(1, total - main - others.reduce((a, h, i) => (i === index ? a : a + h), 0));
  return { main: total - others.reduce((a, b) => a + b, 0), others, grouped, host, collapse: [], k: 1 };
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
 * Пределы границы панелей (ADR-0009, «Управление панелями»), px. Основная — не меньше minMain (доля устройства),
 * раскрытая — не ниже minPane. Если окно сжало панели (squeezed: план с k < 1), пара, которой на двоих
 * не хватает minPane, делит своё место до squeezedMin (заголовок панели) — иначе граница стоит и ничего не делает;
 * а основная при сжатии не растёт: она держит свою долю, и после отпускания план вернул бы всё назад.
 */
export interface SepLimits {
  minMain: number;
  minPane: number;
  squeezedMin: number;
  squeezed: boolean;
}

/**
 * Насколько можно сдвинуть границу между a и b (a выше b; свёрнутые между ними пропускает вызывающий), px:
 * [вверх ≤ 0, вниз ≥ 0]. Панель, которая уже ниже своего предела (сжатие окном, высоты с другого устройства),
 * не «прыгает» к нему в начале перетаскивания — она может только расти. [0, 0] — граница стоит.
 */
export function separatorRange(heights: readonly number[], a: number, b: number, lim: SepLimits): [up: number, down: number] {
  const ha = heights[a];
  const hb = heights[b];
  if (ha === undefined || hb === undefined || a >= b) return [0, 0];
  const base = (i: number) => (i === 0 ? lim.minMain : lim.minPane);
  let loA = base(a);
  let loB = base(b);
  if (ha + hb < loA + loB) {
    if (a !== 0) loA = Math.min(loA, lim.squeezedMin);
    if (b !== 0) loB = Math.min(loB, lim.squeezedMin);
  }
  loA = Math.min(loA, ha);
  loB = Math.min(loB, hb);
  // меньше пикселя — не движение: план в целых пикселях ставит основную на долю пикселя выше её доли
  const snap = (v: number) => (Math.abs(v) < 1 ? 0 : v);
  const up = snap(Math.min(0, loA - ha));
  const down = a === 0 && lim.squeezed ? 0 : snap(Math.max(0, hb - loB));
  return [up, down];
}

/**
 * Перетаскивание границы (ADR-0009): высоты всех панелей сверху вниз (0 — основная), граница между a и b.
 * a растёт на dy, b — уменьшается на столько же (в пределах separatorRange): остальные панели не двигаются.
 */
export function dragSeparator(heights: readonly number[], a: number, b: number, dy: number, lim: SepLimits): number[] {
  const next = [...heights];
  if (!Number.isFinite(dy)) return next;
  const [up, down] = separatorRange(heights, a, b, lim);
  if (up === 0 && down === 0) return next;
  const d = Math.min(down, Math.max(up, dy));
  next[a] = heights[a]! + d;
  next[b] = heights[b]! - d;
  return next;
}

/**
 * Конец перетаскивания границы (ADR-0009): в раскладку пишутся только две панели у границы (у основной записи нет),
 * в желаемых px — экранная высота, делённая на коэффициент сжатия k (PanePlan.k). Сумма пары не меняется, значит
 * и k: план даёт ту же картину, что видел пользователь, а на высоком окне — те же пропорции, а не сжатые px.
 * Остальные записи не трогаются: панели, которых не касались, и дальше получают высоту по умолчанию.
 */
export function commitPaneHeights(heights: Readonly<Record<string, number>>, pair: readonly (readonly [key: string | null, px: number])[], k: number, minPx: number = VIEW.desktop.paneMinPx): Record<string, number> {
  const out = { ...heights };
  const f = k > 0 && k < 1 ? k : 1;
  for (const [key, px] of pair) if (key && Number.isFinite(px)) out[key] = Math.round(Math.min(PANE_MAX_PX, Math.max(minPx, px / f)));
  return out;
}
