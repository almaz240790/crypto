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
  update(p: { time: number }, historical?: boolean): void;
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
      update(p, historical) {
        const before = state.times?.() ?? [];
        s.updateCalls++;
        const last = s.data[s.data.length - 1];
        const i = historical ? s.data.findIndex((d) => d.time === p.time) : -1;
        if (i >= 0) s.data[i] = p;
        else if (last && last.time === p.time) s.data[s.data.length - 1] = p;
        else if (last && p.time < last.time) throw new Error("Cannot update oldest data"); // как LWC без historicalUpdate
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
      applied: [] as Record<string, unknown>[],
      applyOptions: (o: Record<string, unknown>) => ts.applied.push(o),
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
      height: () => 28,
    };
    type FakePane = { stretch: number; height: number; autoScale: boolean; setHeight(h: number): void; getHeight(): number; setStretchFactor(v: number): void; getStretchFactor(): number; paneIndex(): number; moveTo(i: number): void; priceScale(id: string): { options(): { autoScale: boolean }; applyOptions(o: { autoScale?: boolean }): void } };
    const mkPane = (): FakePane => {
      const p: FakePane = {
        stretch: 1,
        height: 100,
        autoScale: true,
        setHeight: (h) => (p.height = h),
        getHeight: () => p.height,
        setStretchFactor: (v) => (p.stretch = v),
        getStretchFactor: () => p.stretch,
        paneIndex: () => chart.paneList.indexOf(p),
        moveTo: () => {
          throw new Error("moveTo сверяет индекс с виджетами панелей — Terminal его не вызывает");
        },
        priceScale: () => ({
          options: () => ({ autoScale: p.autoScale }),
          applyOptions: (o) => {
            if (o.autoScale !== undefined) p.autoScale = o.autoScale;
          },
        }),
      };
      return p;
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
      scales: [] as { id: string; opts: Record<string, unknown> }[],
      priceScale: (id = "right") => ({ applyOptions: (o: Record<string, unknown>) => chart.scales.push({ id, opts: o }) }),
      applyOptions: (o: Record<string, unknown>) => chart.applied.push(o),
      paneList: [] as FakePane[],
      panes: () => chart.paneList,
      swapPanes: (a: number, b: number) => {
        const l = chart.paneList;
        if (!l[a] || !l[b]) throw new Error("Invalid pane index");
        [l[a], l[b]] = [l[b]!, l[a]!];
      },
      addPane: () => {
        const p = mkPane();
        chart.paneList.push(p);
        return p;
      },
      remove: () => {},
    };
    chart.paneList.push(mkPane());
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
import { createTerminal, type Terminal } from "../terminal";
import { chartOptions } from "../theme";

type FakePaneT = { stretch: number; height: number; autoScale: boolean; paneIndex(): number };
type FakeChart = {
  paneList: FakePaneT[];
  width: number;
  series: FakeSeries[];
  applied: { layout?: { fontSize?: number; background?: unknown }; timeScale?: Record<string, unknown>; rightPriceScale?: { scaleMargins?: { top: number } }; handleScroll?: { vertTouchDrag?: boolean; horzTouchDrag?: boolean } }[];
  scales: { id: string; opts: { scaleMargins?: { top: number; bottom: number } } }[];
  ts: { setCalls: number; applied: Record<string, unknown>[]; getVisibleLogicalRange(): Range | null; setVisibleLogicalRange(r: Range): void };
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
    term.resetView(100);
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

describe("уточнение закрытой свечи (ADR-0010)", () => {
  it("запоздавшая минута меняет предпоследний бар точечно: без setData, вид и текущая свеча те же", () => {
    make();
    term.setCandles([...bars(0, 300), { ...bars(300, 1)[0]!, open_: true }]);
    chart.ts.setVisibleLogicalRange({ from: 150, to: 290 });
    const main = chart.series[0]!;
    const vol = chart.series[1]!;
    const setData = main.setDataCalls + vol.setDataCalls;
    const prev = term.candles.at(-2)!;
    term.amend({ ...prev, high: 3, close: 1.9, volume: 7 });
    expect(term.candles.at(-2)).toMatchObject({ time: prev.time, high: 3, close: 1.9, volume: 7 });
    expect(term.candles.length).toBe(301);
    expect(main.data.at(-2)).toMatchObject({ time: prev.time, high: 3, close: 1.9 });
    expect(vol.data.at(-2)).toMatchObject({ time: prev.time, value: 7 });
    expect(main.data.at(-1)).toMatchObject({ time: bars(300, 1)[0]!.time });
    expect(main.setDataCalls + vol.setDataCalls).toBe(setData);
    expect(chart.ts.getVisibleLogicalRange()).toEqual({ from: 150, to: 290 });
    // свечи с таким временем нет — ничего не меняется
    const calls = main.updateCalls;
    term.amend({ ...prev, time: prev.time + 7 });
    expect(main.updateCalls).toBe(calls);
  });

  it("Heikin Ashi: уточнение пересчитывает и текущую свечу справа", () => {
    make();
    term.setCandles([...bars(0, 50), { ...bars(50, 1)[0]!, open_: true }]);
    term.setType("heikin");
    const main = chart.series.find((x) => x.data.length === 51 && x.kind !== "Histogram")!;
    const before = main.data.at(-1);
    term.amend({ ...term.candles.at(-2)!, open: 10, high: 12, low: 9, close: 11 });
    expect(main.data.at(-1)).not.toEqual(before);
    expect(term.candles.length).toBe(51);
  });
});

describe("свежая история справа после пропуска (ADR-0010, W2): догон replaceTail", () => {
  const withGap = () => [...bars(0, 300), { ...bars(303, 1)[0]!, open_: true }]; // 300–302 пропущены

  it("у правого края: пропущенные свечи вставляются, текущая остаётся у края", () => {
    make();
    term.setCandles(withGap());
    chart.ts.setVisibleLogicalRange({ from: 200, to: 305 });
    term.replaceTail(bars(298, 1)[0]!.time, [...bars(298, 5), { ...bars(303, 1)[0]!, close: 1.7, open_: true }]);
    expect(term.candles.length).toBe(304);
    expect(term.candles.slice(-4).map((c) => c.time)).toEqual(bars(300, 4).map((c) => c.time));
    expect(term.candles.at(-1)).toMatchObject({ close: 1.7, open_: true });
    expect(chart.series[0]!.data.length).toBe(304);
    expect(chart.ts.getVisibleLogicalRange()).toEqual({ from: 203, to: 308 });
  });

  it("в прокрученной истории вид на тех же свечах; свечи порции раньше from не берутся", () => {
    make();
    term.setCandles(withGap());
    chart.ts.setVisibleLogicalRange({ from: 50, to: 150 });
    const cur = { ...bars(303, 1)[0]!, open_: true };
    term.replaceTail(bars(300, 1)[0]!.time, [...bars(-5, 3), ...bars(300, 3), cur]);
    expect(term.candles.length).toBe(304);
    expect(term.candles[0]!.time).toBe(bars(0, 1)[0]!.time);
    expect(chart.ts.getVisibleLogicalRange()).toEqual({ from: 50, to: 150 });
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
    term.resetView(100);
    // 100 свечей до последней (индекс 100), справа 104 px при шаге (800 − 104) / 100
    expect(chart.ts.getVisibleLogicalRange()).toEqual({ from: 1, to: 100 + 104 / 6.96 });
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
    term.resetView(100);
    expect(chart.ts.getVisibleLogicalRange()).toEqual({ from: 350, to: 449 + 104 / 6.96 });
    expect(chart.timeAt(449)).toBe(T0 + 399 * H);
    // левый край вида — в 70 барах от первой свечи (индекс шкалы 120): это подход к краю
    expect(requests).toHaveLength(0);
    chart.ts.setVisibleLogicalRange({ from: 120, to: 220 });
    expect(requests).toHaveLength(1);
  });
});

describe("жесты пальцем", () => {
  it("вертикальный жест — сдвиг графика, и после смены темы (тема применяет chartOptions заново)", () => {
    make();
    expect(chartOptions(tokens).handleScroll).toMatchObject({ vertTouchDrag: true, horzTouchDrag: true });
    term.setTheme({ ...tokens, surface: "#ffffff" });
    expect(chart.applied.at(-1)!.handleScroll?.vertTouchDrag).toBe(true);
    expect(chart.applied.at(-1)!.handleScroll?.horzTouchDrag).toBe(true);
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

describe("верхнее поле шкалы цены под легенду (план 2B.9 §10)", () => {
  const topOf = (id: string) => chart.scales.filter((x) => x.id === id && x.opts.scaleMargins).at(-1)?.opts.scaleMargins;

  it("доля панели — в пределах 0.08…0.35; низ (объём) не меняется; мелкие изменения не применяются", () => {
    make();
    term.setTopMargin(0.2);
    expect(topOf("right")).toEqual({ top: 0.2, bottom: 0.2 });
    term.setTopMargin(0.9);
    expect(term.topMarginShare).toBe(0.35);
    term.setTopMargin(0.01);
    expect(term.topMarginShare).toBe(0.08);
    const n = chart.scales.length;
    term.setTopMargin(0.083);
    expect(chart.scales.length).toBe(n);
    term.setTopMargin(Number.NaN);
    expect(term.topMarginShare).toBe(0.08);
  });

  it("переживает смену темы и действует на шкалу наложенного инструмента", () => {
    make();
    term.setCandles(bars(0, 50), false);
    term.setTopMargin(0.25);
    term.setTheme({ ...tokens, surface: "#ffffff" });
    expect(chart.applied.at(-1)!.rightPriceScale?.scaleMargins?.top).toBe(0.08);
    expect(topOf("right")?.top).toBe(0.25);
    term.setOverlay(bars(0, 50), "#999999");
    expect(topOf("overlay")?.top).toBe(0.25);
    term.setTopMargin(0.3);
    expect(topOf("overlay")?.top).toBe(0.3);
  });
});

describe("сброс вида и масштаб у правого края", () => {
  it("resetView(n): n свечей и свободная зона справа rightOffsetPx пикселей", () => {
    make();
    term.setCandles(bars(0, 500));
    chart.width = 800;
    term.resetView(100);
    const r = chart.ts.getVisibleLogicalRange()!;
    expect(r.from).toBe(400);
    // шаг LWC = W / (to − from + 1): ровно (W − R) / n, отступ справа (to − L) · шаг = R
    const spacing = 800 / (r.to - r.from + 1);
    expect(spacing).toBeCloseTo(6.96, 9);
    expect((r.to - 499) * spacing).toBeCloseTo(104, 9);
    chart.width = 340;
    term.setRightOffsetPx(64);
    term.resetView(46);
    const p = chart.ts.getVisibleLogicalRange()!;
    expect(p.from).toBe(454);
    expect((p.to - 499) * (340 / (p.to - p.from + 1))).toBeCloseTo(64, 9);
    expect(chart.ts.applied.at(-1)).toEqual({ rightOffsetPixels: 64 });
  });

  it("свечей меньше n — показываются все, от первой свечи", () => {
    make();
    term.setCandles(bars(0, 30));
    term.resetView(100);
    expect(chart.ts.getVisibleLogicalRange()!.from).toBe(0);
  });

  it("масштаб при видимой последней свече держит правый край и свободную зону в пикселях", () => {
    make();
    term.setCandles(bars(0, 500));
    chart.width = 800;
    term.resetView(100);
    term.zoom(1.25);
    const r = chart.ts.getVisibleLogicalRange()!;
    expect(r.from).toBeCloseTo(420, 9);
    const spacing = 800 / (r.to - r.from + 1);
    expect(spacing).toBeCloseTo(696 / 80, 9);
    expect((r.to - 499) * spacing).toBeCloseTo(104, 9);
    term.zoom(0.8);
    const q = chart.ts.getVisibleLogicalRange()!;
    expect(q.from).toBeCloseTo(400, 9);
    expect((q.to - 499) * (800 / (q.to - q.from + 1))).toBeCloseTo(104, 9);
  });

  it("в истории (последняя свеча за кадром) масштаб — вокруг центра, как раньше", () => {
    make();
    term.setCandles(bars(0, 500));
    chart.ts.setVisibleLogicalRange({ from: 100, to: 200 });
    term.zoom(2);
    expect(chart.ts.getVisibleLogicalRange()).toEqual({ from: 125, to: 175 });
  });

  it("смена темы не сбрасывает шаг бара и отступ справа", () => {
    make();
    term.setTheme({ ...tokens, surface: "#ffffff" });
    const last = chart.applied.at(-1)!;
    expect(last.timeScale?.barSpacing).toBeUndefined();
    expect(last.timeScale?.rightOffset).toBeUndefined();
    expect(last.timeScale?.rightOffsetPixels).toBeUndefined();
  });
});

describe("панели под графиком (ADR-0009, «Управление панелями»)", () => {
  it("addPane возвращает индекс созданной панели и после удаления прежней (раньше — убегающий счётчик)", () => {
    make();
    expect(term.addPane(90)).toBe(1);
    expect(term.addPane(80)).toBe(2);
    chart.paneList.splice(1, 1); // LWC убирает опустевшую панель
    expect(term.addPane(90)).toBe(2);
    expect(chart.paneList).toHaveLength(3);
    expect(chart.paneList[2]!.height).toBe(90);
  });

  it("movePane: основная остаётся первой, индекс приводится к 1 … n − 1", () => {
    make();
    term.addPane();
    term.addPane();
    const [, a, b] = chart.paneList as never as Parameters<Terminal["movePane"]>[0][];
    term.movePane(b!, 1);
    expect(chart.paneList.map((p) => p.paneIndex())).toEqual([0, 1, 2]);
    expect(chart.paneList[1]).toBe(b);
    term.movePane(a!, 0);
    expect(chart.paneList[1]).toBe(a);
    term.movePane(a!, 9);
    expect(chart.paneList[2]).toBe(a);
  });

  it("applyPanePlan и paneHeights: stretch-факторы в пикселях; план не той длины не применяется", () => {
    make();
    term.addPane();
    term.addPane();
    term.applyPanePlan({ main: 500, others: [120, 80] });
    expect(chart.paneList.map((p) => p.stretch)).toEqual([500, 120, 80]);
    term.applyPanePlan({ main: 1, others: [1] });
    expect(chart.paneList.map((p) => p.stretch)).toEqual([500, 120, 80]);
    term.applyPanePlan({ main: 0, others: [0, 300] });
    expect(chart.paneList[0]!.stretch).toBeGreaterThan(0);
    expect(term.paneHeights()).toEqual([100, 100, 100]);
  });

  it("panesTotal: высота контейнера без шкалы времени и линий между панелями; без размеров — сумма панелей", () => {
    make();
    term.addPane();
    expect(term.panesTotal()).toBe(200);
    term = createTerminal({ ...container(), clientHeight: 600 } as unknown as HTMLElement, { tokens });
    chart = state.charts.at(-1) as FakeChart;
    term.addPane();
    term.addPane();
    expect(term.panesTotal()).toBe(600 - 28 - 2);
  });

  it("автомасштаб шкалы панели: чтение, «A», сброс вида возвращает его всем панелям", () => {
    make();
    term.setCandles(bars(0, 200));
    term.addPane();
    expect(term.paneAutoScale(1)).toBe(true);
    chart.paneList[1]!.autoScale = false; // пользователь растянул шкалу RSI
    expect(term.paneAutoScale(1)).toBe(false);
    term.setPaneAutoScale(1, true);
    expect(term.paneAutoScale(1)).toBe(true);
    chart.paneList[1]!.autoScale = false;
    term.resetView(100);
    expect(term.paneAutoScale(1)).toBe(true);
    expect(term.paneAutoScale(7)).toBe(true);
    term.setPaneAutoScale(7, false);
  });
});

/**
 * Автомасштаб правой шкалы основной панели так, как его считает LWC: каждая серия на шкале «right» основной панели
 * даёт диапазон своих данных, autoscaleInfoProvider серии может его заменить (null — серия не участвует).
 */
type Info = { priceRange: { minValue: number; maxValue: number } } | null;
function mainScale(): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const s of chart.series) {
    if (s.pane !== 0 || ((s.opts.priceScaleId as string | undefined) ?? "right") !== "right") continue;
    const base = (): Info => {
      const v = s.data.flatMap((d) => {
        const p = d as { low?: number; high?: number; value?: number };
        return p.low !== undefined ? [p.low, p.high!] : p.value !== undefined ? [p.value] : [];
      });
      return v.length ? { priceRange: { minValue: Math.min(...v), maxValue: Math.max(...v) } } : null;
    };
    const provider = s.opts.autoscaleInfoProvider as ((b: () => Info) => Info) | undefined;
    const info = provider ? provider(base) : base();
    if (!info) continue;
    min = Math.min(min, info.priceRange.minValue);
    max = Math.max(max, info.priceRange.maxValue);
  }
  return { min, max };
}

describe("масштаб только по ценам (продовый баг: свечи сжимались в полосу с индикаторами)", () => {
  it("наложенные индикаторы и сравнение не растягивают шкалу цены; панели индикаторов масштабируются сами", () => {
    make();
    term.setCandles(bars(0, 300)); // low 0.5, high 2
    const far = (v: number) => term.candles.map((c) => ({ time: c.time as never, value: v }));
    // SMA 200 / VWAP далеко от свечей, гистограмма на основной панели, линия на своей панели
    term.addLine(0, "#123456").setData(far(1000));
    term.addLine(0, "#123456", 2).setData(far(-50));
    term.addHistogram(0, "#123456").setData(far(500));
    const rsi = term.addLine(1, "#123456", 1, VALUE_FORMAT);
    rsi.setData(far(70));
    expect(mainScale()).toEqual({ min: 0.5, max: 2 });
    // у линии отдельной панели — свой автомасштаб, без поставщика
    expect((rsi as unknown as FakeSeries).opts.autoscaleInfoProvider).toBeUndefined();
    // сравнение: на своей скрытой шкале — свой масштаб; в процентном режиме делит правую шкалу, но её не растягивает
    term.setOverlay(bars(0, 300).map((c) => ({ ...c, close: 9000 })), "#f0b429");
    const ov = chart.series.at(-1)!;
    const provider = ov.opts.autoscaleInfoProvider as (b: () => Info) => Info;
    const own: Info = { priceRange: { minValue: 9000, maxValue: 9000 } };
    expect(provider(() => own)).toBe(own);
    term.setScaleMode("percent");
    expect(ov.opts.priceScaleId).toBe("right");
    expect(provider(() => own)).toBeNull();
    expect(mainScale()).toEqual({ min: 0.5, max: 2 });
    // основная серия после смены типа графика (линия по закрытиям) по-прежнему задаёт масштаб
    term.setType("line");
    expect(mainScale()).toEqual({ min: 1.5, max: 1.5 });
  });

  it("«A», двойной клик по шкале и «Сбросить вид» на основной панели возвращают масштаб по свечам: дальняя SMA 200 — за краем; поле сверху — под легенду (C1)", () => {
    make();
    term.setCandles(bars(0, 300)); // low 0.5, high 2
    const far = (v: number) => term.candles.map((c) => ({ time: c.time as never, value: v }));
    term.addLine(0, "#123456").setData(far(1000)); // SMA 200 далеко над свечами
    term.addLine(0, "#123456").setData(far(-50)); // VWAP далеко под ними
    term.setTopMargin(0.2); // легенда графика: свечи ниже её строк
    // пользователь растянул шкалу цены (автомасштаб выключен) — «A» на основной панели
    chart.paneList[0]!.autoScale = false;
    expect(term.paneAutoScale(0)).toBe(false);
    term.setPaneAutoScale(0, true);
    expect(term.paneAutoScale(0)).toBe(true);
    expect(mainScale()).toEqual({ min: 0.5, max: 2 });
    // «Сбросить вид» (и двойной клик по шкале — тот же сброс LWC): автомасштаб правой шкалы и шкал панелей; масштаб —
    // по свечам, поле сверху — то же (под легендой), а не 8 % по умолчанию
    const pane = term.addPane(90);
    term.addLine(pane, "#123456", 1, VALUE_FORMAT).setData(far(70));
    chart.paneList[pane]!.autoScale = false;
    term.resetView(100);
    const auto = chart.scales.map((x) => ({ id: x.id, opts: x.opts as { autoScale?: boolean } })).filter((x) => x.id === "right" && x.opts.autoScale !== undefined);
    expect(auto.at(-1)!.opts.autoScale).toBe(true);
    expect(term.paneAutoScale(pane)).toBe(true);
    expect(mainScale()).toEqual({ min: 0.5, max: 2 });
    expect(term.topMarginShare).toBe(0.2);
    // наложенный инструмент на своей шкале получает то же верхнее поле
    term.setOverlay(bars(0, 300).map((c) => ({ ...c, close: 9000 })), "#f0b429");
    expect(chart.scales.filter((x) => x.id === "overlay" && x.opts.scaleMargins).at(-1)!.opts.scaleMargins).toEqual({ top: 0.2, bottom: expect.any(Number) });
  });
});

describe("догон правого края", () => {
  it("вид у правого края едет за новыми свечами с тем же отступом справа; времена не повторяются", () => {
    make();
    term.setCandles(bars(0, 500));
    term.resetView(100);
    const r0 = chart.ts.getVisibleLogicalRange()!;
    // текущая 499 устарела: сервер отдал её закрытой, ещё 30 закрытых и новую текущую
    const fresh = bars(499, 32).map((c, i) => ({ ...c, close: 1.6, open_: i === 31 }));
    term.replaceTail(T0 + 499 * H, fresh);
    expect(term.candles).toHaveLength(531);
    expect(new Set(term.candles.map((c) => c.time)).size).toBe(531);
    expect(term.candles[499]!.close).toBe(1.6);
    const r = chart.ts.getVisibleLogicalRange()!;
    expect(r.from).toBeCloseTo(r0.from + 31, 9);
    expect(r.to).toBeCloseTo(r0.to + 31, 9);
    expect(chart.series[0]!.data).toHaveLength(531);
  });

  it("вид в истории остаётся на тех же свечах, подгруженная слева история сохраняется", () => {
    make();
    term.setCandles(bars(0, 500));
    chart.ts.setVisibleLogicalRange({ from: 30, to: 180 });
    term.addOlder(bars(-500, 500), true);
    chart.ts.setVisibleLogicalRange({ from: 600, to: 700 });
    const t0 = chart.timeAt(600);
    term.replaceTail(T0 + 490 * H, bars(490, 40));
    expect(term.candles[0]!.time).toBe(T0 - 500 * H);
    expect(term.candles).toHaveLength(1030);
    const r = chart.ts.getVisibleLogicalRange()!;
    expect(r).toEqual({ from: 600, to: 700 });
    expect(chart.timeAt(600)).toBe(t0);
  });

  it("полный буфер: выпавшие слева свечи не сдвигают вид в истории", () => {
    make();
    term.setCandles(bars(0, MAX_CANDLES));
    chart.ts.setVisibleLogicalRange({ from: 2000, to: 2100 });
    const t0 = chart.timeAt(2000);
    term.replaceTail(T0 + (MAX_CANDLES - 1) * H, bars(MAX_CANDLES - 1, 11));
    expect(term.candles).toHaveLength(MAX_CANDLES);
    const r = chart.ts.getVisibleLogicalRange()!;
    expect(chart.timeAt(r.from)).toBe(t0);
    expect(r.to - r.from).toBe(100);
  });
});
