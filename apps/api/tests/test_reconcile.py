"""Ежедневная сверка сигналов с офлайн-пересчётом (задача 8 пакета «Сигналы», план 2.8, раздел 11).

Критерии приёмки — тесты с подставленными расхождениями (изменённый стоп, закрытие через 15
минут, два открытых сигнала по инструменту, изменённая свеча во входных данных): каждое даёт
расхождение нужного типа; на корректных данных — ноль расхождений.

Сценарий на БД (нужен DATABASE_URL с миграциями до head; без БД эти тесты пропускаются) строится
боевым кодом: свечи пишутся в ``candles``, сигнал находит ``evaluate`` на входе из
``forward.load_inputs`` и пишет ``forward.write_candidate``, сделку ведёт
``workers.tracker.apply_candles``. Всё идёт во внешней транзакции и откатывается в конце.
"""

from __future__ import annotations

import json
import logging
import secrets
from collections.abc import Callable, Iterator
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Connection, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

import app.monitor as monitor
import app.workers.notifier as notifier
import app.workers.scheduler as scheduler
import app.workers.tracker as worker
from app.db import engine
from app.forward import load_inputs, upsert_candles, write_candidate
from app.models import (
    Incident,
    Instrument,
    Signal,
    SignalEvent,
    SignalResult,
    SignalTracking,
    Strategy,
    StrategyVersion,
)
from app.monitor import DEGRADED, DOWN, OK, reconcile_component, send_alerts, sync_incidents
from app.reconcile import (
    CRITICAL,
    LAG_GRACE,
    WARNING,
    Finding,
    Kind,
    OpenTrade,
    Publication,
    Report,
    check_invariants,
    check_replay,
    check_result,
    check_tracking,
    compare_h4,
    compare_minutes,
    open_overlaps,
    run_reconcile,
)
from app.retrack import (
    Completeness,
    H4Retrack,
    MinuteRetrack,
    Outcome,
    SignalRow,
    TrackedEvent,
    read_only_connection,
)
from engine.candles import Candle, Timeframe
from engine.derivatives import FundingRate, LongShortRatio, OpenInterest
from engine.params import FilterParams, StrategyParams
from engine.scoring import Grade
from engine.signal import (
    MarketInputs,
    SignalCandidate,
    evaluate,
    inputs_fingerprint,
    inputs_upto,
)
from engine.strategies import STRATEGIES

D = Decimal
H4 = Timeframe.H4.delta
M1 = Timeframe.M1.delta
T0 = datetime(2026, 9, 1, tzinfo=UTC)


# --- рынок, на котором движок даёт сигнал (как в packages/engine/tests/test_signal.py) ----------


def _ohlc(rows: list[tuple[float, float, float, float]], start: datetime) -> list[Candle]:
    return [
        Candle(start + H4 * i, D(str(o)), D(str(h)), D(str(lo)), D(str(c)), D(1))
        for i, (o, h, lo, c) in enumerate(rows)
    ]


def _zigzag(
    n: int, tf: Timeframe, start_price: float, step: float, start: datetime
) -> list[Candle]:
    out = []
    for i in range(n):
        leg, pos = i // 4, i % 4
        base = start_price + step * leg + (3.0 if pos == 2 else 0)
        close = base + (0.5 if pos in (1, 2) else -0.5)
        out.append(
            Candle(
                start + tf.delta * i,
                D(str(base)),
                D(str(max(base, close) + 1)),
                D(str(min(base, close) - 1)),
                D(str(close)),
                D(1),
            )
        )
    return out


FLAT = [(100, 101, 99, 100)] * 260
SETUP = [
    (100, 102, 98, 101),
    (101, 103, 99, 102),
    (102, 105, 101, 104),
    (104, 104.5, 100, 101),
    (101, 102, 99, 100),
    (100, 101, 97, 98),
    (99, 99.5, 97.5, 98.8),
    (98.8, 101, 97.8, 100.5),
    (100.5, 104, 100, 103.5),
    (103.5, 108, 103, 107),  # BOS вверх
    (107, 109, 106, 108),
    (107, 107.5, 98.8, 99.5),  # первый ретест ордер-блока — сигнальная свеча
]
AT = T0 + H4 * (len(FLAT) + len(SETUP))
"""Закрытие сигнальной свечи."""
NOW = AT + H4 * 2
PARAMS = StrategyParams(filters=FilterParams(atr_min_history=10**6))  # ATR-режим не проверяем


def _market() -> MarketInputs:
    return MarketInputs(
        symbol="RECUSDT",
        h4=_ohlc([*FLAT, *SETUP], T0),
        d1=_zigzag(120, Timeframe.D1, 100, 2, T0 - timedelta(days=120)),
        w1=_zigzag(40, Timeframe.W1, 100, 2, T0 - timedelta(weeks=40)),
    )


def _candidate(inputs: MarketInputs | None = None) -> SignalCandidate:
    res = evaluate(inputs or _market(), AT, PARAMS)
    assert isinstance(res, SignalCandidate), res
    return res


# --- строки для чистых проверок ----------------------------------------------------------------

OPEN_OUTCOME = Outcome("active", 0, None, None, None, None)


def _closed(status: str, r: str, at: datetime, hits: int = 0, cost: str | None = "0.07") -> Outcome:
    return Outcome(
        status,
        hits,
        D(r),
        None if cost is None else D(cost),
        at,
        D((at - AT).total_seconds()) / 3600,
    )


def _row(cand: SignalCandidate, recorded: Outcome = OPEN_OUTCOME, **kw: Any) -> SignalRow:
    """Сигнал, каким его записал бы ``write_candidate`` (числа — с точностью колонок БД)."""
    t = cand.trade
    q = D("0.0000000001")
    fields: dict[str, Any] = dict(
        id=1,
        public_id="abc1234567",
        strategy="trend-ob-retest",
        version="1.0.0",
        strategy_version_id=1,
        instrument_id=1,
        symbol="RECUSDT",
        scope="forward",
        direction="long",
        grade=cand.score.grade.value,
        score=cand.score.total,
        candle_close_time=AT,
        entry_market=t.entry_market.quantize(q),
        entry_limit=t.entry_limit.quantize(q),
        stop_loss=t.stop_loss.quantize(q),
        tp1=t.tp1.quantize(q),
        tp2=t.tp2.quantize(q),
        tp3=t.tp3.quantize(q),
        rr_tp2=t.rr_tp2.quantize(D("0.001")),
        recorded=recorded,
    )
    fields.update(kw)
    return SignalRow(**fields)


def _pub(cand: SignalCandidate, inputs: MarketInputs | None = None, **kw: Any) -> Publication:
    fields: dict[str, Any] = dict(
        input_hash=cand.input_hash,
        fingerprint=inputs_fingerprint(inputs or _market(), AT),
        inputs_upto=inputs_upto(inputs or _market(), AT),
        publishable=cand.score.publishable,
        deferred=cand.deferred,
        first_event_at=None,
        entry_type=None,
        tracked_to=None,
    )
    fields.update(kw)
    return Publication(**fields)


# --- 1. сигнал воспроизводится -----------------------------------------------------------------


def test_recorded_signal_is_reproduced_on_the_same_inputs() -> None:
    cand = _candidate()
    assert check_replay(_row(cand), _pub(cand), _market(), PARAMS) is None


def test_changed_stop_on_the_same_inputs_is_a_logic_mismatch() -> None:
    """Изменённый стоп: вход тот же (отпечаток совпал), а торговое поле другое — критично."""
    cand = _candidate()
    moved = cand.trade.stop_loss - D("0.5")
    finding = check_replay(_row(cand, stop_loss=moved), _pub(cand), _market(), PARAMS)
    assert finding is not None and finding.kind is Kind.LOGIC and finding.severity == CRITICAL
    assert "стоп" in finding.message and "тот же вход" in finding.message
    # другое направление, скоринг, порог публикации — тоже торговые поля сигнала
    for change in ({"direction": "short"}, {"score": cand.score.total + 1}, {"grade": "A"}):
        other = check_replay(_row(cand, **change), _pub(cand), _market(), PARAMS)
        assert other is not None and other.kind is Kind.LOGIC, change
    hidden = check_replay(_row(cand), _pub(cand, publishable=False), _market(), PARAMS)
    assert hidden is not None and "выше порога публикации" in hidden.message


def test_changed_h4_candle_is_reported_as_changed_inputs() -> None:
    """Изменённая свеча H4: ``input_hash`` уже не тот, с которым сигнал записан."""
    cand = _candidate()
    market = _market()
    touched = replace(market.h4[-5], volume=D(7))
    changed = replace(market, h4=[*market.h4[:-5], touched, *market.h4[-4:]])
    finding = check_replay(_row(cand), _pub(cand), changed, PARAMS)
    assert finding is not None and finding.kind is Kind.INPUTS and finding.severity == WARNING
    assert "input_hash" in finding.message


def test_changed_context_explains_a_different_signal() -> None:
    """Свечи H4 те же, а старший таймфрейм в БД изменился и bias пропал: это изменившиеся входные
    данные (отпечаток показывает ряд), а не расхождение логики."""
    cand = _candidate()
    market = _market()
    flat_d1 = [replace(c, open=D(100), high=D(101), low=D(99), close=D(100)) for c in market.d1]
    changed = replace(market, d1=flat_d1)
    finding = check_replay(_row(cand), _pub(cand), changed, PARAMS)
    assert finding is not None and finding.kind is Kind.INPUTS
    assert "изменились ряды: d1" in finding.message and "сигнала нет" in finding.message


def test_changed_data_that_does_not_change_the_signal_is_not_reported() -> None:
    """Запись funding пришла по REST уже после оценки: вход другой, сигнал тот же — молчим."""
    cand = _candidate()
    later = replace(_market(), funding=[FundingRate(AT - timedelta(hours=8), D("0.0001"))])
    assert inputs_fingerprint(later, AT) != inputs_fingerprint(_market(), AT)
    assert _candidate(later).trade == cand.trade
    assert check_replay(_row(cand), _pub(cand), later, PARAMS) is None


def test_rows_that_arrive_after_the_run_do_not_hide_a_logic_mismatch() -> None:
    """Funding, OI и long/short с временем ровно ``at`` приходят в БД по REST после оценки: живой
    прогон их не видел, пересчёт на следующий день — видит. Сверка обрезает ряды по отметкам,
    записанным с сигналом: иначе любое расхождение логики выглядело бы как «данные изменились»,
    а запись, которая переключает фильтр, давала бы ложное предупреждение."""
    cand = _candidate()
    early = AT - timedelta(hours=8)
    live = replace(
        _market(),
        funding=[FundingRate(early, D("0.0001"))],
        open_interest=[OpenInterest(AT - timedelta(hours=1), D(1000))],
        long_short=[LongShortRatio(AT - timedelta(hours=1), D("0.5"))],
    )
    later = replace(
        live,
        funding=[*live.funding, FundingRate(AT, D("0.0090"))],
        open_interest=[*live.open_interest, OpenInterest(AT, D(5000))],
        long_short=[*live.long_short, LongShortRatio(AT, D("0.95"))],
    )
    assert inputs_fingerprint(later, AT) != inputs_fingerprint(live, AT)
    pub = _pub(cand, live)
    assert pub.inputs_upto == {
        "funding": early.isoformat(),
        "open_interest": (AT - timedelta(hours=1)).isoformat(),
        "liquidations": None,
        "long_short": (AT - timedelta(hours=1)).isoformat(),
    }
    assert check_replay(_row(cand), pub, later, PARAMS) is None
    moved = _row(cand, stop_loss=cand.trade.stop_loss - D("0.5"))
    finding = check_replay(moved, pub, later, PARAMS)
    assert finding is not None and finding.kind is Kind.LOGIC
    # без отметок (сигнал записан до них) поздние записи выглядят как изменившиеся данные
    old = check_replay(moved, replace(pub, inputs_upto=None), later, PARAMS)
    assert old is not None and old.kind is Kind.INPUTS


def test_signal_recorded_before_the_fingerprint_cannot_be_blamed_on_logic() -> None:
    cand = _candidate()
    old = _pub(cand, fingerprint=None)
    assert check_replay(_row(cand), old, _market(), PARAMS) is None
    moved = _row(cand, tp1=cand.trade.tp1 + D(1))
    finding = check_replay(moved, old, _market(), PARAMS)
    assert finding is not None and finding.kind is Kind.UNVERIFIED and finding.severity == WARNING


# --- 2. сопровождение воспроизводится ----------------------------------------------------------


def _minutes(outcome: Outcome | None, events: list[datetime] | None = None) -> MinuteRetrack:
    done = Completeness(AT, NOW, 480, ())
    tracked = tuple(TrackedEvent("tp1", D(1), t, None) for t in events or [])
    return MinuteRetrack(outcome, done, tracked, NOW, None if outcome else "пропуск 1m-свечей")


def _h4(outcome: Outcome | None, until: datetime = NOW) -> H4Retrack:
    return H4Retrack(outcome, until, None if outcome else "нет H4-свечи")


def test_result_that_both_recalculations_confirm_is_fine() -> None:
    cand = _candidate()
    sl = _closed("closed_sl", "-1.07", AT + M1 * 96)
    h4_sl = _closed("closed_sl", "-1.07", AT + H4)
    assert check_result(_row(cand, sl), _minutes(sl), _h4(h4_sl), NOW).finding is None
    still_open = check_result(_row(cand), _minutes(OPEN_OUTCOME), _h4(OPEN_OUTCOME), NOW)
    assert still_open == check_result(_row(cand), _minutes(None), _h4(OPEN_OUTCOME), NOW)
    assert still_open.finding is None and not still_open.explained


def test_close_after_15_minutes_is_a_tracker_mismatch() -> None:
    """Закрытие через 15 минут (ошибка, с которой начался пакет): в БД сделка закрыта по времени,
    тот же код на тех же минутах её не закрывает."""
    cand = _candidate()
    early = _closed("closed_time", "-0.12", AT + M1 * 15)
    res = check_result(_row(cand, early), _minutes(OPEN_OUTCOME), _h4(OPEN_OUTCOME), NOW)
    assert res.finding is not None and res.finding.kind is Kind.TRACKER
    assert res.finding.severity == CRITICAL and "closed_time" in res.finding.message
    # и другой результат при том же статусе — тоже расхождение трекера
    sl = _closed("closed_sl", "-1.07", AT + M1 * 96)
    for other in (
        _closed("closed_sl", "-1.00", AT + M1 * 96),
        _closed("closed_sl", "-1.07", AT + M1 * 97),
        _closed("closed_be", "-0.07", AT + M1 * 96, hits=1),
    ):
        assert compare_minutes(_row(cand, sl), other, [], NOW) is not None, other
    assert compare_minutes(_row(cand, sl), replace(sl, realized_r=D("-1.0704")), [], NOW) is None


def test_open_in_db_but_closed_by_recalculation_waits_for_tracker_lag() -> None:
    cand = _candidate()
    just_now = _closed("closed_sl", "-1.07", NOW - M1 * 2)
    long_ago = _closed("closed_sl", "-1.07", NOW - LAG_GRACE - M1)
    assert compare_minutes(_row(cand), just_now, [], NOW) is None
    assert "в БД сделка открыта" in (compare_minutes(_row(cand), long_ago, [], NOW) or "")
    # оба открыты, но статус разный: свежее событие — отставание, давнее — расхождение
    tp1 = Outcome("tp1_hit", 1, None, None, None, None)
    assert compare_minutes(_row(cand), tp1, [NOW - M1], NOW) is None
    assert compare_minutes(_row(cand), tp1, [NOW - H4], NOW) is not None
    # в БД событие, которого пересчёт не видит
    ahead = _row(cand, tp1)
    assert "не видит" in (compare_minutes(ahead, OPEN_OUTCOME, [], NOW) or "")


def test_difference_from_h4_reference_explained_by_minutes_is_not_an_alert() -> None:
    """Внутри одной H4-свечи цена сначала взяла TP1, потом ушла в безубыток: минутный трекер это
    видит, эталон бэктеста считает худший порядок — стоп. Запись верна, отличие учитывается."""
    cand = _candidate()
    t = cand.trade
    be = _closed("closed_be", "0.43", AT + M1 * 200, hits=1)
    h4_sl = _closed("closed_sl", "-1.07", AT + H4)
    # первая свеча после сигнала: коснулась и стопа, и первой цели — порядок по ней не виден
    wide = Candle(AT, t.entry_market, t.tp1 + D(1), t.stop_loss - D(1), t.entry_market, D(1))
    res = check_result(_row(cand, be), _minutes(be), _h4(h4_sl), NOW, D("0.05"), [wide])
    assert res.finding is None and res.explained
    # свеча, где сделки разошлись, первой цели не касалась: H4 и минуты обязаны совпасть.
    # Тот же код трекера в пересчёте повторил бы свою ошибку — отличие от эталона её выдаёт
    narrow = replace(wide, high=t.tp1 - D("0.1"))
    odd = check_result(_row(cand, be), _minutes(be), _h4(h4_sl), NOW, D("0.05"), [narrow])
    assert odd.finding is not None and odd.finding.kind is Kind.RESULT and not odd.explained
    assert "не объясняется" in odd.finding.message
    assert check_result(_row(cand, be), _minutes(be), _h4(h4_sl), NOW).finding is not None
    # минут нет (пропуски) — подтвердить запись нечем: предупреждение
    unsure = check_result(_row(cand, be), _minutes(None), _h4(h4_sl), NOW)
    assert unsure.finding is not None and unsure.finding.kind is Kind.RESULT
    assert unsure.finding.severity == WARNING and "пропуск 1m-свечей" in unsure.finding.message
    # порог |ΔR|: мелкое отличие результата при том же статусе — не расхождение
    near = replace(h4_sl, status="closed_be", realized_r=D("0.45"))
    assert compare_h4(_row(cand, be), near, NOW, NOW, D("0.05")) is None
    assert compare_h4(_row(cand, be), near, NOW, NOW, D("0.01")) is not None


def test_h4_reference_is_compared_only_on_what_it_has_seen() -> None:
    cand = _candidate()
    closed = _closed("closed_sl", "-1.07", AT + H4 + M1 * 30)  # внутри второй свечи H4
    tol = D("0.05")
    # эталон видел только первую свечу — сравнивать рано
    assert compare_h4(_row(cand, closed), OPEN_OUTCOME, AT + H4, NOW, tol) is None
    # видел и вторую, а сделка у него открыта — расхождение
    assert compare_h4(_row(cand, closed), OPEN_OUTCOME, AT + H4 * 2, NOW, tol) is not None
    # по эталону сделка закрылась только что — трекер мог не успеть
    fresh = _closed("closed_sl", "-1.07", NOW)
    assert compare_h4(_row(cand), fresh, NOW, NOW + M1, tol) is None
    assert compare_h4(_row(cand), fresh, NOW, NOW + H4, tol) is not None


def test_legacy_and_untraded_results_are_not_compared() -> None:
    cand = _candidate()
    legacy = _closed("closed_time", "-0.05", AT + M1 * 15, cost=None)
    res = check_result(_row(cand, legacy), _minutes(OPEN_OUTCOME), _h4(OPEN_OUTCOME), NOW)
    assert res.finding is None and res.legacy
    for status in ("expired", "cancelled"):
        gone = Outcome(status, 0, None, None, None, None)
        assert check_result(_row(cand, gone), _minutes(OPEN_OUTCOME), _h4(OPEN_OUTCOME), NOW) == (
            check_result(_row(cand), _minutes(OPEN_OUTCOME), _h4(OPEN_OUTCOME), NOW)
        )
    nothing = check_result(_row(cand), _minutes(None), _h4(None), NOW)
    assert nothing.finding is None and nothing.unchecked is not None
    assert "RECUSDT" in nothing.unchecked and "нет H4-свечи" in nothing.unchecked


# --- 3. инварианты -----------------------------------------------------------------------------


def test_time_stop_must_come_exactly_at_the_version_deadline() -> None:
    cand = _candidate()
    deadline = AT + H4 * PARAMS.trade.time_stop_candles
    assert deadline - AT == timedelta(hours=60)
    market = _pub(cand, entry_type="market")
    for closed_at, bad in (
        (deadline, False),
        (deadline + M1, False),
        (deadline - M1, False),
        (deadline + M1 * 2, True),
        (AT + M1 * 15, True),
    ):
        row = _row(cand, _closed("closed_time", "0.2", closed_at))
        kinds = [f.kind for f in check_invariants(row, market, PARAMS)]
        assert kinds == ([Kind.TIME_STOP] if bad else []), closed_at
    early = _row(cand, _closed("closed_time", "0.2", AT + M1 * 15))
    assert check_invariants(early, _pub(cand, entry_type="limit"), PARAMS) == []  # срок от входа
    legacy = _row(cand, _closed("closed_time", "0.2", AT + M1 * 15, cost=None))
    assert check_invariants(legacy, market, PARAMS) == []
    sl = _row(cand, _closed("closed_sl", "-1.07", AT + M1 * 15))
    assert check_invariants(sl, market, PARAMS) == []  # стоп может сработать когда угодно


def test_no_event_before_the_first_minute_after_the_signal() -> None:
    cand = _candidate()
    ok = _pub(cand, first_event_at=AT + M1)
    assert check_invariants(_row(cand), ok, PARAMS) == []
    early = _pub(cand, first_event_at=AT)
    (finding,) = check_invariants(_row(cand), early, PARAMS)
    assert finding.kind is Kind.EARLY_EVENT and finding.severity == CRITICAL


def test_open_signal_must_be_tracked() -> None:
    cand = _candidate()
    fresh = _pub(cand, tracked_to=NOW - M1 * 3)
    assert check_tracking(_row(cand), fresh, NOW) is None
    stale = _pub(cand, tracked_to=NOW - H4)
    finding = check_tracking(_row(cand), stale, NOW)
    assert finding is not None and finding.kind is Kind.NOT_TRACKED
    assert check_tracking(_row(cand), _pub(cand), AT + M1 * 5) is None  # только что записан
    never = check_tracking(_row(cand), _pub(cand), NOW)
    assert never is not None and never.severity == CRITICAL
    assert check_tracking(_row(cand), stale, None) is None  # минут нет — это компонент «Данные»
    closed = _row(cand, _closed("closed_sl", "-1.07", AT + M1 * 96))
    assert check_tracking(closed, stale, NOW) is None


def test_two_open_trades_on_one_instrument_and_version() -> None:
    def trade(
        pid: str, version_id: int, instrument_id: int, at: datetime, rule: bool = True
    ) -> OpenTrade:
        return OpenTrade(pid, f"S{instrument_id}USDT", "1.2.0", version_id, instrument_id, at, rule)

    one_each = [trade("a", 1, 1, AT), trade("b", 1, 2, AT), trade("c", 2, 1, AT)]
    assert open_overlaps(one_each) == []
    (finding,) = open_overlaps([*one_each, trade("d", 1, 1, AT + H4), trade("e", 1, 1, AT - H4)])
    assert finding.kind is Kind.OVERLAP and finding.severity == CRITICAL
    assert finding.public_id == "d" and "открыто сделок: 3" in finding.message
    early, later = finding.message.index(" e "), finding.message.index(" a ")
    assert early < later  # раньше открытые — по времени
    # поздний сигнал записан до правила одной сделки (задача 6) — наследство, а не нарушение
    (legacy,) = open_overlaps([trade("f", 3, 3, AT, False), trade("g", 3, 3, AT + H4, False)])
    assert legacy.kind is Kind.OVERLAP_LEGACY and legacy.severity == WARNING
    # а поздний, записанный уже с правилом, поверх старой открытой — нарушение
    (fresh,) = open_overlaps([trade("h", 4, 4, AT, False), trade("i", 4, 4, AT + H4)])
    assert fresh.kind is Kind.OVERLAP and fresh.public_id == "i"


# --- отчёт и монитор ---------------------------------------------------------------------------


def _report(*kinds: Kind, **kw: Any) -> Report:
    findings = tuple(Finding(k, f"id{i}", "RECUSDT", "1.2.0", "текст") for i, k in enumerate(kinds))
    return Report(NOW, NOW - timedelta(days=7), 12, findings, **kw)


def test_report_counts_and_orders_findings() -> None:
    report = _report(Kind.INPUTS, Kind.LOGIC, Kind.RESULT, explained=2, legacy=3, unchecked=("x",))
    assert (report.critical, report.warnings) == (1, 2)
    assert report.lines()[0].startswith("КРИТИЧНО RECUSDT 1.2.0 id1: расхождение логики")
    summary = report.summary()
    for part in ("проверено сигналов 12", "критичных расхождений 1", "предупреждений 2"):
        assert part in summary
    assert "внутри свечи 2" in summary and "не сверяются) 3" in summary
    state = json.loads(json.dumps(report.to_json(), ensure_ascii=False))
    assert state["checked"] == 12 and state["critical"] == 1 and len(state["findings"]) == 3
    assert state["findings"][1] == {
        "kind": "logic_mismatch",
        "severity": "critical",
        "public_id": "id1",
        "symbol": "RECUSDT",
        "version": "1.2.0",
        "message": "текст",
    }
    clean = _report()
    assert clean.lines() == [] and "критичных расхождений 0" in clean.summary()


def test_monitor_component_follows_the_last_reconcile() -> None:
    def comp(report: Report | None, now: datetime = NOW) -> monitor.Component:
        c = reconcile_component(None if report is None else report.to_json(), now)
        assert c is not None
        return c

    never = comp(None)
    assert (never.key, never.title, never.status) == ("reconcile", "Сверка сигналов", OK)
    assert comp(_report()).status == OK and "расхождений нет" in comp(_report()).detail
    warned = comp(_report(Kind.INPUTS))
    assert warned.status == DEGRADED and "предупреждений 1" in warned.detail
    broken = comp(_report(Kind.INPUTS, Kind.TRACKER))
    assert broken.status == DOWN and "критичных 1" in broken.detail
    assert len(broken.checks) == 2 and broken.checks[0].startswith("КРИТИЧНО")
    assert reconcile_component(monitor.UNREADABLE, NOW) is None  # Redis не ответил — не оцениваем
    stale = comp(_report(), NOW + timedelta(hours=37))
    assert stale.status == DEGRADED and "не выполнялась" in stale.detail
    failed = reconcile_component({"at": NOW.isoformat(), "failed": "OperationalError: нет БД"}, NOW)
    assert failed.status == DEGRADED and failed.checks == ["OperationalError: нет БД"]
    assert reconcile_component({"at": "вчера"}, NOW).status == DEGRADED
    # компонент входит в общий статус
    snap = monitor.Snapshot(NOW, {}, 30, 0, 59, None, True, True, _report(Kind.LOGIC).to_json())
    assert {c.key: c.status for c in monitor.evaluate(snap)}["reconcile"] == DOWN


def test_notifier_runs_reconcile_once_a_day_and_after_a_failure() -> None:
    day = datetime(2026, 11, 12, tzinfo=UTC)
    ok = json.dumps(_report().to_json())
    assert notifier.last_reconcile_at(ok) == NOW
    assert notifier.last_reconcile_at(ok.encode()) == NOW
    for raw in (None, b"", "не json", json.dumps({"at": NOW.isoformat(), "failed": "x"}), "[]"):
        assert notifier.last_reconcile_at(raw) is None, raw
    assert notifier.reconcile_due(day.replace(hour=0, minute=30), None)  # итога нет — сразу
    yesterday = day - timedelta(hours=20)
    assert not notifier.reconcile_due(day.replace(hour=0, minute=59), yesterday)  # час не настал
    assert notifier.reconcile_due(day.replace(hour=1), yesterday)
    assert not notifier.reconcile_due(day.replace(hour=23), day.replace(hour=1, minute=5))


class _Redis:
    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    def set(self, key: str, value: str) -> None:
        self.data[key] = value

    def get(self, key: str) -> str | None:
        return self.data.get(key)

    def delete(self, key: str) -> None:
        self.data.pop(key, None)

    def close(self) -> None:
        pass


def test_reconcile_once_stores_the_result_and_a_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _Redis()
    seen: list[Any] = []

    class _Conn:
        def __enter__(self) -> str:
            return "только чтение"

        def __exit__(self, *_: object) -> None:
            return None

    monkeypatch.setattr(notifier.redis, "from_url", lambda *_, **__: store)
    monkeypatch.setattr(notifier, "read_only_connection", _Conn)
    monkeypatch.setattr(
        notifier, "run_reconcile", lambda conn, now: seen.append(conn) or _report(Kind.LOGIC)
    )
    line = notifier.reconcile_once(NOW)
    assert seen == ["только чтение"]
    assert "критичных расхождений 1" in line and "расхождение логики" in line
    state = json.loads(store.data[monitor.RECONCILE_KEY])
    assert reconcile_component(state, NOW).status == DOWN

    def boom(conn: Any, now: datetime) -> Report:
        raise RuntimeError("свечи не читаются")

    monkeypatch.setattr(notifier, "run_reconcile", boom)
    with pytest.raises(RuntimeError):
        notifier.reconcile_once(NOW)
    state = json.loads(store.data[monitor.RECONCILE_KEY])
    assert state["failed"] == "RuntimeError: свечи не читаются"
    assert notifier.last_reconcile_at(store.data[monitor.RECONCILE_KEY]) is None  # повторить


# --- сводка закрытия в scheduler ---------------------------------------------------------------


def test_scheduler_logs_one_summary_line_per_version(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(scheduler, "_summaries", {})
    monkeypatch.setattr(scheduler, "active_instruments", lambda: 4)
    caplog.set_level(logging.INFO, logger="scheduler")
    a, b = "trend-ob-retest@1.1.0", "trend-ob-retest@1.2.0"
    scheduler.record_evaluation(AT, "BTCUSDT", {a: "bias", b: "trigger"})
    scheduler.record_evaluation(AT, "ETHUSDT", {a: "trigger", b: scheduler.SIGNAL})
    scheduler.record_evaluation(AT, "ETHUSDT", {a: "trigger", b: scheduler.SIGNAL})  # повтор
    scheduler.record_evaluation(AT, "SOLUSDT", {a: "filters", b: scheduler.NOT_WRITTEN})
    assert not scheduler.log_close_summary(AT)  # оценены не все — ждём
    scheduler.record_evaluation(AT, "XRPUSDT", {a: "data", b: scheduler.NOT_A_TRADE})
    assert scheduler.log_close_summary(AT)
    assert not scheduler.log_close_summary(AT, force=True)  # один раз на закрытие

    lines = [r.getMessage() for r in caplog.records if "оценено инструментов" in r.getMessage()]
    stamp = AT.strftime("%d.%m %H:%M")
    assert lines == [
        f"{stamp} {a}: оценено инструментов 4 из 4; отсеяно — data 1, bias 1, trigger 1, "
        "filters 1, trade 0; создано сигналов 0 (ещё ниже порога или отложено 0, "
        "не записано кандидатов 0)",
        f"{stamp} {b}: оценено инструментов 4 из 4; отсеяно — data 0, bias 0, trigger 1, "
        "filters 0, trade 0; создано сигналов 1 (ещё ниже порога или отложено 1, "
        "не записано кандидатов 1)",
    ]

    # срок вышел, а оценены не все: сводка пишется с тем, что есть
    caplog.clear()
    later = AT + H4
    scheduler.record_evaluation(later, "BTCUSDT", {a: "bias"})
    assert not scheduler.log_close_summary(later)
    assert scheduler.log_close_summary(later, force=True)
    (line,) = [r.getMessage() for r in caplog.records]
    assert "оценено инструментов 1 из 4" in line
    assert not scheduler.log_close_summary(AT + H4 * 5, force=True)  # закрытия без оценок нет


# --- сценарий на БД ----------------------------------------------------------------------------


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select scope from signals limit 0"))
            conn.execute(text("select cost_r from signal_results limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


@pytest.fixture
def conn() -> Iterator[Connection]:
    c = engine.connect()
    outer = c.begin()
    try:
        yield c
    finally:
        outer.rollback()
        c.close()


@pytest.fixture
def db(conn: Connection) -> Iterator[Session]:
    with Session(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False) as s:
        yield s


@dataclass
class Scenario:
    db: Session
    conn: Connection
    inst: Instrument
    version: StrategyVersion
    candidate: SignalCandidate
    signal: Signal
    minutes: list[Candle]
    """Минуты после сигнала до ``NOW``: полтора часа у цены входа, затем пробой стопа."""

    def track(self, upto: int | None = None) -> None:
        """Ведёт сделку кодом воркера по первым ``upto`` минутам (по умолчанию — по всем)."""
        worker.apply_candles(self.db, self.signal, self.minutes[:upto], Timeframe.M1)
        self.db.flush()

    def reconcile(self, days: int = 7) -> Report:
        self.db.flush()
        with read_only_connection(self.conn) as ro:
            return run_reconcile(ro, NOW, days)


def _h4_from_minutes(minutes: list[Candle]) -> list[Candle]:
    out = []
    for i in range(0, len(minutes), 240):
        chunk = minutes[i : i + 240]
        out.append(
            Candle(
                chunk[0].open_time,
                chunk[0].open,
                max(c.high for c in chunk),
                min(c.low for c in chunk),
                chunk[-1].close,
                D(len(chunk)),
            )
        )
    return out


@pytest.fixture
def scenario(
    db: Session, conn: Connection, monkeypatch: pytest.MonkeyPatch
) -> Callable[..., Scenario]:
    """Строит сценарий: рынок в БД, сигнал от движка, минуты после него. ``stop_shift`` —
    записать сигнал со сдвинутым стопом (как если бы боевой код посчитал его иначе);
    ``falls`` — пробивает ли цена стоп через полтора часа (иначе стоит у входа)."""

    def build(
        status: str = "forward", stop_shift: str = "0", falls: bool = True, hide: bool = False
    ) -> Scenario:
        tag = secrets.token_hex(3)
        slug, ver = f"reconcile-{tag}", "9.8.7"
        monkeypatch.setitem(STRATEGIES, f"{slug}@{ver}", PARAMS)
        strat = Strategy(slug=slug, name="reconcile test")
        db.add(strat)
        db.flush()
        version = StrategyVersion(strategy_id=strat.id, version=ver, params={}, status=status)
        inst = Instrument(
            exchange="binance",
            symbol=f"RC{tag.upper()}USDT",
            base=f"RC{tag.upper()}",
            quote="USDT",
            market_type="futures",
            tick_size=D("0.01"),
            lot_size=D("0.001"),
        )
        db.add_all([version, inst])
        db.flush()
        market = _market()
        upsert_candles(db, inst.id, Timeframe.H4, list(market.h4))
        upsert_candles(db, inst.id, Timeframe.D1, list(market.d1))
        upsert_candles(db, inst.id, Timeframe.W1, list(market.w1))

        inputs = load_inputs(db, inst, AT)
        cand = evaluate(inputs, AT, PARAMS)
        assert isinstance(cand, SignalCandidate), cand
        written = replace(
            cand, trade=replace(cand.trade, stop_loss=cand.trade.stop_loss + D(stop_shift))
        )
        if hide:  # как если бы движок на сервере посчитал сигнал ниже порога публикации
            written = replace(written, score=replace(cand.score, grade=Grade.NONE))
        assert write_candidate(db, version, inst, written, inputs)
        signal = db.query(Signal).filter(Signal.instrument_id == inst.id).one()

        entry, below = cand.trade.entry_market, cand.trade.stop_loss - D("0.5")
        minutes = []
        for i in range(int((NOW - AT) / M1)):
            t = AT + M1 * i
            if not falls or i < 95:
                minutes.append(Candle(t, entry, entry, entry, entry, D(1)))
            elif i == 95:
                minutes.append(Candle(t, entry, entry, below, below, D(1)))
            else:
                minutes.append(Candle(t, below, below, below, below, D(1)))
        upsert_candles(db, inst.id, Timeframe.M1, minutes)
        upsert_candles(db, inst.id, Timeframe.H4, _h4_from_minutes(minutes))
        db.flush()
        return Scenario(db, conn, inst, version, cand, signal, minutes)

    return build


@db_only
def test_correct_data_gives_no_findings(scenario: Callable[..., Scenario]) -> None:
    """Сигнал записан боевым кодом, сделку довёл боевой трекер — сверке нечего сказать."""
    sc = scenario()
    sc.track()
    assert sc.signal.status == "closed_sl"
    report = sc.reconcile()
    assert report.findings == () and report.checked == 1
    assert (report.explained, report.legacy, report.unchecked) == (0, 0, ())
    assert reconcile_component(report.to_json(), NOW).status == OK


@db_only
def test_live_signal_and_open_trade_are_checked_too(scenario: Callable[..., Scenario]) -> None:
    sc = scenario(status="live", falls=False)
    assert sc.signal.scope == "live"
    sc.track()
    assert sc.signal.status == "active"
    report = sc.reconcile()
    assert report.findings == () and report.checked == 1


@db_only
def test_changed_stop_gives_a_logic_alert(scenario: Callable[..., Scenario]) -> None:
    sc = scenario(stop_shift="-0.4", falls=False)
    sc.track()
    report = sc.reconcile()
    (finding,) = report.findings
    assert finding.kind is Kind.LOGIC and finding.public_id == sc.signal.public_id
    assert "стоп" in finding.message and report.critical == 1
    assert reconcile_component(report.to_json(), NOW).status == DOWN


@db_only
def test_close_after_15_minutes_gives_tracker_and_time_stop_alerts(
    scenario: Callable[..., Scenario],
) -> None:
    sc = scenario(falls=False)
    closed_at = AT + M1 * 15
    sc.signal.status = "closed_time"
    sc.db.add(SignalEvent(signal_id=sc.signal.id, type="activated", occurred_at=AT + M1))
    sc.db.add(SignalEvent(signal_id=sc.signal.id, type="time_stop", occurred_at=closed_at))
    sc.db.add(
        SignalResult(
            signal_id=sc.signal.id,
            realized_r=D("-0.07"),
            cost_r=D("0.07"),
            duration_hours=D("0.25"),
            closed_at=closed_at,
            entry_type_used="market",
        )
    )
    report = sc.reconcile()
    assert sorted(f.kind for f in report.findings) == sorted([Kind.TRACKER, Kind.TIME_STOP])
    assert report.critical == 2
    by_kind = {f.kind: f.message for f in report.findings}
    assert "0.25 ч" in by_kind[Kind.TIME_STOP] and "60 ч" in by_kind[Kind.TIME_STOP]
    assert "пересчёт сделку не закрывает" in by_kind[Kind.TRACKER]


@db_only
def test_result_recorded_before_commissions_is_counted_not_alerted(
    scenario: Callable[..., Scenario],
) -> None:
    sc = scenario(falls=False)
    sc.signal.status = "closed_time"
    sc.db.add(SignalResult(signal_id=sc.signal.id, realized_r=D("0.01"), closed_at=AT + M1 * 15))
    report = sc.reconcile()
    assert report.findings == () and report.legacy == 1


@db_only
def test_two_open_signals_on_one_instrument_give_an_alert(
    scenario: Callable[..., Scenario],
) -> None:
    sc = scenario(falls=False)
    sc.track()
    earlier = AT - H4 * 10  # старше окна сверки в сутки, но сделка открыта — её тоже смотрим
    twin = Signal(
        public_id=secrets.token_hex(5),
        strategy_version_id=sc.version.id,
        instrument_id=sc.inst.id,
        direction="long",
        candle_close_time=earlier,
        entry_market=D(100),
        stop_loss=D(50),
        tp1=D(150),
        tp2=D(200),
        tp3=D(250),
        rr_tp2=D(2),
        score=70,
        grade="B",
        status="active",
        scope="forward",
        input_hash="x" * 64,
    )
    sc.db.add(twin)
    sc.db.flush()
    sc.db.add(SignalTracking(signal_id=twin.id, state={}, last_candle_time=NOW - M1))
    report = sc.reconcile(days=1)
    (finding,) = report.findings
    assert finding.kind is Kind.OVERLAP and finding.public_id == sc.signal.public_id
    assert twin.public_id in finding.message and report.checked == 2
    assert len(report.unchecked) == 0 or twin.public_id in report.unchecked[0]


@db_only
def test_trade_that_closes_after_the_window_is_still_checked(
    scenario: Callable[..., Scenario],
) -> None:
    """Сделка жила дольше окна сверки: сигнал старше окна, но закрылась она внутри него — итог
    сверяется. Записан неверный итог — сверка это видит."""
    sc = scenario()
    sc.track()
    assert sc.signal.status == "closed_sl"
    result = sc.db.get(SignalResult, sc.signal.id)
    assert result is not None
    result.realized_r = D("1.5")  # записан не тот итог
    sc.db.flush()
    later = AT + timedelta(days=1, hours=1)  # окно в сутки начинается после сигнала
    assert AT < later - timedelta(days=1) < result.closed_at.astimezone(UTC)
    with read_only_connection(sc.conn) as ro:
        report = run_reconcile(ro, later, days=1)
    assert [f.kind for f in report.findings] == [Kind.TRACKER]
    assert report.checked == 1
    # сделка, закрывшаяся до окна, уже не сверяется
    with read_only_connection(sc.conn) as ro:
        assert run_reconcile(ro, AT + timedelta(days=2), days=1).checked == 0


@db_only
def test_signal_hidden_by_mistake_gives_a_logic_alert(scenario: Callable[..., Scenario]) -> None:
    """Движок на сервере записал сигнал ниже порога публикации, а тот же код на том же входе
    публикует его: подписчики сигнал не получили. Сверка пересчитывает и скрытых кандидатов окна;
    сделкой такой кандидат не был, поэтому его сопровождение не проверяется."""
    sc = scenario(hide=True)
    sc.db.refresh(sc.signal)
    assert sc.signal.published is False and sc.signal.grade == "C"
    report = sc.reconcile()
    (finding,) = report.findings
    assert finding.kind is Kind.LOGIC and "выше порога публикации нет → да" in finding.message
    assert report.hidden == 1 and report.checked == 1
    assert "скрытых кандидатов 1" in report.summary()


@db_only
def test_changed_candle_gives_an_inputs_alert(scenario: Callable[..., Scenario]) -> None:
    sc = scenario(falls=False)
    sc.track()
    touched = _market().h4[-5]
    upsert_candles(sc.db, sc.inst.id, Timeframe.H4, [replace(touched, volume=D(9))])
    report = sc.reconcile()
    (finding,) = report.findings
    assert finding.kind is Kind.INPUTS and report.critical == 0 and report.warnings == 1
    assert reconcile_component(report.to_json(), NOW).status == DEGRADED


@db_only
def test_stuck_open_signal_gives_an_alert(scenario: Callable[..., Scenario]) -> None:
    """Трекер остановился на получасе, а цена потом пробила стоп: сигнал висит открытым и держит
    инструмент занятым — сверка это видит двумя способами."""
    sc = scenario()
    sc.track(upto=30)
    assert sc.signal.status == "active"
    report = sc.reconcile()
    assert sorted(f.kind for f in report.findings) == sorted([Kind.TRACKER, Kind.NOT_TRACKED])


@db_only
def test_reconcile_reads_only(scenario: Callable[..., Scenario]) -> None:
    sc = scenario()
    sc.track()
    sc.db.flush()
    with read_only_connection(sc.conn) as ro:
        run_reconcile(ro, NOW)
        with pytest.raises(DBAPIError, match="read-only"):
            ro.execute(text("update signals set status = 'cancelled'"))


@db_only
def test_reconcile_runs_on_its_own_read_only_connection() -> None:
    """Боевой путь уведомителя: своё соединение, одна транзакция REPEATABLE READ, READ ONLY."""
    with read_only_connection() as ro:
        report = run_reconcile(ro, NOW)
    assert isinstance(report, Report) and report.now == NOW
    assert reconcile_component(report.to_json(), NOW).key == "reconcile"


# --- письмо владельцу ---------------------------------------------------------------------------


class _Store:
    """Redis в памяти: get / set / delete."""

    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    def get(self, key: str) -> bytes | None:
        v = self.data.get(key)
        return None if v is None else v.encode()

    def set(self, key: str, value: str) -> None:
        self.data[key] = value

    def delete(self, key: str) -> None:
        self.data.pop(key, None)


def test_reconcile_email_goes_out_when_the_set_of_findings_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Письмо по сверке — при новом наборе расхождений (вид и сигнал), а не каждые сутки с тем же
    списком и не при одинаковых числах с другим составом; подробности — в письме."""
    sent: list[tuple[str, str, str]] = []
    monkeypatch.setattr(
        notifier, "send_mail", lambda to, subject, body: sent.append((to, subject, body))
    )
    monkeypatch.setattr(notifier.settings, "owner_emails", "owner@example.com")
    r = _Store()

    def run(report: Report, checked: int = 12) -> bool:
        return notifier.reconcile_email(r, replace(report, checked=checked).to_json())

    assert run(_report(Kind.LOGIC))
    to, subject, body = sent[0]
    assert to == "owner@example.com"
    assert subject == "[Platform] Сверка сигналов: критичных 1, предупреждений 0"
    assert "- КРИТИЧНО RECUSDT 1.2.0 id0: расхождение логики — текст" in body
    assert not run(_report(Kind.LOGIC), checked=15)  # назавтра тот же набор — молчим
    swapped = Report(NOW, NOW, 12, (Finding(Kind.LOGIC, "другой", "RECUSDT", "1.2.0", "текст"),))
    assert run(swapped)  # те же числа, другой сигнал — новое письмо
    assert not run(_report())  # расхождений нет — писать не о чем, отметка снята
    assert run(_report(Kind.LOGIC))  # то же расхождение вернулось — пишем снова
    failed = {"at": NOW.isoformat(), "failed": "RuntimeError: нет БД"}
    assert notifier.reconcile_email(r, failed) and "нет БД" in sent[-1][2]
    assert not notifier.reconcile_email(r, failed)  # сбой — одно письмо, не каждые 15 минут
    assert len(sent) == 4
    monkeypatch.setattr(notifier.settings, "owner_emails", "")
    assert not run(_report(Kind.INPUTS))  # адрес владельца не задан — письмо не уходит


@db_only
def test_monitor_sends_no_email_for_reconcile_and_keeps_incident_on_read_failure(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent: list[str] = []
    monkeypatch.setattr(monitor, "send_mail", lambda to, subject, body: sent.append(subject))
    monkeypatch.setattr(monitor.settings, "owner_emails", "owner@example.com")
    db.query(Incident).filter(Incident.closed_at.is_(None)).update({"closed_at": NOW})

    def tick(state: dict[str, Any] | None, now: datetime) -> None:
        c = reconcile_component(state, now)
        comps = [] if c is None else [c]
        sync_incidents(db, comps, now)
        send_alerts(db, comps, now)

    tick(_report(Kind.LOGIC).to_json(), NOW)
    open_ = db.query(Incident).filter(Incident.closed_at.is_(None)).all()
    assert [(i.component, i.severity) for i in open_] == [("reconcile", DOWN)]
    tick(monitor.UNREADABLE, NOW + timedelta(minutes=1))  # Redis не ответил
    tick(monitor.UNREADABLE, NOW + timedelta(hours=7))
    assert db.query(Incident).filter(Incident.closed_at.is_(None)).count() == 1  # не закрыт
    tick(_report().to_json(), NOW + timedelta(hours=8))  # расхождений нет — инцидент закрыт
    assert db.query(Incident).filter(Incident.closed_at.is_(None)).count() == 0
    assert sent == []  # письма по сверке шлёт сама сверка, монитор — нет
