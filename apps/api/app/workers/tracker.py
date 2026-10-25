"""Трекер сигналов по 1m-свечам (этап 2.3, план 2.10/6.3).

- Подписка на ``candles.closed`` с ``tf == 1m``; для каждого открытого сигнала инструмента —
  один шаг ``engine.tracker.SignalTracker``; состояние хранится в ``signal_tracking``.
- Новые события → ``signal_events``, смена статуса → ``signals.status``, закрытие →
  ``signal_results``. Статусы и события те же, что в бэктесте (эквивалентность доказана тестом).
- При старте и раз в минуту — догон: для открытых сигналов проигрываются все закрытые 1m-свечи
  после ``last_candle_time`` (или после сигнальной свечи), так что разрыв WebSocket не
  теряет касаний.
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
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.forward import _setup_from_row
from app.models import Signal, SignalEvent, SignalResult, SignalTracking, StrategyVersion
from app.workers.market_data import CHANNEL_CLOSED
from engine.candles import Candle, Timeframe
from engine.strategies import STRATEGIES
from engine.tracker import SignalStatus, SignalTracker, TrackerEvent, TrackerState

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


def state_to_json(state: TrackerState) -> dict[str, Any]:
    d = asdict(state)
    d["events"] = [
        {"type": e.type.value, "price": str(e.price), "candle_index": e.candle_index}
        for e in state.events
    ]
    for k, v in d.items():
        if isinstance(v, Decimal):
            d[k] = str(v)
    d["status"] = state.status.value
    return d


def state_from_json(d: dict[str, Any]) -> TrackerState:
    from engine.tracker import EventType

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
            TrackerEvent(EventType(e["type"]), Decimal(e["price"]), int(e["candle_index"]))
            for e in d.get("events", [])
        ),
    )


# --- применение шага ---------------------------------------------------------------------------


def _params_for(session: Session, sig: Signal) -> Any:
    ver = session.get(StrategyVersion, sig.strategy_version_id)
    key = next((k for k in STRATEGIES if k.endswith("@" + (ver.version if ver else ""))), None)
    return STRATEGIES[key].trade if key else STRATEGIES["trend-ob-retest@1.0.0"].trade


def apply_candles(session: Session, sig: Signal, candles: list[Candle], tf: Timeframe) -> int:
    """Проигрывает свечи для сигнала, пишет события/статус/результат. Возвращает число событий."""
    row = session.get(SignalTracking, sig.id)
    state = state_from_json(row.state) if row else None
    tracker = SignalTracker(_setup_from_row(sig), _params_for(session, sig), "market", state)
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
    """Смена статуса → Redis ``signals.status`` (для WebSocket API). Ошибка Redis не критична."""
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


def catch_up(tf: Timeframe = Timeframe.M1, instrument_id: int | None = None) -> int:
    """Догон по всем открытым сигналам (или одного инструмента)."""
    total = 0
    changes: list[dict[str, Any]] = []
    with SessionLocal() as session:
        q = select(Signal).where(Signal.status.in_(OPEN))
        if instrument_id is not None:
            q = q.where(Signal.instrument_id == instrument_id)
        for sig in session.scalars(q).all():
            row = session.get(SignalTracking, sig.id)
            since = (
                (row.last_candle_time + tf.delta)
                if row and row.last_candle_time
                else sig.candle_close_time
            )
            candles = _candles_after(session, sig.instrument_id, since, tf)
            if candles:
                before = sig.status
                total += apply_candles(session, sig, candles, tf)
                if sig.status != before:
                    changes.append(
                        {
                            "id": sig.public_id,
                            "instrument_id": sig.instrument_id,
                            "status": sig.status,
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
