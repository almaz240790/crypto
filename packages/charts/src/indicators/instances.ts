import { defaultParams, indicatorById, type IndicatorSpec } from "./registry";

/**
 * Экземпляры индикаторов (план 2B.9, M19): один индикатор можно добавить несколько раз с разными
 * параметрами («EMA 20», «EMA 50», «EMA 200»). Экземпляр ключуется uid вида «ema#2»; цвет постоянный
 * (решение владельца: цвета не настраиваются) — из шести нейтральных токенов --ind-1…6 (план 2A.9).
 */

/** Индикатор в сохранении: uid экземпляра, id из реестра, параметры; hidden — скрыт кнопкой в легенде. */
export interface IndicatorInstance {
  uid: string;
  id: string;
  params: Readonly<Record<string, number>>;
  hidden?: boolean;
}

/** Ключ цвета индикатора: шесть токенов --ind-1…--ind-6 (план 2A.9: индикаторы — только нейтральные ind-*). */
export type IndColor = "ind1" | "ind2" | "ind3" | "ind4" | "ind5" | "ind6";
export const IND_COLORS: readonly IndColor[] = ["ind1", "ind2", "ind3", "ind4", "ind5", "ind6"];

/**
 * Постоянный цвет первого экземпляра. Наложения на графике цены не повторяют друг друга; индикаторы на своих
 * панелях могут совпасть по цвету с наложением — они не пересекаются. Keltner — первый свободный ind-* на
 * графике (замечание критика: охра — только ликвидации, салатовый — только интерфейс), OBV — ind-6.
 */
export const INDICATOR_COLOR: Readonly<Record<string, IndColor>> = {
  ema: "ind1",
  sma: "ind2",
  vwap: "ind3",
  bb: "ind4",
  supertrend: "ind5",
  ichimoku: "ind6",
  rsi: "ind1",
  macd: "ind2",
  stoch: "ind3",
  atr: "ind4",
  volume: "ind5",
  cci: "ind6",
  obv: "ind6",
};
/** Неизвестный индикатор — ind-1 (раньше --accent: салатовый оставлен интерфейсу). */
export const FALLBACK_COLOR: IndColor = "ind1";

/** Сколько экземпляров можно добавить: скользящие средние — до 3, остальные — 1 (отдельные панели — всегда 1). */
export const MAX_INSTANCES: Readonly<Record<string, number>> = { ema: 3, sma: 3 };
export const maxInstances = (id: string): number => MAX_INSTANCES[id] ?? 1;

/** Периоды, которые предлагаются новому экземпляру скользящей средней, по порядку (первый не занятый). */
const SUGGESTED_PERIODS = [20, 50, 200, 100, 9, 21] as const;

/** `${id}#${минимальный свободный n ≥ 1}`. */
export function nextUid(list: readonly IndicatorInstance[], id: string): string {
  const used = new Set(list.map((i) => i.uid));
  let n = 1;
  while (used.has(`${id}#${n}`)) n++;
  return `${id}#${n}`;
}

export function countOf(list: readonly IndicatorInstance[], id: string): number {
  return list.reduce((n, i) => n + (i.id === id ? 1 : 0), 0);
}

/** Можно ли добавить ещё один экземпляр (неизвестный id — нельзя). */
export function canAdd(list: readonly IndicatorInstance[], id: string): boolean {
  const spec = indicatorById(id);
  if (!spec) return false;
  const max = spec.pane === "separate" ? 1 : maxInstances(id);
  return countOf(list, id) < max;
}

/** Параметры в пределах ParamSpec: min/max, шаг; период и прочие целые параметры — целые. */
export function clampParams(spec: IndicatorSpec, params: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of spec.params) {
    const raw = params[p.key];
    let v = typeof raw === "number" && Number.isFinite(raw) ? raw : p.default;
    const step = p.step ?? 1;
    v = Math.round(v / step) * step;
    // шаг 0.5 даёт 2.5000000000000004 — округляем до знаков шага
    const digits = (String(step).split(".")[1] ?? "").length;
    v = Number(v.toFixed(digits));
    out[p.key] = Math.min(p.max, Math.max(p.min, v));
  }
  return out;
}

/** Параметры нового экземпляра: у скользящих средних — первый не занятый период из 20, 50, 200, 100…; иначе по умолчанию. */
export function suggestParams(list: readonly IndicatorInstance[], spec: IndicatorSpec): Record<string, number> {
  const base = defaultParams(spec);
  if ((spec.id !== "ema" && spec.id !== "sma") || countOf(list, spec.id) === 0) return base;
  const used = new Set(list.filter((i) => i.id === spec.id).map((i) => i.params.period));
  const period = SUGGESTED_PERIODS.find((p) => !used.has(p));
  return period === undefined ? base : { ...base, period };
}

/** Короткое имя индикатора в легенде и заголовке панели (русский исходник, через t() в web). */
const SHORT_NAME: Readonly<Record<string, string>> = {
  vwap: "VWAP",
  bb: "BB",
  keltner: "Keltner",
  ichimoku: "Ichimoku",
  supertrend: "Supertrend",
  stoch: "Stochastic",
  volume: "Объём",
};
/** Без параметров в имени: у объёма параметр — средняя на гистограмме, у VWAP и OBV параметров нет. */
const NO_PARAMS_IN_TITLE = new Set(["volume", "vwap", "obv"]);

/** Имя индикатора без параметров («EMA», «BB», «Объём»). */
export function shortName(spec: IndicatorSpec): string {
  return SHORT_NAME[spec.id] ?? spec.title;
}

/**
 * «EMA 50», «MACD 12 26 9», «RSI 14», «BB 20 2», «VWAP», «Объём». tr переводит имя (t() в web); числа —
 * значения параметров в порядке ParamSpec, без единиц.
 */
export function instanceTitle(spec: IndicatorSpec, params: Readonly<Record<string, number>>, tr: (s: string) => string = (s) => s): string {
  const name = tr(shortName(spec));
  if (NO_PARAMS_IN_TITLE.has(spec.id) || spec.params.length === 0) return name;
  const values = spec.params.map((p) => params[p.key] ?? p.default);
  return `${name} ${values.join(" ")}`;
}

/**
 * Цвет экземпляра. Первые экземпляры наложений получают свой постоянный цвет; следующие экземпляры и Keltner —
 * первый ind-*, не занятый другими наложениями на графике (по порядку списка), иначе по кругу. Отдельные панели —
 * свой цвет (у них один экземпляр). Цвета попарно разные, пока наложений на графике не больше шести.
 */
export function instanceColors(list: readonly IndicatorInstance[]): ReadonlyMap<string, IndColor> {
  const out = new Map<string, IndColor>();
  const used = new Set<IndColor>();
  const firstOf = new Set<string>();
  const overlays: IndicatorInstance[] = [];
  for (const inst of list) {
    const spec = indicatorById(inst.id);
    if (spec && spec.pane === "separate") {
      out.set(inst.uid, INDICATOR_COLOR[inst.id] ?? FALLBACK_COLOR);
      continue;
    }
    overlays.push(inst);
  }
  // проход 1: первый экземпляр каждого индикатора с постоянным цветом
  for (const inst of overlays) {
    const fixed = INDICATOR_COLOR[inst.id];
    if (!fixed || firstOf.has(inst.id) || used.has(fixed)) continue;
    firstOf.add(inst.id);
    used.add(fixed);
    out.set(inst.uid, fixed);
  }
  // проход 2: остальные — первый свободный, иначе по кругу
  let k = 0;
  for (const inst of overlays) {
    if (out.has(inst.uid)) continue;
    const free = IND_COLORS.find((c) => !used.has(c));
    const c = free ?? IND_COLORS[k++ % IND_COLORS.length]!;
    used.add(c);
    out.set(inst.uid, c);
  }
  return out;
}

export function instanceColor(list: readonly IndicatorInstance[], uid: string): IndColor {
  return instanceColors(list).get(uid) ?? FALLBACK_COLOR;
}

/** Уровни-ориентиры на отдельной панели: RSI 30/70, Stochastic 20/80, MACD 0, CCI ±100. */
export function paneLevels(spec: IndicatorSpec): readonly number[] {
  return spec.levels ?? [];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Любой список индикаторов → экземпляры (миграция сохранений до C, идемпотентна): `{id, params}` → `{uid:"ema#1"}`,
 * повтор того же id — `#2`; неизвестные id отбрасываются; лишние сверх MAX_INSTANCES (и повторы отдельных
 * панелей) — тоже; uid сохраняется, если он вида `${id}#n` и не занят; параметры — через clampParams.
 */
export function normalizeInstances(raw: unknown): IndicatorInstance[] | null {
  if (!Array.isArray(raw)) return null;
  const out: IndicatorInstance[] = [];
  for (const x of raw) {
    if (!isObj(x) || typeof x.id !== "string") continue;
    const spec = indicatorById(x.id);
    if (!spec || !canAdd(out, x.id)) continue;
    const params: Record<string, number> = {};
    if (isObj(x.params)) for (const [k, n] of Object.entries(x.params)) if (typeof n === "number" && Number.isFinite(n)) params[k] = n;
    const want = typeof x.uid === "string" && x.uid.startsWith(`${x.id}#`) && /^\d+$/.test(x.uid.slice(x.id.length + 1)) ? x.uid : null;
    const uid = want && !out.some((i) => i.uid === want) ? want : nextUid(out, x.id);
    const inst: IndicatorInstance = { uid, id: x.id, params: clampParams(spec, params) };
    if (x.hidden === true) inst.hidden = true;
    out.push(inst);
  }
  return out;
}
