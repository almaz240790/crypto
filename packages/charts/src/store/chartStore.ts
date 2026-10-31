import type { HoverInfo, LegendEntry, SceneIndex } from "../scene/types";
import type { Device } from "../types";

/**
 * Состояние графика для React (план 2B.2, architecture §11): неизменяемые срезы, сравнение по Object.is,
 * подписчики уведомляются синхронно. Пишет контроллер (patch) и React (только select). Читают листовые
 * компоненты через useSyncExternalStore — TerminalPage не перерисовывается на каждый кадр.
 */

export interface HoverSnapshot {
  objectId: string;
  /** Курсор в координатах панели, CSS px. */
  x: number;
  y: number;
  info: HoverInfo;
  /** От живой цены, %; у зоны — 0, если цена внутри. */
  distancePct: number | null;
  /** Касание закрепило подсказку до следующего касания в другом месте. */
  pinned: boolean;
}

export interface VisibleSnapshot {
  fromTime: number | null;
  toTime: number | null;
  /** Последняя свеча в кадре. */
  atRightEdge: boolean;
  bars: number;
}

export interface ChartStatus {
  ready: boolean;
  device: Device;
  theme: "light" | "dark";
  /** Растёт при смене темы: эффекты, оставшиеся в ChartSurface до D (индикаторы, панели), перечитывают токены. */
  themeVersion: number;
  /** Растёт при подгрузке истории слева (переходное поле до D: заменяет useState PR A). */
  historyRev: number;
}

export interface ChartState {
  hover: HoverSnapshot | null;
  /** Выбранный объект: клик по графику или строка «Найдено» (id объекта сцены или группы). */
  selection: string | null;
  sceneIndex: SceneIndex | null;
  legend: readonly LegendEntry[];
  visible: VisibleSnapshot;
  status: ChartStatus;
}

export interface ChartStore {
  getState(): ChartState;
  subscribe(listener: () => void): () => void;
  /** Запись контроллера: ничего не делает, если каждый срез равен прежнему по Object.is. */
  patch(p: Partial<ChartState>): void;
  /** Запись из React (единственная): выбор объекта. */
  select(objectId: string | null): void;
}

const NO_LEGEND: readonly LegendEntry[] = [];

export const INITIAL_STATE: ChartState = {
  hover: null,
  selection: null,
  sceneIndex: null,
  legend: NO_LEGEND,
  visible: { fromTime: null, toTime: null, atRightEdge: true, bars: 0 },
  status: { ready: false, device: "desktop", theme: "light", themeVersion: 0, historyRev: 0 },
};

export function createChartStore(init?: Partial<ChartState>): ChartStore {
  let state: ChartState = { ...INITIAL_STATE, ...init };
  const listeners = new Set<() => void>();
  const patch = (p: Partial<ChartState>) => {
    let changed = false;
    for (const k of Object.keys(p) as (keyof ChartState)[]) {
      if (!Object.is(p[k], state[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...p };
    for (const l of [...listeners]) l();
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    patch,
    select: (objectId) => patch({ selection: objectId }),
  };
}
