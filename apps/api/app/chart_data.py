"""chart-data (план 2A.3, задача 2B.4): свечи порциями, агрегаты 5m/15m/1h из 1m, текущая
незакрытая свеча, слои структуры и сигналов для терминала.

Хранятся 1m, 4h, 1d, 1w; 5m/15m/1h считаются в SQL (``time_bucket`` + ``first``/``last``
TimescaleDB) по 1m на лету, текущая свеча — тем же агрегатом по 1m текущего интервала
(continuous aggregates — отдельная миграция, когда объём запросов это оправдает). Колонки
Numeric, поэтому агрегат в БД точный и совпадает с :func:`aggregate` / :func:`fold`.
"""

from __future__ import annotations

import contextlib
import json
import logging
from collections.abc import Collection
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
CHART_VIEW = {"events": 12, "sweeps": 12}
"""layers?view=chart: сколько последних событий структуры и снятий ликвидности отдаётся.
Клиентский лимит пресета не больше трети (веб: SERVER_CAPS в presets.ts)."""
DERIV_SERIES = ("funding", "oi", "liquidations", "ls_ratio", "ls_top")
"""Ряды derivatives?series=…; ``none`` — только funding_current, next_funding_t и примечание."""


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
    последней, сумма объёмов. Неполные корзины на краях тоже отдаются — решает вызывающий.

    Эталон для SQL-агрегата :func:`load_candles` (тесты сверяют их на фикстурах)."""
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


_AGG_COLUMNS = (
    "first(open, open_time), max(high), min(low), last(close, open_time), "
    "sum(volume), sum(quote_volume), CAST(sum(trades) AS bigint)"
)
_BEFORE = "(CAST(:b AS timestamptz) is null or open_time < CAST(:b AS timestamptz))"
_LAST_M1_SQL = text(
    "select open_time from candles where instrument_id=:i and timeframe='1m' "
    f"and {_BEFORE} order by open_time desc limit 1"
)
_BUCKETS_SQL = text(
    f"select time_bucket(:w, open_time) as t, {_AGG_COLUMNS} from candles "
    f"where instrument_id=:i and timeframe='1m' and open_time >= :lo and {_BEFORE} "
    "group by 1 order by 1"
)
_OLDER_M1_SQL = text(
    "select exists(select 1 from candles "
    "where instrument_id=:i and timeframe='1m' and open_time < :lo)"
)
_CURRENT_SQL = text(
    f"select {_AGG_COLUMNS}, max(open_time), count(*) from candles "
    "where instrument_id=:i and timeframe='1m' and open_time >= :s"
)


def load_candles(
    db: Session, instrument_id: int, tf: Timeframe, before: datetime | None, limit: int = PAGE
) -> tuple[list[Candle], bool]:
    """Закрытые свечи tf до ``before`` (не включая), последние ``limit``.

    Возвращает (свечи, есть ли ещё слева).

    5m/15m/1h — SQL-агрегат по окну времени из ``limit`` корзин, которое кончается корзиной
    самой новой минуты раньше ``before``: ``[top − (limit−1)·size, before)``. Левая корзина окна
    всегда полная (окно выровнено по корзинам), ``has_older`` — есть ли минуты левее окна.
    Отличие от прежнего окна по строкам — только у пропусков в данных: корзины без минут не
    отдаются, и порция короче ``limit``, но не пустая, пока слева есть данные.
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
        has_older = len(candles) > limit
        return (candles[-limit:] if has_older else candles), has_older
    size = tf.seconds
    top = db.execute(_LAST_M1_SQL, {"i": instrument_id, "b": before}).scalar()
    if top is None:
        return [], False
    lo = datetime.fromtimestamp(bucket_key(int(top.timestamp()), size) - (limit - 1) * size, tz=UTC)
    rows = db.execute(
        _BUCKETS_SQL, {"i": instrument_id, "b": before, "lo": lo, "w": tf.delta}
    ).all()
    has_older = bool(db.execute(_OLDER_M1_SQL, {"i": instrument_id, "lo": lo}).scalar())
    return _rows_to_candles(list(rows)), has_older


def bucket_start(tf: Timeframe, now: datetime) -> datetime:
    """Начало текущего интервала tf (неделя — с понедельника 00:00 UTC, как у Binance)."""
    if tf is Timeframe.W1:
        day = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return day - timedelta(days=now.weekday())
    size = tf.seconds
    return datetime.fromtimestamp((int(now.timestamp()) // size) * size, tz=UTC)


def current_bar(
    db: Session, instrument_id: int, tf: Timeframe, now: datetime
) -> tuple[Candle, datetime] | None:
    """Незакрытая свеча tf одним SQL-агрегатом по минутам текущего интервала (для tf ≥ 5m)
    и open time самой новой минуты в ней (``current_through``). Без минут — ``None``."""
    if tf is Timeframe.M1:
        return None
    start = bucket_start(tf, now)
    row = db.execute(_CURRENT_SQL, {"i": instrument_id, "s": start}).one()
    if not row[8]:
        return None
    candle = Candle(
        start, row[0], row[1], row[2], row[3], row[4], row[5] or Decimal(0), int(row[6] or 0)
    )
    return candle, row[7].astimezone(UTC)


def current_candle(db: Session, instrument_id: int, tf: Timeframe, now: datetime) -> Candle | None:
    """Незакрытая свеча tf из минутных свечей текущего интервала (для tf ≥ 5m)."""
    bar = current_bar(db, instrument_id, tf, now)
    return None if bar is None else bar[0]


def fold(m1: list[Candle], start: datetime) -> Candle:
    """Чистая свёртка минутных свечей в одну свечу с началом ``start``. Эталон для
    :func:`current_bar` (тесты сверяют их на фикстурах)."""
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


def chart_view(structure: dict[str, Any] | None) -> dict[str, Any] | None:
    """layers?view=chart: только то, что рисует график. Без swing-ов; зоны — только активные
    (клиентская склейка зон всё равно берёт active); последние CHART_VIEW событий структуры и
    снятий по времени; равные уровни — только не снятые. levels, bias, atr — как есть."""
    if structure is None:
        return None

    def last(items: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
        n = CHART_VIEW[key]
        return sorted(items, key=lambda x: int(x["t"]))[-n:] if n else []

    out = dict(structure)
    out["swings"] = []
    out["zones"] = [z for z in structure.get("zones", []) if z.get("status") == "active"]
    out["events"] = last(list(structure.get("events", [])), "events")
    out["sweeps"] = last(list(structure.get("sweeps", [])), "sweeps")
    out["equal_levels"] = [e for e in structure.get("equal_levels", []) if not e.get("swept")]
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


# --- крипто-панели: funding, OI, ликвидации (план 2A.4, задача 2B.5) ----------------------------


WEEK_SECONDS = int(Timeframe.W1.seconds)
# 1970-01-01 — четверг; недельная свеча Binance открывается в понедельник 00:00 UTC (1970-01-05)
WEEK_ORIGIN = 4 * 86400


def bucket_key(ts: int, size: int) -> int:
    """Начало корзины tf для unix-времени — то же, что open_time свечи (неделя — с понедельника)."""
    origin = WEEK_ORIGIN if size == WEEK_SECONDS else 0
    return ((ts - origin) // size) * size + origin


def bucket_last(rows: list[tuple[datetime, Decimal]], size: int) -> list[dict[str, Any]]:
    """Последнее значение в каждой корзине tf (для OI)."""
    out: dict[int, Decimal] = {}
    for t, v in rows:
        out[bucket_key(int(t.timestamp()), size)] = v
    return [{"t": k, "v": _dec(v)} for k, v in sorted(out.items())]


def bucket_sum(rows: list[tuple[datetime, Decimal, Decimal]], size: int) -> list[dict[str, Any]]:
    """Суммы long/short в каждой корзине tf (для ликвидаций)."""
    out: dict[int, tuple[Decimal, Decimal]] = {}
    for t, a, b in rows:
        k = bucket_key(int(t.timestamp()), size)
        pa, pb = out.get(k, (Decimal(0), Decimal(0)))
        out[k] = (pa + a, pb + b)
    return [{"t": k, "long": _dec(a), "short": _dec(b)} for k, (a, b) in sorted(out.items())]


_DERIV_SQL = {
    "funding": text(
        "select funding_time, rate, interval_hours from funding_rates "
        "where instrument_id=:i and funding_time>=:s and funding_time<:u order by 1"
    ),
    "oi": text(
        "select time, oi_quote from open_interest "
        "where instrument_id=:i and time>=:s and time<:u order by 1"
    ),
    "liquidations": text(
        "select time, long_usd, short_usd from liquidations "
        "where instrument_id=:i and time>=:s and time<:u order by 1"
    ),
    "ls": text(
        "select time, global_ratio, top_traders_ratio from long_short_ratios "
        "where instrument_id=:i and time>=:s and time<:u order by 1"
    ),
}
_LAST_FUNDING_SQL = text(
    "select funding_time, rate, interval_hours from funding_rates "
    "where instrument_id=:i and funding_time>=:s and funding_time<:u "
    "order by funding_time desc limit 1"
)
LIQUIDATIONS_NOTE = "ликвидации из публичного потока Binance (не полный объём)"


def load_derivatives(
    db: Session,
    instrument_id: int,
    tf: Timeframe,
    since: datetime,
    until: datetime | None,
    series: Collection[str] | None = None,
) -> dict[str, Any]:
    """Ряды funding / OI / ликвидаций / long-short по корзинам tf за ``[since, until)``.

    ``series`` — какие ряды отдать (из DERIV_SERIES); ``None`` — все, как раньше; пустой набор —
    только ``funding_current``, ``next_funding_t`` и примечание. Запрашиваются только нужные
    таблицы."""
    until = until or datetime.now(tz=UTC)
    size = tf.seconds
    want = set(DERIV_SERIES) if series is None else set(series)
    params = {"i": instrument_id, "s": since, "u": until}

    def rows(key: str) -> list[Any]:
        return list(db.execute(_DERIV_SQL[key], params).all())

    if "funding" in want:
        f = rows("funding")
        last_f = f[-1] if f else None
    else:
        f = []
        last_f = db.execute(_LAST_FUNDING_SQL, params).first()
    interval = int(last_f[2] or 8) if last_f else 8
    next_funding = int(last_f[0].timestamp()) + interval * 3600 if last_f is not None else None
    ls = rows("ls") if want & {"ls_ratio", "ls_top"} else []
    out: dict[str, Any] = {}
    if "funding" in want:
        out["funding"] = [{"t": int(r[0].timestamp()), "v": _dec(r[1])} for r in f]
    out["funding_current"] = _dec(last_f[1]) if last_f else None
    out["next_funding_t"] = next_funding
    if "oi" in want:
        out["oi"] = bucket_last([(r[0], r[1]) for r in rows("oi")], size)
    if "liquidations" in want:
        out["liquidations"] = bucket_sum([(r[0], r[1], r[2]) for r in rows("liquidations")], size)
    out["liquidations_note"] = LIQUIDATIONS_NOTE
    if "ls_ratio" in want:
        out["ls_ratio"] = bucket_last([(r[0], r[1]) for r in ls], size)
    if "ls_top" in want:
        out["ls_top"] = bucket_last([(r[0], r[2]) for r in ls], size)
    return out
