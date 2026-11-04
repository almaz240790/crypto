import { describe, expect, it } from "vitest";
import { canAdd, clampParams, countOf, FALLBACK_COLOR, IND_COLORS, INDICATOR_COLOR, indicatorById, instanceColor, instanceColors, instanceTitle, maxInstances, nextUid, normalizeInstances, paneLevels, shortName, suggestParams, type IndicatorInstance, type IndicatorSpec } from "../indicators";

const spec = (id: string): IndicatorSpec => indicatorById(id)!;
const inst = (uid: string, params: Record<string, number> = {}): IndicatorInstance => ({ uid, id: uid.split("#")[0]!, params });

describe("экземпляры индикаторов (план 2B.9, M19)", () => {
  it("nextUid: минимальный свободный номер", () => {
    expect(nextUid([], "ema")).toBe("ema#1");
    expect(nextUid([inst("ema#1")], "ema")).toBe("ema#2");
    expect(nextUid([inst("ema#2")], "ema")).toBe("ema#1");
    expect(nextUid([inst("ema#1"), inst("ema#3")], "ema")).toBe("ema#2");
    expect(nextUid([inst("sma#1")], "ema")).toBe("ema#1");
  });

  it("canAdd: до 3 EMA и SMA, остальные — один, неизвестный — нельзя", () => {
    const three = [inst("ema#1"), inst("ema#2"), inst("ema#3")];
    expect(canAdd(three.slice(0, 2), "ema")).toBe(true);
    expect(canAdd(three, "ema")).toBe(false);
    expect(canAdd(three, "sma")).toBe(true);
    expect(canAdd([inst("rsi#1")], "rsi")).toBe(false);
    expect(canAdd([], "rsi")).toBe(true);
    expect(canAdd([inst("vwap#1")], "vwap")).toBe(false);
    expect(canAdd([], "nope")).toBe(false);
    expect(maxInstances("ema")).toBe(3);
    expect(maxInstances("bb")).toBe(1);
    expect(countOf(three, "ema")).toBe(3);
  });

  it("instanceTitle: имя и параметры по порядку ParamSpec, без параметров у объёма, VWAP и OBV", () => {
    expect(instanceTitle(spec("ema"), { period: 50 })).toBe("EMA 50");
    expect(instanceTitle(spec("macd"), { fast: 12, slow: 26, signal: 9 })).toBe("MACD 12 26 9");
    expect(instanceTitle(spec("rsi"), {})).toBe("RSI 14");
    expect(instanceTitle(spec("stoch"), { k: 14, d: 3, smooth: 3 })).toBe("Stochastic 14 3 3");
    expect(instanceTitle(spec("bb"), { period: 20, mult: 2 })).toBe("BB 20 2");
    expect(instanceTitle(spec("vwap"), {})).toBe("VWAP");
    expect(instanceTitle(spec("obv"), {})).toBe("OBV");
    expect(instanceTitle(spec("volume"), { period: 20 })).toBe("Объём");
    expect(instanceTitle(spec("volume"), {}, (s) => (s === "Объём" ? "Volume" : s))).toBe("Volume");
    expect(shortName(spec("keltner"))).toBe("Keltner");
    expect(shortName(spec("cci"))).toBe("CCI");
  });

  it("clampParams: min/max, шаг, целые периоды, недостающие — по умолчанию, лишние — отброшены", () => {
    expect(clampParams(spec("ema"), { period: 0 })).toEqual({ period: 1 });
    expect(clampParams(spec("ema"), { period: 9999 })).toEqual({ period: 500 });
    expect(clampParams(spec("ema"), { period: 20.6 })).toEqual({ period: 21 });
    expect(clampParams(spec("ema"), { period: Number.NaN })).toEqual({ period: 50 });
    expect(clampParams(spec("ema"), { foo: 3 })).toEqual({ period: 50 });
    expect(clampParams(spec("bb"), { period: 20, mult: 2.3 })).toEqual({ period: 20, mult: 2.5 });
    expect(clampParams(spec("supertrend"), { period: 10, mult: 0.1 })).toEqual({ period: 10, mult: 0.5 });
    expect(clampParams(spec("vwap"), { period: 5 })).toEqual({});
  });

  it("suggestParams: первая скользящая — по умолчанию, следующие — первый свободный из 20, 50, 200…", () => {
    expect(suggestParams([], spec("ema"))).toEqual({ period: 50 });
    expect(suggestParams([inst("ema#1", { period: 50 })], spec("ema"))).toEqual({ period: 20 });
    expect(suggestParams([inst("ema#1", { period: 50 }), inst("ema#2", { period: 20 })], spec("ema"))).toEqual({ period: 200 });
    const all = [20, 50, 200, 100, 9, 21].map((p, i) => inst(`ema#${i + 1}`, { period: p }));
    expect(suggestParams(all, spec("ema"))).toEqual({ period: 50 });
    expect(suggestParams([inst("rsi#1")], spec("rsi"))).toEqual({ period: 14 });
  });

  it("instanceColor: 3 EMA и 3 SMA — попарно разные; первые — постоянные; Keltner — первый свободный", () => {
    const list = ["ema#1", "ema#2", "ema#3", "sma#1", "sma#2", "sma#3"].map((u) => inst(u));
    const colors = list.map((i) => instanceColor(list, i.uid));
    expect(new Set(colors).size).toBe(6);
    expect(colors[0]).toBe("ind1");
    expect(colors[3]).toBe("ind2");
    // Keltner: первый ind-*, не занятый наложениями (EMA ind1, SMA ind2 → ind3)
    const k = [inst("ema#1"), inst("sma#1"), inst("keltner#1")];
    expect(instanceColor(k, "keltner#1")).toBe("ind3");
    expect(instanceColor([inst("keltner#1")], "keltner#1")).toBe("ind1");
    // отдельные панели — свои цвета, наложения их не занимают; OBV — ind-6
    expect(instanceColor([inst("ema#1"), inst("obv#1")], "obv#1")).toBe("ind6");
    expect(instanceColor([inst("rsi#1"), inst("ema#1")], "ema#1")).toBe("ind1");
    // нет такого uid — запасной цвет
    expect(instanceColor([], "x#1")).toBe(FALLBACK_COLOR);
    expect(INDICATOR_COLOR.keltner).toBeUndefined();
  });

  it("instanceColor: занятый постоянный цвет и больше шести наложений — по кругу", () => {
    // сначала постоянные цвета первым экземплярам (EMA ind1, VWAP ind3), потом свободные — вторая EMA получает ind2
    const a = [inst("ema#1"), inst("ema#2"), inst("vwap#1")];
    const m = instanceColors(a);
    expect(m.get("vwap#1")).toBe("ind3");
    expect(m.get("ema#2")).toBe("ind2");
    const many = [inst("ema#1"), inst("ema#2"), inst("ema#3"), inst("sma#1"), inst("sma#2"), inst("sma#3"), inst("vwap#1"), inst("bb#1")];
    const mm = instanceColors(many);
    expect(mm.size).toBe(8);
    for (const c of mm.values()) expect(IND_COLORS).toContain(c);
  });

  it("paneLevels: RSI 30/70, Stochastic 20/80, MACD 0, CCI ±100; у наложений — нет", () => {
    expect(paneLevels(spec("rsi"))).toEqual([30, 70]);
    expect(paneLevels(spec("stoch"))).toEqual([20, 80]);
    expect(paneLevels(spec("macd"))).toEqual([0]);
    expect(paneLevels(spec("cci"))).toEqual([-100, 100]);
    expect(paneLevels(spec("ema"))).toEqual([]);
  });

  it("normalizeInstances: {id, params} → uid, повтор → #2, ≤ 3, неизвестные и повторы панелей отброшены, идемпотентно", () => {
    expect(normalizeInstances("x")).toBeNull();
    const v4 = [{ id: "ema", params: { period: 50 } }, { id: "ema", params: { period: 200 } }, { id: "rsi", params: {} }, { id: "rsi", params: {} }, { id: "nope" }, 5, { id: "ema", params: { period: 20 } }, { id: "ema", params: { period: 9 } }];
    const out = normalizeInstances(v4)!;
    expect(out.map((i) => i.uid)).toEqual(["ema#1", "ema#2", "rsi#1", "ema#3"]);
    expect(out[1]!.params).toEqual({ period: 200 });
    expect(out[2]!.params).toEqual({ period: 14 });
    expect(normalizeInstances(out)).toEqual(out);
    // свой uid сохраняется; занятый или чужой — заменяется
    const kept = normalizeInstances([{ uid: "ema#3", id: "ema", params: { period: 21 } }, { uid: "ema#3", id: "ema", params: {} }, { uid: "sma#1", id: "ema", params: {} }, { uid: "ema#x", id: "sma", params: { period: "5" } }])!;
    expect(kept.map((i) => i.uid)).toEqual(["ema#3", "ema#1", "ema#2", "sma#1"]);
    expect(kept[3]!.params).toEqual({ period: 20 });
    // скрытый экземпляр
    expect(normalizeInstances([{ id: "ema", params: {}, hidden: true }])![0]!.hidden).toBe(true);
    expect(normalizeInstances([{ id: "ema", params: {}, hidden: "yes" }])![0]!.hidden).toBeUndefined();
  });
});
