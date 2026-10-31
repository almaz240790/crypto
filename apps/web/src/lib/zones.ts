/**
 * Зоны интереса на графике (план 2A.4): понятные названия вместо OB/SD/FVG и склейка пересекающихся зон,
 * чтобы два прямоугольника с подписями не лежали друг на друге. Склейка живёт в пакете графика
 * (packages/charts/src/scene/zones.ts, виды зон — всегда в порядке ob → sd → fvg); здесь — прежняя сигнатура
 * с названиями и кодами для списков.
 */
import { mergeZones as mergeSceneZones, type ZoneIn } from "@platform/charts";

export type { ZoneIn };
export type ZoneGroup = { top: number; bottom: number; fromT: number; dir: "up" | "down" | "mixed"; names: string[]; codes: string[] };

/** Код зоны профессиональным жаргоном: OB, SD, FVG — для графика. */
export const zoneCode = (kind: string): string => kind.toUpperCase();

/** Ключи перевода — те же фразы, что ZONE_KIND_RU пакета (подсказка на графике). */
const NAMES: Record<string, { up: string; down: string }> = {
  ob: { up: "ордер-блок покупок", down: "ордер-блок продаж" },
  sd: { up: "зона спроса", down: "зона предложения" },
  fvg: { up: "разрыв цены вверх", down: "разрыв цены вниз" },
};

/** Название зоны простыми словами (ключ перевода) — для списка с пояснениями. */
export function zoneName(kind: string, dir: string): string {
  const n = NAMES[kind];
  if (!n) return kind.toUpperCase();
  return dir === "down" ? n.down : n.up;
}

/** Активные зоны, пересекающиеся по цене, склеиваются в одну; на выходе — от ближайшей к цене. */
export function mergeZones(zones: readonly ZoneIn[], price: number): ZoneGroup[] {
  return mergeSceneZones(zones, price).map((g) => {
    const names: string[] = [];
    for (const p of g.parts) {
      const n = zoneName(p.kind, p.dir);
      if (!names.includes(n)) names.push(n);
    }
    return { top: g.top, bottom: g.bottom, fromT: g.fromT, dir: g.dir, names, codes: g.kinds.map(zoneCode) };
  });
}
