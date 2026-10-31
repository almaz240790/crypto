import type { Page } from "@playwright/test";

/**
 * Перепись текста на холстах графика (план 2B.2, §14.3). До загрузки страницы перехватывается
 * CanvasRenderingContext2D.prototype.fillText: для каждого холста хранятся тексты с последней полной очистки
 * (LWC перед отрисовкой заливает холст целиком с globalCompositeOperation = "copy" или зовёт clearRect),
 * то есть ровно то, что сейчас на экране. По каждому тексту: холст (pane / priceAxis / timeAxis / other),
 * текст, размер шрифта в CSS px (размер в пикселях холста, делённый на его масштаб), шрифт, цвет и
 * прямоугольник в координатах панели цены (CSS px).
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type CensusText = { canvas: "pane" | "priceAxis" | "timeAxis" | "other"; text: string; px: number; font: string; fill: string; rect: Rect };
export type OverlayLabel = { id: string; objectId: string; layer: string; text: string; rect: Rect; tone: string; px: number; priority: number; bypassBudget: boolean; color: string };
export type OverlayAxis = { id: string; objectId: string; y: number; text: string; tone: string; style: "outline" | "solid"; merged: string[] };
export type Overlay = {
  sceneVersion: number;
  frameKey: string;
  labels: OverlayLabel[];
  axis: OverlayAxis[];
  hiddenBands: [number, number][];
  dropped: { id: string; reason: string }[];
  candles: Rect[];
  lastPrice: Rect | null;
  free: { x0: number; x1: number } | null;
  gutter: { x0: number; x1: number; mode: "reserved" | "overlay" } | null;
  budget: { canvas: number; perLayer: Record<string, number> };
  minFontPx: number;
  heatRects: Rect[];
  countdown: Rect | null;
  objects: { id: string; layer: string; kind: string; tone: string; color: string; emphasis: string; rect: Rect | null }[];
  layouts: number;
};
export type Census = {
  texts: CensusText[];
  overlay: Overlay;
  /** Панель цены на странице и ширина области свечей и шкалы, CSS px. */
  plot: { left: number; top: number; width: number; height: number; axisWidth: number };
  /** Текст и прямоугольник метки последней цены на шкале (по форматтеру основной серии). */
  lastLabel: { text: string; rect: Rect | null };
  /** DOM-отсчёт до закрытия под ценой, в координатах панели. */
  countdownDom: Rect | null;
  scaleFontPx: number;
};

/** Ставит перехват до загрузки страницы (addInitScript). */
export async function installCensus(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Rec = { text: string; X: number; Y: number; l: number; r: number; asc: number; desc: number; sx: number; sy: number; px: number; font: string; fill: string };
    const byCanvas = new Map<HTMLCanvasElement, Rec[]>();
    const proto = CanvasRenderingContext2D.prototype;
    const reset = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
      const cv = ctx.canvas;
      const m = ctx.getTransform();
      // полная очистка холста: начало новой отрисовки
      if (m.a * x + m.e <= 0 && m.d * y + m.f <= 0 && m.a * w >= cv.width - 1 && m.d * h >= cv.height - 1) byCanvas.set(cv, []);
    };
    const clear = proto.clearRect;
    proto.clearRect = function (x: number, y: number, w: number, h: number) {
      reset(this, x, y, w, h);
      return clear.call(this, x, y, w, h);
    };
    const fillRect = proto.fillRect;
    proto.fillRect = function (x: number, y: number, w: number, h: number) {
      if (this.globalCompositeOperation === "copy") reset(this, x, y, w, h);
      return fillRect.call(this, x, y, w, h);
    };
    const fillText = proto.fillText;
    proto.fillText = function (text: string, x: number, y: number, maxWidth?: number) {
      const s = String(text);
      if (s.trim() !== "") {
        const cv = this.canvas;
        let list = byCanvas.get(cv);
        if (!list) byCanvas.set(cv, (list = []));
        const m = this.getTransform();
        const mt = this.measureText(s);
        const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 0);
        list.push({ text: s, X: m.a * x + m.c * y + m.e, Y: m.b * x + m.d * y + m.f, l: mt.actualBoundingBoxLeft, r: mt.actualBoundingBoxRight, asc: mt.actualBoundingBoxAscent, desc: mt.actualBoundingBoxDescent, sx: m.a, sy: m.d, px, font: this.font, fill: String(this.fillStyle) });
      }
      return maxWidth === undefined ? fillText.call(this, text, x, y) : fillText.call(this, text, x, y, maxWidth);
    };
    (window as unknown as { __censusRaw: () => { canvas: HTMLCanvasElement; recs: Rec[] }[] }).__censusRaw = () => [...byCanvas.entries()].filter(([cv]) => cv.isConnected).map(([canvas, recs]) => ({ canvas, recs }));
  });
}

const frames = (page: Page, n = 2) =>
  page.evaluate(
    (n) =>
      new Promise<void>((res) => {
        let k = 0;
        const step = () => (++k >= n ? res() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );

/** Снимок: ждёт 2 кадра и собирает тексты всех холстов графика, отладку разметки и метку цены. */
export async function census(page: Page): Promise<Census> {
  await frames(page, 2);
  return page.evaluate(() => {
    type Rec = { text: string; X: number; Y: number; l: number; r: number; asc: number; desc: number; sx: number; sy: number; px: number; font: string; fill: string };
    type Chart = {
      panes(): { getHTMLElement(): HTMLElement; getSeries(): { data(): { close?: number; value?: number }[]; priceFormatter(): { format(p: number): string }; priceToCoordinate(p: number): number | null }[] }[];
      paneSize(i?: number): { width: number; height: number };
      priceScale(id: string): { width(): number };
      options(): { layout: { fontSize: number } };
    };
    const el = document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: Chart; __overlay: () => unknown };
    const chart = el.__chart;
    const pane = chart.panes()[0]!;
    const row = pane.getHTMLElement().getBoundingClientRect();
    const size = chart.paneSize(0);
    const axisWidth = chart.priceScale("right").width();
    const plot = { left: row.left, top: row.top, width: size.width, height: size.height, axisWidth };
    const panesBottom = Math.max(...chart.panes().map((p) => p.getHTMLElement().getBoundingClientRect().bottom));
    const raw = (window as unknown as { __censusRaw: () => { canvas: HTMLCanvasElement; recs: Rec[] }[] }).__censusRaw();
    const texts = [];
    for (const { canvas, recs } of raw) {
      if (!el.contains(canvas)) continue;
      const cr = canvas.getBoundingClientRect();
      if (cr.width === 0 || cr.height === 0) continue;
      const kx = canvas.width / cr.width;
      const ky = canvas.height / cr.height;
      const cx = cr.left + cr.width / 2;
      const cy = cr.top + cr.height / 2;
      const kind = cy >= panesBottom - 1 ? "timeAxis" : cy >= row.top && cy <= row.top + size.height ? (cx <= row.left + size.width ? "pane" : cx <= row.left + size.width + axisWidth ? "priceAxis" : "other") : "other";
      for (const r of recs) {
        const x1 = (r.X - r.l * r.sx) / kx + cr.left - plot.left;
        const x2 = (r.X + r.r * r.sx) / kx + cr.left - plot.left;
        const y1 = (r.Y - r.asc * r.sy) / ky + cr.top - plot.top;
        const y2 = (r.Y + r.desc * r.sy) / ky + cr.top - plot.top;
        texts.push({ canvas: kind, text: r.text, px: (r.px * r.sy) / ky, font: r.font, fill: r.fill, rect: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } });
      }
    }
    const series = pane.getSeries()[0]!;
    const lastBar = series.data().at(-1);
    const lastValue = lastBar?.close ?? lastBar?.value ?? null;
    const lastText = lastValue == null ? "" : series.priceFormatter().format(lastValue);
    const lastY = lastValue == null ? null : series.priceToCoordinate(lastValue);
    const fontSize = chart.options().layout.fontSize;
    const lh = Math.round((fontSize * 17) / 12);
    const lastRect = lastY == null ? null : { x: size.width, y: lastY - lh / 2, w: axisWidth, h: lh };
    const cd = document.querySelector('[data-testid="countdown"]') as HTMLElement | null;
    const cdr = cd && cd.style.display !== "none" ? cd.getBoundingClientRect() : null;
    const countdownDom = cdr && cdr.width > 0 ? { x: cdr.left - plot.left, y: cdr.top - plot.top, w: cdr.width, h: cdr.height } : null;
    return { texts, overlay: el.__overlay(), plot, lastLabel: { text: lastText, rect: lastRect }, countdownDom, scaleFontPx: fontSize } as never;
  });
}

export const intersects = (a: Rect, b: Rect, eps = 0) => a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps;
export const inBands = (y: number, bands: readonly (readonly [number, number])[]) => bands.some(([a, b]) => y >= a && y <= b);
const center = (r: Rect) => r.y + r.h / 2;

/**
 * Нарушения правил переписи (план 2B.2, §14.3, пункты 1–5): пустой список — всё в порядке.
 * budget — сколько подписей разрешено (8 десктоп / 4 телефон) сверх обходящих бюджет (выбранный, под курсором).
 */
export function violations(c: Census): string[] {
  const out: string[] = [];
  const o = c.overlay;
  const chartTexts = c.texts.filter((t) => t.canvas !== "other");
  // 1. шрифт на холстах графика не мельче 11 CSS px
  for (const t of chartTexts) if (t.px < 11 - 0.01) out.push(`шрифт ${t.px.toFixed(2)} px < 11: «${t.text}» (${t.canvas})`);
  // 2. размещённые подписи попарно не пересекаются — и по раскладке, и по тому, что нарисовано на холсте
  for (let i = 0; i < o.labels.length; i++)
    for (let j = i + 1; j < o.labels.length; j++) if (intersects(o.labels[i]!.rect, o.labels[j]!.rect)) out.push(`подписи пересекаются: «${o.labels[i]!.text}» и «${o.labels[j]!.text}»`);
  const pane = chartTexts.filter((t) => t.canvas === "pane");
  for (let i = 0; i < pane.length; i++)
    for (let j = i + 1; j < pane.length; j++) if (intersects(pane[i]!.rect, pane[j]!.rect, 0.5)) out.push(`текст на тексте (холст): «${pane[i]!.text}» и «${pane[j]!.text}»`);
  // 3. ни одна подпись не задевает свечу и полосу текущей цены
  for (const l of o.labels) {
    if (o.lastPrice && intersects(l.rect, o.lastPrice)) out.push(`подпись «${l.text}» на полосе текущей цены`);
    const hit = o.candles.find((r) => intersects(l.rect, r));
    if (hit) out.push(`подпись «${l.text}» на свече x=${hit.x.toFixed(1)}`);
  }
  // 4. бюджет подписей
  const counted = o.labels.filter((l) => !l.bypassBudget).length;
  if (counted > o.budget.canvas) out.push(`подписей ${counted} > бюджета ${o.budget.canvas}`);
  // 5. шкала: деления не под метками, тексты шкалы не пересекаются, цена не закрыта
  const axis = chartTexts.filter((t) => t.canvas === "priceAxis");
  const allowed = new Set([...o.axis.map((a) => a.text), c.lastLabel.text]);
  for (const t of axis) if (inBands(center(t.rect), o.hiddenBands) && !allowed.has(t.text)) out.push(`деление «${t.text}» под меткой (y=${center(t.rect).toFixed(1)})`);
  for (let i = 0; i < axis.length; i++)
    for (let j = i + 1; j < axis.length; j++) if (intersects(axis[i]!.rect, axis[j]!.rect, 0.5)) out.push(`тексты шкалы пересекаются: «${axis[i]!.text}» и «${axis[j]!.text}»`);
  const last = c.lastLabel.rect;
  if (last) {
    for (const t of axis) if (t.text !== c.lastLabel.text && intersects(t.rect, last, 0.5)) out.push(`«${t.text}» закрывает метку цены`);
    if (c.countdownDom && intersects(c.countdownDom, last, 1)) out.push("отсчёт до закрытия закрывает метку цены");
  }
  return out;
}

/** Деления шкалы: тексты шкалы вне полос меток (наши метки, цена и отсчёт лежат в полосах). */
export function tickTexts(c: Census): string[] {
  return c.texts.filter((t) => t.canvas === "priceAxis" && !inBands(center(t.rect), c.overlay.hiddenBands)).map((t) => t.text);
}
