from __future__ import annotations

from dataclasses import fields, replace
from decimal import Decimal
from pathlib import Path

import pytest

from engine.params import StrategyParams
from engine.strategies import (
    MVP_SYMBOLS,
    STRATEGIES,
    TREND_OB_RETEST_1_0,
    TREND_OB_RETEST_1_1,
    TREND_OB_RETEST_1_2,
    TREND_OB_RETEST_1_2_1,
)

MVP_FILE = Path(__file__).resolve().parents[3] / "scripts" / "instruments_mvp.txt"


def test_versions_are_distinct_and_registered() -> None:
    assert set(STRATEGIES) == {
        "trend-ob-retest@1.0.0",
        "trend-ob-retest@1.1.0",
        "trend-ob-retest@1.2.0",
        "trend-ob-retest@1.2.1",
    }
    # 1.2 = 1.1 без лонгов, остальное не менялось
    assert not TREND_OB_RETEST_1_2.bias.allow_long and TREND_OB_RETEST_1_2.bias.allow_short
    assert TREND_OB_RETEST_1_2.trade == TREND_OB_RETEST_1_1.trade
    assert TREND_OB_RETEST_1_2.bias.require_w1_agreement
    assert TREND_OB_RETEST_1_0.trade.min_rr == Decimal("1.8")
    assert TREND_OB_RETEST_1_1.trade.min_rr == Decimal("2.5")
    assert TREND_OB_RETEST_1_1.bias.require_w1_agreement
    assert not TREND_OB_RETEST_1_0.bias.require_w1_agreement
    # цели TP2 в 1.1 выбираются так же, как в 1.0 (менялся только порог R:R)
    assert TREND_OB_RETEST_1_1.trade.tp2_min_r == TREND_OB_RETEST_1_0.trade.tp2_min_r


def test_1_2_1_is_1_2_0_on_the_mvp_pairs() -> None:
    """1.2.1 = правила 1.2.0 + список 20 пар MVP; сама 1.2.0 не меняется (задача 11)."""
    a, b = TREND_OB_RETEST_1_2, TREND_OB_RETEST_1_2_1
    same = {f.name for f in fields(StrategyParams)} - {"version", "symbols"}
    assert all(getattr(a, name) == getattr(b, name) for name in same)
    assert a.symbols is None and b.symbols == MVP_SYMBOLS
    assert b == replace(a, version="trend-ob-retest@1.2.1", symbols=MVP_SYMBOLS)
    assert all(p.symbols is None for p in (TREND_OB_RETEST_1_0, TREND_OB_RETEST_1_1, a))


def test_mvp_symbols_match_the_scripts_list() -> None:
    listed = [
        line.strip()
        for line in MVP_FILE.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert list(MVP_SYMBOLS) == listed and len(MVP_SYMBOLS) == 20


def test_symbol_list_rules() -> None:
    assert StrategyParams().covers("ANYUSDT")  # без списка — все инструменты
    p = StrategyParams(symbols=("BTCUSDT", "ETHUSDT"))
    assert p.covers("BTCUSDT") and not p.covers("SOLUSDT")
    for bad in ((), ("BTCUSDT", "BTCUSDT"), ("btcusdt",), (" BTCUSDT",), ("",)):
        with pytest.raises(ValueError, match="symbols"):
            StrategyParams(symbols=bad)
