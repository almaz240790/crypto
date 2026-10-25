"""Скринер (план 3.6, MVP): по каждому инструменту — bias D1/W1, последнее событие структуры H4,
ближайшая активная зона и расстояние до неё в ATR, ATR-перцентиль, изменение и объём за 24 ч,
funding и его перцентиль за 90 дней, изменение OI за 24 ч, ликвидации за 24 ч, бета к BTC.

Считается по закрытым свечам теми же функциями движка; кэш в памяти процесса на ``TTL`` секунд.
"""

from __future__ import annotations

import itertools
import threading
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.forward import _candles
from app.models import Instrument
from engine.bias import context_at
from engine.candles import Candle, Timeframe, closed_only
from engine.filters import _percentile_rank, atr_regime
from engine.indicators import atr
from engine.params import StrategyParams
from engine.structure import analyze_structure
from engine.zones import Zone, ZoneStatus, analyze_zones

TTL = 120
H4_N = 450
D1_N = 320
W1_N = 160
PARAMS = StrategyParams()

_cache: dict[str, Any] = {"at": 0.0, "rows": []}
_lock = threading.Lock()


def _dec(x: Decimal | None) -> str | None:
    return None if x is None else format(x.normalize(), "f")


def beta_to_btc(asset: list[Candle], btc: list[Candle], days: int = 90) -> Decimal | None:
    """Бета дневных доходностей инструмента к BTC за ``days`` дней (пересечение по датам)."""
    a = {c.open_time: c.close for c in asset[-(days + 1) :]}
    b = {c.open_time: c.close for c in btc[-(days + 1) :]}
    common = sorted(set(a) & set(b))
    if len(common) < 20:
        return None
    ra: list[Decimal] = []
    rb: list[Decimal] = []
    for prev, cur in itertools.pairwise(common):
        if a[prev] and b[prev]:
            ra.append(a[cur] / a[prev] - 1)
            rb.append(b[cur] / b[prev] - 1)
    if len(ra) < 20:
        return None
    mb = sum(rb, Decimal(0)) / len(rb)
    ma = sum(ra, Decimal(0)) / len(ra)
    var = sum(((y - mb) ** 2 for y in rb), Decimal(0))
    if var == 0:
        return None
    cov = sum(((x - ma) * (y - mb) for x, y in zip(ra, rb, strict=True)), Decimal(0))
    return cov / var


def change_pct(candles: list[Candle], bars: int) -> Decimal | None:
    if len(candles) <= bars or candles[-1 - bars].close == 0:
        return None
    return (candles[-1].close / candles[-1 - bars].close - 1) * 100


def nearest_zone(
    zones: list[Zone], price: Decimal, atr_now: Decimal | None
) -> dict[str, Any] | None:
    live = [z for z in zones if z.status in (ZoneStatus.ACTIVE, ZoneStatus.TOUCHED)]
    if not live:
        return None

    def dist(z: Zone) -> Decimal:
        if price > z.top:
            return price - z.top
        if price < z.bottom:
            return z.bottom - price
        return Decimal(0)

    z = min(live, key=dist)
    d = dist(z)
    return {
        "kind": z.kind,
        "direction": z.direction.value,
        "top": _dec(z.top),
        "bottom": _dec(z.bottom),
        "status": z.status.value,
        "distance_atr": _dec(d / atr_now) if atr_now else None,
        "distance_pct": _dec(d / price * 100) if price else None,
    }


def _derivatives(session: Session, inst_id: int, now: datetime) -> dict[str, Any]:
    since90 = now - timedelta(days=90)
    since24 = now - timedelta(hours=24)
    funding = (
        session.execute(
            text(
                "select rate from funding_rates where instrument_id=:i and funding_time>=:s "
                "order by funding_time"
            ),
            {"i": inst_id, "s": since90},
        )
        .scalars()
        .all()
    )
    oi_now = session.execute(
        text(
            "select oi_quote from open_interest where instrument_id=:i order by time desc limit 1"
        ),
        {"i": inst_id},
    ).scalar()
    oi_24 = session.execute(
        text(
            "select oi_quote from open_interest where instrument_id=:i and time<=:t "
            "order by time desc limit 1"
        ),
        {"i": inst_id, "t": since24},
    ).scalar()
    liq = session.execute(
        text(
            "select coalesce(sum(long_usd),0), coalesce(sum(short_usd),0) from liquidations "
            "where instrument_id=:i and time>=:s"
        ),
        {"i": inst_id, "s": since24},
    ).first()
    f_now = funding[-1] if funding else None
    return {
        "funding": _dec(f_now * 100) if f_now is not None else None,
        "funding_pct": (
            f"{_percentile_rank(list(funding), f_now) * 100:.0f}" if f_now is not None else None
        ),
        "oi_change_24h": (_dec((oi_now / oi_24 - 1) * 100) if oi_now and oi_24 else None),
        "liq_long_24h": _dec(liq[0]) if liq else None,
        "liq_short_24h": _dec(liq[1]) if liq else None,
    }


def build_row(
    session: Session, inst: Instrument, btc_d1: list[Candle], now: datetime
) -> dict[str, Any]:
    h4 = closed_only(_candles(session, inst.id, Timeframe.H4, H4_N), Timeframe.H4, now)
    d1 = closed_only(_candles(session, inst.id, Timeframe.D1, D1_N), Timeframe.D1, now)
    w1 = closed_only(_candles(session, inst.id, Timeframe.W1, W1_N), Timeframe.W1, now)
    row: dict[str, Any] = {
        "symbol": inst.symbol,
        "instrument_id": inst.id,
        "exchange": inst.exchange,
    }
    if len(h4) < 50:
        row["error"] = "мало истории"
        return row
    price = h4[-1].close
    structure = analyze_structure(h4, PARAMS.structure)
    zones = analyze_zones(h4, structure, PARAMS.zones)
    atr_values = atr(h4, PARAMS.filters.atr_period)
    atr_now = atr_values[-1] if atr_values else None
    regime = atr_regime(h4, PARAMS.filters)
    bias = context_at(now, d1, w1, PARAMS.bias, PARAMS.structure)
    last = structure.last_event
    row.update(
        {
            "price": _dec(price),
            "change_24h": _dec(change_pct(h4, 6)),
            "volume_24h": _dec(sum((c.quote_volume for c in h4[-6:]), Decimal(0))),
            "bias": bias.bias.value,
            "d1_trend": bias.d1_trend.value,
            "w1_trend": bias.w1_trend.value,
            "last_event": None
            if last is None
            else {
                "type": last.type.value,
                "direction": last.direction.value,
                "time": last.time.isoformat(),
                "level": _dec(last.level),
            },
            "zone": nearest_zone(zones, price, atr_now),
            "atr_pct": _dec(atr_now / price * 100) if atr_now else None,
            "atr_percentile": regime.data.get("percentile"),
            "beta_btc": _dec(beta_to_btc(d1, btc_d1)) if inst.symbol != "BTCUSDT" else "1",
            **_derivatives(session, inst.id, now),
        }
    )
    return row


def build_screener(session: Session, now: datetime | None = None) -> list[dict[str, Any]]:
    now = now or datetime.now(tz=UTC)
    instruments = list(
        session.scalars(
            select(Instrument)
            .where(Instrument.market_type == "futures", Instrument.is_active)
            .order_by(Instrument.symbol)
        ).all()
    )
    btc = next((i for i in instruments if i.symbol == "BTCUSDT"), None)
    btc_d1 = (
        closed_only(_candles(session, btc.id, Timeframe.D1, D1_N), Timeframe.D1, now) if btc else []
    )
    return [build_row(session, inst, btc_d1, now) for inst in instruments]


def screener_cached(session: Session) -> tuple[list[dict[str, Any]], datetime]:
    with _lock:
        if time.time() - _cache["at"] < TTL and _cache["rows"]:
            return _cache["rows"], _cache["when"]
        rows = build_screener(session)
        _cache.update({"at": time.time(), "rows": rows, "when": datetime.now(tz=UTC)})
        return rows, _cache["when"]
