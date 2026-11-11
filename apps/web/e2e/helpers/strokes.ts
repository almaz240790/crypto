import type { Page } from "@playwright/test";

/**
 * Перепись линий на холстах графика — как перепись текста (helpers/census.ts), но для обводок. До загрузки страницы
 * перехватываются beginPath / moveTo / lineTo / stroke у CanvasRenderingContext2D: для каждого холста хранятся ломаные,
 * обведённые с последней полной очистки (LWC перед отрисовкой заливает холст целиком с globalCompositeOperation =
 * "copy" или зовёт clearRect), то есть ровно то, что сейчас на экране. Линию серии LWC и линию примитива рисуют одни и
 * те же вызовы холста, поэтому перепись не знает, кто нарисовал линию, — только где она и какого цвета.
 */

export type Stroke = {
  /** Цвет обводки, как его отдаёт холст (приведённый: «#rrggbb» или «rgba(r, g, b, a)»). */
  color: string;
  /** Толщина, CSS px. */
  width: number;
  /** Точки ломаной в координатах панели цены, CSS px. */
  points: [number, number][];
};

/** Ставит перехват до загрузки страницы (addInitScript). */
export async function installStrokes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Pt = [number, number];
    type Rec = { color: string; width: number; pts: Pt[] };
    const byCanvas = new Map<HTMLCanvasElement, Rec[]>();
    const paths = new WeakMap<CanvasRenderingContext2D, Pt[][]>();
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
    const at = (ctx: CanvasRenderingContext2D, x: number, y: number): Pt => {
      const m = ctx.getTransform();
      return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
    };
    const beginPath = proto.beginPath;
    proto.beginPath = function () {
      paths.set(this, []);
      return beginPath.call(this);
    };
    const moveTo = proto.moveTo;
    proto.moveTo = function (x: number, y: number) {
      let subs = paths.get(this);
      if (!subs) paths.set(this, (subs = []));
      subs.push([at(this, x, y)]);
      return moveTo.call(this, x, y);
    };
    const lineTo = proto.lineTo;
    proto.lineTo = function (x: number, y: number) {
      let subs = paths.get(this);
      if (!subs) paths.set(this, (subs = []));
      const p = at(this, x, y);
      const last = subs[subs.length - 1];
      if (last) last.push(p);
      else subs.push([p]);
      return lineTo.call(this, x, y);
    };
    const stroke = proto.stroke;
    proto.stroke = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      // обводка Path2D здесь не нужна: линии серий и примитивов идут через текущий путь холста
      if (args.length === 0) {
        const cv = this.canvas;
        let list = byCanvas.get(cv);
        if (!list) byCanvas.set(cv, (list = []));
        const m = this.getTransform();
        for (const sub of paths.get(this) ?? []) if (sub.length >= 2) list.push({ color: String(this.strokeStyle), width: this.lineWidth * Math.abs(m.d), pts: sub.slice() });
      }
      return (stroke as (...a: unknown[]) => void).apply(this, args);
    } as typeof proto.stroke;
    (window as unknown as { __strokesRaw: () => { canvas: HTMLCanvasElement; recs: Rec[] }[] }).__strokesRaw = () => [...byCanvas.entries()].filter(([cv]) => cv.isConnected).map(([canvas, recs]) => ({ canvas, recs }));
  });
}

/** Ждёт n кадров отрисовки. */
export const frames = (page: Page, n = 2) =>
  page.evaluate(
    (n) =>
      new Promise<void>((res) => {
        let k = 0;
        const step = () => (++k >= n ? res() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );

/**
 * Ломаные, нарисованные сейчас на панели цены (холсты в области свечей основной панели), не короче minPoints точек:
 * линия индикатора — десятки точек, линии сетки и перекрестия — по две.
 */
export async function paneStrokes(page: Page, minPoints = 10): Promise<Stroke[]> {
  await frames(page, 2);
  return page.evaluate((minPoints) => {
    type Rec = { color: string; width: number; pts: [number, number][] };
    type Chart = { panes(): { getHTMLElement(): HTMLElement }[]; paneSize(i?: number): { width: number; height: number } };
    const el = document.querySelector('[data-testid="terminal"]') as HTMLElement & { __chart: Chart };
    const chart = el.__chart;
    const row = chart.panes()[0]!.getHTMLElement().getBoundingClientRect();
    const size = chart.paneSize(0);
    const raw = (window as unknown as { __strokesRaw: () => { canvas: HTMLCanvasElement; recs: Rec[] }[] }).__strokesRaw();
    const out: { color: string; width: number; points: [number, number][] }[] = [];
    for (const { canvas, recs } of raw) {
      if (!el.contains(canvas)) continue;
      const cr = canvas.getBoundingClientRect();
      if (cr.width === 0 || cr.height === 0) continue;
      const cx = cr.left + cr.width / 2;
      const cy = cr.top + cr.height / 2;
      // только холсты области свечей основной панели (не шкалы и не панели индикаторов)
      if (!(cy >= row.top && cy <= row.top + size.height && cx <= row.left + size.width)) continue;
      const kx = canvas.width / cr.width;
      const ky = canvas.height / cr.height;
      for (const r of recs) {
        if (r.pts.length < minPoints) continue;
        out.push({ color: r.color, width: r.width / ky, points: r.pts.map(([x, y]) => [x / kx + cr.left - row.left, y / ky + cr.top - row.top] as [number, number]) });
      }
    }
    return out;
  }, minPoints);
}
