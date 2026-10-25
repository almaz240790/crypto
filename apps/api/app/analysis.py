"""Разбор сигнала для карточки (план 3.5): структура, зоны, уровни на момент сигнальной свечи.

Считается теми же функциями движка и с теми же параметрами версии стратегии, что и сам сигнал,
по закрытым свечам до ``candle_close_time``. Ничего не сохраняется: это представление, а не
новые данные.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.forward import load_inputs
from app.models import Instrument, Signal, StrategyVersion
from engine.bias import context_at
from engine.candles import Timeframe, closed_only
from engine.indicators import atr
from engine.liquidity import find_equal_levels, find_sweeps, period_levels
from engine.params import StrategyParams
from engine.strategies import STRATEGIES
from engine.structure import analyze_structure
from engine.zones import analyze_zones


def params_for_version(version: str | None) -> StrategyParams:
    key = next((k for k in STRATEGIES if version and k.endswith("@" + version)), None)
    return STRATEGIES[key] if key else STRATEGIES["trend-ob-retest@1.0.0"]


def _dec(x: Decimal | None) -> str | None:
    return None if x is None else format(x.normalize(), "f")


def analyze_signal(
    session: Session, sig: Signal, inst: Instrument, window: int = 200
) -> dict[str, Any]:
    ver = session.get(StrategyVersion, sig.strategy_version_id)
    params = params_for_version(ver.version if ver else None)
    at: datetime = sig.candle_close_time
    inputs = load_inputs(session, inst, at)
    h4 = closed_only(inputs.h4, Timeframe.H4, at)
    d1 = closed_only(inputs.d1, Timeframe.D1, at)
    w1 = closed_only(inputs.w1, Timeframe.W1, at)
    structure = analyze_structure(h4, params.structure)
    zones = analyze_zones(h4, structure, params.zones)
    atr_values = atr(h4, params.filters.atr_period) if h4 else []
    equal = find_equal_levels(structure.swings, h4, params.liquidity, atr_values)
    sweeps = find_sweeps(h4, structure.swings)
    levels = period_levels(at, d1, w1)
    bias = context_at(at, d1, w1, params.bias, params.structure)
    start = max(0, len(h4) - window)

    def t(i: int) -> str:
        return h4[i].open_time.isoformat()

    return {
        "at": at.isoformat(),
        "strategy_version": ver.version if ver else None,
        "swings": [
            {"time": s.time.isoformat(), "price": _dec(s.price), "kind": s.kind.value}
            for s in structure.swings
            if s.index >= start
        ],
        "events": [
            {
                "time": e.time.isoformat(),
                "type": e.type.value,
                "direction": e.direction.value,
                "level": _dec(e.level),
                "from_time": e.broken_swing.time.isoformat(),
            }
            for e in structure.events
            if e.index >= start
        ],
        "zones": [
            {
                "kind": z.kind,
                "direction": z.direction.value,
                "top": _dec(z.top),
                "bottom": _dec(z.bottom),
                "from_time": t(z.created_index),
                "status": z.status,
            }
            for z in zones
            if z.created_index >= start
        ],
        "levels": {k: _dec(v) for k, v in asdict(levels).items()},
        "equal_levels": [
            {
                "kind": e.kind.value,
                "price": _dec(e.price),
                "from_time": t(min(e.swing_indices)),
                "to_time": t(e.swept_index) if e.swept_index is not None else None,
                "swept": e.swept_index is not None,
            }
            for e in equal
            if e.confirmed_index >= start
        ],
        "sweeps": [
            {"time": s.time.isoformat(), "kind": s.kind.value, "level": _dec(s.level)}
            for s in sweeps
            if s.index >= start
        ],
        "bias": {
            "bias": bias.bias.value,
            "d1_trend": bias.d1_trend.value,
            "w1_trend": bias.w1_trend.value,
            "ema50_d1": _dec(bias.ema),
        },
        "trade_params": {
            "split": [_dec(x) for x in params.trade.split],
            "be_after_tp1": params.trade.be_after_tp1,
            "limit_expiry_candles": params.trade.limit_expiry_candles,
            "time_stop_candles": params.trade.time_stop_candles,
        },
        "atr": _dec(atr_values[-1]) if atr_values and atr_values[-1] is not None else None,
        "candles_h4": len(h4),
    }
