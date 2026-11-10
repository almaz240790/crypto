"""Трекер сигналов по 1m-свечам (этап 2.3, план 2.6, 2.10, 6.3).

- Подписка на ``candles.closed`` с ``tf == 1m``; для каждого открытого сигнала инструмента —
  один шаг ``engine.tracker.SignalTracker``; состояние хранится в ``signal_tracking``.
- Сроки (лимит 6 × H4, time stop 15 × H4) трекер считает по времени от
  ``signals.candle_close_time`` в свечах сигнального таймфрейма, а не в штуках 1m-свечей.
  Для time stop и истечения в ``signal_events.note`` пишутся срок, фактическое время и цена.
- Новые события → ``signal_events``, смена статуса → ``signals.status``, закрытие →
  ``signal_results``. Статусы и события те же, что в бэктесте (эквивалентность доказана тестом).
- При старте и раз в минуту — догон: для открытых сигналов проигрываются все закрытые 1m-свечи
  после ``last_candle_time`` (или после сигнальной свечи), так что разрыв WebSocket не
  теряет касаний.
- Ошибка в данных одного сигнала не останавливает проход: его шаг откатывается до точки
  сохранения и пишется в лог, остальные сигналы ведутся (``catch_up``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal as os_signal
import time
from dataclasses import asdict
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import redis as redis_sync
import redis.asyncio as aioredis
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.forward import _setup_from_row
from app.models import Signal, SignalEvent, SignalResult, SignalTracking, StrategyVersion
from app.workers.market_data import CHANNEL_CLOSED
from engine.candles import SIGNAL_TIMEFRAME, Candle, Timeframe
from engine.strategies import STRATEGIES
from engine.tracker import EventType, SignalStatus, SignalTracker, TrackerEvent, TrackerState

log = logging.getLogger("tracker")
OPEN = ("pending", "active", "tp1_hit", "tp2_hit")
CATCHUP_EVERY = 60
HEARTBEAT_KEY = "tracker:heartbeat"
EVENT_TYPE = {
    "activated": "activated",
    "tp1": "tp1",
    "tp2": "tp2",
    "tp3": "tp3",
    "be": "be",
    "sl": "sl",
    "time_stop": "time_stop",
    "expired": "expired",
}


# --- сериализация состояния --------------------------------------------------------------------


def _dt(x: object) -> datetime | None:
    return None if x is None else datetime.fromisoformat(str(x)).astimezone(UTC)


def state_to_json(state: TrackerState) -> dict[str, Any]:
    d = asdict(state)
    d["events"] = [
        {
            "type": e.type.value,
            "price": str(e.price),
            "candle_index": e.candle_index,
            "at": None if e.at is None else e.at.isoformat(),
        }
        for e in state.events
    ]
    for k, v in d.items():
        if isinstance(v, Decimal):
            d[k] = str(v)
        elif isinstance(v, datetime):
            d[k] = v.isoformat()
    d["status"] = state.status.value
    return d


def state_from_json(d: dict[str, Any]) -> TrackerState:
    """Читает и новое состояние, и сохранённое до сроков по времени (без ``activated_at``,
    ``deadline_at``, ``last_candle_at`` и времени событий): недостающий срок трекер
    восстанавливает из ``signals.candle_close_time`` при первом шаге."""

    def dec(x: object) -> Decimal | None:
        return None if x is None else Decimal(str(x))

    return TrackerState(
        status=SignalStatus(d["status"]),
        entry_price=dec(d.get("entry_price")),
        stop=dec(d.get("stop")),
        hits=int(d.get("hits", 0)),
        realized_r=Decimal(str(d.get("realized_r", 0))),
        remaining=Decimal(str(d.get("remaining", 1))),
        candles_seen=int(d.get("candles_seen", 0)),
        candles_active=int(d.get("candles_active", 0)),
        mfe_r=Decimal(str(d.get("mfe_r", 0))),
        mae_r=Decimal(str(d.get("mae_r", 0))),
        r_if_tp1_only=dec(d.get("r_if_tp1_only")),
        r_if_full_tp2=dec(d.get("r_if_full_tp2")),
        events=tuple(
            TrackerEvent(
                EventType(e["type"]),
                Decimal(e["price"]),
                int(e["candle_index"]),
                _dt(e.get("at")),
            )
            for e in d.get("events", [])
        ),
        activated_at=_dt(d.get("activated_at")),
        deadline_at=_dt(d.get("deadline_at")),
        last_candle_at=_dt(d.get("last_candle_at")),
    )


# --- применение шага ---------------------------------------------------------------------------


def _params_for(session: Session, sig: Signal) -> Any:
    ver = session.get(StrategyVersion, sig.strategy_version_id)
    key = next((k for k in STRATEGIES if k.endswith("@" + (ver.version if ver else ""))), None)
    return STRATEGIES[key].trade if key else STRATEGIES["trend-ob-retest@1.0.0"].trade


def _hm(t: datetime) -> str:
    return f"{t:%Y-%m-%d %H:%M} UTC"


def _price(p: Decimal) -> str:
    """Цена без хвостовых нулей Numeric из БД: 100.1000000000 → 100.1."""
    return format(p.normalize(), "f")


def event_note(e: TrackerEvent, tracker: SignalTracker) -> str | None:
    """Пояснение к time stop и истечению лимита: срок, фактическое время и цена выхода."""
    deadline = tracker.state.deadline_at
    if e.type not in (EventType.TIME_STOP, EventType.EXPIRED) or e.at is None or deadline is None:
        return None
    tf = tracker.timeframe
    if e.type is EventType.TIME_STOP:
        what, n = "time stop", tracker.params.time_stop_candles
    else:
        what, n = "истечение лимита", tracker.params.limit_expiry_candles
    candle = f"{e.at - tf.delta:%H:%M}–{e.at:%H:%M}"
    if e.at == deadline:
        where = f"по close свечи {tf.value} {candle}"
    else:
        where = f"свечи на сроке нет — по close первой свечи {tf.value} после срока {candle}"
    return (
        f"{what}: срок {_hm(deadline)} ({n} свечей {SIGNAL_TIMEFRAME.value}); "
        f"выход {_hm(e.at)} {where}: {_price(e.price)}"
    )


def apply_candles(session: Session, sig: Signal, candles: list[Candle], tf: Timeframe) -> int:
    """Проигрывает свечи для сигнала, пишет события/статус/результат. Возвращает число событий."""
    row = session.get(SignalTracking, sig.id)
    state = state_from_json(row.state) if row else None
    tracker = SignalTracker(
        _setup_from_row(sig),
        _params_for(session, sig),
        "market",
        state,
        signal_close=sig.candle_close_time.astimezone(UTC),
        timeframe=tf,
    )
    total = 0
    last_time = row.last_candle_time if row else None
    for c in candles:
        if last_time is not None and c.open_time <= last_time.astimezone(UTC):
            continue
        events = tracker.step(c)
        when = c.close_time(tf)
        for e in events:
            session.add(
                SignalEvent(
                    signal_id=sig.id,
                    type=EVENT_TYPE[e.type.value],
                    price=e.price,
                    occurred_at=when,
                    source="tracker",
                    note=event_note(e, tracker),
                )
            )
        total += len(events)
        last_time = c.open_time
        if not tracker.state.status.is_open:
            break
    st = tracker.state
    if row is None:
        row = SignalTracking(signal_id=sig.id, timeframe=tf.value)
        session.add(row)
    row.state = state_to_json(st)
    row.last_candle_time = last_time
    row.updated_at = datetime.now(tz=UTC)
    if st.status.value != sig.status:
        sig.status = st.status.value
        if st.status.is_closed and session.get(SignalResult, sig.id) is None:
            closed_at = last_time + tf.delta if last_time else datetime.now(tz=UTC)
            session.add(
                SignalResult(
                    signal_id=sig.id,
                    realized_r=st.realized_r,
                    realized_r_tp1_only=st.r_if_tp1_only,
                    realized_r_full_tp2=st.r_if_full_tp2,
                    duration_hours=Decimal((closed_at - sig.candle_close_time).total_seconds())
                    / 3600,
                    max_favorable_r=st.mfe_r,
                    max_adverse_r=st.mae_r,
                    closed_at=closed_at,
                    entry_type_used="market",
                )
            )
    return total


def _candles_after(
    session: Session, instrument_id: int, since: datetime, tf: Timeframe
) -> list[Candle]:
    rows = session.execute(
        text(
            "select open_time, open, high, low, close, volume, quote_volume, trades from candles "
            "where instrument_id=:i and timeframe=:tf and open_time>=:t and is_closed "
            "order by open_time"
        ),
        {"i": instrument_id, "tf": tf.value, "t": since},
    ).all()
    return [Candle(r[0].astimezone(UTC), r[1], r[2], r[3], r[4], r[5], r[6], r[7]) for r in rows]


CHANNEL_STATUS = "signals.status"


def _publish_status(changes: list[dict[str, Any]]) -> None:
    """Смена статуса → Redis ``signals.status`` (для WebSocket API). Ошибка Redis не критична.

    В событии есть ``scope``: WebSocket API рассылает события только вошедшим и передаёт область
    клиенту — форвард показывается как тестовый сигнал (``live.Hub.handle_event``, ADR-0013)."""
    if not changes:
        return
    try:
        r = redis_sync.Redis.from_url(settings.redis_url)
        try:
            for c in changes:
                r.publish(CHANNEL_STATUS, json.dumps(c))
        finally:
            r.close()
    except Exception:
        log.warning("не удалось опубликовать смену статуса", exc_info=True)


def _advance(session: Session, sig: Signal, tf: Timeframe) -> int:
    """Догон одного сигнала: закрытые свечи после последней обработанной. Число событий."""
    row = session.get(SignalTracking, sig.id)
    since = (
        (row.last_candle_time + tf.delta) if row and row.last_candle_time else sig.candle_close_time
    )
    candles = _candles_after(session, sig.instrument_id, since, tf)
    return apply_candles(session, sig, candles, tf) if candles else 0


def catch_up(tf: Timeframe = Timeframe.M1, instrument_id: int | None = None) -> int:
    """Догон по всем открытым сигналам (или одного инструмента).

    Каждый сигнал ведётся в своей точке сохранения. Ошибка одного сигнала (трекер отвергает
    ``candle_close_time`` не на границе сигнального таймфрейма и свечу не на сетке потока,
    повреждено сохранённое состояние) откатывает только его шаг и пишется в лог; остальные
    сигналы прохода ведутся и фиксируются. Сам сигнал остаётся открытым и будет повторён на
    следующем проходе. Потеря соединения с БД — не ошибка сигнала: проход прерывается целиком,
    как и раньше.
    """
    total = 0
    changes: list[dict[str, Any]] = []
    with SessionLocal() as session:
        q = select(Signal).where(Signal.status.in_(OPEN))
        if instrument_id is not None:
            q = q.where(Signal.instrument_id == instrument_id)
        for sig in session.scalars(q).all():
            # до точки сохранения: после её отката изменённые поля объекта сбрасываются
            ref = (sig.public_id, sig.id, sig.instrument_id)
            before = sig.status
            savepoint = session.begin_nested()
            try:
                n = _advance(session, sig, tf)
                savepoint.commit()
            except Exception as exc:
                if isinstance(exc, DBAPIError) and exc.connection_invalidated:
                    raise
                savepoint.rollback()
                log.exception(
                    "сигнал %s (id %s, инструмент %s): ошибка трекера, в этом проходе пропущен",
                    *ref,
                )
                continue
            total += n
            if sig.status != before:
                changes.append(
                    {
                        "id": sig.public_id,
                        "instrument_id": sig.instrument_id,
                        "status": sig.status,
                        "scope": sig.scope,
                        "at": datetime.now(tz=UTC).isoformat(),
                    }
                )
        session.commit()
    _publish_status(changes)
    return total


class Tracker:
    def __init__(self) -> None:
        self.redis = aioredis.from_url(settings.redis_url)
        self.stop = asyncio.Event()

    async def listener(self) -> None:
        pubsub = self.redis.pubsub()
        await pubsub.subscribe(CHANNEL_CLOSED)
        async for msg in pubsub.listen():
            if self.stop.is_set():
                break
            if msg.get("type") != "message":
                continue
            data = json.loads(msg["data"])
            if data.get("tf") != "1m":
                continue
            try:
                n = await asyncio.to_thread(catch_up, Timeframe.M1, int(data["instrument_id"]))
                if n:
                    log.info("%s: событий %d", data["symbol"], n)
            except Exception:
                log.exception("%s: ошибка трекера", data.get("symbol"))

    async def periodic(self) -> None:
        while not self.stop.is_set():
            try:
                n = await asyncio.to_thread(catch_up)
                if n:
                    log.info("догон: событий %d", n)
            except Exception:
                log.exception("догон не удался")
            await self.redis.set(HEARTBEAT_KEY, int(time.time()))
            await asyncio.sleep(CATCHUP_EVERY)

    async def run(self) -> None:
        tasks = [asyncio.create_task(self.listener()), asyncio.create_task(self.periodic())]
        await self.stop.wait()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.redis.aclose()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    t = Tracker()
    loop = asyncio.new_event_loop()
    for sig in (os_signal.SIGINT, os_signal.SIGTERM):
        loop.add_signal_handler(sig, t.stop.set)
    loop.run_until_complete(t.run())


if __name__ == "__main__":
    main()
