"""chart-data (план 2A.3, задача 2B.4): свечи порциями, агрегаты 5m/15m/1h из 1m, текущая
незакрытая свеча, слои структуры и сигналов для терминала.

Хранятся 1m, 4h, 1d, 1w; 5m/15m/1h считаются time_bucket'ом по 1m на лету (continuous
aggregates TimescaleDB — отдельная миграция, когда объём запросов это оправдает).
"""

from __future__ import annotations

import contextlib
import json
import logging
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.analysis import params_for_version
from app.models import Instrument, Signal, SignalEvent, StrategyVersion
from engine.bias import context_at
from engine.candles import Candle, Timeframe, closed_only
from engine.indicators import atr
from engine.liquidity import find_equal_levels, find_sweeps, period_levels
from engine.structure import analyze_structure
from engine.zones import analyze_zones

log = logging.getLogger("chart")

STORED = {Timeframe.M1, Timeframe.H4, Timeframe.D1, Timeframe.W1}
AGGREGATED = {Timeframe.M5: 5, Timeframe.M15: 15, Timeframe.H1: 60}
PAGE = 500
LAYER_TFS = (Timeframe.H1, Timeframe.H4, Timeframe.D1, Timeframe.W1)
LAYERS_TTL = 60


def _dec(x: Decimal | None) -> str | None:
    return None if x is None else format(Decimal(x).normalize(), "f")


def candle_dict(c: Candle, open_: bool = False) -> dict[str, Any]:
    return {
        "t": int(c.open_time.timestamp()),
        "o": _dec(c.open),
        "h": _dec(c.high),
        "l": _dec(c.low),
        "c": _dec(c.close),
        "v": _dec(c.volume),
        "open": open_,
    }


def aggregate(m1: list[Candle], tf: Timeframe) -> list[Candle]:
    """Чистая агрегация минутных свечей в tf (5m/15m/1h): open первой, high/low, close
    последней, сумма объёмов. Неполные корзины на краях тоже отдаются — решает вызывающий."""
    size = tf.seconds
    out: list[Candle] = []
    cur: Candle | None = None
    for c in m1:
        bucket = datetime.fromtimestamp((int(c.open_time.timestamp()) // size) * size, tz=UTC)
        if cur is None or cur.open_time != bucket:
            if cur is not None:
                out.append(cur)
            cur = Candle(bucket, c.open, c.high, c.low, c.close, c.volume, c.quote_volume, c.trades)
        else:
            cur = Candle(
                bucket,
                cur.open,
                max(cur.high, c.high),
                min(cur.low, c.low),
                c.close,
                cur.volume + c.volume,
                cur.quote_volume + c.quote_volume,
                cur.trades + c.trades,
            )
    if cur is not None:
        out.append(cur)
    return out


def _rows_to_candles(rows: list[Any]) -> list[Candle]:
    return [
        Candle(r[0].astimezone(UTC), r[1], r[2], r[3], r[4], r[5], r[6] or Decimal(0), r[7] or 0)
        for r in rows
    ]


def load_candles(
    db: Session, instrument_id: int, tf: Timeframe, before: datetime | None, limit: int = PAGE
) -> tuple[list[Candle], bool]:
    """Закрытые свечи tf до ``before`` (не включая), последние ``limit``.

    Возвращает (свечи, есть ли ещё слева).
    """
    limit = max(1, min(limit, PAGE))
    if tf in STORED:
        rows = db.execute(
            text(
                "select open_time, open, high, low, close, volume, quote_volume, trades "
                "from candles "
                "where instrument_id=:i and timeframe=:tf "
                "and (CAST(:b AS timestamptz) is null or open_time < CAST(:b AS timestamptz)) "
                "order by open_time desc limit :n"
            ),
            {"i": instrument_id, "tf": tf.value, "b": before, "n": limit + 1},
        ).all()
        candles = _rows_to_candles(list(reversed(rows)))
    else:
        mult = AGGREGATED[tf]
        rows = db.execute(
            text(
                "select open_time, open, high, low, close, volume, quote_volume, trades "
                "from candles "
                "where instrument_id=:i and timeframe='1m' "
                "and (CAST(:b AS timestamptz) is null or open_time < CAST(:b AS timestamptz)) "
                "order by open_time desc limit :n"
            ),
            {"i": instrument_id, "b": before, "n": (limit + 2) * mult},
        ).all()
        candles = aggregate(_rows_to_candles(list(reversed(rows))), tf)
        # первая корзина может быть неполной (обрезана лимитом) — выбрасываем
        if len(candles) > limit + 1:
            candles = candles[-(limit + 1) :]
        elif candles and len(rows) >= (limit + 2) * mult:
            candles = candles[1:]
    has_older = len(candles) > limit
    if has_older:
        candles = candles[-limit:]
    return candles, has_older


def bucket_start(tf: Timeframe, now: datetime) -> datetime:
    """Начало текущего интервала tf (неделя — с понедельника 00:00 UTC, как у Binance)."""
    if tf is Timeframe.W1:
        day = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return day - timedelta(days=now.weekday())
    size = tf.seconds
    return datetime.fromtimestamp((int(now.timestamp()) // size) * size, tz=UTC)


def current_candle(db: Session, instrument_id: int, tf: Timeframe, now: datetime) -> Candle | None:
    """Незакрытая свеча tf из минутных свечей текущего интервала (для tf ≥ 5m)."""
    if tf is Timeframe.M1:
        return None
    start = bucket_start(tf, now)
    rows = db.execute(
        text(
            "select open_time, open, high, low, close, volume, quote_volume, trades from candles "
            "where instrument_id=:i and timeframe='1m' and open_time >= :s order by open_time"
        ),
        {"i": instrument_id, "s": start},
    ).all()
    if not rows:
        return None
    return fold(_rows_to_candles(list(rows)), start)


def fold(m1: list[Candle], start: datetime) -> Candle:
    """Чистая свёртка минутных свечей в одну свечу с началом ``start``."""
    return Candle(
        start,
        m1[0].open,
        max(c.high for c in m1),
        min(c.low for c in m1),
        m1[-1].close,
        sum((c.volume for c in m1), Decimal(0)),
        sum((c.quote_volume for c in m1), Decimal(0)),
        sum(c.trades for c in m1),
    )


def latest_version(db: Session) -> StrategyVersion | None:
    return db.scalar(
        select(StrategyVersion)
        .where(StrategyVersion.status.in_(["live", "forward"]))
        .order_by((StrategyVersion.status == "live").desc(), StrategyVersion.id.desc())
    )


def compute_layers(db: Session, inst: Instrument, tf: Timeframe, now: datetime) -> dict[str, Any]:
    """Структура, зоны, уровни, равные уровни, снятия по закрытым свечам tf (параметры движка)."""
    ver = latest_version(db)
    params = params_for_version(ver.version if ver else None)
    candles, _ = load_candles(db, inst.id, tf, None, PAGE)
    candles = closed_only(candles, tf, now)
    if len(candles) < 50:
        return {
            "tf": tf.value,
            "at": now.isoformat(),
            "swings": [],
            "events": [],
            "zones": [],
            "levels": {},
            "equal_levels": [],
            "sweeps": [],
            "bias": None,
        }
    structure = analyze_structure(candles, params.structure)
    zones = analyze_zones(candles, structure, params.zones)
    atr_values = atr(candles, params.filters.atr_period)
    equal = find_equal_levels(structure.swings, candles, params.liquidity, atr_values)
    sweeps = find_sweeps(candles, structure.swings)
    d1, _ = load_candles(db, inst.id, Timeframe.D1, None, 400)
    w1, _ = load_candles(db, inst.id, Timeframe.W1, None, 120)
    d1 = closed_only(d1, Timeframe.D1, now)
    w1 = closed_only(w1, Timeframe.W1, now)
    levels = period_levels(now, d1, w1)
    bias = context_at(now, d1, w1, params.bias, params.structure) if d1 and w1 else None

    def t(i: int) -> int:
        return int(candles[i].open_time.timestamp())

    return {
        "tf": tf.value,
        "at": now.isoformat(),
        "strategy_version": ver.version if ver else None,
        "swings": [
            {"t": int(s.time.timestamp()), "p": _dec(s.price), "kind": s.kind.value}
            for s in structure.swings
        ],
        "events": [
            {
                "t": int(e.time.timestamp()),
                "type": e.type.value,
                "dir": e.direction.value,
                "level": _dec(e.level),
                "from_t": int(e.broken_swing.time.timestamp()),
            }
            for e in structure.events
        ],
        "zones": [
            {
                "kind": z.kind,
                "dir": z.direction.value,
                "top": _dec(z.top),
                "bottom": _dec(z.bottom),
                "from_t": t(z.created_index),
                "status": z.status,
            }
            for z in zones
        ],
        "levels": {k: _dec(v) for k, v in asdict(levels).items()},
        "equal_levels": [
            {
                "kind": e.kind.value,
                "p": _dec(e.price),
                "from_t": t(min(e.swing_indices)),
                "to_t": t(e.swept_index) if e.swept_index is not None else None,
                "swept": e.swept_index is not None,
            }
            for e in equal
        ],
        "sweeps": [
            {"t": int(s.time.timestamp()), "kind": s.kind.value, "level": _dec(s.level)}
            for s in sweeps
        ],
        "bias": None
        if bias is None
        else {
            "bias": bias.bias.value,
            "d1_trend": bias.d1_trend.value,
            "w1_trend": bias.w1_trend.value,
            "ema50_d1": _dec(bias.ema),
        },
        "atr": _dec(atr_values[-1]) if atr_values and atr_values[-1] is not None else None,
    }


def layers_cached(
    db: Session, r: Any | None, inst: Instrument, tf: Timeframe, now: datetime
) -> dict[str, Any]:
    key = f"chart:layers:{inst.id}:{tf.value}"
    if r is not None:
        try:
            cached = r.get(key)
            if cached:
                return dict(json.loads(cached))
        except Exception:
            pass
    out = compute_layers(db, inst, tf, now)
    if r is not None:
        with contextlib.suppress(Exception):
            r.set(key, json.dumps(out, ensure_ascii=False), ex=LAYERS_TTL)
    return out


def signal_layer(
    db: Session, inst: Instrument, scope_statuses: list[str], limit: int = 50
) -> list[dict[str, Any]]:
    """Сигналы инструмента для слоя: вход, стоп, цели, статус, события на шкале времени."""
    rows = db.execute(
        select(Signal, StrategyVersion.version)
        .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
        .where(Signal.instrument_id == inst.id, StrategyVersion.status.in_(scope_statuses))
        .order_by(Signal.candle_close_time.desc())
        .limit(limit)
    ).all()
    ids = [s.id for s, _ in rows]
    events: dict[int, list[dict[str, Any]]] = {}
    if ids:
        for e in db.scalars(
            select(SignalEvent)
            .where(SignalEvent.signal_id.in_(ids))
            .order_by(SignalEvent.occurred_at)
        ).all():
            events.setdefault(e.signal_id, []).append(
                {"type": e.type, "p": _dec(e.price), "t": int(e.occurred_at.timestamp())}
            )
    return [
        {
            "id": s.public_id,
            "version": ver,
            "dir": s.direction,
            "t": int(s.candle_close_time.timestamp()),
            "status": s.status,
            "grade": s.grade,
            "entry": _dec(s.entry_limit or s.entry_market),
            "sl": _dec(s.stop_loss),
            "tp": [_dec(s.tp1), _dec(s.tp2), _dec(s.tp3)],
            "zone": (s.rationale_facts or {}).get("zone"),
            "events": events.get(s.id, []),
        }
        for s, ver in rows
    ]
