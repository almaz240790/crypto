"""Инкрементальный трекер сигнала (план 2.6, 2.10; этап 2.3).

Та же машина состояний, что в ``backtest.simulate_trade``, но шаг за шагом: трекер принимает
по одной свече и возвращает события. В live и форварде подаются 1m-свечи (план 2.10), в тесте
эквивалентности с ``simulate_trade`` — H4.

Сроки считаются по времени, в свечах сигнального таймфрейма (``SIGNAL_TIMEFRAME``, H4), а не
по числу поданных свечей. Поэтому результат не зависит от того, 1m или H4 подаются на вход:
- рыночный вход — по закрытию сигнальной свечи; если TP1 не достигнут, time stop срабатывает
  на первой поданной свече с ``close_time >= signal_close + time_stop_candles × H4``, выход по
  её close;
- лимитный вход — касание цены входа до ``signal_close + limit_expiry_candles × H4``, иначе
  ``expired`` на свече, чей ``close_time`` достиг этого срока; time stop отсчитывается от начала
  H4-интервала, в котором была активация (свеча активации — первая из ``time_stop_candles``),
  как в ``simulate_trade``.
Пропуски свечей срок не сдвигают: если свечи, закрывающейся ровно на сроке, нет, событие
приходит на первой поданной свече после срока.

Таймфрейм потока задаётся явно (``timeframe``, по умолчанию — сигнальный H4) и проверяется по
сетке ``open_time``: свеча 1m, поданная трекеру H4, вызывает ``ValueError``, а не считается за H4.

Состояния: pending → active → tp1_hit → tp2_hit → closed_tp3 | closed_be | closed_sl |
closed_time; pending → expired. Правило конфликта в одной свече: стоп раньше тейка.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from enum import StrEnum

from engine.candles import SIGNAL_TIMEFRAME, Candle, Timeframe
from engine.params import TradeParams
from engine.structure import Direction
from engine.trade import TradeSetup

_GRID_ORIGIN = datetime(1970, 1, 1, tzinfo=UTC)
"""Начало сетки свечей Binance: интервалы 1m–1d отсчитываются от 1970-01-01 00:00 UTC."""


def interval_start(t: datetime, tf: Timeframe) -> datetime:
    """Начало интервала ``tf``, в который попадает момент ``t`` (для таймфреймов 1m–1d)."""
    return t - (t - _GRID_ORIGIN) % tf.delta


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
    """Порядковый номер поданной свечи после сигнальной (0 — первая)."""
    at: datetime | None = None
    """Момент события — ``close_time`` свечи, на которой оно произошло. В состояниях,
    сохранённых до появления поля, — None."""


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
    """Сколько свечей подано. Справочно: сроки считаются по времени (``deadline_at``)."""
    candles_active: int = 0
    """Сколько свечей сделка активна. Справочно, как и ``candles_seen``."""
    mfe_r: Decimal = Decimal(0)
    mae_r: Decimal = Decimal(0)
    r_if_tp1_only: Decimal | None = None
    r_if_full_tp2: Decimal | None = None
    events: tuple[TrackerEvent, ...] = field(default_factory=tuple)
    activated_at: datetime | None = None
    """Момент входа: рыночный — закрытие сигнальной свечи; лимитный — ``open_time`` свечи, на
    которой цена дошла до входа."""
    deadline_at: datetime | None = None
    """Действующий срок: до входа — истечение лимита, после входа (пока нет TP1) — time stop."""
    last_candle_at: datetime | None = None
    """``open_time`` последней обработанной свечи: по нему проверяются порядок и шаг потока."""


class SignalTracker:
    """Ведёт один сигнал. Неизменяемое состояние — удобно хранить/восстанавливать из БД.

    ``signal_close`` — закрытие сигнальной свечи (``signals.candle_close_time``). Если не задан,
    им считается ``open_time`` первой поданной свечи (как в ``simulate_trade``: первая свеча —
    сразу после сигнальной). Для состояния, сохранённого без сроков (до их появления), он
    обязателен: срок восстанавливается из него.

    ``timeframe`` — таймфрейм поданных свечей. Он должен делить сигнальный (1m, 5m, 15m, 1h, 4h);
    ``open_time`` каждой свечи обязан лежать на его сетке, иначе ``ValueError``.
    """

    def __init__(
        self,
        setup: TradeSetup,
        params: TradeParams,
        entry_type: str = "market",
        state: TrackerState | None = None,
        *,
        signal_close: datetime | None = None,
        timeframe: Timeframe = SIGNAL_TIMEFRAME,
    ) -> None:
        if SIGNAL_TIMEFRAME.delta % timeframe.delta:
            raise ValueError(
                f"таймфрейм потока {timeframe} не делит сигнальный {SIGNAL_TIMEFRAME}: "
                "сроки сделки по нему не определить"
            )
        self.setup = setup
        self.params = params
        self.entry_type = entry_type
        self.timeframe = timeframe
        self.signal_close: datetime | None = None
        if signal_close is not None:
            self.signal_close = self._checked_signal_close(signal_close)
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

    # --- сроки -----------------------------------------------------------------------------------
    @staticmethod
    def _checked_signal_close(t: datetime) -> datetime:
        if t.tzinfo is None or t.utcoffset() != timedelta(0):
            raise ValueError("signal_close должен быть timezone-aware в UTC")
        if interval_start(t, SIGNAL_TIMEFRAME) != t:
            raise ValueError(f"signal_close {t.isoformat()} не на границе {SIGNAL_TIMEFRAME}")
        return t

    def _signal_close_required(self) -> datetime:
        if self.signal_close is None:
            raise ValueError("нужен signal_close: срок сохранённого состояния не восстановить")
        return self.signal_close

    def _expiry_deadline(self) -> datetime:
        return (
            self._signal_close_required()
            + SIGNAL_TIMEFRAME.delta * self.params.limit_expiry_candles
        )

    def _time_stop_deadline(self, activated_at: datetime) -> datetime:
        start = interval_start(activated_at, SIGNAL_TIMEFRAME)
        return start + SIGNAL_TIMEFRAME.delta * self.params.time_stop_candles

    def _legacy_activated_at(self, s: TrackerState) -> datetime:
        """Момент входа для состояния, сохранённого до появления ``activated_at``."""
        signal_close = self._signal_close_required()
        if self.entry_type == "market":
            return signal_close
        ev = next((e for e in s.events if e.type is EventType.ACTIVATED), None)
        if ev is None:
            raise ValueError("в состоянии активного лимитного сигнала нет события активации")
        if ev.at is not None:
            return ev.at - self.timeframe.delta
        # старые события без времени: номер свечи потока от сигнальной (точно при потоке без
        # пропусков; лимитный вход в воркере не используется)
        return signal_close + self.timeframe.delta * ev.candle_index

    def _with_deadline(self, s: TrackerState) -> TrackerState:
        """Заполняет срок у свежего состояния и у состояния, сохранённого без сроков."""
        if s.deadline_at is not None or s.hits > 0:
            return s
        if s.status is SignalStatus.PENDING:
            if self.entry_type == "market":
                return s  # срок появится при входе на первой свече
            return replace(s, deadline_at=self._expiry_deadline())
        activated = s.activated_at or self._legacy_activated_at(s)
        return replace(s, activated_at=activated, deadline_at=self._time_stop_deadline(activated))

    def _check_candle(self, candle: Candle) -> None:
        """Свеча на сетке таймфрейма потока, после сигнальной и после предыдущей поданной."""
        t = candle.open_time
        if interval_start(t, self.timeframe) != t:
            raise ValueError(
                f"свеча {t.isoformat()} не на сетке {self.timeframe}: поток другого таймфрейма?"
            )
        last = self.state.last_candle_at
        if last is not None and t <= last:
            raise ValueError(f"свеча {t.isoformat()} не позже предыдущей {last.isoformat()}")
        if self.signal_close is None and last is None and self.state.candles_seen == 0:
            self.signal_close = self._checked_signal_close(t)
        if self.signal_close is not None and t < self.signal_close:
            raise ValueError(
                f"свеча {t.isoformat()} раньше закрытия сигнальной {self.signal_close.isoformat()}"
            )

    # --- шаг -------------------------------------------------------------------------------------
    def step(self, candle: Candle) -> list[TrackerEvent]:
        """Обрабатывает следующую свечу после сигнальной. Возвращает новые события."""
        s = self.state
        if not s.status.is_open:
            return []
        self._check_candle(candle)
        s = self._with_deadline(s)
        idx = s.candles_seen
        at = candle.close_time(self.timeframe)
        s = replace(s, candles_seen=idx + 1, last_candle_at=candle.open_time)
        new: list[TrackerEvent] = []

        if s.status is SignalStatus.PENDING:
            if self.entry_type == "market":
                activated = self._signal_close_required()
                s = replace(
                    s,
                    status=SignalStatus.ACTIVE,
                    entry_price=self.setup.entry_market,
                    stop=self.setup.stop_loss,
                    activated_at=activated,
                    deadline_at=self._time_stop_deadline(activated),
                )
                new.append(TrackerEvent(EventType.ACTIVATED, self.setup.entry_market, idx, at))
            else:
                expiry = s.deadline_at
                assert expiry is not None
                if candle.open_time < expiry and self._hit_below(candle, self.setup.entry_limit):
                    s = replace(
                        s,
                        status=SignalStatus.ACTIVE,
                        entry_price=self.setup.entry_limit,
                        stop=self.setup.stop_loss,
                        activated_at=candle.open_time,
                        deadline_at=self._time_stop_deadline(candle.open_time),
                    )
                    new.append(TrackerEvent(EventType.ACTIVATED, self.setup.entry_limit, idx, at))
                else:
                    if at >= expiry:
                        s = replace(s, status=SignalStatus.EXPIRED)
                        new.append(TrackerEvent(EventType.EXPIRED, candle.close, idx, at))
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
            new.append(TrackerEvent(EventType.BE if closed_be else EventType.SL, stop, idx, at))
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
            new.append(TrackerEvent(tp_events[hits - 1], tps[hits - 1], idx, at))
            if hits == 3:
                self.state = replace(s, events=(*s.events, *new))
                return new

        deadline = s.deadline_at
        assert s.hits > 0 or deadline is not None
        if s.hits == 0 and deadline is not None and at >= deadline:
            exit_r = r_at(candle.close)
            s = replace(
                s,
                realized_r=s.realized_r + s.remaining * exit_r,
                remaining=Decimal(0),
                r_if_tp1_only=s.r_if_tp1_only if s.r_if_tp1_only is not None else exit_r,
                r_if_full_tp2=s.r_if_full_tp2 if s.r_if_full_tp2 is not None else exit_r,
                status=SignalStatus.CLOSED_TIME,
            )
            new.append(TrackerEvent(EventType.TIME_STOP, candle.close, idx, at))

        self.state = replace(s, events=(*s.events, *new))
        return new

    def run(self, candles: list[Candle]) -> list[TrackerEvent]:
        out: list[TrackerEvent] = []
        for c in candles:
            out.extend(self.step(c))
            if not self.state.status.is_open:
                break
        return out
