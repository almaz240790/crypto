"""Уведомитель (план 3.11): раз в ``POLL`` секунд читает новые live-сигналы и события трекера
из БД и рассылает письма по настройкам пользователей. Последние обработанные id — в Redis,
при первом запуске начинает с текущего максимума (старое не рассылает). Heartbeat — в Redis.

Здесь же пересчитываются снимки статистики (план 2.4): после закрытия сигнала и раз в
``STATS_EVERY`` секунд. И раз в ``MONITOR_EVERY`` секунд крутится монитор (план 6.7, задача
2.16): проверяет heartbeat воркеров и свежесть свечей, открывает инциденты и шлёт алерты
владельцам. Раз в ``RANK_CHECK_EVERY`` секунд (и при старте) — порядок монет по капитализации
(``app.coin_rank``): с CoinGecko, только если сохранённому в Redis больше суток.

Раз в сутки после ``RECONCILE_HOUR_UTC`` (и при старте, если итога ещё нет) — сверка записанных
сигналов с офлайн-пересчётом (``app.reconcile``, задача 8 пакета «Сигналы»): в фоне, только на
чтение. Итог кладётся в Redis ``reconcile:last``; монитор показывает его компонентом «Сверка
сигналов» и шлёт письмо при расхождении. Сбой сверки тоже записывается итогом — молча она не
пропадает.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import signal as os_signal
import time
from datetime import UTC, datetime
from typing import Any

import httpx
import redis
import redis.asyncio as aioredis
import sentry_sdk
from sqlalchemy import func, select

from app.coin_rank import refresh_if_due
from app.config import settings
from app.db import SessionLocal
from app.models import Signal, SignalEvent
from app.monitor import RECONCILE_KEY, run_monitor
from app.notify import notify_event, notify_new_signal, run_digest, run_journal_reports
from app.reconcile import run_reconcile
from app.retrack import read_only_connection
from app.snapshots import recompute
from app.subscriptions import run_hourly

CLOSING = {"closed_sl", "closed_be", "closed_tp3", "closed_time", "expired", "cancelled"}

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
# сверка сигналов — раз в сутки после этого часа UTC: закрытие 00:00 уже оценено, день записан
RECONCILE_HOUR_UTC = 1
# как часто проверять, пора ли (и повторять после сбоя)
RECONCILE_CHECK_EVERY = 900
HEARTBEAT_KEY = "notifier:heartbeat"
KEY_SIGNAL = "notifier:last_signal_id"
KEY_EVENT = "notifier:last_event_id"


def process(last_signal: int, last_event: int) -> tuple[int, int, int, bool]:
    """Синхронно: новые сигналы и события после указанных id.

    Возвращает новые id, число писем и признак «был закрыт сигнал» (повод пересчитать снимки).
    """
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
            last_signal = sig.id
        for ev in db.scalars(
            select(SignalEvent)
            .where(SignalEvent.id > last_event, SignalEvent.type != "created")
            .order_by(SignalEvent.id)
        ).all():
            closed = closed or ev.type in CLOSING
            try:
                sent += notify_event(db, ev)
            except Exception:
                log.exception("событие %s: ошибка рассылки", ev.id)
                db.rollback()
            last_event = ev.id
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


def last_reconcile_at(raw: bytes | str | None) -> datetime | None:
    """Когда сверка последний раз дошла до конца — из итога в Redis. Сбой за сверку не считается."""
    if not raw:
        return None
    try:
        state = json.loads(raw)
        if not isinstance(state, dict) or state.get("failed"):
            return None
        return datetime.fromisoformat(str(state["at"])).astimezone(UTC)
    except (KeyError, TypeError, ValueError):
        return None


def reconcile_due(now: datetime, last_at: datetime | None) -> bool:
    """Пора ли сверять: итога нет (первый запуск, сбой) или он за прошлые сутки и час настал."""
    if last_at is None:
        return True
    return now.hour >= RECONCILE_HOUR_UTC and last_at.date() < now.date()


def reconcile_once(now: datetime) -> str:
    """Синхронно: одна сверка, итог — в Redis. Возвращает строку для журнала.

    Соединение с БД — только на чтение. Если сверка упала, в Redis пишется итог-сбой: монитор
    покажет его, а следующая проверка повторит попытку.
    """
    r = redis.from_url(settings.redis_url, socket_timeout=5)
    try:
        try:
            with read_only_connection() as conn:
                report = run_reconcile(conn, now)
        except Exception as exc:
            failed = {"at": now.isoformat(), "failed": f"{type(exc).__name__}: {exc}"[:300]}
            r.set(RECONCILE_KEY, json.dumps(failed, ensure_ascii=False))
            raise
        r.set(RECONCILE_KEY, json.dumps(report.to_json(), ensure_ascii=False))
        return "; ".join([report.summary(), *report.lines()])
    finally:
        r.close()


def _reconcile_done(task: asyncio.Task[str]) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        log.error("сверка сигналов: ошибка", exc_info=exc)
    else:
        log.info("%s", task.result())


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

    async def run(self) -> None:
        last_signal = int(await self.redis.get(KEY_SIGNAL) or -1)
        last_event = int(await self.redis.get(KEY_EVENT) or -1)
        next_monitor = 0.0
        next_stats = 0.0
        next_billing = 0.0
        next_ranks = 0.0
        next_reconcile = 0.0
        reconcile_task: asyncio.Task[str] | None = None
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
            if time.monotonic() >= next_reconcile and (
                reconcile_task is None or reconcile_task.done()
            ):
                next_reconcile = time.monotonic() + RECONCILE_CHECK_EVERY
                try:
                    if reconcile_due(now, last_reconcile_at(await self.redis.get(RECONCILE_KEY))):
                        # в фоне: сверка читает много свечей, цикл уведомителя её не ждёт
                        reconcile_task = asyncio.create_task(asyncio.to_thread(reconcile_once, now))
                        reconcile_task.add_done_callback(_reconcile_done)
                except Exception:
                    log.exception("сверка сигналов: запуск")
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
                    process, last_signal, last_event
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
        if reconcile_task is not None and not reconcile_task.done():
            reconcile_task.cancel()
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
