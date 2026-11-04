/**
 * Раскладка панелей под графиком (план 2A.7): у каждой панели — своя строка заголовка, заголовки не налезают
 * друг на друга и на шкалу времени, основная панель держит свою минимальную долю высоты.
 *
 * Свёрнутая панель — ровно строка заголовка (rowPx); раскрытая — желаемая высота, а при нехватке места —
 * пропорционально меньше, но не ниже строки заголовка. Если строк на все панели не хватает (телефон, низкое окно),
 * свёрнутые панели собираются в одну общую строку «ещё N панелей» (её держит последняя свёрнутая — host),
 * у остальных свёрнутых высота GROUPED_PX и своего заголовка нет; раскрытые сверху, которым не осталось строки,
 * сворачиваются (collapse) — так строк хватает всегда.
 */

/** Желание панели: высота в раскрытом виде и свёрнута ли она. */
export type PaneWant = { want: number; collapsed: boolean };

export type PanePlan = {
  /** Высоты дополнительных панелей, px, в их порядке сверху вниз. */
  heights: number[];
  /** Свёрнутые панели, собранные в общую строку: своего заголовка у них нет. */
  grouped: boolean[];
  /** Индекс панели с общей строкой свёрнутых; null — у каждой панели своя строка. */
  host: number | null;
  /** Индексы раскрытых панелей, которым не хватило строки: их надо свернуть. */
  collapse: number[];
};

/** Высота свёрнутой панели внутри общей строки, px (LWC не любит панели нулевой высоты). */
export const GROUPED_PX = 1;

/**
 * Высоты раскрытых панелей в бюджете: желаемые, если помещаются; иначе общий множитель k, но не ниже min —
 * панели, упёршиеся в min, фиксируются, остаток делится между прочими.
 */
export function fitHeights(want: readonly number[], budget: number, min: number): number[] {
  const sum = want.reduce((a, b) => a + b, 0);
  if (sum <= budget) return want.slice();
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
    if (!changed) return want.map((w, i) => (fixed.has(i) ? min : w * k));
  }
}

/**
 * План высот: total — высота всех панелей вместе с основной, px; panes — дополнительные панели сверху вниз.
 * Основной панели остаётся total − Σ heights ≥ total · mainMinShare.
 */
export function planPanes(total: number, panes: readonly PaneWant[], o: { mainMinShare: number; rowPx: number }): PanePlan {
  const heights = panes.map((p) => p.want);
  const grouped = panes.map(() => false);
  if (panes.length === 0 || total <= 0) return { heights, grouped, host: null, collapse: [] };
  const room = Math.max(0, Math.floor(total * (1 - o.mainMinShare)));
  const rows = Math.floor(room / o.rowPx);
  const collapsed = panes.map((p) => p.collapsed);
  const collapse: number[] = [];
  let host: number | null = null;
  let budget = room;
  if (panes.length > rows) {
    // строк на всех не хватает: одна строка — общая для свёрнутых, лишние раскрытые (сверху) сворачиваются
    const expanded = collapsed.flatMap((c, i) => (c ? [] : [i]));
    const surplus = expanded.length - Math.max(0, rows - 1);
    for (const i of expanded.slice(0, Math.max(0, surplus))) {
      collapsed[i] = true;
      collapse.push(i);
    }
    const row = Math.min(o.rowPx, room);
    collapsed.forEach((c, i) => {
      if (!c) return;
      grouped[i] = true;
      heights[i] = GROUPED_PX;
      budget -= GROUPED_PX;
      host = i;
    });
    if (host !== null) {
      heights[host] = row;
      budget -= row - GROUPED_PX;
    }
  } else {
    collapsed.forEach((c, i) => {
      if (!c) return;
      heights[i] = o.rowPx;
      budget -= o.rowPx;
    });
  }
  const open = collapsed.flatMap((c, i) => (c ? [] : [i]));
  const fit = fitHeights(
    open.map((i) => panes[i]!.want),
    budget,
    o.rowPx,
  );
  open.forEach((i, k) => {
    heights[i] = fit[k]!;
  });
  return { heights, grouped, host, collapse };
}
