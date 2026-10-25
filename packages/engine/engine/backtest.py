"""Бэктест: исполнение сделок по свечам, метрики, разбивки (план 2.10–2.11; задача 1.9).

Исполнение (``simulate_trade``):
- рыночный вход по закрытию сигнальной свечи; лимитный — когда цена дошла до ``entry_limit``
  в пределах ``limit_expiry_candles`` свечей, иначе ``expired``;
- внутри одной свечи порядок неизвестен, поэтому правило консервативное: если задеты и
  стоп, и тейк — считается стоп; после TP1 стоп переносится в безубыток;
- TP1/TP2/TP3 закрывают доли ``split`` (40/40/20); ``time_stop_candles`` без TP1 — выход
  по закрытию свечи;
- комиссия и проскальзывание вычитаются в R: ``(2 × fee + slippage) × вход / риск``.

Исполнять можно по любым свечам после сигнальной (H4 или 1m — чем мельче, тем точнее).
Статистика (``summarize``) — по закрытым сделкам в хронологическом порядке.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from engine.candles import Candle, Timeframe
from engine.params import StrategyParams, TradeParams
from engine.scoring import Grade
from engine.signal import MarketInputs, SignalCandidate, evaluate
from engine.structure import Direction
from engine.trade import TradeSetup


class TradeStatus(StrEnum):
    EXPIRED = "expired"
    CLOSED_SL = "closed_sl"
    CLOSED_BE = "closed_be"
    CLOSED_TP3 = "closed_tp3"
    CLOSED_TIME = "closed_time"
    OPEN = "open"
    """Данные закончились до выхода (последние сделки бэктеста)."""


@dataclass(frozen=True, slots=True)
class ExecutionParams:
    fee_rate: Decimal = Decimal("0.0005")
    """Комиссия тейкера за сторону (0.05 %)."""
    slippage: Decimal = Decimal("0.0003")
    entry_type: str = "market"
    """market — по закрытию сигнальной свечи; limit — середина зоны."""


@dataclass(frozen=True, slots=True)
class TradeResult:
    status: TradeStatus
    realized_r: Decimal
    r_if_tp1_only: Decimal | None
    r_if_full_tp2: Decimal | None
    tp_hits: int
    """Сколько тейков достигнуто (0–3)."""
    entry_index: int | None
    exit_index: int | None
    max_favorable_r: Decimal
    max_adverse_r: Decimal
    cost_r: Decimal

    @property
    def closed(self) -> bool:
        return self.status not in (TradeStatus.OPEN, TradeStatus.EXPIRED)


DEFAULT_EXECUTION = ExecutionParams()


def simulate_trade(
    setup: TradeSetup,
    candles: Sequence[Candle],
    trade_params: TradeParams,
    exec_params: ExecutionParams = DEFAULT_EXECUTION,
) -> TradeResult:
    """``candles`` — свечи строго после сигнальной, по порядку."""
    up = setup.direction is Direction.UP
    sign = Decimal(1) if up else Decimal(-1)

    def hit_below(c: Candle, price: Decimal) -> bool:  # цена дошла «против» лонга / «за» шорт
        return c.low <= price if up else c.high >= price

    def hit_above(c: Candle, price: Decimal) -> bool:
        return c.high >= price if up else c.low <= price

    # --- вход -----------------------------------------------------------------
    entry_price = setup.entry_market
    entry_index: int | None = 0 if candles else None
    start = 0
    if exec_params.entry_type == "limit":
        entry_price = setup.entry_limit
        entry_index = None
        for i, c in enumerate(candles[: trade_params.limit_expiry_candles]):
            if hit_below(c, entry_price):
                entry_index = i
                start = i
                break
        if entry_index is None:
            return TradeResult(
                TradeStatus.EXPIRED,
                Decimal(0),
                None,
                None,
                0,
                None,
                None,
                Decimal(0),
                Decimal(0),
                Decimal(0),
            )
    if not candles:
        return TradeResult(
            TradeStatus.OPEN,
            Decimal(0),
            None,
            None,
            0,
            None,
            None,
            Decimal(0),
            Decimal(0),
            Decimal(0),
        )

    # риск считается от фактического входа, чтобы R был честным и для лимита
    risk = (entry_price - setup.stop_loss) * sign
    cost_r = (2 * exec_params.fee_rate + exec_params.slippage) * entry_price / risk

    def r_at(price: Decimal) -> Decimal:
        return (price - entry_price) * sign / risk

    tps = (setup.tp1, setup.tp2, setup.tp3)
    split = trade_params.split
    stop = setup.stop_loss
    realized = Decimal(0)
    remaining = Decimal(1)
    hits = 0
    mfe = Decimal(0)
    mae = Decimal(0)
    tp1_only: Decimal | None = None
    full_tp2: Decimal | None = None
    status = TradeStatus.OPEN
    exit_index: int | None = None

    for i in range(start, len(candles)):
        c = candles[i]
        mfe = max(mfe, r_at(c.high if up else c.low))
        mae = min(mae, r_at(c.low if up else c.high))
        # стоп приоритетнее тейка в одной свече
        if hit_below(c, stop):
            exit_r = r_at(stop)
            realized += remaining * exit_r
            if tp1_only is None:
                tp1_only = exit_r
            if full_tp2 is None:
                full_tp2 = exit_r
            status = (
                TradeStatus.CLOSED_BE
                if hits >= 1 and trade_params.be_after_tp1
                else TradeStatus.CLOSED_SL
            )
            exit_index = i
            break
        while hits < 3 and hit_above(c, tps[hits]):
            tp_r = r_at(tps[hits])
            realized += split[hits] * tp_r
            remaining -= split[hits]
            hits += 1
            if hits == 1:
                if trade_params.be_after_tp1:
                    stop = entry_price  # безубыток
                tp1_only = tp_r
            if hits == 2 and full_tp2 is None:
                full_tp2 = tp_r
        if hits == 3:
            status = TradeStatus.CLOSED_TP3
            exit_index = i
            break
        if hits == 0 and i - start + 1 >= trade_params.time_stop_candles:
            exit_r = r_at(c.close)
            realized += remaining * exit_r
            tp1_only = tp1_only if tp1_only is not None else exit_r
            full_tp2 = full_tp2 if full_tp2 is not None else exit_r
            status = TradeStatus.CLOSED_TIME
            exit_index = i
            break

    if status is TradeStatus.OPEN:
        return TradeResult(
            status, realized - cost_r, tp1_only, full_tp2, hits, entry_index, None, mfe, mae, cost_r
        )
    return TradeResult(
        status,
        realized - cost_r,
        None if tp1_only is None else tp1_only - cost_r,
        None if full_tp2 is None else full_tp2 - cost_r,
        hits,
        entry_index,
        exit_index,
        mfe,
        mae,
        cost_r,
    )


# --- прогон стратегии -----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class BacktestTrade:
    symbol: str
    direction: Direction
    signal_time: datetime
    grade: Grade
    score: int
    rr_tp2: Decimal
    entry: Decimal
    stop: Decimal
    tp1: Decimal
    tp2: Decimal
    tp3: Decimal
    result: TradeResult
    exit_time: datetime | None
    facts: tuple[str, ...] = ()

    @property
    def realized_r(self) -> Decimal:
        return self.result.realized_r


@dataclass(slots=True)
class BacktestRun:
    trades: list[BacktestTrade] = field(default_factory=list)
    skipped: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    """Причины отсутствия сигнала по этапам (data/bias/trigger/filters/trade) — для анализа."""
    skipped_by_symbol: dict[str, dict[str, int]] = field(
        default_factory=lambda: defaultdict(lambda: defaultdict(int))
    )
    block_reasons: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    """Какие фильтры блокировали (по имени из причины), чтобы видеть, что режет сигналы."""
    evaluated: int = 0


def run_backtest(
    inputs: Iterable[MarketInputs],
    params: StrategyParams,
    start: datetime,
    end: datetime,
    exec_params: ExecutionParams = DEFAULT_EXECUTION,
    window: int = 700,
    on_signal: Callable[[SignalCandidate], None] | None = None,
) -> BacktestRun:
    """Проходит все закрытия H4 в [start; end] по каждому инструменту.

    Одновременно по инструменту — не больше одной открытой сделки. Отложенные (новости)
    сигналы в бэктесте пропускаются и считаются в ``skipped['deferred']``.
    ``window`` — сколько последних свечей H4 передаётся в ``evaluate`` (экономия времени;
    должно быть ≥ ``params.min_h4_history`` и ``params.hash_candles``).
    """
    run = BacktestRun()
    for inp in inputs:
        h4 = list(inp.h4)
        busy_until = -1
        for i, c in enumerate(h4):
            at = c.close_time(Timeframe.H4)
            if at < start or at > end:
                continue
            if i <= busy_until:
                continue
            run.evaluated += 1
            sliced = MarketInputs(
                symbol=inp.symbol,
                h4=h4[max(0, i + 1 - window) : i + 1],
                d1=inp.d1,
                w1=inp.w1,
                funding=inp.funding,
                open_interest=inp.open_interest,
                liquidations=inp.liquidations,
                long_short=inp.long_short,
                calendar=inp.calendar,
                token_events=inp.token_events,
                active_signals=inp.active_signals,
                btc_bias_direction=inp.btc_bias_direction,
                avg_daily_turnover=inp.avg_daily_turnover,
            )
            res = evaluate(sliced, at, params)
            if not isinstance(res, SignalCandidate):
                run.skipped[res.stage] += 1
                run.skipped_by_symbol[inp.symbol][res.stage] += 1
                if res.stage in ("filters", "trade"):
                    for reason in res.reason.split("; "):
                        run.block_reasons[reason.split(":")[0][:60]] += 1
                continue
            if res.deferred:
                run.skipped["deferred"] += 1
                continue
            if not res.score.publishable:
                run.skipped["grade_none"] += 1
                continue
            if on_signal is not None:
                on_signal(res)
            after = h4[i + 1 :]
            result = simulate_trade(res.trade, after, params.trade, exec_params)
            exit_idx = result.exit_index
            exit_time = (
                h4[i + 1 + exit_idx].close_time(Timeframe.H4) if exit_idx is not None else None
            )
            run.trades.append(
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
    return run


# --- метрики ----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Metrics:
    signals: int
    closed: int
    expired: int
    open: int
    winrate: Decimal | None
    avg_r: Decimal | None
    profit_factor: Decimal | None
    expectancy: Decimal | None
    max_drawdown_r: Decimal
    max_losing_streak: int
    tp1_share: Decimal | None
    tp2_share: Decimal | None
    tp3_share: Decimal | None
    sum_r: Decimal
    avg_duration_hours: Decimal | None


def summarize(trades: Sequence[BacktestTrade]) -> Metrics:
    closed = sorted((t for t in trades if t.result.closed), key=lambda t: t.signal_time)
    expired = sum(1 for t in trades if t.result.status is TradeStatus.EXPIRED)
    open_ = sum(1 for t in trades if t.result.status is TradeStatus.OPEN)
    n = len(closed)
    rs = [t.realized_r for t in closed]
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r < 0]
    gross_win = sum(wins, Decimal(0))
    gross_loss = -sum(losses, Decimal(0))
    equity = Decimal(0)
    peak = Decimal(0)
    dd = Decimal(0)
    streak = worst_streak = 0
    for r in rs:
        equity += r
        peak = max(peak, equity)
        dd = max(dd, peak - equity)
        streak = streak + 1 if r < 0 else 0
        worst_streak = max(worst_streak, streak)
    durations = [
        Decimal((t.exit_time - t.signal_time).total_seconds()) / 3600
        for t in closed
        if t.exit_time is not None
    ]
    winrate = Decimal(len(wins)) / n if n else None
    avg_win = gross_win / len(wins) if wins else Decimal(0)
    avg_loss = gross_loss / len(losses) if losses else Decimal(0)
    return Metrics(
        signals=len(trades),
        closed=n,
        expired=expired,
        open=open_,
        winrate=winrate,
        avg_r=sum(rs, Decimal(0)) / n if n else None,
        profit_factor=(gross_win / gross_loss) if gross_loss else None,
        expectancy=(winrate * avg_win - (1 - winrate) * avg_loss) if winrate is not None else None,
        max_drawdown_r=dd,
        max_losing_streak=worst_streak,
        tp1_share=Decimal(sum(1 for t in closed if t.result.tp_hits >= 1)) / n if n else None,
        tp2_share=Decimal(sum(1 for t in closed if t.result.tp_hits >= 2)) / n if n else None,
        tp3_share=Decimal(sum(1 for t in closed if t.result.tp_hits >= 3)) / n if n else None,
        sum_r=sum(rs, Decimal(0)),
        avg_duration_hours=sum(durations, Decimal(0)) / len(durations) if durations else None,
    )


def breakdown(
    trades: Sequence[BacktestTrade], key: Callable[[BacktestTrade], str]
) -> dict[str, Metrics]:
    groups: dict[str, list[BacktestTrade]] = defaultdict(list)
    for t in trades:
        groups[key(t)].append(t)
    return {k: summarize(v) for k, v in sorted(groups.items())}


def equity_curve(trades: Sequence[BacktestTrade]) -> list[tuple[datetime, Decimal]]:
    closed = sorted((t for t in trades if t.result.closed), key=lambda t: t.signal_time)
    out: list[tuple[datetime, Decimal]] = []
    total = Decimal(0)
    for t in closed:
        total += t.realized_r
        out.append((t.exit_time or t.signal_time, total))
    return out
