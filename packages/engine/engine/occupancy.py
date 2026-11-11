"""Одна открытая сделка на инструмент и версию стратегии (CLAUDE.md «одна кодовая база»; 10.3,
задачи 1.11 и 2.2).

Общее правило бэктеста (``run_backtest``), scheduler и forward (``app.forward.write_candidate``):
на закрытии свечи H4 ``at`` новый сигнал по инструменту не создаётся, пока у той же версии
стратегии по этому инструменту есть сделка. Инструмент занят в момент ``at``, если у сигнала,
опубликованного раньше ``at``:

- сделка ещё не закончилась — статус pending, active, tp1_hit или tp2_hit; или
- сделка закончилась (закрыта, лимит истёк, сигнал отменён) внутри свечи сигнального таймфрейма,
  которая закрывается в ``at``, или позже: ``ended_at > at − H4``. Так бэктест пропускает и свечу
  H4, на которой закрылась прежняя сделка (раньше — условие ``i <= busy_until``). Закрытие ровно в
  ``at − H4`` относится к предыдущей свече и инструмент на ``at`` не занимает.

Сделка — то, что торгует бэктест: публикуемый (градация не ниже C) и не отложенный сигнал. Кандидаты
ниже C forward хранит для анализа (план 2.7), но в правило их не передаёт, как и бэктест.

Время конца, если оно известно, важнее статуса: при пересчёте задним числом сигнал, закрывшийся
после ``at``, на момент ``at`` был открыт. Сигнал, опубликованный в ``at`` или позже, на ``at``
не влияет.

Лимитный вход. Живой режим не знает заранее, истечёт ли лимит, поэтому ожидающий лимит (pending)
занимает инструмент, а истёкший — ещё и свечу, на которой истёк. Бэктест исход знает
(``simulate_trade``): истёкший лимит сделкой не был, и бэктест его в правило не передаёт
(``backtest_span``). Это единственное расхождение; сейчас scheduler и forward используют только
рыночный вход.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final

from engine.candles import SIGNAL_TIMEFRAME, interval_start

OPEN_STATUSES: Final = frozenset({"pending", "active", "tp1_hit", "tp2_hit"})
"""Статусы незаконченной сделки — те же, что ``engine.tracker.SignalStatus.is_open``."""


@dataclass(frozen=True, slots=True)
class TradeSpan:
    """Прежний сигнал той же версии по тому же инструменту — всё, что нужно правилу."""

    ref: str
    """Идентификатор для журнала: ``public_id`` сигнала, в бэктесте — время сигнала."""
    opened_at: datetime
    """Закрытие сигнальной свечи (``signals.candle_close_time``)."""
    status: str
    """Статус сигнала (``signals.status``, значения ``SignalStatus``)."""
    ended_at: datetime | None = None
    """Когда сделка закончилась: ``close_time`` свечи выхода (``signal_results.closed_at``),
    истечения лимита или момент отмены. None — не закончилась или время неизвестно."""


def _check_at(at: datetime) -> None:
    if at.tzinfo is None or at.utcoffset() != timedelta(0):
        raise ValueError("at должен быть timezone-aware в UTC")
    if interval_start(at, SIGNAL_TIMEFRAME) != at:
        raise ValueError(f"at {at.isoformat()} не на закрытии свечи {SIGNAL_TIMEFRAME}")


def occupies(span: TradeSpan, at: datetime) -> bool:
    """Занимает ли сигнал ``span`` инструмент на закрытии свечи H4 ``at``."""
    if span.opened_at >= at:
        return False
    if span.ended_at is not None:
        return span.ended_at > at - SIGNAL_TIMEFRAME.delta
    return span.status in OPEN_STATUSES


def occupying(spans: Iterable[TradeSpan], at: datetime) -> TradeSpan | None:
    """Сигнал, из-за которого инструмент занят на закрытии ``at``; None — инструмент свободен.

    ``spans`` — сигналы одной версии по одному инструменту в любом порядке; ``at`` — закрытие
    свечи сигнального таймфрейма (timezone-aware, UTC), иначе ``ValueError``.
    """
    _check_at(at)
    return next((s for s in spans if occupies(s, at)), None)
