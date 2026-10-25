from __future__ import annotations

from decimal import Decimal

from engine.strategies import STRATEGIES, TREND_OB_RETEST_1_0, TREND_OB_RETEST_1_1


def test_versions_are_distinct_and_registered() -> None:
    assert set(STRATEGIES) == {"trend-ob-retest@1.0.0", "trend-ob-retest@1.1.0"}
    assert TREND_OB_RETEST_1_0.trade.min_rr == Decimal("1.8")
    assert TREND_OB_RETEST_1_1.trade.min_rr == Decimal("2.5")
    assert TREND_OB_RETEST_1_1.bias.require_w1_agreement
    assert not TREND_OB_RETEST_1_0.bias.require_w1_agreement
    # цели TP2 в 1.1 выбираются так же, как в 1.0 (менялся только порог R:R)
    assert TREND_OB_RETEST_1_1.trade.tp2_min_r == TREND_OB_RETEST_1_0.trade.tp2_min_r
