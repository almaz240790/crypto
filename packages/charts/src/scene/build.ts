import { INDEX_LIMITS, type ResolvedPreset } from "../presets";
import type { LayerKey, SceneLayer, Tone } from "../types";
import { LAYER_KEYS } from "../types";
import { identity, type SceneInput } from "./input";
import { buildAlerts } from "./layers/alerts";
import { makeCtx, type Built, type LayerBuilder } from "./layers/common";
import { buildExternal } from "./layers/external";
import { buildFigures } from "./layers/figures";
import { buildLevels, LEVEL_KEYS } from "./layers/levels";
import { buildLiq, liqTopId } from "./layers/liq";
import { buildPatterns } from "./layers/patterns";
import { buildProfile } from "./layers/profile";
import { buildSignals } from "./layers/signals";
import { buildSr, srId } from "./layers/sr";
import { buildStructure } from "./layers/structure";
import { buildZones, zoneId } from "./layers/zones";
import type { TextKey } from "./text";
import type { HoverInfo, LegendEntry, LegendKey, LevelRow, Scene, SceneIndex, SceneObject } from "./types";
import { zoneDistance } from "./zones";

export type { Built, LayerBuilder } from "./layers/common";

/** Порядок слоёв при равном приоритете подписи (layoutLabels) — от важного к фону. */
export const LAYER_ORDER: readonly SceneLayer[] = ["alerts", "signals", "sr", "zones", "topdown", "structure", "figures", "levels", "liq_map", "volume_profile", "patterns"];
/** Порядок отрисовки объектов: фон снизу, значки и уровни пользователя сверху (тот же порядок у hitTest). */
export const DRAW_ORDER: readonly SceneLayer[] = ["volume_profile", "liq_map", "zones", "levels", "figures", "structure", "topdown", "sr", "signals", "alerts", "patterns"];

/** Один чистый построитель на слой: scene/layers/*.ts. */
export const LAYER_BUILDERS: Readonly<Record<SceneLayer, LayerBuilder>> = {
  sr: buildSr,
  zones: buildZones,
  structure: buildStructure,
  levels: buildLevels,
  liq_map: buildLiq,
  figures: buildFigures,
  patterns: buildPatterns,
  signals: buildSignals,
  alerts: buildAlerts,
  volume_profile: buildProfile,
  topdown: buildExternal,
};

const isLayerKey = (l: SceneLayer): l is LayerKey => (LAYER_KEYS as readonly string[]).includes(l);
/** Алерты и «Разбор» не переключаются слоями: их показывает владелец. */
export const layerOn = (preset: ResolvedPreset, layer: SceneLayer): boolean => (isLayerKey(layer) ? preset.layers[layer] : true);

type LegendDef = { layer: SceneLayer | null; tone: Tone; mark: LegendEntry["mark"]; text: TextKey; explain: TextKey };
/** Строки легенды «?» в порядке показа; «Цена» и «Выделение» есть всегда. */
const LEGEND: Readonly<Record<LegendKey, LegendDef | null>> = {
  price: { layer: null, tone: "up", mark: "price", text: "legend.price", explain: "legend.price.explain" },
  resistance: { layer: "sr", tone: "down", mark: "line", text: "sr.resistance", explain: "legend.resistance.explain" },
  support: { layer: "sr", tone: "up", mark: "line", text: "sr.support", explain: "legend.support.explain" },
  demand: { layer: "zones", tone: "up", mark: "box", text: "zone.demand", explain: "legend.demand.explain" },
  supply: { layer: "zones", tone: "down", mark: "box", text: "zone.supply", explain: "legend.supply.explain" },
  zone: { layer: "zones", tone: "muted", mark: "box", text: "zone.mixed", explain: "legend.zone.explain" },
  bos: { layer: "structure", tone: "structure", mark: "line", text: "legend.bos", explain: "legend.bos.explain" },
  choch: { layer: "structure", tone: "structure", mark: "line", text: "legend.choch", explain: "legend.choch.explain" },
  sweep: { layer: "structure", tone: "structure", mark: "glyph", text: "legend.sweep", explain: "legend.sweep.explain" },
  eq: { layer: "structure", tone: "structure", mark: "dashed", text: "legend.eq", explain: "legend.eq.explain" },
  level: { layer: "levels", tone: "muted", mark: "dotted", text: "legend.level", explain: "legend.level.explain" },
  liq: { layer: "liq_map", tone: "liq", mark: "heat", text: "legend.liq", explain: "legend.liq.explain" },
  figure: { layer: "figures", tone: "figure", mark: "dashed", text: "legend.figure", explain: "legend.figure.explain" },
  pattern: { layer: "patterns", tone: "muted", mark: "glyph", text: "legend.pattern", explain: "legend.pattern.explain" },
  poc: { layer: "volume_profile", tone: "muted", mark: "line", text: "vp.poc", explain: "legend.poc.explain" },
  alert: { layer: "alerts", tone: "alert", mark: "dashed", text: "legend.alert", explain: "legend.alert.explain" },
  position: { layer: "signals", tone: "position", mark: "line", text: "legend.position", explain: "legend.position.explain" },
  // объекты «Разбора» объясняет панель-владелец
  topdown: null,
  selection: { layer: null, tone: "selection", mark: "selection", text: "legend.selection", explain: "legend.selection.explain" },
};
const LEGEND_ORDER = Object.keys(LEGEND) as LegendKey[];

/**
 * Ключ входа сцены. Начало буфера в ключ не входит (подгрузка истории сцену не пересобирает): объекты,
 * начинающиеся раньше первого бара, обрезает отрисовка. Массивы сравниваются по ссылке.
 */
export function sceneKey(input: SceneInput, preset: ResolvedPreset): string {
  const alerts = input.alerts.map((a) => `${a.id}:${a.op}:${a.price}:${a.price2 ?? ""}`).join(",");
  const hidden = [...input.selection.hidden].sort().join(",");
  const layers = LAYER_KEYS.map((k) => (preset.layers[k] ? "1" : "0")).join("");
  return [
    input.analytics.key,
    input.tf,
    identity(input.structure),
    identity(input.patterns),
    identity(input.figures),
    identity(input.signals),
    identity(input.external),
    alerts,
    input.selection.selected ?? "",
    hidden,
    preset.id,
    layers,
    preset.view.device,
    input.fmt.precision,
    input.fmt.axis(12345.6789),
    identity(input.text),
  ].join("|");
}

const pct = (price: number, ref: number) => (ref !== 0 ? ((price - ref) / ref) * 100 : 0);

/** Каталог «Найдено → Уровни»: по INDEX_LIMITS, независимо от слоёв; onChart — нарисован ли объект. */
function buildIndex(input: SceneInput, preset: ResolvedPreset, drawn: ReadonlySet<string>, version: number): SceneIndex {
  const a = input.analytics;
  const ref = a.lastClosed?.close ?? 0;
  const precision = input.fmt.precision;
  const rows: LevelRow[] = [];
  for (const l of a.sr) rows.push({ id: srId(l, precision), layer: "sr", kind: l.side, price: l.price, touches: l.touches, distancePct: pct(l.price, ref), onChart: false });
  const zoneIds = new Set<string>();
  a.zones.forEach((g, i) => {
    const id = zoneId(g, precision);
    if (i >= INDEX_LIMITS.zones && !drawn.has(id)) return;
    zoneIds.add(id);
    const d = zoneDistance(g, ref);
    const signed = d === 0 ? 0 : g.bottom > ref ? pct(g.bottom, ref) : pct(g.top, ref);
    rows.push({ id, layer: "zones", kind: g.dir === "up" ? "demand" : g.dir === "down" ? "supply" : "zone", price: g.bottom, priceTo: g.top, kinds: g.kinds, parts: g.parts, distancePct: signed, onChart: false });
  });
  if (a.liq) {
    const m = a.liq;
    for (const b of m.topShorts) rows.push({ id: liqTopId("short", m.buckets.indexOf(b)), layer: "liq_map", kind: "liq-short", price: b.price, amountUsd: b.short, estimate: true, distancePct: pct(b.price, ref), onChart: false });
    for (const b of m.topLongs) rows.push({ id: liqTopId("long", m.buckets.indexOf(b)), layer: "liq_map", kind: "liq-long", price: b.price, amountUsd: b.long, estimate: true, distancePct: pct(b.price, ref), onChart: false });
  }
  const st = input.structure;
  if (st) {
    for (const k of LEVEL_KEYS) {
      const raw = st.levels[k];
      const price = raw == null ? NaN : Number(raw);
      if (Number.isFinite(price)) rows.push({ id: `lvl:${k}`, layer: "levels", kind: k, price, distancePct: pct(price, ref), onChart: false });
    }
  }
  for (const r of rows) r.onChart = drawn.has(r.id);
  rows.sort((x, y) => y.price - x.price || x.id.localeCompare(y.id));
  const dropped = new Set(rows.filter((r) => !r.onChart && layerOn(preset, r.layer)).map((r) => r.id));
  return { version, levels: rows, onChart: drawn, dropped, liqUnavailable: a.liqUnavailable };
}

function buildLegend(input: SceneInput, keys: ReadonlySet<LegendKey>): LegendEntry[] {
  const t = input.text;
  const out: LegendEntry[] = [];
  for (const key of LEGEND_ORDER) {
    const d = LEGEND[key];
    if (!d || (key !== "price" && key !== "selection" && !keys.has(key))) continue;
    out.push({ key, layer: d.layer, tone: d.tone, mark: d.mark, text: t[d.text], explain: t[d.explain] });
  }
  return out;
}

/**
 * Сцена из входа и пресета. Чистая функция: без LWC, DOM и hex-цветов. При том же ключе возвращает prev
 * (тот же объект, версия не растёт). Выключенный слой даёт только выбранный объект: выбранный рисуется всегда.
 */
export function buildScene(input: SceneInput, preset: ResolvedPreset, prev?: Scene): Scene {
  const key = sceneKey(input, preset);
  if (prev && prev.key === key) return prev;
  const version = (prev?.version ?? 0) + 1;
  const ctx = makeCtx(input, preset);
  const hidden = input.selection.hidden;
  const byLayer = new Map<SceneLayer, Built[]>();
  if (ctx) {
    for (const layer of DRAW_ORDER) {
      const on = layerOn(preset, layer);
      const built = LAYER_BUILDERS[layer](ctx).filter((b) => (on || b.obj.emphasis === "selected") && (!hidden.has(b.obj.id) || b.obj.emphasis === "selected"));
      byLayer.set(layer, built);
    }
  }
  const objects: SceneObject[] = [];
  const legendKeys = new Set<LegendKey>();
  const byId = new Map<string, SceneObject>();
  const drawn = new Set<string>();
  for (const layer of DRAW_ORDER) {
    for (const b of byLayer.get(layer) ?? []) {
      objects.push(b.obj);
      byId.set(b.obj.id, b.obj);
      drawn.add(b.obj.id);
      if (b.legend) legendKeys.add(b.legend);
      if (b.obj.kind === "heat")
        for (const top of b.obj.tops) {
          byId.set(top.id, b.obj);
          drawn.add(top.id);
        }
    }
  }
  return {
    version,
    key,
    objects,
    byId,
    legend: buildLegend(input, legendKeys),
    index: buildIndex(input, preset, drawn, version),
    selected: input.selection.selected,
  };
}

/** Подсказка объекта по id (в том числе подписи суммы ликвидаций). */
export function sceneHover(scene: Scene, id: string): HoverInfo | null {
  const obj = scene.byId.get(id);
  if (!obj) return null;
  if (obj.kind === "heat" && obj.id !== id) return obj.tops.find((t) => t.id === id)?.hover ?? obj.hover;
  return obj.hover;
}

/** id для выбора: у объектов группы (фигура, сигнал, алерт) — id группы. */
export function selectionId(scene: Scene, id: string): string {
  const obj = scene.byId.get(id);
  return obj?.groupId ?? id;
}


