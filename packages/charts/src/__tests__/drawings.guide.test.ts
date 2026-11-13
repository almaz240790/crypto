import { describe, expect, it } from "vitest";
import type { DrawGuide } from "../drawings/controller";
import { formatDrawingPrice } from "../drawings/labels";
import { DrawingsPrimitive } from "../drawings/primitive";
import { GUIDE_GAP_PX, type Drawing } from "../drawings/types";
import type { ThemeTokens } from "../types";
import { bars, H, makeEnv, T0, TOKENS } from "./fakes/lwc";

/**
 * Направляющая точки на графике (просьба владельца «нужно когда нажимаешь не точку а линия горизонтальная чтоб поймать
 * край свечи»; ADR-0009, «Рисование», дополнение 2026-11-13): горизонталь через всю панель на цене точки, метка этой
 * цены на шкале (как метки разметки: фон — салатовый выбора и действий, текст — цвет поверхности), у пальца — и
 * пунктирная вертикаль на времени точки; точка на краю свечи (магнит) отмечена. Временная: подписи и попадание не
 * трогает, перекрестие LWC по горизонтали на это время скрыто (вторая линия и вторая метка у шкалы путали бы).
 */

type Stroke = { style: string; alpha: number; width: number; dash: number[]; x0: number; y0: number; x1: number; y1: number };
type Arc = { x: number; y: number; r: number; fill: string; stroke: string };

function canvas() {
  const strokes: Stroke[] = [];
  const arcs: Arc[] = [];
  let path: { x: number; y: number }[] = [];
  let arc: { x: number; y: number; r: number } | null = null;
  let dash: number[] = [];
  const st = { strokeStyle: "", fillStyle: "", lineWidth: 1, globalAlpha: 1, font: "", textBaseline: "" };
  const stack: (typeof st & { dash: number[] })[] = [];
  const ctx = Object.assign(st, {
    save: () => stack.push({ ...st, dash }),
    restore: () => {
      const s0 = stack.pop()!;
      dash = s0.dash;
      Object.assign(st, s0);
    },
    setLineDash: (d: number[]) => (dash = d),
    beginPath: () => {
      path = [];
      arc = null;
    },
    moveTo: (x: number, y: number) => path.push({ x, y }),
    lineTo: (x: number, y: number) => path.push({ x, y }),
    stroke: () => {
      if (arc) {
        const last = arcs[arcs.length - 1];
        if (last && last.x === arc.x && last.y === arc.y) last.stroke = st.strokeStyle;
        return;
      }
      strokes.push({ style: st.strokeStyle, alpha: st.globalAlpha, width: st.lineWidth, dash: [...dash], x0: path[0]?.x ?? NaN, y0: path[0]?.y ?? NaN, x1: path[1]?.x ?? NaN, y1: path[1]?.y ?? NaN });
    },
    arc: (x: number, y: number, r: number) => (arc = { x, y, r }),
    fill: () => {
      if (arc) arcs.push({ ...arc, fill: st.fillStyle, stroke: "" });
    },
    fillText: () => undefined,
    fillRect: () => undefined,
    strokeRect: () => undefined,
    measureText: (t: string) => ({ width: t.length * 6 }),
    rect: () => undefined,
    closePath: () => undefined,
  });
  return { ctx, strokes, arcs };
}

const PANE_W = 800;
const PANE_H = 400;
const candles = bars(60);

function setup(tokens: ThemeTokens = TOKENS) {
  const env = makeEnv(() => candles, { top: 150, bottom: 70 });
  const updates = { n: 0 };
  const prim = new DrawingsPrimitive(tokens);
  prim.attached({ chart: env.chart, series: env.series, requestUpdate: () => updates.n++ } as never);
  prim.projector!.setBars(candles.map((c) => c.time), H);
  const paint = () => {
    const c = canvas();
    prim.paneViews()[0]!.renderer()!.draw({ useMediaCoordinateSpace: (cb: (s: unknown) => void) => cb({ context: c.ctx, mediaSize: { width: PANE_W, height: PANE_H } }) } as never);
    return c;
  };
  const y = (price: number) => env.series.priceToCoordinate(price);
  const x = (time: number) => prim.projector!.x(time)!;
  return { env, prim, paint, x, y, updates };
}

const G = (o: Partial<DrawGuide> = {}): DrawGuide => ({ time: T0 + 20 * H, price: 104.25, snapped: false, touch: false, ...o });
/** Горизонталь через всю панель на высоте y. */
const across = (c: ReturnType<typeof canvas>, y: number) => c.strokes.filter((s) => s.y0 === s.y1 && Math.abs(s.y0 - y) < 1e-9 && s.x0 === 0 && s.x1 === PANE_W);
/** Вертикальные отрезки на x (сверху вниз). */
const down = (c: ReturnType<typeof canvas>, x: number) => c.strokes.filter((s) => s.x0 === s.x1 && Math.abs(s.x0 - x) < 1e-9).sort((a, b) => a.y0 - b.y0);

describe("направляющая на панели", () => {
  it("мышь: горизонталь салатовым через всю панель на цене точки, сплошная; вертикали нет (её даёт перекрестие LWC)", () => {
    const s = setup();
    expect(across(s.paint(), s.y(104.25)!)).toHaveLength(0);
    s.prim.setGuide(G());
    const c = s.paint();
    const h = across(c, s.y(104.25)!);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ style: TOKENS.accent, alpha: 1, width: 1, dash: [] });
    expect(down(c, s.x(T0 + 20 * H))).toHaveLength(0);
    // не на краю свечи — без отметки
    expect(c.arcs).toHaveLength(0);
  });

  it("палец: и пунктирная вертикаль на времени точки через всю панель с разрывом у точки — палец закрывает точку, а линии видны", () => {
    const s = setup();
    s.prim.setGuide(G({ touch: true }));
    const c = s.paint();
    expect(across(c, s.y(104.25)!)).toHaveLength(1);
    const v = down(c, s.x(T0 + 20 * H));
    expect(v).toHaveLength(2);
    for (const st of v) {
      expect(st.style).toBe(TOKENS.accent);
      expect(st.dash.length).toBeGreaterThan(0);
      expect(st.alpha).toBeLessThan(1);
    }
    const y = s.y(104.25)!;
    expect(v[0]).toMatchObject({ y0: 0, y1: y - GUIDE_GAP_PX });
    expect(v[1]).toMatchObject({ y0: y + GUIDE_GAP_PX, y1: PANE_H });
  });

  it("палец: разрыв вертикали — над всей свечой точки (от максимума до минимума): фитиль, край которого ловят, не закрыт", () => {
    const s = setup();
    s.prim.candles = () => candles;
    const k = candles[20]!;
    s.prim.setGuide(G({ price: k.low, snapped: true, touch: true }));
    const v = down(s.paint(), s.x(k.time));
    expect(v).toHaveLength(2);
    expect(v[0]!.y0).toBe(0);
    expect(v[0]!.y1).toBeCloseTo(s.y(k.high)! - GUIDE_GAP_PX, 9);
    expect(v[1]!.y0).toBeCloseTo(s.y(k.low)! + GUIDE_GAP_PX, 9);
    expect(v[1]!.y1).toBe(PANE_H);
    // правее последней свечи (свечи нет) — разрыв только у точки
    s.prim.setGuide(G({ time: T0 + 80 * H, price: 100, touch: true }));
    const w = down(s.paint(), s.x(T0 + 80 * H));
    expect(w.map((st) => [st.y0, st.y1])).toEqual([[0, s.y(100)! - GUIDE_GAP_PX], [s.y(100)! + GUIDE_GAP_PX, PANE_H]]);
  });

  it("точка на краю свечи (магнит) — отметка салатовым на точке, с ободком цвета поверхности", () => {
    const s = setup();
    const k = candles[20]!;
    s.prim.setGuide(G({ price: k.high, snapped: true }));
    const c = s.paint();
    expect(across(c, s.y(k.high)!)).toHaveLength(1);
    expect(c.arcs).toHaveLength(1);
    expect(c.arcs[0]).toMatchObject({ x: s.x(k.time), y: s.y(k.high)!, fill: TOKENS.accent, stroke: TOKENS.surface });
  });

  it("рисуется под рисунками, отметка — поверх ручек начатого рисунка", () => {
    const s = setup();
    const k = candles[20]!;
    const draft: Drawing = { id: "d", type: "trend", points: [{ time: T0 + 5 * H, price: 120 }, { time: k.time, price: k.high }], style: { color: "text2", width: 1, dashed: false }, locked: false, timeframe: null, updated_at: 0 };
    s.prim.update({ draft });
    s.prim.setGuide(G({ price: k.high, snapped: true }));
    const c = s.paint();
    const gi = c.strokes.findIndex((st) => st.style === TOKENS.accent && st.x0 === 0 && st.x1 === PANE_W);
    const di = c.strokes.findIndex((st) => st.style === TOKENS.text2);
    expect(gi).toBeGreaterThanOrEqual(0);
    expect(di).toBeGreaterThan(gi);
    // ручки начатого — кольца цвета рисунка; отметка магнита — последней
    expect(c.arcs.at(-1)).toMatchObject({ fill: TOKENS.accent });
    expect(c.arcs.slice(0, -1).every((a) => a.stroke === TOKENS.text2)).toBe(true);
  });

  it("убрали — ни линии, ни отметки", () => {
    const s = setup();
    s.prim.setGuide(G({ snapped: true, touch: true }));
    s.prim.setGuide(null);
    const c = s.paint();
    expect(c.strokes.filter((st) => st.style === TOKENS.accent)).toHaveLength(0);
    expect(c.arcs).toHaveLength(0);
  });
});

describe("метка цены направляющей на шкале", () => {
  it("один постоянный вид; есть направляющая — цена с точностью инструмента на её высоте, фон салатовый, текст цвета поверхности; нет — скрыта", () => {
    const s = setup();
    const views = s.prim.priceAxisViews();
    expect(s.prim.priceAxisViews()).toBe(views);
    expect(views).toHaveLength(1);
    const v = views[0]!;
    expect(v.visible?.()).toBe(false);
    s.prim.update({ precision: 1 });
    s.prim.setGuide(G());
    expect(v.visible?.()).toBe(true);
    expect(v.text()).toBe(formatDrawingPrice(104.25, 1));
    expect(v.text()).toBe("104.3");
    expect(v.fixedCoordinate?.()).toBeCloseTo(s.y(104.25)!, 9);
    expect(v.backColor()).toBe(TOKENS.accent);
    expect(v.textColor()).toBe(TOKENS.surface);
    expect(v.tickVisible?.()).toBe(true);
    s.prim.setGuide(null);
    expect(v.visible?.()).toBe(false);
  });

  it("светлая тема: тёмно-зелёный фон и белый текст (как у меток разметки)", () => {
    const light: ThemeTokens = { ...TOKENS, surface: "#ffffff", accent: "#3f6212" };
    const s = setup(light);
    s.prim.setGuide(G());
    const v = s.prim.priceAxisViews()[0]!;
    expect(v.backColor()).toBe("#3f6212");
    expect(v.textColor()).toBe("#ffffff");
  });

  it("шкала цены сдвинулась (масштаб колесом при наведении) — метка на новой высоте той же цены после updateAllViews", () => {
    const s = setup();
    s.prim.setGuide(G());
    const v = s.prim.priceAxisViews()[0]!;
    const y0 = v.fixedCoordinate?.();
    s.env.priceState.top = 130;
    s.prim.updateAllViews();
    expect(v.fixedCoordinate?.()).not.toBe(y0);
    expect(v.fixedCoordinate?.()).toBeCloseTo(s.y(104.25)!, 9);
  });

  it("без точности инструмента — запись подписей рисунков", () => {
    const s = setup();
    s.prim.setGuide(G({ price: 81234.56 }));
    expect(s.prim.priceAxisViews()[0]!.text()).toBe(formatDrawingPrice(81234.56, null));
  });
});

describe("направляющая временная: подписи, попадание и перерисовка", () => {
  it("подписи рисунков (кандидаты общей раскладки) те же — с направляющей и без", () => {
    const s = setup();
    const fib: Drawing = { id: "F", type: "fib", points: [{ time: T0 + 10 * H, price: 120 }, { time: T0 + 40 * H, price: 80 }], style: { color: "text2", width: 1, dashed: false }, locked: false, timeframe: null, updated_at: 0 };
    s.prim.update({ drawings: [fib], selectedId: "F" });
    const measure = { measure: (t: string) => ({ w: t.length * 6, h: 12 }), clear: () => undefined } as never;
    const before = JSON.stringify(s.prim.labelCandidates(measure));
    s.prim.setGuide(G({ touch: true, snapped: true }));
    expect(JSON.stringify(s.prim.labelCandidates(measure))).toBe(before);
  });

  it("перерисовка только при смене: та же направляющая ещё раз — без запроса кадра", () => {
    const s = setup();
    const n0 = s.updates.n;
    s.prim.setGuide(G());
    expect(s.updates.n).toBe(n0 + 1);
    s.prim.setGuide(G());
    expect(s.updates.n).toBe(n0 + 1);
    s.prim.setGuide(G({ price: 105 }));
    expect(s.updates.n).toBe(n0 + 2);
    s.prim.setGuide(null);
    s.prim.setGuide(null);
    expect(s.updates.n).toBe(n0 + 3);
  });

  it("горизонталь перекрестия LWC скрыта, пока есть направляющая (одна линия и одна метка у шкалы); переключается один раз, а не на каждом сдвиге", () => {
    const s = setup();
    const hide = { crosshair: { horzLine: { visible: false, labelVisible: false } } };
    const show = { crosshair: { horzLine: { visible: true, labelVisible: true } } };
    expect(s.env.chart.applied).toEqual([]);
    s.prim.setGuide(G());
    s.prim.setGuide(G({ price: 105 }));
    s.prim.setGuide(G({ price: 106, touch: true }));
    expect(s.env.chart.applied).toEqual([hide]);
    s.prim.setGuide(null);
    expect(s.env.chart.applied).toEqual([hide, show]);
    s.prim.setGuide(null);
    expect(s.env.chart.applied).toEqual([hide, show]);
  });

  it("смена типа графика (серия пересоздана) — перекрестие возвращено при отсоединении, направляющая снова скрывает его на новой серии", () => {
    const s = setup();
    s.prim.setGuide(G());
    s.prim.detached();
    expect(s.env.chart.applied.at(-1)).toEqual({ crosshair: { horzLine: { visible: true, labelVisible: true } } });
    s.prim.attached({ chart: s.env.chart, series: s.env.series, requestUpdate: () => undefined } as never);
    expect(s.env.chart.applied.at(-1)).toEqual({ crosshair: { horzLine: { visible: false, labelVisible: false } } });
  });

  it("снимок для e2e: цена, текст метки, высота, палец и магнит", () => {
    const s = setup();
    expect(s.prim.guideDebug()).toBeNull();
    s.prim.update({ precision: 2 });
    s.prim.setGuide(G({ touch: true, snapped: true }));
    expect(s.prim.guideDebug()).toEqual({ price: 104.25, text: "104.25", y: s.y(104.25), touch: true, snapped: true });
  });
});
