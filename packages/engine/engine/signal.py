"""Сборка сигнала (план 2.6, 2.8; задача 1.8).

``evaluate(inputs, at, params)`` — единственная точка входа для live, forward и backtest.
На вход — сырые ряды (могут содержать будущее относительно ``at``); функция сама обрезает
всё до ``at`` через ``closed_only``/``upto``, поэтому результат зависит только от данных,
известных на закрытии сигнальной свечи. ``replay`` — тот же вызов; воспроизводимость
проверяется тестом «полный ряд против усечённого».

Порядок:
1. bias D1/W1 — при ``neutral`` сигнала нет;
2. структура H4, зоны, ликвидность;
3. триггер: последняя свеча впервые коснулась активной зоны по направлению, рождённой BOS,
   и закрылась внутри зоны или дальше по направлению;
4. фильтры — блок / отложить / бонусы и штрафы;
5. параметры сделки — вход, стоп, тейки, R:R;
6. скоринг и градация;
7. ``input_hash`` по последним ``hash_candles`` свечам H4 и версии параметров.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from engine.bias import Bias, BiasContext, context_at
from engine.candles import Candle, Timeframe, closed_only
from engine.derivatives import (
    CalendarEvent,
    FundingRate,
    LiquidationBucket,
    LongShortRatio,
    OpenInterest,
    TokenEvent,
)
from engine.filters import (
    ActiveSignalRef,
    FilterSummary,
    atr_regime,
    correlation_filter,
    fresh_choch,
    funding_filter,
    liquidation_filter,
    long_short_filter,
    news_filter,
    open_interest_filter,
    run_filters,
    session_filter,
    token_events_filter,
    turnover_filter,
    volume_filter,
)
from engine.indicators import atr
from engine.liquidity import find_equal_levels, find_sweeps, period_levels
from engine.params import StrategyParams
from engine.scoring import ScoreBreakdown, ScoreInput, score_signal
from engine.structure import Direction, EventType, MarketStructure, SwingKind, analyze_structure
from engine.trade import TradeRejection, TradeSetup, build_trade
from engine.zones import Zone, ZoneKind, ZoneStatus, analyze_zones

ZONE_PRIORITY = {ZoneKind.OB: 0, ZoneKind.SD: 1, ZoneKind.FVG: 2}


@dataclass(frozen=True, slots=True)
class MarketInputs:
    symbol: str
    h4: Sequence[Candle]
    d1: Sequence[Candle] = ()
    w1: Sequence[Candle] = ()
    funding: Sequence[FundingRate] = ()
    open_interest: Sequence[OpenInterest] = ()
    liquidations: Sequence[LiquidationBucket] = ()
    long_short: Sequence[LongShortRatio] = ()
    calendar: Sequence[CalendarEvent] = ()
    token_events: Sequence[TokenEvent] = ()
    active_signals: Sequence[ActiveSignalRef] = ()
    btc_bias_direction: Direction | None = None
    avg_daily_turnover: Decimal | None = None


@dataclass(frozen=True, slots=True)
class SignalCandidate:
    symbol: str
    direction: Direction
    candle_close_time: datetime
    strategy_version: str
    zone: Zone
    zone_kinds: frozenset[ZoneKind]
    trade: TradeSetup
    score: ScoreBreakdown
    filters: FilterSummary
    bias: BiasContext
    input_hash: str
    facts: tuple[str, ...]
    deferred: bool = False

    @property
    def publishable(self) -> bool:
        return self.score.publishable and not self.deferred


@dataclass(frozen=True, slots=True)
class NoSignal:
    stage: str
    reason: str
    facts: tuple[str, ...] = field(default_factory=tuple)


def input_hash(candles: Sequence[Candle], version: str, n: int) -> str:
    h = hashlib.sha256()
    h.update(version.encode())
    for c in candles[-n:]:
        h.update(
            f"{c.open_time.isoformat()}|{c.open}|{c.high}|{c.low}|{c.close}|{c.volume}\n".encode()
        )
    return h.hexdigest()


def _bos_for_zone(structure: MarketStructure, zone: Zone) -> int | None:
    """Индекс BOS-события, породившего зону (CHoCH-зоны для входа не используются)."""
    for e in structure.events:
        if e.index == zone.event_index and e.direction is zone.direction:
            return e.index if e.type is EventType.BOS else None
    return None


def _triggered_zones(
    h4: Sequence[Candle], structure: MarketStructure, zones: Sequence[Zone], direction: Direction
) -> list[Zone]:
    i = len(h4) - 1
    c = h4[i]
    out: list[Zone] = []
    for z in zones:
        if z.direction is not direction or z.status is ZoneStatus.INVALIDATED:
            continue
        if z.touched_index != i or _bos_for_zone(structure, z) is None:
            continue
        inside_or_beyond = c.close >= z.bottom if direction is Direction.UP else c.close <= z.top
        if inside_or_beyond:
            out.append(z)
    return sorted(out, key=lambda z: ZONE_PRIORITY[z.kind])


def evaluate(
    inputs: MarketInputs, at: datetime, params: StrategyParams
) -> SignalCandidate | NoSignal:
    h4 = closed_only(inputs.h4, Timeframe.H4, at)
    if len(h4) < params.min_h4_history:
        return NoSignal("data", f"мало истории H4: {len(h4)} < {params.min_h4_history}")
    signal_candle = h4[-1]
    if signal_candle.close_time(Timeframe.H4) != at:
        return NoSignal("data", "момент расчёта не совпадает с закрытием свечи H4")

    bias = context_at(at, inputs.d1, inputs.w1, params.bias, params.structure)
    if bias.bias is Bias.NEUTRAL:
        return NoSignal("bias", "bias D1/W1 нейтральный", bias.reasons)
    direction = Direction.UP if bias.bias is Bias.LONG else Direction.DOWN

    structure = analyze_structure(h4, params.structure)
    zones = analyze_zones(h4, structure, params.zones)
    triggered = _triggered_zones(h4, structure, zones, direction)
    if not triggered:
        return NoSignal(
            "trigger", "нет первого ретеста активной BOS-зоны по направлению", bias.reasons
        )
    zone = triggered[0]
    zone_kinds = frozenset(z.kind for z in triggered if z.overlaps(zone))
    bos_index = zone.event_index
    bos_event = next(e for e in structure.events if e.index == bos_index)
    i = len(h4) - 1

    atr_values = atr(h4, params.filters.atr_period)
    atr_now = atr_values[-1]
    atr_bos = atr_values[bos_index]
    if atr_now is None or atr_bos is None or atr_now == 0:
        return NoSignal("data", "ATR не рассчитан")

    leg_start = bos_event.origin_swing.index if bos_event.origin_swing else max(0, bos_index - 10)
    vol = volume_filter(h4, bos_index, params.filters)
    results = [
        atr_regime(h4, params.filters),
        vol,
        session_filter(h4, i, params.filters),
        fresh_choch(structure, direction, i, params.filters),
        news_filter(inputs.calendar, at, params.filters),
        correlation_filter(
            inputs.symbol,
            direction,
            inputs.active_signals,
            inputs.btc_bias_direction,
            params.filters,
        ),
        turnover_filter(inputs.avg_daily_turnover, params.filters),
        funding_filter(inputs.funding, at, direction, params.filters),
        open_interest_filter(
            inputs.open_interest, h4, leg_start, bos_index, direction, params.filters
        ),
        liquidation_filter(inputs.liquidations, at, direction, params.filters),
        long_short_filter(inputs.long_short, at, direction, params.filters),
        token_events_filter(inputs.token_events, at, direction, params.filters),
    ]
    summary = run_filters(results)
    facts = [*bias.reasons, *(r.reason for r in results)]
    if summary.blocked:
        return NoSignal("filters", "; ".join(summary.block_reasons), tuple(facts))

    # цели: swing-экстремумы по направлению, PDH/PDL/PWH/PWL, равные уровни
    levels = period_levels(
        at, closed_only(inputs.d1, Timeframe.D1, at), closed_only(inputs.w1, Timeframe.W1, at)
    )
    equal = find_equal_levels(structure.swings, h4, params.liquidity, atr_values)
    target_kind = SwingKind.HIGH if direction is Direction.UP else SwingKind.LOW
    targets: list[Decimal] = [s.price for s in structure.swings if s.kind is target_kind]
    targets += [lv.price for lv in equal if lv.kind is target_kind and lv.swept_index is None]
    period = (levels.pdh, levels.pwh) if direction is Direction.UP else (levels.pdl, levels.pwl)
    targets += [p for p in period if p is not None]

    trade = build_trade(direction, zone, signal_candle.close, atr_now, targets, params.trade)
    if isinstance(trade, TradeRejection):
        return NoSignal("trade", trade.reason, tuple(facts))

    sweep_kind = SwingKind.LOW if direction is Direction.UP else SwingKind.HIGH
    sweeps = find_sweeps(h4, structure.swings)
    sweep_recent = any(
        s.kind is sweep_kind and i - s.index <= params.scoring.sweep_lookback for s in sweeps
    )
    sign = 1 if direction is Direction.UP else -1
    obstacle = any(
        0 < (t - trade.entry_market) * sign < (trade.tp1 - trade.entry_market) * sign
        for t in targets
    )
    bos_strength = abs(h4[bos_index].close - bos_event.level) / atr_bos
    volume_ratio = Decimal(vol.data["ratio"]) if "ratio" in vol.data else None
    score = score_signal(
        ScoreInput(
            w1_trend=bias.w1_trend,
            signal_up=direction is Direction.UP,
            bos_strength_atr=bos_strength,
            zone_kinds=zone_kinds,
            sweep_before_entry=sweep_recent,
            volume_ratio=volume_ratio,
            rr_tp2=trade.rr_tp2,
            obstacle_before_tp1=obstacle,
            filter_delta=summary.score_delta,
        ),
        params.scoring,
    )

    facts += [
        f"H4: {bos_event.type.upper()} {bos_event.direction} {bos_event.time:%d.%m %H:%M} UTC, "
        f"закрытие на {bos_strength:.2f} ATR за уровнем {bos_event.level}",
        f"Зона: {'+'.join(sorted(k.upper() for k in zone_kinds))} {zone.bottom}–{zone.top}, "
        f"первый ретест на сигнальной свече",
        "Ликвидность: снятие перед входом"
        if sweep_recent
        else "Ликвидность: снятия перед входом нет",
        *trade.notes,
        f"Скоринг: {score.total} ({score.grade})",
    ]
    return SignalCandidate(
        symbol=inputs.symbol,
        direction=direction,
        candle_close_time=at,
        strategy_version=params.version,
        zone=zone,
        zone_kinds=zone_kinds,
        trade=trade,
        score=score,
        filters=summary,
        bias=bias,
        input_hash=input_hash(h4, params.version, params.hash_candles),
        facts=tuple(facts),
        deferred=summary.deferred,
    )


def replay(
    inputs: MarketInputs, at: datetime, params: StrategyParams
) -> SignalCandidate | NoSignal:
    """Воспроизведение сигнала по историческим данным — тот же код, что и live."""
    return evaluate(inputs, at, params)
