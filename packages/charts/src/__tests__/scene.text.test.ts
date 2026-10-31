import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasMeasurer, monoMeasurer } from "../layout/measure";
import { fillTemplate, formatUtcDate, makeSceneText, PATTERN_RU, RU_STRINGS, RU_TEXT, ZONE_KIND_RU } from "../scene/text";
import { mergeZones, sortZoneKinds, zoneDistance } from "../scene/zones";

describe("тексты графика (план 5.2, 8)", () => {
  it("RU_TEXT — русские строки, функции подстановки", () => {
    expect(RU_TEXT["sr.support"]).toBe("Поддержка");
    expect(RU_TEXT["preset.liquidity"]).toBe("Карта ликвидаций");
    expect(RU_TEXT.fill(RU_TEXT["structure.bos"], { dir: "↑" })).toBe("Пробой ↑");
    expect(RU_TEXT.fill(RU_TEXT["hover.touches"], { n: 5 })).toBe("касаний: 5");
    expect(fillTemplate("{a} и {b}", { a: 1 })).toBe("1 и {b}");
    expect(RU_TEXT.pattern("pin_bar", "Pin bar")).toBe("пин-бар");
    expect(RU_TEXT.pattern("new_kind", "Новый")).toBe("Новый");
    expect(RU_TEXT.figure("double_top", "Двойная вершина")).toBe("Двойная вершина");
    expect(RU_TEXT.zoneKind("ob", "down")).toBe("ордер-блок продаж");
    expect(RU_TEXT.zoneKind("fvg", "up")).toBe("разрыв цены вверх");
    expect(RU_TEXT.zoneKind("xx", "up")).toBe("XX");
    expect(RU_TEXT.panel("funding")).toBe("Фандинг");
    expect(RU_TEXT.panel("oi")).toBe("Открытый интерес");
    expect(RU_TEXT.panel("liq")).toBe("Ликвидации");
    expect(RU_TEXT.panel("ls")).toBe("Лонг/шорт");
  });

  it("дата свечи — в UTC", () => {
    expect(formatUtcDate(Date.UTC(2026, 9, 12, 8, 0) / 1000)).toBe("12.10.26 08:00 UTC");
    expect(RU_TEXT.date(0)).toBe("01.01.70 00:00 UTC");
  });

  it("makeSceneText переводит каждую строку тем же ключом, что и t()", () => {
    const seen: string[] = [];
    const en = makeSceneText((s) => {
      seen.push(s);
      return `EN(${s})`;
    });
    expect(en["sr.support"]).toBe("EN(Поддержка)");
    expect(en.pattern("doji", "x")).toBe("EN(доджи)");
    expect(en.zoneKind("sd", "up")).toBe("EN(зона спроса)");
    expect(en.panel("ls")).toBe("EN(Лонг/шорт)");
    expect(new Set(seen)).toEqual(new Set([...Object.values(RU_STRINGS), "доджи", "зона спроса"]));
  });

  it("без запрещённых формулировок и жаргона на холсте", () => {
    const all = [...Object.values(RU_STRINGS), ...Object.values(PATTERN_RU), ...Object.values(ZONE_KIND_RU).flatMap((x) => [x.up, x.down])].join("\n");
    for (const re of [/сигнал\s+на\s+(покупку|продажу)/i, /ии\s+предсказыва/i, /гарантир/i, /прибыл/i, /\bBOS\b|\bCHoCH\b|\bOB\b|\bFVG\b|\bPDH\b|\bTGT\b|\bINV\b/]) expect(all).not.toMatch(re);
  });
});

describe("склейка зон", () => {
  const z = (kind: string, dir: string, bottom: number, top: number, status = "active") => ({ kind, dir, top: String(top), bottom: String(bottom), from_t: bottom, status });

  it("пересекающиеся склеиваются; виды — ob → sd → fvg независимо от положения; ближайшая первой", () => {
    const g = mergeZones([z("fvg", "up", 100, 110), z("ob", "up", 105, 115), z("sd", "down", 130, 135), z("ob", "down", 90, 95, "touched"), z("sd", "up", "x" as never, 1)], 112);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ bottom: 100, top: 115, dir: "up", kinds: ["ob", "fvg"], parts: [{ kind: "ob", dir: "up" }, { kind: "fvg", dir: "up" }] });
    expect(g[1]!.kinds).toEqual(["sd"]);
    expect(zoneDistance(g[0]!, 112)).toBe(0);
    expect(zoneDistance(g[1]!, 112)).toBe(18);
  });

  it("разные направления — mixed, части с направлением", () => {
    const g = mergeZones([z("ob", "up", 100, 110), z("ob", "down", 108, 112)], 50)[0]!;
    expect(g.dir).toBe("mixed");
    expect(g.parts).toEqual([
      { kind: "ob", dir: "up" },
      { kind: "ob", dir: "down" },
    ]);
    expect(sortZoneKinds(["zz", "fvg", "aa", "ob"])).toEqual(["ob", "fvg", "aa", "zz"]);
  });
});

describe("измерение текста", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("monoMeasurer: 0.6 em на символ", () => {
    expect(monoMeasurer().measure("Сопр.", "sans", 11)).toEqual({ w: 33, h: 11 });
    expect(monoMeasurer(0.5).measure("ab", "mono", 10).w).toBe(10);
  });

  it("canvasMeasurer: шрифт темы, кэш, сброс", () => {
    const fonts: string[] = [];
    const ctx = {
      font: "",
      measureText(t: string) {
        fonts.push(this.font);
        return { width: t.length * 7 };
      },
    };
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return ctx;
        }
      },
    );
    const m = canvasMeasurer({ sans: "Manrope", mono: "Plex", labelWeight: 600 });
    expect(m.measure("Поддержка", "sans", 11)).toEqual({ w: 63, h: 11 });
    expect(m.measure("Поддержка", "sans", 11)).toEqual({ w: 63, h: 11 });
    expect(m.measure("$285M", "mono", 11)).toEqual({ w: 35, h: 11 });
    expect(fonts).toEqual(["600 11px Manrope", "500 11px Plex"]);
    m.clear();
    m.measure("Поддержка", "sans", 11, 500);
    expect(fonts.at(-1)).toBe("500 11px Manrope");
  });

  it("canvasMeasurer: document вместо OffscreenCanvas, без canvas — оценка", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => ({ font: "", measureText: (t: string) => ({ width: t.length }) }) }) });
    expect(canvasMeasurer({ sans: "a", mono: "b", labelWeight: 600 }).measure("abc", "sans", 11).w).toBe(3);
    vi.stubGlobal("document", undefined);
    expect(canvasMeasurer({ sans: "a", mono: "b", labelWeight: 600 }).measure("abc", "sans", 10).w).toBeCloseTo(18, 6);
  });
});
