import { describe, expect, it } from "vitest";
import { DrawingController, type DrawProjector } from "../drawings/controller";
import { CLICK_SLOP_PX, DEFAULT_STYLE, HANDLE_TOUCH_PX, type Drawing } from "../drawings/types";
import { INTERACTION } from "../presets";
import { bars, H, T0 } from "./fakes/lwc";

/**
 * Автомат жестов рисования (ADR-0009, «Рисование»): один рисунок на выбор инструмента, «серия», клик-клик и
 * нажать-протянуть мышью, касание-касание пальцем с протягиванием между ними, отмена, сдвиг и щипок графика
 * рисунков не создают, правка рисунка — тоже, магнит.
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
const proj: DrawProjector = {
  timeAt: (x) => T0 + (x / PX_BAR) * H,
  priceAt: (y) => TOP - y / PX_PRICE,
  projector: () => ({ x: xOf, y: yOf, width: 1000, height: 800 }),
};
const CANDLES = bars(100);

function setup(o: { magnet?: boolean; items?: Drawing[]; coarse?: boolean } = {}) {
  const doc = new FakeTarget();
  const el = Object.assign(new FakeTarget(), { ownerDocument: doc, getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture: () => undefined });
  let items: Drawing[] = o.items ?? [];
  let n = 0;
  const log = { created: [] as Drawing[], selected: [] as (string | null)[], drafts: [] as (Drawing | null)[], steps: [] as number[], done: [] as boolean[], moves: [] as { id: string; final: boolean; points: Drawing["points"] }[] };
  const ctrl = new DrawingController(
    el as unknown as HTMLElement,
    proj,
    { getDrawings: () => items, getCandles: () => CANDLES, tfSeconds: H, timeframe: null, touch: o.coarse ?? false, magnet: o.magnet ?? false, newId: () => `n${++n}` },
    {
      onCreate: (d) => {
        log.created.push(d);
        items = [...items, d];
      },
      onMove: (id, points, final) => {
        log.moves.push({ id, final, points });
        items = items.map((d) => (d.id === id ? { ...d, points } : d));
      },
      onSelect: (id) => log.selected.push(id),
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
  const pointer = (type: "mouse" | "touch", id = 1) => ({
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
  return { ctrl, el, doc, log, items: () => items, mouse: pointer("mouse"), finger: pointer("touch"), pointer, touchReachesChart, lastDraft, fire };
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
    let stopped = false;
    s.el.dispatch("dblclick", { stopPropagation: () => (stopped = true) });
    expect(stopped).toBe(true);
    s.mouse.tap(...at(20, 100));
    expect(s.log.created).toHaveLength(1);
    stopped = false;
    s.el.dispatch("dblclick", { stopPropagation: () => (stopped = true) });
    expect(stopped).toBe(false);
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
    expect(s.log.moves.at(-1)).toEqual({ id: "L", final: true, points: [{ time: T0 + 10 * H, price: 120 }, { time: T0 + 35 * H, price: 95 }] });
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
