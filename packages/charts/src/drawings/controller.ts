import { INTERACTION } from "../presets";
import type { Candle } from "../types";
import { hitTest, magnetSnap, type Hit, type Projector } from "./geometry";
import { POSITION_PARTS, POSITION_PART_INDEX, atrAt, positionDir, positionFromEntry, setPositionEnd, setPositionPrice } from "./position";
import { CLICK_SLOP_PX, DBLCLICK_MS, DBLCLICK_SLOP_PX, DEFAULT_STYLE, FIB_LEVELS, HANDLE_PX, HANDLE_TOUCH_PX, POSITION_BARS, POSITION_EDGE_PX, POSITION_KNOB_TOUCH_PX, POSITION_MIN_PX, WIDE_TYPES, isPosition, pointsNeeded, type Drawing, type DrawingType, type Point } from "./types";

/**
 * Контроллер жестов рисования (план 2A.5, 2A.7; ADR-0009, «Рисование»): постановка точек кликами и касаниями,
 * выбор, перетаскивание точек и тела, магнит к OHLC. Не знает про React и хранилище: сообщает изменения через
 * колбэки, решения о undo/redo принимает хозяин.
 *
 * Как в TradingView:
 * - один рисунок на выбор инструмента: после него инструмент снимается (курсор), пока не включена «серия» (setSeries);
 * - точки ставятся нажатиями: первое — точка A, предпросмотр тянется за указателем, второе — точка B и готово;
 *   мышью можно и нажать-протянуть-отпустить. Одноточечные (линии, заметка) готовы с первого нажатия;
 * - палец (и перо — у него те же touch-события): пока точка A не поставлена, жест принадлежит графику (сдвиг,
 *   щипок); точку A ставит только касание без сдвига. После точки A жест пальцем двигает следующую точку (график
 *   стоит), касание ставит её;
 * - точки ставятся только в области свечей основной панели: нажатие на шкалу цены или времени, в другой панели —
 *   жест графика (масштаб шкалы, прокрутка);
 * - правка рисунка (хэндлы, тело) рисунков не создаёт. Мышь правит любой рисунок под курсором; палец — только
 *   выбранный: по невыбранному касание выбирает, сдвиг и щипок принадлежат графику. Касание мимо снимает выбор,
 *   сдвиг графика — нет;
 * - позиция Long/Short — одним нажатием на цену входа: стоп по ATR(14), цель 1:2, ширина ~30 свечей (position.ts).
 *   Правка: ручки входа, стопа и цели двигают свою цену (по вертикали, не за вход), правый край — длительность,
 *   тело — всю позицию.
 */
export type ControllerEvents = {
  onCreate: (d: Drawing) => void;
  /**
   * Перетаскивание рисунка: final = false — промежуточное положение (без шага отмены); final = true — конец, origin —
   * точки до перетаскивания (шаг отмены пишется от них).
   */
  onMove: (id: string, points: Point[], final: boolean, origin?: Point[]) => void;
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
  /** Длительность бара сейчас (смена таймфрейма без пересоздания контроллера); без неё — tfSeconds. */
  getTfSeconds?: () => number;
  /** Шаг цены инструмента: стоп и цель позиции — по нему. */
  getTick?: () => number | null;
  timeframe: string | null;
  touch: boolean;
  magnet: boolean;
  newId: () => string;
  /** Выбранный рисунок: пальцем правится только он. */
  getSelectedId?: () => string | null;
  /** Часы, мс (по умолчанию performance.now): двойной клик сразу после рисунка. */
  now?: () => number;
};

/** Координаты графика: время и цена под точкой панели и обратно (TimeProjector). */
export type DrawProjector = {
  timeAt: (x: number) => number | null;
  priceAt: (y: number) => number | null;
  projector: () => Projector;
};

type Xy = { x: number; y: number };
type PointerLike = Pick<PointerEvent, "clientX" | "clientY" | "pointerId" | "pointerType" | "button" | "stopPropagation" | "preventDefault">;
type ClientXy = Pick<MouseEvent, "clientX" | "clientY">;

/**
 * Жест указателя над графиком — от первого нажатия до отпускания всех пальцев.
 * pass — жест отдан графику (сдвиг, щипок, касание мимо); place — постановка точки рисунка; edit — правка рисунка.
 * touch — палец или перо; plot — начат в области свечей основной панели (не на шкалах и не в другой панели).
 */
type Gesture = { id: number; touch: boolean; start: Xy; moved: boolean; multi: boolean; plot: boolean; mode: "pass" | "place" | "edit" };

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
  /** Место последней поставленной точки на экране — до магнита и привязки ко времени: «то же место» сравнивается с ним. */
  private lastRaw: Xy | null = null;
  /** Последнее нажатие или отпускание постановки точки: двойной клик рядом с ним — рисование, а не сброс вида. */
  private lastPlace: { at: number; x: number; y: number } | null = null;
  private gesture: Gesture | null = null;
  private readonly pointers = new Set<number>();
  /** Перетаскивание: last — последнее положение, отданное onMove (хозяин мог ещё не перерисоваться). */
  private drag: { hit: Hit; type: DrawingType; start: Xy; origin: Point[]; last: Point[] | null } | null = null;
  /** ATR по свечам графика — кэш на тот же буфер (позиция одним нажатием). */
  private atrCache: { candles: readonly Candle[]; n: number; last: number; time: number; atr: number | null } | null = null;
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
    // двойной клик при рисовании — две точки, а не сброс вида; в том числе тот, чьё первое отпускание завершило
    // рисунок и сняло инструмент
    on(el, "dblclick", (e) => {
      if (this.tool || this.placedJustNow(e as MouseEvent)) e.stopPropagation();
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

  /** Ручки позиции: под пальцем — цель 44 px. */
  get knobTolerance(): number {
    return this.opts.touch ? POSITION_KNOB_TOUCH_PX : HANDLE_PX;
  }

  private get tf(): number {
    return this.opts.getTfSeconds?.() ?? this.opts.tfSeconds;
  }

  /**
   * Рисунок пользователя под точкой (x, y) панели — та же геометрия, что у выбора и перетаскивания. Разметка
   * графика (наведение и клик по объектам сцены) уступает рисункам: они важнее.
   */
  hitAt(x: number, y: number): string | null {
    return hitTest(this.opts.getDrawings(), x, y, this.proj.projector(), this.tolerance, this.knobTolerance)?.id ?? null;
  }

  /** Бросить начатый рисунок (инструмент не меняется). */
  private reset(): void {
    this.pending = [];
    this.lastRaw = null;
    this.preview = null;
    this.previewDragged = false;
    this.ev.onDraft(null);
    this.ev.onStep?.(0);
  }

  private local(e: ClientXy): Xy {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Точка — в области свечей основной панели (левее шкалы цены, выше шкалы времени и других панелей). */
  private inPlot(p: Xy): boolean {
    const pr = this.proj.projector();
    return p.x >= 0 && p.y >= 0 && p.x < pr.width && p.y < pr.height;
  }

  private clock(): number {
    return this.opts.now ? this.opts.now() : performance.now();
  }

  private markPlace(p: Xy): void {
    this.lastPlace = { at: this.clock(), x: p.x, y: p.y };
  }

  /** dblclick пришёл сразу после постановки точки рядом с ней. */
  private placedJustNow(e: ClientXy): boolean {
    const lp = this.lastPlace;
    if (!lp || this.clock() - lp.at > DBLCLICK_MS) return false;
    const { x, y } = this.local(e);
    return Math.hypot(x - lp.x, y - lp.y) <= DBLCLICK_SLOP_PX;
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
    if (time > last) return last + Math.round((time - last) / this.tf) * this.tf;
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
    // перо — как палец: iPad (Apple Pencil) и Android (S Pen) шлют для него и touch-события, которые LWC сдвигает
    const touch = e.pointerType !== "mouse";
    const g0 = this.gesture;
    if (g0 && g0.touch && touch && e.pointerId !== g0.id) {
      // второй палец — щипок, масштаб — графику: начатый рисунок не трогаем (точка возвращается на место), правка
      // рисунка под первым пальцем отменяется (рисунок — на место, без шага отмены)
      this.pointers.add(e.pointerId);
      g0.multi = true;
      if (g0.mode === "place") {
        g0.mode = "pass";
        this.blockTouch = false;
        this.restorePreview();
      } else if (g0.mode === "edit") {
        g0.mode = "pass";
        this.blockTouch = false;
        this.abortDrag(g0);
      }
      return;
    }
    // прежний жест не закончился (отпускание потерялось) — начинаем заново
    if (g0?.mode === "edit") this.endDrag(g0);
    this.pointers.clear();
    this.pointers.add(e.pointerId);
    const start = this.local(e);
    const g: Gesture = { id: e.pointerId, touch, start, moved: false, multi: false, plot: this.inPlot(start), mode: "pass" };
    this.gesture = g;
    this.blockTouch = false;
    // шкалы цены и времени, другие панели — жесты графика (масштаб шкалы, прокрутка): ни точек, ни правки
    if (!g.plot) return;
    if (this.tool) {
      // мышью нажатие всегда ставит точку (можно протянуть); пальцем — только когда рисунок уже начат,
      // иначе это жест графика, а точку A ставит касание без сдвига (в up)
      if (!touch || this.pending.length > 0) {
        g.mode = "place";
        this.previewBefore = { p: this.preview, dragged: this.previewDragged };
        this.blockTouch = touch;
        this.markPlace(start);
        DrawingController.consume(e);
        this.capture(e);
      }
      return;
    }
    const hit = this.editHit(start, touch);
    if (!hit) return;
    g.mode = "edit";
    this.blockTouch = touch;
    DrawingController.consume(e);
    const d = this.opts.getDrawings().find((q) => q.id === hit.id)!;
    this.drag = { hit, type: d.type, start, origin: d.points.map((p) => ({ ...p })), last: null };
    this.ev.onSelect(hit.id);
    this.capture(e);
  }

  /** Незаблокированные рисунки под точкой: мышью правится любой, пальцем и пером — только выбранный. */
  private editHit(p: Xy, touch: boolean): Hit | null {
    const selected = this.opts.getSelectedId?.() ?? null;
    const ds = this.opts.getDrawings().filter((d) => !d.locked && (!touch || d.id === selected));
    return hitTest(ds, p.x, p.y, this.proj.projector(), this.tolerance, this.knobTolerance);
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
      // мышь протянули от первой точки: A — там, где нажали, следующая — под указателем; одноточечный рисунок этим
      // уже готов (точка — где нажали), отпускание его завершит
      if (this.pending.length === 0) {
        const a = this.toPoint(g.start.x, g.start.y);
        if (!a) return;
        this.pending = [a];
        this.lastRaw = g.start;
        if (pointsNeeded(this.tool) > 1) this.ev.onStep?.(1);
      }
      this.previewAt(x, y);
      return;
    }
    // мышь без нажатия: предпросмотр следующей точки за курсором (над шкалами — не ведём)
    if (!g && e.pointerType === "mouse" && this.pending.length > 0 && this.inPlot({ x, y })) this.previewAt(x, y);
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
    if (this.tool) {
      // палец: касание ставит точку A (одноточечный — сразу рисунок); на шкалах и в других панелях — нет
      if (!g.plot) return;
      this.markPlace(at);
      return this.addPoint(at.x, at.y, g.touch);
    }
    // касание по невыбранному рисунку выбирает его (правится пальцем, когда выбран); мимо — снять выбор
    const hit = g.touch && g.plot ? hitTest(this.opts.getDrawings().filter((d) => !d.locked), at.x, at.y, this.proj.projector(), this.tolerance, this.knobTolerance) : null;
    this.ev.onSelect(hit?.id ?? null);
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
    const { hit, type, start, origin } = this.drag!;
    let pts = origin.map((p) => ({ ...p }));
    if (hit.part === "point" && isPosition(type)) {
      // ручка позиции: вход, стоп, цель — только цена (по вертикали, с магнитом); правый край — только время
      // смещение от места нажатия (не «прыжок» ручки под палец: цель касания — 44 px)
      const part = POSITION_PARTS[hit.index];
      const pr = this.proj.projector();
      if (part === "end") {
        const x0 = pr.x(origin[1]!.time);
        const t = this.proj.timeAt((x0 ?? start.x) + x - start.x);
        if (t !== null) pts = setPositionEnd({ type, points: origin }, this.snapTime(t), this.tf);
      } else if (part) {
        const y0 = pr.y(origin[POSITION_PART_INDEX[part]]!.price);
        const at = this.toPoint(x, (y0 ?? start.y) + y - start.y);
        if (at) pts = setPositionPrice({ type, points: origin }, part, at.price, this.opts.getTick?.() ?? null);
      }
    } else if (hit.part === "point") {
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
    this.drag!.last = pts;
    this.ev.onMove(hit.id, pts, false);
  }

  private endDrag(g: Gesture): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    // конец — последнее показанное положение (рисунки хозяина могли ещё не обновиться после последнего сдвига)
    const d = this.opts.getDrawings().find((q) => q.id === drag.hit.id);
    const points = drag.last ?? d?.points;
    if (g.moved && d && points) this.ev.onMove(drag.hit.id, points, true, drag.origin);
    else if (!g.moved) this.ev.onSelect(drag.hit.id);
  }

  /** Правка прервана (второй палец — щипок графика): рисунок — на место, без шага отмены. */
  private abortDrag(g: Gesture): void {
    const drag = this.drag;
    this.drag = null;
    if (drag && g.moved) this.ev.onMove(drag.hit.id, drag.origin, false);
  }

  /** Конец жеста постановки точки. */
  private placeEnd(g: Gesture, x: number, y: number): void {
    this.markPlace({ x, y });
    if (!g.touch) {
      // мышь: клик — следующая точка; нажали-протянули-отпустили — точка там, где отпустили (A поставлена в move);
      // одноточечный, протянутый на пару пикселей (дрожь руки), готов уже с A — завершить, а не ждать второго клика
      if (this.tool && this.pending.length >= pointsNeeded(this.tool)) return this.finish();
      return this.addPoint(x, y, false);
    }
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
    if (this.sameAsLast(p, x, y, touch, !at)) return;
    this.pending.push(p);
    this.lastRaw = { x, y };
    this.preview = null;
    this.previewDragged = false;
    if (this.pending.length >= pointsNeeded(this.tool)) return this.finish();
    this.emitDraft();
    this.ev.onStep?.(this.pending.length);
  }

  /**
   * Нажатие не даёт следующую точку (рисунок нулевой длины, двойной клик или двойное касание): та же точка, что
   * предыдущая (магнит и привязка ко времени свели их); у Фибоначчи и прямоугольника — та же свеча (нулевая
   * ширина); то же место на экране — сравнение с местом прошлого нажатия до магнита (магнит уводит точку на 12 px,
   * дальше допуска) и с самой точкой.
   */
  private sameAsLast(p: Point, x: number, y: number, touch: boolean, checkPlace: boolean): boolean {
    const last = this.pending[this.pending.length - 1];
    if (!last || !this.tool) return false;
    if (last.time === p.time && last.price === p.price) return true;
    if (this.pending.length === 1 && WIDE_TYPES.includes(this.tool) && last.time === p.time) return true;
    if (!checkPlace) return false;
    const slop = touch ? INTERACTION.tapSlopPx : CLICK_SLOP_PX * 2;
    if (this.lastRaw && Math.hypot(x - this.lastRaw.x, y - this.lastRaw.y) <= slop) return true;
    const dist = this.distTo(last, x, y);
    return dist !== null && dist <= slop;
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

  /** ATR(14) на свече входа — по свечам графика, с кэшем на тот же буфер и время. */
  private atrFor(time: number): number | null {
    const candles = this.opts.getCandles();
    const last = candles[candles.length - 1]?.time ?? -1;
    const c = this.atrCache;
    if (c && c.candles === candles && c.n === candles.length && c.last === last && c.time === time) return c.atr;
    const atr = atrAt(candles, time);
    this.atrCache = { candles, n: candles.length, last, time, atr };
    return atr;
  }

  /**
   * Правый край новой позиции: POSITION_BARS свечей правее свечи входа, но не дальше правого края области свечей
   * (POSITION_EDGE_PX) — ручка края и подписи на экране; не уже POSITION_MIN_PX и не меньше одной свечи.
   */
  private positionEnd(entry: Point): number {
    const c = this.opts.getCandles();
    const tf = this.tf;
    let end = entry.time + POSITION_BARS * tf;
    if (c.length > 0) {
      const n = c.length;
      const lastT = c[n - 1]!.time;
      let i = n - 1 + Math.round((entry.time - lastT) / tf);
      if (entry.time <= lastT) {
        let lo = 0, hi = n - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (c[mid]!.time < entry.time) lo = mid + 1;
          else hi = mid;
        }
        i = lo;
      }
      const j = i + POSITION_BARS;
      end = j <= n - 1 ? c[j]!.time : lastT + (j - (n - 1)) * tf;
    }
    const pr = this.proj.projector();
    const x0 = pr.x(entry.time), x1 = pr.x(end);
    const limit = pr.width - POSITION_EDGE_PX;
    if (x0 !== null && x1 !== null && x1 > limit) {
      const t = this.proj.timeAt(Math.max(limit, x0 + POSITION_MIN_PX));
      if (t !== null) end = this.snapTime(t);
    }
    return Math.max(end, entry.time + tf);
  }

  private makeDraft(points: Point[]): Drawing {
    const type = this.tool ?? "trend";
    let pts = points.slice(0, pointsNeeded(type));
    // позиция одним нажатием: стоп по ATR, цель 1:2, ширина ~30 свечей
    if (isPosition(type) && pts[0]) pts = positionFromEntry(positionDir(type), pts[0], { atr: this.atrFor(pts[0].time), end: this.positionEnd(pts[0]), tick: this.opts.getTick?.() ?? null });
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
