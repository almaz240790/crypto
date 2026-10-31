import { CHART_TYPES, LAYERS_VERSION, normalizeMarkup, type ChartType, type MarkupSettings, type PanelKey, type ScaleMode } from "@platform/charts";

/**
 * Сохранённые настройки терминала, версия слоёв 5 (план 2B.2, ADR-0008): вместо набора слоёв — разметка
 * { preset, overrides }. В B здесь только чистые функции; хук useTerminalSettings появится в C.
 */

/** Индикатор в сохранении: id из реестра и параметры. */
export type SavedIndicator = { id: string; params: Record<string, number> };

export interface SavedV5 {
  layers_v: typeof LAYERS_VERSION;
  type: ChartType;
  indicators: SavedIndicator[];
  markup: MarkupSettings;
  panels: PanelKey[];
  scale: ScaleMode;
  overlay: string | null;
  updated_at?: number;
}

/** Новый профиль: одна EMA 50, панелей нет, разметка «Чистый». */
export const DEFAULT_INDICATORS: SavedIndicator[] = [{ id: "ema", params: { period: 50 } }];
export const DEFAULT_SAVED: SavedV5 = { layers_v: LAYERS_VERSION, type: "candles", indicators: DEFAULT_INDICATORS, markup: { preset: "clean", overrides: {} }, panels: [], scale: "linear", overlay: null };

const PANEL_KEYS: readonly PanelKey[] = ["funding", "oi", "liq", "ls"];
const SCALES: readonly ScaleMode[] = ["linear", "log", "percent"];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function indicators(v: unknown): SavedIndicator[] | null {
  if (!Array.isArray(v)) return null;
  const out: SavedIndicator[] = [];
  for (const x of v) {
    if (!isObj(x) || typeof x.id !== "string") continue;
    const params: Record<string, number> = {};
    if (isObj(x.params)) for (const [k, n] of Object.entries(x.params)) if (typeof n === "number" && Number.isFinite(n)) params[k] = n;
    out.push({ id: x.id, params });
  }
  return out;
}

/** Сохранение старше v5 (набор слоёв `layers` или без версии): разметка сбрасывается на «Чистый». */
export function isLegacySave(raw: unknown): boolean {
  return isObj(raw) && raw.layers_v !== LAYERS_VERSION;
}

/**
 * Любое сохранение → SavedV5. Не объект — значения по умолчанию. v5 с разметкой — разметка очищается
 * (неизвестный или не выбираемый пресет, в том числе «Компактный», → «Чистый»; неизвестные ключи и значения,
 * совпадающие с пресетом, удаляются). v4 и раньше — markup = «Чистый», поле layers уходит (прежняя политика
 * «смена версии сбрасывает слои»). Остальные поля переносятся с проверкой типов.
 */
export function migrateSaved(raw: unknown): SavedV5 {
  if (!isObj(raw)) return { ...DEFAULT_SAVED };
  const legacy = isLegacySave(raw);
  const out: SavedV5 = {
    layers_v: LAYERS_VERSION,
    type: CHART_TYPES.includes(raw.type as ChartType) ? (raw.type as ChartType) : DEFAULT_SAVED.type,
    indicators: indicators(raw.indicators) ?? DEFAULT_SAVED.indicators,
    markup: legacy ? { preset: "clean", overrides: {} } : normalizeMarkup(raw.markup),
    panels: Array.isArray(raw.panels) ? PANEL_KEYS.filter((k) => (raw.panels as unknown[]).includes(k)) : [],
    scale: SCALES.includes(raw.scale as ScaleMode) ? (raw.scale as ScaleMode) : DEFAULT_SAVED.scale,
    overlay: typeof raw.overlay === "string" && raw.overlay ? raw.overlay : null,
  };
  if (typeof raw.updated_at === "number" && Number.isFinite(raw.updated_at)) out.updated_at = raw.updated_at;
  return out;
}

/**
 * Раскладка поверх текущих настроек (именованная или с сервера): поля, которых в раскладке нет (шкала,
 * наложение), остаются текущими; разметка и версия — только из раскладки, поэтому раскладка v4 станет «Чистым».
 */
export function migrateLayout(raw: unknown, base: SavedV5): SavedV5 {
  if (!isObj(raw)) return base;
  const { markup: _m, layers_v: _v, ...rest } = base;
  void _m;
  void _v;
  return migrateSaved({ ...rest, ...raw, layers_v: raw.layers_v, markup: raw.markup });
}

/** Что пишет saveLayout: разметка и версия 5 вместо набора слоёв. */
export function layoutData(s: SavedV5, symbol: string, tf: string): Record<string, unknown> {
  return { layers_v: LAYERS_VERSION, type: s.type, indicators: s.indicators, markup: s.markup, panels: s.panels, symbol, tf };
}
