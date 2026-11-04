import { describe, expect, it } from "vitest";
import { baseOf, capPlaces, COIN_ORDER, coinRank, compareByRank, normalizeBase, sortByRank } from "./coinRank";

/** Инструменты расширенного списка (scripts/instruments_extended.txt) — в алфавитном порядке, как отдавал старый API. */
const EXTENDED = [
  "1000BONKUSDT", "1000FLOKIUSDT", "1000PEPEUSDT", "1000SHIBUSDT", "AAVEUSDT", "ADAUSDT", "ALGOUSDT", "APTUSDT", "ARBUSDT", "ATOMUSDT",
  "AVAXUSDT", "AXSUSDT", "BCHUSDT", "BNBUSDT", "BTCUSDT", "CRVUSDT", "DOGEUSDT", "DOTUSDT", "DYDXUSDT", "ENAUSDT", "EOSUSDT", "ETCUSDT",
  "ETHUSDT", "FETUSDT", "FILUSDT", "GALAUSDT", "GRTUSDT", "HBARUSDT", "ICPUSDT", "IMXUSDT", "INJUSDT", "JUPUSDT", "LDOUSDT", "LINKUSDT",
  "LTCUSDT", "MANAUSDT", "MKRUSDT", "NEARUSDT", "ONDOUSDT", "OPUSDT", "ORDIUSDT", "PENDLEUSDT", "RENDERUSDT", "RUNEUSDT", "SANDUSDT",
  "SEIUSDT", "SOLUSDT", "STXUSDT", "SUIUSDT", "TAOUSDT", "TIAUSDT", "TONUSDT", "TRXUSDT", "UNIUSDT", "VETUSDT", "WIFUSDT", "WLDUSDT",
  "XLMUSDT", "XRPUSDT", "ZECUSDT",
].map((symbol) => ({ symbol }));

describe("coinRank", () => {
  it("снимок: BTC, ETH, BNB, XRP, SOL первыми, без повторов и стейблкоинов", () => {
    expect(COIN_ORDER.slice(0, 5)).toEqual(["BTC", "ETH", "BNB", "XRP", "SOL"]);
    expect(new Set(COIN_ORDER).size).toBe(COIN_ORDER.length);
    for (const x of ["USDT", "USDC", "DAI", "USDE", "WBTC", "STETH", "XAUT", "PAXG"]) expect(COIN_ORDER).not.toContain(x);
  });

  it("база: множитель 1000 и бывшие тикеры", () => {
    expect(normalizeBase("1000PEPE")).toBe("PEPE");
    expect(normalizeBase("1000bonk")).toBe("BONK");
    expect(normalizeBase("1MBABYDOGE")).toBe("BABYDOGE");
    expect(normalizeBase("RNDR")).toBe("RENDER");
    expect(normalizeBase("1INCH")).toBe("1INCH");
    expect(baseOf("1000SHIBUSDT")).toBe("SHIB");
    expect(baseOf("ETHUSDC")).toBe("ETH");
    expect(baseOf("BTC")).toBe("BTC");
  });

  it("место: из API, если поле есть (null — без места), иначе по снимку", () => {
    expect(coinRank({ symbol: "BTCUSDT" })).toBe(1);
    expect(coinRank({ symbol: "SOLUSDT" })).toBe(5);
    expect(coinRank({ symbol: "1000PEPEUSDT", base: "1000PEPE" })).toBe(COIN_ORDER.indexOf("PEPE") + 1);
    expect(coinRank({ symbol: "1000PEPEUSDT" })).toBe(COIN_ORDER.indexOf("PEPE") + 1);
    expect(coinRank({ symbol: "SOLUSDT", rank: 3 })).toBe(3);
    expect(coinRank({ symbol: "BTCUSDT", rank: null })).toBeNull();
    expect(coinRank({ symbol: "MKRUSDT" })).toBeNull();
    expect(coinRank({ symbol: "NOPEUSDT" })).toBeNull();
  });

  it("сортировка по снимку: крупные первыми, без места — в конце по алфавиту; исходный список не меняется", () => {
    const sorted = sortByRank(EXTENDED).map((x) => x.symbol);
    expect(sorted.slice(0, 6)).toEqual(["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT", "TRXUSDT"]);
    expect(sorted.at(-1)).toBe("MKRUSDT");
    expect(sorted.indexOf("1000PEPEUSDT")).toBeLessThan(sorted.indexOf("1000BONKUSDT"));
    expect(sorted.indexOf("TONUSDT")).toBeLessThan(sorted.indexOf("1000SHIBUSDT"));
    expect(EXTENDED[0]!.symbol).toBe("1000BONKUSDT");
    expect(sortByRank([{ symbol: "ZZZUSDT" }, { symbol: "AAAUSDT" }, { symbol: "ETHUSDT" }]).map((x) => x.symbol)).toEqual(["ETHUSDT", "AAAUSDT", "ZZZUSDT"]);
  });

  it("сортировка по полю rank из API: свежий порядок важнее снимка", () => {
    const api = [
      { symbol: "ETHUSDT", rank: 2 },
      { symbol: "SOLUSDT", rank: 3 },
      { symbol: "MKRUSDT", rank: null },
      { symbol: "BTCUSDT", rank: 1 },
      { symbol: "ABCUSDT", rank: null },
    ];
    expect(sortByRank(api).map((x) => x.symbol)).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT", "ABCUSDT", "MKRUSDT"]);
    expect(compareByRank({ symbol: "XUSDT", rank: 7 }, { symbol: "AUSDT", rank: 7 })).toBeGreaterThan(0);
  });

  it("место для показа — 1…N без пропусков, а не rank из API; без капитализации — без места", () => {
    // rank из API — позиция в списке CoinGecko с чужими монетами: у DOGE 9, у LINK 12 (HYPE, XMR, WBT, LEO между ними)
    const api = [
      { symbol: "LINKUSDT", rank: 12 },
      { symbol: "MKRUSDT", rank: null },
      { symbol: "BTCUSDT", rank: 1 },
      { symbol: "DOGEUSDT", rank: 9 },
      { symbol: "ZECUSDT", rank: 7 },
      { symbol: "ABCUSDT", rank: null },
    ];
    const places = capPlaces(api);
    expect([...places.entries()]).toEqual([["BTCUSDT", 1], ["ZECUSDT", 2], ["DOGEUSDT", 3], ["LINKUSDT", 4]]);
    expect(places.get("MKRUSDT")).toBeUndefined();
    // старый API без rank — по снимку, тоже подряд: снимок с пропусками (HYPE, XMR…), места — нет
    const old = capPlaces(EXTENDED);
    expect(old.size).toBe(EXTENDED.length - 1);
    expect([...old.values()]).toEqual(Array.from({ length: old.size }, (_, i) => i + 1));
    expect(old.get("BTCUSDT")).toBe(1);
    expect(old.get("DOGEUSDT")).toBe(sortByRank(EXTENDED).findIndex((x) => x.symbol === "DOGEUSDT") + 1);
    expect(coinRank({ symbol: "DOGEUSDT" })).toBeGreaterThan(old.get("DOGEUSDT")!);
    expect(old.has("MKRUSDT")).toBe(false);
    expect(capPlaces([]).size).toBe(0);
  });

  it("поиск по буквам сохраняет порядок капитализации", () => {
    const sorted = sortByRank(EXTENDED);
    const typed = sorted.filter((x) => x.symbol.startsWith("S")).map((x) => x.symbol);
    expect(typed).toEqual(["SOLUSDT", "SUIUSDT", "STXUSDT", "SEIUSDT", "SANDUSDT"]);
    const sub = sorted.filter((x) => x.symbol.includes("ET")).map((x) => x.symbol);
    expect(sub).toEqual(["ETHUSDT", "ETCUSDT", "VETUSDT", "FETUSDT"]);
  });
});
