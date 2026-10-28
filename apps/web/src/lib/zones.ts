/**
 * Зоны интереса на графике (план 2A.4): понятные названия вместо OB/SD/FVG и склейка пересекающихся зон,
 * чтобы два прямоугольника с подписями не лежали друг на друге.
 */
export type ZoneIn = { kind: string; dir: string; top: string; bottom: string; from_t: number; status: string };
export type ZoneGroup = { top: number; bottom: number; fromT: number; dir: "up" | "down" | "mixed"; names: string[]; codes: string[] };

const NAMES: Record<string, { up: string; down: string }> = {
  ob: { up: "ордер-блок покупок", down: "ордер-блок продаж" },
  sd: { up: "зона спроса", down: "зона предложения" },
  fvg: { up: "разрыв цены вверх", down: "разрыв цены вниз" },
};

/** Код зоны профессиональным жаргоном: OB, SD, FVG — для графика. */
export const zoneCode = (kind: string): string => kind.toUpperCase();

/** Название зоны простыми словами (ключ перевода) — для списка с пояснениями. */
export function zoneName(kind: string, dir: string): string {
  const n = NAMES[kind];
  if (!n) return kind.toUpperCase();
  return dir === "down" ? n.down : n.up;
}

/** Активные зоны, пересекающиеся по цене, склеиваются в одну; на выходе — от ближайшей к цене. */
export function mergeZones(zones: readonly ZoneIn[], price: number): ZoneGroup[] {
  const active = zones
    .filter((z) => z.status === "active")
    .map((z) => ({ top: Number(z.top), bottom: Number(z.bottom), fromT: z.from_t, dir: z.dir === "down" ? ("down" as const) : ("up" as const), name: zoneName(z.kind, z.dir), code: zoneCode(z.kind) }))
    .sort((a, b) => a.bottom - b.bottom);
  const groups: ZoneGroup[] = [];
  for (const z of active) {
    const g = groups.at(-1);
    if (g && z.bottom <= g.top) {
      g.top = Math.max(g.top, z.top);
      g.fromT = Math.min(g.fromT, z.fromT);
      if (g.dir !== z.dir) g.dir = "mixed";
      if (!g.names.includes(z.name)) g.names.push(z.name);
      if (!g.codes.includes(z.code)) g.codes.push(z.code);
    } else groups.push({ top: z.top, bottom: z.bottom, fromT: z.fromT, dir: z.dir, names: [z.name], codes: [z.code] });
  }
  const dist = (g: ZoneGroup) => Math.max(0, g.bottom - price, price - g.top);
  return groups.sort((a, b) => dist(a) - dist(b));
}
