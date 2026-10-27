"""Поиск кандидатов графических фигур по swing-точкам на трёх масштабах (план 2A.10.2, 4B.1).

Гарантии:
- Только закрытые свечи на входе.
- Геометрия кандидата известна на закрытии свечи ``known_index`` (все swing-и подтверждены),
  статус «подтверждена»/«отменена» ставится по закрытию более поздней свечи. На префиксе ряда
  подтверждённые фигуры совпадают бит в бит — перерисовки нет.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from decimal import Decimal
from itertools import pairwise

from engine.candles import Candle
from engine.figures import geometry as g
from engine.figures.params import DEFAULT_FIGURE_PARAMS, FigureParams
from engine.figures.types import Figure, FigureStatus, FigureType, Line, Point
from engine.indicators import atr
from engine.params import StructureParams
from engine.structure import Direction, Swing, SwingKind, analyze_structure

Q = Decimal("0.00000001")


@dataclass(slots=True)
class Ctx:
    candles: Sequence[Candle]
    high: list[float]
    low: list[float]
    close: list[float]
    vol: list[float]
    atr: list[float | None]
    p: FigureParams

    def a(self, i: int) -> float:
        v = self.atr[min(i, len(self.atr) - 1)]
        return v if v is not None and v > 0 else 0.0

    def vol_ratio(self, start: int, end: int) -> float:
        """Средний объём внутри [start, end] к среднему за окно до start (1.0 — равны)."""
        w = self.p.volume_window
        before = self.vol[max(0, start - w) : start]
        inside = self.vol[start : end + 1]
        if not before or not inside:
            return 1.0
        mb = sum(before) / len(before)
        return (sum(inside) / len(inside)) / mb if mb > 0 else 1.0


@dataclass(slots=True)
class Candidate:
    type: FigureType
    direction: Direction | None
    scale: int
    points: list[Point]
    lines: list[Line]
    start: int
    end: int
    known: int
    validity_end: int
    """Последняя свеча, на которой ещё ждём пробой."""
    up_line: Line | None
    """Пробой вверх — закрытие выше этой линии (None — вверх не ждём)."""
    down_line: Line | None
    height: float
    """Высота фигуры для цели."""
    invalid_above: float | None
    invalid_below: float | None
    quality: float
    metrics: dict[str, float]


def _d(x: float) -> Decimal:
    return Decimal(str(x)).quantize(Q)


def _pt(i: int, price: float) -> Point:
    return Point(i, _d(price))


def _line(name: str, i1: int, p1: float, i2: int, p2: float) -> Line:
    return Line(name, _pt(i1, p1), _pt(i2, p2))


def _hline(name: str, i1: int, i2: int, price: float) -> Line:
    return _line(name, i1, price, max(i2, i1 + 1), price)


# --- статусы --------------------------------------------------------------------------------------


def resolve(c: Candidate, ctx: Ctx, rules_version: str) -> Figure | None:
    """Проходит по свечам после известности фигуры и ставит статус без утечки будущего."""
    n = len(ctx.close)
    status = FigureStatus.FORMING
    confirm: int | None = None
    invalid: int | None = None
    level: Decimal | None = None
    target: Decimal | None = None
    direction = c.direction
    for j in range(c.known, n):
        close = ctx.close[j]
        if c.invalid_above is not None and close > c.invalid_above:
            status, invalid = FigureStatus.INVALIDATED, j
            break
        if c.invalid_below is not None and close < c.invalid_below:
            status, invalid = FigureStatus.INVALIDATED, j
            break
        if c.up_line is not None and close > float(c.up_line.at(j)):
            status, confirm = FigureStatus.CONFIRMED, j
            level = c.up_line.at(j).quantize(Q)
            target = _d(float(level) + c.height)
            direction = Direction.UP
            break
        if c.down_line is not None and close < float(c.down_line.at(j)):
            status, confirm = FigureStatus.CONFIRMED, j
            level = c.down_line.at(j).quantize(Q)
            target = _d(float(level) - c.height)
            direction = Direction.DOWN
            break
        if j >= c.validity_end:
            status, invalid = FigureStatus.INVALIDATED, j
            break
    if status is FigureStatus.FORMING and c.quality < ctx.p.forming_quality:
        return None
    inv_level = c.invalid_above if direction is Direction.DOWN else c.invalid_below
    if direction is None:
        inv_level = None
    pending = c.up_line if direction is Direction.UP else c.down_line
    if level is None and pending is not None:
        level = pending.at(c.end).quantize(Q)
    if status is FigureStatus.CONFIRMED and confirm is not None:
        vol_break = ctx.vol[confirm]
        base = ctx.vol[max(0, confirm - ctx.p.volume_window) : confirm]
        mb = sum(base) / len(base) if base else 0.0
        c.metrics["breakout_volume"] = (vol_break / mb) if mb > 0 else 1.0
    return Figure(
        type=c.type,
        direction=direction,
        scale=c.scale,
        points=tuple(c.points),
        lines=tuple(c.lines),
        start_index=c.start,
        end_index=c.end,
        known_index=c.known,
        status=status,
        confirm_index=confirm,
        invalidated_index=invalid,
        breakout_level=level,
        target=target,
        invalidation=_d(inv_level) if inv_level is not None else None,
        quality=round(c.quality, 4),
        rules_version=rules_version,
        metrics={k: round(v, 4) for k, v in c.metrics.items()},
    )


# --- шаблоны --------------------------------------------------------------------------------------


def _between(swings: Sequence[Swing], a: Swing, b: Swing, kind: SwingKind) -> list[Swing]:
    return [s for s in swings if a.index < s.index < b.index and s.kind is kind]


def double(swings: Sequence[Swing], ctx: Ctx, scale: int, top: bool) -> Iterator[Candidate]:
    p = ctx.p
    kind = SwingKind.HIGH if top else SwingKind.LOW
    other = SwingKind.LOW if top else SwingKind.HIGH
    ext = [s for s in swings if s.kind is kind]
    for h1, h2 in pairwise(ext):
        a = ctx.a(h2.index)
        if a <= 0:
            continue
        mids = _between(swings, h1, h2, other)
        if not mids:
            continue
        mid = min(mids, key=lambda s: s.price) if top else max(mids, key=lambda s: s.price)
        p1, p2, pm = float(h1.price), float(h2.price), float(mid.price)
        if abs(p1 - p2) > float(p.double_tops_tol_atr) * a:
            continue
        depth = (max(p1, p2) - pm) if top else (pm - min(p1, p2))
        if depth < float(p.double_pullback_atr) * a:
            continue
        known = max(h1.confirmed_index, h2.confirmed_index, mid.confirmed_index)
        length = h2.index - h1.index
        neck = _hline("neck", mid.index, h2.index + length, pm)
        sym = g.clamp01(1 - abs(p1 - p2) / (float(p.double_tops_tol_atr) * a))
        prop = g.clamp01(depth / (3 * a))
        vol = (
            g.clamp01(1.5 - ctx.vol[h2.index] / ctx.vol[h1.index]) if ctx.vol[h1.index] > 0 else 0.5
        )
        quality = (sym + prop + vol) / 3
        if quality < p.min_quality:
            continue
        extreme = max(p1, p2) if top else min(p1, p2)
        yield Candidate(
            type=FigureType.DOUBLE_TOP if top else FigureType.DOUBLE_BOTTOM,
            direction=Direction.DOWN if top else Direction.UP,
            scale=scale,
            points=[_pt(h1.index, p1), _pt(mid.index, pm), _pt(h2.index, p2)],
            lines=[neck],
            start=h1.index,
            end=h2.index,
            known=known,
            validity_end=h2.index + int(p.validity_mult * length),
            up_line=None if top else neck,
            down_line=neck if top else None,
            height=depth,
            invalid_above=extreme if top else None,
            invalid_below=None if top else extreme,
            quality=quality,
            metrics={"symmetry": sym, "depth_atr": depth / a, "volume": vol},
        )


def head_shoulders(
    swings: Sequence[Swing], ctx: Ctx, scale: int, inverse: bool
) -> Iterator[Candidate]:
    p = ctx.p
    kind = SwingKind.LOW if inverse else SwingKind.HIGH
    other = SwingKind.HIGH if inverse else SwingKind.LOW
    sgn = -1.0 if inverse else 1.0
    ext = [s for s in swings if s.kind is kind]
    for s1, h, s2 in zip(ext, ext[1:], ext[2:], strict=False):
        a = ctx.a(s2.index)
        if a <= 0:
            continue
        v1, vh, v2 = sgn * float(s1.price), sgn * float(h.price), sgn * float(s2.price)
        if (
            vh - max(v1, v2) < float(p.hs_head_over_atr) * a
            or abs(v1 - v2) > float(p.hs_shoulders_tol_atr) * a
        ):
            continue
        t1s = _between(swings, s1, h, other)
        t2s = _between(swings, h, s2, other)
        if not t1s or not t2s:
            continue
        t1 = min(t1s, key=lambda s: sgn * float(s.price))
        t2 = min(t2s, key=lambda s: sgn * float(s.price))
        k = (float(t2.price) - float(t1.price)) / (t2.index - t1.index)
        if abs(g.angle_deg(k, a)) > p.hs_neck_max_deg:
            continue
        length = s2.index - s1.index
        neck = _line(
            "neck",
            t1.index,
            float(t1.price),
            s2.index + length,
            float(t1.price) + k * (s2.index + length - t1.index),
        )
        head_h = abs(float(h.price) - float(neck.at(h.index)))
        sym = g.clamp01(1 - abs(v1 - v2) / (float(p.hs_shoulders_tol_atr) * a))
        prop = g.clamp01(head_h / (3 * a))
        flat = g.clamp01(1 - abs(g.angle_deg(k, a)) / p.hs_neck_max_deg)
        vol = g.clamp01(1.5 - ctx.vol[s2.index] / ctx.vol[h.index]) if ctx.vol[h.index] > 0 else 0.5
        quality = (sym + prop + flat + vol) / 4
        if quality < p.min_quality:
            continue
        known = max(s.confirmed_index for s in (s1, h, s2, t1, t2))
        yield Candidate(
            type=FigureType.INV_HEAD_SHOULDERS if inverse else FigureType.HEAD_SHOULDERS,
            direction=Direction.UP if inverse else Direction.DOWN,
            scale=scale,
            points=[_pt(s.index, float(s.price)) for s in (s1, t1, h, t2, s2)],
            lines=[neck],
            start=s1.index,
            end=s2.index,
            known=known,
            validity_end=s2.index + int(p.validity_mult * length),
            up_line=neck if inverse else None,
            down_line=None if inverse else neck,
            height=head_h,
            invalid_above=None if inverse else float(h.price),
            invalid_below=float(h.price) if inverse else None,
            quality=quality,
            metrics={
                "symmetry": sym,
                "head_atr": head_h / a,
                "neck_deg": g.angle_deg(k, a),
                "volume": vol,
            },
        )


def _fit(points: Sequence[Swing]) -> tuple[float, float, float]:
    return g.linreg([float(s.index) for s in points], [float(s.price) for s in points])


def converging(swings: Sequence[Swing], ctx: Ctx, scale: int) -> Iterator[Candidate]:
    """Треугольники, клинья и каналы по окну swing-точек: регрессия по максимумам и минимумам."""
    p = ctx.p
    tol_deg = p.channel_parallel_deg
    for e_i in range(3, len(swings)):
        e = swings[e_i]
        for s_i in range(e_i - 3, max(-1, e_i - 14), -1):
            s = swings[s_i]
            length = e.index - s.index
            if length < p.tri_min_len or length > max(
                p.tri_max_len, p.wedge_max_len, p.channel_max_len
            ):
                continue
            window = swings[s_i : e_i + 1]
            highs = [x for x in window if x.kind is SwingKind.HIGH]
            lows = [x for x in window if x.kind is SwingKind.LOW]
            if len(highs) < 2 or len(lows) < 2:
                continue
            a = ctx.a(e.index)
            if a <= 0:
                continue
            ku, bu, r2u = _fit(highs)
            kl, bl, r2l = _fit(lows)
            if r2u < p.tri_min_r2 or r2l < p.tri_min_r2:
                continue
            up_s, lo_s = ku * s.index + bu, kl * s.index + bl
            up_e, lo_e = ku * e.index + bu, kl * e.index + bl
            if up_s <= lo_s or up_e <= 0:
                continue
            range_s, range_e = up_s - lo_s, up_e - lo_e
            au, al = g.angle_deg(ku, a), g.angle_deg(kl, a)
            tol = p.touch_tol_atr * a
            t_up = g.touches([(x.index, float(x.price)) for x in highs], ku, bu, tol)
            t_lo = g.touches([(x.index, float(x.price)) for x in lows], kl, bl, tol)
            known = max(x.confirmed_index for x in window)
            fit_q = (r2u + r2l) / 2
            touch_q = g.clamp01((t_up + t_lo - 2) / 4)
            vol = g.clamp01(1.5 - ctx.vol_ratio(s.index, e.index))
            typ: FigureType | None = None
            direction: Direction | None = None
            up_line: Line | None = None
            down_line: Line | None = None
            validity_end = e.index + int(p.validity_mult * length)
            invalid_above: float | None = None
            invalid_below: float | None = None
            height = range_s
            extra: dict[str, float] = {}
            conv = ku < kl and range_e > 0
            compression = (1 - range_e / range_s) if conv else 0.0
            apex = (bl - bu) / (ku - kl) if conv else 0.0
            if conv and compression >= p.wedge_compression and apex > e.index:
                same_sign = (ku > 0 and kl > 0) or (ku < 0 and kl < 0)
                if (
                    same_sign
                    and p.wedge_min_len <= length <= p.wedge_max_len
                    and t_up + t_lo >= p.wedge_min_touches
                ):
                    rising = ku > 0
                    typ = FigureType.WEDGE_RISING if rising else FigureType.WEDGE_FALLING
                    direction = Direction.DOWN if rising else Direction.UP
                    validity_end = min(validity_end, int(apex))
                    if rising:
                        down_line = _line(
                            "lower", s.index, lo_s, validity_end, kl * validity_end + bl
                        )
                        invalid_above = ku * validity_end + bu
                    else:
                        up_line = _line(
                            "upper", s.index, up_s, validity_end, ku * validity_end + bu
                        )
                        invalid_below = kl * validity_end + bl
                    quality = (fit_q + touch_q + g.clamp01(compression / 0.6) + vol) / 4
                elif not same_sign or abs(au) <= p.tri_flat_deg or abs(al) <= p.tri_flat_deg:
                    if (
                        not (p.tri_min_len <= length <= p.tri_max_len)
                        or compression < p.tri_compression
                    ):
                        continue
                    validity_end = s.index + int(p.tri_confirm_part * (apex - s.index))
                    if validity_end <= e.index:
                        continue
                    if abs(au) <= p.tri_flat_deg and kl > 0:
                        typ, direction = FigureType.TRIANGLE_ASC, Direction.UP
                    elif abs(al) <= p.tri_flat_deg and ku < 0:
                        typ, direction = FigureType.TRIANGLE_DESC, Direction.DOWN
                    else:
                        typ = FigureType.TRIANGLE_SYM
                    up_line = _line("upper", s.index, up_s, validity_end, ku * validity_end + bu)
                    down_line = _line("lower", s.index, lo_s, validity_end, kl * validity_end + bl)
                    quality = (fit_q + touch_q + g.clamp01(compression / 0.8) + vol) / 4
                else:
                    continue
                extra = {"compression": compression}
            elif abs(au - al) <= tol_deg and p.channel_min_len <= length <= p.channel_max_len:
                mid_deg = (au + al) / 2
                typ = (
                    FigureType.RANGE
                    if abs(mid_deg) <= p.channel_flat_deg
                    else FigureType.CHANNEL_UP
                    if mid_deg > 0
                    else FigureType.CHANNEL_DOWN
                )
                up_line = _line("upper", s.index, up_s, validity_end, ku * validity_end + bu)
                down_line = _line("lower", s.index, lo_s, validity_end, kl * validity_end + bl)
                quality = (fit_q + touch_q + g.clamp01(1 - abs(au - al) / tol_deg)) / 3
                extra = {"slope_deg": mid_deg}
            else:
                continue
            if typ is None or quality < p.min_quality:
                continue
            lines = [ln for ln in (up_line, down_line) if ln is not None]
            if typ in (FigureType.WEDGE_RISING, FigureType.WEDGE_FALLING):
                other = (
                    _line("upper", s.index, up_s, validity_end, ku * validity_end + bu)
                    if down_line
                    else _line("lower", s.index, lo_s, validity_end, kl * validity_end + bl)
                )
                lines = [other, *lines] if down_line else [*lines, other]
            yield Candidate(
                type=typ,
                direction=direction,
                scale=scale,
                points=[_pt(x.index, float(x.price)) for x in window],
                lines=lines,
                start=s.index,
                end=e.index,
                known=known,
                validity_end=validity_end,
                up_line=up_line,
                down_line=down_line,
                height=height,
                invalid_above=invalid_above,
                invalid_below=invalid_below,
                quality=quality,
                metrics={
                    "r2_upper": r2u,
                    "r2_lower": r2l,
                    "touches": float(t_up + t_lo),
                    "upper_deg": au,
                    "lower_deg": al,
                    "volume": vol,
                    **extra,
                },
            )


def flags(ctx: Ctx, scale: int) -> Iterator[Candidate]:
    """Флаг / вымпел: импульс ≥ k ATR за ≤ n свечей, затем консолидация в канале против импульса."""
    p = ctx.p
    n = len(ctx.close)
    for j in range(p.pole_max_candles, n):
        a = ctx.a(j)
        if a <= 0:
            continue
        pole = 0.0
        i0 = j
        for i in range(j - 1, j - p.pole_max_candles - 1, -1):
            move = ctx.close[j] - ctx.close[i]
            if abs(move) >= float(p.pole_min_atr) * a and abs(move) > abs(pole):
                pole, i0 = move, i
        if pole == 0.0:
            continue
        up = pole > 0
        for length in range(p.flag_min_len, p.flag_max_len + 1):
            e = j + length
            if e >= n:
                break
            xs = [float(x) for x in range(j + 1, e + 1)]
            ku, bu, r2u = g.linreg(xs, ctx.high[j + 1 : e + 1])
            kl, bl, r2l = g.linreg(xs, ctx.low[j + 1 : e + 1])
            rng = max(ctx.high[j + 1 : e + 1]) - min(ctx.low[j + 1 : e + 1])
            if rng > p.flag_max_range * abs(pole):
                break
            au, al = g.angle_deg(ku, a), g.angle_deg(kl, a)
            against = (ku <= 0 and kl <= 0) if up else (ku >= 0 and kl >= 0)
            parallel = abs(au - al) <= p.flag_parallel_deg
            conv = ku < kl
            if parallel and against:
                typ = FigureType.FLAG
            elif conv:
                typ = FigureType.PENNANT
            else:
                continue
            nxt = e + 1
            if nxt >= n:
                # консолидация ещё идёт — кандидат «формируется»
                pass
            up_line = _line(
                "upper",
                j + 1,
                ku * (j + 1) + bu,
                e + p.flag_max_len,
                ku * (e + p.flag_max_len) + bu,
            )
            down_line = _line(
                "lower",
                j + 1,
                kl * (j + 1) + bl,
                e + p.flag_max_len,
                kl * (e + p.flag_max_len) + bl,
            )
            vol = g.clamp01(1.5 - ctx.vol_ratio(j + 1, e))
            quality = (
                g.clamp01((r2u + r2l) / 2)
                + g.clamp01(1 - rng / (p.flag_max_range * abs(pole)))
                + vol
            ) / 3
            if quality < p.min_quality:
                continue
            cand = Candidate(
                type=typ,
                direction=Direction.UP if up else Direction.DOWN,
                scale=scale,
                points=[_pt(i0, ctx.close[i0]), _pt(j, ctx.close[j]), _pt(e, ctx.close[e])],
                lines=[up_line, down_line],
                start=i0,
                end=e,
                known=e,
                validity_end=j + p.flag_max_len + 1,
                up_line=up_line if up else None,
                down_line=None if up else down_line,
                height=abs(pole),
                invalid_above=None if up else float(up_line.at(e)),
                invalid_below=float(down_line.at(e)) if up else None,
                quality=quality,
                metrics={
                    "pole_atr": abs(pole) / a,
                    "range_ratio": rng / abs(pole),
                    "r2": (r2u + r2l) / 2,
                    "volume": vol,
                },
            )
            # пробой на следующей свече фиксирует длину; иначе растим консолидацию
            if nxt < n:
                c = ctx.close[nxt]
                if (up and c > float(up_line.at(nxt))) or (not up and c < float(down_line.at(nxt))):
                    yield cand
                    break
                if (up and c < float(down_line.at(nxt))) or (not up and c > float(up_line.at(nxt))):
                    break
            else:
                yield cand
                break


def cups(ctx: Ctx, scale: int) -> Iterator[Candidate]:
    p = ctx.p
    n = len(ctx.close)
    lengths = [L for L in (30, 45, 60, 90, 120, 160, 200) if p.cup_min_len <= L <= p.cup_max_len]
    for e in range(p.cup_min_len, n):
        a = ctx.a(e)
        if a <= 0:
            continue
        for length in lengths:
            s = e - length
            if s < 0:
                break
            lows = ctx.low[s : e + 1]
            xs = [float(i) / length for i in range(length + 1)]
            coef, r2 = g.parabola_r2(xs, lows)
            if coef <= 0 or r2 < p.cup_min_r2:
                continue
            edge = max(3, length // 10)
            rim = min(max(ctx.high[s : s + edge]), max(ctx.high[e - edge + 1 : e + 1]))
            bottom = min(lows)
            depth = rim - bottom
            if not (float(p.cup_depth_min_atr) * a <= depth <= float(p.cup_depth_max_atr) * a):
                continue
            bi = s + lows.index(bottom)
            if not (s + length / 3 <= bi <= e - length / 3):
                continue
            # ручка: откат ≤ 1/3 глубины за 5–25 свечей после края чашки
            handle_end = min(n - 1, e + p.handle_max_len)
            hmin = min(ctx.low[e + 1 : handle_end + 1]) if handle_end > e else rim
            if hmin < rim - p.handle_max_depth * depth:
                continue
            known = min(n - 1, e + p.handle_min_len)
            rim_line = _hline("rim", s, e + p.handle_max_len, rim)
            sym = g.clamp01(1 - abs((bi - s) - (e - bi)) / length)
            vol = g.clamp01(1.5 - ctx.vol_ratio(s, e))
            quality = (r2 + sym + g.clamp01(depth / (4 * a)) + vol) / 4
            if quality < p.min_quality:
                continue
            yield Candidate(
                type=FigureType.CUP_HANDLE,
                direction=Direction.UP,
                scale=scale,
                points=[_pt(s, ctx.high[s]), _pt(bi, bottom), _pt(e, ctx.high[e])],
                lines=[rim_line],
                start=s,
                end=e,
                known=known,
                validity_end=e + p.handle_max_len,
                up_line=rim_line,
                down_line=None,
                height=depth,
                invalid_above=None,
                invalid_below=rim - p.handle_max_depth * depth,
                quality=quality,
                metrics={"r2": r2, "depth_atr": depth / a, "symmetry": sym, "volume": vol},
            )
            break


# --- сборка ---------------------------------------------------------------------------------------


def _overlap(a: Figure, b: Figure) -> bool:
    return a.start_index <= b.end_index and b.start_index <= a.end_index


def dedupe(figs: list[Figure]) -> list[Figure]:
    """Пересекающиеся кандидаты одного типа: остаётся лучший по качеству, при равенстве ранний."""
    out: list[Figure] = []
    for f in sorted(figs, key=lambda x: (-x.quality, x.known_index, x.start_index)):
        if any(o.type is f.type and _overlap(o, f) for o in out):
            continue
        out.append(f)
    return sorted(out, key=lambda x: (x.known_index, x.start_index, x.type.value))


def detect_figures(
    candles: Sequence[Candle], params: FigureParams = DEFAULT_FIGURE_PARAMS
) -> list[Figure]:
    """Все кандидаты (формируется / подтверждена / отменена) по закрытым свечам."""
    n = len(candles)
    if n <= params.warmup:
        return []
    ctx = Ctx(
        candles=candles,
        high=[float(c.high) for c in candles],
        low=[float(c.low) for c in candles],
        close=[float(c.close) for c in candles],
        vol=[float(c.volume) for c in candles],
        atr=[None if v is None else float(v) for v in atr(candles, params.atr_period)],
        p=params,
    )
    found: list[Figure] = []
    for scale in params.swing_lens:
        swings = analyze_structure(candles, StructureParams(swing_len=scale)).swings
        gens: list[Iterator[Candidate]] = [
            double(swings, ctx, scale, True),
            double(swings, ctx, scale, False),
            head_shoulders(swings, ctx, scale, False),
            head_shoulders(swings, ctx, scale, True),
            converging(swings, ctx, scale),
        ]
        if scale == params.swing_lens[0]:
            gens += [flags(ctx, scale), cups(ctx, scale)]
        for gen in gens:
            for cand in gen:
                if cand.known >= n:
                    continue
                fig = resolve(cand, ctx, params.rules_version)
                if fig is not None:
                    found.append(fig)
    return dedupe(found)


def confirmed_only(figs: Sequence[Figure]) -> list[Figure]:
    return [f for f in figs if f.status is FigureStatus.CONFIRMED]


def with_status(figs: Sequence[Figure], status: FigureStatus) -> list[Figure]:
    return [f for f in figs if f.status is status]
