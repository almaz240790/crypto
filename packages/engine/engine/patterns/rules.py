"""Правила свечных паттернов — чистые функции над закрытыми свечами (план 2A.10.1).

Обозначения: body = |close − open|, range = high − low, upper/lower — тени,
avg_body — среднее тело за окно до паттерна, atr — ATR(14) на последней свече паттерна.
Бычий вариант описан в плане, медвежий — зеркально.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from engine.candles import Candle
from engine.patterns.params import PatternParams
from engine.patterns.types import PatternType
from engine.structure import Direction


@dataclass(frozen=True, slots=True)
class Measures:
    avg_body: Decimal
    atr: Decimal


def upper_shadow(c: Candle) -> Decimal:
    return c.high - max(c.open, c.close)


def lower_shadow(c: Candle) -> Decimal:
    return min(c.open, c.close) - c.low


def _mid(c: Candle) -> Decimal:
    return (c.open + c.close) / 2


def engulfing(c1: Candle, c2: Candle, m: Measures, p: PatternParams) -> Direction | None:
    """Свеча 2 поглощает тело свечи 1 противоположного цвета; тело 2 ≥ k × avg_body."""
    if c2.body < p.engulf_body * m.avg_body:
        return None
    if c2.is_bullish and not c1.is_bullish and c2.open <= c1.close and c2.close >= c1.open:
        return Direction.UP
    if not c2.is_bullish and c1.is_bullish and c2.open >= c1.close and c2.close <= c1.open:
        return Direction.DOWN
    return None


def pin_bar(c: Candle, p: PatternParams) -> Direction | None:
    """Молот: длинный нижний хвост, короткий нос, закрытие в верхней части; звезда — зеркально."""
    if c.range <= 0 or c.body < p.pin_body_range * c.range:
        return None
    up, lo = upper_shadow(c), lower_shadow(c)
    part = c.range / p.pin_close_part
    if (
        lo >= p.pin_tail_body * c.body
        and up <= p.pin_nose_range * c.range
        and c.close >= c.high - part
    ):
        return Direction.UP
    if (
        up >= p.pin_tail_body * c.body
        and lo <= p.pin_nose_range * c.range
        and c.close <= c.low + part
    ):
        return Direction.DOWN
    return None


def doji(c: Candle, m: Measures, p: PatternParams) -> PatternType | None:
    """Доджи: тело ≤ доля диапазона, диапазон ≥ доля ATR; короткая тень — стрекоза/надгробие."""
    if c.range <= 0 or c.body > p.doji_body_range * c.range:
        return None
    if c.range < p.doji_range_atr * m.atr:
        return None
    if upper_shadow(c) <= p.doji_tail_range * c.range:
        return PatternType.DOJI_DRAGONFLY
    if lower_shadow(c) <= p.doji_tail_range * c.range:
        return PatternType.DOJI_GRAVESTONE
    return PatternType.DOJI


def star(c1: Candle, c2: Candle, c3: Candle, m: Measures, p: PatternParams) -> Direction | None:
    """Утренняя звезда: большая медвежья, маленькая, бычья с закрытием выше середины первой."""
    if c1.body < p.star_big_body * m.avg_body or c2.body > p.star_small_body * m.avg_body:
        return None
    if not c1.is_bullish and c3.is_bullish and c3.close > _mid(c1):
        return Direction.UP
    if c1.is_bullish and not c3.is_bullish and c3.close < _mid(c1):
        return Direction.DOWN
    return None


def three_line(
    c1: Candle, c2: Candle, c3: Candle, m: Measures, p: PatternParams
) -> Direction | None:
    """Три белых солдата / три чёрные вороны."""
    cs = (c1, c2, c3)
    if any(c.body < p.three_body * m.avg_body for c in cs):
        return None
    if (
        all(c.is_bullish for c in cs)
        and c2.close > c1.close
        and c3.close > c2.close
        and all(upper_shadow(c) <= p.three_shadow_body * c.body for c in cs)
    ):
        return Direction.UP
    if (
        all(not c.is_bullish for c in cs)
        and c2.close < c1.close
        and c3.close < c2.close
        and all(lower_shadow(c) <= p.three_shadow_body * c.body for c in cs)
    ):
        return Direction.DOWN
    return None


def harami(c1: Candle, c2: Candle, m: Measures, p: PatternParams) -> bool:
    """Тело свечи 2 целиком внутри тела свечи 1; тело 1 ≥ k × avg_body. Направления нет."""
    if c1.body < p.harami_body * m.avg_body:
        return False
    return max(c2.open, c2.close) <= max(c1.open, c1.close) and min(c2.open, c2.close) >= min(
        c1.open, c1.close
    )


def inside_bar(c1: Candle, c2: Candle) -> bool:
    return c2.high <= c1.high and c2.low >= c1.low


def inside_bar_breakout(mother: Candle, inner: Candle, c: Candle) -> Direction | None:
    """Свеча после внутреннего бара закрылась за пределами материнской."""
    if not inside_bar(mother, inner):
        return None
    if c.close > mother.high:
        return Direction.UP
    if c.close < mother.low:
        return Direction.DOWN
    return None


def marubozu(c: Candle, m: Measures, p: PatternParams) -> Direction | None:
    """Пробойная свеча: почти без теней, тело ≥ k × avg_body."""
    if c.range <= 0 or c.body < p.marubozu_body * m.avg_body:
        return None
    if upper_shadow(c) + lower_shadow(c) > p.marubozu_shadow_range * c.range:
        return None
    return Direction.UP if c.is_bullish else Direction.DOWN


def tweezer(c1: Candle, c2: Candle, m: Measures, p: PatternParams) -> Direction | None:
    """Пинцет: два соседних экстремума с разницей ≤ k × ATR, свечи разного цвета."""
    if c1.is_bullish == c2.is_bullish:
        return None
    tol = p.tweezer_tolerance_atr * m.atr
    if not c1.is_bullish and abs(c1.low - c2.low) <= tol:
        return Direction.UP
    if c1.is_bullish and abs(c1.high - c2.high) <= tol:
        return Direction.DOWN
    return None
