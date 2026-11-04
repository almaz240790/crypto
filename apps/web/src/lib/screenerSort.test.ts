import { describe, expect, it } from "vitest";
import { DEFAULT_SCREENER_SORT, firstDirection, sortScreenerRows } from "./screenerSort";
import type { ScreenerRow } from "./user";

const row = (symbol: string, extra: Partial<ScreenerRow> = {}): ScreenerRow => ({ symbol, instrument_id: 1, exchange: "binance", ...extra });
/** Как отдаёт скринер API до этой правки: по алфавиту и без поля rank. */
const ALPHA = [
  row("1000PEPEUSDT", { change_24h: "5" }),
  row("ADAUSDT", { change_24h: "-1" }),
  row("BNBUSDT", { change_24h: "2" }),
  row("BTCUSDT", { change_24h: "1" }),
  row("ETHUSDT", { change_24h: "2" }),
  row("MKRUSDT", { change_24h: null }),
  row("SOLUSDT", { change_24h: "3", zone: { kind: "ob", direction: "up", top: "1", bottom: "0", status: "active", distance_atr: "0.4", distance_pct: "1" } }),
  row("XRPUSDT"),
];
const syms = (rows: ScreenerRow[]) => rows.map((r) => r.symbol);

describe("sortScreenerRows", () => {
  it("по умолчанию — по капитализации: BTC, ETH, BNB, XRP, SOL…, без места — в конце", () => {
    expect(DEFAULT_SCREENER_SORT).toEqual({ k: "rank", d: 1 });
    expect(syms(sortScreenerRows(ALPHA, DEFAULT_SCREENER_SORT))).toEqual(["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT", "ADAUSDT", "1000PEPEUSDT", "MKRUSDT"]);
    expect(ALPHA[0]!.symbol).toBe("1000PEPEUSDT");
  });

  it("поле rank из API важнее снимка", () => {
    const rows = [row("BTCUSDT", { rank: 2 }), row("ETHUSDT", { rank: 1 }), row("ABCUSDT", { rank: null })];
    expect(syms(sortScreenerRows(rows, DEFAULT_SCREENER_SORT))).toEqual(["ETHUSDT", "BTCUSDT", "ABCUSDT"]);
  });

  it("сортировка пользователя работает: равные — по капитализации, пустые — в конце", () => {
    expect(syms(sortScreenerRows(ALPHA, { k: "change_24h", d: -1 }))).toEqual(["1000PEPEUSDT", "SOLUSDT", "ETHUSDT", "BNBUSDT", "BTCUSDT", "ADAUSDT", "XRPUSDT", "MKRUSDT"]);
    expect(syms(sortScreenerRows(ALPHA, { k: "change_24h", d: 1 })).slice(0, 2)).toEqual(["ADAUSDT", "BTCUSDT"]);
    expect(syms(sortScreenerRows(ALPHA, { k: "symbol", d: 1 }))).toEqual(syms(ALPHA));
    expect(syms(sortScreenerRows(ALPHA, { k: "zone", d: 1 }))).toEqual(["SOLUSDT", "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "1000PEPEUSDT", "MKRUSDT"]);
    expect(syms(sortScreenerRows(ALPHA, { k: "rank", d: -1 })).slice(0, 2)).toEqual(["1000PEPEUSDT", "ADAUSDT"]);
  });

  it("первый клик: место и имя — по возрастанию, числа — по убыванию", () => {
    expect(firstDirection("rank")).toBe(1);
    expect(firstDirection("symbol")).toBe(1);
    expect(firstDirection("volume_24h")).toBe(-1);
  });
});
