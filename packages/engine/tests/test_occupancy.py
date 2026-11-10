"""Одна открытая сделка на инструмент и версию (``engine.occupancy``; задача 6 пакета 2026-11-05).

- граничные случаи правила: открытые статусы, свеча выхода, закрытие ровно на границе свечи,
  пересчёт задним числом, лимит, ошибки входа;
- эквивалентность: ``run_backtest`` с общим правилом пропускает те же закрытия H4 и даёт те же
  сделки, что прежний цикл с ``busy_until`` (эталонная копия ниже), на 400 случайных сценариях,
  в том числе с пропусками свечей, истёкшими лимитами и сделками, открытыми до конца данных;
- 1m-закрытие внутри свечи H4 занимает только закрытие этой свечи, как выход по H4 в бэктесте.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest

import engine.backtest as bt
from engine.backtest import (
    BacktestTrade,
    TradeResult,
    TradeStatus,
    backtest_span,
    run_backtest,
)
from engine.candles import SIGNAL_TIMEFRAME, Candle, Timeframe
from engine.occupancy import OPEN_STATUSES, TradeSpan, occupies, occupying
from engine.params import StrategyParams
from engine.scoring import Grade
from engine.signal import MarketInputs, NoSignal
from engine.structure import Direction
from engine.tracker import SignalStatus

D = Decimal
H4 = SIGNAL_TIMEFRAME.delta
M1 = timedelta(minutes=1)
T0 = datetime(2026, 10, 26, 8, tzinfo=UTC)


def span(status: str, opened: datetime = T0, ended: datetime | None = None) -> TradeSpan:
    return TradeSpan("sig", opened, status, ended)


# --- правило -------------------------------------------------------------------------------------


def test_open_statuses_are_the_tracker_open_statuses() -> None:
    assert {s.value for s in SignalStatus if s.is_open} == OPEN_STATUSES


@pytest.mark.parametrize("status", sorted(OPEN_STATUSES))
def test_open_signal_blocks_every_later_close(status: str) -> None:
    for n in (1, 2, 15, 100):
        assert occupying([span(status)], T0 + n * H4) is not None


def test_signal_does_not_block_its_own_close_or_earlier() -> None:
    """Опубликованный в ``at`` или позже сигнал на ``at`` не влияет (пересчёт задним числом)."""
    assert occupying([span("active")], T0) is None
    assert occupying([span("active", opened=T0 + H4)], T0) is None


def test_trade_closed_inside_candle_blocks_that_close_only() -> None:
    """Сделка закрылась в 10:37 внутри свечи 08:00–12:00: закрытие 12:00 занято, 16:00 — нет."""
    closed = span("closed_sl", ended=T0 + H4 + timedelta(hours=2, minutes=37))
    assert occupying([closed], T0 + 2 * H4) is closed
    assert occupying([closed], T0 + 3 * H4) is None


def test_close_on_candle_boundary_belongs_to_the_candle_it_ends() -> None:
    """Последняя минута свечи закрывается ровно в ``at`` — занята свеча ``at``; закрытие ровно
    в ``at − H4`` относится к предыдущей свече."""
    closed = span("closed_time", ended=T0 + 15 * H4)
    assert occupying([closed], T0 + 15 * H4) is closed
    assert occupying([closed], T0 + 16 * H4) is None
    first_minute = span("closed_sl", ended=T0 + 15 * H4 + M1)
    assert occupying([first_minute], T0 + 16 * H4) is first_minute


def test_known_end_wins_over_status() -> None:
    """При пересчёте задним числом сигнал, закрывшийся после ``at``, на ``at`` был открыт; сигнал
    с конечным статусом без времени конца инструмент не занимает."""
    later = span("closed_tp3", ended=T0 + 30 * H4)
    assert occupying([later], T0 + 5 * H4) is later
    assert occupying([span("closed_sl")], T0 + H4) is None
    assert occupying([span("cancelled", ended=T0 + H4 + M1)], T0 + 2 * H4) is not None


def test_pending_limit_blocks_until_expiry_candle() -> None:
    """Живой режим: ожидающий лимит занимает инструмент, истёкший — ещё и свечу истечения."""
    assert occupying([span("pending")], T0 + 6 * H4) is not None
    expired = span("expired", ended=T0 + 6 * H4)
    assert occupying([expired], T0 + 6 * H4) is expired
    assert occupying([expired], T0 + 7 * H4) is None


def test_first_blocking_signal_is_returned() -> None:
    old = span("closed_sl", ended=T0 + H4)
    blocking = TradeSpan("b", T0 + 2 * H4, "tp1_hit")
    assert occupying([old, blocking], T0 + 4 * H4) is blocking
    assert occupying([], T0 + H4) is None
    assert occupies(blocking, T0 + 3 * H4) and not occupies(old, T0 + 3 * H4)


def test_at_must_be_utc_close_of_signal_candle() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        occupying([], datetime(2026, 10, 26, 8))
    with pytest.raises(ValueError, match="UTC"):
        occupying([], datetime(2026, 10, 26, 11, tzinfo=timezone(timedelta(hours=3))))
    with pytest.raises(ValueError, match="не на закрытии"):
        occupying([], T0 + timedelta(hours=1))


# --- сделки бэктеста ----------------------------------------------------------------------------


def _trade(status: TradeStatus, exit_time: datetime | None) -> BacktestTrade:
    res = TradeResult(status, D(0), None, None, 0, 0, None, D(0), D(0), D(0))
    return BacktestTrade(
        "XUSDT", Direction.DOWN, T0, Grade.B, 70, D(2), D(1), D(2), D(1), D(1), D(1), res, exit_time
    )


def test_backtest_span_mapping() -> None:
    closed = backtest_span(_trade(TradeStatus.CLOSED_BE, T0 + 3 * H4))
    assert closed == TradeSpan(T0.isoformat(), T0, "closed_be", T0 + 3 * H4)
    assert backtest_span(_trade(TradeStatus.OPEN, None)) == TradeSpan(T0.isoformat(), T0, "active")
    # исход лимита известен заранее: истёкший лимит сделкой не был и инструмент не занимает
    assert backtest_span(_trade(TradeStatus.EXPIRED, None)) is None


# --- эквивалентность прежнему циклу бэктеста ------------------------------------------------------


class FakeCandidate(SimpleNamespace):
    """Кандидат движка с полями, которые читает ``run_backtest`` (подменяет ``SignalCandidate``)."""


class Script:
    """Детерминированные «движок» и «исполнение» для сценария: где кандидат и чем кончится сделка.

    Решения зависят только от (инструмент, ``at``), поэтому оба цикла видят одно и то же.
    """

    def __init__(self, seed: int) -> None:
        self.seed = seed

    def _rng(self, symbol: str, at: datetime) -> random.Random:
        return random.Random(f"{self.seed}|{symbol}|{at.isoformat()}")

    def evaluate(self, inputs: MarketInputs, at: datetime, params: StrategyParams) -> Any:
        rng = self._rng(inputs.symbol, at)
        roll = rng.random()
        if roll < 0.55:
            return NoSignal("trigger", "нет слома")
        trade = SimpleNamespace(
            rr_tp2=D(2), entry_market=D(100), stop_loss=D(95), tp1=D(105), tp2=D(110), tp3=D(120)
        )
        return FakeCandidate(
            direction=Direction.DOWN,
            deferred=roll > 0.97,
            score=SimpleNamespace(publishable=roll < 0.93, grade=Grade.B, total=70),
            trade=trade,
            facts=(inputs.symbol, at.isoformat()),
            symbol=inputs.symbol,
            at=at,
        )

    def simulate(self, setup: Any, candles: Any, trade_params: Any, exec_params: Any) -> Any:
        n = len(candles)
        rng = random.Random(f"{self.seed}|sim|{n}|{candles[0].open_time if n else '-'}")
        kind = rng.random()
        if kind < 0.1:
            return TradeResult(
                TradeStatus.EXPIRED, D(0), None, None, 0, None, None, D(0), D(0), D(0)
            )
        if n == 0 or kind < 0.2:
            return TradeResult(TradeStatus.OPEN, D(0), None, None, 0, 0, None, D(0), D(0), D(0))
        status = rng.choice(
            [TradeStatus.CLOSED_SL, TradeStatus.CLOSED_TP3, TradeStatus.CLOSED_TIME]
        )
        exit_index = rng.randrange(min(n, 25))
        return TradeResult(status, D(1), D(1), D(1), 1, 0, exit_index, D(1), D(0), D(0))


def legacy_run(
    inputs: list[MarketInputs], start: datetime, end: datetime, script: Script
) -> tuple[list[datetime], list[tuple[str, datetime, str, datetime | None]]]:
    """Прежний цикл ``run_backtest`` (до общего правила): ``busy_until`` по индексам свечей."""
    evaluated: list[datetime] = []
    trades: list[tuple[str, datetime, str, datetime | None]] = []
    for inp in inputs:
        h4 = list(inp.h4)
        busy_until = -1
        for i, c in enumerate(h4):
            at = c.close_time(Timeframe.H4)
            if at < start or at > end:
                continue
            if i <= busy_until:
                continue
            evaluated.append(at)
            res = script.evaluate(inp, at, StrategyParams())
            if isinstance(res, NoSignal) or res.deferred or not res.score.publishable:
                continue
            after = h4[i + 1 :]
            result = script.simulate(res.trade, after, None, None)
            exit_idx = result.exit_index
            exit_time = (
                h4[i + 1 + exit_idx].close_time(Timeframe.H4) if exit_idx is not None else None
            )
            trades.append((inp.symbol, at, result.status.value, exit_time))
            if exit_idx is not None:
                busy_until = i + 1 + exit_idx
            elif result.status is TradeStatus.OPEN:
                busy_until = len(h4)
    return evaluated, trades


def random_h4(rng: random.Random, n: int) -> list[Candle]:
    """Ряд H4 с редкими пропусками свечей (биржевые простои)."""
    out: list[Candle] = []
    t = T0
    for _ in range(n):
        if rng.random() < 0.05:
            t += H4 * rng.randint(1, 3)
        out.append(Candle(t, D(100), D(101), D(99), D(100), D(1)))
        t += H4
    return out


def test_run_backtest_matches_legacy_busy_until_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    rng = random.Random(6)
    for seed in range(400):
        script = Script(seed)
        monkeypatch.setattr(bt, "evaluate", script.evaluate)
        monkeypatch.setattr(bt, "simulate_trade", script.simulate)
        monkeypatch.setattr(bt, "SignalCandidate", FakeCandidate)
        inputs = [
            MarketInputs(symbol=f"S{k}USDT", h4=random_h4(rng, rng.randint(5, 120)))
            for k in range(rng.randint(1, 3))
        ]
        start = T0 + H4 * rng.randint(0, 10)
        end = T0 + H4 * rng.randint(20, 140)
        evaluated, trades = legacy_run(inputs, start, end, script)

        run = run_backtest(inputs, StrategyParams(), start, end, window=10)

        got = [(t.symbol, t.signal_time, t.result.status.value, t.exit_time) for t in run.trades]
        assert got == trades, seed
        assert run.evaluated == len(evaluated), seed
        in_window = sum(
            1 for inp in inputs for c in inp.h4 if start <= c.close_time(Timeframe.H4) <= end
        )
        assert run.evaluated + run.skipped["busy"] == in_window, seed
        assert sum(v["busy"] for v in run.skipped_by_symbol.values()) == run.skipped["busy"]


# --- 1m и H4 ------------------------------------------------------------------------------------


def test_minute_close_blocks_like_h4_exit_in_backtest() -> None:
    """Сделка, закрытая 1m-трекером в любую минуту свечи H4, занимает ровно те же закрытия H4,
    что и выход на этой свече в бэктесте (``exit_time`` = закрытие свечи H4)."""
    exit_candle_close = T0 + 5 * H4
    h4_exit = span("closed_sl", ended=exit_candle_close)
    for minute in range(1, 241):
        m1_exit = span("closed_sl", ended=exit_candle_close - H4 + minute * M1)
        for n in range(1, 9):
            at = T0 + n * H4
            assert occupies(m1_exit, at) == occupies(h4_exit, at), (minute, n)
