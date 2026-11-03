import { CHART_TYPES, INDICATORS, LAYERS_VERSION, defaultParams, normalizeMarkup, resolvePreset, selectPreset, setLayerOverride, type ChartType, type LayerKey, type MarkupSettings, type PanelKey, type PresetId, type ScaleMode } from "@platform/charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLayout, putLayout } from "@/lib/drawings";
import { TEMPLATES } from "../templates";

/**
 * Сохранённые настройки терминала, версия слоёв 5 (план 2B.2, ADR-0008): вместо набора слоёв — разметка
 * { preset, overrides }. Чистые функции миграции и хук useTerminalSettings (план 2B.9): localStorage,
 * синхронизация с сервером, переключатели индикаторов, панелей, слоёв и пресета.
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
    // порядок панелей — порядок добавления (панели создаются по нему): сохраняется, отбрасываются только
    // неизвестные ключи и повторы
    panels: Array.isArray(raw.panels) ? (raw.panels as unknown[]).filter((k, i, a): k is PanelKey => PANEL_KEYS.includes(k as PanelKey) && a.indexOf(k) === i) : [],
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

/** Ключ настроек терминала в localStorage. */
export const STORAGE = "pl-terminal";
/** Задержка отправки изменённых настроек на сервер. */
const PUSH_DELAY_MS = 800;

/** Настройки из localStorage, приведённые к версии 5; legacy — найдено сохранение старше v5. */
function readSaved(): { saved: SavedV5; legacy: boolean } {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return { saved: { ...DEFAULT_SAVED }, legacy: false };
    const parsed: unknown = JSON.parse(raw);
    return { saved: migrateSaved(parsed), legacy: isLegacySave(parsed) };
  } catch {
    return { saved: { ...DEFAULT_SAVED }, legacy: false };
  }
}
const load = (): SavedV5 => readSaved().saved;

/**
 * Настройки терминала: читаются из localStorage после монтирования (до этого — то же чтение на каждом
 * рендере), сохраняются туда же; у вошедшего — берутся с сервера, если там новее, и отправляются туда
 * с задержкой. legacyFound — найдено сохранение старше v5 (разметка сброшена на «Чистый»).
 */
export function useTerminalSettings(authed: boolean) {
  const [saved, setSaved] = useState<SavedV5 | null>(null);
  const [legacyFound, setLegacyFound] = useState(false);
  useEffect(() => {
    queueMicrotask(() => {
      const r = readSaved();
      setSaved(r.saved);
      if (r.legacy) setLegacyFound(true);
    });
  }, []);
  useEffect(() => {
    if (saved) {
      try {
        localStorage.setItem(STORAGE, JSON.stringify(saved));
      } catch {
        /* приватный режим */
      }
    }
  }, [saved]);
  // раскладка: при входе берём с сервера, если она новее локальной; изменения отправляем с задержкой
  const layoutPulled = useRef(false);
  useEffect(() => {
    if (!authed || layoutPulled.current) return;
    layoutPulled.current = true;
    getLayout()
      .then((r) => {
        if (!r.data) return;
        const local = load();
        if (r.updated_at > (local.updated_at ?? 0)) {
          setSaved({ ...migrateLayout(r.data, local), updated_at: r.updated_at });
          if (isLegacySave(r.data)) setLegacyFound(true);
        }
      })
      .catch(() => {});
  }, [authed]);
  useEffect(() => {
    if (!authed || !saved || !layoutPulled.current) return;
    const t = setTimeout(() => {
      const { updated_at, ...data } = saved;
      void putLayout(data, updated_at ?? Date.now()).catch(() => {});
    }, PUSH_DELAY_MS);
    return () => clearTimeout(t);
  }, [saved, authed]);

  const st = saved ?? load();
  /** Изменение настроек с отметкой времени (по ней сервер и локальная копия решают, что новее). */
  const update = useCallback((fn: (cur: SavedV5) => SavedV5) => setSaved((p) => ({ ...fn(p ?? load()), updated_at: Date.now() })), []);
  const patch = useCallback((p: Partial<Omit<SavedV5, "layers_v" | "updated_at">>) => update((cur) => ({ ...cur, ...p })), [update]);
  const toggleIndicator = useCallback(
    (id: string) =>
      update((cur) => {
        const has = cur.indicators.some((i) => i.id === id);
        const spec = INDICATORS.find((i) => i.id === id)!;
        return { ...cur, indicators: has ? cur.indicators.filter((i) => i.id !== id) : [...cur.indicators, { id, params: defaultParams(spec) }] };
      }),
    [update],
  );
  const togglePanel = useCallback(
    (k: PanelKey) =>
      update((cur) => {
        const has = cur.panels.includes(k);
        return { ...cur, panels: has ? cur.panels.filter((x) => x !== k) : [...cur.panels, k] };
      }),
    [update],
  );
  // слой поверх пресета — поправка («Свой»); выбор пресета поправки сбрасывает
  const resolved = useMemo(() => resolvePreset(st.markup, "desktop", { authed }), [st.markup, authed]);
  const toggleLayer = useCallback(
    (k: LayerKey) =>
      update((cur) => {
        const on = resolvePreset(cur.markup, "desktop", { authed }).layers[k];
        return { ...cur, markup: setLayerOverride(cur.markup, k, !on) };
      }),
    [update, authed],
  );
  const selectMarkup = useCallback((id: PresetId) => update((cur) => ({ ...cur, markup: selectPreset(id) })), [update]);
  const applyTemplate = useCallback(
    (id: string) => {
      const t = TEMPLATES.find((x) => x.id === id);
      if (t) update((cur) => ({ ...cur, indicators: t.indicators, panels: t.panels }));
    },
    [update],
  );
  /** Именованная раскладка поверх текущих настроек — через ту же миграцию: v4 применяется как «Чистый». */
  const applyLayout = useCallback((raw: unknown) => update((cur) => migrateLayout(raw, cur)), [update]);

  return { st, resolved, legacyFound, patch, toggleIndicator, togglePanel, toggleLayer, selectMarkup, applyTemplate, applyLayout };
}

export type TerminalSettings = ReturnType<typeof useTerminalSettings>;
