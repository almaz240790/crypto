/**
 * Легенда графика вписывается в основную панель (план 2B.9 §10, ADR-0009): сколько строк индикаторов показать без
 * раскрытия и какое верхнее поле шкалы цены под неё оставить. Чистые функции — vitest (legendFit.test).
 *
 * Под пальцем строки легенды по 44 px (кнопки строки видны всегда): на низкой панели (телефон в ландшафте, планшет с
 * панелями индикаторов) три такие строки и «ещё N» были выше самой панели — уходили под строки панелей ниже, «ещё N»
 * не нажималось, а поле шкалы упиралось в 35 % и свечам оставалось 44 % высоты. Теперь:
 * - без раскрытия — столько строк, сколько помещается в LEGEND_ROWS_SHARE панели; не помещается ни одна — «ещё N»
 *   в строке символа рядом с «?»;
 * - верхнее поле шкалы — до низа легенды, но не больше LEGEND_MARGIN_SHARE (мышь — 35 %, палец — 20 %: свечам
 *   с объёмом снизу остаётся 60 %). Под пальцем строка легенды поэтому может лечь на самые старые свечи слева, как
 *   у TradingView; раскрытый список — тоже, и прокручивается в пределах панели.
 */

/** Строк индикаторов без раскрытия — не больше этого (дальше «ещё N», как сворачивает легенду TradingView). */
export const LEGEND_ROWS = 3;

/** Шаг строк легенды, px (строка и зазор 2 px): строка символа, строка индикатора и «ещё N» — у мыши и под пальцем. */
export const LEGEND_STEP = { line: 28, row: { fine: 24, coarse: 48 }, more: { fine: 24, coarse: 46 } } as const;

/** Легенда от верха панели, px (.legendHost top). */
export const LEGEND_TOP_PX = 6;
/** Зазор между низом легенды и верхом свечей, px (верхнее поле шкалы цены — Terminal.setTopMargin). */
export const LEGEND_GAP_PX = 6;

/** Доля основной панели под строки легенды без раскрытия (как PRICE_MARGIN_TOP_MAX пакета графика). */
export const LEGEND_ROWS_SHARE = 0.35;

/**
 * Верхнее поле шкалы цены под легенду — не больше доли основной панели: мышь — PRICE_MARGIN_TOP_MAX (0.35), палец —
 * 0.2 (строки вдвое выше, а свечам с объёмом снизу должно остаться не меньше 60 %).
 */
export const LEGEND_MARGIN_SHARE = { fine: 0.35, coarse: 0.2 } as const;

/** Место легенды в основной панели высотой mainH: budget — без раскрытия, max — раскрытой (до низа панели), px. */
export type LegendFit = { coarse: boolean; budget: number; max: number };

export function legendFit(mainH: number, coarse: boolean): LegendFit {
  const h = Math.max(0, mainH);
  return { coarse, budget: Math.max(0, Math.floor(h * LEGEND_ROWS_SHARE) - LEGEND_TOP_PX - LEGEND_GAP_PX), max: Math.max(0, h - LEGEND_TOP_PX - LEGEND_GAP_PX) };
}

/**
 * Строки индикаторов без раскрытия: n — наложений, extra — других строк под строкой символа (наложенный инструмент).
 * rows — сколько показать; more — нужна «ещё N»; inline — «ещё N» в строке символа (ни одна строка не поместилась).
 * Без fit (размер панели ещё неизвестен) — как раньше: LEGEND_ROWS.
 */
export function legendRows(fit: LegendFit | null, n: number, extra = 0): { rows: number; more: boolean; inline: boolean } {
  if (n <= 0) return { rows: 0, more: false, inline: false };
  if (!fit) return n > LEGEND_ROWS ? { rows: LEGEND_ROWS, more: true, inline: false } : { rows: n, more: false, inline: false };
  const row = fit.coarse ? LEGEND_STEP.row.coarse : LEGEND_STEP.row.fine;
  const room = fit.budget - LEGEND_STEP.line - extra * row;
  if (n <= LEGEND_ROWS && n * row <= room) return { rows: n, more: false, inline: false };
  const more = fit.coarse ? LEGEND_STEP.more.coarse : LEGEND_STEP.more.fine;
  const rows = Math.max(0, Math.min(LEGEND_ROWS, n - 1, Math.floor((room - more) / row)));
  return { rows, more: true, inline: rows === 0 };
}

/** Высота прокрутки раскрытого списка строк, px: до низа панели за вычетом строки символа и «свернуть». */
export function legendListMax(fit: LegendFit, extra = 0, inline = false): number {
  const row = fit.coarse ? LEGEND_STEP.row.coarse : LEGEND_STEP.row.fine;
  const more = inline ? 0 : fit.coarse ? LEGEND_STEP.more.coarse : LEGEND_STEP.more.fine;
  return Math.max(row, fit.max - LEGEND_STEP.line - extra * row - more);
}

/** Верхнее поле шкалы цены (доля основной панели): до низа легенды с зазором, но не больше LEGEND_MARGIN_SHARE. */
export function legendTopMargin(legendBottom: number | null, mainH: number, coarse: boolean): number {
  if (legendBottom == null || !(mainH > 0)) return 0;
  return Math.min((legendBottom + LEGEND_GAP_PX) / mainH, coarse ? LEGEND_MARGIN_SHARE.coarse : LEGEND_MARGIN_SHARE.fine);
}
