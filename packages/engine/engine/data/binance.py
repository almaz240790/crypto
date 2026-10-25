"""Загрузка истории свечей Binance.

Источники (без API-ключа):
- Data Vision — месячные zip-архивы klines:
  https://data.binance.vision/data/{futures/um|spot}/monthly/klines/{SYMBOL}/{tf}/{SYMBOL}-{tf}-{YYYY-MM}.zip
- REST — для догрузки текущего месяца:
  https://fapi.binance.com/fapi/v1/klines (perpetual USDT-M),
  https://api.binance.com/api/v3/klines (spot).

Формат строки kline (csv и REST одинаковы по порядку полей):
open_time, open, high, low, close, volume, close_time, quote_volume, trades,
taker_buy_base, taker_buy_quote, ignore. Время — миллисекунды UTC (в новых архивах spot
встречаются микросекунды — нормализуем по величине).
"""

from __future__ import annotations

import csv
import io
import zipfile
from collections.abc import Iterator
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal

import httpx

from engine.candles import Candle, Timeframe

Market = Literal["futures", "spot"]

DATA_VISION = "https://data.binance.vision/data"
REST_BASE = {
    "futures": "https://fapi.binance.com/fapi/v1/klines",
    "spot": "https://api.binance.com/api/v3/klines",
}
REST_LIMIT = 1500


def _ts_to_dt(raw: str | int) -> datetime:
    value = int(raw)
    if value > 10**14:  # микросекунды
        value //= 1000
    return datetime.fromtimestamp(value / 1000, tz=UTC)


def parse_kline_row(row: list[str] | list[str | int | float]) -> Candle:
    return Candle(
        open_time=_ts_to_dt(row[0]),  # type: ignore[arg-type]
        open=Decimal(str(row[1])),
        high=Decimal(str(row[2])),
        low=Decimal(str(row[3])),
        close=Decimal(str(row[4])),
        volume=Decimal(str(row[5])),
        quote_volume=Decimal(str(row[7])),
        trades=int(row[8]),
    )


def parse_zip(content: bytes) -> list[Candle]:
    """Разбирает zip Data Vision (внутри один csv, иногда с заголовком)."""
    candles: list[Candle] = []
    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        for name in zf.namelist():
            if not name.endswith(".csv"):
                continue
            text = zf.read(name).decode("utf-8")
            for row in csv.reader(io.StringIO(text)):
                if not row or not row[0].isdigit():
                    continue  # заголовок или пустая строка
                candles.append(parse_kline_row(row))
    candles.sort(key=lambda c: c.open_time)
    return candles


def month_range(start: date, end: date) -> Iterator[tuple[int, int]]:
    """Все (год, месяц) от start до end включительно."""
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        m += 1
        if m == 13:
            y, m = y + 1, 1


def data_vision_url(symbol: str, tf: Timeframe, year: int, month: int, market: Market) -> str:
    prefix = "futures/um" if market == "futures" else "spot"
    name = f"{symbol}-{tf.value}-{year}-{month:02d}.zip"
    return f"{DATA_VISION}/{prefix}/monthly/klines/{symbol}/{tf.value}/{name}"


class BinanceHistory:
    """Клиент загрузки истории. Синхронный, с повторами. Сеть — только здесь."""

    def __init__(self, market: Market = "futures", client: httpx.Client | None = None) -> None:
        self.market: Market = market
        self._client = client or httpx.Client(timeout=60.0, follow_redirects=True)

    def fetch_month(self, symbol: str, tf: Timeframe, year: int, month: int) -> list[Candle] | None:
        """Месячный архив. ``None`` — архива нет (пара ещё не торговалась или месяц не закрыт)."""
        url = data_vision_url(symbol, tf, year, month, self.market)
        resp = self._client.get(url)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return parse_zip(resp.content)

    def fetch_rest(
        self, symbol: str, tf: Timeframe, start: datetime, end: datetime
    ) -> list[Candle]:
        """Догрузка через REST постранично (по 1500 свечей)."""
        out: list[Candle] = []
        cursor = int(start.timestamp() * 1000)
        end_ms = int(end.timestamp() * 1000)
        while cursor < end_ms:
            params = {
                "symbol": symbol,
                "interval": tf.value,
                "startTime": cursor,
                "endTime": end_ms,
                "limit": REST_LIMIT,
            }
            resp = self._client.get(REST_BASE[self.market], params=params)
            resp.raise_for_status()
            rows = resp.json()
            if not rows:
                break
            batch = [parse_kline_row(r) for r in rows]
            out.extend(batch)
            cursor = int(batch[-1].open_time.timestamp() * 1000) + tf.seconds * 1000
            if len(rows) < REST_LIMIT:
                break
        return out

    def iter_range(
        self, symbol: str, tf: Timeframe, start: date, end: date
    ) -> Iterator[list[Candle]]:
        """История порциями (по месяцу архива, затем REST-хвост) — без накопления в памяти.

        Порции не пересекаются: REST начинается со свечи после последней архивной.
        Для 1m это важно: 4 года × 30 пар не помещаются в память целиком.
        """
        start_dt = datetime(start.year, start.month, start.day, tzinfo=UTC)
        last: datetime | None = None
        # Месячные архивы 1w на Data Vision неполные (недели на стыке месяцев теряются),
        # а объём W1 мал — берём недельные свечи целиком через REST.
        months = [] if tf is Timeframe.W1 else list(month_range(start, end))
        for year, month in months:
            batch = self.fetch_month(symbol, tf, year, month)
            if batch:
                last = batch[-1].open_time
                yield batch
        end_dt = datetime(end.year, end.month, end.day, tzinfo=UTC) + Timeframe.D1.delta
        rest_from = (last + tf.delta) if last is not None else start_dt
        tail = self.fetch_rest(symbol, tf, rest_from, end_dt)
        if tail:
            yield tail

    def fetch_range(self, symbol: str, tf: Timeframe, start: date, end: date) -> list[Candle]:
        """Вся история списком (для небольших таймфреймов и тестов)."""
        candles: list[Candle] = []
        for batch in self.iter_range(symbol, tf, start, end):
            candles.extend(batch)
        # дедупликация по open_time на случай пересечения архива и REST
        seen: dict[datetime, Candle] = {}
        for c in candles:
            seen[c.open_time] = c
        return [seen[k] for k in sorted(seen)]
