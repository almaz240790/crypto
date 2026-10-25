"""Параметры сделки: вход, стоп, тейк-профиты, R:R (план 2.6).

Лонг (шорт зеркально):
- вход рыночный = закрытие сигнальной свечи; лимитный = середина зоны;
- стоп = нижняя граница зоны − max(0.25 × ATR, 0.15 % цены); риск R = вход − стоп;
  если R > 2.5 ATR — отклонение;
- TP1 = вход + 1 R;
- TP2 = ближайший структурный уровень в [1.8 R; 3 R]; уровней в окне нет, но дальше есть —
  3 R; уровней выше вообще нет — 3 R с пометкой; ближайший уровень в [1 R; 1.8 R) — отклонение
  (цель слишком близко, R:R < 1.8);
- TP3 = следующий уровень после TP2 или 4 R — что ближе;
- R:R до TP2 ≥ 1.8, иначе отклонение.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal

from engine.params import TradeParams
from engine.structure import Direction
from engine.zones import Zone


@dataclass(frozen=True, slots=True)
class TradeSetup:
    direction: Direction
    entry_market: Decimal
    entry_limit: Decimal
    stop_loss: Decimal
    tp1: Decimal
    tp2: Decimal
    tp3: Decimal
    risk: Decimal
    """Расстояние от рыночного входа до стопа (1 R) в цене."""
    rr_tp2: Decimal
    notes: tuple[str, ...]

    def r_at(self, price: Decimal) -> Decimal:
        """Результат в R при выходе по цене ``price`` от рыночного входа."""
        sign = 1 if self.direction is Direction.UP else -1
        return (price - self.entry_market) * sign / self.risk


@dataclass(frozen=True, slots=True)
class TradeRejection:
    reason: str


DEFAULT_PARAMS = TradeParams()


def build_trade(
    direction: Direction,
    zone: Zone,
    close: Decimal,
    atr_value: Decimal,
    targets: Sequence[Decimal],
    params: TradeParams = DEFAULT_PARAMS,
) -> TradeSetup | TradeRejection:
    """Собирает сделку по зоне входа, закрытию сигнальной свечи, ATR и структурным уровням.

    ``targets`` — цены-кандидаты для тейков (swing-экстремумы, PDH/PDL, равные уровни);
    берутся только те, что по направлению сделки.
    """
    sign = Decimal(1) if direction is Direction.UP else Decimal(-1)
    notes: list[str] = []

    entry = close
    entry_limit = zone.bottom + zone.height * params.limit_zone_pct
    buffer = max(params.sl_buffer_atr * atr_value, params.sl_buffer_pct * close)
    far_edge = zone.bottom if direction is Direction.UP else zone.top
    stop = far_edge - buffer * sign
    risk = (entry - stop) * sign
    if risk <= 0:
        return TradeRejection("стоп не ниже входа: зона выше цены закрытия")
    if risk > params.max_sl_atr * atr_value:
        return TradeRejection(
            f"стоп слишком широкий: {risk / atr_value:.2f} ATR > {params.max_sl_atr} ATR"
        )

    def level(r: Decimal) -> Decimal:
        return entry + risk * r * sign

    def r_of(price: Decimal) -> Decimal:
        return (price - entry) * sign / risk

    tp1 = level(params.tp1_r)
    ahead = sorted((t for t in targets if (t - entry) * sign > 0), key=lambda t: (t - entry) * sign)
    window = [t for t in ahead if params.tp2_min_r <= r_of(t) <= params.tp2_max_r]
    if window:
        tp2 = window[0]
        notes.append(f"TP2 по структурному уровню {r_of(tp2):.2f} R")
    elif ahead and r_of(ahead[0]) < params.tp2_min_r and r_of(ahead[0]) >= params.tp1_r:
        return TradeRejection(
            f"ближайший уровень {ahead[0]} на {r_of(ahead[0]):.2f} R — "
            f"цель ближе {params.tp2_min_r} R"
        )
    else:
        tp2 = level(params.tp2_max_r)
        notes.append(
            f"TP2 = {params.tp2_max_r} R: структурного уровня в окне нет"
            + ("" if ahead else " (уровней по направлению нет)")
        )

    after = [t for t in ahead if (t - tp2) * sign > 0]
    tp3_default = level(params.tp3_r)
    if after and (after[0] - entry) * sign < (tp3_default - entry) * sign:
        tp3 = after[0]
        notes.append(f"TP3 по структурному уровню {r_of(tp3):.2f} R")
    else:
        tp3 = tp3_default
        notes.append(f"TP3 = {params.tp3_r} R")

    rr_tp2 = r_of(tp2)
    if rr_tp2 < params.min_rr:
        return TradeRejection(f"R:R до TP2 {rr_tp2:.2f} < {params.min_rr}")

    return TradeSetup(
        direction=direction,
        entry_market=entry,
        entry_limit=entry_limit,
        stop_loss=stop,
        tp1=tp1,
        tp2=tp2,
        tp3=tp3,
        risk=risk,
        rr_tp2=rr_tp2,
        notes=tuple(notes),
    )
