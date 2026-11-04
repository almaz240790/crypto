import { describe, expect, it } from "vitest";
import { DrawingController, type DrawProjector } from "../drawings/controller";
import { CLICK_SLOP_PX, DBLCLICK_MS, DEFAULT_STYLE, HANDLE_TOUCH_PX, type Drawing } from "../drawings/types";
import { INTERACTION } from "../presets";
import { bars, H, T0 } from "./fakes/lwc";

/**
 * Автомат жестов рисования (ADR-0009, «Рисование»): один рисунок на выбор инструмента, «серия», клик-клик и
 * нажать-протянуть мышью, касание-касание пальцем с протягиванием между ними, отмена, сдвиг и щипок графика
 * рисунков не создают, правка рисунка — тоже, магнит. Перо — как палец; шкалы и другие панели — жесты графика.
 */

type Listener = (e: Event) => void;
class FakeTarget {
  readonly listeners = new Map<string, Listener[]>();
  addEventListener(k: string, fn: Listener): void {
    this.listeners.set(k, [...(this.listeners.get(k) ?? []), fn]);
  }
  removeEventListener(k: string, fn: Listener): void {
    this.listeners.set(k, (this.listeners.get(k) ?? []).filter((f) => f !== fn));
  }
  dispatch(k: string, e: object): void {
    for (const fn of this.listeners.get(k) ?? []) fn(e as Event);
  }
}

type FakeEvent = { clientX: number; clientY: number; pointerId: number; pointerType: string; button: number; stopped: boolean; prevented: boolean; stopPropagation(): void; preventDefault(): void };
const pev = (x: number, y: number, pointerType: string, pointerId: number, button = 0): FakeEvent => ({
  clientX: x,
  clientY: y,
  pointerId,
  pointerType,
  button,
  stopped: false,
  prevented: false,
  stopPropagation() {
    this.stopped = true;
  },
  preventDefault() {
    this.prevented = true;
  },
});

/** Шкалы: 10 px на свечу 4ч от T0, 4 px на единицу цены от 200 вниз. */
const PX_BAR = 10;
const PX_PRICE = 4;
const TOP = 200;
const xOf = (time: number) => ((time - T0) / H) * PX_BAR;
const yOf = (price: number) => (TOP - price) * PX_PRICE;
/** Область свечей основной панели: правее — шкала цены, ниже — шкала времени и другие панели. */
const PLOT_W = 1000;
const PLOT_H = 800;
const projOf = (pxBar: number): DrawProjector => ({
  timeAt: (x) => T0 + (x / pxBar) * H,
  priceAt: (y) => TOP - y / PX_PRICE,
  projector: () => ({ x: (time) => ((time - T0) / H) * pxBar, y: yOf, width: PLOT_W, height: PLOT_H }),
});
const CANDLES = bars(100);

function setup(o: { magnet?: boolean; items?: Drawing[]; coarse?: boolean; pxBar?: number } = {}) {
  const doc = new FakeTarget();
  const el = Object.assign(new FakeTarget(), { ownerDocument: doc, getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture: () => undefined });
  let items: Drawing[] = o.items ?? [];
  let n = 0;
  let selected: string | null = null;
  const clock = { now: 0 };
  const log = { created: [] as Drawing[], selected: [] as (string | null)[], drafts: [] as (Drawing | null)[], steps: [] as number[], done: [] as boolean[], moves: [] as { id: string; final: boolean; points: Drawing["points"]; origin?: Drawing["points"] }[] };
  const ctrl = new DrawingController(
    el as unknown as HTMLElement,
    projOf(o.pxBar ?? PX_BAR),
    { getDrawings: () => items, getCandles: () => CANDLES, tfSeconds: H, timeframe: null, touch: o.coarse ?? false, magnet: o.magnet ?? false, newId: () => `n${++n}`, getSelectedId: () => selected, now: () => clock.now },
    {
      onCreate: (d) => {
        log.created.push(d);
        items = [...items, d];
        // как useDrawings: новый рисунок выбран
        selected = d.id;
      },
      onMove: (id, points, final, origin) => {
        log.moves.push({ id, final, points, origin });
        items = items.map((d) => (d.id === id ? { ...d, points } : d));
      },
      onSelect: (id) => {
        log.selected.push(id);
        selected = id;
      },
      onDraft: (d) => log.drafts.push(d),
      onDone: (ended) => log.done.push(ended),
      onStep: (k) => log.steps.push(k),
    },
  );
  const fire = (k: string, x: number, y: number, type: string, id: number, button = 0) => {
    const e = pev(x, y, type, id, button);
    // отпускание контроллер слушает на документе (мышь могли отпустить за графиком)
    (k === "pointerup" || k === "pointercancel" ? doc : el).dispatch(k, e);
    return e;
  };
  const pointer = (type: "mouse" | "touch" | "pen", id = 1) => ({
    down: (x: number, y: number) => fire("pointerdown", x, y, type, id),
    move: (x: number, y: number) => fire("pointermove", x, y, type, id),
    up: (x: number, y: number) => fire("pointerup", x, y, type, id),
    cancel: (x: number, y: number) => fire("pointercancel", x, y, type, id),
    tap(x: number, y: number) {
      const d = this.down(x, y);
      const u = this.up(x, y);
      return { d, u };
    },
    drag(x1: number, y1: number, x2: number, y2: number, steps = 5) {
      const d = this.down(x1, y1);
      const moves = Array.from({ length: steps }, (_, i) => this.move(x1 + ((x2 - x1) * (i + 1)) / steps, y1 + ((y2 - y1) * (i + 1)) / steps));
      const u = this.up(x2, y2);
      return { d, moves, u };
    },
  });
  /** touchstart…touchend — дошли ли они до LWC (не остановлены контроллером). */
  const touchReachesChart = (k: string, touches = 0) => {
    let stopped = false;
    el.dispatch(k, { type: k, touches: { length: touches }, stopPropagation: () => (stopped = true) });
    return !stopped;
  };
  const lastDraft = () => log.drafts[log.drafts.length - 1] ?? null;
  /** Двойной клик дошёл до графика (ChartController сбросил бы вид)? */
  const dblReachesChart = (x: number, y: number) => {
    let stopped = false;
    el.dispatch("dblclick", { clientX: x, clientY: y, stopPropagation: () => (stopped = true) });
    return !stopped;
  };
  return { ctrl, el, doc, log, items: () => items, selected: () => selected, clock, mouse: pointer("mouse"), finger: pointer("touch"), pen: pointer("pen"), pointer, touchReachesChart, dblReachesChart, lastDraft, fire };
}

/** Точка на свече i с ценой p — в пикселях. */
const at = (i: number, p: number) => [xOf(T0 + i * H), yOf(p)] as const;

describe("один рисунок на выбор инструмента и «серия»", () => {
  it("после рисунка инструмент снят: дальнейшие клики, протягивания и касания рисунков не создают", () => {
    const s = setup();
    s.ctrl.setTool("fib");
    s.mouse.tap(...at(10, 120));
    s.mouse.tap(...at(30, 90));
    expect(s.log.created).toHaveLength(1);
    expect(s.log.created[0]!.type).toBe("fib");
    expect(s.log.done).toEqual([true]);
    expect(s.ctrl.tool).toBeNull();
    // раньше инструмент оставался выбранным и каждые два жеста давали новый рисунок
    s.mouse.tap(...at(40, 110));
    s.mouse.drag(...at(50, 110), ...at(70, 95));
    s.mouse.tap(...at(60, 80));
    s.finger.drag(...at(50, 110), ...at(70, 95));
    s.finger.tap(...at(55, 100));
    s.finger.tap(...at(65, 100));
    expect(s.log.created).toHaveLength(1);
    expect(s.log.steps.filter((k) => k > 0)).toEqual([1]);
  });

  it("«серия»: инструмент остаётся, рисунки один за другим; выключили — следующий рисунок последний", () => {
    const s = setup();
    s.ctrl.setSeries(true);
    s.ctrl.setTool("trend");
    for (const i of [10, 30, 50]) {
      s.mouse.tap(...at(i, 120));
      s.mouse.tap(...at(i + 10, 100));
    }
    expect(s.log.created.map((d) => d.type)).toEqual(["trend", "trend", "trend"]);
    expect(s.log.done).toEqual([false, false, false]);
    expect(s.ctrl.tool).toBe("trend");
    s.ctrl.setSeries(false);
    s.mouse.tap(...at(70, 120));
    s.mouse.tap(...at(80, 100));
    expect(s.log.done).toEqual([false, false, false, true]);
    expect(s.ctrl.tool).toBeNull();
  });

  it("измеритель — всегда разовый, даже в «серии»", () => {
    const s = setup();
    s.ctrl.setSeries(true);
    s.ctrl.setTool("ruler");
    s.mouse.tap(...at(10, 120));
    s.mouse.tap(...at(20, 110));
    expect(s.log.done).toEqual([true]);
    expect(s.ctrl.tool).toBeNull();
  });

  it("одноточечные (горизонтальная линия, заметка) готовы с первого нажатия — мышью и пальцем", () => {
    const s = setup();
    s.ctrl.setTool("hline");
    s.mouse.tap(...at(10, 120));
    expect(s.log.created.map((d) => d.type)).toEqual(["hline"]);
    s.ctrl.setTool("note");
    s.finger.tap(...at(20, 110));
    expect(s.log.created.map((d) => d.type)).toEqual(["hline", "note"]);
    expect(s.ctrl.tool).toBeNull();
  });
});

describe("мышь: клик-клик и нажать-протянуть-отпустить", () => {
  it("первый клик — точка A, предпросмотр за курсором, второй клик — точка B; график не сдвигается", () => {
    const s = setup();
    s.ctrl.setTool("trend");
    const a = s.mouse.tap(...at(10, 120));
    expect(a.d.stopped && a.d.prevented).toBe(true);
    expect(s.log.steps.at(-1)).toBe(1);
    expect(s.log.created).toHaveLength(0);
    // наведение без нажатия: предпросмотр второй точки за курсором
    s.mouse.move(...at(25, 100));
    expect(s.lastDraft()!.points).toEqual([{ time: T0 + 10 * H, price: 120 }, { time: T0 + 25 * H, price: 100 }]);
    s.mouse.tap(...at(30, 90));
    expect(s.log.created[0]!.points).toEqual([{ time: T0 + 10 * H, price: 120 }, { time: T0 + 30 * H, price: 90 }]);
    expect(s.lastDraft()).toBeNull();
    expect(s.log.steps.at(-1)).toBe(0);
  });

  it("нажать в A, протянуть и отпустить в B — рисунок готов; нажатие поглощено (график не сдвигается)", () => {
    const s = setup();
    s.ctrl.setTool("fib");
    const g = s.mouse.drag(...at(10, 120), ...at(40, 90));
    expect(g.d.stopped).toBe(true);
    expect(g.moves.every((m) => m.stopped)).toBe(true);
    expect(s.log.created).toHaveLength(1);
    expect(s.log.created[0]!.points).toEqual([{ time: T0 + 10 * H, price: 120 }, { time: T0 + 40 * H, price: 90 }]);
  });

  it("второй клик в ту же точку не даёт рисунок нулевой длины; двойной клик при рисовании не сбрасывает вид", () => {
    const s = setup();
    s.ctrl.setTool("trend");
    s.mouse.tap(...at(10, 120));
    s.mouse.tap(at(10, 120)[0] + CLICK_SLOP_PX, at(10, 120)[1]);
    expect(s.log.created).toHaveLength(0);
    expect(s.dblReachesChart(...at(10, 120))).toBe(false);
    s.mouse.tap(...at(20, 100));
    expect(s.log.created).toHaveLength(1);
    // инструмент снят; двойной клик позже или в другом месте — снова сброс вида
    s.clock.now += DBLCLICK_MS + 1;
    expect(s.dblReachesChart(...at(20, 100))).toBe(true);
  });

  it("канал: третья точка — как раньше (A, B, затем ширина)", () => {
    const s = setup();
    s.ctrl.setTool("channel");
    s.mouse.tap(...at(10, 120));
    s.mouse.tap(...at(40, 130));
    expect(s.log.steps.at(-1)).toBe(2);
    expect(s.log.created).toHaveLength(0);
    s.mouse.move(...at(20, 110));
    expect(s.lastDraft()!.points).toHaveLength(3);
    s.mouse.tap(...at(20, 110));
    expect(s.log.created[0]!.points).toHaveLength(3);
  });

  it("правая кнопка мыши точек не ставит", () => {
    const s = setup();
    s.ctrl.setTool("hline");
    s.fire("pointerdown", ...at(10, 120), "mouse", 1, 2);
    s.fire("pointerup", ...at(10, 120), "mouse", 1, 2);
    expect(s.log.created).toHaveLength(0);
  });

  it("мышь отпустили за пределами графика — жест закончен, следующее нажатие начинает новый", () => {
    const s = setup();
    s.ctrl.setTool("trend");
    s.mouse.down(...at(10, 120));
    // отпускание потерялось (окно потеряло фокус): новое нажатие той же мышью — новый жест
    s.mouse.down(...at(10, 120));
    s.mouse.up(...at(10, 120));
    expect(s.log.steps.at(-1)).toBe(1);
    s.mouse.down(...at(30, 100));
    s.mouse.up(5000, 5000);
    expect(s.log.created).toHaveLength(1);
  });
});

describe("палец: касание-касание с протягиванием между ними", () => {
  it("касание — A; протягивание двигает B без завершения (график стоит); касание — B и готово", () => {
    const s = setup({ coarse: true });
    s.ctrl.setTool("fib");
    s.finger.tap(...at(10, 120));
    expect(s.log.steps.at(-1)).toBe(1);
    expect(s.lastDraft()!.points).toEqual([{ time: T0 + 10 * H, price: 120 }]);
    // протягиваем: точка B идёт за пальцем, касания до LWC не доходят, рисунок не завершён
    const d = s.finger.down(...at(20, 110));
    expect(d.stopped).toBe(true);
    expect(s.touchReachesChart("touchstart", 1)).toBe(false);
    for (const i of [24, 28, 32]) s.finger.move(...at(i, 105));
    expect(s.touchReachesChart("touchmove", 1)).toBe(false);
    s.finger.up(...at(32, 105));
    expect(s.touchReachesChart("touchend", 0)).toBe(false);
    expect(s.lastDraft()!.points[1]).toEqual({ time: T0 + 32 * H, price: 105 });
    expect(s.log.created).toHaveLength(0);
    // следующий жест (касание мимо протянутой точки) — B там, где коснулись
    s.finger.tap(...at(45, 95));
    expect(s.log.created).toHaveLength(1);
    expect(s.log.created[0]!.points[1]).toEqual({ time: T0 + 45 * H, price: 95 });
    expect(s.ctrl.tool).toBeNull();
    // после жеста (последний палец поднят) касания снова доходят до графика
    expect(s.touchReachesChart("touchend", 0)).toBe(false);
    expect(s.touchReachesChart("touchstart", 1)).toBe(true);
  });

  it("касание рядом с протянутой точкой подтверждает её без сдвига", () => {
    const s = setup({ coarse: true });
    s.ctrl.setTool("trend");
    s.finger.tap(...at(10, 120));
    s.finger.drag(...at(20, 110), ...at(33, 101));
    const [x, y] = at(33, 101);
    s.finger.tap(x + HANDLE_TOUCH_PX / 2, y - 6);
    expect(s.log.created[0]!.points[1]).toEqual({ time: T0 + 33 * H, price: 101 });
  });

  it("до точки A сдвиг и щипок принадлежат графику и рисунков не создают", () => {
    const s = setup({ coarse: true });
    s.ctrl.setTool("fib");
    const pan = s.finger.drag(...at(10, 120), ...at(40, 120));
    expect(pan.d.stopped).toBe(false);
    expect(pan.moves.some((m) => m.stopped)).toBe(false);
    expect(s.touchReachesChart("touchstart", 1)).toBe(true);
    expect(s.touchReachesChart("touchmove", 1)).toBe(true);
    // щипок двумя пальцами
    const f1 = s.pointer("touch", 1), f2 = s.pointer("touch", 2);
    f1.down(...at(30, 110));
    f2.down(...at(50, 110));
    f1.move(...at(25, 110));
    f2.move(...at(55, 110));
    f1.up(...at(25, 110));
    f2.up(...at(55, 110));
    // касание на месте после щипка (второй палец остался и поднят без сдвига) — тоже не точка
    f1.down(...at(30, 110));
    f2.down(...at(50, 110));
    f2.up(...at(50, 110));
    f1.up(...at(30, 110));
    expect(s.log.steps.filter((k) => k > 0)).toEqual([]);
    expect(s.log.created).toHaveLength(0);
    // касание без сдвига — точка A
    s.finger.tap(...at(20, 110));
    expect(s.log.steps.at(-1)).toBe(1);
  });

  it("щипок после точки A: точка B не двигается и рисунок не завершается, масштаб — графику", () => {
    const s = setup({ coarse: true });
    s.ctrl.setTool("trend");
    s.finger.tap(...at(10, 120));
    s.finger.drag(...at(20, 110), ...at(30, 100));
    const before = s.lastDraft()!.points;
    const f1 = s.pointer("touch", 3), f2 = s.pointer("touch", 4);
    f1.down(...at(40, 100));
    f1.move(...at(45, 100));
    f2.down(...at(60, 100));
    expect(s.touchReachesChart("touchstart", 2)).toBe(true);
    f1.move(...at(35, 100));
    f2.move(...at(65, 100));
    f1.up(...at(35, 100));
    f2.up(...at(65, 100));
    expect(s.log.created).toHaveLength(0);
    expect(s.lastDraft()!.points).toEqual(before);
  });

  it("отмена жеста системой (pointercancel) возвращает точку на место", () => {
    const s = setup({ coarse: true });
    s.ctrl.setTool("trend");
    s.finger.tap(...at(10, 120));
    s.finger.down(...at(20, 110));
    s.finger.move(...at(40, 90));
    s.finger.cancel(...at(40, 90));
    expect(s.lastDraft()!.points).toEqual([{ time: T0 + 10 * H, price: 120 }]);
    expect(s.log.created).toHaveLength(0);
  });
});

describe("отмена и правка", () => {
  it("снятие инструмента (Отменить, Esc) бросает начатый рисунок; следующий клик рисунков не создаёт", () => {
    const s = setup();
    s.ctrl.setTool("fib");
    s.mouse.tap(...at(10, 120));
    expect(s.ctrl.placed).toBe(1);
    s.ctrl.setTool(null);
    expect(s.lastDraft()).toBeNull();
    expect(s.log.steps.at(-1)).toBe(0);
    expect(s.ctrl.placed).toBe(0);
    s.mouse.tap(...at(30, 90));
    expect(s.log.created).toHaveLength(0);
    expect(s.log.selected.at(-1)).toBeNull();
  });

  it("перетаскивание хэндла и тела правит рисунок и новых не создаёт; касание мимо снимает выбор, сдвиг — нет", () => {
    const line: Drawing = { id: "L", type: "trend", points: [{ time: T0 + 10 * H, price: 120 }, { time: T0 + 30 * H, price: 100 }], style: DEFAULT_STYLE, locked: false, timeframe: null, updated_at: 0 };
    const s = setup({ items: [line], coarse: true });
    // хэндл B мышью
    s.mouse.drag(...at(30, 100), ...at(35, 95));
    expect(s.log.selected).toEqual(["L"]);
    expect(s.log.moves.at(-1)).toEqual({ id: "L", final: true, points: [{ time: T0 + 10 * H, price: 120 }, { time: T0 + 35 * H, price: 95 }], origin: line.points });
    // тело пальцем: график не сдвигается (касания не доходят до LWC)
    const d = s.finger.down(...at(20, 110 - 2.5));
    expect(d.stopped).toBe(true);
    expect(s.touchReachesChart("touchstart", 1)).toBe(false);
    s.finger.move(...at(25, 105 - 2.5));
    s.finger.up(...at(25, 105 - 2.5));
    expect(s.log.moves.at(-1)!.final).toBe(true);
    expect(s.touchReachesChart("touchend", 0)).toBe(false);
    // касание по рисунку без сдвига — только выбор (тело сдвинуто на 5 свечей и −5 по цене: A — в 15 / 115)
    s.finger.tap(...at(15, 115));
    expect(s.log.selected.at(-1)).toBe("L");
    // сдвиг графика пальцем мимо рисунка: выбор не снимается
    const pan = s.finger.drag(...at(60, 150), ...at(90, 150));
    expect(pan.d.stopped).toBe(false);
    expect(s.log.selected.at(-1)).toBe("L");
    // касание мимо — снять выбор
    s.finger.tap(...at(60, 150));
    expect(s.log.selected.at(-1)).toBeNull();
    expect(s.log.created).toHaveLength(0);
  });

  it("заблокированный рисунок не перетаскивается: нажатие уходит графику", () => {
    const line: Drawing = { id: "L", type: "hline", points: [{ time: T0, price: 120 }], style: DEFAULT_STYLE, locked: true, timeframe: null, updated_at: 0 };
    const s = setup({ items: [line] });
    const g = s.mouse.drag(...at(20, 120), ...at(30, 110));
    expect(g.d.stopped).toBe(false);
    expect(s.log.moves).toHaveLength(0);
    expect(s.ctrl.hitAt(...at(20, 120))).toBe("L");
  });

  it("destroy снимает обработчики", () => {
    const s = setup();
    s.ctrl.destroy();
    expect([...s.el.listeners.values()].every((l) => l.length === 0)).toBe(true);
    expect([...s.doc.listeners.values()].every((l) => l.length === 0)).toBe(true);
  });
});

describe("магнит и вид нового рисунка", () => {
  it("с магнитом точка — к ближайшей цене OHLC свечи (в пределах 12 px), без магнита — как есть", () => {
    const c = CANDLES[20]!;
    const near = c.high + 1.5; // 6 px выше максимума
    const s = setup({ magnet: true });
    s.ctrl.setTool("hline");
    s.mouse.tap(xOf(c.time), yOf(near));
    expect(s.log.created[0]!.points[0]).toEqual({ time: c.time, price: c.high });
    s.ctrl.setMagnet(false);
    s.ctrl.setTool("hline");
    s.mouse.tap(xOf(c.time), yOf(near));
    expect(s.log.created[1]!.points[0]!.price).toBeCloseTo(near, 9);
    // время — к ближайшей свече
    s.ctrl.setTool("vline");
    s.mouse.tap(xOf(c.time) + PX_BAR * 0.4, 100);
    expect(s.log.created[2]!.points[0]!.time).toBe(c.time);
  });

  it("магнит работает и для протянутой пальцем точки", () => {
    const c = CANDLES[40]!;
    const s = setup({ magnet: true, coarse: true });
    s.ctrl.setTool("trend");
    s.finger.tap(...at(10, 120));
    s.finger.drag(...at(20, 110), xOf(c.time), yOf(c.low - 1));
    expect(s.lastDraft()!.points[1]).toEqual({ time: c.time, price: c.low });
  });

  it("цвет по умолчанию — нейтральный text2 (не салатовый и не охра); у позиций — up/down", () => {
    const s = setup();
    for (const t of ["fib", "trend", "rect"] as const) {
      s.ctrl.setTool(t);
      s.mouse.tap(...at(10, 120));
      s.mouse.tap(...at(30, 100));
    }
    s.ctrl.setTool("position-long");
    s.mouse.tap(...at(10, 120));
    s.mouse.tap(...at(10, 110));
    s.mouse.tap(...at(10, 140));
    expect(s.log.created.map((d) => d.style.color)).toEqual(["text2", "text2", "text2", "up"]);
    expect(s.log.created[0]!.levels).toContain(0.618);
  });

  it("допуск касания — тот же, что у жестов графика", () => {
    expect(INTERACTION.tapSlopPx).toBeGreaterThan(CLICK_SLOP_PX);
  });
});

/** Фибоначчи на свечах 10…40, цены 120…80: тело — весь прямоугольник A–B. */
const FIB: Drawing = { id: "F", type: "fib", points: [{ time: T0 + 10 * H, price: 120 }, { time: T0 + 40 * H, price: 80 }], style: DEFAULT_STYLE, locked: false, timeframe: null, updated_at: 0 };

describe("палец над готовым рисунком: график важнее, правится только выбранный", () => {
  it("сдвиг пальцем по невыбранному Фибоначчи — график едет, рисунок стоит; касание выбирает его", () => {
    const s = setup({ items: [FIB], coarse: true });
    const pan = s.finger.drag(...at(25, 100), ...at(10, 100));
    expect(pan.d.stopped).toBe(false);
    expect(pan.moves.some((m) => m.stopped)).toBe(false);
    expect(s.touchReachesChart("touchstart", 1)).toBe(true);
    expect(s.touchReachesChart("touchmove", 1)).toBe(true);
    expect(s.log.moves).toHaveLength(0);
    expect(s.items()[0]!.points).toEqual(FIB.points);
    expect(s.log.selected).toEqual([]);
    // касание без сдвига — выбор (а не снятие выбора)
    s.finger.tap(...at(25, 100));
    expect(s.selected()).toBe("F");
    // выбранный — правится: хэндл B пальцем, график стоит
    const d = s.finger.down(...at(40, 80));
    expect(d.stopped).toBe(true);
    expect(s.touchReachesChart("touchstart", 1)).toBe(false);
    s.finger.move(...at(45, 75));
    s.finger.up(...at(45, 75));
    expect(s.log.moves.at(-1)).toMatchObject({ id: "F", final: true, points: [FIB.points[0], { time: T0 + 45 * H, price: 75 }], origin: FIB.points });
    expect(s.log.created).toHaveLength(0);
  });

  it("мышь по-прежнему тянет и невыбранный рисунок", () => {
    const s = setup({ items: [FIB] });
    const g = s.mouse.drag(...at(25, 100), ...at(30, 95));
    expect(g.d.stopped).toBe(true);
    expect(s.log.moves.at(-1)!.final).toBe(true);
  });

  it("щипок, начатый пальцем на выбранном рисунке: правка отменена (рисунок на месте, без шага отмены), масштаб — графику", () => {
    const s = setup({ items: [FIB], coarse: true });
    s.finger.tap(...at(25, 100));
    expect(s.selected()).toBe("F");
    const f1 = s.pointer("touch", 7), f2 = s.pointer("touch", 8);
    f1.down(...at(25, 100));
    expect(s.touchReachesChart("touchstart", 1)).toBe(false);
    f1.move(...at(22, 100));
    expect(s.items()[0]!.points).not.toEqual(FIB.points);
    f2.down(...at(35, 90));
    // второй палец: touchstart с двумя касаниями доходит до LWC — он начинает щипок
    expect(s.touchReachesChart("touchstart", 2)).toBe(true);
    expect(s.items()[0]!.points).toEqual(FIB.points);
    f1.move(...at(15, 100));
    f2.move(...at(45, 90));
    expect(s.touchReachesChart("touchmove", 2)).toBe(true);
    f1.up(...at(15, 100));
    f2.up(...at(45, 90));
    expect(s.items()[0]!.points).toEqual(FIB.points);
    expect(s.log.moves.filter((m) => m.final)).toEqual([]);
    expect(s.log.created).toHaveLength(0);
    expect(s.selected()).toBe("F");
  });
});

describe("шкалы цены и времени, другие панели — жесты графика", () => {
  it("с инструментом нажатие и протягивание по шкале цены и клик по шкале времени точек не ставят", () => {
    const s = setup();
    s.ctrl.setTool("fib");
    const axis = s.mouse.drag(PLOT_W + 30, 250, PLOT_W + 30, 480);
    expect(axis.d.stopped || axis.d.prevented).toBe(false);
    expect(axis.moves.some((m) => m.stopped)).toBe(false);
    expect(s.log.created).toHaveLength(0);
    expect(s.ctrl.placed).toBe(0);
    s.ctrl.setTool("trend");
    s.mouse.tap(300, PLOT_H + 10);
    expect(s.ctrl.placed).toBe(0);
    expect(s.ctrl.tool).toBe("trend");
    // пальцем: касание шкалы — не точка A
    const f = setup({ coarse: true });
    f.ctrl.setTool("hline");
    f.finger.tap(PLOT_W + 20, 300);
    expect(f.log.created).toHaveLength(0);
    // после точки A протягивание по шкале цены — масштаб шкалы, точка B не двигается
    f.ctrl.setTool("trend");
    f.finger.tap(...at(10, 120));
    const g = f.finger.drag(PLOT_W + 20, 300, PLOT_W + 20, 500);
    expect(g.d.stopped).toBe(false);
    expect(f.touchReachesChart("touchstart", 1)).toBe(true);
    expect(f.lastDraft()!.points).toHaveLength(1);
  });

  it("Фибоначчи и прямоугольник: вторая точка на той же свече — не рисунок нулевой ширины", () => {
    const s = setup();
    s.ctrl.setTool("fib");
    s.mouse.drag(...at(30, 120), ...at(30, 80));
    expect(s.log.created).toHaveLength(0);
    expect(s.ctrl.placed).toBe(1);
    s.mouse.tap(...at(31, 80));
    expect(s.log.created).toHaveLength(1);
    s.ctrl.setTool("rect");
    s.mouse.tap(...at(50, 120));
    s.mouse.tap(...at(50, 60));
    expect(s.log.created).toHaveLength(1);
    // трендовая на одной свече — вертикальный отрезок, допустимо
    s.ctrl.setTool("trend");
    s.mouse.tap(...at(60, 120));
    s.mouse.tap(...at(60, 60));
    expect(s.log.created.map((d) => d.type)).toEqual(["fib", "trend"]);
  });
});

describe("то же место: двойной клик и двойное касание с магнитом", () => {
  /** 9 px выше максимума свечи 20: магнит уводит точку на максимум — дальше допуска «того же места». */
  const c = CANDLES[20]!;
  const near = [xOf(c.time), yOf(c.high) - 9] as const;

  it("мышь: двойной клик рядом с максимумом не даёт Фибоначчи нулевой длины, инструмент остаётся", () => {
    const s = setup({ magnet: true });
    s.ctrl.setTool("fib");
    s.mouse.tap(...near);
    s.mouse.tap(...near);
    expect(s.log.created).toHaveLength(0);
    expect(s.ctrl.tool).toBe("fib");
    expect(s.ctrl.placed).toBe(1);
  });

  it("палец: двойное касание рядом с минимумом — тоже", () => {
    const s = setup({ magnet: true, coarse: true });
    s.ctrl.setTool("trend");
    const p = [xOf(c.time), yOf(c.low) + 10] as const;
    s.finger.tap(...p);
    s.finger.tap(...p);
    expect(s.log.created).toHaveLength(0);
    expect(s.ctrl.tool).toBe("trend");
  });

  it("широкие свечи без магнита: привязка ко времени уводит точку от клика — второй клик туда же не рисует", () => {
    const s = setup({ pxBar: 30 });
    s.ctrl.setTool("trend");
    const p = [20 * 30 + 10, yOf(110)] as const;
    s.mouse.tap(...p);
    s.mouse.tap(...p);
    expect(s.log.created).toHaveLength(0);
    s.mouse.tap(30 * 30, yOf(100));
    expect(s.log.created).toHaveLength(1);
  });
});

describe("двойной клик, которым закончили рисунок, вид не сбрасывает", () => {
  it("Alt+H и двойной клик: линия, инструмент снят, dblclick до графика не доходит", () => {
    const s = setup();
    s.ctrl.setTool("hline");
    s.mouse.tap(...at(30, 110));
    s.mouse.tap(...at(30, 110));
    expect(s.ctrl.tool).toBeNull();
    expect(s.log.created).toHaveLength(1);
    s.clock.now += 120;
    expect(s.dblReachesChart(...at(30, 110))).toBe(false);
  });

  it("второй клик двойного ставит точку B трендовой — тоже", () => {
    const s = setup();
    s.ctrl.setTool("trend");
    s.mouse.tap(...at(10, 120));
    s.clock.now += 1000;
    s.mouse.tap(...at(40, 90));
    s.mouse.tap(...at(40, 90));
    expect(s.log.created).toHaveLength(1);
    s.clock.now += 200;
    expect(s.dblReachesChart(...at(40, 90))).toBe(false);
    // двойной клик в другом месте — сброс вида
    expect(s.dblReachesChart(...at(70, 140))).toBe(true);
  });
});

describe("одноточечные мышью и пером: дрожь руки при клике", () => {
  it("нажали, сдвинули на 4–5 px, отпустили — линия там, где нажали, сразу (инструмент снят)", () => {
    for (const [type, dx, dy] of [["hline", 4, 0], ["hray", 3, 3], ["vline", 5, 0], ["note", 0, 5]] as const) {
      const s = setup();
      s.ctrl.setTool(type);
      const [x, y] = at(30, 125);
      s.mouse.down(x, y);
      s.mouse.move(x + dx, y + dy);
      s.mouse.up(x + dx, y + dy);
      expect(s.log.created.map((d) => d.type), type).toEqual([type]);
      expect(s.log.created[0]!.points, type).toEqual([{ time: T0 + 30 * H, price: 125 }]);
      expect(s.log.done).toEqual([true]);
      expect(s.ctrl.tool).toBeNull();
      // следующий клик ничего не рисует
      s.mouse.tap(...at(50, 50));
      expect(s.log.created).toHaveLength(1);
    }
  });

  it("пером — как пальцем: дрожь до 8 px — касание", () => {
    const s = setup();
    s.ctrl.setTool("hline");
    const [x, y] = at(30, 125);
    s.pen.down(x, y);
    s.pen.move(x + 5, y);
    s.pen.up(x + 5, y);
    expect(s.log.created).toHaveLength(1);
  });
});

describe("перо — как палец", () => {
  it("до точки A протягивание пером — жест графика; после A и при правке touch-события пера до LWC не доходят", () => {
    const s = setup();
    s.ctrl.setTool("trend");
    const pan = s.pen.drag(...at(10, 120), ...at(40, 120));
    expect(pan.d.stopped).toBe(false);
    expect(s.ctrl.placed).toBe(0);
    s.pen.tap(...at(10, 120));
    expect(s.ctrl.placed).toBe(1);
    const d = s.pen.down(...at(20, 110));
    expect(d.stopped).toBe(true);
    expect(s.touchReachesChart("touchstart", 1)).toBe(false);
    s.pen.move(...at(30, 100));
    expect(s.touchReachesChart("touchmove", 1)).toBe(false);
    s.pen.up(...at(30, 100));
    s.pen.tap(...at(30, 100));
    expect(s.log.created).toHaveLength(1);
    // правка выбранного рисунка пером — тоже без сдвига графика
    const h = s.pen.down(...at(30, 100));
    expect(h.stopped).toBe(true);
    expect(s.touchReachesChart("touchstart", 1)).toBe(false);
    s.pen.move(...at(35, 95));
    expect(s.touchReachesChart("touchmove", 1)).toBe(false);
    s.pen.up(...at(35, 95));
    expect(s.log.moves.at(-1)!.final).toBe(true);
  });
});

describe("отмена после перетаскивания", () => {
  it("конец перетаскивания сообщает положение до него (шаг отмены — от него)", () => {
    const line: Drawing = { id: "L", type: "trend", points: [{ time: T0 + 10 * H, price: 120 }, { time: T0 + 30 * H, price: 100 }], style: DEFAULT_STYLE, locked: false, timeframe: null, updated_at: 0 };
    const s = setup({ items: [line] });
    s.mouse.drag(...at(30, 100), ...at(36, 90));
    const finals = s.log.moves.filter((m) => m.final);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.origin).toEqual(line.points);
    expect(s.log.moves.filter((m) => !m.final).every((m) => m.origin === undefined)).toBe(true);
  });
});
