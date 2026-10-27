"""Воркер алертов (план 2A.6, 6.3; задача 2B.13).

- Слушает ``candles.closed``: по 1m — ценовые алерты инструмента (≤ 60 с от закрытия минуты);
  по 4h/1d/1w и 1m на границах 15m/1h — индикаторы, зоны, структура.
- Раз в 30 с: алерты по новым live-паттернам (курсор в Redis), истечение, heartbeat.
- Идемпотентность: уникальность (alert_id, triggered_at) в БД плюс ключи ``alerts:done:*``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import signal as os_signal
import time
from collections.abc import Callable
from datetime import UTC, datetime

import redis.asyncio as aioredis
from sqlalchemy import select

from app.alerts import evaluate_bars, evaluate_figures, evaluate_patterns, evaluate_price, expire
from app.config import settings
from app.db import SessionLocal
from app.models import Instrument
from app.workers.market_data import CHANNEL_CLOSED
from app.workers.pattern_detector import tfs_for_event
from engine.candles import Timeframe

log = logging.getLogger("alerts_worker")
DONE_TTL = 24 * 3600
LOOP_EVERY = 30
HEARTBEAT_KEY = "alerts:heartbeat"
CURSOR_KEY = "alerts:pattern_cursor"
FIGURE_CURSOR_KEY = "alerts:figure_cursor"


def done_key(symbol: str, tf: str, close_time: datetime) -> str:
    return f"alerts:done:{symbol}:{tf}:{close_time:%Y%m%dT%H%M}"


def process_price(symbol: str, close_time: datetime) -> int:
    with SessionLocal() as db:
        inst = db.scalar(
            select(Instrument).where(
                Instrument.symbol == symbol, Instrument.market_type == "futures"
            )
        )
        if inst is None:
            return 0
        n = evaluate_price(db, inst, close_time)
        db.commit()
        return n


def process_bars(symbol: str, tf: Timeframe, close_time: datetime) -> int:
    with SessionLocal() as db:
        inst = db.scalar(
            select(Instrument).where(
                Instrument.symbol == symbol, Instrument.market_type == "futures"
            )
        )
        if inst is None:
            return 0
        n = evaluate_bars(db, inst, tf, close_time)
        db.commit()
        return n


def patterns_once(cursor: int) -> tuple[int, int]:
    with SessionLocal() as db:
        new_cursor, fired = evaluate_patterns(db, cursor)
        db.commit()
        return new_cursor, fired


def figures_once(cursor: int) -> tuple[int, int]:
    with SessionLocal() as db:
        new_cursor, fired = evaluate_figures(db, cursor)
        db.commit()
        return new_cursor, fired


def expire_once() -> int:
    with SessionLocal() as db:
        n = expire(db)
        db.commit()
        return n


class AlertsWorker:
    def __init__(self) -> None:
        self.redis = aioredis.from_url(settings.redis_url)
        self.stop = asyncio.Event()

    async def _once(self, key: str, fn: Callable[..., int], *args: object) -> None:
        if not await self.redis.set(key, "1", nx=True, ex=DONE_TTL):
            return
        try:
            n = await asyncio.to_thread(fn, *args)
            if n:
                log.info("%s: сработало %s", key, n)
        except Exception:
            log.exception("%s: ошибка проверки", key)
            await self.redis.delete(key)

    async def listener(self) -> None:
        pubsub = self.redis.pubsub()
        await pubsub.subscribe(CHANNEL_CLOSED)
        async for msg in pubsub.listen():
            if self.stop.is_set():
                break
            if msg.get("type") != "message":
                continue
            data = json.loads(msg["data"])
            tf = str(data.get("tf", ""))
            close_time = datetime.fromisoformat(data["close_time"]).astimezone(UTC)
            symbol = str(data["symbol"])
            if tf == "1m":
                await self._once(
                    done_key(symbol, "1m", close_time), process_price, symbol, close_time
                )
            for bar_tf in tfs_for_event(tf, close_time):
                await self._once(
                    done_key(symbol, bar_tf.value, close_time),
                    process_bars,
                    symbol,
                    bar_tf,
                    close_time,
                )

    async def loop(self) -> None:
        while not self.stop.is_set():
            await self.redis.set(HEARTBEAT_KEY, int(time.time()))
            try:
                cursor = int(await self.redis.get(CURSOR_KEY) or 0)
                new_cursor, fired = await asyncio.to_thread(patterns_once, cursor)
                if new_cursor != cursor:
                    await self.redis.set(CURSOR_KEY, new_cursor)
                if fired:
                    log.info("паттерны: сработало %d", fired)
                fcursor = int(await self.redis.get(FIGURE_CURSOR_KEY) or 0)
                new_f, ffired = await asyncio.to_thread(figures_once, fcursor)
                if new_f != fcursor:
                    await self.redis.set(FIGURE_CURSOR_KEY, new_f)
                if ffired:
                    log.info("фигуры: сработало %d", ffired)
                expired = await asyncio.to_thread(expire_once)
                if expired:
                    log.info("истекло алертов: %d", expired)
            except Exception:
                log.exception("цикл алертов")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.stop.wait(), timeout=LOOP_EVERY)

    async def run(self) -> None:
        tasks = [asyncio.create_task(self.listener()), asyncio.create_task(self.loop())]
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
    w = AlertsWorker()
    loop = asyncio.new_event_loop()
    for sig in (os_signal.SIGINT, os_signal.SIGTERM):
        loop.add_signal_handler(sig, w.stop.set)
    loop.run_until_complete(w.run())


if __name__ == "__main__":
    main()
