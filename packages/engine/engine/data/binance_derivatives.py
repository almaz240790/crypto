"""История деривативных данных Binance USDT-M (задача 1.5a).

Источники (без ключа):
- funding: месячные архивы
  ``futures/um/monthly/fundingRate/{SYMBOL}/{SYMBOL}-fundingRate-{YYYY-MM}.zip``
  (csv: calc_time мс, funding_interval_hours, last_funding_rate) + REST ``/fapi/v1/fundingRate``
  для хвоста.
- метрики (OI и long/short): только дневные архивы
  ``futures/um/daily/metrics/{SYMBOL}/{SYMBOL}-metrics-{YYYY-MM-DD}.zip`` с шагом 5 минут
  (csv: create_time, symbol, sum_open_interest, sum_open_interest_value,
  count_toptrader_long_short_ratio, sum_toptrader_long_short_ratio, count_long_short_ratio,
  sum_taker_long_short_vol_ratio). Храним выборку на границе каждого часа.
- ликвидации: исторических архивов нет; собираются live-стримом (этап 2), в бэктесте фильтр
  отключён на периодах без данных.
"""

from __future__ import annotations

import csv
import io
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import httpx

from engine.data.binance import DATA_VISION, month_range
from engine.derivatives import FundingRate

FUNDING_REST = "https://fapi.binance.com/fapi/v1/fundingRate"


@dataclass(frozen=True, slots=True)
class MetricsSample:
    time: datetime
    oi_contracts: Decimal
    oi_quote: Decimal
    top_traders_ratio: Decimal | None
    """Long/short ratio топ-трейдеров по числу аккаунтов (long/short, не доля).
    В архивах до середины 2022 года поля пустые — тогда None."""
    global_ratio: Decimal | None
    taker_ratio: Decimal | None

    @property
    def has_ratios(self) -> bool:
        return self.top_traders_ratio is not None and self.global_ratio is not None

    @property
    def top_long_pct(self) -> Decimal | None:
        """Доля лонгов 0–1 из отношения long/short."""
        r = self.top_traders_ratio
        return None if r is None else r / (1 + r)

    @property
    def global_long_pct(self) -> Decimal | None:
        r = self.global_ratio
        return None if r is None else r / (1 + r)


def _read_csv_from_zip(content: bytes) -> list[list[str]]:
    rows: list[list[str]] = []
    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        for name in zf.namelist():
            if name.endswith(".csv"):
                rows.extend(csv.reader(io.StringIO(zf.read(name).decode("utf-8"))))
    return rows


def parse_funding_rows(rows: list[list[str]]) -> list[FundingRate]:
    out: list[FundingRate] = []
    for row in rows:
        if not row or not row[0].isdigit():
            continue
        out.append(FundingRate(datetime.fromtimestamp(int(row[0]) / 1000, tz=UTC), Decimal(row[2])))
    out.sort(key=lambda r: r.time)
    return out


def _opt(value: str) -> Decimal | None:
    value = value.strip()
    return Decimal(value) if value else None


def parse_metrics_rows(rows: list[list[str]], step_minutes: int = 60) -> list[MetricsSample]:
    """Оставляет записи, у которых минута кратна ``step_minutes`` (по умолчанию — каждый час)."""
    out: list[MetricsSample] = []
    for row in rows:
        if not row or row[0] == "create_time":
            continue
        t = datetime.strptime(row[0], "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC)
        if (t.hour * 60 + t.minute) % step_minutes != 0:
            continue
        out.append(
            MetricsSample(
                time=t,
                oi_contracts=Decimal(row[2]),
                oi_quote=Decimal(row[3]),
                top_traders_ratio=_opt(row[4]),
                global_ratio=_opt(row[6]),
                taker_ratio=_opt(row[7]),
            )
        )
    out.sort(key=lambda r: r.time)
    return out


def funding_url(symbol: str, year: int, month: int) -> str:
    name = f"{symbol}-fundingRate-{year}-{month:02d}.zip"
    return f"{DATA_VISION}/futures/um/monthly/fundingRate/{symbol}/{name}"


def metrics_url(symbol: str, day: date) -> str:
    return f"{DATA_VISION}/futures/um/daily/metrics/{symbol}/{symbol}-metrics-{day:%Y-%m-%d}.zip"


class BinanceDerivativesHistory:
    def __init__(self, client: httpx.Client | None = None) -> None:
        self._client = client or httpx.Client(timeout=60.0, follow_redirects=True)

    def _get_zip(self, url: str) -> list[list[str]] | None:
        resp = self._client.get(url)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return _read_csv_from_zip(resp.content)

    def fetch_funding_month(self, symbol: str, year: int, month: int) -> list[FundingRate] | None:
        rows = self._get_zip(funding_url(symbol, year, month))
        return None if rows is None else parse_funding_rows(rows)

    def fetch_funding_rest(self, symbol: str, start: datetime, end: datetime) -> list[FundingRate]:
        out: list[FundingRate] = []
        cursor = int(start.timestamp() * 1000)
        end_ms = int(end.timestamp() * 1000)
        while cursor < end_ms:
            resp = self._client.get(
                FUNDING_REST,
                params={"symbol": symbol, "startTime": cursor, "endTime": end_ms, "limit": 1000},
            )
            resp.raise_for_status()
            rows = resp.json()
            if not rows:
                break
            batch = [
                FundingRate(
                    datetime.fromtimestamp(int(r["fundingTime"]) / 1000, tz=UTC),
                    Decimal(str(r["fundingRate"])),
                )
                for r in rows
            ]
            out.extend(batch)
            cursor = int(batch[-1].time.timestamp() * 1000) + 1
            if len(rows) < 1000:
                break
        return out

    def iter_funding(self, symbol: str, start: date, end: date) -> Iterator[list[FundingRate]]:
        last: datetime | None = None
        for year, month in month_range(start, end):
            batch = self.fetch_funding_month(symbol, year, month)
            if batch:
                last = batch[-1].time
                yield batch
        start_dt = datetime(start.year, start.month, start.day, tzinfo=UTC)
        end_dt = datetime(end.year, end.month, end.day, tzinfo=UTC) + timedelta(days=1)
        tail = self.fetch_funding_rest(
            symbol, (last + timedelta(seconds=1)) if last else start_dt, end_dt
        )
        if tail:
            yield tail

    def fetch_metrics_day(
        self, symbol: str, day: date, step_minutes: int = 60
    ) -> list[MetricsSample] | None:
        rows = self._get_zip(metrics_url(symbol, day))
        return None if rows is None else parse_metrics_rows(rows, step_minutes)

    def iter_metrics(
        self, symbol: str, start: date, end: date, step_minutes: int = 60
    ) -> Iterator[tuple[date, list[MetricsSample] | None]]:
        """По дню: (дата, выборка) или (дата, None), если архива нет."""
        day = start
        while day <= end:
            yield day, self.fetch_metrics_day(symbol, day, step_minutes)
            day += timedelta(days=1)
