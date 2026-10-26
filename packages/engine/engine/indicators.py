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


# --- индикаторы терминала (план 2A.4) -----------------------------------------------------------
# Эталон для TypeScript-реализации packages/charts/src/indicators (golden-тесты, точность 1e-8).


def rsi(candles: Sequence[Candle], period: int = 14) -> list[Decimal | None]:
    """RSI по Уайлдеру: первые средние — простое среднее ``period`` изменений, далее сглаживание."""
    if period < 1:
        raise ValueError("period должен быть >= 1")
    closes = np.array([float(c.close) for c in candles], dtype=np.float64)
    n = len(closes)
    if n <= period:
        return [None] * n
    diff = np.diff(closes)
    gains = np.where(diff > 0, diff, 0.0)
    losses = np.where(diff < 0, -diff, 0.0)
    result = np.full(n, np.nan)
    avg_gain = gains[:period].mean()
    avg_loss = losses[:period].mean()
    result[period] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    for i in range(period + 1, n):
        avg_gain = (avg_gain * (period - 1) + gains[i - 1]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i - 1]) / period
        result[i] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    return _to_decimal(result, period)


def _ema_values(values: np.ndarray, period: int, valid_from: int) -> tuple[np.ndarray, int]:
    """EMA по ряду с NaN в начале: сеется простым средним первых ``period`` валидных значений."""
    n = len(values)
    out = np.full(n, np.nan)
    start = valid_from + period - 1
    if start >= n:
        return out, n
    alpha = 2.0 / (period + 1)
    out[start] = values[valid_from : start + 1].mean()
    for i in range(start + 1, n):
        out[i] = alpha * values[i] + (1 - alpha) * out[i - 1]
    return out, start


def macd(
    candles: Sequence[Candle], fast: int = 12, slow: int = 26, signal: int = 9
) -> tuple[list[Decimal | None], list[Decimal | None], list[Decimal | None]]:
    """MACD = EMA(fast) − EMA(slow); сигнальная — EMA(signal) от MACD; гистограмма — разность."""
    if not (0 < fast < slow) or signal < 1:
        raise ValueError("ожидается 0 < fast < slow и signal >= 1")
    closes = np.array([float(c.close) for c in candles], dtype=np.float64)
    n = len(closes)
    f, _ = _ema_values(closes, fast, 0)
    s, s_from = _ema_values(closes, slow, 0)
    line = f - s
    sig, sig_from = _ema_values(line, signal, s_from)
    hist = line - sig
    return (
        _to_decimal(line, min(s_from, n)),
        _to_decimal(sig, min(sig_from, n)),
        _to_decimal(hist, min(sig_from, n)),
    )


def _sma_values(values: np.ndarray, period: int, valid_from: int) -> tuple[np.ndarray, int]:
    n = len(values)
    out = np.full(n, np.nan)
    start = valid_from + period - 1
    for i in range(start, n):
        out[i] = values[i - period + 1 : i + 1].mean()
    return out, min(start, n)


def stochastic(
    candles: Sequence[Candle], k: int = 14, d: int = 3, smooth: int = 3
) -> tuple[list[Decimal | None], list[Decimal | None]]:
    """%K = SMA(smooth) от сырого %K за ``k`` свечей; %D = SMA(d) от %K.

    При нулевом диапазоне (hh == ll) сырой %K = 50.
    """
    if k < 1 or d < 1 or smooth < 1:
        raise ValueError("периоды должны быть >= 1")
    highs = np.array([float(c.high) for c in candles])
    lows = np.array([float(c.low) for c in candles])
    closes = np.array([float(c.close) for c in candles])
    n = len(closes)
    raw = np.full(n, np.nan)
    for i in range(k - 1, n):
        hh = highs[i - k + 1 : i + 1].max()
        ll = lows[i - k + 1 : i + 1].min()
        raw[i] = 50.0 if hh == ll else 100.0 * (closes[i] - ll) / (hh - ll)
    kv, k_from = _sma_values(raw, smooth, k - 1)
    dv, d_from = _sma_values(kv, d, k_from)
    return _to_decimal(kv, k_from), _to_decimal(dv, d_from)


def bollinger(
    candles: Sequence[Candle], period: int = 20, mult: float = 2.0
) -> tuple[list[Decimal | None], list[Decimal | None], list[Decimal | None]]:
    """Средняя SMA(period), полосы ± mult × σ (σ — по населению, как в TradingView)."""
    if period < 1:
        raise ValueError("period должен быть >= 1")
    closes = np.array([float(c.close) for c in candles], dtype=np.float64)
    n = len(closes)
    mid = np.full(n, np.nan)
    up = np.full(n, np.nan)
    lo = np.full(n, np.nan)
    for i in range(period - 1, n):
        w = closes[i - period + 1 : i + 1]
        m = w.mean()
        sd = np.sqrt(((w - m) ** 2).mean())
        mid[i], up[i], lo[i] = m, m + mult * sd, m - mult * sd
    return _to_decimal(mid, period - 1), _to_decimal(up, period - 1), _to_decimal(lo, period - 1)


def vwap_daily(candles: Sequence[Candle]) -> list[Decimal | None]:
    """Дневной VWAP по типичной цене (h+l+c)/3, сброс в 00:00 UTC."""
    out = np.full(len(candles), np.nan)
    pv = vol = 0.0
    day = None
    for i, c in enumerate(candles):
        d = c.open_time.date()
        if d != day:
            pv = vol = 0.0
            day = d
        tp = (float(c.high) + float(c.low) + float(c.close)) / 3.0
        v = float(c.volume)
        pv += tp * v
        vol += v
        out[i] = pv / vol if vol > 0 else tp
    return _to_decimal(out, 0)


def supertrend(
    candles: Sequence[Candle], period: int = 10, mult: float = 3.0
) -> tuple[list[Decimal | None], list[int | None]]:
    """Supertrend: полосы (h+l)/2 ± mult × ATR(period), направление 1 (вверх) / −1 (вниз).

    Линия = нижняя полоса при тренде вверх и верхняя при тренде вниз. Смена тренда — закрытие
    за противоположной полосой предыдущей свечи. Первое значение — на первой свече с ATR.
    """
    if period < 1:
        raise ValueError("period должен быть >= 1")
    atr_v = atr(candles, period)
    n = len(candles)
    line: list[Decimal | None] = [None] * n
    direction: list[int | None] = [None] * n
    highs = [float(c.high) for c in candles]
    lows = [float(c.low) for c in candles]
    closes = [float(c.close) for c in candles]
    fu = fl = float("nan")
    trend = 0
    for i in range(n):
        a = atr_v[i]
        if a is None:
            continue
        hl2 = (highs[i] + lows[i]) / 2.0
        bu = hl2 + mult * float(a)
        bl = hl2 - mult * float(a)
        if trend == 0:
            fu, fl = bu, bl
            trend = -1 if closes[i] < bl else 1
        else:
            fu = bu if (bu < fu or closes[i - 1] > fu) else fu
            fl = bl if (bl > fl or closes[i - 1] < fl) else fl
            if trend == 1 and closes[i] < fl:
                trend = -1
            elif trend == -1 and closes[i] > fu:
                trend = 1
        value = fl if trend == 1 else fu
        line[i] = Decimal(repr(value))
        direction[i] = trend
    return line, direction


def volume_sma(candles: Sequence[Candle], period: int = 20) -> list[Decimal | None]:
    if period < 1:
        raise ValueError("period должен быть >= 1")
    vols = np.array([float(c.volume) for c in candles], dtype=np.float64)
    out, start = _sma_values(vols, period, 0)
    return _to_decimal(out, start)
