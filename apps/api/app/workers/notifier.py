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

Отдельной задачей (ADR-0004) — доставка срабатываний алертов пользователям
(``app.alerts.deliver_batch``): очередь — строки ``alert_triggers`` со статусом ``queued``,
проход раз в ``ALERTS_POLL`` секунд и сразу по сообщению воркера алертов в ``alerts.triggered``.
На Railway ключи почты и Web Push есть у этого процесса, а у воркера алертов — нет. У доставки
свой heartbeat (``ALERTS_HEARTBEAT_KEY``): время, когда очередь последний раз двигалась; монитор
показывает «Уведомления» по худшему из двух heartbeat, так что застрявший проход виден.

Дайджесты (ADR-0002) шлёт этот процесс: у cron-сервиса ``digest`` на Railway нет ключа почты, и
в production без ключа он ничего не отмечает (``app.notify.mail_ready``). Ошибка прохода —
повтор через ``DIGEST_RETRY_AFTER`` секунд; дубли исключает ``notification_log``.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import signal as os_signal
import time
from collections.abc import Awaitable, Callable
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

from app.alerts import CHANNEL_TRIGGERED, DeliveryPass, deliver_batch
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
ALERTS_POLL = 15
"""Опрос очереди срабатываний алертов (страховка: обычно будит сообщение воркера алертов)."""
ALERTS_BUSY = 1.0
"""Выборка очереди полная, но все строки заняты другим экземпляром (выкладка бок о бок): пауза
до следующего прохода — короткая, очередь не кончилась."""
RESTART_AFTER = 5.0
"""Цикл упал с необработанной ошибкой — перезапуск через столько секунд (``_supervised``)."""
REDIS_RETRY = 5.0
"""При старте Redis недоступен — повтор чтения курсоров через столько секунд."""
MONITOR_EVERY = 60
STATS_EVERY = 600
BILLING_EVERY = 3600
# порядок монет: проверка раз в час, запрос к CoinGecko — раз в сутки (после сбоя — через час)
RANK_CHECK_EVERY = 3600
# дайджесты и отчёт по журналу — раз в сутки после этого часа UTC (понедельник: + недельные)
DIGEST_HOUR_UTC = 6
KEY_DIGEST = "notifier:digest:"
DIGEST_RETRY_AFTER = 900
"""Аренда отметки дайджестов: пока идёт проход и после его ошибки отметка за день живёт
столько секунд, затем — повтор (``Notifier.digests``)."""
HEARTBEAT_KEY = "notifier:heartbeat"
ALERTS_HEARTBEAT_KEY = "alert_delivery:heartbeat"
"""Heartbeat доставки алертов: unix-время, когда очередь последний раз двигалась (начало
прохода, очередное срабатывание, конец прохода). Пока проход идёт, пишется раз в ``ALERTS_BEAT``
секунд — с временем последнего движения, а не текущим: застрявший проход его не обновляет."""
ALERTS_BEAT = 10.0
"""Как часто во время прохода очереди писать heartbeat доставки, с."""
ALERTS_STALL = 60.0
"""Проход стоит на одном срабатывании дольше — предупреждение в лог (один раз за проход)."""
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
    """Синхронно: ежедневный дайджест; по понедельникам — недельный и отчёт по журналу.

    Ошибка одной рассылки не отменяет остальные; если хоть одна не завершилась —
    ``RuntimeError`` в конце, и уведомитель повторит проход (отправленным дубля не будет)."""
    jobs: list[tuple[str, Callable[[Session], int]]] = [
        ("daily", lambda db: run_digest(db, "daily", now))
    ]
    if now.weekday() == 0:
        jobs += [
            ("weekly", lambda db: run_digest(db, "weekly", now)),
            ("journal", lambda db: run_journal_reports(db, now)),
        ]
    out: dict[str, int] = {}
    failed: list[str] = []
    with SessionLocal() as db:
        for name, job in jobs:
            try:
                out[name] = job(db)
            except Exception:
                log.exception("дайджесты: рассылка %s не завершена", name)
                db.rollback()
                failed.append(name)
    if failed:
        raise RuntimeError(f"рассылки не завершены: {', '.join(failed)}; отправлено {out}")
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


def alerts_once(progress: Callable[[], None] | None = None) -> DeliveryPass:
    """Синхронно: один проход очереди срабатываний алертов (``app.alerts.deliver_batch``);
    ``progress`` — перед каждым срабатыванием (heartbeat доставки)."""
    with SessionLocal() as db:
        return deliver_batch(db, progress=progress)


class Notifier:
    def __init__(self) -> None:
        self.redis = aioredis.from_url(settings.redis_url)
        self.stop = asyncio.Event()
        self.alerts_wake = asyncio.Event()
        self._redis_ok = True
        # когда очередь алертов последний раз двигалась (unix-время; пишет и поток прохода)
        self._alerts_moved = time.time()
        self.staff_retry = StaffRetry()

    async def run(self) -> None:
        tasks = [
            asyncio.create_task(self._supervised("уведомителя", self.main_loop)),
            asyncio.create_task(self._supervised("доставки алертов", self.alerts_loop)),
            asyncio.create_task(self.alerts_listener()),
        ]
        try:
            await asyncio.gather(tasks[0], tasks[1])  # циклы выходят сами по ``stop``
        finally:
            self.stop.set()
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self.redis.aclose()

    async def _supervised(self, name: str, loop: Callable[[], Awaitable[None]]) -> None:
        """Цикл упал с необработанной ошибкой — в лог и перезапуск через ``RESTART_AFTER``.

        Циклы независимы: доставке алертов нужен только PostgreSQL, и сбой основного цикла
        (Redis перезапустился, ошибка в рассылке) её не останавливает. Раньше любое исключение
        основного цикла завершало процесс, а с ним — и очередь алертов."""
        while not self.stop.is_set():
            try:
                await loop()
            except Exception:
                log.exception("цикл %s упал — перезапуск через %.0f с", name, RESTART_AFTER)
                await self._sleep(RESTART_AFTER)

    async def _sleep(self, seconds: float) -> None:
        """Пауза, которую прерывает остановка."""
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.stop.wait(), timeout=seconds)

    def _redis_failed(self, what: str, exc: Exception) -> None:
        if self._redis_ok:
            log.warning("Redis недоступен (%s: %s) — продолжаем без него", what, exc)
            self._redis_ok = False

    def _redis_back(self) -> None:
        if not self._redis_ok:
            log.info("Redis снова доступен")
            self._redis_ok = True

    async def _get(self, key: str) -> tuple[bool, str | None]:
        """(удалось ли, значение). Недоступность Redis — не ошибка цикла: (False, None)."""
        try:
            value = await self.redis.get(key)
        except Exception as exc:
            self._redis_failed(f"чтение {key}", exc)
            return False, None
        self._redis_back()
        return True, value.decode() if isinstance(value, bytes) else value

    async def _set(self, key: str, value: str | int, ex: int | None = None) -> bool:
        """Записать ключ; недоступность Redis — False (в лог один раз за сбой)."""
        try:
            await self.redis.set(key, value, ex=ex)
        except Exception as exc:
            self._redis_failed(f"запись {key}", exc)
            return False
        self._redis_back()
        return True

    async def _start_id(self, key: str) -> int:
        """Курсор из Redis при старте; Redis недоступен — ждём его (иначе начали бы с текущего
        максимума и пропустили письма о сигналах за время простоя)."""
        while not self.stop.is_set():
            ok, value = await self._get(key)
            if ok:
                return int(value or -1)
            await self._sleep(REDIS_RETRY)
        return -1

    async def alerts_listener(self) -> None:
        """Сообщение воркера алертов в ``alerts.triggered`` — будит ``alerts_loop`` без ожидания.
        Обрыв подписки — переподключение через 5 с; пока её нет, работает опрос."""
        while not self.stop.is_set():
            try:
                async with self.redis.pubsub() as pubsub:  # выход закрывает соединение подписки
                    await pubsub.subscribe(CHANNEL_TRIGGERED)
                    async for msg in pubsub.listen():
                        if msg.get("type") == "message":
                            self.alerts_wake.set()
            except Exception:
                log.warning("подписка %s оборвалась, переподключение", CHANNEL_TRIGGERED)
                await asyncio.sleep(5)

    async def alerts_loop(self) -> None:
        """Проходы очереди срабатываний. Выборка была полной и этот экземпляр что-то обработал —
        следующий проход сразу: в очереди есть ещё (всплеск срабатываний), даже если часть
        строк забрал второй уведомитель или они ждут повтора. Полная, но вся занята другим
        экземпляром — короткая пауза. Иначе — до сообщения воркера или ``ALERTS_POLL``."""
        while not self.stop.is_set():
            self.alerts_wake.clear()
            res = DeliveryPass(0, 0, False)
            try:
                res = await self._alerts_pass()
                if res.decided:
                    log.info("алерты: доставлено срабатываний %d", res.decided)
            except Exception:
                log.exception("доставка алертов")
            self._alerts_touch()
            await self._set(ALERTS_HEARTBEAT_KEY, int(self._alerts_moved))
            if res.full and res.handled:
                continue
            await self._wait_alerts(ALERTS_BUSY if res.full else ALERTS_POLL)

    def _alerts_touch(self) -> None:
        """Очередь сдвинулась (вызывается и из потока прохода)."""
        self._alerts_moved = time.time()

    async def _alerts_pass(self) -> DeliveryPass:
        """Один проход очереди в отдельном потоке. Пока он идёт, раз в ``ALERTS_BEAT`` секунд
        пишется heartbeat доставки — время последнего движения очереди: если отправка по одному
        срабатыванию зависла, heartbeat стареет и монитор это покажет. Сам проход не
        прерывается: каждое срабатывание — в своей транзакции, а запросы к почте и push-сервису
        ограничены таймаутами (``app.mail``, ``app.push.PUSH_TIMEOUT``)."""
        self._alerts_touch()
        job = asyncio.ensure_future(asyncio.to_thread(alerts_once, self._alerts_touch))
        stall_warned = False
        while True:
            await self._set(ALERTS_HEARTBEAT_KEY, int(self._alerts_moved))
            done, _ = await asyncio.wait({job}, timeout=ALERTS_BEAT)
            if done:
                return job.result()
            idle = time.time() - self._alerts_moved
            if idle >= ALERTS_STALL and not stall_warned:
                log.warning("доставка алертов: проход стоит на одном срабатывании %.0f с", idle)
                stall_warned = True

    async def _wait_alerts(self, timeout: float) -> None:
        """До сообщения воркера алертов, остановки или ``timeout`` секунд."""
        waits = [
            asyncio.create_task(self.alerts_wake.wait()),
            asyncio.create_task(self.stop.wait()),
        ]
        try:
            await asyncio.wait(waits, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for w in waits:
                w.cancel()

    async def digests(self, now: datetime) -> None:
        """Проход дайджестов за дату ``now``.

        Отметка «за эту дату отправлено» ставится в Redis на ``DIGEST_RETRY_AFTER`` секунд до
        прохода (аренда) и на трое суток — только после успешного. Ошибка или процесс убит
        посреди прохода (выкладка, перезапуск) — аренда истекает, и проход повторяет этот или
        новый экземпляр; уже отправленным дубля не будет (``notification_log``). Cron-сервис
        digest без ключа почты больше не подстраховывает — повторяем сами. Redis недоступен —
        прохода нет (без аренды его мог бы начать и второй экземпляр), он будет в следующей
        итерации."""
        today = now.strftime("%Y-%m-%d")
        if not await self._set(KEY_DIGEST + "date", today, ex=DIGEST_RETRY_AFTER):
            return  # без Redis нет аренды — проход в следующей итерации
        try:
            result = await asyncio.to_thread(digests_once, now)
        except Exception:
            log.exception("дайджесты: ошибка, повтор через %d с", DIGEST_RETRY_AFTER)
            return
        await self._set(KEY_DIGEST + "date", today, ex=3 * 86400)
        log.info("дайджесты: %s", result)

    async def main_loop(self) -> None:
        """Сигналы и события, дайджесты, монитор, снимки, подписки, порядок монет, heartbeat.

        Redis здесь — курсоры, отметка дайджестов и heartbeat. Его перезапуск или недоступность
        цикл не роняет: курсоры живут в памяти, дайджесты ждут Redis, heartbeat пишется, когда
        он вернётся."""
        last_signal = await self._start_id(KEY_SIGNAL)
        last_event = await self._start_id(KEY_EVENT)
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
            known, done_date = await self._get(KEY_DIGEST + "date")
            if known and not digest_logged:
                # один раз при старте — чтобы по логам было видно, почему дайджесты (не) ушли
                log.info("дайджесты: отметка в Redis за %s, час UTC %d", done_date, now.hour)
                digest_logged = True
            if known and digest_due(now, done_date):
                await self.digests(now)
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
                await self._set(KEY_SIGNAL, last_signal)
                await self._set(KEY_EVENT, last_event)
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
            await self._set(HEARTBEAT_KEY, int(time.time()))
            await self._sleep(POLL)


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
