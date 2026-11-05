"""Публичная статистика (план 2.11, 3.10): «худшие периоды» и форвард по одной версии."""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.stats import stats_payload, worst_drawdowns
from engine.backtest import BacktestTrade, TradeResult, TradeStatus, summarize
from engine.scoring import Grade
from engine.structure import Direction

T0 = datetime(2026, 10, 26, tzinfo=UTC)


def _trade(r: str, signal_h: float, exit_h: float, sym: str = "X") -> BacktestTrade:
    status = TradeStatus.CLOSED_TP3 if Decimal(r) > 0 else TradeStatus.CLOSED_SL
    res = TradeResult(status, Decimal(r), None, None, 0, 0, 0, Decimal(0), Decimal(0), Decimal(0))
    t = T0 + timedelta(hours=signal_h)
    return BacktestTrade(
        sym, Direction.UP, t, Grade.A, 80, Decimal(2), Decimal(1), Decimal(0), Decimal(2),
        Decimal(3), Decimal(4), res, T0 + timedelta(hours=exit_h), ("sig", "market"),
    )  # fmt: skip


def test_worst_drawdowns_follow_close_time_not_signal_time() -> None:
    """Сделки закрываются не в порядке открытия: долгая прибыльная открыта первой, а две быстрые
    убыточные после неё закрываются раньше. Дно не может оказаться раньше пика."""
    trades = [
        _trade("2", 0, 48),  # открыта первой, закрыта последней
        _trade("-1", 12, 16),
        _trade("-1", 24, 28),
    ]
    dd = worst_drawdowns(trades)
    assert dd == [
        {
            # до первой сделки итог 0, пик — начало учёта (первый сигнал)
            "start": T0.isoformat(),
            "trough": (T0 + timedelta(hours=28)).isoformat(),
            "depth_r": 2.0,
        }
    ]
    # прежний порядок (по сигналу) давал пик 28.10 00:00 и дно 27.10 04:00 — дно раньше пика
    for d in dd:
        assert d["start"] <= d["trough"]
    # метрики движка не меняются: max_drawdown_r по-прежнему в порядке сигналов
    assert stats_payload(trades)["metrics"]["max_drawdown_r"] == float(
        round(summarize(trades).max_drawdown_r, 4)
    )


def test_worst_drawdowns_same_close_time_counted_together() -> None:
    """Две сделки закрылись одной свечой (+1 и −1): порядок внутри свечи ничего не значит,
    просадки «внутри минуты» нет — итог в этот момент не изменился."""
    a = [_trade("1", 0, 8, "A"), _trade("-1", 4, 8, "B")]
    assert worst_drawdowns(a) == []
    assert worst_drawdowns(list(reversed(a))) == []


def test_worst_drawdowns_random_paths_start_before_trough() -> None:
    rng = random.Random(7)
    for _ in range(300):
        trades = []
        for i in range(rng.randint(1, 25)):
            s = rng.randint(0, 200) * 4
            r = rng.choice(["-1", "-1", "-0.5", "0.4", "1", "2.5"])
            trades.append(_trade(r, s, s + rng.randint(1, 30) * 4, f"S{i}"))
        dd = worst_drawdowns(trades)
        assert len(dd) <= 3
        assert [d["depth_r"] for d in dd] == sorted((d["depth_r"] for d in dd), reverse=True)
        for d in dd:
            assert d["start"] <= d["trough"] and d["depth_r"] > 0
        # перестановка входа не меняет результат (порядок задаёт только время закрытия)
        shuffled = trades[:]
        rng.shuffle(shuffled)
        assert worst_drawdowns(shuffled) == dd


def test_worst_drawdowns_open_and_expired_ignored() -> None:
    open_res = TradeResult(
        TradeStatus.OPEN, Decimal(0), None, None, 0, 0, None, Decimal(0), Decimal(0), Decimal(0)
    )
    t = _trade("-1", 0, 4)
    still_open = BacktestTrade(
        "Y", Direction.UP, T0, Grade.B, 60, Decimal(2), Decimal(1), Decimal(0), Decimal(2),
        Decimal(3), Decimal(4), open_res, None, ("sig2", "market"),
    )  # fmt: skip
    assert worst_drawdowns([still_open]) == []
    assert worst_drawdowns([still_open, t]) == [
        {"start": T0.isoformat(), "trough": (T0 + timedelta(hours=4)).isoformat(), "depth_r": 1.0}
    ]
