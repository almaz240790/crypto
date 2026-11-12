"""Планировщик (этап 2.2, план 6.3): запуск движка по закрытию свечи H4.

- Основной путь: подписка на Redis ``candles.closed`` (от market-data), берём только ``tf == 4h``.
- Защита от двойного запуска: ключ ``sched:done:{symbol}:{close_time}`` (SET NX, TTL 2 дня).
- Fallback: раз в 30 с проверяем, что для последнего закрытия H4 (+90 с) по каждому инструменту
  запуск был; если нет — догружаем свечу по REST и запускаем.
- Перед запуском на закрытии, которое совпадает с закрытием дня (00:00 UTC) или недели, —
  проверка, что дневная и недельная свечи уже записаны закрытыми (``ensure_context_candles``):
  market-data пишет закрытые 4h и 1d разными сообщениями, и событие 4h может прийти на секунду
  раньше строки 1d. Короткое ожидание, затем догрузка по REST; если свечи нет — оценка
  откладывается до следующей попытки fallback, а не идёт на незакрытой свече.
- Сам запуск — ``evaluate`` по версиям стратегии в статусе ``forward``/``live`` (как в форварде),
  кандидат пишется в ``signals``; уведомления — отдельный сервис (этап 3). Версии в других
  статусах (новая из кода создаётся в ``backtest``) не оцениваются; об этом одна строка INFO
  на версию и статус за запуск процесса.
- Сводка закрытия (задача 8 пакета «Сигналы»): по одной строке INFO на версию — сколько
  инструментов оценено, сколько отсеяно на каждом этапе (data, bias, trigger, filters, trade) и
  сколько создано сигналов. Пишется, когда оценены все активные инструменты, или через
  ``SUMMARY_DEADLINE`` после закрытия — с тем, что успели. По ней видно, оценивается ли версия
  вообще: отказы на этапах bias и trigger построчно в журнал не пишутся.
- Одна открытая сделка на инструмент и версию, как в бэктесте: пока сделка версии по инструменту
  открыта и на закрытии H4, внутри которой она закрылась, кандидат не пишется
  (``forward.write_candidate``, правило — ``engine.lifecycle.blocking_signal``); пропуск — строка
  INFO логгера ``forward`` с инструментом, версией и ``public_id`` открытого сигнала.
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal as os_signal
import threading
import time
from collections import Counter
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

import redis.asyncio as aioredis
from sqlalchemy import select

from app.config import settings
from app.db import SessionLocal
from app.forward import (
    SKIPPED_VERSION_LOG,
    closed_candle_exists,
    evaluated_versions,
    last_h4_close,
    load_inputs,
    missing_context_candles,
    skipped_versions,
    sync_strategy_versions,
    upsert_candles,
    write_candidate,
)
from app.models import Instrument, StrategyVersion
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
CONTEXT_GRACE = timedelta(seconds=10)
"""Сколько после закрытия H4 ждать закрытых свечей D1/W1 от market-data, прежде чем догружать
их по REST. Срок общий на закрытие, а не на инструмент: очередь инструментов его не умножает."""
CONTEXT_POLL = 0.5

# версия → статус, о котором уже написали «не оценивается»: process_symbol идёт в потоках
_reported_skips: dict[str, str] = {}
_reported_lock = threading.Lock()


def report_skipped_versions(rows: dict[str, StrategyVersion]) -> None:
    """Один раз за запуск процесса на статус версии пишет, что версия не оценивается.

    Вызывается на каждый инструмент, поэтому без памяти строка повторялась бы десятки раз за
    закрытие H4. Строка пишется снова при каждой смене статуса: backtest → archived, а также
    когда версия возвращается в неоцениваемый статус после оценки (backtest → forward → backtest)
    или в прежний неоцениваемый статус через другой (backtest → archived → backtest).
    """
    skipped = skipped_versions(rows)
    with _reported_lock:
        for key in [k for k in _reported_skips if k in rows and k not in skipped]:
            del _reported_skips[key]  # версия снова оценивается — следующий пропуск новый
        fresh = [(k, st) for k, st in skipped.items() if _reported_skips.get(k) != st]
        _reported_skips.update(fresh)
    for key, status in fresh:
        log.info(SKIPPED_VERSION_LOG, key, status)


SUMMARY_DEADLINE = timedelta(minutes=3)
"""Через сколько после закрытия H4 сводка пишется, даже если оценены не все инструменты."""
SUMMARY_KEEP = Timeframe.H4.delta * 2
STAGES = ("data", "bias", "trigger", "filters", "trade")
"""Этапы ``evaluate``, на которых кандидат отсеивается (``NoSignal.stage``)."""
SIGNAL, NOT_A_TRADE, NOT_WRITTEN = "signal", "not_a_trade", "not_written"
"""Исходы кандидата: записан сигнал-сделка; записан кандидат ниже порога публикации или
отложенный; не записан (инструмент занят сделкой, повтор той же свечи, версия снята)."""
SUMMARY_LOG = (
    "%s %s: оценено инструментов %d из %d; отсеяно — data %d, bias %d, trigger %d, filters %d, "
    "trade %d; создано сигналов %d (ещё ниже порога или отложено %d, не записано кандидатов %d)"
)


class CloseSummary:
    """Счётчики одного закрытия H4: какие инструменты оценены и чем кончилась оценка версий."""

    def __init__(self) -> None:
        self.symbols: set[str] = set()
        self.versions: dict[str, Counter[str]] = {}
        self.expected: frozenset[str] | None = None
        """Активные инструменты на момент первой сводки (по ним — «из скольких»)."""
        self.logged = False


_summaries: dict[datetime, CloseSummary] = {}
_summary_lock = threading.Lock()


def record_evaluation(
    at: datetime, symbol: str, outcomes: dict[str, str], evaluated: Iterable[str] = ()
) -> None:
    """Запоминает исход оценки инструмента на закрытии ``at``: версия → этап отсева из
    ``STAGES`` или исход кандидата (``SIGNAL`` / ``NOT_A_TRADE`` / ``NOT_WRITTEN``).

    ``evaluated`` — все оцениваемые версии (forward/live): строка сводки будет у каждой, даже у
    версии со своим списком инструментов, ни одна пара которой к сроку не оценена («0 из N»)."""
    with _summary_lock:
        summary = _summaries.setdefault(at, CloseSummary())
        for key in evaluated:
            summary.versions.setdefault(key, Counter())
        if symbol in summary.symbols:
            return  # повторный запуск по той же свече сводку не удваивает
        summary.symbols.add(symbol)
        for key, outcome in outcomes.items():
            summary.versions.setdefault(key, Counter())[outcome] += 1


def active_instruments() -> frozenset[str]:
    with SessionLocal() as session:
        return frozenset(
            session.scalars(
                select(Instrument.symbol).where(
                    Instrument.market_type == "futures", Instrument.is_active
                )
            ).all()
        )


def log_close_summary(at: datetime, force: bool = False) -> bool:
    """Пишет сводку закрытия ``at`` — по строке на версию, один раз на закрытие.

    Без ``force`` — только когда оценены все активные инструменты; с ``force`` (срок вышел) —
    с тем, что есть: по строке видно, сколько инструментов не оценено. ``True`` — сводка
    написана этим вызовом.
    """
    with _summary_lock:
        summary = _summaries.get(at)
        if summary is None or summary.logged:
            return False
        expected = summary.expected
    if expected is None:
        expected = active_instruments()
    with _summary_lock:
        summary.expected = expected
        if summary.logged or (not force and len(summary.symbols) < len(expected)):
            return False
        summary.logged = True
        versions = {key: Counter(c) for key, c in sorted(summary.versions.items())}
        for old in [t for t in _summaries if t < at - SUMMARY_KEEP]:
            del _summaries[old]
    for key, c in versions.items():
        params = STRATEGIES.get(key)
        # «из скольких» — по списку версии (StrategyParams.symbols), если он есть
        due = sum(1 for sym in expected if params is None or params.covers(sym))
        log.info(
            SUMMARY_LOG,
            at.strftime("%d.%m %H:%M"),
            key,
            sum(c.values()),
            due,
            *(c[stage] for stage in STAGES),
            c[SIGNAL],
            c[NOT_A_TRADE],
            c[NOT_WRITTEN],
        )
    return True


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
        rows = sync_strategy_versions(session)
        report_skipped_versions(rows)
        versions = evaluated_versions(rows)
        inputs = load_inputs(session, inst, at)
        outcomes: dict[str, str] = {}
        for key, version in versions.items():
            params = STRATEGIES[key]
            if not params.covers(symbol):
                continue  # инструмента нет в списке версии (StrategyParams.symbols)
            res = evaluate(inputs, at, params)
            if isinstance(res, SignalCandidate):
                if write_candidate(session, version, inst, res, inputs):
                    outcomes[key] = SIGNAL if res.publishable else NOT_A_TRADE
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
                else:
                    outcomes[key] = NOT_WRITTEN
            elif isinstance(res, NoSignal):
                outcomes[key] = res.stage
                if res.stage not in ("bias", "trigger"):
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
    record_evaluation(at, symbol, outcomes, versions.keys())
    return stats


def ensure_candle(symbol: str, tf: Timeframe, close_time: datetime) -> bool:
    """Есть ли в БД закрытая свеча ``tf`` с этим закрытием; если нет — догрузить по REST."""
    open_time = close_time - tf.delta
    with SessionLocal() as session:
        inst = session.scalar(
            select(Instrument).where(
                Instrument.symbol == symbol, Instrument.market_type == "futures"
            )
        )
        if inst is None:
            return False
        if closed_candle_exists(session, inst.id, tf, open_time):
            return True
        try:
            candles = BinanceHistory("futures").fetch_rest(
                symbol, tf, open_time - tf.delta * 2, close_time
            )
        except Exception as exc:
            log.warning("%s: REST-догрузка свечи %s не удалась: %s", symbol, tf.value, exc)
            return False
        closed = [c for c in candles if c.close_time(tf) <= close_time]
        if not any(c.open_time == open_time for c in closed):
            return False
        upsert_candles(session, inst.id, tf, closed)
        session.commit()
        return True


def ensure_h4_candle(symbol: str, close_time: datetime) -> bool:
    """Есть ли закрытая свеча H4 с этим закрытием в БД; если нет — догрузить по REST."""
    return ensure_candle(symbol, Timeframe.H4, close_time)


def ensure_context_candles(symbol: str, at: datetime, grace: timedelta = CONTEXT_GRACE) -> bool:
    """Записаны ли закрытыми свечи D1/W1, которые закрываются в ``at`` (``context_candles_due``).

    На обычном закрытии H4 таких свечей нет — сразу ``True``. В 00:00 UTC ждём строку от
    market-data до ``at + grace``, затем догружаем недостающее по REST. ``False`` — свечи нет и
    догрузить не удалось: оценивать нельзя, bias посчитался бы без только что закрытого дня
    (или по незакрытой строке), и сигнал разошёлся бы с бэктестом и со сверкой.
    """
    with SessionLocal() as session:
        inst_id = session.scalar(
            select(Instrument.id).where(
                Instrument.symbol == symbol, Instrument.market_type == "futures"
            )
        )
        if inst_id is None:
            return True  # process_symbol по такому инструменту ничего не делает
        while True:
            missing = missing_context_candles(session, inst_id, at)
            if not missing or datetime.now(tz=UTC) >= at + grace:
                break
            session.rollback()  # следующий запрос — в новой транзакции
            time.sleep(CONTEXT_POLL)
    for tf, open_time in missing:
        if not ensure_candle(symbol, tf, open_time + tf.delta):
            log.warning(
                "%s %s: свеча %s не закрыта в БД и не догружена — оценка отложена",
                symbol,
                at.strftime("%d.%m %H:%M"),
                tf.value,
            )
            return False
        log.warning(
            "%s %s: свеча %s догружена по REST (market-data не записал её закрытой вовремя)",
            symbol,
            at.strftime("%d.%m %H:%M"),
            tf.value,
        )
    return True


class Scheduler:
    def __init__(self) -> None:
        self.redis = aioredis.from_url(settings.redis_url)
        self.stop = asyncio.Event()

    async def try_run(self, symbol: str, close_time: datetime, source: str) -> None:
        if not await self.redis.set(done_key(symbol, close_time), source, nx=True, ex=DONE_TTL):
            return
        try:
            if not await asyncio.to_thread(ensure_context_candles, symbol, close_time):
                # не оценено: ключ снимается, fallback повторит попытку через FALLBACK_EVERY
                await self.redis.delete(done_key(symbol, close_time))
                return
            stats = await asyncio.to_thread(process_symbol, symbol, close_time)
            log.debug("%s %s (%s): %s", symbol, close_time, source, stats)
            await asyncio.to_thread(log_close_summary, close_time)
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
            if now - close_time >= SUMMARY_DEADLINE:
                await asyncio.to_thread(log_close_summary, close_time, True)

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
