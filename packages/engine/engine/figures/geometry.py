"""Геометрия для фигур: регрессия, касания, углы, парабола. Float — только внутри расчётов."""

from __future__ import annotations

import math
from collections.abc import Sequence
from decimal import Decimal


def linreg(xs: Sequence[float], ys: Sequence[float]) -> tuple[float, float, float]:
    """(наклон, пересечение, R²). Для двух точек R² = 1; меньше двух — (0, 0, 0)."""
    n = len(xs)
    if n < 2:
        return 0.0, 0.0, 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return 0.0, my, 0.0
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    k = sxy / sxx
    b = my - k * mx
    ss_tot = sum((y - my) ** 2 for y in ys)
    if ss_tot == 0:
        return k, b, 1.0
    ss_res = sum((y - (k * x + b)) ** 2 for x, y in zip(xs, ys, strict=True))
    return k, b, max(0.0, 1.0 - ss_res / ss_tot)


def angle_deg(slope: float, atr: float) -> float:
    """Угол линии в градусах при масштабе «ATR на свечу»."""
    if atr <= 0:
        return 0.0
    return math.degrees(math.atan(slope / atr))


def parabola_r2(xs: Sequence[float], ys: Sequence[float]) -> tuple[float, float]:
    """Аппроксимация y = a·x² + b·x + c методом наименьших квадратов → (a, R²)."""
    n = len(xs)
    if n < 3:
        return 0.0, 0.0
    # нормальные уравнения 3×3
    s = [sum(x**p for x in xs) for p in range(5)]
    t = [sum(y * x**p for x, y in zip(xs, ys, strict=True)) for p in range(3)]
    m = [[s[4], s[3], s[2]], [s[3], s[2], s[1]], [s[2], s[1], float(n)]]
    rhs = [t[2], t[1], t[0]]
    sol = _solve3(m, rhs)
    if sol is None:
        return 0.0, 0.0
    a, b, c = sol
    my = sum(ys) / n
    ss_tot = sum((y - my) ** 2 for y in ys)
    if ss_tot == 0:
        return a, 0.0
    ss_res = sum((y - (a * x * x + b * x + c)) ** 2 for x, y in zip(xs, ys, strict=True))
    return a, max(0.0, 1.0 - ss_res / ss_tot)


def _solve3(m: list[list[float]], v: list[float]) -> tuple[float, float, float] | None:
    a = [[*row, v[i]] for i, row in enumerate(m)]
    for col in range(3):
        piv = max(range(col, 3), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-12:
            return None
        a[col], a[piv] = a[piv], a[col]
        for r in range(3):
            if r == col:
                continue
            f = a[r][col] / a[col][col]
            for c in range(col, 4):
                a[r][c] -= f * a[col][c]
    return a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]


def touches(points: Sequence[tuple[int, float]], k: float, b: float, tol: float) -> int:
    """Сколько точек лежит на линии y = k·x + b с допуском ``tol``."""
    return sum(1 for x, y in points if abs(y - (k * x + b)) <= tol)


def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def dec(x: float, q: Decimal) -> Decimal:
    """Float → Decimal с квантованием к точности цены ``q``."""
    return Decimal(str(x)).quantize(q)
