"""Свечные паттерны: детерминированные правила по закрытым свечам (план 2A.10.1, 2B.10).

Паттерны не являются сигналами (план 2A.10.5). Версия правил — ``PatternParams.rules_version``.
"""

from engine.patterns.detect import detect_last, detect_patterns
from engine.patterns.outcomes import PatternOutcome, outcome, outcome_from, outcomes
from engine.patterns.params import DEFAULT_PATTERN_PARAMS, PatternParams
from engine.patterns.types import PatternContext, PatternMatch, PatternType, title

__all__ = [
    "DEFAULT_PATTERN_PARAMS",
    "PatternContext",
    "PatternMatch",
    "PatternOutcome",
    "PatternParams",
    "PatternType",
    "detect_last",
    "detect_patterns",
    "outcome",
    "outcome_from",
    "outcomes",
    "title",
]
