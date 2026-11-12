from __future__ import annotations

import random
from collections import Counter
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

import engine.backtest as backtest
from engine.backtest import (
    BacktestTrade,
    ExecutionParams,
    TradeResult,
    TradeStatus,
    breakdown,
    equity_curve,
    run_backtest,
    signal_status,
    simulate_trade,
    summarize,
)
from engine.bias import Bias, BiasContext
from engine.candles import Candle, Timeframe
from engine.filters import FilterSummary
from engine.lifecycle import SignalLife, SignalStatus
from engine.params import FilterParams, StrategyParams, TradeParams
from engine.scoring import Grade, ScoreBreakdown
from engine.signal import MarketInputs, NoSignal, SignalCandidate
from engine.structure import Direction, Trend
from engine.trade import TradeSetup
from engine.zones import Zone, ZoneKind
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


# --- эталон: список сделок бэктеста не меняется (задача 3: комиссии в трекере) -----------------


def trade_list_digest() -> str:
    """sha256 списка сделок на фикстуре: синтетический сетап ``run_backtest`` и 200 случайных
    путей H4 через ``simulate_trade`` (лонг/шорт, рыночный/лимитный вход) — всё с комиссиями
    ``DEFAULT_EXECUTION``. Любая правка исполнения или формулы ``cost_r`` меняет хэш."""
    import hashlib
    import random

    from engine.backtest import DEFAULT_EXECUTION
    from tests.test_tracker import SHORT, random_path

    lines: list[str] = []
    params = StrategyParams(filters=FilterParams(atr_min_history=10**6))
    after = [
        (99.5, 104, 99, 103),
        (103, 106, 102, 105.5),
        (105.5, 111, 105, 110),
        (110, 112, 109, 111),
    ]
    start = T0 + H4 * (len(FLAT) + len(SETUP) - 3)
    end = T0 + H4 * (len(FLAT) + len(SETUP) + len(after))
    run = run_backtest([inputs(after)], params, start, end, DEFAULT_EXECUTION)
    results = [(t.symbol, t.signal_time.isoformat(), t.result) for t in run.trades]
    rng = random.Random(2026)
    for trial in range(200):
        setup = LONG if trial % 2 == 0 else SHORT
        entry_type = "limit" if trial % 5 == 0 else "market"
        path = random_path(rng, rng.randint(1, 30))
        r = simulate_trade(setup, path, TP, ExecutionParams(entry_type=entry_type))
        results.append((entry_type, str(trial), r))
    for a, b, r in results:
        lines.append(
            f"{a}|{b}|{r.status}|{r.realized_r}|{r.r_if_tp1_only}|{r.r_if_full_tp2}|{r.tp_hits}|"
            f"{r.entry_index}|{r.exit_index}|{r.max_favorable_r}|{r.max_adverse_r}|{r.cost_r}"
        )
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def test_trade_list_digest_is_unchanged() -> None:
    """Эталон посчитан до выноса формулы cost_r в ``execution_cost_r``: на 55402f6 и на
    origin/main a91eab4 (после задач 1, 2, 4, 5) — хэш совпал."""
    assert trade_list_digest() == "7704a4aba7394b7cd1e40e78fce4ccc3f51ec39a79755fec20ffee1c20b076cc"


# --- одна открытая сделка на инструмент: общее правило движка (задача 6) -----------------------


def test_signal_status_of_trade_result() -> None:
    def res(status: TradeStatus, hits: int) -> TradeResult:
        return TradeResult(status, D(0), None, None, hits, 0, None, D(0), D(0), D(0))

    assert signal_status(res(TradeStatus.OPEN, 0)) is SignalStatus.ACTIVE
    assert signal_status(res(TradeStatus.OPEN, 1)) is SignalStatus.TP1_HIT
    assert signal_status(res(TradeStatus.OPEN, 2)) is SignalStatus.TP2_HIT
    assert signal_status(res(TradeStatus.EXPIRED, 0)) is SignalStatus.EXPIRED
    for closed in (
        TradeStatus.CLOSED_SL,
        TradeStatus.CLOSED_BE,
        TradeStatus.CLOSED_TP3,
        TradeStatus.CLOSED_TIME,
    ):
        status = signal_status(res(closed, 1))
        assert status.is_closed and status.value == closed.value
    # у каждого исхода сделки есть статус сигнала
    assert all(isinstance(signal_status(res(s, 0)), SignalStatus) for s in TradeStatus)


def test_busy_candles_are_counted_on_synthetic_setup() -> None:
    """Свечи, пока сделка открыта, и свеча её выхода не оцениваются и считаются в
    ``skipped['busy']``; ``evaluated`` — только свечи, на которых вызван ``evaluate``."""
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
    run = run_backtest([inp], params, start, end, NO_COST)
    (t,) = run.trades
    assert t.exit_time is not None
    in_range = [c for c in inp.h4 if start <= c.close_time(Timeframe.H4) <= end]
    # заняты свечи после сигнальной по свечу выхода включительно
    busy = [c for c in in_range if t.signal_time < c.close_time(Timeframe.H4) <= t.exit_time]
    assert len(busy) >= 1
    assert run.skipped["busy"] == len(busy)
    assert run.skipped_by_symbol["BTCUSDT"]["busy"] == len(busy)
    assert run.evaluated == len(in_range) - len(busy)
    # каждая оценённая свеча — либо сделка, либо пропуск на одном из этапов ``evaluate``
    assert sum(run.skipped.values()) - run.skipped["busy"] + len(run.trades) == run.evaluated


def test_backtest_rejects_repeated_or_unsorted_candles() -> None:
    """Правило одной сделки считает по времени: на ряду с повтором свечи или не по порядку ответ
    был бы другим, чем у прежнего счёта по номеру свечи, — такой ряд отклоняется сразу и с
    понятным сообщением про ряд (а не про сигнал где-то в середине прогона)."""
    params = StrategyParams(filters=FilterParams(atr_min_history=10**6))
    inp = inputs([(99.5, 104, 99, 103)])
    h4 = list(inp.h4)
    start, end = T0, T0 + H4 * (len(h4) + 1)
    repeated = replace(inp, h4=(*h4[:5], h4[4], *h4[5:]))
    with pytest.raises(ValueError, match="BTCUSDT: свечи H4 должны идти по возрастанию"):
        run_backtest([repeated], params, start, end, NO_COST)
    unsorted = replace(inp, h4=(*h4[:5], h4[6], h4[5], *h4[7:]))
    with pytest.raises(ValueError, match="по возрастанию open_time без повторов"):
        run_backtest([unsorted], params, start, end, NO_COST)
    # пропуск в сетке H4 — допустимый ряд
    gapped = replace(inp, h4=(*h4[:5], *h4[6:]))
    run_backtest([gapped], params, start, end, NO_COST)


def _walk(seed: int, n: int, drop: frozenset[int] = frozenset()) -> list[Candle]:
    """Случайный ряд H4 с шагом цены до 2 %; ``drop`` — номера свечей, которых в ряду нет."""
    rng = random.Random(seed)
    out = []
    price = 100.0
    for i in range(n):
        o = price
        cl = o * (1 + rng.uniform(-0.02, 0.02))
        h = max(o, cl) * (1 + rng.uniform(0, 0.012))
        lo = min(o, cl) * (1 - rng.uniform(0, 0.012))
        price = cl
        if i not in drop:
            ohlc = (D(f"{x:.4f}") for x in (o, h, lo, cl))
            out.append(Candle(T0 + H4 * i, *ohlc, D(1)))
    return out


def _fake_evaluate(
    inp: MarketInputs, at: datetime, params: StrategyParams
) -> SignalCandidate | NoSignal:
    """Вместо ``evaluate``: кандидат почти на каждой свече — правило занятости работает на
    пределе. Часть свечей — без сигнала, часть кандидатов отложена или ниже порога публикации.
    Решение зависит только от сигнальной свечи (последней во входе)."""
    c = inp.h4[-1]
    assert c.close_time(Timeframe.H4) == at
    kind = int(c.close * 10_000) % 10
    if kind == 0:
        return NoSignal("trigger", "нет ретеста")
    if kind == 5:
        return NoSignal("filters", "ATR: вне режима; объём: ниже среднего")
    up = kind % 2 == 0
    direction = Direction.UP if up else Direction.DOWN
    sign = 1 if up else -1
    risk = c.close * D("0.03")
    trade = TradeSetup(
        direction,
        c.close,
        c.close - sign * risk / 2,
        c.close - sign * risk,
        c.close + sign * risk,
        c.close + sign * risk * D("2.3"),
        c.close + sign * risk * 4,
        risk,
        D("2.3"),
        (),
    )
    return SignalCandidate(
        symbol=inp.symbol,
        direction=direction,
        candle_close_time=at,
        strategy_version=params.version,
        zone=Zone(ZoneKind.OB, direction, c.high, c.low, 0, 0, 0, 0),
        zone_kinds=frozenset({ZoneKind.OB}),
        trade=trade,
        score=ScoreBreakdown({}, 70, Grade.NONE if kind == 1 else Grade.B),
        filters=FilterSummary(()),
        bias=BiasContext(Bias.LONG, Trend.UP, Trend.UP, None, None, None, ()),
        input_hash="",
        facts=(),
        deferred=kind == 3,
    )


def _reference_run(
    all_inputs: list[MarketInputs],
    params: StrategyParams,
    start: datetime,
    end: datetime,
    exec_params: ExecutionParams,
) -> tuple[list[BacktestTrade], int, dict[str, int], int]:
    """Цикл ``run_backtest`` до задачи 6, дословно: занятость по номеру свечи
    (``i <= busy_until``). Возвращает сделки, число оценённых свечей, пропуски по этапам и
    число занятых свечей в периоде."""
    trades = []
    skipped: Counter[str] = Counter()
    evaluated = busy = 0
    for inp in all_inputs:
        h4 = list(inp.h4)
        busy_until = -1
        for i, c in enumerate(h4):
            at = c.close_time(Timeframe.H4)
            if at < start or at > end:
                continue
            if i <= busy_until:
                busy += 1
                continue
            evaluated += 1
            res = _fake_evaluate(replace(inp, h4=h4[: i + 1]), at, params)
            if not isinstance(res, SignalCandidate):
                skipped[res.stage] += 1
                continue
            if res.deferred:
                skipped["deferred"] += 1
                continue
            if not res.score.publishable:
                skipped["grade_none"] += 1
                continue
            result = simulate_trade(res.trade, h4[i + 1 :], params.trade, exec_params)
            exit_idx = result.exit_index
            exit_time = (
                h4[i + 1 + exit_idx].close_time(Timeframe.H4) if exit_idx is not None else None
            )
            trades.append(
                BacktestTrade(
                    symbol=inp.symbol,
                    direction=res.direction,
                    signal_time=at,
                    grade=res.score.grade,
                    score=res.score.total,
                    rr_tp2=res.trade.rr_tp2,
                    entry=res.trade.entry_market,
                    stop=res.trade.stop_loss,
                    tp1=res.trade.tp1,
                    tp2=res.trade.tp2,
                    tp3=res.trade.tp3,
                    result=result,
                    exit_time=exit_time,
                    facts=res.facts,
                )
            )
            if exit_idx is not None:
                busy_until = i + 1 + exit_idx
            elif result.status is TradeStatus.OPEN:
                busy_until = len(h4)
    return trades, evaluated, dict(skipped), busy


def _two_instruments() -> list[MarketInputs]:
    return [
        MarketInputs(symbol="AAAUSDT", h4=_walk(1, 900)),
        # ряд с пропусками свечей: правило считает по времени, а не по номеру свечи
        MarketInputs(symbol="BBBUSDT", h4=_walk(2, 900, drop=frozenset({200, 201, 455, 700}))),
    ]


def test_trades_are_bit_for_bit_the_same_as_with_the_candle_index_rule(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Критерий «бэктест не меняется»: при кандидате почти на каждой свече (сделки идут одна за
    другой, все исходы, рыночный и лимитный вход, ряд с пропусками, незакрытая сделка в конце
    данных) список сделок и счётчики совпадают с прежним циклом; занятые свечи теперь посчитаны.
    Хэш-эталон ``test_trade_list_digest_is_unchanged`` эту замену не ловит: в нём одна сделка
    ``run_backtest``, а занятость на исход не влияет."""
    monkeypatch.setattr(backtest, "evaluate", _fake_evaluate)
    params = StrategyParams()
    start, end = T0 + H4 * 10, T0 + H4 * 880
    seen = set()
    for entry_type in ("market", "limit"):
        exec_params = ExecutionParams(entry_type=entry_type)
        run = run_backtest(_two_instruments(), params, start, end, exec_params)
        trades, evaluated, skipped, busy = _reference_run(
            _two_instruments(), params, start, end, exec_params
        )
        assert run.trades == trades
        assert run.evaluated == evaluated
        assert busy > 100 and run.skipped.pop("busy") == busy
        assert dict(run.skipped) == skipped
        assert run.block_reasons == {"ATR": skipped["filters"], "объём": skipped["filters"]}
        assert sum(v["busy"] for v in run.skipped_by_symbol.values()) == busy
        assert len(trades) > 50
        seen |= {t.result.status for t in trades}
    # проверены все исходы, в том числе истёкший лимит (не занимает инструмент) и сделка,
    # не закрытая к концу данных
    assert seen == set(TradeStatus)

    # данные кончаются раньше выхода: незакрытая сделка занимает инструмент до конца ряда
    calm = [c(100, 100.5, 99.5, 100.0002, i) for i in range(40)]  # кандидат на каждой свече
    one = [MarketInputs(symbol="CCCUSDT", h4=calm)]
    params = StrategyParams(trade=TradeParams(time_stop_candles=100))
    run = run_backtest(one, params, T0, T0 + H4 * 100, NO_COST)
    trades, evaluated, skipped, busy = _reference_run(one, params, T0, T0 + H4 * 100, NO_COST)
    assert run.trades == trades and [t.result.status for t in trades] == [TradeStatus.OPEN]
    assert (run.evaluated, run.skipped["busy"]) == (evaluated, busy) == (1, 39)


def test_on_busy_reports_suppressed_candidates_without_changing_the_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``on_busy`` (для отчёта владельцу): на занятой свече кандидат всё же вычисляется и, если
    стал бы сделкой, отдаётся вместе с мешающим сигналом. Сделки и счётчики те же, что без него."""
    monkeypatch.setattr(backtest, "evaluate", _fake_evaluate)
    params = StrategyParams()
    start, end = T0 + H4 * 10, T0 + H4 * 880
    plain = run_backtest(_two_instruments(), params, start, end)
    suppressed: list[tuple[SignalCandidate, SignalLife]] = []
    published: list[SignalCandidate] = []
    run = run_backtest(
        _two_instruments(),
        params,
        start,
        end,
        on_signal=published.append,
        on_busy=lambda cand, blocker: suppressed.append((cand, blocker)),
    )
    assert run.trades == plain.trades and run.evaluated == plain.evaluated
    assert run.skipped == plain.skipped and run.skipped_by_symbol == plain.skipped_by_symbol
    assert len(published) == len(run.trades)

    trades = {(t.symbol, t.signal_time): t for t in run.trades}
    # не на каждой занятой свече есть кандидат; отложенные и ниже порога — не подавленные сигналы
    assert 0 < len(suppressed) < run.skipped["busy"]
    for cand, blocker in suppressed:
        assert cand.publishable
        blocking_trade = trades[(cand.symbol, blocker.opened_at)]  # мешает сделка этого прогона
        assert blocking_trade.signal_time < cand.candle_close_time
        if blocking_trade.exit_time is not None:  # None — сделка не закрыта к концу данных
            assert cand.candle_close_time <= blocking_trade.exit_time
        assert (cand.symbol, cand.candle_close_time) not in trades  # сам сделкой не стал
