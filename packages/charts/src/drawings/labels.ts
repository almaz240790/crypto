import { formatPriceLabel } from "../format";
import type { LabelCandidate, Slot } from "../layout/types";
import type { ThemeTokens } from "../types";
import { fibLevels, positionKnobs, positionScreen, type Projector } from "./geometry";
import { formatRR, positionParts, type PositionParts } from "./position";
import { FIB_KEY_LEVELS, HANDLE_PX, POSITION_KNOB_R, POSITION_KNOB_TOUCH_R, isPosition, type Drawing, type StyleColor } from "./types";

/**
 * Подписи рисунков как кандидаты общей раскладки подписей (план 2B.2; ADR-0009, «Рисование»): уровни Фибоначчи,
 * плашки позиции, цена горизонтальной линии, процент трендовой и измерителя, текст прямоугольника и заметки.
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
 * Как рисуется подпись: text — текст без фона (как раньше у линий), plaque — на плашке цвета фона (Фибоначчи),
 * outline — плашка позиции (фон, рамка и текст цвета зоны), note — рамка заметки.
 */
export type DrawingLabelStyle = "text" | "plaque" | "outline" | "note";
/**
 * Нет свободного места: fixed — подпись на своём месте всё равно (заметка — это сам рисунок), soft — первое место,
 * не задевающее легенду, кнопки и полосу цены, drop — не показывать (второстепенный уровень Фибоначчи).
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

/** Тексты подписей позиции на холсте (русский оригинал; web передаёт перевод через t()). */
export type DrawingText = { entry: string; stop: string; target: string; risk: string; size: string };
export const DRAWING_TEXT: DrawingText = { entry: "Вход", stop: "Стоп", target: "Цель", risk: "риск", size: "объём" };

export type RiskProfile = { deposit: number; riskPct: number };

/** Ширина текста шрифтом холста: моноширинный или основной, кегль и насыщенность. */
export type MeasureText = (text: string, font: "mono" | "sans", px: number, weight: number) => number;

export interface DrawingLabelInput {
  drawings: readonly Drawing[];
  draft: Drawing | null;
  selectedId: string | null;
  proj: Projector;
  tokens: ThemeTokens;
  precision: number | null;
  profile: RiskProfile | null;
  text: DrawingText;
  measure: MeasureText;
}

/** Цвет рисунка из токена темы ("accent" — прежний цвет по умолчанию, рисуется нейтральным). */
export function drawingColor(tokens: ThemeTokens, c: StyleColor): string {
  const map: Record<StyleColor, string> = { accent: tokens.text2, up: tokens.up, down: tokens.down, warn: tokens.warn, text2: tokens.text2, text3: tokens.text3 };
  return map[c] ?? tokens.text2;
}

/**
 * Цена в подписи рисунка: с точностью инструмента и разрядами — как на шкале. Без шага цены (precision = null) —
 * прежняя грубая запись.
 */
export function formatDrawingPrice(p: number, precision: number | null): string {
  if (precision !== null) return formatPriceLabel(p, precision);
  return p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toPrecision(4);
}

/** Процент в подписи позиции: «2.31». */
const pct2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

/** Тексты плашек позиции: цель, стоп, вход (с риском и объёмом по профилю — второй строкой). */
export function positionLabelTexts(p: PositionParts, precision: number | null, profile: RiskProfile | null, text: DrawingText): { target: string; stop: string; entry: string[] } {
  const risk = Math.abs(p.entry - p.stop);
  const reward = Math.abs(p.target - p.entry);
  const rr = risk > 0 ? reward / risk : 0;
  const ref = p.entry !== 0 ? Math.abs(p.entry) : 1;
  const fmt = (v: number) => formatDrawingPrice(v, precision);
  const entry = [`${text.entry} ${fmt(p.entry)} · R:R 1:${formatRR(rr)}`];
  if (profile && profile.deposit > 0 && profile.riskPct > 0 && risk > 0) {
    const usd = (profile.deposit * profile.riskPct) / 100;
    entry.push(`${text.risk} ${usd.toFixed(0)} $ · ${text.size} ${(usd / risk).toPrecision(4)}`);
  }
  return {
    target: `${text.target} ${fmt(p.target)} · +${pct2((reward / ref) * 100)}% · ${formatRR(rr)}R`,
    stop: `${text.stop} ${fmt(p.stop)} · −${pct2((risk / ref) * 100)}%`,
    entry,
  };
}

/**
 * Где начать подпись уровня Фибоначчи (x под label): справа от рисунка; не помещается до края панели — внутри рисунка
 * у правого края; рисунок уже подписи — слева от него; в крайнем случае — у края панели. Возвращает все подходящие
 * места по порядку (раскладка берёт первое свободное).
 */
function fibXs(span: number, left: number, right: number, width: number): number[] {
  const out: number[] = [];
  if (right + span <= width) out.push(right);
  if (right - left >= span + 2 * TEXT_DX) out.push(right - span - TEXT_DX);
  if (left - span - TEXT_DX >= 0) out.push(left - span - TEXT_DX);
  out.push(Math.max(0, width - span));
  return [...new Set(out)];
}

/** Все подписи видимых рисунков и начатого рисунка — в координатах панели (CSS px). */
export function drawingLabels(o: DrawingLabelInput): DrawingLabel[] {
  const out: DrawingLabel[] = [];
  const list = o.draft ? [...o.drawings, o.draft] : o.drawings;
  for (const d of list) {
    const base = d === o.draft ? -20 : d.id === o.selectedId ? -10 : 0;
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
  /** Подпись у линии: прямоугольник от x + 2, над линией (низ строки на 3 px выше) или под ней. */
  const line = (part: string, text: string, xs: readonly number[], y: number, opts: { style?: DrawingLabelStyle; strong?: boolean; mode?: DrawingLabelMode; rank?: number; below?: boolean } = {}) => {
    const weight = opts.strong ? 600 : 400;
    const w = measure(text, "mono", LABEL_PX, weight) + 2 * TEXT_DX;
    const above = xs.map((x) => ({ x: x + TEXT_DX, y: y - LINE_GAP - LABEL_H }));
    const below = xs.map((x) => ({ x: x + TEXT_DX, y: y + LINE_GAP }));
    out.push({ id: `${d.id}#${part}`, drawingId: d.id, lines: [text], style: opts.style ?? "text", color, font: "mono", px: LABEL_PX, weight, w, h: LABEL_H, slots: opts.below === false ? above : [...above, ...below], mode: opts.mode ?? "soft", rank: base + (opts.rank ?? 0) });
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
    case "trend":
    case "ruler": {
      const b = xy(1);
      if (!b) return;
      const p1 = d.points[0]!, p2 = d.points[1]!;
      const pct = p1.price ? ((p2.price - p1.price) / p1.price) * 100 : 0;
      const text = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)} %${d.text ? " · " + d.text : ""}`;
      const w = measure(text, "mono", LABEL_PX, 400) + 2 * TEXT_DX;
      line("pct", text, [b.x, b.x - w - 2 * TEXT_DX], b.y);
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
      for (const { level, price } of fibLevels(d.points[0]!, d.points[1]!, d.levels)) {
        const y = proj.y(price);
        if (y === null) continue;
        const key = FIB_KEY_LEVELS.includes(level);
        const edge = level === 0 || level === 1;
        const text = `${level} · ${formatDrawingPrice(price, precision)}`;
        // от x до конца плашки: отступ плашки, отступ текста, текст, поле плашки справа
        const span = TEXT_DX + measure(text, "mono", LABEL_PX, key ? 600 : 400) + 2 * TEXT_DX;
        // второстепенный уровень без места не подписывается: подписи не ложатся друг на друга и на разметку
        line(`L${level}`, text, fibXs(span, left, right, W), y, { style: "plaque", strong: key, mode: key || edge ? "soft" : "drop", rank: key || edge ? 0 : 1 });
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
    // посередине, у левого и правого края внутри, затем снаружи слева и справа
    const xs = [...new Set([s.xC - w / 2, s.xL + POS_GAP, s.xR - w - POS_GAP, s.xL - w - POS_GAP, s.xR + POS_GAP].map(clampX))];
    const slots: { x: number; y: number }[] = [];
    for (const yy of ys) for (const x of xs) slots.push({ x, y: clampY(yy(h)) });
    out.push({ id: `${d.id}#${part}`, drawingId: d.id, lines, style: "outline", color: tones[part], font: "mono", px: LABEL_PX, weight: 600, w, h, slots, mode: "soft", rank: base + rank });
  };
  // k — на сколько плашек дальше от линии (полоса текущей цены, подпись разметки старше — следующее место)
  const outside = (y: number, up: boolean, k = 0): Yf => (h) => (up ? y - (k + 1) * (h + POS_GAP) : y + POS_GAP + k * (h + POS_GAP));
  const inside = (y: number, up: boolean, k = 0): Yf => (h) => (up ? y + POS_GAP + k * (h + POS_GAP) : y - (k + 1) * (h + POS_GAP));
  const near = (y: number, up: boolean): Yf[] => [outside(y, up), inside(y, up), outside(y, up, 1), inside(y, up, 1), outside(y, up, 2)];
  const targetUp = s.yT <= s.yE;
  const stopUp = s.yS < s.yE;
  if (visible(s.yE, s.yT)) plaque("target", [t.target], near(s.yT, targetUp), 1);
  if (visible(s.yE, s.yS)) plaque("stop", [t.stop], near(s.yS, stopUp), 2);
  // вход — на своей линии (плашка поперёк линии), иначе над ней или под ней
  const yE = s.yE;
  if (visible(s.yS, s.yT)) plaque("entry", t.entry, [(h) => yE - h / 2, (h) => yE - h - POS_GAP, (h) => yE + POS_GAP, (h) => yE - 2 * (h + POS_GAP), (h) => yE + h + 2 * POS_GAP], 0);
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

