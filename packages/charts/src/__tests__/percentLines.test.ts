import { describe, expect, it } from "vitest";
import { PercentLinesPrimitive, lineDash, projectLine, strokePaths, visibleSlice, type LinePath } from "../render/PercentLines";

/**
 * Линии наложенных индикаторов в процентной шкале (ADR-0009, «Процентная шкала: индикаторы на графике цены»):
 * примитив рисует их по цене через шкалу основной серии; вне процентной шкалы не рисует ничего.
 */

const H = 14400;
const data = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ time: (from + i) * H, value: 100 + from + i }));

describe("видимый отрезок данных", () => {
  it("видимые точки и по одной точке запаса с каждой стороны", () => {
    const d = data(20);
    expect(visibleSlice(d, 5 * H, 9 * H).map((p) => p.time / H)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    // границы между свечами
    expect(visibleSlice(d, 5 * H + 1, 9 * H - 1).map((p) => p.time / H)).toEqual([5, 6, 7, 8, 9]);
    // у краёв данных запаса нет
    expect(visibleSlice(d, 0, 2 * H).map((p) => p.time / H)).toEqual([0, 1, 2, 3]);
    expect(visibleSlice(d, 17 * H, 30 * H).map((p) => p.time / H)).toEqual([16, 17, 18, 19]);
  });

  it("данные целиком левее или правее вида, пустые данные", () => {
    const d = data(5);
    // вид правее данных: остаётся только последняя точка (линию из одной точки рисовать нечем)
    expect(visibleSlice(d, 50 * H, 60 * H).map((p) => p.time / H)).toEqual([4]);
    expect(visibleSlice(d, -20 * H, -10 * H).map((p) => p.time / H)).toEqual([0]);
    expect(visibleSlice([], 0, H)).toEqual([]);
  });
});

describe("проекция и обводка", () => {
  it("точка без значения, с нечисловым значением или без координаты — разрыв", () => {
    const pts = projectLine(
      [{ time: 0, value: 1 }, { time: H }, { time: 2 * H, value: Number.NaN }, { time: 3 * H, value: 4 }, { time: 4 * H, value: -1 }],
      (t) => t / H,
      (v) => (v < 0 ? null : v * 10),
    );
    expect(pts).toEqual([[0, 10], null, null, [3, 40], null]);
  });

  it("штрих по стилю линии LWC", () => {
    expect(lineDash(0, 2)).toEqual([]);
    expect(lineDash(undefined, 2)).toEqual([]);
    expect(lineDash(1, 2)).toEqual([2, 2]);
    expect(lineDash(2, 2)).toEqual([4, 4]);
    expect(lineDash(3, 1)).toEqual([6, 6]);
    expect(lineDash(4, 1)).toEqual([1, 4]);
  });

  it("одна линия — один путь; разрыв начинает новый отрезок; линия из одной точки не обводится", () => {
    const calls: string[] = [];
    const ctx = {
      beginPath: () => calls.push("begin"),
      moveTo: (x: number, y: number) => calls.push(`M${x},${y}`),
      lineTo: (x: number, y: number) => calls.push(`L${x},${y}`),
      stroke: () => calls.push(`stroke:${ctx.strokeStyle}:${ctx.lineWidth}:${ctx.dash.join("/")}`),
      setLineDash: (d: number[]) => (ctx.dash = d),
      strokeStyle: "",
      lineWidth: 0,
      lineJoin: "",
      dash: [] as number[],
    };
    const paths: LinePath[] = [
      { color: "#111", width: 2, dash: [], points: [[0, 1], [1, 2], null, [3, 4], [4, 5]] },
      { color: "#222", width: 1, dash: [1, 1], points: [[0, 9], null, null] },
      { color: "#333", width: 1, dash: [2, 2], points: [[0, 7], [1, 8]] },
    ];
    strokePaths(ctx as unknown as CanvasRenderingContext2D, paths);
    expect(calls).toEqual(["begin", "M0,1", "L1,2", "M3,4", "L4,5", "stroke:#111:2:", "begin", "M0,9", "begin", "M0,7", "L1,8", "stroke:#333:1:2/2"]);
    // штрих после отрисовки сброшен: следующий примитив на том же холсте рисует сплошной
    expect(ctx.dash).toEqual([]);
  });
});

describe("примитив", () => {
  type Opts = { visible: boolean; color: string; lineWidth: number; lineStyle: number };
  const line = (o: Partial<Opts>, d = data(10)) => ({ options: (): Opts => ({ visible: true, color: "#abc", lineWidth: 1, lineStyle: 0, ...o }), data: () => d });
  /** Шкала времени: 10 px на свечу; видимы свечи 2…6. Основная серия: y = 500 − цена. */
  const chart = { timeScale: () => ({ getVisibleRange: () => ({ from: 2 * H, to: 6 * H }), timeToCoordinate: (t: number) => (t / H) * 10 }) };
  const main = (k: number) => ({ priceToCoordinate: (p: number) => 500 * k - p });
  const attach = (prim: PercentLinesPrimitive, k = 1) => prim.attached({ chart, series: main(k), requestUpdate: () => undefined } as never);

  it("в процентной шкале — линии по цене через основную серию; в остальных — ничего", () => {
    let percent = true;
    const lines = [line({ color: "#e00", lineWidth: 2 }), line({ visible: false }), line({ color: "#0e0", lineStyle: 2 }, data(10, 3))];
    const prim = new PercentLinesPrimitive(() => lines as never, () => percent);
    // не присоединён — координат нет
    expect(prim.paths()).toEqual([]);
    attach(prim);
    const paths = prim.paths();
    // скрытый экземпляр не рисуется
    expect(paths.map((p) => p.color)).toEqual(["#e00", "#0e0"]);
    expect(paths[0]).toMatchObject({ width: 2, dash: [] });
    // свечи 1…7 (запас по одной), y = 500 − (100 + i)
    expect(paths[0]!.points).toEqual([1, 2, 3, 4, 5, 6, 7].map((i) => [i * 10, 400 - i]));
    // линия с данными от 3-й свечи: слева запаса нет
    expect(paths[1]!.points[0]).toEqual([30, 397]);
    expect(paths[1]).toMatchObject({ dash: [2, 2] });
    expect(prim.paneViews()[0]!.renderer()).not.toBeNull();
    percent = false;
    expect(prim.paths()).toEqual([]);
    expect(prim.paneViews()[0]!.renderer()).toBeNull();
  });

  it("после смены типа графика рисует по шкале новой основной серии", () => {
    const prim = new PercentLinesPrimitive(() => [line({})] as never, () => true);
    attach(prim, 1);
    expect(prim.paths()[0]!.points[0]).toEqual([10, 399]);
    prim.detached();
    expect(prim.paths()).toEqual([]);
    attach(prim, 2);
    expect(prim.paths()[0]!.points[0]).toEqual([10, 899]);
  });
});
