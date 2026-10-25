"""Разбор сигнала для карточки: сериализация структуры/зон/уровней без БД."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from app import analysis
from app.models import Instrument, Signal, StrategyVersion
from engine.candles import Candle, Timeframe
from engine.signal import MarketInputs


def _zigzag(n: int, tf: Timeframe, start: datetime) -> list[Candle]:
    out = []
    for i in range(n):
        c = 100 + 10 * math.sin(i / 3) + i * 0.3
        o = c - 0.4
        out.append(
            Candle(
                open_time=start + tf.delta * i,
                open=Decimal(f"{o:.2f}"),
                high=Decimal(f"{max(o, c) + 0.8:.2f}"),
                low=Decimal(f"{min(o, c) - 0.8:.2f}"),
                close=Decimal(f"{c:.2f}"),
                volume=Decimal(10),
            )
        )
    return out


class FakeSession:
    def get(self, model: Any, _id: int) -> Any:
        assert model is StrategyVersion
        return StrategyVersion(id=1, strategy_id=1, version="1.1.0", params={}, status="forward")


def test_analyze_signal_serializes_structure(monkeypatch: Any) -> None:
    at = datetime(2026, 10, 1, tzinfo=UTC)
    h4 = _zigzag(300, Timeframe.H4, at - timedelta(hours=4 * 300))
    d1 = _zigzag(120, Timeframe.D1, at - timedelta(days=120))
    w1 = _zigzag(60, Timeframe.W1, at - timedelta(weeks=60))
    monkeypatch.setattr(
        analysis, "load_inputs", lambda s, inst, at: MarketInputs("BTCUSDT", h4, d1, w1)
    )
    sig = Signal(
        public_id="abc",
        strategy_version_id=1,
        instrument_id=1,
        direction="long",
        candle_close_time=at,
        status="active",
    )
    out = analysis.analyze_signal(FakeSession(), sig, Instrument(id=1, symbol="BTCUSDT"))  # type: ignore[arg-type]
    assert out["strategy_version"] == "1.1.0" and out["candles_h4"] == 300
    assert out["swings"] and {s["kind"] for s in out["swings"]} <= {"high", "low"}
    assert all(e["type"] in ("bos", "choch") and e["level"] for e in out["events"])
    assert out["levels"]["pdh"] is not None and out["levels"]["pwl"] is not None
    assert out["bias"]["d1_trend"] in ("up", "down", "flat")
    assert out["trade_params"]["split"] == ["0.4", "0.4", "0.2"]
    assert out["atr"] is not None


def test_params_for_version_fallback() -> None:
    assert analysis.params_for_version("1.1.0") is not analysis.params_for_version(None)
    assert analysis.params_for_version("9.9.9") is analysis.params_for_version(None)
