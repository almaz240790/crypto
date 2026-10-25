"""Сервис market-data (этап 2.1, план 6.1/6.3): живые свечи и деривативы Binance USDT-M → БД.

- WebSocket combined streams: kline_1m / kline_4h / kline_1d / kline_1w и forceOrder (ликвидации)
  по всем активным инструментам; до ``STREAMS_PER_CONNECTION`` потоков на соединение.
- Свечи пишутся батчами раз в секунду (upsert); текущая незакрытая свеча хранится с
  ``is_closed = false``, на закрытии перезаписывается с ``true`` и публикуется в Redis
  канал ``candles.closed`` (планировщик слушает 4h, трекер — 1m).
- Ликвидации агрегируются по минутам: SELL = ликвидация лонга, BUY = шорта; сумма в USDT.
- Раз в ``DERIVATIVES_EVERY`` секунд — REST: funding, OI (1h), long/short (1h).
- При старте и после каждого переподключения — догрузка пропусков по REST от последней
  закрытой свечи в БД.
- Heartbeat в Redis ``market_data:heartbeat`` (unix time) — для /health и алертов.
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal as os_signal
import time
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import redis.asyncio as aioredis
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from app.config import settings
from app.db import SessionLocal
from app.forward import UPSERT_CHUNK, _refresh_derivatives, upsert_candles
from app.models import Instrument, LiquidationRow
from engine.candles import Timeframe
from engine.data.binance import BinanceHistory

log = logging.getLogger("market_data")

WS_URL = "wss://fstream.binance.com/stream?streams="
STREAMS_PER_CONNECTION = 150
TIMEFRAMES = (Timeframe.M1, Timeframe.H4, Timeframe.D1, Timeframe.W1)
FLUSH_EVERY = 1.0
DERIVATIVES_EVERY = 300
HEARTBEAT_KEY = "market_data:heartbeat"
STATUS_KEY = "market_data:status"
REPORT_EVERY = 60
CHANNEL_CLOSED = "candles.closed"


def _dt(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


class MarketData:
    def __init__(self) -> None:
        self.redis = aioredis.from_url(settings.redis_url)
        self.symbols: dict[str, int] = {}  # symbol → instrument_id
        self.candle_buffer: dict[tuple[int, str, datetime], dict[str, Any]] = {}
        self.liq_buffer: dict[tuple[int, datetime], list[Decimal]] = defaultdict(
            lambda: [Decimal(0), Decimal(0)]
        )
        self.closed_events: list[dict[str, Any]] = []
        self.stop = asyncio.Event()
        # счётчики для ежеминутной сводки в лог и ключа статуса в Redis (план 2.16)
        self.n_klines = 0
        self.n_flushed = 0
        self.n_published = 0
        self.n_flush_errors = 0

    # --- инструменты и догрузка ----------------------------------------------------------------
    def load_symbols(self) -> None:
        with SessionLocal() as s:
            rows = s.scalars(
                select(Instrument).where(Instrument.market_type == "futures", Instrument.is_active)
            ).all()
            self.symbols = {r.symbol: r.id for r in rows}
        log.info("инструментов: %d", len(self.symbols))

    def backfill(self) -> None:
        """REST-догрузка от последней закрытой свечи в БД до сейчас, по каждому tf."""
        history = BinanceHistory("futures")
        now = datetime.now(tz=UTC)
        with SessionLocal() as s:
            for symbol, inst_id in self.symbols.items():
                for tf in TIMEFRAMES:
                    last = s.execute(
                        text(
                            "select max(open_time) from candles where instrument_id=:i "
                            "and timeframe=:tf and is_closed"
                        ),
                        {"i": inst_id, "tf": tf.value},
                    ).scalar()
                    start = (last.astimezone(UTC) + tf.delta) if last else now - tf.delta * 1500
                    if tf is Timeframe.M1 and not last:
                        start = now - timedelta(days=7)
                    if start >= now:
                        continue
                    try:
                        candles = history.fetch_rest(symbol, tf, start, now)
                    except Exception as exc:
                        log.warning("%s %s: догрузка не удалась: %s", symbol, tf.value, exc)
                        continue
                    closed = [c for c in candles if c.close_time(tf) <= now]
                    if closed:
                        upsert_candles(s, inst_id, tf, closed)
                s.commit()
        log.info("догрузка завершена")

    # --- обработка событий ---------------------------------------------------------------------
    def on_kline(self, k: dict[str, Any]) -> None:
        symbol = k["s"]
        inst_id = self.symbols.get(symbol)
        if inst_id is None:
            return
        self.n_klines += 1
        tf = k["i"]
        open_time = _dt(int(k["t"]))
        row = {
            "instrument_id": inst_id,
            "timeframe": tf,
            "open_time": open_time,
            "open": Decimal(k["o"]),
            "high": Decimal(k["h"]),
            "low": Decimal(k["l"]),
            "close": Decimal(k["c"]),
            "volume": Decimal(k["v"]),
            "quote_volume": Decimal(k["q"]),
            "trades": int(k["n"]),
            "is_closed": bool(k["x"]),
        }
        self.candle_buffer[(inst_id, tf, open_time)] = row
        if row["is_closed"]:
            self.closed_events.append(
                {
                    "symbol": symbol,
                    "instrument_id": inst_id,
                    "tf": tf,
                    "open_time": open_time.isoformat(),
                    "close_time": (open_time + Timeframe(tf).delta).isoformat(),
                    "close": k["c"],
                }
            )

    def on_force_order(self, o: dict[str, Any]) -> None:
        inst_id = self.symbols.get(o["s"])
        if inst_id is None:
            return
        minute = _dt(int(o["T"])).replace(second=0, microsecond=0)
        usd = Decimal(o["q"]) * Decimal(o["ap"])
        bucket = self.liq_buffer[(inst_id, minute)]
        if o["S"] == "SELL":  # продажа по рынку = ликвидирован лонг
            bucket[0] += usd
        else:
            bucket[1] += usd

    # --- запись ---------------------------------------------------------------------------------
    def _flush_sync(
        self,
        candles: list[dict[str, Any]],
        liqs: dict[tuple[int, datetime], list[Decimal]],
    ) -> None:
        with SessionLocal() as s:
            from app.models import Candle as CandleRow

            for i in range(0, len(candles), UPSERT_CHUNK):
                stmt = insert(CandleRow).values(candles[i : i + UPSERT_CHUNK])
                s.execute(
                    stmt.on_conflict_do_update(
                        index_elements=["instrument_id", "timeframe", "open_time"],
                        set_={
                            k: stmt.excluded[k]
                            for k in (
                                "open",
                                "high",
                                "low",
                                "close",
                                "volume",
                                "quote_volume",
                                "trades",
                                "is_closed",
                            )
                        },
                    )
                )
            if liqs:
                stmt2 = insert(LiquidationRow).values(
                    [
                        {
                            "instrument_id": i,
                            "time": t,
                            "long_usd": v[0],
                            "short_usd": v[1],
                            "source": "stream",
                        }
                        for (i, t), v in liqs.items()
                    ]
                )
                s.execute(
                    stmt2.on_conflict_do_update(
                        index_elements=["instrument_id", "time"],
                        set_={
                            "long_usd": LiquidationRow.long_usd + stmt2.excluded.long_usd,
                            "short_usd": LiquidationRow.short_usd + stmt2.excluded.short_usd,
                        },
                    )
                )
            s.commit()

    async def flusher(self) -> None:
        while not self.stop.is_set():
            await asyncio.sleep(FLUSH_EVERY)
            candles = list(self.candle_buffer.values())
            self.candle_buffer.clear()
            # минутные агрегаты ликвидаций отдаём только за завершённые минуты
            cutoff = datetime.now(tz=UTC).replace(second=0, microsecond=0)
            liqs = {k: v for k, v in self.liq_buffer.items() if k[1] < cutoff}
            for k in liqs:
                del self.liq_buffer[k]
            events, self.closed_events = self.closed_events, []
            if candles or liqs:
                try:
                    await asyncio.to_thread(self._flush_sync, candles, liqs)
                    self.n_flushed += len(candles)
                except Exception:
                    self.n_flush_errors += 1
                    log.exception("ошибка записи в БД; данные будут догружены по REST")
            for e in events:
                await self.redis.publish(CHANNEL_CLOSED, json.dumps(e))
                self.n_published += 1
            await self.redis.set(HEARTBEAT_KEY, int(time.time()))
            await self.redis.set(
                STATUS_KEY,
                json.dumps(
                    {
                        "klines": self.n_klines,
                        "flushed": self.n_flushed,
                        "published": self.n_published,
                        "flush_errors": self.n_flush_errors,
                        "buffer": len(self.candle_buffer),
                        "at": int(time.time()),
                    }
                ),
            )

    async def reporter(self) -> None:
        """Раз в минуту — строка сводки в лог: видно, идут ли данные и пишутся ли они."""
        while not self.stop.is_set():
            await asyncio.sleep(REPORT_EVERY)
            log.info(
                "сводка: klines=%d записано=%d опубликовано=%d ошибок записи=%d",
                self.n_klines,
                self.n_flushed,
                self.n_published,
                self.n_flush_errors,
            )

    # --- деривативы -----------------------------------------------------------------------------
    def _derivatives_sync(self) -> None:
        history = BinanceHistory("futures")
        now = datetime.now(tz=UTC)
        with SessionLocal() as s:
            rows = s.scalars(
                select(Instrument).where(Instrument.symbol.in_(list(self.symbols)))
            ).all()
            for inst in rows:
                _refresh_derivatives(s, history, inst, now)
            s.commit()

    async def derivatives_loop(self) -> None:
        while not self.stop.is_set():
            try:
                await asyncio.to_thread(self._derivatives_sync)
            except Exception:
                log.exception("деривативы не обновлены")
            await asyncio.sleep(DERIVATIVES_EVERY)

    # --- websocket -------------------------------------------------------------------------------
    def _streams(self) -> list[list[str]]:
        names: list[str] = []
        for symbol in self.symbols:
            s = symbol.lower()
            names += [f"{s}@kline_{tf.value}" for tf in TIMEFRAMES]
            names.append(f"{s}@forceOrder")
        return [
            names[i : i + STREAMS_PER_CONNECTION]
            for i in range(0, len(names), STREAMS_PER_CONNECTION)
        ]

    async def connection(self, streams: list[str], idx: int) -> None:
        url = WS_URL + "/".join(streams)
        backoff = 1.0
        while not self.stop.is_set():
            try:
                async with connect(url, ping_interval=20, ping_timeout=20, max_size=2**22) as ws:
                    log.info("соединение %d: %d потоков", idx, len(streams))
                    backoff = 1.0
                    async for raw in ws:
                        msg = json.loads(raw)
                        data = msg.get("data", {})
                        event = data.get("e")
                        if event == "kline":
                            self.on_kline(data["k"])
                        elif event == "forceOrder":
                            self.on_force_order(data["o"])
            except (ConnectionClosed, OSError) as exc:
                log.warning("соединение %d разорвано: %s; повтор через %.0f с", idx, exc, backoff)
            except Exception:
                log.exception("соединение %d: ошибка", idx)
            if self.stop.is_set():
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)
            try:
                await asyncio.to_thread(self.backfill)
            except Exception:
                log.exception("догрузка после переподключения не удалась")

    async def run(self) -> None:
        self.load_symbols()
        await asyncio.to_thread(self.backfill)
        tasks = [
            asyncio.create_task(self.flusher()),
            asyncio.create_task(self.derivatives_loop()),
            asyncio.create_task(self.reporter()),
        ]
        tasks += [
            asyncio.create_task(self.connection(chunk, i))
            for i, chunk in enumerate(self._streams())
        ]
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
    md = MarketData()
    loop = asyncio.new_event_loop()
    for sig in (os_signal.SIGINT, os_signal.SIGTERM):
        loop.add_signal_handler(sig, md.stop.set)
    loop.run_until_complete(md.run())


if __name__ == "__main__":
    main()
