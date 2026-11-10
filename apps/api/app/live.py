"""WebSocket ``/v1/ws``: живые цены и смена статусов сигналов (план 3.4, 6.2, 2A.3).

Один фоновый слушатель Redis на процесс API. ``prices.live`` (тикер market-data раз в секунду,
ADR-0010) обрабатывается сразу, в самом слушателе: тики ``{"t":"tick","s","p","at"}`` (или пачкой
``{"t":"ticks","at","p":{…}}`` для клиента, попросившего ``batch``) и формирующаяся минута
``{"t":"forming","s","tf":"1m","c"}`` подписчикам символа — не чаще раза в секунду на символ и
клиента. ``candles.closed`` (только 1m) → ``price`` и ``candle``; ``signals.status`` → ``signal``
залогиненным (в сообщении есть ``scope``; форвард — тестовые сигналы, ADR-0013) — через
ограниченную очередь отдельной задачей: чтение БД и ошибки там не задерживают и не обрывают тики.
Каждому клиенту пишет только его задача отправки, с таймаутом: медленный клиент не держит остальных
и отключается. При (пере)подписке слушатель читает последние цены из ключа
``prices:last`` — после перезапуска API и обрыва Redis цены сразу верные. Клиент не ходит на биржу
напрямую. Без Redis (тесты, локально) слушатель спит и повторяет попытку.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

import redis.asyncio as aioredis
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import text

from app import auth
from app.config import settings
from app.db import SessionLocal
from app.entitlements import all_plans_have_test_signals

log = logging.getLogger(__name__)
router = APIRouter()

CHANNEL_CLOSED = "candles.closed"
CHANNEL_STATUS = "signals.status"
CHANNEL_PRICES = "prices.live"
PRICES_KEY = "prices:last"
"""Последние цены целиком ``{"at", "p"}`` от market-data — читаются при (пере)подписке."""
RETRY_SECONDS = 5
TICK_MIN_INTERVAL = 1.0
"""Не чаще раза в секунду на символ и клиента (тик и формирующаяся минута — порознь)."""
TICK_KEEPALIVE = 2.5
"""Неизменная цена повторяется тиком не реже — у клиента «онлайн» = тик за последние 5 с."""
PRICES_FRESH = 5.0
"""Цена символа, не подтверждённая тикером дольше этого, не повторяется и не выдаётся как живая."""
SEND_TIMEOUT = 5.0
"""Клиент не принял сообщение за это время — соединение закрывается (клиент переподключится)."""
OUTBOX_MAX = 256
"""Сообщения без слияния (price, candle, signal, ответы) копятся не больше — дальше отключение."""
EVENTS_MAX = 1000
"""Очередь закрытых минут и статусов от слушателя к обработчику; при переполнении старые — прочь."""
DB_TIMEOUT = 5.0
"""Чтение закрытой минуты из БД (старый market-data без свечи в событии) — не дольше."""
FORMING_KEY = "f:"
LOG_EVERY = 60


def _compact(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"))


def _age(at: object) -> float | None:
    """Секунд с момента ``at`` (ISO с часовым поясом); None — не разобрать."""
    try:
        dt = datetime.fromisoformat(str(at))
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None
    return (datetime.now(tz=UTC) - dt).total_seconds()


class Client:
    def __init__(self, ws: WebSocket, user_id: int | None, role: str | None = None) -> None:
        self.ws = ws
        self.user_id = user_id
        self.role = role if user_id is not None else None  # роль из токена; у гостя её нет
        self.symbols: set[str] = set()
        self.batch = False  # тики одной пачкой раз в секунду ({"t":"ticks"}), не по символу
        self.forming = True  # формирующиеся минуты нужны (графику; ленте — нет)
        # живые цены: по ключу (символ или f:символ) — последнее неотправленное сообщение готовым
        # текстом; новое заменяет старое, так что «очередь» не длиннее числа подписок, а отставший
        # клиент получает свежую цену, а не накопленные
        self.pending: dict[str, str] = {}
        self.batch_p: dict[str, str] = {}
        self.batch_at = ""
        self.batch_sent = float("-inf")
        self.sent_at: dict[str, float] = {}
        # остальное (price, candle, signal, subscribed, pong) — по порядку, без слияния
        self.outbox: deque[str] = deque()
        self.overflow = False
        self.wake = asyncio.Event()
        self.dropped = 0

    def subscribe(self, symbols: set[str], batch: bool = False, forming: bool = True) -> None:
        """Замена набора подписок; неотправленное по снятым символам больше не нужно."""
        self.symbols = symbols
        self.batch = batch
        self.forming = forming
        for d in (self.pending, self.sent_at, self.batch_p):
            for key in [k for k in d if k.removeprefix(FORMING_KEY) not in symbols]:
                del d[key]
        if not forming:
            for key in [k for k in self.pending if k.startswith(FORMING_KEY)]:
                del self.pending[key]

    def has_pending(self, symbol: str) -> bool:
        return symbol in self.pending or symbol in self.batch_p

    def offer_tick(self, symbol: str, price: str, at: str, text_: str) -> None:
        """Тик символа: ``text_`` — готовое ``{"t":"tick"}`` (общий для всех клиентов текст)."""
        if self.batch:
            if symbol in self.batch_p:
                self.dropped += 1
            self.batch_p[symbol] = price
            self.batch_at = at
            self.wake.set()
        else:
            self.offer(symbol, text_)

    def offer(self, key: str, text_: str) -> None:
        if key in self.pending:
            self.dropped += 1  # не успели отправить — заменяем свежим
        self.pending[key] = text_
        self.wake.set()

    def push(self, text_: str) -> None:
        """Сообщение без слияния — в порядке поступления; переполнение — клиент не читает."""
        if len(self.outbox) >= OUTBOX_MAX:
            self.overflow = True
        else:
            self.outbox.append(text_)
        self.wake.set()

    def due(self, now: float) -> tuple[list[str], list[str], float | None]:
        """Что пора отправить: сообщения по порядку, тики; через сколько секунд созреет следующий
        тик (None — неотправленных тиков нет)."""
        msgs = list(self.outbox)
        self.outbox.clear()
        ticks: list[str] = []
        wait: float | None = None
        for key, text_ in list(self.pending.items()):
            left = self.sent_at.get(key, float("-inf")) + TICK_MIN_INTERVAL - now
            if left <= 0:
                ticks.append(text_)
                del self.pending[key]
                self.sent_at[key] = now
            else:
                wait = left if wait is None else min(wait, left)
        if self.batch_p:
            left = self.batch_sent + TICK_MIN_INTERVAL - now
            if left <= 0:
                ticks.append(_compact({"t": "ticks", "at": self.batch_at, "p": self.batch_p}))
                for s in self.batch_p:
                    self.sent_at[s] = now
                self.batch_p = {}
                self.batch_sent = now
            else:
                wait = left if wait is None else min(wait, left)
        return msgs, ticks, wait

    async def pump(self, hub: Hub) -> None:
        """Единственный писатель в сокет клиента — своей задачей: медленный клиент не держит
        остальных; не принял сообщение за ``SEND_TIMEOUT`` — отключается."""
        try:
            while True:
                self.wake.clear()
                if self.overflow:
                    raise OverflowError(f"очередь сообщений клиента > {OUTBOX_MAX}")
                msgs, ticks, wait = self.due(time.monotonic())
                for text_ in msgs:
                    await asyncio.wait_for(self.ws.send_text(text_), SEND_TIMEOUT)
                    hub.sent += 1
                for text_ in ticks:
                    await asyncio.wait_for(self.ws.send_text(text_), SEND_TIMEOUT)
                    hub.ticks_sent += 1
                if msgs or ticks:
                    continue  # пока отправляли, могло прийти новое
                if wait is None:
                    await self.wake.wait()
                else:
                    with suppress(TimeoutError):
                        await asyncio.wait_for(self.wake.wait(), wait)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # соединение оборвано или клиент не читает: отключаем, браузер переподключится
            hub.last_error = f"send: {type(exc).__name__}: {exc}"[:200]
            hub.clients.discard(self)
            with suppress(Exception):
                await self.ws.close()


class Hub:
    def __init__(self) -> None:
        self.clients: set[Client] = set()
        self.task: asyncio.Task[None] | None = None  # слушатель Redis
        self.worker: asyncio.Task[None] | None = None  # закрытые минуты и статусы сигналов
        self.events: asyncio.Queue[tuple[str, dict[str, Any]]] | None = None
        # диагностика для /debug/live (план 2.16)
        self.messages = 0
        self.sent = 0
        self.last_message_at: str | None = None
        self.last_error: str | None = None
        self.events_dropped = 0
        self.errors = 0
        # живые цены: последняя цена символа, когда тикер её подтвердил, время последнего сообщения
        self.prices: dict[str, str] = {}
        self.price_seen: dict[str, float] = {}  # time.monotonic()
        self.prices_at: str | None = None
        self.prices_seen = float("-inf")  # time.monotonic() последнего сообщения тикера
        self.ticks_in = 0
        self.ticks_sent = 0
        self.snapshots = 0

    def status(self) -> dict[str, Any]:
        return {
            "listener": "running" if self.task and not self.task.done() else "stopped",
            "worker": "running" if self.worker and not self.worker.done() else "stopped",
            "clients": len(self.clients),
            "subscriptions": sorted({s for c in self.clients for s in c.symbols})[:50],
            "messages": self.messages,
            "sent": self.sent,
            "last_message_at": self.last_message_at,
            "last_error": self.last_error,
            "events_queued": self.events.qsize() if self.events else 0,
            "events_dropped": self.events_dropped,
            "prices": len(self.prices),
            "prices_at": self.prices_at,
            "ticks_in": self.ticks_in,
            "ticks_sent": self.ticks_sent,
            "ticks_dropped": sum(c.dropped for c in self.clients),
            "snapshots": self.snapshots,
        }

    def _error(self, where: str, exc: BaseException) -> None:
        self.errors += 1
        self.last_error = f"{where}: {type(exc).__name__}: {exc}"[:200]
        if self.errors % LOG_EVERY == 1:
            log.warning("live: %s (ошибок всего %d)", self.last_error, self.errors)

    def _fresh(self, symbol: str, now: float) -> bool:
        return now - self.price_seen.get(symbol, float("-inf")) <= PRICES_FRESH

    def on_prices(self, data: dict[str, Any], now: float | None = None) -> None:
        """Сообщение ``prices.live``: тики подписчикам изменившихся символов, повтор неизменной
        цены раз в ``TICK_KEEPALIVE`` (пока тикер её подтверждает) и формирующиеся минутные свечи.
        Текст тика собирается один раз на символ, не на каждого клиента."""
        now = time.monotonic() if now is None else now
        at = str(data.get("at") or datetime.now(tz=UTC).isoformat())
        raw_p, raw_c, raw_stale = data.get("p"), data.get("c"), data.get("stale")
        heartbeat = isinstance(raw_p, dict)
        prices = {str(k): str(v) for k, v in raw_p.items()} if isinstance(raw_p, dict) else {}
        forming = raw_c if isinstance(raw_c, dict) else {}
        stale = {str(s) for s in raw_stale} if isinstance(raw_stale, list) else set()
        if heartbeat:
            self.ticks_in += 1
            self.snapshots += int(bool(data.get("full")))
            self.prices_at = at
            self.prices_seen = now
            self.prices.update(prices)
            # сообщение тикера подтверждает все цены, кроме «stale» (стрим молчит, REST недоступен)
            for s in self.prices:
                if s not in stale:
                    self.price_seen[s] = now
            for s in stale:
                self.price_seen.pop(s, None)
        texts: dict[str, str] = {}
        ftexts: dict[str, str] = {}

        def tick(s: str, p: str) -> str:
            if s not in texts:
                texts[s] = _compact({"t": "tick", "s": s, "p": p, "at": at})
            return texts[s]

        for c in list(self.clients):
            for s in c.symbols:
                if s in prices:
                    c.offer_tick(s, prices[s], at, tick(s, prices[s]))
                elif (
                    heartbeat
                    and s in self.prices
                    and self._fresh(s, now)
                    and not c.has_pending(s)
                    and now - c.sent_at.get(s, float("-inf")) >= TICK_KEEPALIVE
                ):
                    c.offer_tick(s, self.prices[s], at, tick(s, self.prices[s]))
                if c.forming and isinstance(forming.get(s), dict):
                    if s not in ftexts:
                        payload = {"t": "forming", "s": s, "tf": "1m", "c": forming[s]}
                        ftexts[s] = _compact(payload)
                    c.offer(FORMING_KEY + s, ftexts[s])

    def prime(self, client: Client, now: float | None = None) -> None:
        """Новая подписка: последняя известная цена сразу, если тикер её подтверждает."""
        now = time.monotonic() if now is None else now
        if self.prices_at is None or now - self.prices_seen > PRICES_FRESH:
            return
        for s in client.symbols:
            if s in self.prices and self._fresh(s, now):
                p = self.prices[s]
                text_ = _compact({"t": "tick", "s": s, "p": p, "at": self.prices_at})
                client.offer_tick(s, p, self.prices_at, text_)

    def load_snapshot(self, raw: object, now: float | None = None) -> bool:
        """Цены из ключа ``prices:last`` (при подписке на канал): свежие — как полное сообщение
        тикера, с его возрастом. Сообщения, пропущенные хабом (перезапуск API, обрыв Redis), так
        догоняются сразу, а не с изменением цены."""
        now = time.monotonic() if now is None else now
        try:
            data = json.loads(raw) if isinstance(raw, str | bytes) else None
        except ValueError:
            return False
        if not isinstance(data, dict) or not isinstance(data.get("p"), dict):
            return False
        age = _age(data.get("at"))
        if age is None or age > PRICES_FRESH:
            return False
        self.on_prices({"at": data["at"], "p": data["p"], "full": True}, now=now - max(age, 0.0))
        return True

    async def start(self) -> None:
        if self.task is None:
            self.events = asyncio.Queue(EVENTS_MAX)
            self.task = asyncio.create_task(self._listen_forever())
            self.worker = asyncio.create_task(self._process_events())

    async def stop(self) -> None:
        for task in (self.task, self.worker):
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        self.task = self.worker = None
        self.events = None

    async def _listen_forever(self) -> None:
        while True:
            try:
                await self._listen()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"[:200]
                log.warning(
                    "redis недоступен (%s), повтор через %ss", type(exc).__name__, RETRY_SECONDS
                )
                await asyncio.sleep(RETRY_SECONDS)

    async def _listen(self) -> None:
        r = aioredis.from_url(settings.redis_url)
        try:
            pubsub = r.pubsub()
            await pubsub.subscribe(CHANNEL_CLOSED, CHANNEL_STATUS, CHANNEL_PRICES)
            # после подписки: сообщения позже ключа придут в канал, раньше — уже в ключе
            try:
                self.load_snapshot(await r.get(PRICES_KEY))
            except Exception as exc:
                self._error("prices:last", exc)
            async for msg in pubsub.listen():
                if msg.get("type") != "message":
                    continue
                self.dispatch(msg["channel"], msg["data"])
        finally:
            await r.aclose()

    def dispatch(self, channel: str | bytes, raw: str | bytes) -> None:
        """Сообщение Redis: цены — сразу (без ожиданий), остальное — в очередь обработчика.
        Ошибка в одном сообщении не обрывает подписку."""
        if isinstance(channel, bytes):
            channel = channel.decode()
        try:
            data = json.loads(raw)
        except ValueError as exc:
            self._error(channel, exc)
            return
        if not isinstance(data, dict):
            return
        self.messages += 1
        self.last_message_at = datetime.now(tz=UTC).isoformat()
        if channel == CHANNEL_PRICES:
            try:
                self.on_prices(data)
            except Exception as exc:
                self._error(channel, exc)
        elif channel in (CHANNEL_CLOSED, CHANNEL_STATUS):
            if channel == CHANNEL_CLOSED and (
                data.get("tf") != "1m" or not self._anyone_wants(str(data.get("symbol")))
            ):
                return
            q = self.events
            if q is None:
                return
            if q.full():
                q.get_nowait()  # отстали — старое событие уступает новому
                self.events_dropped += 1
            q.put_nowait((channel, data))

    async def _process_events(self) -> None:
        q = self.events
        assert q is not None
        while True:
            channel, data = await q.get()
            try:
                await self.handle_event(channel, data)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._error(channel, exc)

    async def handle_event(self, channel: str, data: dict[str, Any]) -> None:
        if channel == CHANNEL_STATUS:
            # Гостю — ничего. Вошедшим: live — всем; форвард — как тестовые сигналы (ADR-0013):
            # admin/owner всегда, остальным — пока флаг ``test_signals`` включён на всех тарифах
            # (тариф клиента сокет не знает). Область — в сообщении, клиент ставит пометку.
            # Событие без области (трекер до миграции 0022) не рассылается.
            scope = data.get("scope")
            if scope == "live":
                self.broadcast({"t": "signal", **data}, authed_only=True)
            elif scope == "forward":
                everyone = all_plans_have_test_signals()
                self.broadcast(
                    {"t": "signal", **data},
                    authed_only=True,
                    only=None if everyone else (lambda c: c.role in ("admin", "owner")),
                )
            return
        symbol = str(data["symbol"])
        candle = data.get("candle") if isinstance(data.get("candle"), dict) else None
        if candle is None:  # market-data до ADR-0010: свеча — из БД, не дольше DB_TIMEOUT
            try:
                candle = await asyncio.wait_for(
                    asyncio.to_thread(_candle_row, int(data["instrument_id"]), data["open_time"]),
                    DB_TIMEOUT,
                )
            except Exception as exc:
                self._error("candle row", exc)
        price = (candle or {}).get("c") or data.get("close")
        if price is not None:
            self.broadcast(
                {"t": "price", "s": symbol, "p": price, "at": data["close_time"]}, symbol=symbol
            )
        if candle is not None:
            self.broadcast({"t": "candle", "s": symbol, "tf": "1m", "c": candle}, symbol=symbol)

    def _anyone_wants(self, symbol: str) -> bool:
        return any(symbol in c.symbols for c in self.clients)

    def broadcast(
        self,
        payload: dict[str, Any],
        symbol: str | None = None,
        authed_only: bool = False,
        only: Callable[[Client], bool] | None = None,
    ) -> None:
        """В очередь отправки подходящих клиентов — без ожидания сокетов."""
        text_ = json.dumps(payload)
        for c in list(self.clients):
            if symbol is not None and symbol not in c.symbols:
                continue
            if authed_only and c.user_id is None:
                continue
            if only is not None and not only(c):
                continue
            c.push(text_)


CLOSE_SQL = text(
    "select close from candles where instrument_id=:i and timeframe='1m' and open_time=:t"
)
CANDLE_SQL = text(
    "select open_time, open, high, low, close, volume from candles "
    "where instrument_id=:i and timeframe='1m' and open_time=:t"
)


def _close_price(instrument_id: int, open_time: str) -> str | None:
    with SessionLocal() as s:
        row = s.execute(
            CLOSE_SQL, {"i": instrument_id, "t": datetime.fromisoformat(open_time)}
        ).first()
    return None if row is None else format(row[0].normalize(), "f")


def _candle_row(instrument_id: int, open_time: str) -> dict[str, Any] | None:
    """Закрытая минутная свеча целиком — терминал сворачивает её в текущую свечу своего tf."""
    with SessionLocal() as s:
        row = s.execute(
            CANDLE_SQL, {"i": instrument_id, "t": datetime.fromisoformat(open_time)}
        ).first()
    if row is None:
        return None

    def fmt(x: Any) -> str:
        return format(x.normalize(), "f")

    return {
        "t": int(row[0].timestamp()),
        "o": fmt(row[1]),
        "h": fmt(row[2]),
        "l": fmt(row[3]),
        "c": fmt(row[4]),
        "v": fmt(row[5]),
    }


hub = Hub()


@router.websocket("/v1/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    """Протокол: клиент → {"sub": ["BTCUSDT", ...], "batch"?: true, "forming"?: false} (замена
    набора; batch — тики пачкой {"t":"ticks"}, forming: false — без формирующихся минут) и
    {"ping": 1}; сервер → subscribed, pong, price и candle (закрытая минута), tick или ticks (живая
    цена раз в секунду), forming (формирующаяся минута), signal (со ``scope``: live или forward —
    тестовый сигнал; только вошедшим). Незнакомые типы старые клиенты
    пропускают."""
    user_id: int | None = None
    role: str | None = None
    token = ws.query_params.get("token")
    if token:
        try:
            claims = auth.decode_access_token(token)
            user_id = int(claims["sub"])
            role = str(claims.get("role") or "user")
        except Exception:
            user_id = None
    await ws.accept()
    client = Client(ws, user_id, role)
    hub.clients.add(client)
    await hub.start()
    sender = asyncio.create_task(client.pump(hub))
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if isinstance(msg, dict) and isinstance(msg.get("sub"), list):
                client.subscribe(
                    {str(s).upper() for s in msg["sub"][:200]},
                    batch=msg.get("batch") is True,
                    forming=msg.get("forming") is not False,
                )
                client.push(json.dumps({"t": "subscribed", "n": len(client.symbols)}))
                hub.prime(client)
            elif msg == {"ping": 1}:
                client.push('{"t":"pong"}')
    except (WebSocketDisconnect, RuntimeError):
        pass  # RuntimeError — сокет уже закрыт отправителем (медленный клиент)
    finally:
        sender.cancel()
        with suppress(asyncio.CancelledError):
            await sender
        hub.clients.discard(client)
