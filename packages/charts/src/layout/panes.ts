/**
 * Раскладка панелей под графиком (план 2A.7): у каждой панели — своя строка заголовка, заголовки не налезают
 * друг на друга и на шкалу времени, основная панель держит свою минимальную долю высоты.
 *
 * Свёрнутая панель — ровно строка заголовка (rowPx); раскрытая — желаемая высота, а при нехватке места —
 * пропорционально меньше, но не ниже строки заголовка. Если строк на все панели не хватает (телефон, низкое окно),
 * свёрнутые панели собираются в одну общую строку «ещё N панелей» (её держит последняя свёрнутая — host),
 * у остальных свёрнутых высота GROUPED_PX и своего заголовка нет; раскрытые, которым не осталось строки,
 * сворачиваются (collapse) — так строк хватает всегда. Сворачиваются раньше раскрытые (меньший rank), при равном —
 * верхние: панель, которую пользователь только что раскрыл, остаётся раскрытой. Это свёртывание — только раскладка:
 * в выбор пользователя оно не записывается, и место вернулось — панели снова раскрыты.
 */

/**
 * Желание панели: высота в раскрытом виде, свёрнута ли она пользователем и rank — когда её раскрыли (больше —
 * позже; по умолчанию 0): при нехватке строк последние раскрытые остаются.
 */
export type PaneWant = { want: number; collapsed: boolean; rank?: number };

export type PanePlan = {
  /** Высоты дополнительных панелей, px, в их порядке сверху вниз. */
  heights: number[];
  /** Свёрнутые панели, собранные в общую строку: своего заголовка у них нет. */
  grouped: boolean[];
  /** Индекс панели с общей строкой свёрнутых; null — у каждой панели своя строка. */
  host: number | null;
  /** Индексы раскрытых панелей, которым не хватило строки: на этой раскладке они свёрнуты (по возрастанию). */
  collapse: number[];
};

/**
 * Высота свёрнутой панели внутри общей строки, px: меньше LWC не делает (Math.max(…, 2) в раскладке панелей), а
 * лишнее он отнимает у последней панели — та могла оказаться ниже строки заголовка.
 */
export const GROUPED_PX = 2;

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
    // строк на всех не хватает: одна строка — общая для свёрнутых, лишние раскрытые сворачиваются — раньше
    // раскрытые (меньший rank), при равном — верхние
    // раскрытых остаётся столько, чтобы вместе со строкой и полосками остальных (GROUPED_PX) влезть в room
    const expanded = collapsed.flatMap((c, i) => (c ? [] : [i]));
    const keep = Math.max(0, Math.floor((room - o.rowPx - (panes.length - 1) * GROUPED_PX) / (o.rowPx - GROUPED_PX)));
    const surplus = expanded.length - keep;
    const byAge = expanded.slice().sort((a, b) => (panes[a]!.rank ?? 0) - (panes[b]!.rank ?? 0) || a - b);
    for (const i of byAge.slice(0, Math.max(0, surplus))) {
      collapsed[i] = true;
      collapse.push(i);
    }
    collapse.sort((a, b) => a - b);
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
  // целые пиксели: LWC округляет высоты панелей, а остаток отдаёт последней — с дробными она «плыла» на 1–2 px
  open.forEach((i, k) => {
    heights[i] = Math.floor(fit[k]!);
  });
  return { heights, grouped, host, collapse };
}
