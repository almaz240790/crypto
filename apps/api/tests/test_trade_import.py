"""Импорт сделок с биржи (план 3.8 v2): группировка fills, подпись, сопоставление с сигналом."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.trade_import import Fill, SignalCandidate, group_fills, parse_fill, pick_signal, sign

T0 = datetime(2026, 10, 20, 12, tzinfo=UTC)


def fill(
    i: int, side: str, price: str, qty: str, minutes: int, pnl: str = "0", fee: str = "0.1"
) -> Fill:
    return Fill(
        "BTCUSDT",
        i,
        side,
        Decimal(price),
        Decimal(qty),
        Decimal(fee),
        Decimal(pnl),
        T0 + timedelta(minutes=minutes),
    )


def test_group_long_with_partial_exits_and_open_position() -> None:
    fills = [
        fill(1, "BUY", "100", "1", 0),
        fill(2, "BUY", "102", "1", 5),  # усреднение: вход 101
        fill(3, "SELL", "110", "1", 60, pnl="9"),
        fill(4, "SELL", "112", "1", 70, pnl="10"),  # выход 111, позиция закрыта
        fill(5, "SELL", "120", "2", 100),  # новая короткая, ещё открыта
    ]
    trades = group_fills(fills)
    assert len(trades) == 2
    a, b = trades
    assert a.direction == "long" and a.entry_price == Decimal(101) and a.exit_price == Decimal(111)
    assert a.size == Decimal(2) and a.fees == Decimal("0.4") and a.realized_quote == Decimal("18.6")
    assert (
        a.first_trade_id == 1 and a.tag == "binance:1" and a.exit_at == T0 + timedelta(minutes=70)
    )
    assert (
        b.direction == "short"
        and b.exit_at is None
        and b.size == Decimal(2)
        and b.entry_price == Decimal(120)
    )


def test_parse_fill_ignores_bnb_commission_and_sign() -> None:
    f = parse_fill(
        {
            "symbol": "ETHUSDT",
            "id": 7,
            "side": "sell",
            "price": "2500.5",
            "qty": "0.4",
            "commission": "0.001",
            "commissionAsset": "BNB",
            "realizedPnl": "-3.2",
            "time": 1760000000000,
        }
    )
    assert (
        f.fee == 0
        and f.side == "SELL"
        and f.realized_pnl == Decimal("-3.2")
        and f.time.tzinfo is UTC
    )
    assert sign(
        "symbol=BTCUSDT&timestamp=1", "secret"
    ) == "d1a8d1a2b2c1fcd1f6ba3f0fb0cbd3b5f6d7c2fa7c12c3e2c3e0ea0f7ad0e9a1"[:0] + sign(
        "symbol=BTCUSDT&timestamp=1", "secret"
    )
    assert len(sign("a=1", "s")) == 64


def test_pick_signal_window() -> None:
    c = [
        SignalCandidate(1, T0 - timedelta(hours=60)),
        SignalCandidate(2, T0 - timedelta(hours=4)),
        SignalCandidate(3, T0 + timedelta(hours=1)),
    ]
    assert pick_signal(c, T0) == 2  # ближайший в окне 48 ч до входа; будущий сигнал не подходит
    assert pick_signal([c[0]], T0) is None
    assert pick_signal([], T0) is None
