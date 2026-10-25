"""WebSocket ``/v1/ws``: живые цены и смена статусов сигналов (план 3.4, 6.2).

Один фоновый слушатель Redis на процесс API: ``candles.closed`` (только 1m) → цена закрытия
из БД → всем подписчикам инструмента; ``signals.status`` → всем залогиненным. Клиент не ходит
на биржу напрямую. Без Redis (тесты, локально) слушатель спит и повторяет попытку.
"""

from __future__ import annotations

import asyncio
import json
import logging
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
RETRY_SECONDS = 5


class Client:
    def __init__(self, ws: WebSocket, user_id: int | None) -> None:
        self.ws = ws
        self.user_id = user_id
        self.symbols: set[str] = set()


class Hub:
    def __init__(self) -> None:
        self.clients: set[Client] = set()
        self.task: asyncio.Task[None] | None = None
        # диагностика для /debug/live (план 2.16)
        self.messages = 0
        self.sent = 0
        self.last_message_at: str | None = None
        self.last_error: str | None = None

    def status(self) -> dict[str, Any]:
        return {
            "listener": "running" if self.task and not self.task.done() else "stopped",
            "clients": len(self.clients),
            "subscriptions": sorted({s for c in self.clients for s in c.symbols})[:50],
            "messages": self.messages,
            "sent": self.sent,
            "last_message_at": self.last_message_at,
            "last_error": self.last_error,
        }

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
            await pubsub.subscribe(CHANNEL_CLOSED, CHANNEL_STATUS)
            async for msg in pubsub.listen():
                if msg.get("type") != "message":
                    continue
                channel = msg["channel"]
                if isinstance(channel, bytes):
                    channel = channel.decode()
                data = json.loads(msg["data"])
                self.messages += 1
                self.last_message_at = datetime.now(tz=UTC).isoformat()
                if channel == CHANNEL_CLOSED:
                    if data.get("tf") != "1m" or not self._anyone_wants(data["symbol"]):
                        continue
                    price = data.get("close") or await asyncio.to_thread(
                        _close_price, int(data["instrument_id"]), data["open_time"]
                    )
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


def _close_price(instrument_id: int, open_time: str) -> str | None:
    with SessionLocal() as s:
        row = s.execute(
            CLOSE_SQL, {"i": instrument_id, "t": datetime.fromisoformat(open_time)}
        ).first()
    return None if row is None else format(row[0].normalize(), "f")


hub = Hub()


@router.websocket("/v1/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    """Протокол: клиент → {"sub": ["BTCUSDT", ...]} (замена набора); сервер → price/signal/pong."""
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
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if isinstance(msg, dict) and isinstance(msg.get("sub"), list):
                client.symbols = {str(s).upper() for s in msg["sub"][:200]}
                await ws.send_text(json.dumps({"t": "subscribed", "n": len(client.symbols)}))
            elif msg == {"ping": 1}:
                await ws.send_text('{"t":"pong"}')
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(client)
