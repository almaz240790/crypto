from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from engine.backtest import (
    ExecutionParams,
    TradeStatus,
    breakdown,
    equity_curve,
    run_backtest,
    simulate_trade,
    summarize,
)
from engine.candles import Candle, Timeframe
from engine.params import FilterParams, StrategyParams, TradeParams
from engine.structure import Direction
from engine.trade import TradeSetup
from tests.test_signal import FLAT, SETUP, inputs

D = Decimal
T0 = datetime(2024, 1, 1, tzinfo=UTC)
H4 = Timeframe.H4.delta
TP = TradeParams()
NO_COST = ExecutionParams(fee_rate=D(0), slippage=D(0))

# лонг: вход 100, стоп 97 (риск 3), TP1 103, TP2 107, TP3 112; лимит 98.5
LONG = TradeSetup(
    Direction.UP, D(100), D("98.5"), D(97), D(103), D(107), D(112), D(3), D(7) / D(3), ()
)


def c(o: float, h: float, lo: float, cl: float, i: int = 0) -> Candle:
    return Candle(T0 + H4 * i, D(str(o)), D(str(h)), D(str(lo)), D(str(cl)), D(1))


def test_full_tp_ladder() -> None:
    path = [c(100, 104, 99, 103), c(103, 108, 102, 107), c(107, 113, 106, 112)]
    r = simulate_trade(LONG, path, TP, NO_COST)
    assert r.status is TradeStatus.CLOSED_TP3 and r.tp_hits == 3
    # 0.4×1 + 0.4×(7/3) + 0.2×4 = 0.4 + 0.9333 + 0.8
    assert abs(r.realized_r - D("2.1333")) < D("0.001")
    assert r.r_if_tp1_only == D(1) and r.r_if_full_tp2 == D(7) / D(3)
    assert r.exit_index == 2 and r.max_favorable_r == D(13) / D(3)


def test_stop_loss_and_sl_priority_in_same_candle() -> None:
    r = simulate_trade(LONG, [c(100, 101, 98, 99), c(99, 104, 96, 103)], TP, NO_COST)
    assert r.status is TradeStatus.CLOSED_SL and r.realized_r == D(-1)
    assert r.tp_hits == 0 and r.exit_index == 1
    assert r.max_adverse_r == D(-4) / D(3)


def test_breakeven_after_tp1() -> None:
    r = simulate_trade(LONG, [c(100, 104, 99, 103), c(103, 105, 99.5, 101)], TP, NO_COST)
    assert r.status is TradeStatus.CLOSED_BE and r.tp_hits == 1
    assert r.realized_r == D("0.4")  # 40 % по TP1, остальное в ноль


def test_no_breakeven_variant_keeps_original_stop() -> None:
    params = TradeParams(be_after_tp1=False)
    r = simulate_trade(LONG, [c(100, 104, 99, 103), c(103, 105, 96, 97)], params, NO_COST)
    assert r.status is TradeStatus.CLOSED_SL and r.tp_hits == 1
    assert r.realized_r == D("0.4") + D("0.6") * D(-1)


def test_time_stop() -> None:
    path = [c(100, 102, 99, 101, i) for i in range(TP.time_stop_candles)]
    r = simulate_trade(LONG, path, TP, NO_COST)
    assert r.status is TradeStatus.CLOSED_TIME and r.exit_index == TP.time_stop_candles - 1
    assert r.realized_r == D(1) / D(3)


def test_limit_entry_fill_and_expiry() -> None:
    limit = ExecutionParams(fee_rate=D(0), slippage=D(0), entry_type="limit")
    filled = simulate_trade(LONG, [c(100, 101, 98, 99), c(99, 104, 98.6, 103)], TP, limit)
    assert filled.entry_index == 0 and filled.tp_hits == 1
    # риск от лимитного входа: 98.5 − 97 = 1.5 → TP1 = 4.5/1.5 = 3 R
    assert filled.r_if_tp1_only == D(3)
    never = simulate_trade(LONG, [c(100, 101, 99, 100, i) for i in range(10)], TP, limit)
    assert never.status is TradeStatus.EXPIRED and never.realized_r == D(0)


def test_costs_reduce_r() -> None:
    r = simulate_trade(
        LONG, [c(100, 104, 99, 103), c(103, 108, 102, 107), c(107, 113, 106, 112)], TP
    )
    expected_cost = (D(2) * D("0.0005") + D("0.0003")) * D(100) / D(3)
    assert r.cost_r == expected_cost and abs(r.realized_r - (D("2.1333") - expected_cost)) < D(
        "0.001"
    )


def test_open_when_data_ends() -> None:
    r = simulate_trade(LONG, [c(100, 102, 99, 101)], TP, NO_COST)
    assert r.status is TradeStatus.OPEN and not r.closed
    assert simulate_trade(LONG, [], TP, NO_COST).status is TradeStatus.OPEN


def test_short_mirror_execution() -> None:
    short = TradeSetup(
        Direction.DOWN, D(100), D("101.5"), D(103), D(97), D(93), D(88), D(3), D(7) / D(3), ()
    )
    r = simulate_trade(
        short, [c(100, 101, 96, 97), c(97, 98, 92, 93), c(93, 94, 87, 88)], TP, NO_COST
    )
    assert r.status is TradeStatus.CLOSED_TP3 and abs(r.realized_r - D("2.1333")) < D("0.001")


def test_run_backtest_on_synthetic_setup() -> None:
    params = StrategyParams(filters=FilterParams(atr_min_history=10**6))
    after = [
        (99.5, 104, 99, 103),
        (103, 106, 102, 105.5),
        (105.5, 111, 105, 110),
        (110, 112, 109, 111),
    ]
    inp = inputs(after)
    start = T0 + H4 * (len(FLAT) + len(SETUP) - 3)
    end = T0 + H4 * (len(FLAT) + len(SETUP) + len(after))
    seen: list[str] = []
    run = run_backtest(
        [inp], params, start, end, NO_COST, on_signal=lambda s: seen.append(s.symbol)
    )
    assert run.evaluated >= 4 and seen == ["BTCUSDT"]
    assert len(run.trades) == 1
    t = run.trades[0]
    assert t.symbol == "BTCUSDT" and t.direction is Direction.UP and t.grade.value == "B"
    assert t.result.tp_hits >= 2 and t.exit_time is not None
    assert run.skipped["trigger"] >= 1
    assert run.skipped_by_symbol["BTCUSDT"]["trigger"] == run.skipped["trigger"]
    m = summarize(run.trades)
    assert m.closed == 1 and m.winrate == D(1) and m.sum_r == t.realized_r
    assert breakdown(run.trades, lambda x: x.grade.value)["B"].closed == 1
    assert equity_curve(run.trades)[-1][1] == t.realized_r


def test_summarize_metrics_by_hand() -> None:
    from engine.backtest import BacktestTrade, TradeResult
    from engine.scoring import Grade

    def trade(r: str, status: TradeStatus, hits: int, hours: int, i: int) -> BacktestTrade:
        res = TradeResult(status, D(r), None, None, hits, 0, 1, D(0), D(0), D(0))
        t = T0 + timedelta(hours=4 * i)
        return BacktestTrade(
            "X",
            Direction.UP,
            t,
            Grade.A,
            80,
            D(2),
            D(1),
            D(0),
            D(2),
            D(3),
            D(4),
            res,
            t + timedelta(hours=hours),
        )

    trades = [
        trade("2", TradeStatus.CLOSED_TP3, 3, 8, 0),
        trade("-1", TradeStatus.CLOSED_SL, 0, 4, 1),
        trade("-1", TradeStatus.CLOSED_SL, 0, 4, 2),
        trade("0.4", TradeStatus.CLOSED_BE, 1, 12, 3),
        trade("0", TradeStatus.EXPIRED, 0, 0, 4),
    ]
    m = summarize(trades)
    assert m.signals == 5 and m.closed == 4 and m.expired == 1
    assert m.winrate == D("0.5") and m.sum_r == D("0.4")
    assert m.profit_factor == D("2.4") / D(2)
    assert m.max_drawdown_r == D(2) and m.max_losing_streak == 2
    assert m.tp1_share == D("0.5") and m.tp3_share == D("0.25")
    assert m.avg_duration_hours == D(7)
    assert m.expectancy == D("0.5") * D("1.2") - D("0.5") * D(1)
    assert summarize([]).winrate is None and summarize([]).max_drawdown_r == 0
