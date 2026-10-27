"""Импорт сделок с биржи (план 3.8, v2): Binance USDT-M futures по read-only API-ключу.

Ключ и секрет используются только в этом запросе и не сохраняются. Fills (`/fapi/v1/userTrades`)
группируются в сделки по позиции (открылась при нулевой позиции, закрылась при возврате к нулю),
сделка сопоставляется с live-сигналом по инструменту, направлению и времени входа.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from urllib.parse import urlencode

import httpx

BASE = "https://fapi.binance.com"
USER_TRADES = "/fapi/v1/userTrades"
PAGE = 1000
MAX_SYMBOLS = 80
# вход по сигналу: не раньше закрытия сигнальной свечи и не позже этого окна
MATCH_WINDOW = timedelta(hours=48)
QUOTE_FEES = ("USDT", "BUSD", "USDC")


@dataclass(frozen=True)
class Fill:
    symbol: str
    trade_id: int
    side: str  # BUY / SELL
    price: Decimal
    qty: Decimal
    fee: Decimal  # в валюте котировки; комиссия в BNB не учитывается
    realized_pnl: Decimal
    time: datetime


@dataclass
class Trade:
    symbol: str
    direction: str  # long / short
    entry_at: datetime
    entry_price: Decimal
    size: Decimal
    fees: Decimal
    first_trade_id: int
    exit_at: datetime | None = None
    exit_price: Decimal | None = None
    realized_quote: Decimal | None = None
    fill_ids: list[int] = field(default_factory=list)

    @property
    def tag(self) -> str:
        return f"binance:{self.first_trade_id}"


def sign(query: str, secret: str) -> str:
    return hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()


def parse_fill(raw: dict[str, Any]) -> Fill:
    asset = str(raw.get("commissionAsset") or "")
    fee = Decimal(str(raw.get("commission") or "0")) if asset in QUOTE_FEES else Decimal(0)
    return Fill(
        symbol=str(raw["symbol"]),
        trade_id=int(raw["id"]),
        side=str(raw["side"]).upper(),
        price=Decimal(str(raw["price"])),
        qty=Decimal(str(raw["qty"])),
        fee=fee,
        realized_pnl=Decimal(str(raw.get("realizedPnl") or "0")),
        time=datetime.fromtimestamp(int(raw["time"]) / 1000, tz=UTC),
    )


def fetch_fills(
    client: httpx.Client, api_key: str, api_secret: str, symbol: str, since: datetime
) -> list[Fill]:
    """Все fills по символу с момента ``since`` (постранично по 1000)."""
    out: list[Fill] = []
    start = int(since.timestamp() * 1000)
    for _ in range(50):
        params = {
            "symbol": symbol,
            "startTime": start,
            "limit": PAGE,
            "timestamp": int(time.time() * 1000),
            "recvWindow": 10000,
        }
        q = urlencode(params)
        r = client.get(
            f"{BASE}{USER_TRADES}?{q}&signature={sign(q, api_secret)}",
            headers={"X-MBX-APIKEY": api_key},
            timeout=20,
        )
        if r.status_code != 200:
            msg = (
                r.json().get("msg", r.text)
                if "json" in r.headers.get("content-type", "")
                else r.text
            )
            raise ValueError(f"Binance {r.status_code}: {msg}")
        page = [parse_fill(x) for x in r.json()]
        out.extend(page)
        if len(page) < PAGE:
            break
        start = int(page[-1].time.timestamp() * 1000) + 1
    return out


def group_fills(fills: list[Fill]) -> list[Trade]:
    """Сделки по позиции: открытие при нулевой позиции, закрытие при возврате к нулю.
    Вход/выход — средневзвешенные цены, размер — максимум позиции, комиссии — сумма."""
    trades: list[Trade] = []
    by_symbol: dict[str, list[Fill]] = {}
    for f in fills:
        by_symbol.setdefault(f.symbol, []).append(f)
    for symbol, rows in by_symbol.items():
        rows.sort(key=lambda f: (f.time, f.trade_id))
        pos = Decimal(0)
        cur: Trade | None = None
        open_qty = Decimal(0)
        open_notional = Decimal(0)
        close_qty = Decimal(0)
        close_notional = Decimal(0)
        pnl = Decimal(0)
        for f in rows:
            signed = f.qty if f.side == "BUY" else -f.qty
            if cur is None:
                if signed == 0:
                    continue
                cur = Trade(
                    symbol=symbol,
                    direction="long" if signed > 0 else "short",
                    entry_at=f.time,
                    entry_price=f.price,
                    size=abs(signed),
                    fees=Decimal(0),
                    first_trade_id=f.trade_id,
                )
                open_qty = open_notional = close_qty = close_notional = pnl = Decimal(0)
            cur.fill_ids.append(f.trade_id)
            cur.fees += f.fee
            pnl += f.realized_pnl
            opening = (signed > 0) == (cur.direction == "long")
            if opening:
                open_qty += abs(signed)
                open_notional += abs(signed) * f.price
            else:
                close_qty += abs(signed)
                close_notional += abs(signed) * f.price
            pos += signed
            cur.size = max(cur.size, abs(pos))
            if pos == 0:
                cur.entry_price = open_notional / open_qty if open_qty else cur.entry_price
                cur.exit_price = close_notional / close_qty if close_qty else None
                cur.exit_at = f.time
                cur.realized_quote = pnl - cur.fees
                trades.append(cur)
                cur = None
        if cur is not None:
            cur.entry_price = open_notional / open_qty if open_qty else cur.entry_price
            trades.append(cur)  # позиция ещё открыта — запись без выхода
    return sorted(trades, key=lambda t: t.entry_at)


@dataclass(frozen=True)
class SignalCandidate:
    id: int
    close_time: datetime


def pick_signal(candidates: list[SignalCandidate], entry_at: datetime) -> int | None:
    """Ближайший сигнал, чья свеча закрылась до входа не раньше чем за MATCH_WINDOW."""
    best: SignalCandidate | None = None
    for c in candidates:
        if c.close_time <= entry_at <= c.close_time + MATCH_WINDOW and (
            best is None or c.close_time > best.close_time
        ):
            best = c
    return best.id if best else None
