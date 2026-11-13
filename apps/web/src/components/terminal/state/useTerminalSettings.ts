import { CHART_TYPES, LAYERS_VERSION, canAdd, clampParams, indicatorById, isEmptyPaneLayout, nextUid, normalizeFibLevels, normalizeInstances, normalizeMarkup, normalizePaneLayout, prunePaneLayout, resolvePreset, selectPreset, setLayerOverride, suggestParams, type ChartType, type IndicatorInstance, type LayerKey, type MarkupSettings, type PaneLayout, type PanelKey, type PresetId, type ScaleMode } from "@platform/charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLayout, putLayout } from "@/lib/drawings";
import { loadError, retryable } from "../loadError";
import { TEMPLATES } from "../templates";

/**
 * Сохранённые настройки терминала, версия слоёв 5 (план 2B.2, ADR-0008): вместо набора слоёв — разметка
 * { preset, overrides }. Чистые функции миграции и хук useTerminalSettings (план 2B.9): localStorage,
 * синхронизация с сервером, переключатели индикаторов, панелей, слоёв и пресета.
 */

export interface SavedV5 {
  layers_v: typeof LAYERS_VERSION;
  type: ChartType;
  /** Экземпляры индикаторов (план 2B.9): uid «ema#2», до 3 EMA и SMA; старые {id, params} мигрируют (normalizeInstances). */
  indicators: IndicatorInstance[];
  markup: MarkupSettings;
  panels: PanelKey[];
  scale: ScaleMode;
  overlay: string | null;
  /**
   * Порядок и высоты панелей под графиком (ADR-0009, «Управление панелями»): только у панелей, которые есть сейчас;
   * пустая раскладка не хранится (поля нет — порядок добавления и высоты по умолчанию). Новое поле без смены
   * версии: старые сохранения его не имеют, старая сборка его отбрасывает.
   */
  paneLayout?: PaneLayout;
  /**
   * Уровни нового Фибоначчи — набор, который пользователь выбрал последним в карточке рисунка (ADR-0009, «Рисование»,
   * дополнение 2026-11-11): трейдер настраивает уровни один раз. Поля нет — уровни по умолчанию (FIB_LEVELS); после
   * первого выбора поле есть всегда, «стандартные» записывают в него набор по умолчанию (а не убирают поле: раскладка
   * с сервера без поля не отличалась бы от «ещё не выбирал» и не сбрасывала бы набор на другом устройстве). Новое
   * поле без смены версии, как paneLayout. В именованные раскладки не пишется — это настройка инструмента рисования.
   */
  fibLevels?: number[];
  /**
   * «Линии до края» нового Фибоначчи — выбор пользователя в карточке рисунка в прошлый раз (ADR-0009, «Рисование»,
   * дополнение 2026-11-13), как набор уровней: поля нет — продлённый (по умолчанию); после первого переключения поле
   * есть всегда (true тоже записывается — иначе «включил снова» на другом устройстве не отличалось бы от «не выбирал»).
   * Новое поле без смены версии; в именованные раскладки не пишется.
   */
  fibExtend?: boolean;
  updated_at?: number;
}

/** Новый профиль: одна EMA 50, панелей нет, разметка «Чистый». */
export const DEFAULT_INDICATORS: IndicatorInstance[] = [{ uid: "ema#1", id: "ema", params: { period: 50 } }];
export const DEFAULT_SAVED: SavedV5 = { layers_v: LAYERS_VERSION, type: "candles", indicators: DEFAULT_INDICATORS, markup: { preset: "clean", overrides: {} }, panels: [], scale: "linear", overlay: null };

const PANEL_KEYS: readonly PanelKey[] = ["funding", "oi", "liq", "ls"];
const SCALES: readonly ScaleMode[] = ["linear", "log", "percent"];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Ключи панелей под графиком: экземпляры индикаторов на отдельной панели (uid) и панели данных фьючерсов. */
export function paneKeys(s: Pick<SavedV5, "indicators" | "panels">): string[] {
  return [...s.indicators.filter((i) => indicatorById(i.id)?.pane === "separate").map((i) => i.uid), ...s.panels];
}

/** Настройки с раскладкой панелей: записи убранных панелей отбрасываются, пустая раскладка — без поля. */
export function withPaneLayout(s: SavedV5, l: PaneLayout | undefined): SavedV5 {
  const { paneLayout: _p, ...rest } = s;
  void _p;
  const pruned = l ? prunePaneLayout(l, paneKeys(s)) : undefined;
  return pruned && !isEmptyPaneLayout(pruned) ? { ...rest, paneLayout: pruned } : rest;
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
    // {id, params} до C → экземпляры {uid, id, params} (повтор id — «#2»), лишние сверх лимита отбрасываются
    indicators: normalizeInstances(raw.indicators) ?? DEFAULT_SAVED.indicators,
    markup: legacy ? { preset: "clean", overrides: {} } : normalizeMarkup(raw.markup),
    // порядок панелей — порядок добавления (панели создаются по нему): сохраняется, отбрасываются только
    // неизвестные ключи и повторы
    panels: Array.isArray(raw.panels) ? (raw.panels as unknown[]).filter((k, i, a): k is PanelKey => PANEL_KEYS.includes(k as PanelKey) && a.indexOf(k) === i) : [],
    scale: SCALES.includes(raw.scale as ScaleMode) ? (raw.scale as ScaleMode) : DEFAULT_SAVED.scale,
    overlay: typeof raw.overlay === "string" && raw.overlay ? raw.overlay : null,
  };
  if (typeof raw.updated_at === "number" && Number.isFinite(raw.updated_at)) out.updated_at = raw.updated_at;
  // уровни нового Фибоначчи: приведённый набор (числа, 3 знака, по возрастанию); не список — без поля
  if (Array.isArray(raw.fibLevels)) out.fibLevels = normalizeFibLevels(raw.fibLevels);
  // «Линии до края» нового Фибоначчи: только true или false; иное — без поля (продлённый)
  if (typeof raw.fibExtend === "boolean") out.fibExtend = raw.fibExtend;
  // раскладка панелей: мусор — без поля; ключи — только панелей из этих же настроек
  return raw.paneLayout === undefined ? out : withPaneLayout(out, normalizePaneLayout(raw.paneLayout));
}

/**
 * Раскладка поверх текущих настроек (именованная или с сервера): поля, которых в раскладке нет (шкала,
 * наложение), остаются текущими; разметка, версия и раскладка панелей — только из раскладки, поэтому раскладка v4
 * станет «Чистым», а раскладка без порядка и высот панелей — с порядком добавления и высотами по умолчанию.
 */
export function migrateLayout(raw: unknown, base: SavedV5): SavedV5 {
  if (!isObj(raw)) return base;
  const { markup: _m, layers_v: _v, paneLayout: _p, ...rest } = base;
  void _m;
  void _v;
  void _p;
  return migrateSaved({ ...rest, ...raw, layers_v: raw.layers_v, markup: raw.markup });
}

/** Что пишет saveLayout: разметка и версия 5 вместо набора слоёв. */
export function layoutData(s: SavedV5, symbol: string, tf: string): Record<string, unknown> {
  return { layers_v: LAYERS_VERSION, type: s.type, indicators: s.indicators, markup: s.markup, panels: s.panels, ...(s.paneLayout ? { paneLayout: s.paneLayout } : {}), symbol, tf };
}

/** Новый экземпляр индикатора в конце списка (если лимит позволяет): uid — минимальный свободный номер. */
export function addInstance(list: readonly IndicatorInstance[], id: string): IndicatorInstance[] {
  const spec = indicatorById(id);
  if (!spec || !canAdd(list, id)) return [...list];
  return [...list, { uid: nextUid(list, id), id, params: suggestParams(list, spec) }];
}

/** Ключ настроек терминала в localStorage. */
export const STORAGE = "pl-terminal";
/** Задержка отправки изменённых настроек на сервер. */
const PUSH_DELAY_MS = 800;
/** Паузы перед повтором загрузки раскладки с сервера после сбоя, мс; дальше — последняя. */
const PULL_RETRY_MS = [3000, 10_000, 30_000, 60_000];

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
  // раскладка: при входе берём с сервера, если она новее локальной; изменения отправляем с задержкой — только после
  // того, как ответ сервера получен (сбой — повтор с паузами), и только правки пользователя новее копии на сервере:
  // иначе значения по умолчанию нового устройства (или до медленного ответа) затирали раскладку на всех устройствах
  // (аудит TSA-3)
  const [pulled, setPulled] = useState(false);
  /** updated_at копии на сервере после последней сверки (0 — копии нет): не новее — не отправляем. */
  const serverAt = useRef(0);
  useEffect(() => {
    if (!authed || pulled) return;
    let dead = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pull = () =>
      getLayout()
        .then((r) => {
          if (dead) return;
          if (r.data) {
            serverAt.current = r.updated_at;
            const local = load();
            if (r.updated_at > (local.updated_at ?? 0)) {
              setSaved({ ...migrateLayout(r.data, local), updated_at: r.updated_at });
              if (isLegacySave(r.data)) setLegacyFound(true);
            }
          }
          setPulled(true);
        })
        .catch((e: unknown) => {
          // сеть, 5xx, 429 — повтор; отказ (сеанс кончился) — без раскладки сервера и без отправки
          if (!dead && retryable(loadError(e))) timer = setTimeout(pull, PULL_RETRY_MS[Math.min(tries++, PULL_RETRY_MS.length - 1)]);
        });
    pull();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [authed, pulled]);
  useEffect(() => {
    const at = saved?.updated_at;
    if (!authed || !saved || !pulled || at === undefined || at <= serverAt.current) return;
    const t = setTimeout(() => {
      const { updated_at: _u, ...data } = saved;
      void _u;
      void putLayout(data, at)
        .then(() => {
          serverAt.current = Math.max(serverAt.current, at);
        })
        .catch(() => {});
    }, PUSH_DELAY_MS);
    return () => clearTimeout(t);
  }, [saved, authed, pulled]);

  const st = saved ?? load();
  /** Изменение настроек с отметкой времени (по ней сервер и локальная копия решают, что новее). */
  // после любой правки раскладка панелей — только у оставшихся панелей (убрали RSI — его высота и место забыты)
  const update = useCallback(
    (fn: (cur: SavedV5) => SavedV5) =>
      setSaved((p) => {
        const next = fn(p ?? load());
        return { ...withPaneLayout(next, next.paneLayout), updated_at: Date.now() };
      }),
    [],
  );
  const patch = useCallback((p: Partial<Omit<SavedV5, "layers_v" | "updated_at">>) => update((cur) => ({ ...cur, ...p })), [update]);
  /** Флажок в «Индикаторах»: есть экземпляры — убрать все, нет — добавить один с параметрами по умолчанию. */
  const toggleIndicator = useCallback(
    (id: string) =>
      update((cur) => {
        if (cur.indicators.some((i) => i.id === id)) return { ...cur, indicators: cur.indicators.filter((i) => i.id !== id) };
        return { ...cur, indicators: addInstance(cur.indicators, id) };
      }),
    [update],
  );
  /** «+ ещё EMA»: ещё один экземпляр (до MAX_INSTANCES) со свободным периодом. */
  const addIndicator = useCallback((id: string) => update((cur) => ({ ...cur, indicators: addInstance(cur.indicators, id) })), [update]);
  const removeInstance = useCallback((uid: string) => update((cur) => ({ ...cur, indicators: cur.indicators.filter((i) => i.uid !== uid) })), [update]);
  const setInstanceParams = useCallback(
    (uid: string, params: Record<string, number>) =>
      update((cur) => ({
        ...cur,
        indicators: cur.indicators.map((i) => {
          const spec = indicatorById(i.id);
          return i.uid === uid && spec ? { ...i, params: clampParams(spec, { ...i.params, ...params }) } : i;
        }),
      })),
    [update],
  );
  /** «скрыть / показать» в легенде графика: экземпляр остаётся в списке, линии не рисуются. */
  const toggleInstanceHidden = useCallback(
    (uid: string) =>
      update((cur) => ({
        ...cur,
        indicators: cur.indicators.map((i) => {
          if (i.uid !== uid) return i;
          if (i.hidden) {
            const { hidden: _h, ...rest } = i;
            void _h;
            return rest;
          }
          return { ...i, hidden: true };
        }),
      })),
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
      if (t) update((cur) => ({ ...cur, indicators: normalizeInstances(t.indicators) ?? [], panels: [...t.panels] }));
    },
    [update],
  );
  /** Порядок и высоты панелей под графиком (граница, «выше / ниже»): пустая раскладка — поле убирается. */
  const setPaneLayout = useCallback((l: PaneLayout) => update((cur) => withPaneLayout(cur, l)), [update]);
  /** «убрать» в заголовке панели: экземпляр индикатора по uid или панель данных фьючерсов по ключу. */
  const removePane = useCallback(
    (key: string) =>
      update((cur) => (PANEL_KEYS.includes(key as PanelKey) ? { ...cur, panels: cur.panels.filter((k) => k !== key) } : { ...cur, indicators: cur.indicators.filter((i) => i.uid !== key) })),
    [update],
  );
  /** Именованная раскладка поверх текущих настроек — через ту же миграцию: v4 применяется как «Чистый». */
  const applyLayout = useCallback((raw: unknown) => update((cur) => migrateLayout(raw, cur)), [update]);
  /**
   * Выбор у Фибоначчи в карточке рисунка (или его отмена и повтор): уровни (в том числе «стандартные») и «Линии до
   * края» — с ними начнётся следующий рисунок. Чего в выборе нет, остаётся как было.
   */
  const setFibDefaults = useCallback(
    (p: { levels?: readonly number[]; extend?: boolean }) =>
      update((cur) => ({ ...cur, ...(p.levels ? { fibLevels: normalizeFibLevels(p.levels) } : {}), ...(p.extend !== undefined ? { fibExtend: p.extend } : {}) })),
    [update],
  );

  return { st, resolved, legacyFound, patch, toggleIndicator, addIndicator, removeInstance, setInstanceParams, toggleInstanceHidden, togglePanel, toggleLayer, selectMarkup, applyTemplate, applyLayout, setPaneLayout, removePane, setFibDefaults };
}

export type TerminalSettings = ReturnType<typeof useTerminalSettings>;
