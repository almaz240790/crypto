"""Детектор свечных паттернов (план 2A.10.1, 6.3; задача 2B.11).

- Слушает Redis ``candles.closed``: события 4h/1d/1w запускают детекцию по своему TF, события
  1m на границах 15 мин и часа — по 15m/1h (агрегация из 1m в ``chart_data``).
- Идемпотентность: ключ ``patt:done:{symbol}:{tf}:{close_time}`` (SET NX, TTL 2 дня).
- Fallback раз в 60 с: по каждому TF и инструменту проверяет, что по последнему закрытию
  запуск был (+90 с запаса); если свеча уже в БД — запускает.
- Раз в 5 мин дописывает отработку (``pattern_outcomes``), раз в час пересчитывает агрегаты.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import signal as os_signal
import time
from datetime import UTC, datetime, timedelta

import redis.asyncio as aioredis
from sqlalchemy import select

from app.chart_data import bucket_start
from app.config import settings
from app.db import SessionLocal
from app.models import Instrument
from app.patterns import DETECT_TFS, detect_and_store, evaluate_outcomes, recompute_stats
from app.workers.market_data import CHANNEL_CLOSED
from engine.candles import Timeframe

log = logging.getLogger("pattern_detector")
DONE_TTL = 2 * 24 * 3600
FALLBACK_DELAY = timedelta(seconds=90)
FALLBACK_EVERY = 60
OUTCOMES_EVERY = 300
STATS_EVERY = 3600
HEARTBEAT_KEY = "pattern_detector:heartbeat"
DIRECT = {Timeframe.H4, Timeframe.D1, Timeframe.W1}


def done_key(symbol: str, tf: Timeframe, close_time: datetime) -> str:
    return f"patt:done:{symbol}:{tf.value}:{close_time:%Y%m%dT%H%M}"


def tfs_for_event(tf: str, close_time: datetime) -> list[Timeframe]:
    """Какие таймфреймы детектора закрылись по событию market-data."""
    if tf in {t.value for t in DIRECT}:
        return [Timeframe(tf)]
    if tf != "1m":
        return []
    out: list[Timeframe] = []
    if close_time.minute % 15 == 0:
        out.append(Timeframe.M15)
    if close_time.minute == 0:
        out.append(Timeframe.H1)
    return out


def process(symbol: str, tf: Timeframe, close_time: datetime) -> int | None:
    """Синхронно: детекция по инструменту на закрытии ``close_time``.

    None — свеча ещё не в БД (повторим по fallback), иначе число новых отметок.
    """
    with SessionLocal() as db:
        inst = db.scalar(
            select(Instrument).where(
                Instrument.symbol == symbol, Instrument.market_type == "futures"
            )
        )
        if inst is None:
            return 0
        from app.chart_data import PAGE, load_candles
        from engine.candles import closed_only

        candles, _ = load_candles(db, inst.id, tf, None, PAGE)
        candles = closed_only(candles, tf, close_time)
        if not candles or candles[-1].close_time(tf) != close_time:
            return None
        rows = detect_and_store(db, inst, tf, close_time)
        db.commit()
        return len(rows)


def outcomes_once() -> int:
    with SessionLocal() as db:
        n = evaluate_outcomes(db)
        db.commit()
        return n


def stats_once() -> int:
    with SessionLocal() as db:
        n = recompute_stats(db)
        db.commit()
        return n


class Detector:
    def __init__(self) -> None:
        self.redis = aioredis.from_url(settings.redis_url)
        self.stop = asyncio.Event()

    async def try_run(self, symbol: str, tf: Timeframe, close_time: datetime, source: str) -> None:
        key = done_key(symbol, tf, close_time)
        if not await self.redis.set(key, source, nx=True, ex=DONE_TTL):
            return
        try:
            started = time.monotonic()
            n = await asyncio.to_thread(process, symbol, tf, close_time)
            if n is None:
                await self.redis.delete(key)
                return
            log.debug(
                "%s %s %s (%s): %d отметок за %.1f с",
                symbol,
                tf.value,
                close_time,
                source,
                n,
                time.monotonic() - started,
            )
        except Exception:
            log.exception("%s %s %s: ошибка детекции", symbol, tf.value, close_time)
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
            close_time = datetime.fromisoformat(data["close_time"]).astimezone(UTC)
            for tf in tfs_for_event(data.get("tf", ""), close_time):
                await self.try_run(data["symbol"], tf, close_time, "event")

    async def fallback(self) -> None:
        next_outcomes = 0.0
        next_stats = 0.0
        while not self.stop.is_set():
            await self.redis.set(HEARTBEAT_KEY, int(time.time()))
            now = datetime.now(tz=UTC)
            with SessionLocal() as db:
                symbols = db.scalars(
                    select(Instrument.symbol).where(
                        Instrument.market_type == "futures", Instrument.is_active
                    )
                ).all()
            for tf in DETECT_TFS:
                close_time = bucket_start(tf, now)
                if now - close_time < FALLBACK_DELAY:
                    continue
                for symbol in symbols:
                    if await self.redis.exists(done_key(symbol, tf, close_time)):
                        continue
                    await self.try_run(symbol, tf, close_time, "fallback")
            if time.monotonic() >= next_outcomes:
                next_outcomes = time.monotonic() + OUTCOMES_EVERY
                try:
                    n = await asyncio.to_thread(outcomes_once)
                    if n:
                        log.info("отработка: записано %d", n)
                except Exception:
                    log.exception("цикл отработки")
            if time.monotonic() >= next_stats:
                next_stats = time.monotonic() + STATS_EVERY
                try:
                    n = await asyncio.to_thread(stats_once)
                    log.info("агрегаты паттернов: %d строк", n)
                except Exception:
                    log.exception("цикл агрегатов")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.stop.wait(), timeout=FALLBACK_EVERY)

    async def run(self) -> None:
        tasks = [asyncio.create_task(self.listener()), asyncio.create_task(self.fallback())]
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
    d = Detector()
    loop = asyncio.new_event_loop()
    for sig in (os_signal.SIGINT, os_signal.SIGTERM):
        loop.add_signal_handler(sig, d.stop.set)
    loop.run_until_complete(d.run())


if __name__ == "__main__":
    main()
