"""Именованные версии стратегии (план 2.9). Новая версия = новый объект, старые не меняются.

Содержимое версии дублируется в ``strategy_versions.params`` при выпуске; здесь — источник
правды для кода и бэктестов.
"""

from __future__ import annotations

from decimal import Decimal

from engine.params import BiasParams, StrategyParams, TradeParams

TREND_OB_RETEST_1_0 = StrategyParams(version="trend-ob-retest@1.0.0")
"""Базовые правила плана как есть. Бэктест №1 (2022-06 — 2026-10, 20 пар): PF 0.90, 608 сделок."""

TREND_OB_RETEST_1_1 = StrategyParams(
    version="trend-ob-retest@1.1.0",
    bias=BiasParams(require_w1_agreement=True),
    trade=TradeParams(min_rr=Decimal("2.5")),
)
"""Кандидат после walk-forward (docs/backtests/2026-10-25-walk-forward.md):
W1 обязан совпадать с направлением (флэт не допускается), сделки с R:R < 2.5 отклоняются,
выбор целей TP2 не менялся. In-sample PF 1.92 (69 сделок), out-of-sample PF 1.46 (42)."""

TREND_OB_RETEST_1_2 = StrategyParams(
    version="trend-ob-retest@1.2.0",
    bias=BiasParams(require_w1_agreement=True, allow_long=False),
    trade=TradeParams(min_rr=Decimal("2.5")),
)
"""Кандидат «только шорты» (docs/backtests/2026-10-25-longs.md): правила 1.1, лонги отключены.
Пост-фактум по прогонам #4/#5 лонги убыточны на обоих списках и на IS/OOS. Не выпущена —
решение за заказчиком (план 10.4)."""

STRATEGIES: dict[str, StrategyParams] = {
    p.version: p for p in (TREND_OB_RETEST_1_0, TREND_OB_RETEST_1_1, TREND_OB_RETEST_1_2)
}
