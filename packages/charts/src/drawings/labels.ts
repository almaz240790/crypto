import { formatPriceLabel, formatQuantity } from "../format";
import { LABEL_GAP, type LabelCandidate, type Slot } from "../layout/types";
import type { ThemeTokens } from "../types";
import { fibExtended, fibHue, fibLevelText, fibMulticolor } from "./fib";
import { fibLevels, positionKnobs, positionScreen, rulerInfo, type Projector, type RulerInfo } from "./geometry";
import { formatRR, positionParts, type PositionParts } from "./position";
import { FIB_KEY_LEVELS, FIB_LABEL_EDGE_PX, HANDLE_PX, POSITION_KNOB_R, POSITION_KNOB_TOUCH_R, isPosition, type Drawing, type Point, type StyleColor } from "./types";

/**
 * Подписи рисунков как кандидаты общей раскладки подписей (план 2B.2; ADR-0009, «Рисование»): уровни Фибоначчи,
 * плашки позиции, цена горизонтальной линии, процент трендовой, измеритель, текст прямоугольника и заметки.
 * Раскладка разметки (layoutLabels) ставит их вместе с подписями разметки: рисунок пользователя важнее —
 * приоритет DRAWING_LABEL_PRIORITY выше «Сопр.», «Подд.», зон и структуры, поэтому подписи разметки обходят подписи
 * рисунков, а рисунок уступает только алертам, уровням сигнала и выбранному объекту. Подписи рисунков не обходят
 * свечи (у плашек фон), но не ложатся на полосу текущей цены, легенду и кнопки и не выходят за панель.
 */

/** Выше «Сопр.» и «Подд.» (80), зон (70), структуры (60); ниже алертов и уровней сигнала (90) и выбранного (95). */
export const DRAWING_LABEL_PRIORITY = 85;
/** Слой раскладки для подписей рисунков (не слой сцены). */
export const DRAWING_LAYER = "drawings";

/** Подпись уровня и линии: строка 11 px моноширинным, плашка 14 px; текст — с x + 2 плашки, низ строки — на 3 px выше линии. */
export const LABEL_PX = 11;
export const LABEL_H = 14;
const LINE_GAP = 3;
const TEXT_DX = 2;
/** Плашка позиции: отступы 4 × 1, строка 14 px. */
const POS_PAD_X = 4;
const POS_PAD_Y = 1;
/** Заметка: 12 px, рамка 18 px, текст с отступом 6 px; рамка на 6 px правее и 20 px выше точки. */
const NOTE_PX = 12;
const NOTE_H = 18;
const NOTE_PAD = 6;
const NOTE_DX = 6;
const NOTE_DY = 20;
/** Зазор между плашкой позиции и её линией, px. */
const POS_GAP = 2;

/**
 * Как рисуется подпись: text — текст без фона (как раньше у линий), plaque — на плашке цвета фона (измеритель), fib —
 * уровень Фибоначчи на полупрозрачной плашке цвета фона (свечи под ней видны, FIB_PLAQUE_ALPHA), outline — плашка
 * позиции (фон, рамка и текст цвета зоны), note — рамка заметки.
 */
export type DrawingLabelStyle = "text" | "plaque" | "fib" | "outline" | "note";
/**
 * Нет свободного места: fixed — подпись на своём месте всё равно (заметка — это сам рисунок), soft — первое место,
 * не задевающее легенду, кнопки, полосу цены и другие подписи рисунков (поверх подписи разметки старше — можно), а
 * нет и такого — не показывать; drop — не показывать (второстепенный уровень Фибоначчи).
 */
export type DrawingLabelMode = "fixed" | "soft" | "drop";

export interface DrawingLabel {
  /** `${drawingId}#${часть}` */
  id: string;
  drawingId: string;
  lines: readonly string[];
  style: DrawingLabelStyle;
  /** Цвет текста (и рамки у outline). */
  color: string;
  font: "mono" | "sans";
  px: number;
  weight: 400 | 600;
  w: number;
  h: number;
  /** Места по порядку предпочтения: левый верхний угол прямоугольника подписи. */
  slots: readonly { x: number; y: number }[];
  mode: DrawingLabelMode;
  /** Порядок при равном приоритете: начатый и выбранный рисунок раньше, ключевые уровни раньше второстепенных. */
  rank: number;
}

/**
 * Тексты подписей на холсте (русский оригинал; web передаёт перевод через t()): плашки позиции; у измерителя — число
 * свечей словом и единицы времени («25 свечей · 4д 8ч»).
 */
export type DrawingText = { entry: string; stop: string; target: string; risk: string; size: string; bars: (n: number) => string; day: string; hour: string; minute: string };
/** Склонение: 1 свеча, 2 свечи, 5 свечей. */
const ruPlural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
};
export const DRAWING_TEXT: DrawingText = { entry: "Вход", stop: "Стоп", target: "Цель", risk: "риск", size: "объём", bars: (n) => `${n} ${ruPlural(n, "свеча", "свечи", "свечей")}`, day: "д", hour: "ч", minute: "мин" };

export type RiskProfile = { deposit: number; riskPct: number };

/** Ширина текста шрифтом холста: моноширинный или основной, кегль и насыщенность. */
export type MeasureText = (text: string, font: "mono" | "sans", px: number, weight: number) => number;

export interface DrawingLabelInput {
  drawings: readonly Drawing[];
  draft: Drawing | null;
  /** Временный измеритель (план 2A.5): не рисунок — подпись, как у начатого. */
  ruler?: Drawing | null;
  /**
   * Свечи и ход в ATR у измерителя — по свечам графика (DrawingsPrimitive): без них подпись — только разница цен и %.
   */
  rulerStats?: (p1: Point, p2: Point) => RulerInfo;
  selectedId: string | null;
  proj: Projector;
  tokens: ThemeTokens;
  precision: number | null;
  profile: RiskProfile | null;
  text: DrawingText;
  measure: MeasureText;
  /** Ручки под палец (крупнее): подписи у точек выбранного и начатого рисунка обходят ручку этого размера. */
  touch?: boolean;
}

/** Цвет рисунка из токена темы ("accent" — прежний цвет по умолчанию, рисуется нейтральным). */
export function drawingColor(tokens: ThemeTokens, c: StyleColor): string {
  const map: Record<StyleColor, string> = { accent: tokens.text2, up: tokens.up, down: tokens.down, warn: tokens.warn, text2: tokens.text2, text3: tokens.text3 };
  return map[c] ?? tokens.text2;
}

/**
 * Цвет уровня Фибоначчи (ADR-0009, «Рисование», дополнение 2026-11-13): у разноцветного (цвет рисунка по умолчанию) —
 * оттенок уровня из палитры --fib-* (fibHue), 0, 1 и уровни вне набора — нейтральные (--text-2); у рисунка с выбранным
 * цветом — этот цвет у всех уровней.
 */
export function fibLevelColor(tokens: ThemeTokens, d: Pick<Drawing, "style">, level: number): string {
  if (!fibMulticolor(d)) return drawingColor(tokens, d.style.color);
  const hue = fibHue(level);
  return hue === null ? tokens.text2 : (tokens.fib[hue] ?? tokens.text2);
}

/**
 * Цена в подписи рисунка: с точностью инструмента и разрядами — как на шкале. Без шага цены (precision = null) —
 * прежняя грубая запись.
 */
export function formatDrawingPrice(p: number, precision: number | null): string {
  if (!Number.isFinite(p)) return "—";
  if (precision !== null) return formatPriceLabel(p, precision);
  // цена ниже нуля (уровень Фибоначчи далеко за точками) — с типографским минусом, как у шкалы
  const a = Math.abs(p);
  const s = a >= 1000 ? a.toFixed(1) : a >= 1 ? a.toFixed(2) : a.toPrecision(4);
  return p < 0 && Number(s) !== 0 ? `−${s}` : s;
}

/** Процент в подписи позиции: «2.31». */
const pct2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

/** Длительность у измерителя — по часам: «5д», «4д 8ч», «16ч», «4ч 30мин», «15мин». */
export function formatSpan(seconds: number, text: Pick<DrawingText, "day" | "hour" | "minute">): string {
  const total = Math.round(Math.abs(seconds) / 60);
  const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
  if (d > 0) return h > 0 ? `${d}${text.day} ${h}${text.hour}` : `${d}${text.day}`;
  if (h > 0) return m > 0 ? `${h}${text.hour} ${m}${text.minute}` : `${h}${text.hour}`;
  return `${m}${text.minute}`;
}

/**
 * Строки подписи измерителя (план 2A.5): «−4.50 · −4.50 %» — разница цен и % от первой точки (минус типографский, как
 * у цен), «25 свечей · 5д · 1.8 ATR» — свечи, время и ход в ATR(14); ATR ещё нет — без него.
 */
export function rulerLabelLines(r: RulerInfo, precision: number | null, text: DrawingText): string[] {
  const sign = r.priceDiff < 0 ? "−" : "+";
  const head = `${sign}${formatDrawingPrice(Math.abs(r.priceDiff), precision)} · ${sign}${Math.abs(r.changePct).toFixed(2)} %`;
  const tail = [text.bars(r.bars), formatSpan(r.seconds, text), ...(r.atrMultiple !== null ? [`${r.atrMultiple.toFixed(1)} ATR`] : [])];
  return [head, tail.join(" · ")];
}

/**
 * Риск в $ и объём позиции по профилю: «риск 100 $ · объём 449 438» — одна строка для плашки входа на графике и для
 * карточки позиции (те же слова и та же запись числа, без экспоненты).
 */
export function positionRiskText(riskUsd: number, size: number, text: Pick<DrawingText, "risk" | "size">): string {
  return `${text.risk} ${formatQuantity(riskUsd)} $ · ${text.size} ${formatQuantity(size)}`;
}

/** Тексты плашек позиции: цель, стоп, вход (с риском и объёмом по профилю — второй строкой). */
export function positionLabelTexts(p: PositionParts, precision: number | null, profile: RiskProfile | null, text: Pick<DrawingText, "entry" | "stop" | "target" | "risk" | "size">): { target: string; stop: string; entry: string[] } {
  const risk = Math.abs(p.entry - p.stop);
  const reward = Math.abs(p.target - p.entry);
  const rr = risk > 0 ? reward / risk : 0;
  const ref = p.entry !== 0 ? Math.abs(p.entry) : 1;
  const fmt = (v: number) => formatDrawingPrice(v, precision);
  const entry = [`${text.entry} ${fmt(p.entry)} · R:R 1:${formatRR(rr)}`];
  if (profile && profile.deposit > 0 && profile.riskPct > 0 && risk > 0) {
    const usd = (profile.deposit * profile.riskPct) / 100;
    entry.push(positionRiskText(usd, usd / risk, text));
  }
  return {
    target: `${text.target} ${fmt(p.target)} · +${pct2((reward / ref) * 100)}% · ${formatRR(rr)}R`,
    stop: `${text.stop} ${fmt(p.stop)} · −${pct2((risk / ref) * 100)}%`,
    entry,
  };
}

/**
 * Где начать подпись уровня Фибоначчи (x под label): справа от рисунка; не помещается до края панели — внутри рисунка
 * у правого края; рисунок уже подписи — слева от него. Место у края панели — только когда рисунок сам доходит до края
 * или частично за экраном (либо другого места нет вовсе): у небольшого Фибоначчи посреди экрана подпись, которой не
 * хватило места рядом, не уезжает к шкале цены за сотни пикселей от своей линии, а не показывается (второстепенный
 * уровень) или остаётся у рисунка. Возвращает все подходящие места по порядку (раскладка берёт первое свободное).
 */
export function fibXs(span: number, left: number, right: number, width: number): number[] {
  const out: number[] = [];
  if (right + span <= width) out.push(right);
  if (right - left >= span + 2 * TEXT_DX) out.push(right - span - TEXT_DX);
  if (left - span - TEXT_DX >= 0) out.push(left - span - TEXT_DX);
  if (out.length === 0 || left < 0 || right + span > width) out.push(Math.max(0, width - span));
  return [...new Set(out)];
}

/**
 * Места подписи уровня продлённого Фибоначчи (x под label; ADR-0009, «Рисование», дополнение 2026-11-13): столбец у
 * шкалы цены — правый край плашки на FIB_LABEL_EDGE_PX левее края панели, у правого конца линии: подписи уровней
 * выровнены и не лежат на свечах A–B. Ключевым (soft) после столбца — прежние места у рисунка (fibXs): столбец на их
 * высоте занят (полоса текущей цены, подпись старше) — подпись остаётся на своей линии, а не пропадает.
 */
export function fibEdgeXs(span: number, left: number, right: number, width: number, soft: boolean): number[] {
  const col = width - FIB_LABEL_EDGE_PX - span;
  return soft ? [col, ...fibXs(span, left, right, width).filter((x) => x !== col)] : [col];
}

/** Все подписи видимых рисунков, начатого рисунка и измерителя — в координатах панели (CSS px). */
export function drawingLabels(o: DrawingLabelInput): DrawingLabel[] {
  const out: DrawingLabel[] = [];
  const list = [...o.drawings, ...(o.draft ? [o.draft] : []), ...(o.ruler ? [o.ruler] : [])];
  for (const d of list) {
    const base = d === o.draft || d === o.ruler ? -20 : d.id === o.selectedId ? -10 : 0;
    labelsOf(d, base, o, out);
  }
  return out;
}

function labelsOf(d: Drawing, base: number, o: DrawingLabelInput, out: DrawingLabel[]): void {
  const { proj, tokens, precision, measure } = o;
  const W = proj.width;
  const color = drawingColor(tokens, d.style.color);
  const xy = (i: number) => {
    const p = d.points[i];
    if (!p) return null;
    const x = proj.x(p.time), y = proj.y(p.price);
    return x === null || y === null ? null : { x, y };
  };
  /**
   * Подпись у линии: прямоугольник от x + 2, над линией (низ строки на 3 px выше) или под ней. Места — сначала все над
   * линией, потом все под ней; byX — по каждому x над и под линией (столбец продлённого Фибоначчи раньше запасных мест).
   */
  const line = (part: string, text: string, xs: readonly number[], y: number, opts: { style?: DrawingLabelStyle; strong?: boolean; mode?: DrawingLabelMode; rank?: number; below?: boolean; color?: string; byX?: boolean } = {}) => {
    const weight = opts.strong ? 600 : 400;
    const w = measure(text, "mono", LABEL_PX, weight) + 2 * TEXT_DX;
    const above = xs.map((x) => ({ x: x + TEXT_DX, y: y - LINE_GAP - LABEL_H }));
    const below = xs.map((x) => ({ x: x + TEXT_DX, y: y + LINE_GAP }));
    const slots = opts.below === false ? above : opts.byX ? above.flatMap((s, i) => [s, below[i]!]) : [...above, ...below];
    out.push({ id: `${d.id}#${part}`, drawingId: d.id, lines: [text], style: opts.style ?? "text", color: opts.color ?? color, font: "mono", px: LABEL_PX, weight, w, h: LABEL_H, slots, mode: opts.mode ?? "soft", rank: base + (opts.rank ?? 0) });
  };
  if (isPosition(d.type)) return positionLabels(d, base, o, out);
  const a = xy(0);
  if (!a) return;
  switch (d.type) {
    case "hline":
    case "hray": {
      const x0 = d.type === "hline" ? 0 : Math.max(0, a.x);
      const text = formatDrawingPrice(d.points[0]!.price, precision);
      const w = measure(text, "mono", LABEL_PX, 400) + 2 * TEXT_DX;
      line("price", text, [x0, Math.max(x0, W - w - 2 * TEXT_DX)], a.y);
      return;
    }
    case "trend": {
      const b = xy(1);
      if (!b) return;
      const p1 = d.points[0]!, p2 = d.points[1]!;
      const pct = p1.price ? ((p2.price - p1.price) / p1.price) * 100 : 0;
      const text = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)} %${d.text ? " · " + d.text : ""}`;
      const w = measure(text, "mono", LABEL_PX, 400) + 2 * TEXT_DX;
      // у выбранного и начатого на B — ручка (занятое место раскладки, handleRects): над и под линией у самой точки
      // подпись задевала её и пропадала — именно когда измеряют или тянут конец. Тогда — правее или левее ручки
      // (прямоугольник подписи — на TEXT_DX от x, раскладка раздувает его на LABEL_GAP; 1 px — запас на округление).
      const r = (o.touch ? HANDLE_TOUCH_R : HANDLE_R) + LABEL_GAP - TEXT_DX + 1;
      line("pct", text, [b.x, b.x - w - 2 * TEXT_DX, b.x + r, b.x - w - 2 * TEXT_DX - r], b.y);
      return;
    }
    case "ruler": {
      const b = xy(1);
      if (!b) return;
      const p1 = d.points[0]!, p2 = d.points[1]!;
      const lines = o.rulerStats ? rulerLabelLines(o.rulerStats(p1, p2), precision, o.text) : rulerLabelLines(rulerInfo(p1, p2, () => 0, null), precision, o.text).slice(0, 1);
      const w = Math.max(...lines.map((l) => measure(l, "mono", LABEL_PX, 400))) + 2 * TEXT_DX;
      const h = lines.length * LABEL_H;
      const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y), left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
      // за точкой B по ходу (вниз — под измерением, вверх — над ним), с зазором на ручку B (начатый и выбранный), потом —
      // с другой стороны; по горизонтали — посередине измерения, под B, у правого и левого края. В панели — всегда
      const gap = (o.touch ? HANDLE_TOUCH_R : HANDLE_R) + LABEL_GAP + 1;
      const ys = b.y >= a.y ? [bottom + gap, top - gap - h] : [top - gap - h, bottom + gap];
      const xs = [(left + right) / 2 - w / 2, b.x - w / 2, right - w, left];
      const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), Math.max(0, max));
      const slots = ys.flatMap((y) => xs.map((x) => ({ x: clamp(x, W - w), y: clamp(y, proj.height - h) })));
      out.push({ id: `${d.id}#ruler`, drawingId: d.id, lines, style: "plaque", color, font: "mono", px: LABEL_PX, weight: 400, w, h, slots, mode: "soft", rank: base });
      return;
    }
    case "rect": {
      const b = xy(1);
      if (!b || !d.text) return;
      const x = Math.min(a.x, b.x), top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
      const w = measure(d.text, "mono", LABEL_PX, 400) + 2 * TEXT_DX;
      // у верхнего края внутри (низ строки на 11 px ниже края), иначе у нижнего
      out.push({ id: `${d.id}#text`, drawingId: d.id, lines: [d.text], style: "text", color, font: "mono", px: LABEL_PX, weight: 400, w, h: LABEL_H, slots: [{ x: x + TEXT_DX, y: top - LINE_GAP }, { x: x + TEXT_DX, y: bottom - LABEL_H - LINE_GAP }], mode: "soft", rank: base });
      return;
    }
    case "fib": {
      const b = xy(1);
      if (!b) return;
      const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
      const ext = fibExtended(d);
      // Фибоначчи за экраном (график прокрутили) — без подписей: иначе запасное место у края панели собирало бы все
      // его уровни у текущей цены без линий рядом. Продлённый левее экрана — с подписями: его линии идут через панель
      if (left > W || (!ext && right < 0)) return;
      for (const { level, price } of fibLevels(d.points[0]!, d.points[1]!, d.levels)) {
        const y = proj.y(price);
        if (y === null) continue;
        const key = FIB_KEY_LEVELS.includes(level);
        const edge = level === 0 || level === 1;
        // отрицательный уровень (цель по движению) — с типографским минусом: «−0.618 · 123.4»
        const text = `${fibLevelText(level)} · ${formatDrawingPrice(price, precision)}`;
        // от x до конца плашки: отступ плашки, отступ текста, текст, поле плашки справа
        const span = TEXT_DX + measure(text, "mono", LABEL_PX, key ? 600 : 400) + 2 * TEXT_DX;
        // второстепенный уровень без места не подписывается: подписи не ложатся друг на друга и на разметку
        const soft = key || edge;
        const xs = ext ? fibEdgeXs(span, left, right, W, soft) : fibXs(span, left, right, W);
        line(`L${level}`, text, xs, y, { style: "fib", strong: key, mode: soft ? "soft" : "drop", rank: soft ? 0 : 1, color: fibLevelColor(tokens, d, level), byX: ext });
      }
      return;
    }
    case "note": {
      const text = d.text ?? "";
      const w = measure(text, "sans", NOTE_PX, 400) + 2 * NOTE_PAD;
      out.push({ id: `${d.id}#note`, drawingId: d.id, lines: [text], style: "note", color, font: "sans", px: NOTE_PX, weight: 400, w, h: NOTE_H, slots: [{ x: a.x + NOTE_DX, y: a.y - NOTE_DY }], mode: "fixed", rank: base });
      return;
    }
    default:
      return;
  }
}

/**
 * Плашки позиции: цель — над зоной прибыли (у Short — под ней), стоп — под зоной риска (у Short — над ней), вход — на
 * линии входа; по горизонтали — посередине позиции, у её левого или правого края. Нет места снаружи — внутри зоны.
 * Подпись остаётся в панели (прижимается к краю), пока её зона хоть частично на экране.
 */
function positionLabels(d: Drawing, base: number, o: DrawingLabelInput, out: DrawingLabel[]): void {
  const p = positionParts(d);
  const s = p ? positionScreen(d, o.proj) : null;
  if (!p || !s) return;
  const W = o.proj.width, H = o.proj.height;
  if (s.xR < 0 || s.xL > W) return;
  const t = positionLabelTexts(p, o.precision, o.profile, o.text);
  const tones = { target: o.tokens.up, stop: o.tokens.down, entry: o.tokens.text2 };
  const visible = (y1: number, y2: number) => Math.max(y1, y2) >= 0 && Math.min(y1, y2) <= H;
  /** y места по высоте плашки. */
  type Yf = (h: number) => number;
  const plaque = (part: "target" | "stop" | "entry", lines: readonly string[], ys: readonly Yf[], rank: number) => {
    const w = Math.max(...lines.map((l) => o.measure(l, "mono", LABEL_PX, 600))) + 2 * POS_PAD_X;
    const h = lines.length * LABEL_H + 2 * POS_PAD_Y;
    const clampX = (x: number) => Math.min(Math.max(x, 0), Math.max(0, W - w));
    const clampY = (y: number) => Math.min(Math.max(y, 0), Math.max(0, H - h));
    // над позицией: посередине, у левого и правого края — на всех высотах; лишь потом снаружи слева и справа (плашка
    // у своей зоны важнее, чем у самой линии)
    const inner = [...new Set([s.xC - w / 2, s.xL + POS_GAP, s.xR - w - POS_GAP].map(clampX))];
    const outer = [...new Set([s.xL - w - POS_GAP, s.xR + POS_GAP].map(clampX))].filter((x) => !inner.includes(x));
    const slots: { x: number; y: number }[] = [];
    for (const xs of [inner, outer]) for (const yy of ys) for (const x of xs) slots.push({ x, y: clampY(yy(h)) });
    out.push({ id: `${d.id}#${part}`, drawingId: d.id, lines, style: "outline", color: tones[part], font: "mono", px: LABEL_PX, weight: 600, w, h, slots, mode: "soft", rank: base + rank });
  };
  // k — на сколько плашек дальше от линии (полоса текущей цены, подпись разметки старше — следующее место)
  const outside = (y: number, up: boolean, k = 0): Yf => (h) => (up ? y - (k + 1) * (h + POS_GAP) : y + POS_GAP + k * (h + POS_GAP));
  const inside = (y: number, up: boolean, k = 0): Yf => (h) => (up ? y + POS_GAP + k * (h + POS_GAP) : y - (k + 1) * (h + POS_GAP));
  // дальние места (до пяти плашек от линии) — раньше, чем запасное место поверх другой подписи: позиции рядом и
  // Фибоначчи у цены раскладываются стопкой, а не друг на друга
  const near = (y: number, up: boolean): Yf[] => [outside(y, up), inside(y, up), outside(y, up, 1), inside(y, up, 1), outside(y, up, 2), inside(y, up, 2), outside(y, up, 3), outside(y, up, 4)];
  const targetUp = s.yT <= s.yE;
  const stopUp = s.yS < s.yE;
  if (visible(s.yE, s.yT)) plaque("target", [t.target], near(s.yT, targetUp), 1);
  if (visible(s.yE, s.yS)) plaque("stop", [t.stop], near(s.yS, stopUp), 2);
  // вход — на своей линии (плашка поперёк линии), иначе над ней или под ней
  const yE = s.yE;
  const entryYs: Yf[] = [(h) => yE - h / 2, (h) => yE - h - POS_GAP, (h) => yE + POS_GAP];
  for (let k = 2; k <= 4; k++) entryYs.push((h) => yE - k * (h + POS_GAP), (h) => yE + (k - 1) * h + k * POS_GAP);
  if (visible(s.yS, s.yT)) plaque("entry", t.entry, entryYs, 0);
}

/** Ручки выбранного рисунка — выше всех подписей: ни подпись рисунка, ни подпись разметки на них не ложится. */
export const HANDLE_PRIORITY = 100;
/** Видимый радиус ручки точки: мышь, палец (как у DrawingsPrimitive). */
const HANDLE_R = HANDLE_PX / 2;
const HANDLE_TOUCH_R = 10;

/**
 * Ручки выбранного и начатого рисунка на экране (их рисует примитив поверх подписей): места, занятые для раскладки —
 * подпись не прячется под ручкой (у позиции на телефоне ручка цели посередине линии, плашка цели — над ней).
 */
export function handleRects(o: Pick<DrawingLabelInput, "drawings" | "draft" | "selectedId" | "proj">, touch: boolean): { id: string; rect: { x: number; y: number; w: number; h: number } }[] {
  const out: { id: string; rect: { x: number; y: number; w: number; h: number } }[] = [];
  const list = [...o.drawings.filter((d) => d.id === o.selectedId && !d.locked), ...(o.draft ? [o.draft] : [])];
  for (const d of list) {
    const pts: { x: number; y: number }[] = [];
    let r = touch ? HANDLE_TOUCH_R : HANDLE_R;
    if (isPosition(d.type)) {
      const s = positionScreen(d, o.proj);
      if (s) pts.push(...Object.values(positionKnobs(s)));
      r = touch ? POSITION_KNOB_TOUCH_R : POSITION_KNOB_R;
    } else {
      for (const p of d.points) {
        const x = o.proj.x(p.time), y = o.proj.y(p.price);
        if (x !== null && y !== null) pts.push({ x, y });
      }
    }
    pts.forEach((p, i) => out.push({ id: `${d.id}#handle${i}`, rect: { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r } }));
  }
  return out;
}

/** Ручка как кандидат раскладки: на своём месте всегда (fixed), раньше всех подписей, сама не рисуется раскладкой. */
export function handleCandidate(h: { id: string; rect: { x: number; y: number; w: number; h: number } }): LabelCandidate {
  return { id: h.id, objectId: h.id, layer: DRAWING_LAYER, text: "", font: "mono", px: LABEL_PX, w: h.rect.w, h: h.rect.h, priority: HANDLE_PRIORITY, tone: "muted", slots: [{ key: "free-above", x: h.rect.x, y: h.rect.y, clampX: false }], bypassBudget: true, external: true, overCandles: true, area: "pane", force: "fixed" };
}

/** Кандидат общей раскладки: тот же прямоугольник, приоритет рисунка, без бюджета; свечи не обходит. */
export function toCandidate(l: DrawingLabel): LabelCandidate {
  const slots: Slot[] = l.slots.map((s) => ({ key: "free-above", x: s.x, y: s.y, clampX: false }));
  return {
    id: l.id,
    objectId: l.drawingId,
    layer: DRAWING_LAYER,
    text: l.lines.join(" / "),
    font: l.font,
    px: l.px,
    w: l.w,
    h: l.h,
    priority: DRAWING_LABEL_PRIORITY,
    tone: "muted",
    slots,
    bypassBudget: true,
    rank: l.rank,
    external: true,
    overCandles: true,
    area: "pane",
    force: l.mode === "drop" ? undefined : l.mode,
  };
}

