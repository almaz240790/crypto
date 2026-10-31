import { describe, expect, it } from "vitest";
import { alignToCandles } from "../derivatives";

const H = 14400;
const D = 86400;

describe("данные панелей на время свечей", () => {
  it("точка левее первой свечи и после конца последней отбрасываются — шкала времени не сдвигается", () => {
    const times = [10 * H, 11 * H, 12 * H];
    const rows = [9 * H, 10 * H, 11 * H, 12 * H, 13 * H].map((t, i) => ({ t, v: i }));
    const out = alignToCandles(rows, times, 13 * H);
    expect(out.map((x) => x.time)).toEqual(times);
    expect(out.map((x) => x.row.v)).toEqual([1, 2, 3]);
  });

  it("фандинг 00/08/16 UTC на дневных свечах — одна точка на свечу, последняя за день", () => {
    const times = [0, D, 2 * D];
    const rows = [0, 8, 16, 24, 32, 40, 48].map((h, i) => ({ t: h * 3600, v: i }));
    const out = alignToCandles(rows, times, 3 * D);
    expect(out).toEqual([
      { time: 0, row: { t: 16 * 3600, v: 2 } },
      { time: D, row: { t: 40 * 3600, v: 5 } },
      { time: 2 * D, row: { t: 48 * 3600, v: 6 } },
    ]);
  });

  it("ликвидации в одной свече складываются", () => {
    const times = [0, H];
    const rows = [
      { t: 0, long: 1, short: 2 },
      { t: 3600, long: 3, short: 4 },
      { t: H, long: 5, short: 6 },
    ];
    const out = alignToCandles(rows, times, 2 * H, (a, b) => ({ t: a.t, long: a.long + b.long, short: a.short + b.short }));
    expect(out.map((x) => [x.time, x.row.long, x.row.short])).toEqual([
      [0, 4, 6],
      [H, 5, 6],
    ]);
  });

  it("без свечей — пусто", () => {
    expect(alignToCandles([{ t: 1 }], [], 10)).toEqual([]);
  });
});
