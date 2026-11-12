"""chart-data (план 2A.3, задача 2B.4): свечи порциями, агрегаты 5m/15m/1h из 1m, текущая
незакрытая свеча, слои структуры и сигналов для терминала.

Хранятся 1m, 4h, 1d, 1w; 5m/15m/1h считаются time_bucket'ом по 1m на лету (continuous
aggregates TimescaleDB — отдельная миграция, когда объём запросов это оправдает).
"""

from __future__ import annotations

import contextlib
import json
import logging
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import or_, select, text
from sqlalchemy.orm import Session

from app.analysis import params_for_version
from app.entitlements import Entitlements, apply_signal_entitlements
from app.models import Instrument, Signal, SignalEvent, StrategyVersion
from app.signal_scope import scope_filter
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


THROUGH_LOOKBACK = timedelta(hours=1)
"""Насколько назад от начала интервала искать последнюю закрытую минуту, если в интервале их нет."""


@dataclass(frozen=True)
class LiveBucket:
    """Текущая свеча tf, свёрнутая только из закрытых минут (план 2A.3).

    Идущую минуту market-data переписывает каждую секунду с ``is_closed = false``; она придёт по
    WebSocket закрытой, и клиент свернёт её сам. Взятая в текущую свечу, она считалась бы дважды
    (объём), а минута, закрытая перед самым ответом, но ещё не записанная, — терялась бы.
    """

    candle: Candle | None
    """Свёртка закрытых минут интервала; None — закрытых минут в интервале ещё нет (у 1m —
    всегда)."""
    first: datetime | None
    """Первая учтённая минута (не начало интервала — у минутной истории пропуск)."""
    through: datetime | None
    """Последняя закрытая минута в БД на момент запроса (в интервале, иначе — перед ним): минуты
    WebSocket не позже неё уже учтены ответом. None — закрытых минут рядом нет."""
    start: datetime | None = None
    """Интервал текущей свечи: идущий, а сразу после закрытия — только что закрытый, пока его
    последняя минута не записана закрытой (окончательным его отдавать нельзя). None — идущий."""


def current_candle(db: Session, instrument_id: int, tf: Timeframe, now: datetime) -> LiveBucket:
    """Текущая свеча tf из закрытых минутных свечей и последняя закрытая минута (through).

    Обычно это идущий интервал. Но закрытая минута пишется в БД не сразу (запись раз в секунду,
    в режиме REST-опроса — до 15 с): сразу после закрытия интервала его последняя минута ещё
    недописанная, и свеча с ней — не окончательная (chart-data-live-2). Тогда текущая — только что
    закрытый по времени интервал из закрытых минут, а его последнюю минуту клиент свернёт сам.
    Отставание больше одного интервала — сбой записи минут: там, как раньше, — идущий интервал.
    У 1m свёртки нет (свеча — сама минута): только through и интервал."""
    start = bucket_start(tf, now)
    if tf is not Timeframe.M1:
        m1 = _closed_minutes(db, instrument_id, start, None)
        if m1:
            return LiveBucket(fold(m1, start), m1[0].open_time, m1[-1].open_time, start)
    last = db.execute(
        text(
            "select max(open_time) from candles where instrument_id=:i and timeframe='1m' "
            "and open_time >= :w and open_time < :s and is_closed"
        ),
        {"i": instrument_id, "w": start - THROUGH_LOOKBACK, "s": start},
    ).scalar()
    if last is None:
        return LiveBucket(None, None, None, start)
    through = last.astimezone(UTC)
    prev = bucket_start(tf, start - timedelta(seconds=1))
    if not prev <= through + timedelta(minutes=1) < start:
        return LiveBucket(None, None, through, start)
    m1 = [] if tf is Timeframe.M1 else _closed_minutes(db, instrument_id, prev, start)
    if not m1:
        return LiveBucket(None, None, through, prev)
    return LiveBucket(fold(m1, prev), m1[0].open_time, through, prev)


def _closed_minutes(
    db: Session, instrument_id: int, start: datetime, end: datetime | None
) -> list[Candle]:
    """Закрытые минутные свечи с ``start`` (до ``end``, не включая) по времени."""
    rows = db.execute(
        text(
            "select open_time, open, high, low, close, volume, quote_volume, trades from candles "
            "where instrument_id=:i and timeframe='1m' and open_time >= :s and is_closed "
            "and (CAST(:e AS timestamptz) is null or open_time < CAST(:e AS timestamptz)) "
            "order by open_time"
        ),
        {"i": instrument_id, "s": start, "e": end},
    ).all()
    return _rows_to_candles(list(rows))


def open_minutes(
    db: Session, instrument_id: int, after: datetime, start: datetime, end: datetime | None = None
) -> tuple[Decimal, Decimal, int]:
    """Объём, объём в котируемой и сделки недописанных минут интервала после ``after`` (идущая
    минута и закрытая на бирже, но ещё не записанная закрытой) — хранимая свеча Binance их
    уже содержит. ``end`` — конец интервала: идущая минута следующего в свечу не входит."""
    row = db.execute(
        text(
            "select coalesce(sum(volume), 0), coalesce(sum(quote_volume), 0), "
            "coalesce(sum(trades), 0) from candles where instrument_id=:i and timeframe='1m' "
            "and open_time > :a and open_time >= :s and not is_closed "
            "and (CAST(:e AS timestamptz) is null or open_time < CAST(:e AS timestamptz))"
        ),
        {"i": instrument_id, "a": after, "s": start, "e": end},
    ).one()
    return Decimal(row[0]), Decimal(row[1]), int(row[2])


def without_open_minutes(
    stored: Candle, folded: Candle, open_part: tuple[Decimal, Decimal, int]
) -> Candle:
    """Хранимая свеча Binance идущего интервала, когда минутная история начинается позже начала
    интервала: объём — без недописанных минут после through (клиент досворачивает их сам, не
    дважды), но не меньше свёртки закрытых минут; цены — как есть (high/low тех минут —
    объединение, close уточнят тики). Свеча и минута пишутся из разных потоков Binance, а
    незакрытая 4h/1d/1w — не чаще раза в ``FORMING_HTF_EVERY`` (5 с): объём точен до нескольких
    секунд торгов между их снимками."""
    v, q, n = open_part
    return replace(
        stored,
        volume=max(stored.volume - v, folded.volume),
        quote_volume=max(stored.quote_volume - q, folded.quote_volume),
        trades=max(stored.trades - n, folded.trades),
    )


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


def _written_open(db: Session, instrument_id: int, tf: Timeframe, c: Candle) -> bool:
    """Свеча закрыта по времени, но в БД — ещё снимок формирующейся (``is_closed = false``).

    market-data переписывает идущую 4h/1d/1w раз в ``FORMING_HTF_EVERY`` секунд и записывает
    закрытой, когда приходит закрытие с биржи: в первые секунды после закрытия последняя строка —
    последний снимок, без сделок последних секунд. У 5m/15m/1h — последняя минута корзины.
    Строки нет (пропуск в истории) — свеча как есть."""
    if tf in STORED:
        tf_db, at = tf.value, c.open_time
    else:
        tf_db, at = Timeframe.M1.value, c.open_time + tf.delta - Timeframe.M1.delta
    closed = db.execute(
        text(
            "select is_closed from candles "
            "where instrument_id=:i and timeframe=:tf and open_time=:t"
        ),
        {"i": instrument_id, "tf": tf_db, "t": at},
    ).scalar()
    return closed is False


def compute_layers(db: Session, inst: Instrument, tf: Timeframe, now: datetime) -> dict[str, Any]:
    """Структура, зоны, уровни, равные уровни, снятия по закрытым свечам tf (параметры движка).

    ``last_t`` — начало последней закрытой свечи, по которой построен ответ (клиент сверяет её со
    своей последней закрытой и, если сервер отстал, перечитывает слои). Последняя строка, ещё не
    записанная закрытой, в расчёт не входит; ``complete = false`` — ответ построен без неё или по
    снимку незакрытой дневной/недельной свечи, такой ответ не кэшируется."""
    ver = latest_version(db)
    params = params_for_version(ver.version if ver else None)
    candles, _ = load_candles(db, inst.id, tf, None, PAGE)
    candles = closed_only(candles, tf, now)
    complete = True
    if candles and _written_open(db, inst.id, tf, candles[-1]):
        candles = candles[:-1]
        complete = False
    last_t = int(candles[-1].open_time.timestamp()) if candles else None
    if len(candles) < 50:
        return {
            "tf": tf.value,
            "at": now.isoformat(),
            "last_t": last_t,
            "complete": complete,
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
    # снимок незакрытой дневной/недельной не отбрасывается (иначе «вчера» стало бы позавчера), но
    # такой ответ не кэшируется: через секунды строка будет закрытой
    for period, rows in ((Timeframe.D1, d1), (Timeframe.W1, w1)):
        if rows and _written_open(db, inst.id, period, rows[-1]):
            complete = False
    levels = period_levels(now, d1, w1)
    bias = context_at(now, d1, w1, params.bias, params.structure) if d1 and w1 else None

    def t(i: int) -> int:
        return int(candles[i].open_time.timestamp())

    return {
        "tf": tf.value,
        "at": now.isoformat(),
        "last_t": last_t,
        "complete": complete,
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


def layers_key(instrument_id: int, tf: Timeframe, now: datetime) -> str:
    """Ключ кэша слоёв: последняя закрытая свеча tf и день (макс./мин. вчера и прошлой недели
    сменяются в 00:00 UTC). Ответ, посчитанный до закрытия, после закрытия не отдаётся."""
    last = bucket_start(tf, now) - tf.delta
    return (
        f"chart:layers:{instrument_id}:{tf.value}:{int(last.timestamp())}:{now.date().isoformat()}"
    )


def layers_cached(
    db: Session, r: Any | None, inst: Instrument, tf: Timeframe, now: datetime
) -> dict[str, Any]:
    """Слои с кэшем ``LAYERS_TTL`` на последнюю закрытую свечу; неполный ответ (``complete``) —
    без кэша."""
    key = layers_key(inst.id, tf, now)
    if r is not None:
        try:
            cached = r.get(key)
            if cached:
                return dict(json.loads(cached))
        except Exception:
            pass
    out = compute_layers(db, inst, tf, now)
    if r is not None and out.get("complete", True):
        with contextlib.suppress(Exception):
            r.set(key, json.dumps(out, ensure_ascii=False), ex=LAYERS_TTL)
    return out


BE_STATUSES = ("tp1_hit", "tp2_hit")
"""Открытые статусы после цели 1: стоп на цене входа, если версия переносит его (be_after_tp1)."""


def signal_layer(
    db: Session,
    inst: Instrument,
    scopes: list[str],
    limit: int = 50,
    plan: tuple[Entitlements, list[int] | None, datetime] | None = None,
) -> list[dict[str, Any]]:
    """Сигналы инструмента для слоя: вход, стоп, цели, статус, события на шкале времени.

    ``scopes`` — области сигналов (``signals.scope`` на момент публикации, ``app.signal_scope``):
    live — все live-сигналы, forward — форвард-сигналы версий, которые сейчас в forward или live.
    ``plan`` — права пользователя, разрешённые инструменты и момент запроса: те же ограничения
    тарифа, что у ленты (градации, задержка, инструменты; ``apply_signal_entitlements``).
    ``be`` — стоп сейчас на цене входа: цель 1 взята, и версия переносит стоп в безубыток.
    """
    q = (
        select(Signal, StrategyVersion.version)
        .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
        .where(Signal.instrument_id == inst.id, or_(*(scope_filter(s) for s in scopes)))
    )
    if plan is not None:
        q = apply_signal_entitlements(q, *plan)
    rows = db.execute(q.order_by(Signal.candle_close_time.desc()).limit(limit)).all()
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
            "be": s.status in BE_STATUSES and params_for_version(ver).trade.be_after_tp1,
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


def load_derivatives(
    db: Session, instrument_id: int, tf: Timeframe, since: datetime, until: datetime | None
) -> dict[str, Any]:
    until = until or datetime.now(tz=UTC)
    size = tf.seconds
    f = db.execute(
        text(
            "select funding_time, rate, interval_hours from funding_rates "
            "where instrument_id=:i and funding_time>=:s and funding_time<:u order by 1"
        ),
        {"i": instrument_id, "s": since, "u": until},
    ).all()
    oi = db.execute(
        text(
            "select time, oi_quote from open_interest "
            "where instrument_id=:i and time>=:s and time<:u order by 1"
        ),
        {"i": instrument_id, "s": since, "u": until},
    ).all()
    liq = db.execute(
        text(
            "select time, long_usd, short_usd from liquidations "
            "where instrument_id=:i and time>=:s and time<:u order by 1"
        ),
        {"i": instrument_id, "s": since, "u": until},
    ).all()
    ls = db.execute(
        text(
            "select time, global_ratio, top_traders_ratio from long_short_ratios "
            "where instrument_id=:i and time>=:s and time<:u order by 1"
        ),
        {"i": instrument_id, "s": since, "u": until},
    ).all()
    last_f = f[-1] if f else None
    interval = int(last_f[2] or 8) if last_f else 8
    next_funding = int(last_f[0].timestamp()) + interval * 3600 if last_f is not None else None
    return {
        "funding": [{"t": int(r[0].timestamp()), "v": _dec(r[1])} for r in f],
        "funding_current": _dec(last_f[1]) if last_f else None,
        "next_funding_t": next_funding,
        "oi": bucket_last([(r[0], r[1]) for r in oi], size),
        "liquidations": bucket_sum([(r[0], r[1], r[2]) for r in liq], size),
        "liquidations_note": "ликвидации из публичного потока Binance (не полный объём)",
        "ls_ratio": bucket_last([(r[0], r[1]) for r in ls], size),
        "ls_top": bucket_last([(r[0], r[2]) for r in ls], size),
    }
