"""Графические фигуры (4B.1): синтетика на каждый тип, статусы, нет перерисовки, отработка."""

from __future__ import annotations

import math
from datetime import UTC, datetime
from decimal import Decimal

from engine.candles import Candle, Timeframe
from engine.figures import (
    DEFAULT_FIGURE_PARAMS,
    Figure,
    FigureParams,
    FigureStatus,
    FigureType,
    Line,
    Point,
    confirmed_only,
    detect_figures,
    figure_outcome,
    with_status,
)
from engine.figures import geometry as g
from engine.figures.detect import dedupe
from engine.indicators import atr
from engine.structure import Direction

T0 = datetime(2024, 1, 1, tzinfo=UTC)
D = Decimal


def series(path: list[float], vol: list[float] | None = None) -> list[Candle]:
    """Свечи по закрытиям: тень 0.4 со стороны движения, чтобы экстремумы были swing-точками."""
    out: list[Candle] = []
    for i, v in enumerate(path):
        o = path[i - 1] if i else v
        hi = v + 0.4 if v >= o else max(o, v) + 0.05
        lo = min(o, v) - 0.05 if v >= o else v - 0.4
        out.append(
            Candle(
                T0 + Timeframe.H4.delta * i,
                D(f"{o:.3f}"),
                D(f"{hi:.3f}"),
                D(f"{lo:.3f}"),
                D(f"{v:.3f}"),
                D(str(vol[i] if vol else 10)),
            )
        )
    return out


def warm(n: int = 40, base: float = 100.0) -> list[float]:
    return [base + 0.3 * math.sin(i / 2) for i in range(n)]


def seg(a: float, b: float, n: int) -> list[float]:
    return [a + (b - a) * i / n for i in range(1, n + 1)]


def only(figs: list[Figure], t: FigureType, status: FigureStatus | None = None) -> list[Figure]:
    return [f for f in figs if f.type is t and (status is None or f.status is status)]


def test_geometry_helpers() -> None:
    k, b, r2 = g.linreg([0, 1, 2, 3], [1, 3, 5, 7])
    assert abs(k - 2) < 1e-9 and abs(b - 1) < 1e-9 and r2 == 1.0
    assert g.linreg([1], [1]) == (0.0, 0.0, 0.0)
    assert g.linreg([1, 1], [1, 2])[2] == 0.0
    assert g.linreg([0, 1, 2], [5, 5, 5])[2] == 1.0
    assert abs(g.angle_deg(1.0, 1.0) - 45) < 1e-9 and g.angle_deg(1.0, 0.0) == 0.0
    a, r2 = g.parabola_r2([0, 1, 2, 3, 4], [4, 1, 0, 1, 4])
    assert abs(a - 1) < 1e-9 and r2 > 0.999
    assert g.parabola_r2([0, 1], [1, 2]) == (0.0, 0.0)
    flat_a, flat_r2 = g.parabola_r2([0, 1, 2], [3, 3, 3])
    assert abs(flat_a) < 1e-9 and flat_r2 == 0.0
    assert g.touches([(0, 1.0), (1, 3.05), (2, 10.0)], 2.0, 1.0, 0.1) == 2
    assert g.clamp01(2) == 1.0 and g.clamp01(-1) == 0.0
    ln = Line("x", Point(0, D(10)), Point(10, D(20)))
    assert ln.at(5) == D(15) and Line("y", Point(3, D(1)), Point(3, D(9))).at(7) == D(1)


def test_double_top_confirmed_with_target_and_no_redraw() -> None:
    path = (
        warm()
        + seg(100, 110, 8)
        + seg(110, 104, 6)
        + seg(104, 110, 6)
        + seg(110, 103, 8)
        + seg(103, 100.5, 5)
    )
    cs = series(path)
    figs = detect_figures(cs)
    dt = only(figs, FigureType.DOUBLE_TOP, FigureStatus.CONFIRMED)
    assert len(dt) == 1
    f = dt[0]
    assert (
        f.direction is Direction.DOWN and f.breakout_level == D("103.6") and f.target == D("96.8")
    )
    assert (
        f.invalidation == D("110.4")
        and f.confirm_index is not None
        and f.confirm_index > f.known_index
    )
    assert f.quality >= 0.6 and f.rules_version == "figures@1.0.0" and f.title == "Двойная вершина"
    assert [p.index for p in f.points] == [f.start_index, f.points[1].index, f.end_index]
    # нет перерисовки: до пробоя та же геометрия со статусом «формируется», после — бит в бит
    before = detect_figures(cs[: f.confirm_index])
    forming = only(before, FigureType.DOUBLE_TOP, FigureStatus.FORMING)
    assert len(forming) == 1 and forming[0].points == f.points and forming[0].lines == f.lines
    assert forming[0].confirm_index is None and forming[0].target is None
    after = detect_figures(cs[: f.confirm_index + 1])
    assert only(after, FigureType.DOUBLE_TOP, FigureStatus.CONFIRMED)[0] == f
    assert detect_figures(cs) == figs  # детерминизм


def test_double_bottom_and_invalidated_double_top() -> None:
    path = (
        warm()
        + seg(100, 90, 8)
        + seg(90, 96, 6)
        + seg(96, 90, 6)
        + seg(90, 97, 8)
        + seg(97, 100, 5)
    )
    figs = detect_figures(series(path))
    db = only(figs, FigureType.DOUBLE_BOTTOM, FigureStatus.CONFIRMED)
    assert len(db) == 1 and db[0].direction is Direction.UP and db[0].target is not None
    assert db[0].target > db[0].breakout_level  # type: ignore[operator]
    # вершина, после которой цена ушла выше максимума → отменена
    path2 = (
        warm()
        + seg(100, 110, 8)
        + seg(110, 104, 6)
        + seg(104, 110, 6)
        + seg(110, 107, 4)
        + seg(107, 113, 5)
    )
    figs2 = detect_figures(series(path2))
    inv = [
        f
        for f in only(figs2, FigureType.DOUBLE_TOP, FigureStatus.INVALIDATED)
        if f.start_index >= 40
    ]
    assert len(inv) == 1 and inv[0].invalidated_index is not None and inv[0].confirm_index is None


def test_head_and_shoulders_both_ways() -> None:
    hs = (
        warm()
        + seg(100, 106, 6)
        + seg(106, 102, 4)
        + seg(102, 110, 6)
        + seg(110, 102, 6)
        + seg(102, 106, 5)
        + seg(106, 101, 6)
        + seg(101, 97, 4)
    )
    figs = detect_figures(series(hs))
    f = only(figs, FigureType.HEAD_SHOULDERS, FigureStatus.CONFIRMED)
    assert len(f) == 1 and f[0].direction is Direction.DOWN and len(f[0].points) == 5
    assert f[0].target is not None and f[0].target < f[0].breakout_level  # type: ignore[operator]
    assert f[0].invalidation == D("110.4") and f[0].metrics["neck_deg"] <= 15
    inv = [200 - x for x in hs]
    figs2 = detect_figures(series(inv))
    f2 = only(figs2, FigureType.INV_HEAD_SHOULDERS, FigureStatus.CONFIRMED)
    assert len(f2) == 1 and f2[0].direction is Direction.UP


def test_triangle_wedges_channel_and_range() -> None:
    tri = warm()
    for k in range(3):
        amp = 8 * (0.7**k)
        tri += seg(tri[-1], 100 + amp, 4) + seg(100 + amp, 100 - amp, 6)
    tri += seg(tri[-1], 102, 3) + seg(102, 110, 4)
    f = only(detect_figures(series(tri)), FigureType.TRIANGLE_SYM, FigureStatus.CONFIRMED)
    assert len(f) == 1 and f[0].direction is Direction.UP and f[0].metrics["compression"] >= 0.4
    assert {ln.name for ln in f[0].lines} == {"upper", "lower"}
    wd = warm()
    for k in range(5):
        wd += seg(wd[-1], 105 + k * 0.8, 4) + seg(105 + k * 0.8, 100 + k * 1.6, 4)
    wd += seg(wd[-1], 96, 4)
    w = only(detect_figures(series(wd)), FigureType.WEDGE_RISING, FigureStatus.CONFIRMED)
    assert len(w) == 1 and w[0].direction is Direction.DOWN and w[0].metrics["touches"] >= 3
    fw = warm()
    for k in range(5):
        fw += seg(fw[-1], 100 - k * 1.6, 4) + seg(100 - k * 1.6, 95 - k * 0.8, 4)
    fw += seg(fw[-1], 104, 4)
    w2 = only(detect_figures(series(fw)), FigureType.WEDGE_FALLING, FigureStatus.CONFIRMED)
    assert len(w2) == 1 and w2[0].direction is Direction.UP
    ch = (
        warm()
        + [100 + 0.25 * i + (3 if (i // 5) % 2 else 0) for i in range(50)]
        + seg(115.5, 122, 4)
    )
    c = only(detect_figures(series(ch)), FigureType.CHANNEL_UP, FigureStatus.CONFIRMED)
    assert len(c) == 1 and c[0].direction is Direction.UP and c[0].metrics["slope_deg"] > 3
    rg = warm()
    for _ in range(4):
        rg += seg(rg[-1], 104, 4) + seg(104, 100, 4)
    rg += seg(rg[-1], 94, 4)
    r = [f for f in only(detect_figures(series(rg)), FigureType.RANGE) if f.end_index >= 50]
    assert r and r[0].status is FigureStatus.CONFIRMED and r[0].direction is Direction.DOWN


def test_flag_and_cup() -> None:
    flag = (
        warm()
        + seg(100, 112, 5)
        + [112 - 0.3 * i + (0.5 if i % 2 else -0.5) for i in range(1, 9)]
        + seg(109.5, 116, 4)
    )
    f = only(detect_figures(series(flag)), FigureType.FLAG, FigureStatus.CONFIRMED)
    assert len(f) == 1 and f[0].direction is Direction.UP and f[0].metrics["pole_atr"] >= 2.5
    assert f[0].target is not None and float(f[0].target) > 116
    cup = (
        warm()
        + [100 - 6 * (1 - ((i - 30) / 30) ** 2) for i in range(61)]
        + [100 - 0.8 - 0.3 * (i % 3) for i in range(8)]
        + seg(99.5, 104, 4)
    )
    c = only(detect_figures(series(cup)), FigureType.CUP_HANDLE, FigureStatus.CONFIRMED)
    assert len(c) == 1 and c[0].direction is Direction.UP and c[0].metrics["r2"] >= 0.8
    assert c[0].target is not None and c[0].target > c[0].breakout_level  # type: ignore[operator]


def test_forming_requires_quality_and_warmup() -> None:
    assert detect_figures(series(warm(20))) == []
    ch = warm() + [100 + 0.25 * i + (3 if (i // 5) % 2 else 0) for i in range(50)]
    figs = detect_figures(series(ch))
    forming = with_status(figs, FigureStatus.FORMING)
    assert forming and all(f.quality >= 0.6 for f in forming)
    strict = FigureParams(forming_quality=1.01)
    assert not with_status(detect_figures(series(ch), strict), FigureStatus.FORMING)
    assert confirmed_only(figs) == [f for f in figs if f.status is FigureStatus.CONFIRMED]
    assert DEFAULT_FIGURE_PARAMS.warmup == 30


def test_dedupe_keeps_best_overlapping() -> None:
    base = dict(
        type=FigureType.RANGE,
        direction=None,
        scale=2,
        points=(Point(0, D(1)),),
        lines=(),
        known_index=5,
        status=FigureStatus.FORMING,
        confirm_index=None,
        invalidated_index=None,
        breakout_level=None,
        target=None,
        invalidation=None,
        rules_version="x",
    )
    a = Figure(start_index=0, end_index=10, quality=0.5, **base)  # type: ignore[arg-type]
    b = Figure(start_index=5, end_index=15, quality=0.9, **base)  # type: ignore[arg-type]
    c = Figure(start_index=20, end_index=30, quality=0.4, **base)  # type: ignore[arg-type]
    out = dedupe([a, b, c])
    assert out == [b, c]


def test_figure_outcome() -> None:
    path = (
        warm()
        + seg(100, 110, 8)
        + seg(110, 104, 6)
        + seg(104, 110, 6)
        + seg(110, 103, 8)
        + seg(103, 96, 6)
        + seg(96, 99, 3)
    )
    cs = series(path)
    f = only(detect_figures(cs), FigureType.DOUBLE_TOP, FigureStatus.CONFIRMED)[0]
    a = atr(cs, 14)[f.confirm_index or 0]
    assert a is not None
    o = figure_outcome(cs, f, a)
    assert o.target_hit is True and o.invalidation_hit is False and o.bars_to_target is not None
    assert o.max_favorable_atr is not None and o.max_favorable_atr > 0
    short = figure_outcome(cs[: (f.confirm_index or 0) + 1], f, a)
    assert short.target_hit is None
    forming = detect_figures(cs[: f.confirm_index])
    ff = only(forming, FigureType.DOUBLE_TOP, FigureStatus.FORMING)[0]
    assert figure_outcome(cs, ff, a).target_hit is None
    # инвалидация после пробоя: цена вернулась выше максимумов
    path2 = (
        warm()
        + seg(100, 110, 8)
        + seg(110, 104, 6)
        + seg(104, 110, 6)
        + seg(110, 103, 8)
        + seg(103, 112, 6)
        + [112] * 14
    )
    cs2 = series(path2)
    f2 = only(detect_figures(cs2), FigureType.DOUBLE_TOP, FigureStatus.CONFIRMED)[0]
    o2 = figure_outcome(cs2, f2, a)
    assert o2.target_hit is False and o2.invalidation_hit is True
