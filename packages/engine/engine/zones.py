"""Зоны интереса: order block, зона спроса/предложения, FVG (план 2.4).

Зоны выводятся из событий структуры (BOS/CHoCH) и становятся известны на свече, которая
подтвердила пробой, — раньше их нет (нет перерисовки). Дальше по ходу свечей зона
меняет только статус: ``touched`` (цена вошла в зону) и ``invalidated`` (закрытие за
дальней границей). Границы и свечи-источники после создания не меняются.

Для направления вверх (лонг):
- OB — последняя медвежья свеча на отрезке от swing-источника до свечи пробоя;
  зона от её low до open (консервативно) или до high (агрессивно, параметр).
- S/D — база консолидации из 1–3 свечей с телом < 50 % диапазона перед импульсом
  ≥ ``sd_min_impulse_atr`` × ATR; зона — от low до high базы.
- FVG — разрыв между high свечи m−1 и low свечи m+1 внутри импульсной ноги.
Для направления вниз — зеркально.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace
from decimal import Decimal
from enum import StrEnum

from engine.candles import Candle
from engine.indicators import atr
from engine.params import ZoneParams
from engine.structure import Direction, MarketStructure, StructureEvent


class ZoneKind(StrEnum):
    OB = "ob"
    SD = "sd"
    FVG = "fvg"


class ZoneStatus(StrEnum):
    ACTIVE = "active"
    TOUCHED = "touched"
    INVALIDATED = "invalidated"


@dataclass(frozen=True, slots=True)
class Zone:
    kind: ZoneKind
    direction: Direction
    """UP — зона спроса (для лонга), DOWN — зона предложения (для шорта)."""
    top: Decimal
    bottom: Decimal
    created_index: int
    """Свеча пробоя структуры, на закрытии которой зона стала известна."""
    source_start: int
    source_end: int
    """Диапазон свечей-источников (включительно)."""
    event_index: int
    touched_index: int | None = None
    invalidated_index: int | None = None

    @property
    def status(self) -> ZoneStatus:
        if self.invalidated_index is not None:
            return ZoneStatus.INVALIDATED
        if self.touched_index is not None:
            return ZoneStatus.TOUCHED
        return ZoneStatus.ACTIVE

    @property
    def mid(self) -> Decimal:
        return (self.top + self.bottom) / 2

    @property
    def height(self) -> Decimal:
        return self.top - self.bottom

    def overlaps(self, other: Zone) -> bool:
        return self.bottom <= other.top and other.bottom <= self.top


def _order_block(
    candles: Sequence[Candle], event: StructureEvent, params: ZoneParams
) -> Zone | None:
    if event.origin_swing is None:
        return None
    start, end = event.origin_swing.index, event.index
    up = event.direction is Direction.UP
    for j in range(end - 1, start - 1, -1):
        c = candles[j]
        if up and c.close < c.open:
            top = c.high if params.ob_aggressive else c.open
            return Zone(ZoneKind.OB, Direction.UP, top, c.low, end, j, j, end)
        if not up and c.close > c.open:
            bottom = c.low if params.ob_aggressive else c.open
            return Zone(ZoneKind.OB, Direction.DOWN, c.high, bottom, end, j, j, end)
    return None


def _supply_demand(
    candles: Sequence[Candle],
    event: StructureEvent,
    atr_values: Sequence[Decimal | None],
    params: ZoneParams,
) -> Zone | None:
    if event.origin_swing is None:
        return None
    start, end = event.origin_swing.index, event.index
    up = event.direction is Direction.UP
    for k in range(end - 1, start - 1, -1):
        a = atr_values[k]
        if a is None:
            return None
        # база: подряд идущие свечи с малым телом, заканчивающиеся на k
        base: list[Candle] = []
        j = k
        while j >= start and len(base) < params.sd_base_max_candles:
            c = candles[j]
            if c.range == 0 or c.body / c.range >= params.sd_body_max_ratio:
                break
            base.append(c)
            j -= 1
        if not base:
            continue
        lo = min(c.low for c in base)
        hi = max(c.high for c in base)
        after = candles[k + 1 : end + 1]
        impulse = (max(c.high for c in after) - lo) if up else (hi - min(c.low for c in after))
        if impulse >= params.sd_min_impulse_atr * a:
            direction = Direction.UP if up else Direction.DOWN
            return Zone(ZoneKind.SD, direction, hi, lo, end, j + 1, k, end)
    return None


def _fair_value_gaps(candles: Sequence[Candle], event: StructureEvent) -> list[Zone]:
    if event.origin_swing is None:
        return []
    start, end = event.origin_swing.index, event.index
    up = event.direction is Direction.UP
    out: list[Zone] = []
    for m in range(start + 1, end):
        prev, nxt = candles[m - 1], candles[m + 1]
        if up and nxt.low > prev.high:
            out.append(Zone(ZoneKind.FVG, Direction.UP, nxt.low, prev.high, end, m - 1, m + 1, end))
        elif not up and nxt.high < prev.low:
            out.append(
                Zone(ZoneKind.FVG, Direction.DOWN, prev.low, nxt.high, end, m - 1, m + 1, end)
            )
    return out


def _update_status(zone: Zone, candles: Sequence[Candle], upto: int) -> Zone:
    """Статус по свечам после создания и до ``upto`` включительно."""
    touched = zone.touched_index
    for i in range(zone.created_index + 1, upto + 1):
        c = candles[i]
        if zone.direction is Direction.UP:
            if c.close < zone.bottom:
                return replace(zone, touched_index=touched, invalidated_index=i)
            if touched is None and c.low <= zone.top:
                touched = i
        else:
            if c.close > zone.top:
                return replace(zone, touched_index=touched, invalidated_index=i)
            if touched is None and c.high >= zone.bottom:
                touched = i
    return replace(zone, touched_index=touched)


DEFAULT_PARAMS = ZoneParams()


def analyze_zones(
    candles: Sequence[Candle],
    structure: MarketStructure,
    params: ZoneParams = DEFAULT_PARAMS,
) -> list[Zone]:
    """Зоны по всем событиям структуры со статусом на последней свече."""
    if not candles:
        return []
    atr_values = atr(candles, params.atr_period)
    last = len(candles) - 1
    zones: list[Zone] = []
    for event in structure.events:
        created: list[Zone] = []
        ob = _order_block(candles, event, params)
        if ob is not None:
            created.append(ob)
        sd = _supply_demand(candles, event, atr_values, params)
        if sd is not None:
            created.append(sd)
        created.extend(_fair_value_gaps(candles, event))
        zones.extend(_update_status(z, candles, last) for z in created)
    return zones


def active_zones(zones: Sequence[Zone], direction: Direction | None = None) -> list[Zone]:
    return [
        z
        for z in zones
        if z.status is not ZoneStatus.INVALIDATED
        and (direction is None or z.direction is direction)
    ]
