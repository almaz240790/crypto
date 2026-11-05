import { coinRank, compareByRank } from "./coinRank";
import type { ScreenerRow } from "./user";

/** Колонки сортировки скринера; rank — место по капитализации (по умолчанию: BTC, ETH, BNB…). */
export type ScreenerSortKey = "rank" | "symbol" | "change_24h" | "volume_24h" | "zone" | "atr_percentile" | "funding" | "oi_change_24h" | "ls_ratio" | "beta_btc";
export type ScreenerSort = { k: ScreenerSortKey; d: 1 | -1 };
export const DEFAULT_SCREENER_SORT: ScreenerSort = { k: "rank", d: 1 };

/** Направление при первом клике по колонке: место и имя — по возрастанию, числа — по убыванию. */
export const firstDirection = (k: ScreenerSortKey): 1 | -1 => (k === "rank" || k === "symbol" ? 1 : -1);

function num(x: string | null | undefined): number | null {
  if (x === null || x === undefined) return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function key(r: ScreenerRow, k: ScreenerSortKey): number | string | null {
  switch (k) {
    case "rank":
      return coinRank(r);
    case "symbol":
      return r.symbol;
    case "zone":
      return r.zone ? num(r.zone.distance_atr) : null;
    default:
      return num(r[k]);
  }
}

/** Копия строк в порядке сортировки: пустые значения — в конце, равные и пустые — по капитализации. */
export function sortScreenerRows(rows: readonly ScreenerRow[], sort: ScreenerSort): ScreenerRow[] {
  return [...rows].sort((a, b) => {
    const x = key(a, sort.k);
    const y = key(b, sort.k);
    if (x === null && y === null) return compareByRank(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sort.d || compareByRank(a, b);
  });
}
