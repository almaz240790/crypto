"""Жизненный цикл сигнала: статусы и правило «одна открытая сделка на инструмент и версию».

Правило (задача 6 пакета «Сигналы»; CLAUDE.md — «одна кодовая база для live, forward и
backtest») живёт здесь и больше нигде: его вызывают ``run_backtest`` и запись кандидата в
``signals`` (scheduler и форвард, ``app.forward.write_candidate``), на него же опирается пометка
пересечений в отчёте пересчёта (``app.retrack.open_trade_overlap``).

**Правило.** У версии стратегии по инструменту не больше одной сделки за раз. На вход подаются
сигналы одной версии по одному инструменту (``SignalLife``), поэтому сделки разных версий по
одному инструменту друг другу не мешают. Инструмент занят в момент ``at`` — закрытие сигнальной
свечи нового кандидата, — если среди сигналов, появившихся раньше ``at``, есть:

- сигнал в открытом статусе: ``pending``, ``active``, ``tp1_hit``, ``tp2_hit``;
- или сделка, закрывшаяся внутри свечи сигнального таймфрейма, которая заканчивается в ``at``
  (``closed_at > at − H4``): свеча выхода тоже пропускается. Сделка, закрывшаяся ровно на
  открытии этой свечи (``closed_at == at − H4``) или раньше, инструмент не занимает.

Статусы ``expired`` и ``cancelled`` инструмент не занимают: сделки по такому сигналу нет.

Сигнал здесь — кандидат, который стал сделкой. Кандидат ниже порога публикации и отложенный
кандидат (``SignalCandidate.publishable`` = False) в бэктесте сделкой не становятся и на вход
правила не попадают; так же отбирает строки и запись кандидата в форварде и live.

**Без утечки будущего.** Сигнал, появившийся в ``at`` или позже, на ответ не влияет. Для
сделки, открытой к моменту ``at``, ответ не зависит от того, известно ли уже её закрытие после
``at``: и «ещё открыта», и «закрылась позже ``at``» дают одно и то же «занят».

**Лимитный вход — расхождение бэктеста и живого режима.** Бэктест знает исход ордера сразу:
истёкший лимит приходит со статусом ``expired`` и инструмент не занимает ни на одной свече.
Живой режим заранее не знает, истечёт ли ордер, поэтому ожидающий лимит (``pending``) считается
открытым, пока не истечёт. Сейчас везде используется рыночный вход, и расхождения нет.
То же с отменой вручную (в бэктесте её нет): до отмены сигнал открыт и инструмент занимает,
после (``cancelled``) — уже нет, без пропуска свечи.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum

from engine.candles import SIGNAL_TIMEFRAME


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


def _require_utc(name: str, t: datetime) -> None:
    if t.tzinfo is None or t.utcoffset() != timedelta(0):
        raise ValueError(f"{name} должен быть timezone-aware в UTC")


@dataclass(frozen=True, slots=True)
class SignalLife:
    """Сигнал версии по инструменту глазами правила «одна открытая сделка».

    Больше правилу ничего не нужно, поэтому описание одинаково собирается и из сделки бэктеста,
    и из строк ``signals`` / ``signal_results``.
    """

    ref: str
    """Идентификатор сигнала для журнала и отчёта (``public_id``; в бэктесте — инструмент и
    время). На ответ правила не влияет, только выбирает из двух одновременных сигналов один."""
    opened_at: datetime
    """Закрытие сигнальной свечи (``signals.candle_close_time``), UTC."""
    status: SignalStatus
    closed_at: datetime | None = None
    """Время закрытия сделки (``signal_results.closed_at``), UTC. У статуса ``closed_*``
    обязательно; у остальных статусов не используется."""

    def __post_init__(self) -> None:
        _require_utc("opened_at", self.opened_at)
        if self.closed_at is not None:
            _require_utc("closed_at", self.closed_at)
            if self.closed_at < self.opened_at:
                raise ValueError(
                    f"сигнал {self.ref}: закрытие {self.closed_at.isoformat()} раньше "
                    f"сигнальной свечи {self.opened_at.isoformat()}"
                )
        elif self.status.is_closed:
            raise ValueError(f"сигнал {self.ref}: статус {self.status} без времени закрытия")


def _blocks(signal: SignalLife, at: datetime) -> bool:
    if signal.opened_at >= at:
        return False  # появился не раньше ``at``: для этого момента он — будущее
    if signal.status.is_open:
        return True
    closed_at = signal.closed_at
    return (
        signal.status.is_closed
        and closed_at is not None
        and closed_at > at - SIGNAL_TIMEFRAME.delta
    )


def blocking_signal(signals: Iterable[SignalLife], at: datetime) -> SignalLife | None:
    """Сигнал, из-за которого инструмент занят в момент ``at``; ``None`` — инструмент свободен.

    ``signals`` — сигналы **одной версии по одному инструменту**, в любом порядке; можно со
    всей историей и с более поздними сигналами — лишние правило отбросит само. ``at`` — закрытие
    сигнальной свечи кандидата, UTC. Если мешают несколько сигналов (записанные до появления
    правила), возвращается самый ранний: по ``opened_at``, затем по ``ref``.
    """
    _require_utc("at", at)
    blockers = [s for s in signals if _blocks(s, at)]
    return min(blockers, key=lambda s: (s.opened_at, s.ref), default=None)
