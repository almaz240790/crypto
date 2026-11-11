"""Уведомитель (план 3.11): раз в ``POLL`` секунд читает новые live-сигналы и события трекера
из БД и рассылает письма по настройкам пользователей; о сигналах форварда и смене их статуса —
письма и push владельцам и администраторам (``notify_staff_*``); то, что им не ушло (сеть, сбой
почты или push), повторяется с растущим интервалом (``StaffRetry``). События исправления исхода
(``source = 'retrack'``, пересчёт форварда) не рассылаются. Последние обработанные id — в Redis,
при первом запуске начинает с текущего максимума (старое не рассылает). Heartbeat — в Redis.

Здесь же пересчитываются снимки статистики (план 2.4): после закрытия сигнала и раз в
``STATS_EVERY`` секунд. И раз в ``MONITOR_EVERY`` секунд крутится монитор (план 6.7, задача
2.16): проверяет heartbeat воркеров и свежесть свечей, открывает инциденты и шлёт алерты
владельцам. Раз в ``RANK_CHECK_EVERY`` секунд (и при старте) — порядок монет по капитализации
(``app.coin_rank``): с CoinGecko, только если сохранённому в Redis больше суток.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import signal as os_signal
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import partial
from typing import Any

import httpx
import redis
import redis.asyncio as aioredis
import sentry_sdk
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.coin_rank import refresh_if_due
from app.config import settings
from app.corrections import CORRECTION_SOURCE
from app.db import SessionLocal
from app.models import Signal, SignalEvent
from app.monitor import run_monitor
from app.notify import (
    StaffDeliveryError,
    notify_event,
    notify_new_signal,
    notify_staff_event,
    notify_staff_signal,
    run_digest,
    run_journal_reports,
)
from app.snapshots import recompute
from app.subscriptions import run_hourly

CLOSING = {"sl", "be", "tp3", "time_stop", "expired", "cancelled"}
"""Типы событий, закрывающих сигнал: после них снимки статистики пересчитываются сразу (раньше
здесь стояли статусы сигнала, и с типами событий совпадали только expired и cancelled)."""

log = logging.getLogger("notifier")
POLL = 30
MONITOR_EVERY = 60
STATS_EVERY = 600
BILLING_EVERY = 3600
# порядок монет: проверка раз в час, запрос к CoinGecko — раз в сутки (после сбоя — через час)
RANK_CHECK_EVERY = 3600
# дайджесты и отчёт по журналу — раз в сутки после этого часа UTC (понедельник: + недельные)
DIGEST_HOUR_UTC = 6
KEY_DIGEST = "notifier:digest:"
HEARTBEAT_KEY = "notifier:heartbeat"
KEY_SIGNAL = "notifier:last_signal_id"
KEY_EVENT = "notifier:last_event_id"
STAFF_RETRY_FIRST = 60.0
"""Повтор неушедшего уведомления владельцу или администратору — через столько секунд после
неудачи; дальше интервал удваивается до ``STAFF_RETRY_MAX``."""
STAFF_RETRY_MAX = 1800.0
STAFF_RETRY_FOR = 6 * 3600.0
"""Столько секунд после первой неудачи уведомление ещё повторяется; дальше оно устарело —
ошибка в лог, без повтора."""


@dataclass
class _Pending:
    first: float
    due: float
    delay: float


class StaffRetry:
    """Очередь повторов уведомлений владельцу и администраторам (``notify_staff_*``), которые
    ушли не всем: ключ (``signal`` / ``event``, id) → срок следующей попытки. Повтор отправляет
    только неушедшее (``notification_log``). Очередь — в памяти уведомителя: после его
    перезапуска не повторяется."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.items: dict[tuple[str, int], _Pending] = {}

    def failed(self, key: tuple[str, int]) -> None:
        now = self.clock()
        p = self.items.get(key)
        if p is None:
            self.items[key] = _Pending(now, now + STAFF_RETRY_FIRST, STAFF_RETRY_FIRST)
        elif now - p.first >= STAFF_RETRY_FOR:
            del self.items[key]
            log.error(
                "%s %s: уведомление владельцу и администраторам не ушло за %.0f ч — без повтора",
                *key,
                STAFF_RETRY_FOR / 3600,
            )
        else:
            p.delay = min(p.delay * 2, STAFF_RETRY_MAX)
            p.due = now + p.delay

    def done(self, key: tuple[str, int]) -> None:
        self.items.pop(key, None)

    def due(self) -> list[tuple[str, int]]:
        now = self.clock()
        return [k for k, p in self.items.items() if p.due <= now]


def _notify_staff(
    db: Session, retry: StaffRetry, key: tuple[str, int], call: Callable[[], int]
) -> int:
    """Уведомление владельцу и администраторам (``notify_staff_*``). Ушло не всем — в очередь
    повторов; ушло — из очереди. Число отправок."""
    try:
        n = call()
    except StaffDeliveryError as exc:
        log.warning("%s — повтор позже", exc)
        retry.failed(key)
        return exc.sent
    except Exception:
        log.exception("%s %s: ошибка рассылки владельцу и администраторам — повтор позже", *key)
        db.rollback()
        retry.failed(key)
        return 0
    retry.done(key)
    return n


def _retry_staff(db: Session, retry: StaffRetry) -> int:
    """Повтор уведомлений владельцу и администраторам, срок которых подошёл."""
    sent = 0
    for key in retry.due():
        kind, item_id = key
        if kind == "signal":
            sig = db.get(Signal, item_id)
            if sig is not None:
                sent += _notify_staff(db, retry, key, partial(notify_staff_signal, db, sig))
                continue
        else:
            ev = db.get(SignalEvent, item_id)
            if ev is not None:
                sent += _notify_staff(db, retry, key, partial(notify_staff_event, db, ev))
                continue
        retry.done(key)  # строки нет — повторять нечего
    return sent


def process(
    last_signal: int, last_event: int, retry: StaffRetry | None = None
) -> tuple[int, int, int, bool]:
    """Синхронно: новые сигналы и события после указанных id; затем повтор неушедших
    уведомлений владельцу и администраторам из ``retry`` (очередь живёт между вызовами; без
    неё неушедшее только пишется в лог).

    Возвращает новые id, число писем и признак «был закрыт сигнал» (повод пересчитать снимки).
    """
    retry = retry if retry is not None else StaffRetry()
    sent = 0
    closed = False
    with SessionLocal() as db:
        if last_signal < 0:
            last_signal = db.scalar(select(func.max(Signal.id))) or 0
        if last_event < 0:
            last_event = db.scalar(select(func.max(SignalEvent.id))) or 0
        for sig in db.scalars(
            select(Signal).where(Signal.id > last_signal).order_by(Signal.id)
        ).all():
            try:
                sent += notify_new_signal(db, sig)
            except Exception:
                log.exception("сигнал %s: ошибка рассылки", sig.public_id)
                db.rollback()
            sent += _notify_staff(
                db, retry, ("signal", sig.id), partial(notify_staff_signal, db, sig)
            )
            last_signal = sig.id
        for ev in db.scalars(
            select(SignalEvent)
            .where(SignalEvent.id > last_event, SignalEvent.type != "created")
            .order_by(SignalEvent.id)
        ).all():
            closed = closed or ev.type in CLOSING
            last_event = ev.id
            if ev.source == CORRECTION_SOURCE:
                continue  # исправление исхода (пересчёт форварда) — без уведомлений
            try:
                sent += notify_event(db, ev)
            except Exception:
                log.exception("событие %s: ошибка рассылки", ev.id)
                db.rollback()
            sent += _notify_staff(db, retry, ("event", ev.id), partial(notify_staff_event, db, ev))
        sent += _retry_staff(db, retry)
    return last_signal, last_event, sent, closed


def stats_once() -> int:
    with SessionLocal() as db:
        return recompute(db)


def billing_once() -> dict[str, Any]:
    with SessionLocal() as db:
        return run_hourly(db)


def digest_due(now: datetime, done_date: str | None) -> bool:
    """Пора ли слать дайджесты: час настал и за эту дату ещё не слали."""
    return now.hour >= DIGEST_HOUR_UTC and done_date != now.strftime("%Y-%m-%d")


def digests_once(now: datetime) -> dict[str, int]:
    """Синхронно: ежедневный дайджест; по понедельникам — недельный и отчёт по журналу."""
    out: dict[str, int] = {}
    with SessionLocal() as db:
        out["daily"] = run_digest(db, "daily", now)
        if now.weekday() == 0:
            out["weekly"] = run_digest(db, "weekly", now)
            out["journal"] = run_journal_reports(db, now)
    return out


def ranks_once() -> str:
    """Синхронно: обновить порядок монет, если пора. ``fresh`` / ``updated`` / ``failed``."""
    r = redis.from_url(settings.redis_url, socket_timeout=5)
    try:
        with httpx.Client() as client:
            return refresh_if_due(r, client)
    finally:
        r.close()


def monitor_once() -> str:
    """Синхронно: один прогон монитора. Возвращает общий статус."""
    r = redis.from_url(settings.redis_url, socket_timeout=5)
    try:
        with SessionLocal() as db:
            return str(run_monitor(db, r)["status"])
    finally:
        r.close()


class Notifier:
    def __init__(self) -> None:
        self.redis = aioredis.from_url(settings.redis_url)
        self.stop = asyncio.Event()
        self.staff_retry = StaffRetry()

    async def run(self) -> None:
        last_signal = int(await self.redis.get(KEY_SIGNAL) or -1)
        last_event = int(await self.redis.get(KEY_EVENT) or -1)
        next_monitor = 0.0
        next_stats = 0.0
        next_billing = 0.0
        next_ranks = 0.0
        digest_logged = False
        while not self.stop.is_set():
            if time.monotonic() >= next_ranks:
                next_ranks = time.monotonic() + RANK_CHECK_EVERY
                try:
                    await asyncio.to_thread(ranks_once)
                except Exception:
                    log.exception("порядок монет")
            if time.monotonic() >= next_billing:
                next_billing = time.monotonic() + BILLING_EVERY
                try:
                    await asyncio.to_thread(billing_once)
                except Exception:
                    log.exception("цикл подписок")
            now = datetime.now(tz=UTC)
            done = await self.redis.get(KEY_DIGEST + "date")
            done_date = done.decode() if isinstance(done, bytes) else done
            if not digest_logged:
                # один раз при старте — чтобы по логам было видно, почему дайджесты (не) ушли
                log.info("дайджесты: отметка в Redis за %s, час UTC %d", done_date, now.hour)
                digest_logged = True
            if digest_due(now, done_date):
                await self.redis.set(KEY_DIGEST + "date", now.strftime("%Y-%m-%d"), ex=3 * 86400)
                try:
                    log.info("дайджесты: %s", await asyncio.to_thread(digests_once, now))
                except Exception:
                    log.exception("дайджесты: ошибка")
            if time.monotonic() >= next_monitor:
                next_monitor = time.monotonic() + MONITOR_EVERY
                try:
                    status = await asyncio.to_thread(monitor_once)
                    if status != "ok":
                        log.warning("монитор: %s", status)
                except Exception:
                    log.exception("цикл монитора")
            try:
                last_signal, last_event, sent, closed = await asyncio.to_thread(
                    process, last_signal, last_event, self.staff_retry
                )
                await self.redis.set(KEY_SIGNAL, last_signal)
                await self.redis.set(KEY_EVENT, last_event)
                if sent:
                    log.info("отправлено писем: %d", sent)
                if closed:
                    next_stats = 0.0
            except Exception:
                log.exception("цикл уведомителя")
            if time.monotonic() >= next_stats:
                next_stats = time.monotonic() + STATS_EVERY
                try:
                    await asyncio.to_thread(stats_once)
                except Exception:
                    log.exception("снимки статистики")
            await self.redis.set(HEARTBEAT_KEY, int(time.time()))
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.stop.wait(), timeout=POLL)
        await self.redis.aclose()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if settings.sentry_dsn:
        sentry_sdk.init(dsn=settings.sentry_dsn, environment=settings.app_env)
    n = Notifier()
    loop = asyncio.new_event_loop()
    for sig in (os_signal.SIGINT, os_signal.SIGTERM):
        loop.add_signal_handler(sig, n.stop.set)
    loop.run_until_complete(n.run())


if __name__ == "__main__":
    main()
