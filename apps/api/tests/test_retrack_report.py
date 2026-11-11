"""Отчёт пересчёта форвард-сигналов исправленным трекером (задача 7 пакета «Сигналы»).

Без БД — чистые функции пересчёта: полнота ряда, 1m-трекер, H4-эталон, пометка пересечения,
«утечка будущего». На БД (нужен DATABASE_URL с миграциями до head; без БД тесты пропускаются) —
критерии приёмки: три сигнала (time stop, SL, TP3) со старыми 15-минутными закрытиями дают
ожидаемые «было / стало»; запись в транзакции отчёта невозможна; отчёт воспроизводим байт в байт.
Каждый тест на БД работает во внешней транзакции и откатывается в конце.
"""

from __future__ import annotations

import csv
import io
import secrets
import sys
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import insert, select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

from app.db import engine
from app.forward import write_candidate
from app.models import Candle as CandleRow
from app.models import (
    Instrument,
    Signal,
    SignalEvent,
    SignalResult,
    Strategy,
    StrategyVersion,
)
from app.retrack import (
    Outcome,
    SignalRow,
    TradeSpan,
    check_completeness,
    load_forward_signals,
    open_trade_overlap,
    read_only_connection,
    retrack_h4,
    retrack_minutes,
)
from app.retrack_report import (
    NOT_RETRACKED,
    REPORT_CSV,
    REPORT_MD,
    ReportOptions,
    UnknownVersionError,
    build_report,
    render_csv,
    render_markdown,
    run_report,
    totals,
    write_report,
)
from engine.backtest import DEFAULT_EXECUTION, execution_cost_r
from engine.candles import Candle, Timeframe
from engine.structure import Direction

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))

T0 = datetime(2026, 10, 26, 8, tzinfo=UTC)
M1 = timedelta(minutes=1)
H4 = timedelta(hours=4)
NOW = T0 + timedelta(days=4)
ENTRY, STOP, TP1, TP2, TP3 = Decimal(100), Decimal(95), Decimal(105), Decimal(110), Decimal(120)
COST_R = execution_cost_r(ENTRY, ENTRY - STOP, DEFAULT_EXECUTION)
"""Комиссия и проскальзывание в R для сделки фикстуры: (2 × 0.05 % + 0.03 %) × 100 / 5."""

Ohlc = tuple[Decimal, Decimal, Decimal, Decimal]
Path1m = Callable[[int], Ohlc]


def flat(price: str = "100") -> Path1m:
    p = Decimal(price)
    return lambda _i: (p, p, p, p)


def stop_at(minute: int) -> Path1m:
    """Ровно у входа, на минуте ``minute`` цена проваливается под стоп."""

    def path(i: int) -> Ohlc:
        if i < minute:
            return Decimal(100), Decimal(100), Decimal(100), Decimal(100)
        return Decimal(100), Decimal(100), Decimal(94), Decimal(94)

    return path


def three_targets(i: int) -> Ohlc:
    """Рост без откатов к входу: TP1 на 100-й минуте, TP2 на 200-й, TP3 на 400-й."""
    level = "101" if i < 100 else "106" if i < 200 else "111" if i < 400 else "121"
    p = Decimal(level)
    return p, p, p, p


def minute_candles(start: datetime, n: int, path: Path1m) -> list[Candle]:
    out = []
    for i in range(n):
        o, h, lo, c = path(i)
        out.append(Candle(start + M1 * i, o, h, lo, c, Decimal(1), Decimal(100), 1))
    return out


def aggregate_h4(minutes: list[Candle]) -> list[Candle]:
    """Полные H4-свечи из минут (240 минут подряд от границы H4)."""
    out = []
    for k in range(0, len(minutes) - 239, 240):
        chunk = minutes[k : k + 240]
        out.append(
            Candle(
                chunk[0].open_time,
                chunk[0].open,
                max(c.high for c in chunk),
                min(c.low for c in chunk),
                chunk[-1].close,
                Decimal(240),
                Decimal(24000),
                240,
            )
        )
    return out


def signal_row(at: datetime = T0, version: str = "1.1.0", public_id: str = "sig-a") -> SignalRow:
    return SignalRow(
        id=1,
        public_id=public_id,
        strategy="trend-ob-retest",
        version=version,
        strategy_version_id=1,
        instrument_id=1,
        symbol="TESTUSDT",
        scope="forward",
        direction="long",
        grade="A",
        score=80,
        candle_close_time=at,
        entry_market=ENTRY,
        entry_limit=None,
        stop_loss=STOP,
        tp1=TP1,
        tp2=TP2,
        tp3=TP3,
        rr_tp2=Decimal(2),
        recorded=Outcome("closed_time", 0, Decimal("0.010"), None, at + M1 * 15, Decimal("0.25")),
    )


# --- без БД: полнота ряда ----------------------------------------------------------------------


def test_completeness_finds_gaps_at_start_middle_and_end() -> None:
    times = [T0 + M1 * i for i in (2, 3, 4, 8, 9)]
    c = check_completeness(times, T0, T0 + M1 * 12, Timeframe.M1)
    assert c.expected == 12
    assert [(g.start, g.candles) for g in c.gaps] == [
        (T0, 2),
        (T0 + M1 * 5, 3),
        (T0 + M1 * 10, 2),
    ]
    assert (c.missing, c.longest) == (7, 3)
    full = check_completeness([T0 + M1 * i for i in range(12)], T0, T0 + M1 * 12, Timeframe.M1)
    assert full.gaps == ()
    # времена вне отрезка не учитываются
    outside = [T0 - M1, *(T0 + M1 * i for i in range(12)), T0 + M1 * 12]
    assert check_completeness(outside, T0, T0 + M1 * 12, Timeframe.M1).gaps == ()
    assert check_completeness([], T0, T0 + M1 * 3, Timeframe.M1).missing == 3


# --- без БД: 1m-трекер -------------------------------------------------------------------------


def test_minutes_time_stop_after_60_hours_with_costs() -> None:
    """Главное исправление: без TP1 сделка живёт 60 ч, а не 15 минут; результат — за вычетом
    комиссий, как в бэктесте."""
    res = retrack_minutes(signal_row(), minute_candles(T0, 62 * 60, flat()), NOW)
    assert res.outcome is not None and res.reason is None
    assert res.outcome.status == "closed_time"
    assert res.outcome.closed_at == T0 + timedelta(hours=60)
    assert res.outcome.duration_hours == Decimal(60)
    assert Decimal("0.026") == COST_R
    assert res.outcome.cost_r == COST_R
    assert res.outcome.realized_r == -COST_R
    assert res.completeness.gaps == ()
    assert [e.type for e in res.events] == ["activated", "time_stop"]
    assert res.tracked_until == T0 + timedelta(hours=60)


def test_minutes_stop_and_three_targets() -> None:
    sl = retrack_minutes(signal_row(), minute_candles(T0, 600, stop_at(300)), NOW)
    assert sl.outcome is not None
    assert (sl.outcome.status, sl.outcome.tp_hits) == ("closed_sl", 0)
    assert sl.outcome.realized_r == Decimal(-1) - COST_R
    assert sl.outcome.closed_at == T0 + M1 * 301
    tp = retrack_minutes(signal_row(), minute_candles(T0, 720, three_targets), NOW)
    assert tp.outcome is not None
    assert (tp.outcome.status, tp.outcome.tp_hits) == ("closed_tp3", 3)
    # доли 0.4 / 0.4 / 0.2 на 1R, 2R и 4R
    assert tp.outcome.realized_r == Decimal("2.0") - COST_R
    assert tp.outcome.closed_at == T0 + M1 * 401
    assert [e.type for e in tp.events] == ["activated", "tp1", "tp2", "tp3"]


def test_minutes_open_trade_has_no_result() -> None:
    """Сделка, не закрытая к ``now``: открытый статус, результата нет."""
    now = T0 + timedelta(hours=10)
    res = retrack_minutes(signal_row(), minute_candles(T0, 62 * 60, flat()), now)
    assert res.outcome is not None
    assert res.outcome.status == "active" and res.outcome.is_open
    assert res.outcome.realized_r is None and res.outcome.closed_at is None
    assert res.tracked_until == now


def test_minutes_no_future_leak() -> None:
    """Свечи после ``now`` на результат не влияют: стоп на 300-й минуте при ``now`` раньше него
    не виден, и ответ тот же, что на обрезанном ряду."""
    candles = minute_candles(T0, 600, stop_at(300))
    now = T0 + M1 * 200
    seen = retrack_minutes(signal_row(), candles, now)
    cut = retrack_minutes(signal_row(), candles[:200], now)
    assert seen == cut
    assert seen.outcome is not None and seen.outcome.status == "active"


def test_minutes_gap_over_threshold_is_not_retracked() -> None:
    candles = minute_candles(T0, 62 * 60, flat())
    holed = candles[:100] + candles[130:]  # нет 30 минут подряд
    res = retrack_minutes(signal_row(), holed, NOW, max_gap_minutes=5)
    assert res.outcome is None and res.gap_exceeded
    assert res.completeness.longest == 30
    assert res.reason is not None and "30 мин подряд" in res.reason
    # порог выше пропуска — сигнал пересчитан, срок не сдвинулся (сроки считаются по времени)
    ok = retrack_minutes(signal_row(), holed, NOW, max_gap_minutes=30)
    assert ok.outcome is not None
    assert ok.outcome.closed_at == T0 + timedelta(hours=60)
    assert ok.completeness.missing == 30
    # пропуск после закрытия сделки не считается
    after = minute_candles(T0, 600, stop_at(300))
    late_hole = after[:400] + after[500:]
    assert retrack_minutes(signal_row(), late_hole, NOW, max_gap_minutes=0).outcome is not None


# --- без БД: H4-эталон -------------------------------------------------------------------------


def test_h4_reference_matches_backtest_rules() -> None:
    h4 = aggregate_h4(minute_candles(T0, 64 * 60, flat()))
    ref = retrack_h4(signal_row(), h4, NOW)
    assert ref.outcome is not None
    assert ref.outcome.status == "closed_time"
    assert ref.outcome.closed_at == T0 + timedelta(hours=60)
    assert ref.outcome.realized_r == -COST_R
    # свечи до закрытия сигнальной (история слева для графика) в расчёт не входят
    history = aggregate_h4(minute_candles(T0 - H4 * 5, 5 * 240, stop_at(0)))
    assert retrack_h4(signal_row(), history + h4, NOW) == ref
    # TP3: на H4 выход — закрытием свечи, внутри которой взята цель
    tp = retrack_h4(signal_row(), aggregate_h4(minute_candles(T0, 720, three_targets)), NOW)
    assert tp.outcome is not None
    assert (tp.outcome.status, tp.outcome.closed_at) == ("closed_tp3", T0 + H4 * 2)
    assert tp.outcome.realized_r == Decimal("2.0") - COST_R


def test_h4_reference_needs_unbroken_series() -> None:
    h4 = aggregate_h4(minute_candles(T0, 64 * 60, flat()))
    assert retrack_h4(signal_row(), h4[1:], NOW).outcome is None
    broken = retrack_h4(signal_row(), h4[:5] + h4[6:], NOW)
    assert broken.outcome is None
    assert broken.reason is not None and "нет H4-свечи" in broken.reason
    # сделка открыта, а следующая свеча ещё не закрылась — это не пропуск
    now = T0 + H4 * 3 + timedelta(hours=1)
    open_ref = retrack_h4(signal_row(), h4, now)
    assert open_ref.outcome is not None and open_ref.outcome.status == "active"
    assert open_ref.outcome.realized_r is None
    assert open_ref.tracked_until == T0 + H4 * 3


# --- без БД: пометка пересечения (правило задачи 6) --------------------------------------------


def test_overlap_flag_follows_backtest_rule() -> None:
    at = T0 + H4 * 5
    still_open = TradeSpan("a", T0, None)
    assert open_trade_overlap([still_open], at).flag is True
    assert open_trade_overlap([still_open], at).with_public_id == "a"
    # закрылась внутри свечи, которая заканчивается в at, — занято;
    # ровно на её открытии и раньше — нет
    assert open_trade_overlap([TradeSpan("a", T0, at - H4 + M1)], at).flag is True
    assert open_trade_overlap([TradeSpan("a", T0, at)], at).flag is True
    assert open_trade_overlap([TradeSpan("a", T0, at - H4)], at).flag is False
    assert open_trade_overlap([TradeSpan("a", T0, T0 + H4)], at).flag is False
    # более поздний сигнал не мешает более раннему; без других сигналов — свободно
    assert open_trade_overlap([TradeSpan("b", at + H4, None)], at).flag is False
    assert open_trade_overlap([], at).flag is False
    # сделку более раннего сигнала не удалось пересчитать — «нет данных», а не «нет»
    assert open_trade_overlap([TradeSpan("a", T0, None, known=False)], at).flag is None


# --- на БД -------------------------------------------------------------------------------------


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select cost_r from signal_results limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


@pytest.fixture
def db() -> Iterator[Session]:
    """Сессия во внешней транзакции: commit в коде — это savepoint, в конце всё откатывается."""
    conn = engine.connect()
    outer = conn.begin()
    s = Session(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False)
    try:
        yield s
    finally:
        s.close()
        outer.rollback()
        conn.close()


def _instrument(db: Session, name: str) -> Instrument:
    tag = secrets.token_hex(3).upper()
    inst = Instrument(
        exchange="binance",
        symbol=f"RT{name}{tag}USDT",
        base=f"RT{name}{tag}",
        quote="USDT",
        market_type="futures",
        tick_size=Decimal("0.01"),
        lot_size=Decimal("0.001"),
    )
    db.add(inst)
    db.flush()
    return inst


def _version(db: Session, status: str = "forward", version: str = "1.1.0") -> StrategyVersion:
    """Версия с настоящим номером (параметры сделки берутся из ``engine.strategies``), но у
    своей тестовой стратегии — боевые строки не затрагиваются."""
    strat = Strategy(slug=f"retrack-{secrets.token_hex(3)}", name="retrack test")
    db.add(strat)
    db.flush()
    ver = StrategyVersion(strategy_id=strat.id, version=version, params={}, status=status)
    db.add(ver)
    db.flush()
    return ver


def _candidate(at: datetime) -> Any:
    return SimpleNamespace(
        candle_close_time=at,
        direction=Direction.UP,
        trade=SimpleNamespace(
            entry_market=ENTRY,
            entry_limit=None,
            stop_loss=STOP,
            tp1=TP1,
            tp2=TP2,
            tp3=TP3,
            rr_tp2=Decimal(2),
        ),
        score=SimpleNamespace(
            total=80,
            grade=SimpleNamespace(value="A"),
            publishable=True,
            components={"trend": 30},
        ),
        facts=("тест",),
        deferred=False,
        zone=SimpleNamespace(kind="ob", top=Decimal(101), bottom=Decimal(99)),
        filters=SimpleNamespace(flags=[]),
        input_hash="h" * 64,
    )


def _publish(db: Session, ver: StrategyVersion, inst: Instrument, at: datetime) -> Signal:
    assert write_candidate(db, ver, inst, _candidate(at))
    db.commit()
    sig = db.scalar(
        select(Signal).where(
            Signal.strategy_version_id == ver.id,
            Signal.instrument_id == inst.id,
            Signal.candle_close_time == at,
        )
    )
    assert sig is not None
    return sig


def _close_after_15_minutes(db: Session, sig: Signal) -> None:
    """Запись, какой её оставил трекер с ошибкой: time stop через 15 минут, без комиссий."""
    closed_at = sig.candle_close_time + M1 * 15
    sig.status = "closed_time"
    db.add_all(
        [
            SignalEvent(
                signal_id=sig.id,
                type="time_stop",
                price=ENTRY,
                occurred_at=closed_at,
                source="tracker",
            ),
            SignalResult(
                signal_id=sig.id,
                realized_r=Decimal("0.010"),
                duration_hours=Decimal("0.25"),
                closed_at=closed_at,
                entry_type_used="market",
                cost_r=None,
            ),
        ]
    )
    db.commit()


def _store(db: Session, inst: Instrument, tf: str, candles: list[Candle]) -> None:
    db.execute(
        insert(CandleRow),
        [
            {
                "instrument_id": inst.id,
                "timeframe": tf,
                "open_time": c.open_time,
                "open": c.open,
                "high": c.high,
                "low": c.low,
                "close": c.close,
                "volume": c.volume,
                "quote_volume": c.quote_volume,
                "trades": c.trades,
                "is_closed": True,
            }
            for c in candles
        ],
    )
    db.commit()


def _market(db: Session, inst: Instrument, start: datetime, hours: int, path: Path1m) -> None:
    """1m-свечи от ``start`` и H4-свечи из них; слева — 60 спокойных H4-свечей для графика."""
    minutes = minute_candles(start, hours * 60, path)
    _store(db, inst, "1m", minutes)
    history = aggregate_h4(minute_candles(start - H4 * 60, 60 * 240, flat("101")))
    _store(db, inst, "4h", history + aggregate_h4(minutes))


@pytest.fixture
def report_fixture(db: Session) -> SimpleNamespace:
    """Три форвард-сигнала (time stop, SL, TP3) со старыми 15-минутными закрытиями, четвёртый —
    на инструменте первого, пока сделка первого ещё открыта; и один live-сигнал.

    Порядок записи — как на production: трекер с ошибкой закрыл первую сделку через 15 минут,
    поэтому к четвёртому сигналу по записи в БД инструмент свободен и правило одной открытой
    сделки (``write_candidate``, задача 6) его пропускает. Пересчитанная же сделка первого
    сигнала живёт 60 часов — это пересечение отчёт и помечает."""
    ver = _version(db)
    a, b, c = (_instrument(db, n) for n in "ABC")
    _market(db, a, T0, 72, flat())
    _market(db, b, T0, 12, stop_at(300))
    _market(db, c, T0, 12, three_targets)
    sig_a = _publish(db, ver, a, T0)
    sig_b = _publish(db, ver, b, T0)
    sig_c = _publish(db, ver, c, T0)
    for sig in (sig_a, sig_b, sig_c):
        _close_after_15_minutes(db, sig)
    sig_d = _publish(db, ver, a, T0 + H4 * 2)
    _close_after_15_minutes(db, sig_d)
    live = _publish(db, _version(db, status="live"), a, T0)
    slug = db.scalar(select(Strategy.slug).where(Strategy.id == ver.strategy_id))
    return SimpleNamespace(
        ver=ver, label=f"{slug}@1.1.0", a=sig_a, b=sig_b, c=sig_c, d=sig_d, live=live
    )


def _options(fx: SimpleNamespace, **kw: Any) -> ReportOptions:
    """Отчёт только по версии фикстуры: в тестовой БД могут лежать чужие форвард-сигналы."""
    return ReportOptions(since=T0 - H4, now=NOW, versions=(fx.label,), **kw)


@db_only
def test_report_shows_was_and_became(db: Session, report_fixture: SimpleNamespace) -> None:
    fx = report_fixture
    with read_only_connection(db.connection()) as conn:
        report = build_report(conn, _options(fx, charts=False))
    rows = {r.signal.public_id: r for r in report.signals}
    # live-сигнал в отчёт не попадает; форвард-сигналы — все четыре
    assert set(rows) == {fx.a.public_id, fx.b.public_id, fx.c.public_id, fx.d.public_id}

    # «было» у всех: закрыт по времени через 15 минут, без комиссий
    for r in rows.values():
        assert (r.was.status, r.was.duration_hours, r.was.cost_r) == (
            "closed_time",
            Decimal("0.25"),
            None,
        )
        assert r.was.realized_r == Decimal("0.010")
        assert r.was.closed_at == r.signal.candle_close_time + M1 * 15

    a, b, c, d = (rows[s.public_id] for s in (fx.a, fx.b, fx.c, fx.d))
    # time stop: 60 ч вместо 15 минут, результат за вычетом комиссий
    assert a.new is not None and a.ref is not None
    assert (a.new.status, a.new.duration_hours) == ("closed_time", Decimal("60.00"))
    assert a.new.closed_at == T0 + timedelta(hours=60)
    assert a.new.realized_r == Decimal("-0.026") and a.new.cost_r == Decimal("0.026")
    assert a.delta_r == Decimal("-0.036")
    assert (a.ref.status, a.ref.realized_r) == ("closed_time", Decimal("-0.026"))
    assert a.same_status is True and a.minutes_minus_h4_r == 0
    # стоп на 300-й минуте: по 1m выход в ту же минуту, по H4 — закрытием свечи
    assert b.new is not None and b.ref is not None
    assert (b.new.status, b.new.realized_r) == ("closed_sl", Decimal("-1.026"))
    assert b.new.closed_at == T0 + M1 * 301 and b.new.duration_hours == Decimal("5.02")
    assert (b.ref.status, b.ref.closed_at) == ("closed_sl", T0 + H4 * 2)
    assert b.ref.realized_r == Decimal("-1.026")
    # три цели
    assert c.new is not None and c.ref is not None
    assert (c.new.status, c.new.tp_hits) == ("closed_tp3", 3)
    assert c.new.realized_r == Decimal("1.974") and c.new.duration_hours == Decimal("6.68")
    assert (c.ref.status, c.ref.realized_r) == ("closed_tp3", Decimal("1.974"))
    # пометка правила «одна открытая сделка»: четвёртый сигнал вышел, пока сделка первого открыта
    assert (d.overlap.flag, d.overlap.with_public_id) == (True, fx.a.public_id)
    assert [r.overlap.flag for r in (a, b, c)] == [False, False, False]
    assert d.new is not None and d.new.closed_at == T0 + H4 * 2 + timedelta(hours=60)

    # итоги по версии: было — четыре сделки по +0.010R; стало — те же четыре, пересчитаны все
    (total,) = totals(report)
    assert (total.was.closed, total.new.closed, total.new.not_computed) == (4, 4, 0)
    assert total.was.sum_r == Decimal("0.040")
    assert total.new.sum_r == Decimal("-0.026") * 2 + Decimal("-1.026") + Decimal("1.974")

    md = render_markdown(report)
    for fragment in (
        "Было / стало",
        "| по времени | +0.010 | 0.25 | по времени | -0.026 | 60.00 | -0.036 |",
        "| по времени | +0.010 | 0.25 | стоп | -1.026 | 5.02 | -1.036 |",
        "| по времени | +0.010 | 0.25 | TP3 | +1.974 | 6.68 | +1.964 |",
        "| Сумма R по закрытым | +0.040 | +0.896 | +0.896 |",
        f"да (с `{fx.a.public_id}`)",
        "в базу данных ничего не записано",
        "результаты на прошлых данных",
    ):
        assert fragment in md, fragment
    assert fx.live.public_id not in md
    # выравнивание столбцов таблицы сравнения: числа — вправо, статусы и пометки — влево
    assert "|---|---|---|---|---|---:|---:|---|---:|---:|---:|---|---|---:|---|" in md
    assert "гарант" not in md.lower()
    table = list(csv.reader(io.StringIO(render_csv(report))))
    assert len(table) == 1 + 4
    assert len({len(line) for line in table}) == 1


@db_only
def test_report_marks_signal_with_gap_as_not_retracked(
    db: Session, report_fixture: SimpleNamespace
) -> None:
    fx = report_fixture
    # у инструмента B пропадает час минутных свечей до стопа
    db.execute(
        text(
            "delete from candles where instrument_id = :i and timeframe = '1m' "
            "and open_time >= :a and open_time < :b"
        ),
        {"i": fx.b.instrument_id, "a": T0 + M1 * 60, "b": T0 + M1 * 120},
    )
    db.commit()
    with read_only_connection(db.connection()) as conn:
        strict = build_report(conn, _options(fx, charts=False, max_gap_minutes=5))
        loose = build_report(conn, _options(fx, charts=False, max_gap_minutes=60))
    b = next(r for r in strict.signals if r.signal.public_id == fx.b.public_id)
    assert b.new is None and b.minutes.gap_exceeded
    assert b.minutes.completeness.longest == 60
    # H4-эталон от минутных пропусков не зависит
    assert b.ref is not None and b.ref.status == "closed_sl"
    (total,) = totals(strict)
    assert (total.new.not_computed, total.new.closed) == (1, 3)
    md = render_markdown(strict)
    assert NOT_RETRACKED in md and "60 мин подряд" in md
    b2 = next(r for r in loose.signals if r.signal.public_id == fx.b.public_id)
    assert b2.new is not None and b2.new.status == "closed_sl"
    assert b2.minutes.completeness.missing == 60


@db_only
def test_report_cannot_write(db: Session, report_fixture: SimpleNamespace) -> None:
    """Транзакция отчёта — только на чтение: любая запись в ней падает."""
    fx = report_fixture
    conn = db.connection()
    with read_only_connection(conn) as ro:
        assert load_forward_signals(ro, T0 - H4, NOW)  # читать можно
        for statement in (
            "update signals set status = 'active' where id = :id",
            "delete from signal_results where signal_id = :id",
            "insert into signal_events (signal_id, type, occurred_at, source) "
            "values (:id, 'sl', now(), 'tracker')",
        ):
            nested = ro.begin_nested()
            with pytest.raises(DBAPIError, match="read-only transaction"):
                ro.execute(text(statement), {"id": fx.a.id})
            nested.rollback()
    # после блока соединение вызывающего снова пишет, а данные сигнала не изменились
    assert db.scalar(select(Signal.status).where(Signal.id == fx.a.id)) == "closed_time"
    db.execute(text("update signals set status = status where id = :id"), {"id": fx.a.id})
    # и на отдельном соединении движка (так работает скрипт) запись тоже невозможна
    with read_only_connection(engine) as ro, pytest.raises(DBAPIError, match="read-only"):
        ro.execute(text("create temporary table retrack_probe (x int)"))


@db_only
def test_report_is_deterministic(
    db: Session, report_fixture: SimpleNamespace, tmp_path: Path
) -> None:
    """Одинаковый вход — одинаковые файлы байт в байт, включая PNG."""
    fx = report_fixture
    runs = []
    for name in ("one", "two"):
        _, files = run_report(_options(fx), tmp_path / name, bind=db.connection())
        runs.append({p.relative_to(tmp_path / name).as_posix(): p.read_bytes() for p in files})
    assert runs[0] == runs[1]
    names = set(runs[0])
    assert {REPORT_MD, REPORT_CSV} <= names
    charts = sorted(n for n in names if n.endswith(".png"))
    assert len(charts) == 4 and all(n.startswith("signals/") for n in charts)
    assert all(runs[0][n].startswith(b"\x89PNG") for n in charts)
    # в отчёте — переданный момент, а не время запуска
    md = runs[0][REPORT_MD].decode()
    assert f"{NOW:%d.%m.%Y %H:%M}" in md
    assert f"{datetime.now(tz=UTC):%d.%m.%Y}" not in md
    # повторная запись в тот же каталог ничего не меняет и чужие файлы не трогает
    (tmp_path / "one" / "note.txt").write_text("не трогать")
    with read_only_connection(db.connection()) as conn:
        again = build_report(conn, _options(fx))
    write_report(again, tmp_path / "one")
    assert (tmp_path / "one" / "note.txt").read_text() == "не трогать"
    assert (tmp_path / "one" / REPORT_MD).read_bytes() == runs[0][REPORT_MD]


@db_only
def test_unknown_version_is_rejected(db: Session, report_fixture: SimpleNamespace) -> None:
    options = ReportOptions(since=T0, now=NOW, versions=("9.9.9",), charts=False)
    with (
        read_only_connection(db.connection()) as conn,
        pytest.raises(UnknownVersionError, match=r"9\.9\.9"),
    ):
        build_report(conn, options)


def test_options_require_utc() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        ReportOptions(since=datetime(2026, 10, 26), now=NOW)
    with pytest.raises(ValueError, match="отрицательным"):
        ReportOptions(since=T0, now=NOW, max_gap_minutes=-1)


@db_only
def test_cli_runs_read_only_and_rejects_unknown_version(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    import retrack_report as cli

    # будущая дата: сигналов нет, но отчёт пишется, код возврата 0
    code = cli.main(["--since", "2099-01-01", "--out", str(tmp_path / "o"), "--no-png"])
    assert code == 0
    assert (tmp_path / "o" / REPORT_MD).exists() and (tmp_path / "o" / REPORT_CSV).exists()
    assert "сигналов: 0" in capsys.readouterr().out
    code = cli.main(["--since", "2099-01-01", "--out", str(tmp_path / "x"), "--version", "9.9.9"])
    assert code == 2
    assert "версии нет в БД" in capsys.readouterr().err
    assert not (tmp_path / "x").exists()
