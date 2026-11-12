import type { HistoryEdge } from "../buffer";
import type { HoverInfo, LegendEntry, SceneIndex } from "../scene/types";
import type { Candle, Device, Tone } from "../types";

/**
 * Состояние графика для React (план 2B.2, architecture §11): неизменяемые срезы, сравнение по Object.is,
 * подписчики уведомляются синхронно. Пишет контроллер (patch) и React (только select). Читают листовые
 * компоненты через useSyncExternalStore — TerminalShell не перерисовывается на каждый кадр.
 */

export interface HoverSnapshot {
  objectId: string;
  /** Курсор в координатах панели, CSS px. */
  x: number;
  y: number;
  info: HoverInfo;
  /** Тон объекта: цвет заголовка подсказки (--chart-<tone>). */
  tone: Tone;
  /** Цена или диапазон по шагу инструмента («0.0049400», «от 99.50 до 101.00»); null — у объекта нет цены. */
  priceText: string | null;
  /** От живой цены, %; у зоны — 0, если цена внутри. */
  distancePct: number | null;
  /** Область свечей без ценовой шкалы, CSS px: подсказка не заходит на шкалу. */
  plot: { width: number; height: number };
  /** Касание закрепило подсказку до следующего касания в другом месте (палец: карточка внизу графика). */
  pinned: boolean;
}

/**
 * Значение линии индикатора (план 2B.9): key — `${uid}.${серия}`, label — «EMA 50» или «MACD 12 26 9 Сигнальная»;
 * price — значение в ценах инструмента (наложения), форматируется по шагу цены.
 */
export interface IndicatorValue {
  key: string;
  uid: string;
  label: string;
  value: number | null;
  color: string;
  price: boolean;
}

/** Перекрестие (план 2A.7, C): свеча под курсором или пальцем и значения индикаторов на ней. */
export interface CrosshairSnapshot {
  time: number;
  /** Индекс свечи в буфере терминала. */
  index: number;
  candle: Candle;
  values: readonly IndicatorValue[];
  /** Телефон: «липкое» перекрестие после долгого нажатия. */
  sticky: boolean;
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
  /**
   * Время первой свечи буфера после подгрузки истории слева; null — истории ещё не подгружали (буфер — первая порция)
   * или сменились инструмент либо таймфрейм. По нему линия сравнения догружает историю второго инструмента.
   */
  historyFrom: number | null;
  /** Левый край истории (план 2A.7): идёт порция слева, подгрузку остановил лимит буфера (MAX_CANDLES) или ничего. */
  historyEdge: HistoryEdge;
}

export interface ChartState {
  hover: HoverSnapshot | null;
  /** Выбранный объект: клик по графику или строка «Найдено» (id объекта сцены или группы). */
  selection: string | null;
  sceneIndex: SceneIndex | null;
  legend: readonly LegendEntry[];
  /** Перекрестие: пишет ChartSurface не чаще раза за кадр; читают только листы (легенда, значения панелей). */
  crosshair: CrosshairSnapshot | null;
  /** Последние значения индикаторов (легенда без перекрестия); пишется при пересчёте индикаторов. */
  values: readonly IndicatorValue[];
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
const NO_VALUES: readonly IndicatorValue[] = [];

export const INITIAL_STATE: ChartState = {
  hover: null,
  selection: null,
  sceneIndex: null,
  legend: NO_LEGEND,
  crosshair: null,
  values: NO_VALUES,
  visible: { fromTime: null, toTime: null, atRightEdge: true, bars: 0 },
  status: { ready: false, device: "desktop", theme: "light", themeVersion: 0, historyRev: 0, historyFrom: null, historyEdge: null },
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
