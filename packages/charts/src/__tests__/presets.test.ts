import { describe, expect, it } from "vitest";
import {
  barsForWidth,
  cleanOverrides,
  DEFAULT_LIMITS,
  DEFAULT_PRESET,
  deviceFor,
  hitTolerance,
  INTERACTION,
  LAYERS_VERSION,
  normalizeMarkup,
  PRESET_IDS,
  PRESETS,
  resolvePreset,
  SELECTABLE_PRESETS,
  selectPreset,
  setLayerOverride,
  VIEW,
  type LayerLimits,
} from "../presets";
import { RU_TEXT } from "../scene/text";
import { LAYER_KEYS, TF_SECONDS, type Device, type Timeframe } from "../types";

const TFS = Object.keys(TF_SECONDS) as Timeframe[];
const DEVICES: Device[] = ["desktop", "phone", "cell"];

describe("пресеты разметки (план 2B.2, ADR-0008)", () => {
  it("версия слоёв 5, по умолчанию «Чистый»", () => {
    expect(LAYERS_VERSION).toBe(5);
    expect(DEFAULT_PRESET).toBe("clean");
    expect(SELECTABLE_PRESETS).toEqual(["clean", "structure", "levels", "liquidity", "detailed"]);
    expect(PRESET_IDS).toContain("compact");
  });

  it("у каждого пресета все лимиты заданы и конечны, все слои названы", () => {
    const keys = Object.keys(DEFAULT_LIMITS) as (keyof LayerLimits)[];
    for (const id of PRESET_IDS) {
      const p = PRESETS[id];
      expect(p.id).toBe(id);
      expect(Object.keys(p.limits).sort()).toEqual([...keys].sort());
      for (const k of keys) {
        const v = p.limits[k];
        if (typeof v === "number") expect(Number.isFinite(v), `${id}.${k}`).toBe(true);
        else if (typeof v === "boolean") expect(typeof v).toBe("boolean");
        else expect(Array.isArray(v)).toBe(true);
      }
      expect(Object.keys(p.layers).sort()).toEqual([...LAYER_KEYS].sort());
      expect(RU_TEXT[p.title]).toBeTruthy();
    }
  });

  it("слои пресетов как в спецификации; паттерны, профиль и сигналы выключены везде", () => {
    const onKeys = (id: keyof typeof PRESETS) => LAYER_KEYS.filter((k) => PRESETS[id].layers[k]).sort();
    expect(onKeys("clean")).toEqual(["sr", "zones"]);
    expect(onKeys("structure")).toEqual(["sr", "structure", "zones"]);
    expect(onKeys("levels")).toEqual(["levels", "sr", "zones"]);
    expect(onKeys("liquidity")).toEqual(["liq_map", "sr"]);
    expect(onKeys("detailed")).toEqual(["figures", "liq_map", "sr", "structure", "zones"]);
    expect(onKeys("compact")).toEqual(["sr", "zones"]);
    for (const id of PRESET_IDS) for (const k of ["patterns", "volume_profile", "signals"] as const) expect(PRESETS[id].layers[k]).toBe(false);
    expect(PRESETS.compact.userSelectable).toBe(false);
    expect(RU_TEXT[PRESETS.liquidity.title]).toBe("Карта ликвидаций");
  });

  it("лимиты: «Чистый» по одному, «Подробный» — прежний набор", () => {
    expect(PRESETS.clean.limits).toMatchObject({ srPerSide: 1, zones: 1, zonesOnePerSide: false });
    expect(PRESETS.structure.limits).toMatchObject({ structureEvents: 2, structureLastOfEachKind: true, sweeps: 2, equalLevelsPerSide: 1, equalLevelsMaxAtr: 1.5 });
    expect(PRESETS.levels.limits).toMatchObject({ srPerSide: 2, zones: 2, zonesOnePerSide: true });
    expect(PRESETS.detailed.limits).toMatchObject({ structureEvents: 4, structureLastOfEachKind: false, equalLevelsPerSide: 2, equalLevelsMaxAtr: 3, srPerSide: 3, zones: 2, liqTopPerSide: 2, figures: 1 });
    expect(DEFAULT_LIMITS).toMatchObject({ vpRows: 24, vpValueArea: 0.7, srStrongTouches: 5, signals: 20, patternRecentBars: 60 });
  });
});

describe("вид по устройствам", () => {
  it("у каждого вида лимит свечей на все 7 таймфреймов, шрифты не меньше 11 px", () => {
    for (const d of DEVICES) {
      const v = VIEW[d];
      expect(v.device).toBe(d);
      for (const tf of TFS) expect(v.maxBars[tf], `${d} ${tf}`).toBeGreaterThanOrEqual(v.minBars);
      expect(v.labelFontPx).toBeGreaterThanOrEqual(11);
      expect(v.scaleFontPx).toBeGreaterThanOrEqual(11);
      expect(v.labels.canvas).toBeGreaterThan(0);
      for (const n of Object.values(v.labels.perLayer)) expect(n).toBeGreaterThanOrEqual(0);
    }
    expect(VIEW.desktop.scaleFontPx).toBe(12);
    expect([VIEW.desktop.rightOffsetPx, VIEW.phone.rightOffsetPx, VIEW.cell.rightOffsetPx]).toEqual([104, 64, 48]);
    expect([VIEW.desktop.gutterPx, VIEW.phone.gutterPx, VIEW.cell.gutterPx]).toEqual([48, 28, 0]);
    expect([VIEW.desktop.labels.canvas, VIEW.phone.labels.canvas, VIEW.cell.labels.canvas]).toEqual([8, 4, 3]);
    expect([VIEW.desktop.axis.total, VIEW.phone.axis.total, VIEW.cell.axis.total]).toEqual([9, 6, 3]);
    expect(VIEW.cell.axis.countdown).toBe(false);
  });

  it("barsForWidth: примеры спецификации и предел ширины бара", () => {
    expect(barsForWidth(966, VIEW.desktop, "4h")).toBe(100);
    expect(barsForWidth(334, VIEW.phone, "4h")).toBe(45);
    expect(barsForWidth(1460, VIEW.desktop, "4h")).toBe(113);
    // узкая область — не меньше minBars
    expect(barsForWidth(200, VIEW.desktop, "4h")).toBe(40);
    // ширина ещё неизвестна
    expect(barsForWidth(0, VIEW.desktop, "4h")).toBe(100);
    expect(barsForWidth(Number.NaN, VIEW.phone, "4h")).toBe(54);
    for (const d of DEVICES)
      for (const tf of TFS)
        for (let w = 300; w <= 2600; w += 37) {
          const n = barsForWidth(w, VIEW[d], tf);
          const free = w - VIEW[d].rightOffsetPx;
          expect(free / n, `${d} ${tf} ${w}`).toBeLessThanOrEqual(VIEW[d].maxBarPx + 0.06);
        }
  });

  it("deviceFor: ширина контейнера, принудительный класс", () => {
    expect(deviceFor(639, false)).toBe("phone");
    expect(deviceFor(640, false)).toBe("desktop");
    expect(deviceFor(0, false)).toBe("desktop");
    expect(deviceFor(1200, true, "cell")).toBe("cell");
    expect(deviceFor(300, true)).toBe("phone");
  });

  it("допуск попадания: 5 мышью, 12 пальцем", () => {
    expect(hitTolerance(VIEW.desktop, false)).toBe(5);
    expect(hitTolerance(VIEW.desktop, true)).toBe(12);
    expect(hitTolerance(VIEW.phone, false)).toBe(12);
    expect(hitTolerance(VIEW.cell, false)).toBe(5);
  });

  it("константы жестов не изменились", () => {
    expect(INTERACTION).toEqual({ longPressMs: 300, tapSlopPx: 8, swipePx: 24, visibleDebounceMs: 200, wheelZoom: 0.0025, wheelScroll: 0.6, minVisibleBars: 10 });
  });
});

describe("resolvePreset и поправки «Свой»", () => {
  it("без поправок — пресет как есть, custom false", () => {
    const r = resolvePreset({ preset: "clean", overrides: {} }, "desktop", { authed: true });
    expect(r).toMatchObject({ id: "clean", custom: false, view: VIEW.desktop });
    expect(r.layers).toEqual(PRESETS.clean.layers);
    expect(r.limits).toBe(PRESETS.clean.limits);
  });

  it("поправка → custom; слой поверх пресета берёт лимиты DEFAULT_LIMITS", () => {
    const r = resolvePreset({ preset: "clean", overrides: { structure: true } }, "phone", { authed: true });
    expect(r.custom).toBe(true);
    expect(r.layers.structure).toBe(true);
    expect(r.limits.structureEvents).toBe(DEFAULT_LIMITS.structureEvents);
    expect(r.view).toBe(VIEW.phone);
  });

  it("поправка, равная пресету, — не «Свой»", () => {
    expect(resolvePreset({ preset: "clean", overrides: { sr: true } }, "desktop", { authed: true }).custom).toBe(false);
  });

  it("гостю сигналы выключены даже поправкой (M24)", () => {
    const m = { preset: "detailed" as const, overrides: { signals: true } };
    expect(resolvePreset(m, "desktop", { authed: false }).layers.signals).toBe(false);
    expect(resolvePreset(m, "desktop", { authed: true }).layers.signals).toBe(true);
  });

  it("неизвестный пресет — по умолчанию", () => {
    expect(resolvePreset({ preset: "zzz" as never, overrides: {} }, "desktop", { authed: true }).id).toBe("clean");
  });

  it("setLayerOverride: значение пресета убирает ключ; selectPreset очищает", () => {
    let m = selectPreset("levels");
    m = setLayerOverride(m, "zones", false);
    expect(m.overrides).toEqual({ zones: false });
    m = setLayerOverride(m, "liq_map", true);
    expect(m.overrides).toEqual({ zones: false, liq_map: true });
    m = setLayerOverride(m, "zones", true);
    expect(m.overrides).toEqual({ liq_map: true });
    expect(selectPreset("levels")).toEqual({ preset: "levels", overrides: {} });
  });

  it("cleanOverrides и normalizeMarkup: мусор и «Компактный» → «Чистый»", () => {
    expect(cleanOverrides("clean", { zones: true, sr: false, bogus: true, liq_map: "yes", structure: true })).toEqual({ sr: false, structure: true });
    expect(cleanOverrides("clean", null)).toEqual({});
    expect(normalizeMarkup(null)).toEqual({ preset: "clean", overrides: {} });
    expect(normalizeMarkup({ preset: "compact", overrides: {} })).toEqual({ preset: "clean", overrides: {} });
    expect(normalizeMarkup({ preset: "compact", overrides: {} }, true)).toEqual({ preset: "compact", overrides: {} });
    expect(normalizeMarkup({ preset: "structure", overrides: { zones: true, levels: true } })).toEqual({ preset: "structure", overrides: { levels: true } });
    expect(normalizeMarkup({ preset: 7 })).toEqual({ preset: "clean", overrides: {} });
  });
});
