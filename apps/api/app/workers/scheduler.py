"""Планировщик (этап 2.2, план 6.3): запуск движка по закрытию свечи H4.

- Основной путь: подписка на Redis ``candles.closed`` (от market-data), берём только ``tf == 4h``.
- Защита от двойного запуска: ключ ``sched:done:{symbol}:{close_time}`` (SET NX, TTL 2 дня).
- Fallback: раз в 30 с проверяем, что для последнего закрытия H4 (+90 с) по каждому инструменту
  запуск был; если нет — догружаем свечу по REST и запускаем.
- Сам запуск — ``evaluate`` по версиям стратегии в статусе ``forward``/``live`` (как в форварде),
  кандидат пишется в ``signals``; уведомления — отдельный сервис (этап 3).
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal as os_signal
import time
from datetime import UTC, datetime, timedelta

import redis.asyncio as aioredis
from sqlalchemy import select

from app.config import settings
from app.db import SessionLocal
from app.forward import (
    ensure_strategy_versions,
    last_h4_close,
    load_inputs,
    upsert_candles,
    write_candidate,
)
from app.models import Instrument
from app.workers.market_data import CHANNEL_CLOSED
from engine.candles import Timeframe
from engine.data.binance import BinanceHistory
from engine.signal import NoSignal, SignalCandidate, evaluate
from engine.strategies import STRATEGIES

log = logging.getLogger("scheduler")
DONE_TTL = 2 * 24 * 3600
FALLBACK_DELAY = timedelta(seconds=90)
FALLBACK_EVERY = 30
HEARTBEAT_KEY = "scheduler:heartbeat"


def done_key(symbol: str, close_time: datetime) -> str:
    return f"sched:done:{symbol}:{close_time:%Y%m%dT%H%M}"


def process_symbol(symbol: str, at: datetime) -> dict[str, int]:
    """Синхронно: evaluate по всем версиям для одного инструмента на момент ``at``."""
    stats = {"signals": 0, "no_signal": 0}
    with SessionLocal() as session:
        inst = session.scalar(
            select(Instrument).where(
                Instrument.symbol == symbol, Instrument.market_type == "futures"
            )
        )
        if inst is None:
            return stats
        versions = ensure_strategy_versions(session)
        inputs = load_inputs(session, inst, at)
        for key, version in versions.items():
            res = evaluate(inputs, at, STRATEGIES[key])
            if isinstance(res, SignalCandidate):
                if write_candidate(session, version, inst, res):
                    stats["signals"] += 1
                    log.info(
                        "%s %s %s: %s %s %d%s",
                        at.strftime("%d.%m %H:%M"),
                        symbol,
                        key,
                        res.direction,
                        res.score.grade,
                        res.score.total,
                        " (отложен)" if res.deferred else "",
                    )
            elif isinstance(res, NoSignal) and res.stage not in ("bias", "trigger"):
                stats["no_signal"] += 1
                log.info(
                    "%s %s %s: нет сигнала (%s: %s)",
                    at.strftime("%d.%m %H:%M"),
                    symbol,
                    key,
                    res.stage,
                    res.reason[:80],
                )
        session.commit()
    return stats


def ensure_h4_candle(symbol: str, close_time: datetime) -> bool:
    """Есть ли закрытая свеча H4 с этим закрытием в БД; если нет — догрузить по REST."""
    open_time = close_time - Timeframe.H4.delta
    with SessionLocal() as session:
        inst = session.scalar(select(Instrument).where(Instrument.symbol == symbol))
        if inst is None:
            return False
        from sqlalchemy import text

        exists = session.execute(
            text(
                "select 1 from candles where instrument_id=:i and timeframe='4h' "
                "and open_time=:t and is_closed"
            ),
            {"i": inst.id, "t": open_time},
        ).first()
        if exists:
            return True
        try:
            candles = BinanceHistory("futures").fetch_rest(
                symbol, Timeframe.H4, open_time - Timeframe.H4.delta * 2, close_time
            )
        except Exception as exc:
            log.warning("%s: REST-догрузка свечи не удалась: %s", symbol, exc)
            return False
        closed = [c for c in candles if c.close_time(Timeframe.H4) <= close_time]
        if not any(c.open_time == open_time for c in closed):
            return False
        upsert_candles(session, inst.id, Timeframe.H4, closed)
        session.commit()
        return True


class Scheduler:
    def __init__(self) -> None:
        self.redis = aioredis.from_url(settings.redis_url)
        self.stop = asyncio.Event()

    async def try_run(self, symbol: str, close_time: datetime, source: str) -> None:
        if not await self.redis.set(done_key(symbol, close_time), source, nx=True, ex=DONE_TTL):
            return
        try:
            stats = await asyncio.to_thread(process_symbol, symbol, close_time)
            log.debug("%s %s (%s): %s", symbol, close_time, source, stats)
        except Exception:
            log.exception("%s %s: ошибка запуска движка", symbol, close_time)
            await self.redis.delete(done_key(symbol, close_time))

    async def listener(self) -> None:
        pubsub = self.redis.pubsub()
        await pubsub.subscribe(CHANNEL_CLOSED)
        async for msg in pubsub.listen():
            if self.stop.is_set():
                break
            if msg.get("type") != "message":
                continue
            data = json.loads(msg["data"])
            if data.get("tf") != "4h":
                continue
            close_time = datetime.fromisoformat(data["close_time"]).astimezone(UTC)
            await self.try_run(data["symbol"], close_time, "ws")

    async def fallback(self) -> None:
        while not self.stop.is_set():
            await asyncio.sleep(FALLBACK_EVERY)
            await self.redis.set(HEARTBEAT_KEY, int(time.time()))
            now = datetime.now(tz=UTC)
            close_time = last_h4_close(now)
            if now - close_time < FALLBACK_DELAY:
                continue
            with SessionLocal() as session:
                symbols = session.scalars(
                    select(Instrument.symbol).where(
                        Instrument.market_type == "futures", Instrument.is_active
                    )
                ).all()
            for symbol in symbols:
                if await self.redis.exists(done_key(symbol, close_time)):
                    continue
                ok = await asyncio.to_thread(ensure_h4_candle, symbol, close_time)
                if ok:
                    log.warning(
                        "%s %s: запуск по fallback (событие от market-data не пришло)",
                        symbol,
                        close_time,
                    )
                    await self.try_run(symbol, close_time, "fallback")

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
    s = Scheduler()
    loop = asyncio.new_event_loop()
    for sig in (os_signal.SIGINT, os_signal.SIGTERM):
        loop.add_signal_handler(sig, s.stop.set)
    loop.run_until_complete(s.run())


if __name__ == "__main__":
    main()
