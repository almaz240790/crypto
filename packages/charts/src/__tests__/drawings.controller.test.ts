import { describe, expect, it } from "vitest";
import { DrawingController, type DrawProjector } from "../drawings/controller";
import { positionScreen } from "../drawings/geometry";
import { atrAt } from "../drawings/position";
import { CLICK_SLOP_PX, DBLCLICK_MS, DEFAULT_STYLE, FIB_LEVELS, HANDLE_TOUCH_PX, type Drawing } from "../drawings/types";
import type { Candle } from "../types";
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

function setup(o: { magnet?: boolean; items?: Drawing[]; coarse?: boolean; pxBar?: number; candles?: Candle[]; tick?: number | null; tf?: () => number; stale?: boolean; proj?: DrawProjector; fibLevels?: () => readonly number[] | null | undefined } = {}) {
  const doc = new FakeTarget();
  const el = Object.assign(new FakeTarget(), { ownerDocument: doc, getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture: () => undefined });
  let items: Drawing[] = o.items ?? [];
  let n = 0;
  let selected: string | null = null;
  const clock = { now: 0 };
  const log = { created: [] as Drawing[], selected: [] as (string | null)[], drafts: [] as (Drawing | null)[], steps: [] as number[], done: [] as boolean[], moves: [] as { id: string; final: boolean; points: Drawing["points"]; origin?: Drawing["points"] }[] };
  const ctrl = new DrawingController(
    el as unknown as HTMLElement,
    o.proj ?? projOf(o.pxBar ?? PX_BAR),
    { getDrawings: () => items, getCandles: () => o.candles ?? CANDLES, tfSeconds: H, ...(o.tf ? { getTfSeconds: o.tf } : {}), getTick: () => o.tick ?? null, timeframe: null, touch: o.coarse ?? false, magnet: o.magnet ?? false, newId: () => `n${++n}`, getSelectedId: () => selected, now: () => clock.now, ...(o.fibLevels ? { getFibLevels: o.fibLevels } : {}) },
    {
      onCreate: (d) => {
        log.created.push(d);
        items = [...items, d];
        // как useDrawings: новый рисунок выбран
        selected = d.id;
      },
      onMove: (id, points, final, origin) => {
        log.moves.push({ id, final, points, origin });
        // stale — хозяин (React) ещё не перерисовался: промежуточные положения до getDrawings не доходят
        if (final || !o.stale) items = items.map((d) => (d.id === id ? { ...d, points } : d));
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
  const select = (id: string | null) => {
    selected = id;
  };
  return { ctrl, el, doc, log, items: () => items, selected: () => selected, select, clock, mouse: pointer("mouse"), finger: pointer("touch"), pen: pointer("pen"), pointer, touchReachesChart, dblReachesChart, lastDraft, fire };
}

/** Точка на свече i с ценой p — в пикселях. */
const at = (i: number, p: number) => [xOf(T0 + i * H), yOf(p)] as const;

describe("уровни нового Фибоначчи", () => {
  const draw = (s: ReturnType<typeof setup>) => {
    s.ctrl.setTool("fib");
    s.mouse.tap(...at(10, 120));
    s.mouse.tap(...at(30, 90));
    return s.log.created[s.log.created.length - 1]!;
  };

  it("без настройки — уровни по умолчанию, у каждого рисунка свой массив", () => {
    const s = setup();
    const a = draw(s);
    const b = draw(s);
    expect(a.levels).toEqual(FIB_LEVELS);
    expect(a.levels).not.toBe(FIB_LEVELS);
    expect(b.levels).not.toBe(a.levels);
  });

  it("с набором, выбранным в прошлый раз, — он же, приведённый; набор читается в момент рисунка", () => {
    let remembered: readonly number[] | null = [1, -0.618, 0, 0.5, 0.5000001];
    const s = setup({ fibLevels: () => remembered });
    // предпросмотр за курсором — уже с этим набором
    s.ctrl.setTool("fib");
    s.mouse.tap(...at(10, 120));
    s.mouse.move(...at(20, 100));
    expect(s.lastDraft()!.levels).toEqual([-0.618, 0, 0.5, 1]);
    s.mouse.tap(...at(30, 90));
    expect(s.log.created[0]!.levels).toEqual([-0.618, 0, 0.5, 1]);
    // пользователь сменил набор — следующий рисунок с новым; первый не тронут
    remembered = [0, 1, 2.618];
    expect(draw(s).levels).toEqual([0, 1, 2.618]);
    expect(s.log.created[0]!.levels).toEqual([-0.618, 0, 0.5, 1]);
    // набор сбросили или в настройках мусор — уровни по умолчанию
    remembered = null;
    expect(draw(s).levels).toEqual(FIB_LEVELS);
    remembered = [];
    expect(draw(s).levels).toEqual(FIB_LEVELS);
    remembered = [Number.NaN];
    expect(draw(s).levels).toEqual(FIB_LEVELS);
  });

  it("у других инструментов уровней нет, какой бы набор ни был выбран", () => {
    const s = setup({ fibLevels: () => [0, 1] });
    s.ctrl.setTool("trend");
    s.mouse.tap(...at(10, 120));
    s.mouse.tap(...at(30, 90));
    expect(s.log.created[0]!.type).toBe("trend");
    expect(s.log.created[0]!.levels).toBeUndefined();
  });
});

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

describe("палец: только что нарисованный рисунок", () => {
  /** Фибоначчи двумя касаниями на свечах 10 и 40: выбран сразу (как useDrawings). */
  const drawn = () => {
    const s = setup({ coarse: true });
    s.ctrl.setTool("fib");
    s.finger.tap(...at(10, 120));
    s.finger.tap(...at(40, 80));
    expect(s.log.created).toHaveLength(1);
    const d = s.log.created[0]!;
    expect(s.selected()).toBe(d.id);
    return { s, d };
  };

  it("выбран, но сдвиг из его середины — графику, пока по нему не коснулись; ручки тянутся сразу", () => {
    const { s, d } = drawn();
    // сдвиг из середины: график едет (касания доходят до LWC), рисунок на месте, выбор остаётся
    const pan = s.finger.down(...at(25, 100));
    expect(pan.stopped).toBe(false);
    expect(s.touchReachesChart("touchstart", 1)).toBe(true);
    s.finger.move(...at(18, 100));
    expect(s.touchReachesChart("touchmove", 1)).toBe(true);
    s.finger.up(...at(10, 100));
    expect(s.log.moves).toHaveLength(0);
    expect(s.selected()).toBe(d.id);
    // ручка B — сразу: график стоит
    const h = s.finger.down(...at(40, 80));
    expect(h.stopped).toBe(true);
    expect(s.touchReachesChart("touchstart", 1)).toBe(false);
    s.finger.move(...at(45, 75));
    s.finger.up(...at(45, 75));
    expect(s.log.moves.at(-1)).toMatchObject({ id: d.id, final: true, points: [d.points[0], { time: T0 + 45 * H, price: 75 }] });
    // после правки ручки тело всё ещё не тянется — только касание по рисунку
    const n = s.log.moves.length;
    expect(s.finger.drag(...at(25, 100), ...at(15, 100)).d.stopped).toBe(false);
    expect(s.log.moves).toHaveLength(n);
    // касание по рисунку — теперь тело тянется, график стоит
    s.finger.tap(...at(25, 100));
    expect(s.selected()).toBe(d.id);
    const b = s.finger.down(...at(25, 100));
    expect(b.stopped).toBe(true);
    expect(s.touchReachesChart("touchstart", 1)).toBe(false);
    s.finger.move(...at(20, 100));
    s.finger.up(...at(20, 100));
    expect(s.log.moves.at(-1)).toMatchObject({ id: d.id, final: true });
    expect(s.items()[0]!.points[0]!.time).toBe(T0 + 5 * H);
  });

  it("касание по ручке тоже считается касанием по рисунку; выбран другой рисунок и снова этот без касания — тело не тянется", () => {
    const { s, d } = drawn();
    s.finger.tap(...at(40, 80));
    expect(s.finger.drag(...at(25, 100), ...at(20, 100)).d.stopped).toBe(true);
    // выбор снят мимо, затем рисунок выбран не касанием (список рисунков, отмена): тело — снова графику
    s.finger.tap(...at(70, 160));
    expect(s.selected()).toBeNull();
    s.select(d.id);
    const n = s.log.moves.length;
    expect(s.finger.drag(...at(20, 100), ...at(10, 100)).d.stopped).toBe(false);
    expect(s.log.moves).toHaveLength(n);
  });

  it("мышь — как прежде: только что нарисованный тянется за тело сразу", () => {
    const s = setup();
    s.ctrl.setTool("fib");
    s.mouse.tap(...at(10, 120));
    s.mouse.tap(...at(40, 80));
    const g = s.mouse.drag(...at(25, 100), ...at(20, 100));
    expect(g.d.stopped).toBe(true);
    expect(s.log.moves.at(-1)!.final).toBe(true);
  });
});

describe("заблокированный рисунок: выбирается, но не правится", () => {
  const LOCKED: Drawing = { ...FIB, locked: true };

  it("мышь: клик по телу, линии уровня и точке выбирает (карточка с «разблокировать» и «удалить»); протягивание — графику", () => {
    const s = setup({ items: [LOCKED] });
    s.mouse.tap(...at(25, 100));
    expect(s.log.selected.at(-1)).toBe("F");
    s.mouse.tap(...at(25, 120 + 40 * 0.272));
    expect(s.log.selected.at(-1)).toBe("F");
    s.mouse.tap(...at(10, 120));
    expect(s.log.selected.at(-1)).toBe("F");
    // протягивание по нему — жест графика: не поглощено, рисунок на месте, выбор не меняется
    const g = s.mouse.drag(...at(25, 100), ...at(30, 95));
    expect(g.d.stopped || g.d.prevented).toBe(false);
    expect(g.moves.some((m) => m.stopped)).toBe(false);
    expect(s.log.moves).toHaveLength(0);
    expect(s.selected()).toBe("F");
    // клик мимо — выбор снят
    s.mouse.tap(...at(70, 150));
    expect(s.log.selected.at(-1)).toBeNull();
  });

  it("палец: касание выбирает; сдвиг по выбранному — графику, рисунок на месте", () => {
    const s = setup({ items: [LOCKED], coarse: true });
    s.finger.tap(...at(25, 100));
    expect(s.selected()).toBe("F");
    const pan = s.finger.down(...at(25, 100));
    expect(pan.stopped).toBe(false);
    expect(s.touchReachesChart("touchstart", 1)).toBe(true);
    s.finger.move(...at(15, 100));
    expect(s.touchReachesChart("touchmove", 1)).toBe(true);
    s.finger.up(...at(15, 100));
    expect(s.log.moves).toHaveLength(0);
    expect(s.selected()).toBe("F");
    // ручки заблокированного не тянутся
    s.finger.drag(...at(40, 80), ...at(45, 75));
    expect(s.log.moves).toHaveLength(0);
    expect(s.log.created).toHaveLength(0);
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

describe("правка Фибоначчи и прямоугольника: не нулевой ширины", () => {
  it("ручку отпустили на свече другой точки — остаётся последнее положение по пути, как при постановке второй точки", () => {
    const s = setup({ items: [FIB] });
    // B (свеча 40) — влево на свечу A (10) с промахом в треть свечи: раньше обе точки на свече 10, линии уровней — 0 px
    s.mouse.drag(...at(40, 80), xOf(T0 + 10 * H) + PX_BAR * 0.3, yOf(85));
    const end = s.log.moves.at(-1)!;
    expect(end.final).toBe(true);
    expect(end.points[0]).toEqual(FIB.points[0]);
    expect(end.points[1]!.time).not.toBe(FIB.points[0]!.time);
    expect(end.points[1]!.time).toBe(s.log.moves.at(-2)!.points[1]!.time);
    // промежуточные положения — тоже без нулевой ширины
    for (const m of s.log.moves) expect(m.points[1]!.time).not.toBe(m.points[0]!.time);
    // через A на другую сторону — можно (как и при постановке)
    s.mouse.drag(...at((end.points[1]!.time - T0) / H, 85), ...at(4, 85));
    expect(s.items()[0]!.points[1]!.time).toBe(T0 + 4 * H);
    // ручка A на свечу B, первым же сдвигом (последнего положения ещё нет) — A на месте
    const s2 = setup({ items: [FIB], stale: true });
    s2.mouse.drag(...at(10, 120), ...at(40, 110), 1);
    expect(s2.items()[0]!.points).toEqual(FIB.points);
  });

  it("прямоугольник — так же; трендовая на одной свече (вертикальный отрезок) — можно", () => {
    const rect: Drawing = { ...FIB, id: "R", type: "rect", levels: undefined };
    const s = setup({ items: [rect] });
    s.mouse.drag(...at(40, 80), ...at(10, 90));
    expect(s.items()[0]!.points[1]!.time).not.toBe(T0 + 10 * H);
    const line: Drawing = { ...FIB, id: "L", type: "trend", levels: undefined };
    const t = setup({ items: [line] });
    t.mouse.drag(...at(40, 80), ...at(10, 90));
    expect(t.items()[0]!.points[1]).toEqual({ time: T0 + 10 * H, price: 90 });
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

/**
 * Позиция Long/Short как в TradingView (ADR-0009, «Рисование», дополнение «Позиция»): одно нажатие на цену входа —
 * готовая позиция (стоп — ATR(14), цель 1:2, ~30 свечей вправо, не дальше края панели); ручки входа, стопа и цели
 * двигают свою цену, правый край — длительность, тело — всю позицию; график под правкой не едет.
 */
describe("позиция: одно нажатие", () => {
  const atr14 = (i: number) => atrAt(CANDLES, T0 + i * H)!;

  it("клик мышью — вход по клику, стоп на ATR(14) ниже, цель 1:2, правый край — через 30 свечей; инструмент снят", () => {
    const s = setup();
    s.ctrl.setTool("position-long");
    s.mouse.tap(...at(40, 100));
    expect(s.log.created).toHaveLength(1);
    const d = s.log.created[0]!;
    const a = atr14(40);
    expect(a).toBeGreaterThan(0);
    expect(d.type).toBe("position-long");
    expect(d.style.color).toBe("up");
    expect(d.points[0]).toEqual({ time: T0 + 40 * H, price: 100 });
    expect(d.points[1]!.price).toBeCloseTo(100 - a, 9);
    expect(d.points[2]!.price).toBeCloseTo(100 + 2 * a, 9);
    expect(d.points[1]!.time).toBe(T0 + 70 * H);
    expect(d.points[2]!.time).toBe(T0 + 70 * H);
    expect(s.log.done).toEqual([true]);
    expect(s.ctrl.tool).toBeNull();
    // дальше клики позиций не ставят (раньше нужны были ещё два нажатия — стоп и цель)
    s.mouse.tap(...at(50, 95));
    s.mouse.tap(...at(50, 110));
    expect(s.log.created).toHaveLength(1);
  });

  it("касание пальцем — Short: стоп выше на ATR, цель ниже на 2 ATR; сдвиг до касания — графику", () => {
    const s = setup({ coarse: true });
    s.ctrl.setTool("position-short");
    const pan = s.finger.drag(...at(30, 100), ...at(10, 100));
    expect(pan.d.stopped).toBe(false);
    expect(s.log.created).toHaveLength(0);
    s.finger.tap(...at(30, 102));
    expect(s.log.created).toHaveLength(1);
    const d = s.log.created[0]!;
    const a = atr14(30);
    expect(d.type).toBe("position-short");
    expect(d.style.color).toBe("down");
    expect(d.points[1]!.price).toBeCloseTo(102 + a, 9);
    expect(d.points[2]!.price).toBeCloseTo(102 - 2 * a, 9);
    expect(s.ctrl.tool).toBeNull();
  });

  it("мышь с дрожью руки (нажать-протянуть на 4 px) — та же позиция там, где нажали", () => {
    const s = setup();
    s.ctrl.setTool("position-long");
    s.mouse.drag(...at(40, 100), at(40, 100)[0] + 4, at(40, 100)[1] + 1, 2);
    expect(s.log.created).toHaveLength(1);
    expect(s.log.created[0]!.points[0]).toEqual({ time: T0 + 40 * H, price: 100 });
  });

  it("правый край — не дальше края области свечей (width − 8): у последних свечей позиция уже, у самого края — левее", () => {
    const s = setup();
    s.ctrl.setTool("position-long");
    s.mouse.tap(...at(90, 100));
    // 30 свечей вправо — за краем (1000 px): край — на свече под x = 990 ≤ 992
    expect(s.log.created[0]!.points[1]!.time).toBe(T0 + 99 * H);
    s.ctrl.setTool("position-long");
    s.mouse.tap(...at(98, 100));
    // у самого края — одна свеча (раньше запас 40 px уводил край и его ручку под шкалу цены)
    expect(s.log.created[1]!.points.map((p) => p.time)).toEqual([T0 + 98 * H, T0 + 99 * H, T0 + 99 * H]);
    // нажали в последних 8 px (свеча входа за краем) — позиция на свечу левее, край на экране
    s.ctrl.setTool("position-short");
    s.mouse.tap(996, yOf(100));
    const d = s.log.created[2]!;
    expect(d.points.map((p) => p.time)).toEqual([T0 + 98 * H, T0 + 99 * H, T0 + 99 * H]);
    expect(d.points[0]!.price).toBe(100);
    // ручка края — в области свечей: хватается мышью
    const sc = positionScreen(d, projOf(PX_BAR).projector())!;
    expect(sc.xR).toBeLessThanOrEqual(PLOT_W - 8);
    expect(s.ctrl.hitAt(sc.xR, sc.yE)).toBe(d.id);
  });

  it("широкие свечи (36 px): край — последняя свеча не правее width − 8, а не ближайшая (за краем)", () => {
    for (const pxBar of [36, 44, 60]) {
      for (const x of [500, 640, 800, 930]) {
        const s = setup({ pxBar });
        s.ctrl.setTool("position-long");
        s.mouse.tap(x, yOf(100));
        const d = s.log.created[0]!;
        const pr = projOf(pxBar).projector();
        const xEnd = pr.x(d.points[1]!.time)!;
        expect(xEnd, `${pxBar} px, x ${x}`).toBeLessThanOrEqual(PLOT_W - 8);
        expect(d.points[1]!.time).toBeGreaterThan(d.points[0]!.time);
        const sc = positionScreen(d, pr)!;
        expect(sc.xR, `${pxBar} px, x ${x}`).toBeLessThanOrEqual(PLOT_W - 8);
      }
    }
  });

  it("без ATR (свечей меньше 14) — стоп на 1 % цены; цены — по шагу инструмента", () => {
    const s = setup({ candles: bars(10), tick: 0.1 });
    s.ctrl.setTool("position-long");
    s.mouse.tap(...at(5, 100));
    const d = s.log.created[0]!;
    expect(d.points[1]!.price).toBe(99);
    expect(d.points[2]!.price).toBe(102);
    const t = setup({ tick: 0.1 });
    t.ctrl.setTool("position-short");
    t.mouse.tap(...at(40, 100));
    const p = t.log.created[0]!.points;
    for (const q of p.slice(1)) expect(Math.round(q.price * 10) / 10).toBe(q.price);
  });

  it("длительность бара — текущего таймфрейма (смена таймфрейма без пересоздания контроллера)", () => {
    let tf = H;
    const s = setup({ tf: () => tf, candles: [] });
    s.ctrl.setTool("position-long");
    tf = H / 4;
    s.mouse.tap(100, 400);
    const d = s.log.created[0]!;
    expect(d.points[1]!.time - d.points[0]!.time).toBe(30 * (H / 4));
  });
});

/** Long: вход 100 на свече 20, стоп 96, цель 108, правый край — свеча 50. На экране: x 200…500, y 400 / 416 / 368. */
const POS: Drawing = {
  id: "P",
  type: "position-long",
  points: [
    { time: T0 + 20 * H, price: 100 },
    { time: T0 + 50 * H, price: 96 },
    { time: T0 + 50 * H, price: 108 },
  ],
  style: { ...DEFAULT_STYLE, color: "up" },
  locked: false,
  timeframe: null,
  updated_at: 0,
};

describe("позиция: ручки и тело", () => {
  const last = (s: ReturnType<typeof setup>) => s.log.moves.at(-1)!;

  it("конец перетаскивания — последнее показанное положение, даже если хозяин ещё не перерисовался", () => {
    const s = setup({ items: [POS], stale: true });
    s.mouse.drag(350, 368, 350, 340);
    const moves = s.log.moves;
    expect(moves.at(-1)!.final).toBe(true);
    expect(moves.at(-1)!.points).toEqual(moves.at(-2)!.points);
    expect(moves.at(-1)!.points[2]!.price).toBe(115);
  });

  it("ручка стопа двигает только стоп (по вертикали); конец — шаг отмены от положения до перетаскивания", () => {
    const s = setup({ items: [POS] });
    const d = s.mouse.down(350, 416);
    expect(d.stopped).toBe(true);
    s.mouse.move(360, 430);
    s.mouse.move(370, 440);
    s.mouse.up(370, 440);
    const m = last(s);
    expect(m.final).toBe(true);
    expect(m.origin).toEqual(POS.points);
    expect(m.points).toEqual([POS.points[0], { time: T0 + 50 * H, price: 90 }, POS.points[2]]);
    expect(s.log.created).toHaveLength(0);
  });

  it("стоп не переходит за вход, цель — тоже, вход остаётся между ними (позиция не выворачивается)", () => {
    const s = setup({ items: [POS], tick: 0.1 });
    s.mouse.drag(350, 416, 350, 300);
    expect(last(s).points[1]!.price).toBe(99.9);
    const t = setup({ items: [POS], tick: 0.1 });
    t.mouse.drag(350, 368, 350, 500);
    expect(last(t).points[2]!.price).toBe(100.1);
    const u = setup({ items: [POS], tick: 0.1 });
    u.mouse.drag(200, 400, 200, 100);
    expect(last(u).points[0]).toEqual({ time: T0 + 20 * H, price: 107.9 });
    const v = setup({ items: [POS] });
    v.mouse.drag(200, 400, 200, 392);
    expect(last(v).points[0]!.price).toBe(102);
    expect(last(v).points.slice(1)).toEqual(POS.points.slice(1));
  });

  it("ручка цели и линия цели по всей длине; правый край — длительность; тело — вся позиция", () => {
    const s = setup({ items: [POS] });
    s.mouse.drag(350, 368, 350, 340);
    expect(last(s).points[2]!.price).toBe(115);
    const line = setup({ items: [POS] });
    line.mouse.drag(450, 368, 450, 360);
    expect(last(line).points[2]!.price).toBe(110);
    const end = setup({ items: [POS] });
    end.mouse.drag(500, 400, 600, 420);
    expect(last(end).points).toEqual([POS.points[0], { time: T0 + 60 * H, price: 96 }, { time: T0 + 60 * H, price: 108 }]);
    const body = setup({ items: [POS] });
    body.mouse.drag(300, 384, 330, 404);
    expect(last(body).points).toEqual([
      { time: T0 + 23 * H, price: 95 },
      { time: T0 + 53 * H, price: 91 },
      { time: T0 + 53 * H, price: 103 },
    ]);
  });

  it("палец: ручка выбранной позиции — цель 44 px; график под правкой не едет; невыбранная — касание выбирает", () => {
    const s = setup({ items: [POS], coarse: true });
    // невыбранная: сдвиг по телу — графику
    const pan = s.finger.drag(300, 405, 250, 405);
    expect(pan.d.stopped).toBe(false);
    expect(s.log.moves).toHaveLength(0);
    s.finger.tap(300, 405);
    expect(s.selected()).toBe("P");
    // в 19 px от ручки стопа (у левого края, радиус касания 22): правится стоп — от места касания, без прыжка под
    // палец; touch-события до графика не доходят
    const d = s.finger.down(200 + 15, 416 + 12);
    expect(d.stopped).toBe(true);
    expect(s.touchReachesChart("touchstart", 1)).toBe(false);
    s.finger.move(215, 440);
    expect(s.touchReachesChart("touchmove", 1)).toBe(false);
    s.finger.move(215, 452);
    s.finger.up(215, 452);
    const m = last(s);
    expect(m.final).toBe(true);
    expect(m.points[1]!.price).toBeCloseTo(96 - 6, 9);
    expect(m.points[0]).toEqual(POS.points[0]);
    expect(m.points[2]).toEqual(POS.points[2]);
  });

  it("тело позиции — по шагу цены: сдвиг кратен шагу, цены без хвостов float", () => {
    const pts = [
      { time: T0 + 20 * H, price: 100.1 },
      { time: T0 + 50 * H, price: 96.3 },
      { time: T0 + 50 * H, price: 108.7 },
    ];
    for (const kind of ["mouse", "touch"] as const) {
      const s = setup({ items: [{ ...POS, points: pts }], tick: 0.1, coarse: kind === "touch" });
      // выбрать касанием (кликом): тело выбранного палец тянет после касания по нему
      s.pointer(kind).tap(300, 384);
      expect(s.selected()).toBe("P");
      // сдвиг на 19.3 px — 4.825 цены: не кратно шагу
      s.pointer(kind).drag(300, 384, 300, 403.3);
      const m = last(s);
      expect(m.final).toBe(true);
      for (const p of m.points) expect(Number(p.price.toFixed(1))).toBe(p.price);
      const d0 = m.points[0]!.price - pts[0]!.price;
      expect(Number((m.points[1]!.price - pts[1]!.price).toFixed(9))).toBe(Number(d0.toFixed(9)));
      expect(Number((m.points[2]!.price - pts[2]!.price).toFixed(9))).toBe(Number(d0.toFixed(9)));
    }
  });

  it("правый край — от показанного края: прежняя позиция со стопом левее входа или на свече входа не схлопывается", () => {
    // прежняя (три нажатия): вход на свече 40, стоп на 20, цель на 60 — на экране свечи 20…40 (x 200…400)
    const old: Drawing = { ...POS, points: [{ time: T0 + 40 * H, price: 100 }, { time: T0 + 20 * H, price: 96 }, { time: T0 + 60 * H, price: 108 }] };
    const s = setup({ items: [old] });
    expect(positionScreen(old, projOf(PX_BAR).projector())).toMatchObject({ xL: 200, xR: 400 });
    s.mouse.drag(400, 400, 420, 400);
    let sc = positionScreen({ type: "position-long", points: last(s).points }, projOf(PX_BAR).projector())!;
    expect([sc.xL, sc.xR]).toEqual([200, 420]);
    // все три точки на свече входа: край нарисован на 40 px правее — ручка идёт за указателем сразу, без мёртвой зоны
    const same: Drawing = { ...POS, points: [{ time: T0 + 40 * H, price: 100 }, { time: T0 + 40 * H, price: 96 }, { time: T0 + 40 * H, price: 108 }] };
    const t = setup({ items: [same] });
    t.mouse.down(440, 400);
    for (const dx of [10, 20]) {
      t.mouse.move(440 + dx, 400);
      sc = positionScreen({ type: "position-long", points: last(t).points }, projOf(PX_BAR).projector())!;
      expect(sc.xR).toBe(440 + dx);
    }
    t.mouse.up(460, 400);
    // отдалённый график (1 px на свечу): 30 свечей — 30 px, нарисовано 40 — ручка тоже сразу идёт за указателем
    const far = setup({ items: [POS], pxBar: 1 });
    far.mouse.down(60, 400);
    far.mouse.move(70, 400);
    sc = positionScreen({ type: "position-long", points: last(far).points }, projOf(1).projector())!;
    expect(sc.xR).toBe(70);
  });

  it("попадание: ручки раньше линий, линии раньше тела, правый край по высоте позиции", () => {
    const s = setup({ items: [POS] });
    expect(s.ctrl.hitAt(200, 400)).toBe("P");
    expect(s.ctrl.hitAt(505, 380)).toBe("P");
    expect(s.ctrl.hitAt(300, 390)).toBe("P");
    expect(s.ctrl.hitAt(600, 390)).toBeNull();
    expect(s.ctrl.hitAt(300, 300)).toBeNull();
  });
});

describe("сдвиг рисунка за тело на логарифмической шкале", () => {
  /** Логарифмическая шкала: 400 px на декаду, 1000 — у верхнего края. */
  const yLog = (price: number) => (3 - Math.log10(price)) * 400;
  const LOG: DrawProjector = {
    timeAt: (x) => T0 + (x / PX_BAR) * H,
    priceAt: (y) => 10 ** (3 - y / 400),
    projector: () => ({ x: xOf, y: (p) => (p > 0 ? yLog(p) : null), width: PLOT_W, height: PLOT_H }),
  };
  const FIB_LOG: Drawing = { id: "f", type: "fib", points: [{ time: T0 + 20 * H, price: 100 }, { time: T0 + 60 * H, price: 200 }], style: DEFAULT_STYLE, locked: false, timeframe: null, updated_at: 0 };

  it("Фибоначчи едет за указателем как целое: высота в пикселях та же, нижняя точка не уходит в ноль", () => {
    const t = setup({ items: [FIB_LOG], proj: LOG });
    const h0 = yLog(100) - yLog(200);
    // за тело вниз на 200 px (и на 5 свечей вправо)
    t.mouse.drag(400, 340, 450, 540, 8);
    const [a, b] = t.items()[0]!.points;
    // раньше: одна разница цен для обеих точек — A = 3.4, B = 103.4, высота 598 px вместо 120
    expect(yLog(a!.price) - yLog(100)).toBeCloseTo(200, 6);
    expect(yLog(b!.price) - yLog(200)).toBeCloseTo(200, 6);
    expect(yLog(a!.price) - yLog(b!.price)).toBeCloseTo(h0, 6);
    expect(b!.price / a!.price).toBeCloseTo(2, 9);
    expect(a!.time).toBe(T0 + 25 * H);
    expect(b!.time).toBe(T0 + 65 * H);
    // и дальше вниз, пока указатель на обычной цене: обе цены положительные
    t.mouse.drag(450, 540, 450, 740, 8);
    for (const p of t.items()[0]!.points) expect(p.price).toBeGreaterThan(0);
  });

  it("на линейной шкале сдвиг за тело — прежний: та же разница цен у всех точек", () => {
    const fib: Drawing = { ...FIB_LOG, points: [{ time: T0 + 20 * H, price: 100 }, { time: T0 + 60 * H, price: 120 }] };
    const t = setup({ items: [fib] });
    t.mouse.drag(400, 360, 430, 400, 5);
    const [a, b] = t.items()[0]!.points;
    expect(a!.price).toBeCloseTo(90, 9);
    expect(b!.price).toBeCloseTo(110, 9);
    expect([a!.time, b!.time]).toEqual([T0 + 23 * H, T0 + 63 * H]);
  });
});

