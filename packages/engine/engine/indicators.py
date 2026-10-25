"""Базовые индикаторы на закрытых свечах.

Все функции принимают уже отфильтрованный ``closed_only`` ряд и возвращают список
той же длины, где первые значения, для которых не хватает истории, равны ``None``.
Расчёт — во ``float`` (numpy), результат округляется в ``Decimal`` через ``str``,
чтобы TypeScript-реализация (packages/charts) могла совпасть на golden-тестах.
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal

import numpy as np

from engine.candles import Candle


def _to_decimal(values: np.ndarray, valid_from: int) -> list[Decimal | None]:
    out: list[Decimal | None] = [None] * len(values)
    for i in range(valid_from, len(values)):
        out[i] = Decimal(repr(float(values[i])))
    return out


def sma(candles: Sequence[Candle], period: int) -> list[Decimal | None]:
    if period < 1:
        raise ValueError("period должен быть >= 1")
    closes = np.array([float(c.close) for c in candles], dtype=np.float64)
    if len(closes) < period:
        return [None] * len(closes)
    window = np.convolve(closes, np.ones(period) / period, mode="valid")
    result = np.full(len(closes), np.nan)
    result[period - 1 :] = window
    return _to_decimal(result, period - 1)


def ema(candles: Sequence[Candle], period: int) -> list[Decimal | None]:
    """EMA с инициализацией простым средним первых ``period`` свечей (как в TradingView)."""
    if period < 1:
        raise ValueError("period должен быть >= 1")
    closes = np.array([float(c.close) for c in candles], dtype=np.float64)
    n = len(closes)
    if n < period:
        return [None] * n
    alpha = 2.0 / (period + 1)
    result = np.full(n, np.nan)
    result[period - 1] = closes[:period].mean()
    for i in range(period, n):
        result[i] = alpha * closes[i] + (1 - alpha) * result[i - 1]
    return _to_decimal(result, period - 1)


def true_range(candles: Sequence[Candle]) -> list[Decimal]:
    """TR_i = max(high-low, |high-prev_close|, |low-prev_close|); для первой свечи — high-low."""
    out: list[Decimal] = []
    prev_close: Decimal | None = None
    for c in candles:
        if prev_close is None:
            tr = c.high - c.low
        else:
            tr = max(c.high - c.low, abs(c.high - prev_close), abs(c.low - prev_close))
        out.append(tr)
        prev_close = c.close
    return out


def atr(candles: Sequence[Candle], period: int = 14) -> list[Decimal | None]:
    """ATR по Уайлдеру: первое значение — SMA(TR, period), далее сглаживание 1/period."""
    if period < 1:
        raise ValueError("period должен быть >= 1")
    tr = np.array([float(x) for x in true_range(candles)], dtype=np.float64)
    n = len(tr)
    if n < period:
        return [None] * n
    result = np.full(n, np.nan)
    result[period - 1] = tr[:period].mean()
    for i in range(period, n):
        result[i] = (result[i - 1] * (period - 1) + tr[i]) / period
    return _to_decimal(result, period - 1)
