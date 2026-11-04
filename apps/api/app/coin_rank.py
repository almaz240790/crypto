"""Порядок монет по капитализации: списки инструментов — BTC, ETH, BNB, XRP, SOL…, а не по алфавиту.

Источник — публичный CoinGecko ``/coins/markets`` (без ключа). Порядок — список баз инструментов
в нашей записи (``PEPE`` для 1000PEPEUSDT, ``TON`` для монеты, которую CoinGecko теперь зовёт GRAM)
по убыванию капитализации, без стейблкоинов, обёрток и стейкинга, токенизированных акций, фондов
и металлов. Место (``rank``) — позиция в этом списке с единицы: у BTC — 1.

Обновление — в процессе notifier (ADR-0002): при старте и затем раз в сутки ``refresh_if_due``
кладёт порядок в Redis (``coins:rank``, TTL ~36 ч). API в запросе сети не трогает: читает Redis
(``current_ranks``) с кэшем в памяти процесса, а без Redis или при пустом ключе берёт
``STATIC_ORDER`` — снимок CoinGecko на 2026-11-04 (обновить: ``scripts/coin_order.py``).
Сбой CoinGecko не трогает последний сохранённый порядок.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

import httpx

log = logging.getLogger("coin_rank")

COINGECKO_MARKETS = "https://api.coingecko.com/api/v3/coins/markets"
PER_PAGE = 250
PAGES = 2
"""Первые 500 монет: все наши инструменты в первой пятисотке с запасом."""
HTTP_TIMEOUT = 10.0
REDIS_KEY = "coins:rank"
REDIS_TTL = 36 * 3600
"""Сутки до следующего обновления и полсуток на сбои CoinGecko; дальше — статический порядок."""
REFRESH_EVERY = timedelta(hours=24)
MIN_COINS = 100
"""Ответ короче — не рейтинг (обрезанная страница, заглушка): считаем сбоем и не сохраняем."""
MEMO_TTL = 600.0
"""Сколько API держит прочитанный из Redis порядок в памяти процесса, с."""
MEMO_TTL_FALLBACK = 60.0
"""То же для статического порядка (нет Redis или ключа) — чтобы быстрее подхватить свежий."""

# Бывшие тикеры Binance → нынешние (монета та же).
ALIASES: dict[str, str] = {"RNDR": "RENDER", "MATIC": "POL"}

# База инструмента (без множителя 1000) → id монеты в CoinGecko. Явно для всех наших инструментов:
# тикеры CoinGecko меняются (TON → GRAM, EOS → A у Vaulta) и бывают у нескольких монет (TON —
# ещё и Tokamak). Базы вне словаря сопоставляются по тикеру CoinGecko.
COINGECKO_IDS: dict[str, str] = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "BNB": "binancecoin",
    "XRP": "ripple",
    "SOL": "solana",
    "TRX": "tron",
    "ZEC": "zcash",
    "DOGE": "dogecoin",
    "LINK": "chainlink",
    "ADA": "cardano",
    "XLM": "stellar",
    "BCH": "bitcoin-cash",
    "NEAR": "near",
    "UNI": "uniswap",
    "LTC": "litecoin",
    "AVAX": "avalanche-2",
    "SUI": "sui",
    "TON": "the-open-network",
    "HBAR": "hedera-hashgraph",
    "SHIB": "shiba-inu",
    "TAO": "bittensor",
    "ENA": "ethena",
    "PEPE": "pepe",
    "AAVE": "aave",
    "ONDO": "ondo-finance",
    "DOT": "polkadot",
    "WLD": "worldcoin-wld",
    "ICP": "internet-computer",
    "ARB": "arbitrum",
    "ETC": "ethereum-classic",
    "POL": "polygon-ecosystem-token",
    "ALGO": "algorand",
    "JUP": "jupiter-exchange-solana",
    "RENDER": "render-token",
    "ATOM": "cosmos",
    "INJ": "injective-protocol",
    "FIL": "filecoin",
    "STX": "blockstack",
    "APT": "aptos",
    "VET": "vechain",
    "TIA": "celestia",
    "CRV": "curve-dao-token",
    "FET": "fetch-ai",
    "SEI": "sei-network",
    "PENDLE": "pendle",
    "LDO": "lido-dao",
    "BONK": "bonk",
    "OP": "optimism",
    "GRT": "the-graph",
    "FLOKI": "floki",
    "RUNE": "thorchain",
    "WIF": "dogwifcoin",
    "AXS": "axie-infinity",
    "MANA": "decentraland",
    "EOS": "vaulta",
    "SAND": "the-sandbox",
    "IMX": "immutable-x",
    "DYDX": "dydx-chain",
    "GALA": "gala",
    "ORDI": "ordinals",
    # Maker перешёл в Sky: у MKR в CoinGecko нет капитализации — в порядке его нет, он после всех.
    "MKR": "maker",
}
BASE_BY_ID: dict[str, str] = {v: k for k, v in COINGECKO_IDS.items()}

# Не монеты в смысле рейтинга: стейблкоины, обёртки и стейкинг, токенизированные акции, фонды,
# металлы, долговые бумаги. Сито грубое: ошибка сдвигает только места чужих монет — наши
# инструменты из COINGECKO_IDS через него не проходят.
_NOT_A_COIN = re.compile(
    r"usd|\beur|dollar|euro|stablecoin|wrapped|staked|staking|restak|bridged|tokeni[sz]ed"
    r"|xstock|bstock|\bgold\b|silver|treasury|t-bills?\b|money market|\bfund\b|\bclo\b"
    r"|securitize|reinsurance|\bbond\b|^tradable-|^pc\d{4,}$",
    re.IGNORECASE,
)
_NOT_A_COIN_IDS = frozenset(
    {
        "dai",
        "gho",
        "usx",
        "usa",
        "cash-4",
        "ylds",
        "united-stables",
        "figure-heloc",
        "hashnote-usyc",
        "hastra-auto",
        "nest-blackopal-liquidstone-ii-vault",
        "verified-emeralds",
        "alpha-bulgaria-warrants",
        "jpycoin",
        "jpysc",
        "a7a5",
        "crown-brlv",
    }
)
_NOT_A_COIN_ID_PREFIXES = ("midas-",)
_TICKER = re.compile(r"[A-Z0-9]{1,20}")
_MULTIPLIER = re.compile(r"^(?:1000000|1000|1M)(?=[A-Z])")
QUOTES = ("USDT", "USDC", "FDUSD", "BUSD", "USD")

# Снимок CoinGecko /coins/markets на 2026-11-04 (первые 300 после сита) — scripts/coin_order.py.
# Тот же список — COIN_ORDER в apps/web/src/lib/coinRank.ts (сверяет тест test_coin_rank.py).
# fmt: off
STATIC_ORDER: tuple[str, ...] = (
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
)
# fmt: on


def normalize_base(base: str) -> str:
    """База инструмента в записи порядка: без множителя (1000PEPE → PEPE) и с нынешним тикером."""
    b = _MULTIPLIER.sub("", base.strip().upper())
    return ALIASES.get(b, b)


def base_of(symbol: str) -> str:
    """База по символу пары, когда поля ``base`` нет: 1000PEPEUSDT → PEPE."""
    s = symbol.strip().upper()
    for q in QUOTES:
        if s.endswith(q) and len(s) > len(q):
            s = s[: -len(q)]
            break
    return normalize_base(s)


def is_coin(market: Mapping[str, Any]) -> bool:
    """Монета для рейтинга: не стейблкоин, не обёртка, не токенизированная бумага или металл."""
    cid = str(market.get("id") or "")
    if cid in BASE_BY_ID:
        return True
    if cid in _NOT_A_COIN_IDS or cid.startswith(_NOT_A_COIN_ID_PREFIXES):
        return False
    fields = (cid, str(market.get("symbol") or ""), str(market.get("name") or ""))
    return not any(_NOT_A_COIN.search(f) for f in fields)


def _cap(market: Mapping[str, Any]) -> float:
    try:
        return float(market.get("market_cap") or 0)
    except (TypeError, ValueError):
        return 0.0


def order_from_markets(markets: Iterable[Mapping[str, Any]]) -> list[str]:
    """Порядок баз по убыванию капитализации из ответа /coins/markets (все страницы вместе).

    Наши монеты узнаются по id (``COINGECKO_IDS``), прочие — по тикеру; из монет с одинаковым
    тикером остаётся самая крупная, а тикер нашей базы не достаётся чужой монете.
    """
    ranked = sorted((m for m in markets if _cap(m) > 0), key=_cap, reverse=True)
    order: list[str] = []
    seen: set[str] = set()
    for m in ranked:
        if not is_coin(m):
            continue
        key = BASE_BY_ID.get(str(m.get("id") or ""))
        if key is None:
            key = normalize_base(str(m.get("symbol") or ""))
            if not _TICKER.fullmatch(key) or key in COINGECKO_IDS:
                continue
        if key not in seen:
            seen.add(key)
            order.append(key)
    return order


def rank_table(order: Sequence[str]) -> dict[str, int]:
    """База → место (1 — самая крупная)."""
    return {b: i + 1 for i, b in enumerate(order)}


def rank_of(base: str, table: Mapping[str, int]) -> int | None:
    return table.get(normalize_base(base))


def rank_sort_key(rank: int | None, symbol: str) -> tuple[int, int, str]:
    """Сначала по месту, монеты без места — после всех, по алфавиту."""
    return (0, rank, symbol) if rank is not None else (1, 0, symbol)


def fetch_markets(client: httpx.Client, pages: int = PAGES) -> list[dict[str, Any]]:
    """Первые ``pages`` × 250 монет по капитализации. Ошибка сети или ответа — исключение."""
    out: list[dict[str, Any]] = []
    for page in range(1, pages + 1):
        r = client.get(
            COINGECKO_MARKETS,
            params={
                "vs_currency": "usd",
                "order": "market_cap_desc",
                "per_page": PER_PAGE,
                "page": page,
            },
            headers={"accept": "application/json"},
            timeout=HTTP_TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, list):
            raise ValueError(f"CoinGecko: ожидался список, пришло {type(data).__name__}")
        out.extend(m for m in data if isinstance(m, dict))
    return out


class RedisLike(Protocol):
    def get(self, name: str) -> Any: ...
    def set(self, name: str, value: str, ex: int | None = None) -> Any: ...


def load_cached(r: RedisLike) -> dict[str, Any] | None:
    """Сохранённый порядок ``{"order": [...], "fetched_at": iso}`` или None (нет, битый)."""
    raw = r.get(REDIS_KEY)
    if not raw:
        return None
    try:
        data = json.loads(raw)
        order = data["order"]
        fetched = datetime.fromisoformat(data["fetched_at"])
    except (ValueError, KeyError, TypeError):
        return None
    if not isinstance(order, list) or not all(isinstance(x, str) for x in order) or not order:
        return None
    if fetched.tzinfo is None:
        return None
    return {"order": order, "fetched_at": fetched}


def save_cached(r: RedisLike, order: Sequence[str], now: datetime) -> None:
    payload = {"order": list(order), "fetched_at": now.isoformat(), "source": "coingecko"}
    r.set(REDIS_KEY, json.dumps(payload), ex=REDIS_TTL)


def refresh_if_due(r: RedisLike, client: httpx.Client, now: datetime | None = None) -> str:
    """Обновить порядок, если сохранённому больше суток или его нет.

    ``fresh`` — обновлять рано; ``updated`` — сохранён новый; ``failed`` — CoinGecko не ответил
    или ответ не похож на рейтинг: в Redis остаётся прежний порядок (а без него API берёт
    статический). Исключений не бросает — цикл воркера не должен из-за этого падать.
    """
    now = now or datetime.now(tz=UTC)
    try:
        cached = load_cached(r)
    except Exception:
        log.warning("порядок монет: Redis недоступен", exc_info=True)
        return "failed"
    if cached and now - cached["fetched_at"] < REFRESH_EVERY:
        return "fresh"
    try:
        order = order_from_markets(fetch_markets(client))
    except Exception as exc:
        log.warning("порядок монет: CoinGecko не ответил (%s), остаётся прежний", exc)
        return "failed"
    if len(order) < MIN_COINS or "BTC" not in order[:3]:
        log.warning("порядок монет: ответ не похож на рейтинг (%d), остаётся прежний", len(order))
        return "failed"
    try:
        save_cached(r, order, now)
    except Exception:
        log.warning("порядок монет: не удалось сохранить в Redis", exc_info=True)
        return "failed"
    log.info("порядок монет обновлён: %d, первые %s", len(order), ", ".join(order[:5]))
    return "updated"


_memo: dict[str, Any] = {"until": 0.0, "table": None}
_memo_lock = threading.Lock()
STATIC_TABLE = rank_table(STATIC_ORDER)


def _redis() -> RedisLike:
    import redis

    from app.config import settings

    return redis.from_url(settings.redis_url, socket_timeout=1, socket_connect_timeout=1)


def current_ranks(r: RedisLike | None = None, clock: float | None = None) -> Mapping[str, int]:
    """Таблица мест для ответа API: из Redis (кэш в памяти процесса) или статическая.

    Только для чтения: та же таблица отдаётся всем запросам до истечения кэша.
    """
    now = time.monotonic() if clock is None else clock
    with _memo_lock:
        if _memo["table"] is not None and now < _memo["until"]:
            return _memo["table"]  # type: ignore[no-any-return]
        table: dict[str, int] | None = None
        try:
            cached = load_cached(r if r is not None else _redis())
            if cached:
                table = rank_table(cached["order"])
        except Exception:
            log.warning("порядок монет: Redis недоступен, статический порядок")
        ttl = MEMO_TTL if table is not None else MEMO_TTL_FALLBACK
        result = table if table is not None else STATIC_TABLE
        _memo.update(table=result, until=now + ttl)
        return result


def reset_memo() -> None:
    """Для тестов: забыть кэш процесса."""
    with _memo_lock:
        _memo.update(table=None, until=0.0)
