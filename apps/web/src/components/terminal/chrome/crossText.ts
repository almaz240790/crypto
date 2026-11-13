import { formatCompactValue, formatPriceShort, formatSignedPercent, tickPrecision, type Candle } from "@platform/charts";
import { formatPrice } from "@/lib/format";

/**
 * Значения свечи под перекрестием для строки состояния телефона (ADR-0009, дополнение 2026-11-13). Строка не
 * переносится и не обрезается: если не влезает, CrosshairStrip сжимает её по шагам, пока не влезет. Сначала общие шаги
 * (уровень — номер последнего): 1 — промежутки 8 px и короткие подписи («инд.», «не закрыта»), 2 — шрифт 11 px, 3 — цены
 * короче (formatPriceShort, как шкала цены телефона: от 10 000 — целым числом), 4 — время без «UTC», 5 — у идущей свечи
 * без дня: только время (у свечи от 00:00 — суток и недели — только дата). Идущая свеча — нынешняя, а полные дата и
 * время — на метке шкалы времени под перекрестием. Потом место уступают части той строки, что ещё не влезла
 * (CROSS_SHED): пометка «не закр.», изменение от открытия, пометка точкой, объём; и последним — шрифт 10 px. Цены
 * ETH (~3 000) и монет дешевле цента короче не становятся, а ширина знаков на телефонах и в CI своя (другой шрифт,
 * масштаб текста, ширина знака, округлённая до пикселя): на шаге 5 пометке «не закрыта» хватало места только здесь.
 * Цены и время не уступают никогда. Чистые функции — vitest.
 */
export const CROSS_TIGHT = 1;
export const CROSS_SMALL = 2;
export const CROSS_SHORT = 3;
export const CROSS_NO_ZONE = 4;
export const CROSS_NO_DAY = 5;
/** Шрифт 10 px — после всех уступок, если строка всё ещё не влезла (знаки намного шире здешних). */
export const CROSS_TINY = 6;

/** Части строки, которые уступают место (data-part в разметке): пометка идущей свечи, изменение от открытия, объём. */
export type CrossPart = "note" | "change" | "volume";
export type CrossShed = "noteShort" | "change" | "noteDot" | "volume";
/**
 * Уступки по порядку, каждая — только если не влезает строка с этой частью: на телефоне в две строки пометка — в
 * первой, изменение и объём — во второй, и пометка не сокращается из-за длинной второй строки (а изменение — из-за
 * первой). «не закр.» смысл сохраняет — первой; изменение от открытия уступает раньше точки: C и так цветом
 * показывает рост или падение, а процент считается из O и C; точка (для чтения с экрана и в подсказке — «свеча не
 * закрыта») — когда и «не закр.» не влезает; объём — последним.
 */
export const CROSS_SHED: readonly { id: CrossShed; part: CrossPart }[] = [
  { id: "noteShort", part: "note" },
  { id: "change", part: "change" },
  { id: "noteDot", part: "note" },
  { id: "volume", part: "volume" },
];

/** Вид строки: общий шаг и уступки. */
export type CrossFit = { level: number; shed: readonly CrossShed[] };
export const CROSS_FULL: CrossFit = { level: 0, shed: [] };

/**
 * Следующий вид, если строка не влезает (over() — переполнена хоть одна строка значений, over(part) — та, где лежит
 * часть; нет части — false), или null: влезла или сжимать дальше некуда. Общие шаги — по порядку; после шага 5 —
 * первая уступка, которая освободит место в переполненной строке; уступать нечего — шрифт 10 px; после него — null:
 * строка обрезается у правого края (на 360 px — со знаками шире здешних примерно на треть у закрытой свечи 1000PEPE,
 * идущая свеча помещается и с полуторными).
 */
export function nextCrossFit(fit: CrossFit, over: (part?: CrossPart) => boolean): CrossFit | null {
  if (fit.level >= CROSS_TINY || !over()) return null;
  if (fit.level < CROSS_NO_DAY) return { ...fit, level: fit.level + 1 };
  const step = CROSS_SHED.find((x) => !fit.shed.includes(x.id) && over(x.part));
  return step ? { ...fit, shed: [...fit.shed, step.id] } : { ...fit, level: CROSS_TINY };
}

/** Время свечи — UTC, как было в карточке: «20.09, 00:00». */
const DATE = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit" });
const TIME = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });

/** Дата и время свечи по шагу сжатия: «20.09, 00:00 UTC» → «20.09, 00:00» → у идущей свечи «16:00» или «20.09». */
function dateText(k: Candle, level: number): string {
  const at = new Date(k.time * 1000);
  if (level >= CROSS_NO_DAY && k.open_) return at.getUTCHours() === 0 && at.getUTCMinutes() === 0 ? DAY.format(at) : TIME.format(at);
  const date = DATE.format(at);
  return level >= CROSS_NO_ZONE ? date : `${date} UTC`;
}

/** Пометка идущей свечи: «свеча не закрыта», «не закрыта», «не закр.» или точка; у закрытой — нет. */
export type CrossNote = "full" | "tight" | "short" | "dot";

export type CrossText = {
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Изменение от открытия, как в легенде десктопа: «+0.62 %», «−0.10 %»; у открытия 0 и уступленное — нет. */
  change: string | null;
  up: boolean;
  /** Объём компактно; уступленный — нет. */
  volume: string | null;
  note: CrossNote | null;
};

function noteOf(k: Candle, fit: CrossFit): CrossNote | null {
  if (!k.open_) return null;
  if (fit.shed.includes("noteDot")) return "dot";
  if (fit.shed.includes("noteShort")) return "short";
  return fit.level >= CROSS_TIGHT ? "tight" : "full";
}

export function crossText(k: Candle, tick: string | null, fit: CrossFit): CrossText {
  const { level, shed } = fit;
  const precision = tickPrecision(tick);
  const px = (v: number) => (level >= CROSS_SHORT ? formatPriceShort(v, precision) : formatPrice(v, tick));
  return {
    date: dateText(k, level),
    open: px(k.open),
    high: px(k.high),
    low: px(k.low),
    close: px(k.close),
    change: k.open && !shed.includes("change") ? formatSignedPercent(((k.close - k.open) / k.open) * 100) : null,
    up: k.close >= k.open,
    volume: shed.includes("volume") ? null : formatCompactValue(k.volume),
    note: noteOf(k, fit),
  };
}

/**
 * Ключ подгонки: шрифт строки моноширинный, поэтому её ширина зависит только от длины текстов, пометки «не закрыта» и
 * кнопки индикаторов. Палец идёт по свечам с той же длиной цен — строка не перемеряется; длина сменилась — подгонка
 * начинается заново с полного вида.
 */
export function crossFitKey(k: Candle, tick: string | null, values: number): string {
  const x = crossText(k, tick, CROSS_FULL);
  return `${[x.date, x.open, x.high, x.low, x.close, x.change ?? "", x.volume ?? ""].map((s) => s.length).join(".")}|${x.note ? 1 : 0}|${values > 0 ? String(values).length : 0}`;
}
