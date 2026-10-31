import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "../types";

/**
 * Terminal на поддельном LWC (план 2A.7): подгрузка истории не сдвигает вид и не идёт каскадом, закрытие
 * свечи не сбрасывает масштаб, формат цены инструмента переживает смену типа графика, сброс вида — от ширины.
 *
 * Шкала времени подделки ведёт себя как у LWC 5 (model.updateTimeScale): общая для всех серий, вид задаётся
 * правым отступом от последней точки; при добавлении точек справа отступ компенсируется, только если
 * последний бар не был виден (иначе вид едет за новым баром), при выпадении точек слева отступ не меняется.
 */

type Range = { from: number; to: number };
type FakeSeries = {
  kind: string;
  pane: number;
  opts: Record<string, unknown>;
  data: { time: number }[];
  setDataCalls: number;
  updateCalls: number;
  setData(d: { time: number }[]): void;
  update(p: { time: number }): void;
  applyOptions(o: Record<string, unknown>): void;
  options(): Record<string, unknown>;
  priceScale(): { applyOptions(): void };
  attachPrimitive(): void;
  detachPrimitive(): void;
};

const state = vi.hoisted(() => ({ charts: [] as unknown[], times: null as null | (() => number[]), onTimes: null as null | ((before: number[]) => void) }));

vi.mock("lightweight-charts", () => {
  const mkSeries = (kind: string, opts: Record<string, unknown>, pane: number): FakeSeries => {
    const s: FakeSeries = {
      kind,
      pane,
      opts: { ...opts },
      data: [],
      setDataCalls: 0,
      updateCalls: 0,
      setData(d) {
        const before = state.times?.() ?? [];
        s.data = d.slice();
        s.setDataCalls++;
        state.onTimes?.(before);
      },
      update(p) {
        const before = state.times?.() ?? [];
        s.updateCalls++;
        const last = s.data[s.data.length - 1];
        if (last && last.time === p.time) s.data[s.data.length - 1] = p;
        else s.data.push(p);
        state.onTimes?.(before);
      },
      applyOptions(o) {
        Object.assign(s.opts, o);
      },
      options: () => s.opts,
      priceScale: () => ({ applyOptions: () => {} }),
      attachPrimitive: () => {},
      detachPrimitive: () => {},
    };
    return s;
  };
  const createChart = () => {
    const series: FakeSeries[] = [];
    const subs: ((r: Range | null) => void)[] = [];
    let range: Range | null = null;
    const times = () => [...new Set(series.flatMap((s) => s.data.map((d) => d.time)))].sort((a, b) => a - b);
    // как LWC: правый отступ от последней точки сохраняется; новые точки справа при невидимом последнем баре
    // компенсируются (вид на тех же свечах), при видимом — вид едет за новым баром
    const onTimes = (before: number[]) => {
      const after = times();
      if (!range || before.length === 0 || after.length === 0) return;
      const oldBase = before.length - 1;
      const newBase = after.length - 1;
      if (oldBase === newBase && before[0] === after[0]) return;
      let rightOffset = range.to - oldBase;
      const width = range.to - range.from;
      const lastVisible = range.from <= oldBase && oldBase <= range.to;
      const addedRight = newBase > oldBase && !(after[0]! < before[0]!);
      if (addedRight && !lastVisible) rightOffset -= newBase - oldBase;
      const next = { from: newBase + rightOffset - width, to: newBase + rightOffset };
      if (next.from === range.from && next.to === range.to) return;
      range = next;
      subs.forEach((cb) => cb({ ...range! }));
    };
    state.times = times;
    state.onTimes = onTimes;
    const ts = {
      width: () => chart.width,
      options: () => ({ barSpacing: 6 }),
      setCalls: 0,
      subscribeVisibleLogicalRangeChange: (cb: (r: Range | null) => void) => subs.push(cb),
      getVisibleLogicalRange: () => (range ? { ...range } : null),
      setVisibleLogicalRange: (r: Range) => {
        ts.setCalls++;
        range = { from: r.from, to: r.to };
        subs.forEach((cb) => cb({ ...range! }));
      },
      timeToIndex: (t: number) => {
        const all = times();
        const i = all.findIndex((x) => x >= t);
        return i < 0 ? null : i;
      },
      coordinateToLogical: () => null,
    };
    const chart = {
      width: 800,
      series,
      ts,
      applied: [] as Record<string, unknown>[],
      timeAt: (i: number) => times()[Math.floor(i)],
      addSeries: (def: { kind: string }, opts: Record<string, unknown>, pane = 0) => {
        const s = mkSeries(def.kind, opts, pane);
        series.push(s);
        return s;
      },
      removeSeries: (s: FakeSeries) => series.splice(series.indexOf(s), 1),
      timeScale: () => ts,
      priceScale: () => ({ applyOptions: () => {} }),
      applyOptions: (o: Record<string, unknown>) => chart.applied.push(o),
      panes: () => [],
      addPane: () => ({ setHeight: () => {} }),
      remove: () => {},
    };
    state.charts.push(chart);
    return chart;
  };
  return {
    createChart,
    CandlestickSeries: { kind: "Candlestick" },
    BarSeries: { kind: "Bar" },
    LineSeries: { kind: "Line" },
    HistogramSeries: { kind: "Histogram" },
    PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2 },
    ColorType: { Solid: "solid" },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Dashed: 2 },
  };
});

import { EDGE, MAX_CANDLES } from "../buffer";
import { PERCENT_FORMAT, VALUE_FORMAT, instrumentPriceFormat } from "../priceFormat";
import { barsForWidth, createTerminal, VIEW_BAR_PX, VIEW_MAX_BARS, VIEW_MIN_BARS, type Terminal } from "../terminal";

type FakeChart = {
  width: number;
  series: FakeSeries[];
  applied: { layout?: { fontSize?: number; background?: unknown } }[];
  ts: { setCalls: number; getVisibleLogicalRange(): Range | null; setVisibleLogicalRange(r: Range): void };
  timeAt(i: number): number | undefined;
};

const H = 14400;
const T0 = 1_790_000_000 - (1_790_000_000 % H);
const bars = (from: number, n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ time: T0 + (from + i) * H, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, open_: false }));
const tokens = { bg: "#000000", surface: "#000000", border: "#111111", text: "#ffffff", text2: "#eeeeee", text3: "#dddddd", up: "#00ff00", down: "#ff0000", accent: "#c6f432", warn: "#f0b429", ind: ["#123456"], fontSans: "x", fontMono: "y" };
const container = () => ({ addEventListener: () => {}, removeEventListener: () => {}, getBoundingClientRect: () => ({ left: 0 }), clientWidth: 860 }) as unknown as HTMLElement;

let chart: FakeChart;
let requests: number[];
let term: Terminal;

function make(onNeedOlder?: (before: number) => void): Terminal {
  requests = [];
  term = createTerminal(container(), { tokens, onNeedOlder: onNeedOlder ?? ((b) => requests.push(b)) });
  chart = state.charts.at(-1) as FakeChart;
  return term;
}

beforeEach(() => {
  state.charts.length = 0;
});

describe("подгрузка истории слева", () => {
  it("вид остаётся на тех же свечах: диапазон сдвигается на число добавленных баров", () => {
    make();
    term.setCandles(bars(0, 500));
    chart.ts.setVisibleLogicalRange({ from: 350, to: 480 });
    const t0 = chart.timeAt(350);
    term.addOlder(bars(-500, 500), true);
    expect(chart.ts.getVisibleLogicalRange()).toEqual({ from: 850, to: 980 });
    expect(chart.timeAt(850)).toBe(t0);
    expect(term.candles.length).toBe(1000);
  });

  it("один запрос на один подход к краю: без каскада, даже если ответ приходит сразу", () => {
    const pages: number[] = [];
    make((before) => {
      pages.push(before);
      // сервер отвечает сразу полной порцией, история бесконечна — раньше это давало 21 запрос подряд
      const first = (before - T0) / H;
      queueMicrotask(() => term.addOlder(bars(first - 500, 500), true));
    });
    term.setCandles(bars(0, 500));
    chart.ts.setVisibleLogicalRange({ from: 90, to: 240 });
    return new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() => {
      expect(pages).toHaveLength(1);
      // те же свечи на экране, свежий край не выгружен
      expect(chart.ts.getVisibleLogicalRange()).toEqual({ from: 590, to: 740 });
      expect(term.candles.at(-1)!.time).toBe(T0 + 499 * H);
    });
  });

  it("короткая порция у края не запускает следующую, пока пользователь не отойдёт от края", () => {
    make();
    term.setCandles(bars(0, 500));
    chart.ts.setVisibleLogicalRange({ from: 40, to: 190 });
    expect(requests).toHaveLength(1);
    term.addOlder(bars(-30, 30), true);
    expect(chart.ts.getVisibleLogicalRange()!.from).toBe(70);
    chart.ts.setVisibleLogicalRange({ from: 60, to: 210 });
    expect(requests).toHaveLength(1);
    // ушёл от края и вернулся — новый подход, новая порция
    chart.ts.setVisibleLogicalRange({ from: EDGE + 50, to: EDGE + 200 });
    chart.ts.setVisibleLogicalRange({ from: 10, to: 160 });
    expect(requests).toHaveLength(2);
  });

  it("неудачный запрос не блокирует подгрузку навсегда", () => {
    make();
    term.setCandles(bars(0, 500));
    chart.ts.setVisibleLogicalRange({ from: 40, to: 190 });
    term.olderFailed();
    chart.ts.setVisibleLogicalRange({ from: EDGE + 10, to: EDGE + 160 });
    chart.ts.setVisibleLogicalRange({ from: 20, to: 170 });
    expect(requests).toHaveLength(2);
  });

  it("полный буфер: свежие свечи не выгружаются, живые обновления продолжают приходить", () => {
    make();
    term.setCandles(bars(0, MAX_CANDLES - 100));
    chart.ts.setVisibleLogicalRange({ from: 10, to: 160 });
    term.addOlder(bars(-500, 500), true);
    expect(term.candles.length).toBe(MAX_CANDLES);
    expect(term.candles.at(-1)!.time).toBe(T0 + (MAX_CANDLES - 101) * H);
    // дальше влево не грузим: буфер полон
    chart.ts.setVisibleLogicalRange({ from: EDGE + 10, to: EDGE + 160 });
    chart.ts.setVisibleLogicalRange({ from: 0, to: 150 });
    expect(requests).toHaveLength(1);
    const next = bars(MAX_CANDLES - 100, 1)[0]!;
    term.update({ ...next, open_: true });
    expect(term.candles.at(-1)!.time).toBe(next.time);
  });
});

describe("закрытие свечи и живые обновления", () => {
  it("новая свеча добавляется инкрементально: без setData и без сброса вида", () => {
    make();
    term.setCandles(bars(0, 500));
    chart.ts.setVisibleLogicalRange({ from: 130, to: 285 });
    const main = chart.series[0]!;
    const setData = main.setDataCalls;
    const setRange = chart.ts.setCalls;
    const last = term.candles.at(-1)!;
    term.update({ ...last, close: 1.7 }); // текущая свеча
    term.update({ ...bars(500, 1)[0]!, open_: true }); // закрылась, началась новая
    expect(main.setDataCalls).toBe(setData);
    expect(chart.ts.setCalls).toBe(setRange);
    expect(main.updateCalls).toBe(2);
    expect(chart.ts.getVisibleLogicalRange()).toEqual({ from: 130, to: 285 });
    expect(term.candles.length).toBe(501);
  });

  it("полный буфер, вид у правого края: новая свеча остаётся в кадре с тем же отступом справа", () => {
    make();
    term.setCandles(bars(0, MAX_CANDLES));
    term.resetView(VIEW_BAR_PX.desktop);
    const r0 = chart.ts.getVisibleLogicalRange()!;
    const setRange = chart.ts.setCalls;
    // раньше каждое закрытие съедало бар отступа справа, и с 7-го живая свеча уходила за край
    for (let k = 0; k < 9; k++) {
      const cur = term.candles.at(-1)!;
      term.update({ ...cur, close: 1.6 });
      term.update({ ...bars(MAX_CANDLES + k, 1)[0]!, open_: true });
      expect(term.candles.length).toBe(MAX_CANDLES);
      expect(chart.ts.getVisibleLogicalRange()).toEqual(r0);
      expect(chart.timeAt(MAX_CANDLES - 1)).toBe(T0 + (MAX_CANDLES + k) * H);
    }
    expect(chart.ts.setCalls).toBe(setRange);
  });

  it("полный буфер, вид в истории: закрытие свечи не сдвигает вид, в том числе с серией отдельной панели от первой свечи", () => {
    make();
    term.setCandles(bars(0, MAX_CANDLES));
    // OBV/объём на отдельной панели — с первой свечи; TerminalView пересчитывает его после term.update
    const obv = term.addLine(1, "#123456", 1, VALUE_FORMAT);
    const syncObv = () => obv.setData(term.candles.map((c) => ({ time: c.time as never, value: 1 })));
    syncObv();
    chart.ts.setVisibleLogicalRange({ from: 2000, to: 2100 });
    const t0 = chart.timeAt(2000);
    const setRange = chart.ts.setCalls;
    for (let k = 0; k < 5; k++) {
      term.update({ ...bars(MAX_CANDLES + k, 1)[0]!, open_: true });
      syncObv();
      const r = chart.ts.getVisibleLogicalRange()!;
      expect(chart.timeAt(r.from)).toBe(t0);
      expect(r.to - r.from).toBe(100);
    }
    // вид не задаётся явно: в LWC setVisibleLogicalRange откладывается до отрисовки и перебил бы сдвиг шкалы
    expect(chart.ts.setCalls).toBe(setRange);
  });

  it("история, загруженная слева, после закрытия свечи остаётся", () => {
    make();
    term.setCandles(bars(0, 500));
    chart.ts.setVisibleLogicalRange({ from: 30, to: 180 });
    term.addOlder(bars(-500, 500), true);
    term.update({ ...bars(500, 1)[0]!, open_: true });
    expect(term.candles.length).toBe(1001);
    expect(term.candles[0]!.time).toBe(T0 - 500 * H);
  });
});

describe("формат цены инструмента", () => {
  it("основная серия и наложенные линии получают шаг цены; формат переживает смену типа графика", () => {
    make();
    const f = instrumentPriceFormat("1.000E-7");
    term.setPriceFormat(f);
    expect(chart.series[0]!.opts.priceFormat).toBe(f);
    const ema = term.addLine(0, "#123456");
    const funding = term.addLine(1, "#123456", 1, PERCENT_FORMAT);
    expect((ema as unknown as FakeSeries).opts.priceFormat).toBe(f);
    expect((funding as unknown as FakeSeries).opts.priceFormat).toBe(PERCENT_FORMAT);
    term.setType("bars");
    const main = chart.series.find((s) => s.kind === "Bar")!;
    expect(main.opts.priceFormat).toBe(f);
    const g = instrumentPriceFormat("0.1");
    term.setPriceFormat(g);
    expect(main.opts.priceFormat).toBe(g);
    expect((ema as unknown as FakeSeries).opts.priceFormat).toBe(g);
    expect((funding as unknown as FakeSeries).opts.priceFormat).toBe(PERCENT_FORMAT);
  });
});

describe("наложенный инструмент и индексы шкалы", () => {
  it("точки наложения — только на времени свечей; сброс вида показывает последние свечи, а не прошлое наложения", () => {
    make();
    term.setCandles(bars(0, 101));
    // у наложенного инструмента история длиннее: 200 баров до первой свечи основного и 10 после последней
    term.setOverlay(bars(-200, 311), "#f0b429");
    const ov = chart.series.at(-1)!;
    expect(ov.data[0]!.time).toBe(T0);
    expect(ov.data).toHaveLength(101);
    term.resetView(VIEW_BAR_PX.desktop);
    expect(chart.ts.getVisibleLogicalRange()).toEqual({ from: 101 - 95, to: 106 });
    expect(chart.timeAt(100)).toBe(T0 + 100 * H);
    // подгрузка слева и новая свеча справа — наложение на новом наборе свечей
    term.addOlder(bars(-100, 100), true);
    expect(ov.data[0]!.time).toBe(T0 - 100 * H);
    term.update({ ...bars(101, 1)[0]!, open_: true });
    expect(ov.data.at(-1)!.time).toBe(T0 + 101 * H);
    expect(ov.data).toHaveLength(202);
    term.setOverlay(null, "#f0b429");
    expect(chart.series).not.toContain(ov);
  });

  it("сброс вида и подгрузка слева считают индексы по шкале времени, а не по длине буфера", () => {
    make();
    term.setCandles(bars(0, 400));
    // серия с точками левее первой свечи (раньше — несрезанное наложение): шкала длиннее буфера на 50
    term.addLine(0, "#123456").setData(bars(-50, 50).map((c) => ({ time: c.time as never, value: 1 })));
    term.resetView(VIEW_BAR_PX.desktop);
    expect(chart.ts.getVisibleLogicalRange()).toEqual({ from: 450 - 95, to: 455 });
    expect(chart.timeAt(449)).toBe(T0 + 399 * H);
    // левый край вида — в 70 барах от первой свечи (индекс шкалы 120): это подход к краю
    expect(requests).toHaveLength(0);
    chart.ts.setVisibleLogicalRange({ from: 120, to: 220 });
    expect(requests).toHaveLength(1);
  });
});

describe("шрифт шкал", () => {
  it("размер шрифта телефона переживает смену темы", () => {
    make();
    term.setFontSize(10);
    term.setTheme({ ...tokens, surface: "#ffffff" });
    const last = chart.applied.at(-1)!;
    expect(last.layout?.fontSize).toBe(10);
    expect(last.layout?.background).toBeDefined();
  });
});

describe("сброс вида от ширины", () => {
  it("число свечей — ширина / целевой шаг бара, в пределах 40…150", () => {
    expect(barsForWidth(806, VIEW_BAR_PX.desktop)).toBe(96);
    expect(barsForWidth(334, VIEW_BAR_PX.phone)).toBe(51);
    expect(barsForWidth(200, VIEW_BAR_PX.phone)).toBe(VIEW_MIN_BARS);
    expect(barsForWidth(3000, VIEW_BAR_PX.desktop)).toBe(VIEW_MAX_BARS);
    expect(barsForWidth(0, VIEW_BAR_PX.desktop)).toBe(100);
  });

  it("resetView ставит диапазон по ширине области, а не фиксированные 150 свечей", () => {
    make();
    term.setCandles(bars(0, 500));
    chart.width = 800;
    term.resetView(VIEW_BAR_PX.desktop);
    expect(chart.ts.getVisibleLogicalRange()).toEqual({ from: 500 - 95, to: 505 });
    chart.width = 340;
    term.resetView(VIEW_BAR_PX.phone);
    expect(chart.ts.getVisibleLogicalRange()).toEqual({ from: 500 - 52, to: 505 });
  });
});
