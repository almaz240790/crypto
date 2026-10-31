import type { Candle } from "../types";
import { hitTest, magnetSnap, type Hit } from "./geometry";
import type { TimeProjector } from "./primitive";
import { DEFAULT_STYLE, FIB_LEVELS, HANDLE_PX, HANDLE_TOUCH_PX, pointsNeeded, type Drawing, type DrawingType, type Point } from "./types";

/**
 * Контроллер жестов рисования: режим инструмента (постановка точек по кликам/тапам), выбор,
 * перетаскивание точек и тела, магнит к OHLC. Не знает про React и хранилище: сообщает
 * изменения через колбэки, решения о undo/redo принимает хозяин.
 */
export type ControllerEvents = {
  onCreate: (d: Drawing) => void;
  onMove: (id: string, points: Point[], final: boolean) => void;
  onSelect: (id: string | null) => void;
  onDraft: (d: Drawing | null) => void;
  onDone?: () => void;
};

export type ControllerOptions = {
  getDrawings: () => Drawing[];
  getCandles: () => readonly Candle[];
  tfSeconds: number;
  timeframe: string | null;
  touch: boolean;
  magnet: boolean;
  newId: () => string;
};

export class DrawingController {
  tool: DrawingType | null = null;
  private pending: Point[] = [];
  private drag: { hit: Hit; start: { x: number; y: number }; origin: Point[] } | null = null;
  private moved = false;
  private readonly handlers: Array<[string, (e: PointerEvent | KeyboardEvent) => void]> = [];

  constructor(
    private readonly el: HTMLElement,
    private readonly proj: TimeProjector,
    private readonly opts: ControllerOptions,
    private readonly ev: ControllerEvents,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(k: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(k, fn as EventListener, { capture: true });
      this.handlers.push([k, fn as (e: PointerEvent | KeyboardEvent) => void]);
    };
    on("pointerdown", (e) => this.down(e));
    on("pointermove", (e) => this.move(e));
    on("pointerup", (e) => this.up(e));
    on("pointercancel", () => this.cancelDrag());
  }

  destroy(): void {
    for (const [k, fn] of this.handlers) this.el.removeEventListener(k, fn as EventListener, { capture: true });
  }

  setTool(tool: DrawingType | null): void {
    this.tool = tool;
    this.pending = [];
    this.ev.onDraft(null);
  }

  setMagnet(v: boolean): void {
    this.opts.magnet = v;
  }

  get tolerance(): number {
    return this.opts.touch ? HANDLE_TOUCH_PX / 2 : HANDLE_PX;
  }

  /**
   * Рисунок пользователя под точкой (x, y) панели — та же геометрия, что у выбора и перетаскивания. Разметка
   * графика (наведение и клик по объектам сцены) уступает рисункам: они важнее.
   */
  hitAt(x: number, y: number): string | null {
    return hitTest(this.opts.getDrawings(), x, y, this.proj.projector(), this.tolerance)?.id ?? null;
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private toPoint(x: number, y: number): Point | null {
    const time = this.proj.timeAt(x);
    const price = this.proj.priceAt(y);
    if (time === null || price === null) return null;
    const snapped = this.snapTime(time);
    let p = price;
    if (this.opts.magnet) {
      const c = this.candleAt(snapped);
      const tol = Math.abs((this.proj.priceAt(y + 12) ?? price) - price);
      p = magnetSnap(c, price, tol);
    }
    return { time: snapped, price: p };
  }

  /** Время — к ближайшей свече (или к шагу за правым краем). */
  private snapTime(time: number): number {
    const c = this.opts.getCandles();
    if (c.length === 0) return time;
    const last = c[c.length - 1]!.time;
    if (time > last) return last + Math.round((time - last) / this.opts.tfSeconds) * this.opts.tfSeconds;
    let lo = 0, hi = c.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid]!.time < time) lo = mid + 1;
      else hi = mid;
    }
    const b = c[lo]!.time, a = c[Math.max(0, lo - 1)]!.time;
    return Math.abs(time - a) < Math.abs(b - time) ? a : b;
  }

  private candleAt(time: number): Candle | undefined {
    return this.opts.getCandles().find((c) => c.time === time);
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const { x, y } = this.local(e);
    this.moved = false;
    if (this.tool) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    const hit = hitTest(this.opts.getDrawings().filter((d) => !d.locked), x, y, this.proj.projector(), this.tolerance);
    if (hit) {
      e.stopPropagation();
      e.preventDefault();
      const d = this.opts.getDrawings().find((q) => q.id === hit.id)!;
      this.drag = { hit, start: { x, y }, origin: d.points.map((p) => ({ ...p })) };
      this.ev.onSelect(hit.id);
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {
        /* старые браузеры */
      }
    }
  }

  private move(e: PointerEvent): void {
    const { x, y } = this.local(e);
    if (this.drag) {
      e.stopPropagation();
      e.preventDefault();
      this.moved = true;
      const { hit, start, origin } = this.drag;
      const pts = origin.map((p) => ({ ...p }));
      if (hit.part === "point") {
        const np = this.toPoint(x, y);
        if (np) pts[hit.index] = np;
      } else {
        const t0 = this.proj.timeAt(start.x), t1 = this.proj.timeAt(x);
        const p0 = this.proj.priceAt(start.y), p1 = this.proj.priceAt(y);
        if (t0 !== null && t1 !== null && p0 !== null && p1 !== null) {
          const dt = this.snapTime(t1) - this.snapTime(t0), dp = p1 - p0;
          for (const p of pts) {
            p.time += dt;
            p.price += dp;
          }
        }
      }
      this.ev.onMove(hit.id, pts, false);
      return;
    }
    if (this.tool && this.pending.length > 0) {
      const np = this.toPoint(x, y);
      if (np) this.ev.onDraft(this.makeDraft([...this.pending, np]));
    }
  }

  private up(e: PointerEvent): void {
    const { x, y } = this.local(e);
    if (this.drag) {
      const { hit, origin } = this.drag;
      this.drag = null;
      const d = this.opts.getDrawings().find((q) => q.id === hit.id);
      if (this.moved && d) this.ev.onMove(hit.id, d.points, true);
      else if (!this.moved) this.ev.onSelect(hit.id);
      void origin;
      return;
    }
    if (this.tool) {
      e.stopPropagation();
      e.preventDefault();
      const p = this.toPoint(x, y);
      if (!p) return;
      this.pending.push(p);
      if (this.pending.length >= pointsNeeded(this.tool)) {
        const d = this.makeDraft(this.pending);
        this.pending = [];
        this.ev.onDraft(null);
        this.ev.onCreate(d);
        if (this.tool === "ruler") this.setTool(null);
        this.ev.onDone?.();
      } else {
        this.ev.onDraft(this.makeDraft(this.pending));
      }
      return;
    }
    if (!this.moved) this.ev.onSelect(null);
  }

  private cancelDrag(): void {
    this.drag = null;
  }

  private makeDraft(points: Point[]): Drawing {
    const type = this.tool ?? "trend";
    const pts = points.slice(0, pointsNeeded(type));
    // позиция: третья точка (цель) по умолчанию зеркальна стопу через вход (R:R 1), пока её не поставили
    const color = type === "position-long" ? "up" : type === "position-short" ? "down" : DEFAULT_STYLE.color;
    return {
      id: this.opts.newId(),
      type,
      points: pts,
      style: { ...DEFAULT_STYLE, color },
      locked: false,
      timeframe: this.opts.timeframe,
      levels: type === "fib" ? FIB_LEVELS : undefined,
      updated_at: Date.now(),
    };
  }
}
