import { describe, expect, it } from "vitest";
import { DEFAULT_SAVED, isLegacySave, layoutData, migrateLayout, migrateSaved } from "./useTerminalSettings";

/** Миграция сохранений на версию слоёв 5 (план 2B.2, ADR-0008). */
const V4 = { type: "bars", indicators: [{ id: "rsi", params: { period: 14 } }], layers: { structure: true, zones: true, levels: false, signals: false, patterns: false, figures: true, volume_profile: false, sr: true, liq_map: true }, layers_v: 4, panels: ["oi", "bad"], scale: "log", overlay: "ETHUSDT", updated_at: 5 };

describe("migrateSaved", () => {
  it("v4 → «Чистый» без поля layers, остальное переносится", () => {
    const s = migrateSaved(V4);
    expect(s).toEqual({ layers_v: 5, type: "bars", indicators: [{ id: "rsi", params: { period: 14 } }], markup: { preset: "clean", overrides: {} }, panels: ["oi"], scale: "log", overlay: "ETHUSDT", updated_at: 5 });
    expect("layers" in s).toBe(false);
    expect(isLegacySave(V4)).toBe(true);
    // без версии (самые старые сохранения) — тоже старые
    expect(isLegacySave({ layers: {} })).toBe(true);
  });

  it("v5 переносится, поправки очищаются; «Компактный» и неизвестный пресет → «Чистый»", () => {
    const v5 = { ...DEFAULT_SAVED, markup: { preset: "levels", overrides: { zones: true, structure: true, nope: true, sr: "yes" } } };
    expect(migrateSaved(v5).markup).toEqual({ preset: "levels", overrides: { structure: true } });
    expect(isLegacySave(v5)).toBe(false);
    expect(migrateSaved({ ...v5, markup: { preset: "compact", overrides: {} } }).markup.preset).toBe("clean");
    expect(migrateSaved({ ...v5, markup: { preset: "xxx" } }).markup).toEqual({ preset: "clean", overrides: {} });
    expect(migrateSaved({ ...v5, markup: null }).markup.preset).toBe("clean");
  });

  it("мусор → значения по умолчанию", () => {
    expect(migrateSaved(null)).toEqual(DEFAULT_SAVED);
    expect(migrateSaved("x")).toEqual(DEFAULT_SAVED);
    expect(migrateSaved([1])).toEqual(DEFAULT_SAVED);
    const s = migrateSaved({ layers_v: 5, type: "pie", indicators: "x", panels: 3, scale: "zz", overlay: 7 });
    expect(s).toEqual(DEFAULT_SAVED);
  });

  it("именованная раскладка v4 применяется как «Чистый»; шкала и наложение остаются текущими", () => {
    const base = { ...DEFAULT_SAVED, scale: "percent" as const, overlay: "ETHUSDT", markup: { preset: "detailed" as const, overrides: {} } };
    const named = { type: "candles", indicators: [], layers: { zones: false }, panels: ["funding"], symbol: "BTCUSDT", tf: "4h" };
    const s = migrateLayout(named, base);
    expect(s.markup).toEqual({ preset: "clean", overrides: {} });
    expect(s.scale).toBe("percent");
    expect(s.overlay).toBe("ETHUSDT");
    expect(s.indicators).toEqual([]);
    expect(s.panels).toEqual(["funding"]);
    // раскладка v5 сохраняет свою разметку
    expect(migrateLayout({ layers_v: 5, markup: { preset: "structure", overrides: {} } }, base).markup.preset).toBe("structure");
    expect(migrateLayout(null, base)).toBe(base);
  });

  it("saveLayout пишет markup и layers_v 5 вместо layers", () => {
    const d = layoutData({ ...DEFAULT_SAVED, markup: { preset: "levels", overrides: { figures: true } } }, "BTCUSDT", "4h");
    expect(d).toEqual({ layers_v: 5, type: "candles", indicators: DEFAULT_SAVED.indicators, markup: { preset: "levels", overrides: { figures: true } }, panels: [], symbol: "BTCUSDT", tf: "4h" });
    expect("layers" in d).toBe(false);
  });
});
