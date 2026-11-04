"""WebSocket ``/v1/ws``: живые цены и смена статусов сигналов (план 3.4, 6.2, 2A.3).

Один фоновый слушатель Redis на процесс API: ``candles.closed`` (только 1m) → цена закрытия
из БД → всем подписчикам инструмента; ``signals.status`` → всем залогиненным; ``prices.live``
(тикер market-data раз в секунду, ADR-0010) → тики ``{"t":"tick","s","p","at"}`` и формирующаяся
минута ``{"t":"forming","s","tf":"1m","c"}`` подписчикам символа — не чаще раза в секунду на символ
и клиента, своей задачей на клиента, без очереди: неотправленное заменяется свежим. Клиент не ходит
на биржу напрямую. Без Redis (тесты, локально) слушатель спит и повторяет попытку.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

import redis.asyncio as aioredis
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import text

from app import auth
from app.config import settings
from app.db import SessionLocal

log = logging.getLogger(__name__)
router = APIRouter()

CHANNEL_CLOSED = "candles.closed"
CHANNEL_STATUS = "signals.status"
CHANNEL_PRICES = "prices.live"
RETRY_SECONDS = 5
TICK_MIN_INTERVAL = 1.0
"""Не чаще раза в секунду на символ и клиента (тик и формирующаяся минута — порознь)."""
TICK_KEEPALIVE = 2.5
"""Неизменная цена повторяется тиком не реже — у клиента «онлайн» = тик за последние 5 с."""
PRICES_FRESH = 5.0
"""Последнее сообщение тикера старше — поток цен считается остановленным (без «первого тика»)."""
SEND_TIMEOUT = 5.0
"""Клиент не принял тик за это время — соединение закрывается (клиент переподключится)."""
FORMING_KEY = "f:"


def _compact(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"))


class Client:
    def __init__(self, ws: WebSocket, user_id: int | None) -> None:
        self.ws = ws
        self.user_id = user_id
        self.symbols: set[str] = set()
        # живые цены: по ключу (символ или f:символ) — последнее неотправленное сообщение; новое
        # заменяет старое, так что «очередь» не длиннее числа подписок, а отставший клиент
        # получает свежую цену, а не накопленные
        self.pending: dict[str, dict[str, Any]] = {}
        self.sent_at: dict[str, float] = {}
        self.wake = asyncio.Event()
        self.dropped = 0

    def subscribe(self, symbols: set[str]) -> None:
        """Замена набора подписок; неотправленное по снятым символам больше не нужно."""
        self.symbols = symbols
        for d in (self.pending, self.sent_at):
            for key in [k for k in d if k.removeprefix(FORMING_KEY) not in symbols]:
                del d[key]

    def offer(self, key: str, payload: dict[str, Any]) -> None:
        if key in self.pending:
            self.dropped += 1  # не успели отправить — заменяем свежим
        self.pending[key] = payload
        self.wake.set()

    def due(self, now: float) -> tuple[list[dict[str, Any]], float | None]:
        """Сообщения, которым пора уйти, и через сколько секунд созреет следующее (None — пусто)."""
        out: list[dict[str, Any]] = []
        wait: float | None = None
        for key, payload in list(self.pending.items()):
            left = self.sent_at.get(key, -TICK_MIN_INTERVAL) + TICK_MIN_INTERVAL - now
            if left <= 0:
                out.append(payload)
                del self.pending[key]
                self.sent_at[key] = now
            else:
                wait = left if wait is None else min(wait, left)
        return out, wait

    async def pump(self, hub: Hub) -> None:
        """Отправка тиков этому клиенту — своей задачей: медленный клиент не держит остальных."""
        try:
            while True:
                await self.wake.wait()
                self.wake.clear()
                while True:
                    batch, wait = self.due(time.monotonic())
                    for payload in batch:
                        await asyncio.wait_for(self.ws.send_text(_compact(payload)), SEND_TIMEOUT)
                        hub.ticks_sent += 1
                    if wait is None:
                        break
                    await asyncio.sleep(wait)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # соединение оборвано или клиент не читает: отключаем, браузер переподключится
            hub.last_error = f"tick send: {type(exc).__name__}: {exc}"[:200]
            hub.clients.discard(self)
            with suppress(Exception):
                await self.ws.close()


class Hub:
    def __init__(self) -> None:
        self.clients: set[Client] = set()
        self.task: asyncio.Task[None] | None = None
        # диагностика для /debug/live (план 2.16)
        self.messages = 0
        self.sent = 0
        self.last_message_at: str | None = None
        self.last_error: str | None = None
        # живые цены: последняя цена каждого символа и время последнего сообщения тикера
        self.prices: dict[str, str] = {}
        self.prices_at: str | None = None
        self.prices_seen = float("-inf")  # time.monotonic() последнего сообщения тикера
        self.ticks_in = 0
        self.ticks_sent = 0

    def status(self) -> dict[str, Any]:
        return {
            "listener": "running" if self.task and not self.task.done() else "stopped",
            "clients": len(self.clients),
            "subscriptions": sorted({s for c in self.clients for s in c.symbols})[:50],
            "messages": self.messages,
            "sent": self.sent,
            "last_message_at": self.last_message_at,
            "last_error": self.last_error,
            "prices": len(self.prices),
            "prices_at": self.prices_at,
            "ticks_in": self.ticks_in,
            "ticks_sent": self.ticks_sent,
            "ticks_dropped": sum(c.dropped for c in self.clients),
        }

    def on_prices(self, data: dict[str, Any], now: float | None = None) -> None:
        """Сообщение ``prices.live``: тики подписчикам изменившихся символов, повтор неизменной
        цены раз в ``TICK_KEEPALIVE`` (пока тикер жив) и формирующиеся минутные свечи."""
        now = time.monotonic() if now is None else now
        at = str(data.get("at") or datetime.now(tz=UTC).isoformat())
        raw_p, raw_c = data.get("p"), data.get("c")
        heartbeat = isinstance(raw_p, dict)
        prices = {str(k): str(v) for k, v in raw_p.items()} if isinstance(raw_p, dict) else {}
        forming = raw_c if isinstance(raw_c, dict) else {}
        if heartbeat:
            self.ticks_in += 1
            self.prices_at = at
            self.prices_seen = now
            self.prices.update(prices)
        for c in list(self.clients):
            for s in c.symbols:
                if s in prices:
                    c.offer(s, {"t": "tick", "s": s, "p": prices[s], "at": at})
                elif (
                    heartbeat
                    and s in self.prices
                    and s not in c.pending
                    and now - c.sent_at.get(s, float("-inf")) >= TICK_KEEPALIVE
                ):
                    c.offer(s, {"t": "tick", "s": s, "p": self.prices[s], "at": at})
                if isinstance(forming.get(s), dict):
                    c.offer(FORMING_KEY + s, {"t": "forming", "s": s, "tf": "1m", "c": forming[s]})

    def prime(self, client: Client, now: float | None = None) -> None:
        """Новая подписка: последняя известная цена сразу, если поток цен жив."""
        now = time.monotonic() if now is None else now
        if self.prices_at is None or now - self.prices_seen > PRICES_FRESH:
            return
        for s in client.symbols:
            if s in self.prices:
                client.offer(s, {"t": "tick", "s": s, "p": self.prices[s], "at": self.prices_at})

    async def start(self) -> None:
        if self.task is None:
            self.task = asyncio.create_task(self._listen_forever())

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task
            self.task = None

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
            async for msg in pubsub.listen():
                if msg.get("type") != "message":
                    continue
                channel = msg["channel"]
                if isinstance(channel, bytes):
                    channel = channel.decode()
                data = json.loads(msg["data"])
                if not isinstance(data, dict):
                    continue
                self.messages += 1
                self.last_message_at = datetime.now(tz=UTC).isoformat()
                if channel == CHANNEL_PRICES:
                    self.on_prices(data)
                elif channel == CHANNEL_CLOSED:
                    if data.get("tf") != "1m" or not self._anyone_wants(data["symbol"]):
                        continue
                    candle = await asyncio.to_thread(
                        _candle_row, int(data["instrument_id"]), data["open_time"]
                    )
                    price = (candle or {}).get("c") or data.get("close")
                    if price is not None:
                        await self.broadcast(
                            {
                                "t": "price",
                                "s": data["symbol"],
                                "p": price,
                                "at": data["close_time"],
                            },
                            symbol=data["symbol"],
                        )
                    if candle is not None:
                        await self.broadcast(
                            {"t": "candle", "s": data["symbol"], "tf": "1m", "c": candle},
                            symbol=data["symbol"],
                        )
                elif channel == CHANNEL_STATUS:
                    await self.broadcast({"t": "signal", **data}, authed_only=True)
        finally:
            await r.aclose()

    def _anyone_wants(self, symbol: str) -> bool:
        return any(symbol in c.symbols for c in self.clients)

    async def broadcast(
        self, payload: dict[str, Any], symbol: str | None = None, authed_only: bool = False
    ) -> None:
        text_ = json.dumps(payload)
        for c in list(self.clients):
            if symbol is not None and symbol not in c.symbols:
                continue
            if authed_only and c.user_id is None:
                continue
            try:
                await c.ws.send_text(text_)
                self.sent += 1
            except Exception:
                self.clients.discard(c)


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
    """Протокол: клиент → {"sub": ["BTCUSDT", ...]} (замена набора) и {"ping": 1};
    сервер → subscribed, pong, price и candle (закрытая минута), tick (живая цена раз в секунду),
    forming (формирующаяся минута), signal. Незнакомые типы старые клиенты пропускают."""
    user_id: int | None = None
    token = ws.query_params.get("token")
    if token:
        try:
            user_id = int(auth.decode_access_token(token)["sub"])
        except Exception:
            user_id = None
    await ws.accept()
    client = Client(ws, user_id)
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
                client.subscribe({str(s).upper() for s in msg["sub"][:200]})
                await ws.send_text(json.dumps({"t": "subscribed", "n": len(client.symbols)}))
                hub.prime(client)
            elif msg == {"ping": 1}:
                await ws.send_text('{"t":"pong"}')
    except (WebSocketDisconnect, RuntimeError):
        pass  # RuntimeError — сокет уже закрыт отправителем тиков (медленный клиент)
    finally:
        sender.cancel()
        with suppress(asyncio.CancelledError):
            await sender
        hub.clients.discard(client)
