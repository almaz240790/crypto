/**
 * Зоны интереса (план 2A.4): пересекающиеся активные зоны склеиваются в одну группу, чтобы два прямоугольника
 * с подписями не лежали друг на друге. Перенесено из apps/web/src/lib/zones.ts; виды зон в группе — всегда
 * в порядке ob → sd → fvg (раньше порядок зависел от того, какая зона ниже, и 4h с 1d давали разный текст).
 */
export type ZoneIn = { kind: string; dir: string; top: string; bottom: string; from_t: number; status: string };
/** kinds — виды зон группы (ob/sd/fvg) в фиксированном порядке; parts — вид и направление каждой исходной зоны. */
export type ZoneGroup = { top: number; bottom: number; fromT: number; dir: "up" | "down" | "mixed"; kinds: string[]; parts: { kind: string; dir: "up" | "down" }[] };

export const ZONE_KIND_ORDER: readonly string[] = ["ob", "sd", "fvg"];

const kindRank = (k: string): number => {
  const i = ZONE_KIND_ORDER.indexOf(k);
  return i < 0 ? ZONE_KIND_ORDER.length : i;
};

/** Виды зон в фиксированном порядке ob → sd → fvg, неизвестные — после, по алфавиту. */
export function sortZoneKinds(kinds: readonly string[]): string[] {
  return [...kinds].sort((a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b));
}

const sortParts = (parts: readonly ZoneGroup["parts"][number][]): ZoneGroup["parts"] =>
  [...parts].sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.kind.localeCompare(b.kind) || (a.dir === b.dir ? 0 : a.dir === "up" ? -1 : 1));

/** Расстояние от цены до группы: 0, если цена внутри. */
export function zoneDistance(g: Pick<ZoneGroup, "top" | "bottom">, price: number): number {
  return Math.max(0, g.bottom - price, price - g.top);
}

/** Активные зоны, пересекающиеся по цене, склеиваются в одну; на выходе — от ближайшей к цене. */
export function mergeZones(zones: readonly ZoneIn[], price: number): ZoneGroup[] {
  const active = zones
    .filter((z) => z.status === "active")
    .map((z) => ({ top: Number(z.top), bottom: Number(z.bottom), fromT: z.from_t, dir: z.dir === "down" ? ("down" as const) : ("up" as const), kind: z.kind }))
    .filter((z) => Number.isFinite(z.top) && Number.isFinite(z.bottom))
    .sort((a, b) => a.bottom - b.bottom || a.top - b.top || a.fromT - b.fromT);
  const groups: ZoneGroup[] = [];
  for (const z of active) {
    const g = groups.at(-1);
    if (g && z.bottom <= g.top) {
      g.top = Math.max(g.top, z.top);
      g.fromT = Math.min(g.fromT, z.fromT);
      if (g.dir !== z.dir) g.dir = "mixed";
      if (!g.kinds.includes(z.kind)) g.kinds.push(z.kind);
      if (!g.parts.some((x) => x.kind === z.kind && x.dir === z.dir)) g.parts.push({ kind: z.kind, dir: z.dir });
    } else groups.push({ top: z.top, bottom: z.bottom, fromT: z.fromT, dir: z.dir, kinds: [z.kind], parts: [{ kind: z.kind, dir: z.dir }] });
  }
  for (const g of groups) {
    g.kinds = sortZoneKinds(g.kinds);
    g.parts = sortParts(g.parts);
  }
  return groups.sort((a, b) => zoneDistance(a, price) - zoneDistance(b, price) || a.bottom - b.bottom);
}
