/**
 * Порядок монет по капитализации для всех списков инструментов: BTC, ETH, BNB, XRP, SOL…, а не алфавит.
 *
 * Место приходит из API — поле rank в /v1/instruments и в строках скринера (apps/api/app/coin_rank.py,
 * обновление с CoinGecko раз в сутки). Пока поля нет (API до этой правки), место берётся из COIN_ORDER —
 * того же снимка, что STATIC_ORDER в API (сверяет apps/api/tests/test_coin_rank.py). Монеты без места —
 * после всех, по алфавиту.
 */

/** Снимок CoinGecko /coins/markets на 2026-11-04: базы по убыванию капитализации без стейблкоинов, обёрток и бумаг. */
export const COIN_ORDER: readonly string[] = [
  "BTC", "ETH", "BNB", "XRP", "SOL", "TRX", "ZEC", "HYPE", "DOGE", "XMR",
  "WBT", "LINK", "LEO", "ADA", "XLM", "BCH", "NEAR", "UNI", "LTC", "RAIN",
  "CC", "AVAX", "SUI", "TON", "HBAR", "QNT", "SHIB", "TAO", "CRO", "ENA",
  "OKB", "PEPE", "AAVE", "PUMP", "ONDO", "M", "ASTER", "DOT", "BTW", "SKY",
  "MNT", "MORPHO", "WLFI", "WLD", "ICP", "HTX", "BGB", "ARB", "ETC", "JST",
  "VVV", "KCS", "POL", "GT", "KAS", "ALGO", "PI", "JUP", "LIT", "RENDER",
  "ATOM", "INJ", "NEXO", "ZRO", "FIL", "NIGHT", "STX", "CAKE", "XDC", "DASH",
  "ETHFI", "BDX", "APT", "PEARL", "STABLE", "FLR", "PYTH", "VET", "PENGU", "RAY",
  "TIA", "CRV", "GRASS", "TRUMP", "VIRTUAL", "FET", "HASH", "DRV", "SPX", "BTT",
  "BSV", "SEI", "STRK", "PIEVERSE", "FF", "PENDLE", "XPL", "SUN", "GNO", "LDO",
  "KITE", "XTZ", "OHM", "BONK", "UB", "OP", "APEPE", "CFX", "CARDS", "BP",
  "AERO", "DCR", "LUNC", "GRT", "NFT", "FLOKI", "KAIA", "MON", "AR", "ENS",
  "BEAM", "BAT", "RUNE", "KMNO", "COMP", "KOGE", "ZBCN", "JASMY", "JTO", "EIGEN",
  "IOTA", "AKT", "SYRUP", "SHFL", "FLUID", "CVX", "ZAMA", "WIF", "BTSE", "GEOD",
  "ANVL", "TWT", "MET", "S", "KNTQ", "GOMINING", "THETA", "TRAC", "AXS", "BORG",
  "BC", "PONS", "MANA", "MX", "CAP", "USELESS", "COCO", "XCN", "NEO", "EOS",
  "BR", "NPC", "VSN", "SN51", "SENT", "SAND", "Q", "RAIL", "YELLOW", "FARTCOIN",
  "B", "2Z", "AWE", "CHZ", "XEC", "OZO", "AIOZ", "EDGE", "1INCH", "SUPER",
  "APE", "ZK", "RLB", "SFP", "IMX", "GLM", "H", "DGAI", "ATH", "SOSO",
  "CASHCAT", "EGLD", "SNX", "STONK", "GENIUS", "PLUME", "ZEN", "SN64", "META", "0G",
  "SKR", "PROM", "GMX", "ULTIMA", "NXM", "RSR", "ORCA", "BABYCLAW", "DYDX", "SOON",
  "SHX", "DOG", "GALA", "PEAQ", "QRL", "YZY", "HOT", "DBR", "ZRX", "RED",
  "ARKM", "CHEEMS", "QTUM", "TAG", "SN4", "WAL", "FORM", "GAS", "W", "MINA",
  "ORE", "PROS", "ADI", "ORDI", "CRX", "KAVA", "MAGMA", "YFI", "APES", "MELANIA",
  "LPT", "PURR", "HNT", "NMR", "ALLO", "O", "WEMIX", "COW", "AP3X", "SAFE",
  "UNT", "KSM", "NILA", "DIEM", "OMI", "MOOLAH", "ELG", "TEMPLE", "AKE", "ZANO",
  "RIF", "VELO", "AI", "ZETA", "PRIZE", "QUBIC", "WIN", "GAL", "JCT", "TFUEL",
  "BABY", "AMP", "ALEO", "BANANAS31", "BABYDOGE", "LINEA", "VTHO", "CKB", "SWOP", "DGB",
  "ONE", "ARX", "SPK", "ZIG", "KAITO", "ESP", "SUSHI", "NOXO", "MCAT", "IO",
  "FT", "TURBO", "XPR", "MEGA", "EXOD", "METAL", "FONQ", "AXL", "MARSCOIN", "NXPC",
];

const STATIC_RANK: ReadonlyMap<string, number> = new Map(COIN_ORDER.map((b, i) => [b, i + 1]));
/** Бывшие тикеры Binance → нынешние. */
const ALIASES: Readonly<Record<string, string>> = { RNDR: "RENDER", MATIC: "POL" };
const QUOTES = ["USDT", "USDC", "FDUSD", "BUSD", "USD"] as const;

/** База в записи порядка: без множителя (1000PEPE → PEPE) и с нынешним тикером. */
export function normalizeBase(base: string): string {
  const b = base.trim().toUpperCase().replace(/^(?:1000000|1000|1M)(?=[A-Z])/, "");
  return ALIASES[b] ?? b;
}

/** База по символу пары: 1000PEPEUSDT → PEPE. */
export function baseOf(symbol: string): string {
  let s = symbol.trim().toUpperCase();
  const q = QUOTES.find((x) => s.endsWith(x) && s.length > x.length);
  if (q) s = s.slice(0, -q.length);
  return normalizeBase(s);
}

export type Rankable = { symbol: string; base?: string | null; rank?: number | null };

/** Место монеты: из API, если поле есть (null — капитализации нет), иначе по статическому порядку. */
export function coinRank(x: Rankable): number | null {
  if (x.rank !== undefined) return x.rank;
  return STATIC_RANK.get(x.base ? normalizeBase(x.base) : baseOf(x.symbol)) ?? null;
}

/** Сравнение для sort: по месту, монеты без места — после всех, между собой — по алфавиту. */
export function compareByRank(a: Rankable, b: Rankable): number {
  const ra = coinRank(a);
  const rb = coinRank(b);
  if (ra !== rb) {
    if (ra === null) return 1;
    if (rb === null) return -1;
    return ra - rb;
  }
  return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
}

/** Копия списка в порядке капитализации. */
export function sortByRank<T extends Rankable>(items: readonly T[]): T[] {
  return [...items].sort(compareByRank);
}
