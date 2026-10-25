"""Инкрементальный трекер сигнала (план 2.10; этап 2.3).

Та же машина состояний, что в ``backtest.simulate_trade``, но шаг за шагом: трекер принимает
по одной свече (1m в live, H4 в форварде) и возвращает события. Эквивалентность с
``simulate_trade`` на одинаковом ряде свечей проверяется тестом.

Состояния: pending → active → tp1_hit → tp2_hit → closed_tp3 | closed_be | closed_sl |
closed_time; pending → expired. Правило конфликта в одной свече: стоп раньше тейка.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from decimal import Decimal
from enum import StrEnum

from engine.candles import Candle
from engine.params import TradeParams
from engine.structure import Direction
from engine.trade import TradeSetup


class SignalStatus(StrEnum):
    PENDING = "pending"
    ACTIVE = "active"
    TP1_HIT = "tp1_hit"
    TP2_HIT = "tp2_hit"
    CLOSED_TP3 = "closed_tp3"
    CLOSED_BE = "closed_be"
    CLOSED_SL = "closed_sl"
    CLOSED_TIME = "closed_time"
    EXPIRED = "expired"
    CANCELLED = "cancelled"

    @property
    def is_open(self) -> bool:
        return self in (
            SignalStatus.PENDING,
            SignalStatus.ACTIVE,
            SignalStatus.TP1_HIT,
            SignalStatus.TP2_HIT,
        )

    @property
    def is_closed(self) -> bool:
        return self.startswith("closed")


class EventType(StrEnum):
    ACTIVATED = "activated"
    TP1 = "tp1"
    TP2 = "tp2"
    TP3 = "tp3"
    BE = "be"
    SL = "sl"
    TIME_STOP = "time_stop"
    EXPIRED = "expired"


@dataclass(frozen=True, slots=True)
class TrackerEvent:
    type: EventType
    price: Decimal
    candle_index: int
    """Порядковый номер свечи после сигнальной (0 — первая)."""


@dataclass(frozen=True, slots=True)
class TrackerState:
    status: SignalStatus = SignalStatus.PENDING
    entry_price: Decimal | None = None
    stop: Decimal | None = None
    hits: int = 0
    realized_r: Decimal = Decimal(0)
    """Накопленный результат закрытых долей (без комиссий)."""
    remaining: Decimal = Decimal(1)
    candles_seen: int = 0
    candles_active: int = 0
    mfe_r: Decimal = Decimal(0)
    mae_r: Decimal = Decimal(0)
    r_if_tp1_only: Decimal | None = None
    r_if_full_tp2: Decimal | None = None
    events: tuple[TrackerEvent, ...] = field(default_factory=tuple)


class SignalTracker:
    """Ведёт один сигнал. Неизменяемое состояние — удобно хранить/восстанавливать из БД."""

    def __init__(
        self,
        setup: TradeSetup,
        params: TradeParams,
        entry_type: str = "market",
        state: TrackerState | None = None,
    ) -> None:
        self.setup = setup
        self.params = params
        self.entry_type = entry_type
        self.state = state or TrackerState()
        self._up = setup.direction is Direction.UP
        self._sign = Decimal(1) if self._up else Decimal(-1)

    # --- вспомогательное -----------------------------------------------------------------------
    def _hit_below(self, c: Candle, price: Decimal) -> bool:
        return c.low <= price if self._up else c.high >= price

    def _hit_above(self, c: Candle, price: Decimal) -> bool:
        return c.high >= price if self._up else c.low <= price

    def _risk(self, entry: Decimal) -> Decimal:
        return (entry - self.setup.stop_loss) * self._sign

    def r_at(self, price: Decimal) -> Decimal:
        entry = self.state.entry_price
        if entry is None:
            raise ValueError("сигнал ещё не активирован")
        return (price - entry) * self._sign / self._risk(entry)

    # --- шаг -------------------------------------------------------------------------------------
    def step(self, candle: Candle) -> list[TrackerEvent]:
        """Обрабатывает следующую свечу после сигнальной. Возвращает новые события."""
        s = self.state
        if not s.status.is_open:
            return []
        idx = s.candles_seen
        s = replace(s, candles_seen=idx + 1)
        new: list[TrackerEvent] = []

        if s.status is SignalStatus.PENDING:
            if self.entry_type == "market":
                s = replace(
                    s,
                    status=SignalStatus.ACTIVE,
                    entry_price=self.setup.entry_market,
                    stop=self.setup.stop_loss,
                )
                new.append(TrackerEvent(EventType.ACTIVATED, self.setup.entry_market, idx))
            elif self._hit_below(candle, self.setup.entry_limit):
                s = replace(
                    s,
                    status=SignalStatus.ACTIVE,
                    entry_price=self.setup.entry_limit,
                    stop=self.setup.stop_loss,
                )
                new.append(TrackerEvent(EventType.ACTIVATED, self.setup.entry_limit, idx))
            else:
                if idx + 1 >= self.params.limit_expiry_candles:
                    s = replace(s, status=SignalStatus.EXPIRED)
                    new.append(TrackerEvent(EventType.EXPIRED, candle.close, idx))
                self.state = replace(s, events=(*s.events, *new))
                return new

        assert s.entry_price is not None and s.stop is not None
        entry, stop = s.entry_price, s.stop
        risk = self._risk(entry)

        def r_at(price: Decimal) -> Decimal:
            return (price - entry) * self._sign / risk

        s = replace(
            s,
            candles_active=s.candles_active + 1,
            mfe_r=max(s.mfe_r, r_at(candle.high if self._up else candle.low)),
            mae_r=min(s.mae_r, r_at(candle.low if self._up else candle.high)),
        )

        if self._hit_below(candle, stop):
            exit_r = r_at(stop)
            closed_be = s.hits >= 1 and self.params.be_after_tp1
            s = replace(
                s,
                realized_r=s.realized_r + s.remaining * exit_r,
                remaining=Decimal(0),
                r_if_tp1_only=s.r_if_tp1_only if s.r_if_tp1_only is not None else exit_r,
                r_if_full_tp2=s.r_if_full_tp2 if s.r_if_full_tp2 is not None else exit_r,
                status=SignalStatus.CLOSED_BE if closed_be else SignalStatus.CLOSED_SL,
            )
            new.append(TrackerEvent(EventType.BE if closed_be else EventType.SL, stop, idx))
            self.state = replace(s, events=(*s.events, *new))
            return new

        tps = (self.setup.tp1, self.setup.tp2, self.setup.tp3)
        tp_events = (EventType.TP1, EventType.TP2, EventType.TP3)
        while s.hits < 3 and self._hit_above(candle, tps[s.hits]):
            tp_r = r_at(tps[s.hits])
            share = self.params.split[s.hits]
            hits = s.hits + 1
            s = replace(
                s,
                realized_r=s.realized_r + share * tp_r,
                remaining=s.remaining - share,
                hits=hits,
                status={
                    1: SignalStatus.TP1_HIT,
                    2: SignalStatus.TP2_HIT,
                    3: SignalStatus.CLOSED_TP3,
                }[hits],
                stop=entry if (hits == 1 and self.params.be_after_tp1) else s.stop,
                r_if_tp1_only=tp_r if hits == 1 else s.r_if_tp1_only,
                r_if_full_tp2=tp_r if (hits == 2 and s.r_if_full_tp2 is None) else s.r_if_full_tp2,
            )
            new.append(TrackerEvent(tp_events[hits - 1], tps[hits - 1], idx))
            if hits == 3:
                self.state = replace(s, events=(*s.events, *new))
                return new

        if s.hits == 0 and s.candles_active >= self.params.time_stop_candles:
            exit_r = r_at(candle.close)
            s = replace(
                s,
                realized_r=s.realized_r + s.remaining * exit_r,
                remaining=Decimal(0),
                r_if_tp1_only=s.r_if_tp1_only if s.r_if_tp1_only is not None else exit_r,
                r_if_full_tp2=s.r_if_full_tp2 if s.r_if_full_tp2 is not None else exit_r,
                status=SignalStatus.CLOSED_TIME,
            )
            new.append(TrackerEvent(EventType.TIME_STOP, candle.close, idx))

        self.state = replace(s, events=(*s.events, *new))
        return new

    def run(self, candles: list[Candle]) -> list[TrackerEvent]:
        out: list[TrackerEvent] = []
        for c in candles:
            out.extend(self.step(c))
            if not self.state.status.is_open:
                break
        return out
