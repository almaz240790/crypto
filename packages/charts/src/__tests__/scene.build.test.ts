import { describe, expect, it } from "vitest";
import { PRESETS, resolvePreset, SELECTABLE_PRESETS, type MarkupSettings, type PresetId } from "../presets";
import { priceFormatter } from "../priceFormat";
import { buildScene, sceneHover, sceneKey, selectionId } from "../scene/build";
import { deriveAnalytics, NO_SELECTION, type AlertLine, type ExternalObject, type SceneInput } from "../scene/input";
import { PATTERN_RU, RU_STRINGS, RU_TEXT } from "../scene/text";
import type { Scene, SceneObject } from "../scene/types";
import { LAYER_KEYS, type Candle, type Device, type LayerKey } from "../types";
import { FIXTURES, loadFixture, type FixtureName, type SceneFixture } from "./fixtures/scene/load";

const ALL_ON: Partial<Record<LayerKey, boolean>> = Object.fromEntries(LAYER_KEYS.map((k) => [k, true]));
const NO_ALERTS: readonly AlertLine[] = [];
const NO_EXTERNAL: readonly ExternalObject[] = [];

type Opts = { device?: Device; authed?: boolean; selected?: string | null; alerts?: readonly AlertLine[]; candles?: Candle[]; oi?: SceneFixture["oi"] | null; external?: readonly ExternalObject[]; hidden?: ReadonlySet<string> };

/** Вход сцены из фикстуры: один и тот же форматтер на устройство, чтобы ключ сцены был стабилен. */
const fmtCache = new Map<string, ReturnType<typeof priceFormatter>>();
function makeInput(fx: SceneFixture, o: Opts = {}, prevAnalytics?: SceneInput["analytics"]): SceneInput {
  const narrow = (o.device ?? "desktop") !== "desktop";
  const fk = `${fx.tick}|${narrow}`;
  if (!fmtCache.has(fk)) fmtCache.set(fk, priceFormatter(fx.tick, narrow));
  return {
    tf: fx.tf,
    analytics: deriveAnalytics(o.candles ?? fx.candles, o.oi === undefined ? fx.oi : o.oi, fx.structure, prevAnalytics),
    structure: fx.structure,
    patterns: fx.patterns,
    figures: fx.figures,
    signals: fx.signals,
    alerts: o.alerts ?? NO_ALERTS,
    external: o.external ?? NO_EXTERNAL,
    selection: o.selected || o.hidden ? { selected: o.selected ?? null, hidden: o.hidden ?? new Set() } : NO_SELECTION,
    fmt: fmtCache.get(fk)!,
    text: RU_TEXT,
  };
}

function scene(name: FixtureName, markup: MarkupSettings, o: Opts = {}): Scene {
  const fx = loadFixture(name);
  return buildScene(makeInput(fx, o), resolvePreset(markup, o.device ?? "desktop", { authed: o.authed ?? false }));
}

const preset = (id: PresetId): MarkupSettings => ({ preset: id, overrides: {} });
const custom: MarkupSettings = { preset: "clean", overrides: ALL_ON };

/** Снимок без координат: id, вид, тон, подпись, приоритет, шкала. */
function summary(s: Scene) {
  return s.objects.map((o) => ({
    id: o.id,
    kind: o.kind,
    tone: o.tone,
    ...(o.emphasis !== "normal" ? { emphasis: o.emphasis } : {}),
    ...(o.label ? { label: o.label.text, priority: o.label.priority } : { priority: o.priority }),
    ...(o.axis ? { axis: o.axis.text } : {}),
    ...(o.kind === "heat" ? { tops: o.tops.map((t) => `${t.id} ${t.label.text}`) } : {}),
  }));
}

const byLayer = (s: Scene, layer: string) => s.objects.filter((o) => o.layer === layer);
const cnt = (objs: readonly SceneObject[], pred: (o: SceneObject) => boolean) => objs.filter(pred).length;

describe("buildScene: снимки по пресетам", () => {
  for (const name of FIXTURES) {
    for (const id of [...SELECTABLE_PRESETS, "compact"] as PresetId[]) {
      it(`${name} · ${id}`, () => {
        expect(summary(scene(name, preset(id), { authed: true, device: id === "compact" ? "cell" : "desktop" }))).toMatchSnapshot();
      });
    }
    it(`${name} · «Свой», все 9 слоёв`, () => {
      expect(summary(scene(name, custom, { authed: true }))).toMatchSnapshot();
    });
    it(`${name} · «Чистый» на телефоне`, () => {
      expect(summary(scene(name, preset("clean"), { device: "phone" }))).toMatchSnapshot();
    });
  }
});

describe("buildScene: инварианты", () => {
  it("тот же вход — тот же объект сцены, версия не растёт", () => {
    const fx = loadFixture("btc-4h-rich");
    const r = resolvePreset(preset("detailed"), "desktop", { authed: false });
    const input = makeInput(fx);
    const s1 = buildScene(input, r);
    expect(s1.version).toBe(1);
    expect(buildScene(makeInput(fx, {}, input.analytics), r, s1)).toBe(s1);
    const s2 = buildScene(makeInput(fx, { selected: "sr:R:80273.3" }, input.analytics), r, s1);
    expect(s2).not.toBe(s1);
    expect(s2.version).toBe(2);
    expect(s2.index.version).toBe(2);
  });

  it("утечка будущего: открытая свеча не меняет ни аналитику, ни сцену", () => {
    const fx = loadFixture("btc-4h-rich");
    const r = resolvePreset(custom, "desktop", { authed: true });
    const input = makeInput(fx);
    const s1 = buildScene(input, r);
    const last = fx.candles[fx.candles.length - 1]!;
    const open: Candle = { time: last.time + 14400, open: last.close, high: last.close * 1.2, low: last.close * 0.7, close: last.close * 1.15, volume: 1e9, open_: true };
    const withOpen = makeInput(fx, { candles: [...fx.candles, open] }, input.analytics);
    expect(withOpen.analytics).toBe(input.analytics);
    expect(buildScene(withOpen, r, s1)).toBe(s1);
    // и без prev: аналитика по закрытым свечам та же
    const fresh = deriveAnalytics([...fx.candles, open], fx.oi, fx.structure);
    expect(fresh.key).toBe(input.analytics.key);
    expect(fresh.sr).toEqual(input.analytics.sr);
    expect(fresh.liq).toEqual(input.analytics.liq);
  });

  it("id стабильны: после новой закрытой свечи неизменные объекты сохраняют id", () => {
    const fx = loadFixture("btc-4h-rich");
    const r = resolvePreset(preset("detailed"), "desktop", { authed: false });
    const before = buildScene(makeInput(fx, { candles: fx.candles.slice(0, -1) }), r);
    const after = buildScene(makeInput(fx), r, before);
    expect(after.version).toBe(before.version + 1);
    const ids = (s: Scene, layer: string) => byLayer(s, layer).map((o) => o.id);
    expect(ids(after, "structure")).toEqual(ids(before, "structure"));
    expect(ids(after, "figures")).toEqual(ids(before, "figures"));
    // один и тот же id — один и тот же объект (та же цена)
    for (const o of after.objects) {
      const b = before.byId.get(o.id);
      if (b && o.kind === "hline" && b.kind === "hline") expect(b.price).toBeCloseTo(o.price, 6);
      if (b && o.kind === "box" && b.kind === "box") expect([b.top, b.bottom]).toEqual([o.top, o.bottom]);
    }
  });

  it("в сцене нет hex-цветов и rgb(", () => {
    for (const name of FIXTURES) {
      const s = scene(name, custom, { authed: true, selected: "fig:1", alerts: [{ id: 1, price: 1, op: "cross_up" }] });
      const json = JSON.stringify({ objects: s.objects, legend: s.legend, index: { ...s.index, onChart: [...s.index.onChart], dropped: [...s.index.dropped] } });
      expect(json).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(json).not.toMatch(/rgba?\(/i);
    }
  });

  it("dimmed — только у заливок (карта, профиль), не у линий и текста", () => {
    for (const name of FIXTURES) {
      const s = scene(name, custom, { authed: true });
      for (const o of s.objects) if (o.emphasis === "dimmed") expect(["heat", "profile"]).toContain(o.kind);
    }
    const s = scene("btc-4h-rich", custom, { authed: true });
    expect(s.byId.get("vp")?.emphasis).toBe("dimmed");
    expect(s.byId.get("vp")?.label).toBeUndefined();
    const vpOnly = scene("btc-4h-rich", { preset: "clean", overrides: { volume_profile: true } });
    expect(vpOnly.byId.get("vp")?.emphasis).toBe("normal");
    expect(vpOnly.byId.get("vp")?.label?.text).toBe("Макс. объём");
  });

  it("лимиты пресетов: «Чистый» по одному, «Структура» — последний пробой и смена, равные уровни в 1.5 ATR", () => {
    for (const name of FIXTURES) {
      const clean = scene(name, preset("clean"));
      expect(cnt(clean.objects, (o) => o.id.startsWith("sr:S:"))).toBeLessThanOrEqual(1);
      expect(cnt(clean.objects, (o) => o.id.startsWith("sr:R:"))).toBeLessThanOrEqual(1);
      expect(cnt(clean.objects, (o) => o.layer === "zones")).toBeLessThanOrEqual(1);
      expect(clean.objects.every((o) => o.layer === "sr" || o.layer === "zones")).toBe(true);
      const st = scene(name, preset("structure"));
      expect(cnt(st.objects, (o) => o.id.startsWith("bos:"))).toBeLessThanOrEqual(1);
      expect(cnt(st.objects, (o) => o.id.startsWith("choch:"))).toBeLessThanOrEqual(1);
      expect(cnt(st.objects, (o) => o.id.startsWith("sweep:"))).toBeLessThanOrEqual(2);
      const fx = loadFixture(name);
      const atr = Number(fx.structure.atr);
      const ref = fx.candles[fx.candles.length - 1]!.close;
      for (const o of st.objects) if (o.id.startsWith("eq:") && o.kind === "hline") expect(Math.abs(o.price - ref)).toBeLessThanOrEqual(1.5 * atr + 1e-9);
      expect(cnt(st.objects, (o) => o.id.startsWith("eq:H"))).toBeLessThanOrEqual(1);
      expect(cnt(st.objects, (o) => o.id.startsWith("eq:L"))).toBeLessThanOrEqual(1);
    }
    const levels = scene("btc-4h-rich", preset("levels"));
    const zones = byLayer(levels, "zones");
    expect(zones.length).toBeLessThanOrEqual(2);
    expect(new Set(zones.map((z) => z.label?.text)).size).toBe(zones.length);
    expect(byLayer(levels, "levels").map((o) => o.id)).toEqual(["lvl:pdh", "lvl:pdl", "lvl:pwh", "lvl:pwl"]);
    const detailed = scene("btc-4h-rich", preset("detailed"));
    expect(cnt(detailed.objects, (o) => o.id.startsWith("sr:S:"))).toBe(2);
    expect(cnt(detailed.objects, (o) => o.id.startsWith("sr:R:"))).toBe(3);
    expect(cnt(detailed.objects, (o) => /^(bos|choch):/.test(o.id))).toBe(4);
    expect(cnt(detailed.objects, (o) => o.axis?.group === "sr")).toBe(4);
  });

  it("каждая подпись — из RU_TEXT, названий паттернов или фигур", () => {
    const fills = [
      ...["↑", "↓"].flatMap((dir) => [RU_TEXT.fill(RU_STRINGS["structure.bos"], { dir }), RU_TEXT.fill(RU_STRINGS["structure.choch"], { dir })]),
      ...[1, 2, 3].map((n) => RU_TEXT.fill(RU_STRINGS["signal.tp"], { n })),
    ];
    for (const name of FIXTURES) {
      const fx = loadFixture(name);
      const allowed = new Set([...Object.values(RU_STRINGS), ...fills, ...Object.values(PATTERN_RU), ...fx.patterns.map((p) => p.title), ...fx.figures.map((f) => f.title)]);
      const s = scene(name, custom, { authed: true, alerts: [{ id: 7, price: 1, op: "enter_range", price2: 2 }] });
      for (const o of s.objects) {
        if (o.label) expect(allowed.has(o.label.text), o.label.text).toBe(true);
        if (o.kind === "heat") for (const t of o.tops) expect(t.label.text).toMatch(/^≈ \$\d[\d.]*[KMB]?$/);
      }
    }
  });

  it("ликвидации: при покрытии OI ниже 0.5 нет liq:*, а liqUnavailable — при любом слое", () => {
    for (const markup of [preset("clean"), preset("liquidity"), custom]) {
      const s = scene("btc-1w", markup, { authed: true });
      expect(s.objects.some((o) => o.id.startsWith("liq:"))).toBe(false);
      expect(s.index.liqUnavailable).toBe(true);
      expect(s.index.levels.some((r) => r.layer === "liq_map")).toBe(false);
    }
    // производные не загружены — «нет данных» не показываем
    expect(scene("btc-1w", preset("liquidity"), { oi: null }).index.liqUnavailable).toBe(false);
    // 4h: карта есть, в каталоге по 3 на сторону независимо от слоя
    const clean = scene("btc-4h-rich", preset("clean"));
    expect(clean.index.liqUnavailable).toBe(false);
    expect(clean.index.levels.filter((r) => r.kind === "liq-long")).toHaveLength(3);
    expect(clean.index.levels.filter((r) => r.kind === "liq-short")).toHaveLength(3);
    expect(clean.index.levels.filter((r) => r.layer === "liq_map").every((r) => !r.onChart && r.estimate)).toBe(true);
    const liq = scene("btc-4h-rich", preset("liquidity"));
    const heat = liq.byId.get("liq:map");
    expect(heat?.kind).toBe("heat");
    if (heat?.kind !== "heat") return;
    expect(heat.tops.filter((t) => t.side === "long").length).toBeLessThanOrEqual(2);
    expect(heat.tops.filter((t) => t.side === "short").length).toBeLessThanOrEqual(2);
    expect(heat.bars.every((b) => b.weight > 0 && b.weight <= 1)).toBe(true);
    for (const t of heat.tops) {
      expect(liq.byId.get(t.id)).toBe(heat);
      expect(liq.index.levels.find((r) => r.id === t.id)?.onChart ?? true).toBe(true);
      expect(sceneHover(liq, t.id)?.estimate).toBe(true);
    }
  });

  it("выбранный объект рисуется сверх лимита и при выключенном слое", () => {
    const fx = loadFixture("btc-4h-rich");
    const base = scene("btc-4h-rich", preset("clean"));
    const far = base.index.levels.find((r) => r.layer === "zones" && !r.onChart)!;
    expect(far).toBeDefined();
    const s = scene("btc-4h-rich", preset("clean"), { selected: far.id });
    const z = s.byId.get(far.id)!;
    expect(z.emphasis).toBe("selected");
    expect(z.label?.priority).toBe(95);
    expect(s.index.levels.find((r) => r.id === far.id)?.onChart).toBe(true);
    // паттерн при выключенном слое
    const p = fx.patterns.find((x) => !x.significant)!;
    const sp = scene("btc-4h-rich", preset("clean"), { selected: `pat:${p.id}` });
    const g = sp.byId.get(`pat:${p.id}`)!;
    expect(g).toMatchObject({ kind: "glyph", emphasis: "selected", tone: "selection" });
    expect(g.label).toMatchObject({ show: "always", priority: 95 });
    // фигура: группа целиком, тон выделения, точки
    const f = fx.figures.filter((x) => x.status === "confirmed").at(0)!;
    const sf = scene("btc-4h-rich", preset("clean"), { selected: `fig:${f.id}` });
    const poly = sf.byId.get(`fig:${f.id}`);
    expect(poly).toMatchObject({ kind: "polyline", tone: "selection", style: "solid", width: 2, emphasis: "selected" });
    if (poly?.kind === "polyline") expect(poly.dots?.length).toBeGreaterThan(0);
    for (const o of sf.objects.filter((x) => x.groupId === `fig:${f.id}`)) expect(o.emphasis).toBe("selected");
    expect(selectionId(sf, `fig:${f.id}:tgt`)).toBe(`fig:${f.id}`);
    expect(selectionId(sf, "nope")).toBe("nope");
    // выбранная поддержка остаётся в своём тоне
    const sr = base.objects.find((o) => o.id.startsWith("sr:S:"))!;
    expect(scene("btc-4h-rich", preset("clean"), { selected: sr.id }).byId.get(sr.id)).toMatchObject({ tone: "up", width: 2, emphasis: "selected" });
    // выбранное событие структуры при выключенном слое
    const ev = fx.structure.events[0]!;
    expect(scene("btc-4h-rich", preset("clean"), { selected: `${ev.type}:${ev.t}` }).byId.get(`${ev.type}:${ev.t}`)?.emphasis).toBe("selected");
  });

  it("скрытые объекты не рисуются (кроме выбранного)", () => {
    const base = scene("btc-4h-rich", preset("clean"));
    const sr = base.objects.find((o) => o.layer === "sr")!;
    expect(scene("btc-4h-rich", preset("clean"), { hidden: new Set([sr.id]) }).byId.has(sr.id)).toBe(false);
    expect(scene("btc-4h-rich", preset("clean"), { hidden: new Set([sr.id]), selected: sr.id }).byId.has(sr.id)).toBe(true);
  });

  it("каталог «Найдено»: S/R по 3, зоны 2, уровни дня и недели; по убыванию цены; dropped — отрезанные при включённом слое", () => {
    const s = scene("btc-4h-rich", preset("clean"));
    const rows = s.index.levels;
    expect(rows.filter((r) => r.kind === "support")).toHaveLength(2);
    expect(rows.filter((r) => r.kind === "resistance")).toHaveLength(3);
    expect(rows.filter((r) => r.layer === "zones")).toHaveLength(2);
    expect(rows.filter((r) => r.layer === "levels").map((r) => r.kind).sort()).toEqual(["pdh", "pdl", "pwh", "pwl"]);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.price).toBeGreaterThanOrEqual(rows[i]!.price);
    expect(rows.filter((r) => r.onChart).map((r) => r.id).sort()).toEqual(s.objects.filter((o) => o.layer === "sr" || o.layer === "zones").map((o) => o.id).sort());
    for (const r of rows) expect(s.index.dropped.has(r.id)).toBe(!r.onChart && (r.layer === "sr" || r.layer === "zones"));
    const z = rows.find((r) => r.layer === "zones")!;
    expect(z.kinds?.length).toBeGreaterThan(0);
    expect(z.priceTo).toBeGreaterThan(z.price);
  });

  it("легенда «Чистого»: цена, сопротивление, поддержка, зона, выделение", () => {
    const s = scene("btc-4h-rich", preset("clean"));
    const texts = s.legend.map((e) => e.text);
    expect(texts[0]).toBe("Цена");
    expect(texts.at(-1)).toBe("Выделение");
    expect(texts).toContain("Сопротивление");
    expect(texts).toContain("Поддержка");
    expect(texts.some((t) => ["Спрос", "Предложение", "Зона"].includes(t))).toBe(true);
    expect(texts).toHaveLength(5);
    for (const e of s.legend) expect(e.explain.length).toBeGreaterThan(10);
  });

  it("алерты: линия с колокольчиком и контурная цена, у диапазона — две линии одной группы", () => {
    const alerts: AlertLine[] = [
      { id: 1, price: 80000, op: "cross_up" },
      { id: 2, price: 70000, op: "enter_range", price2: 72000 },
      { id: 3, price: Number.NaN, op: "cross_down" },
    ];
    const s = scene("btc-4h-rich", preset("clean"), { alerts });
    const a = byLayer(s, "alerts");
    expect(a.map((o) => o.id)).toEqual(["alert:1", "alert:2", "alert:2:2"]);
    expect(a.every((o) => o.label?.icon === "bell" && o.axis?.group === "alert" && o.axis.style === "outline")).toBe(true);
    expect(a[0]!.label?.text).toBe("Алерт ↑");
    expect(a[1]!.label?.text).toBe("Алерт ↔");
    expect(a[2]!.groupId).toBe("alert:2");
    expect(a[0]!.axis?.text).toBe("80 000.0");
    // ключ сцены учитывает цены алертов
    const fx = loadFixture("btc-4h-rich");
    const r = resolvePreset(preset("clean"), "desktop", { authed: false });
    expect(sceneKey(makeInput(fx, { alerts }), r)).not.toBe(sceneKey(makeInput(fx, { alerts: [{ ...alerts[0]!, price: 80001 }] }), r));
  });

  it("сигналы: вошедшим — значок и уровни открытого, у закрытого только значок; гостю — ничего", () => {
    const s = scene("btc-4h-rich", { preset: "clean", overrides: { signals: true } }, { authed: true });
    const ids = byLayer(s, "signals").map((o) => o.id);
    expect(ids).toEqual(["sig:s-open", "sig:s-open:entry", "sig:s-open:stop", "sig:s-open:tp1", "sig:s-open:tp2", "sig:s-open:tp3", "sig:s-closed"]);
    const tp2 = s.byId.get("sig:s-open:tp2")!;
    expect(tp2).toMatchObject({ tone: "position", groupId: "sig:s-open" });
    expect(tp2.label?.text).toBe("Цель 2");
    expect(tp2.axis?.priority).toBe(88);
    expect(sceneHover(s, "sig:s-open")?.title).toBe("Сигнал A, лонг");
    expect(byLayer(scene("btc-4h-rich", { preset: "clean", overrides: { signals: true } }, { authed: false }), "signals")).toHaveLength(0);
  });

  it("«Разбор»: внешние линии и зоны с группой шкалы topdown", () => {
    const external: ExternalObject[] = [
      { id: "h1", owner: "topdown", sourceTf: "1h", kind: "hline", price: 79000, from: null, tone: "down", label: "Н1 сопротивление", hover: { title: "Н1 сопротивление" }, priority: 65 },
      { id: "b1", owner: "topdown", sourceTf: "1d", kind: "box", top: 70000, bottom: 71000, from: 1_780_000_000, tone: "up", label: "Д1 спрос", hover: { title: "Д1 спрос" }, priority: 65 },
      { id: "bad", owner: "topdown", sourceTf: "1d", kind: "box", tone: "up", label: "—", hover: { title: "—" }, priority: 65 },
    ];
    const s = scene("btc-4h-rich", preset("clean"), { external });
    const t = byLayer(s, "topdown");
    expect(t.map((o) => o.id)).toEqual(["ext:h1", "ext:b1"]);
    expect(s.byId.get("ext:h1")?.axis?.group).toBe("topdown");
    expect(s.byId.get("ext:b1")).toMatchObject({ kind: "box", top: 71000, bottom: 70000 });
    expect(s.legend.some((e) => e.key === "topdown")).toBe(false);
  });

  it("короткие подписи на телефоне, контурные цены по устройству", () => {
    const s = scene("btc-4h-rich", preset("levels"), { device: "phone" });
    const sr = byLayer(s, "sr");
    expect(sr.map((o) => o.label?.text).sort()).toEqual(["Подд.", "Подд.", "Сопр.", "Сопр."]);
    // на шкале телефона — 1 S/R на сторону, целые цены
    expect(sr.filter((o) => o.axis).map((o) => o.axis!.text)).toEqual(["80 273", "76 307"]);
    expect(PRESETS.levels.limits.srPerSide).toBe(2);
  });

  it("PEPE: id и цены по шагу 1e-7", () => {
    const s = scene("pepe-4h", preset("clean"));
    for (const o of byLayer(s, "sr")) {
      expect(o.id).toMatch(/^sr:[RS]:0\.\d{7}$/);
      expect(o.axis?.text).toMatch(/^0\.\d{7}$/);
    }
  });

  it("пустая история — пустая сцена без ошибок", () => {
    const fx = loadFixture("btc-4h-rich");
    const s = buildScene(makeInput(fx, { candles: [] }), resolvePreset(custom, "desktop", { authed: true }));
    expect(s.objects).toHaveLength(0);
    expect(s.legend.map((e) => e.key)).toEqual(["price", "selection"]);
    expect(s.index.levels.filter((r) => r.layer !== "levels")).toHaveLength(0);
    expect(sceneHover(s, "zzz")).toBeNull();
  });
});
