import { LIQ_MIN_OI_COVERAGE, liquidationMap, oiCoverage, supportResistance, type LiqMap, type SrLevel } from "../levels";
import { INDEX_LIMITS } from "../presets";
import type { PriceFormatter } from "../priceFormat";
import type { Candle, Timeframe, Tone } from "../types";
import type { HoverInfo } from "./types";
import type { SceneFigure, ScenePattern, SceneSignal, SceneStructure } from "./wire";
import { mergeZones, type ZoneGroup } from "./zones";
import type { SceneText } from "./text";

/**
 * Аналитика по ЗАКРЫТЫМ свечам (правило CLAUDE.md): пересчёт раз на закрытие свечи, не на каждый тик.
 * «Ближайший» считается от закрытия последней закрытой свечи, поэтому подписи не дёргаются на тиках.
 */
export interface Analytics {
  /** `${lastClosed.time}|${oi}|${structure}` — ключ пересчёта; открытая свеча его не меняет. */
  key: string;
  lastClosed: Candle | null;
  /** По INDEX_LIMITS.srPerSide на сторону: каталог «Найдено», на графике — по лимиту пресета. */
  sr: readonly SrLevel[];
  /** null — нет карты (мало OI, нет данных). */
  liq: LiqMap | null;
  /** Склеенные активные зоны, от ближайшей. */
  zones: readonly ZoneGroup[];
  atr: number | null;
  /** Производные загружены, закрытые свечи есть, но покрытие OI ниже порога (PR A). */
  liqUnavailable: boolean;
}

export interface AlertLine {
  id: number;
  price: number;
  op: "cross_up" | "cross_down" | "enter_range";
  price2?: number;
}

export interface SceneSelection {
  /** Объект, выбранный кликом по графику или строкой «Найдено» (id или groupId). */
  selected: string | null;
  /** Скрытые пользователем объекты (дерево объектов, позже). */
  hidden: ReadonlySet<string>;
}

/** Резерв под «Разбор сверху вниз» (план 2A.11): любая панель может положить объекты на график. */
export interface ExternalObject {
  id: string;
  owner: "topdown";
  sourceTf: Timeframe;
  kind: "hline" | "box";
  price?: number;
  top?: number;
  bottom?: number;
  from?: number | null;
  tone: Tone;
  /** «Н1 сопротивление» */
  label: string;
  hover: HoverInfo;
  priority: number;
}

export interface SceneInput {
  tf: Timeframe;
  analytics: Analytics;
  structure: SceneStructure | null;
  patterns: readonly ScenePattern[];
  figures: readonly SceneFigure[];
  signals: readonly SceneSignal[];
  alerts: readonly AlertLine[];
  external: readonly ExternalObject[];
  selection: SceneSelection;
  fmt: PriceFormatter;
  text: SceneText;
}

/** Постоянные пустые значения: ссылка не меняется, ключ сцены тоже. */
export const NO_SELECTION: SceneSelection = { selected: null, hidden: new Set() };
export const NONE: readonly never[] = [];

/** Номер объекта по ссылке: ключи сцены и аналитики учитывают «тот же ли это объект», без глубокого сравнения. */
const ids = new WeakMap<object, number>();
let nextId = 1;
export function identity(o: object | null | undefined): number {
  if (!o) return 0;
  let id = ids.get(o);
  if (id === undefined) {
    id = nextId++;
    ids.set(o, id);
  }
  return id;
}

function lastClosedOf(candles: readonly Candle[]): Candle | null {
  for (let i = candles.length - 1; i >= 0; i--) if (!candles[i]!.open_) return candles[i]!;
  return null;
}

function oiKey(oi: readonly { t: number; v: number }[] | null): string {
  if (oi === null) return "none";
  const last = oi[oi.length - 1];
  return `${oi.length}:${last ? `${last.t}:${last.v}` : ""}`;
}

/**
 * Аналитика для сцены. Незакрытая свеча на вход не попадает: она отбрасывается здесь, и prev возвращается,
 * пока не закрылась новая свеча и не сменились OI или структура (тест на утечку будущего).
 * oi = null — производные не загружены (тогда и «нет данных» не показываем).
 */
export function deriveAnalytics(candles: readonly Candle[], oi: readonly { t: number; v: number }[] | null, structure: SceneStructure | null, prev?: Analytics): Analytics {
  const lastClosed = lastClosedOf(candles);
  const key = `${lastClosed?.time ?? "none"}|${oiKey(oi)}|${identity(structure)}`;
  if (prev && prev.key === key) return prev;
  const closed = candles.filter((c) => !c.open_);
  if (!lastClosed || closed.length === 0) return { key, lastClosed: null, sr: [], liq: null, zones: [], atr: null, liqUnavailable: false };
  const atrNum = structure?.atr != null ? Number(structure.atr) : NaN;
  return {
    key,
    lastClosed,
    sr: supportResistance(closed, { perSide: INDEX_LIMITS.srPerSide }),
    liq: liquidationMap(closed, oi, { top: INDEX_LIMITS.liqPerSide }),
    zones: structure ? mergeZones(structure.zones, lastClosed.close) : [],
    atr: Number.isFinite(atrNum) && atrNum > 0 ? atrNum : null,
    liqUnavailable: oi !== null && oiCoverage(closed, oi) < LIQ_MIN_OI_COVERAGE,
  };
}
