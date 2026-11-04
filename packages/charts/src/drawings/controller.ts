import { INTERACTION } from "../presets";
import type { Candle } from "../types";
import { hitTest, magnetSnap, type Hit, type Projector } from "./geometry";
import { CLICK_SLOP_PX, DEFAULT_STYLE, FIB_LEVELS, HANDLE_PX, HANDLE_TOUCH_PX, pointsNeeded, type Drawing, type DrawingType, type Point } from "./types";

/**
 * Контроллер жестов рисования (план 2A.5, 2A.7; ADR-0009, «Рисование»): постановка точек кликами и касаниями,
 * выбор, перетаскивание точек и тела, магнит к OHLC. Не знает про React и хранилище: сообщает изменения через
 * колбэки, решения о undo/redo принимает хозяин.
 *
 * Как в TradingView:
 * - один рисунок на выбор инструмента: после него инструмент снимается (курсор), пока не включена «серия» (setSeries);
 * - точки ставятся нажатиями: первое — точка A, предпросмотр тянется за указателем, второе — точка B и готово;
 *   мышью можно и нажать-протянуть-отпустить. Одноточечные (линии, заметка) готовы с первого нажатия;
 * - палец: пока точка A не поставлена, жест принадлежит графику (сдвиг, щипок); точку A ставит только касание
 *   без сдвига. После точки A жест пальцем двигает следующую точку (график стоит), касание ставит её;
 * - правка рисунка (хэндлы, тело) рисунков не создаёт; касание мимо снимает выбор, сдвиг графика — нет.
 */
export type ControllerEvents = {
  onCreate: (d: Drawing) => void;
  onMove: (id: string, points: Point[], final: boolean) => void;
  onSelect: (id: string | null) => void;
  onDraft: (d: Drawing | null) => void;
  /** Рисунок завершён; ended — инструмент снят (без «серии», а у измерителя всегда). */
  onDone?: (ended: boolean) => void;
  /** Сколько точек начатого рисунка поставлено (0 — рисунок не начат): подсказка шага в чипе. */
  onStep?: (placed: number) => void;
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

/** Координаты графика: время и цена под точкой панели и обратно (TimeProjector). */
export type DrawProjector = {
  timeAt: (x: number) => number | null;
  priceAt: (y: number) => number | null;
  projector: () => Projector;
};

type Xy = { x: number; y: number };
type PointerLike = Pick<PointerEvent, "clientX" | "clientY" | "pointerId" | "pointerType" | "button" | "stopPropagation" | "preventDefault">;

/**
 * Жест указателя над графиком — от первого нажатия до отпускания всех пальцев.
 * pass — жест отдан графику (сдвиг, щипок, касание мимо); place — постановка точки рисунка; edit — правка рисунка.
 */
type Gesture = { id: number; touch: boolean; start: Xy; moved: boolean; multi: boolean; mode: "pass" | "place" | "edit" };

export class DrawingController {
  tool: DrawingType | null = null;
  /** «Рисовать серию»: инструмент остаётся выбранным после рисунка. */
  series = false;
  private pending: Point[] = [];
  /** Предпросмотр следующей точки рисунка — под указателем. */
  private preview: Point | null = null;
  /** Предпросмотр протянут пальцем: касание рядом с ним подтверждает именно его. */
  private previewDragged = false;
  private previewBefore: { p: Point | null; dragged: boolean } = { p: null, dragged: false };
  private gesture: Gesture | null = null;
  private readonly pointers = new Set<number>();
  private drag: { hit: Hit; start: Xy; origin: Point[] } | null = null;
  /** Касания (touch*) не доходят до LWC: палец двигает точку или рисунок, а не график. */
  private blockTouch = false;
  private readonly handlers: Array<[EventTarget, string, (e: Event) => void]> = [];

  constructor(
    private readonly el: HTMLElement,
    private readonly proj: DrawProjector,
    private readonly opts: ControllerOptions,
    private readonly ev: ControllerEvents,
  ) {
    const on = (t: EventTarget, k: string, fn: (e: Event) => void) => {
      t.addEventListener(k, fn, { capture: true });
      this.handlers.push([t, k, fn]);
    };
    on(el, "pointerdown", (e) => this.down(e as PointerEvent));
    on(el, "pointermove", (e) => this.move(e as PointerEvent));
    // отпускание — на документе: мышь могли отпустить за пределами графика, жест всё равно закончится
    const doc: EventTarget = el.ownerDocument ?? el;
    on(doc, "pointerup", (e) => this.up(e as PointerEvent));
    on(doc, "pointercancel", (e) => this.cancelGesture(e as PointerEvent));
    // LWC сдвигает и масштабирует по touchstart/touchmove, а не по pointer-событиям: их отсекаем отдельно
    for (const k of ["touchstart", "touchmove", "touchend", "touchcancel"]) on(el, k, (e) => this.touch(e as TouchEvent));
    // двойной клик при рисовании — две точки, а не сброс вида
    on(el, "dblclick", (e) => {
      if (this.tool) e.stopPropagation();
    });
  }

  destroy(): void {
    for (const [t, k, fn] of this.handlers) t.removeEventListener(k, fn, { capture: true });
  }

  setTool(tool: DrawingType | null): void {
    this.tool = tool;
    this.reset();
  }

  setSeries(v: boolean): void {
    this.series = v;
  }

  setMagnet(v: boolean): void {
    this.opts.magnet = v;
  }

  /** Поставлено точек начатого рисунка (0 — не начат). */
  get placed(): number {
    return this.pending.length;
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

  /** Бросить начатый рисунок (инструмент не меняется). */
  private reset(): void {
    this.pending = [];
    this.preview = null;
    this.previewDragged = false;
    this.ev.onDraft(null);
    this.ev.onStep?.(0);
  }

  private local(e: PointerLike): Xy {
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

  /** Экранное расстояние от (x, y) до точки рисунка; null — точка за пределами шкал. */
  private distTo(p: Point, x: number, y: number): number | null {
    const pr = this.proj.projector();
    const px = pr.x(p.time), py = pr.y(p.price);
    return px === null || py === null ? null : Math.hypot(px - x, py - y);
  }

  private static consume(e: PointerLike): void {
    e.stopPropagation();
    e.preventDefault();
  }

  private capture(e: PointerLike): void {
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* старые браузеры и синтетические события */
    }
  }

  private touch(e: TouchEvent): void {
    if (this.blockTouch) e.stopPropagation();
    if ((e.type === "touchend" || e.type === "touchcancel") && e.touches.length === 0) this.blockTouch = false;
  }

  private down(e: PointerLike): void {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const touch = e.pointerType === "touch";
    const g0 = this.gesture;
    if (g0 && g0.touch && touch && e.pointerId !== g0.id) {
      // второй палец — щипок: начатый рисунок не трогаем (точка возвращается на место), масштаб — графику
      this.pointers.add(e.pointerId);
      g0.multi = true;
      if (g0.mode === "place") {
        g0.mode = "pass";
        this.blockTouch = false;
        this.restorePreview();
      }
      return;
    }
    // прежний жест не закончился (отпускание потерялось) — начинаем заново
    if (g0?.mode === "edit") this.endDrag(g0);
    this.pointers.clear();
    this.pointers.add(e.pointerId);
    const start = this.local(e);
    const g: Gesture = { id: e.pointerId, touch, start, moved: false, multi: false, mode: "pass" };
    this.gesture = g;
    this.blockTouch = false;
    if (this.tool) {
      // мышью нажатие всегда ставит точку (можно протянуть); пальцем — только когда рисунок уже начат,
      // иначе это жест графика, а точку A ставит касание без сдвига (в up)
      if (!touch || this.pending.length > 0) {
        g.mode = "place";
        this.previewBefore = { p: this.preview, dragged: this.previewDragged };
        this.blockTouch = touch;
        DrawingController.consume(e);
        this.capture(e);
      }
      return;
    }
    const hit = hitTest(this.opts.getDrawings().filter((d) => !d.locked), start.x, start.y, this.proj.projector(), this.tolerance);
    if (!hit) return;
    g.mode = "edit";
    this.blockTouch = touch;
    DrawingController.consume(e);
    const d = this.opts.getDrawings().find((q) => q.id === hit.id)!;
    this.drag = { hit, start, origin: d.points.map((p) => ({ ...p })) };
    this.ev.onSelect(hit.id);
    this.capture(e);
  }

  private move(e: PointerLike): void {
    const { x, y } = this.local(e);
    const g = this.gesture;
    const own = g !== null && e.pointerId === g.id;
    if (own && !g.moved && Math.hypot(x - g.start.x, y - g.start.y) > (g.touch ? INTERACTION.tapSlopPx : CLICK_SLOP_PX)) g.moved = true;
    if (own && g.mode === "edit") {
      DrawingController.consume(e);
      if (g.moved && !g.multi && this.drag) this.dragTo(x, y);
      return;
    }
    if (!this.tool) return;
    if (own && g.mode === "place") {
      DrawingController.consume(e);
      if (!g.moved) return;
      // мышь протянули от первой точки: A — там, где нажали, следующая — под указателем
      if (this.pending.length === 0) {
        const a = this.toPoint(g.start.x, g.start.y);
        if (!a) return;
        this.pending = [a];
        this.ev.onStep?.(1);
      }
      this.previewAt(x, y);
      return;
    }
    // мышь без нажатия: предпросмотр следующей точки за курсором
    if (!g && e.pointerType !== "touch" && this.pending.length > 0) this.previewAt(x, y);
  }

  private up(e: PointerLike): void {
    const g = this.gesture;
    if (!g || !this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (g.mode !== "pass") DrawingController.consume(e);
    if (e.pointerId !== g.id || this.pointers.size > 0) {
      // пальцы отпускают по одному: жест заканчивается с последним, а с двумя пальцами — это не касание
      g.multi = true;
      if (this.pointers.size === 0) this.endGesture(g, null);
      return;
    }
    this.endGesture(g, this.local(e));
  }

  private endGesture(g: Gesture, at: Xy | null): void {
    this.gesture = null;
    if (g.mode === "edit") return this.endDrag(g);
    if (g.multi || !at) return;
    if (g.mode === "place") return this.placeEnd(g, at.x, at.y);
    if (g.moved) return; // сдвиг графика: ни точки, ни снятия выбора
    if (this.tool) this.addPoint(at.x, at.y, g.touch); // палец: касание ставит точку A (одноточечный — сразу рисунок)
    else this.ev.onSelect(null);
  }

  private cancelGesture(e: PointerLike): void {
    const g = this.gesture;
    if (!g || !this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size > 0) return;
    this.gesture = null;
    if (g.mode === "edit") this.endDrag(g);
    else if (g.mode === "place") this.restorePreview();
  }

  private restorePreview(): void {
    this.preview = this.previewBefore.p;
    this.previewDragged = this.previewBefore.dragged;
    this.emitDraft();
  }

  private dragTo(x: number, y: number): void {
    const { hit, start, origin } = this.drag!;
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
  }

  private endDrag(g: Gesture): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    const d = this.opts.getDrawings().find((q) => q.id === drag.hit.id);
    if (g.moved && d) this.ev.onMove(drag.hit.id, d.points, true);
    else if (!g.moved) this.ev.onSelect(drag.hit.id);
  }

  /** Конец жеста постановки точки. */
  private placeEnd(g: Gesture, x: number, y: number): void {
    // мышь: клик — следующая точка; нажали-протянули-отпустили — точка там, где отпустили (A поставлена в move)
    if (!g.touch) return this.addPoint(x, y, false);
    if (g.moved) {
      // палец протянул следующую точку: она остаётся там, где его подняли; поставит её касание
      this.previewDragged = this.preview !== null;
      return;
    }
    // касание рядом с протянутой точкой подтверждает её (палец закрывает точку — без сдвига на пару пикселей)
    const pv = this.preview;
    if (pv && this.previewDragged) {
      const dist = this.distTo(pv, x, y);
      if (dist !== null && dist <= HANDLE_TOUCH_PX) return this.addPoint(x, y, true, pv);
    }
    this.addPoint(x, y, true);
  }

  /** Поставить следующую точку (по умолчанию — под (x, y), с магнитом); последняя завершает рисунок. */
  private addPoint(x: number, y: number, touch: boolean, at?: Point): void {
    if (!this.tool) return;
    const p = at ?? this.toPoint(x, y);
    if (!p) return;
    const last = this.pending[this.pending.length - 1];
    if (last && !at) {
      // второе нажатие в ту же точку — не рисунок нулевой длины (и не двойной клик)
      const dist = this.distTo(last, x, y);
      if (dist !== null && dist <= (touch ? INTERACTION.tapSlopPx : CLICK_SLOP_PX * 2)) return;
    }
    this.pending.push(p);
    this.preview = null;
    this.previewDragged = false;
    if (this.pending.length >= pointsNeeded(this.tool)) return this.finish();
    this.emitDraft();
    this.ev.onStep?.(this.pending.length);
  }

  private finish(): void {
    const d = this.makeDraft(this.pending);
    // один рисунок на выбор инструмента; «серия» оставляет инструмент, измеритель — всегда разовый
    const ended = !this.series || this.tool === "ruler";
    if (ended) this.tool = null;
    this.reset();
    this.ev.onCreate(d);
    this.ev.onDone?.(ended);
  }

  private previewAt(x: number, y: number): void {
    const p = this.toPoint(x, y);
    if (!p) return;
    this.preview = p;
    this.emitDraft();
  }

  private emitDraft(): void {
    if (!this.tool || this.pending.length === 0) return this.ev.onDraft(null);
    this.ev.onDraft(this.makeDraft(this.preview ? [...this.pending, this.preview] : this.pending));
  }

  private makeDraft(points: Point[]): Drawing {
    const type = this.tool ?? "trend";
    const pts = points.slice(0, pointsNeeded(type));
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
