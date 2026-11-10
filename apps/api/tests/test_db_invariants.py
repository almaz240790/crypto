"""Проверка инвариантов схемы на реальной БД (нужен DATABASE_URL с TimescaleDB).

Локально: `make up && make migrate && uv run pytest apps/api`. В CI поднимается сервис timescaledb.
Без доступной БД тесты пропускаются, а не падают.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

from app.db import SessionLocal, engine
from app.models import Instrument, Signal, Strategy, StrategyVersion


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1 from signals limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


pytestmark = pytest.mark.skipif(
    not _db_available(), reason="БД с применёнными миграциями недоступна"
)


@pytest.fixture
def session() -> Session:  # type: ignore[misc]
    s = SessionLocal()
    s.begin()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _fixture_signal(s: Session) -> Signal:
    inst = Instrument(
        exchange="binance",
        symbol="TESTUSDT",
        base="TEST",
        quote="USDT",
        market_type="futures",
        tick_size=Decimal("0.01"),
        lot_size=Decimal("0.001"),
    )
    strat = Strategy(slug="t-" + datetime.now(tz=UTC).strftime("%H%M%S%f"), name="t")
    s.add_all([inst, strat])
    s.flush()
    ver = StrategyVersion(strategy_id=strat.id, version="1.0.0", params={"swing_len": 2})
    s.add(ver)
    s.flush()
    sig = Signal(
        public_id="t" + datetime.now(tz=UTC).strftime("%H%M%S%f")[:12],
        strategy_version_id=ver.id,
        instrument_id=inst.id,
        direction="long",
        candle_close_time=datetime(2026, 1, 1, 4, tzinfo=UTC),
        entry_market=Decimal(100),
        stop_loss=Decimal(95),
        tp1=Decimal(105),
        tp2=Decimal(110),
        tp3=Decimal(120),
        rr_tp2=Decimal(2),
        score=80,
        grade="A",
        scope="forward",
        input_hash="x" * 64,
    )
    s.add(sig)
    s.flush()
    return sig


def test_signal_trade_fields_are_immutable(session: Session) -> None:
    sig = _fixture_signal(session)
    sig.stop_loss = Decimal(90)
    with pytest.raises(DBAPIError, match="неизменяемы"):
        session.flush()


def test_signal_scope_is_immutable(session: Session) -> None:
    """Область сигнала фиксируется при публикации (план 2.11, правило 5; миграция 0022)."""
    sig = _fixture_signal(session)
    sig.scope = "live"
    with pytest.raises(DBAPIError, match="неизменяемы"):
        session.flush()


def test_signal_scope_must_be_known(session: Session) -> None:
    sig = _fixture_signal(session)
    with pytest.raises(DBAPIError, match="ck_signals_scope"):
        session.execute(
            text(
                "insert into signals (public_id, strategy_version_id, instrument_id, direction, "
                "candle_close_time, entry_market, stop_loss, tp1, tp2, tp3, rr_tp2, score, grade, "
                "input_hash, scope) select 'scopebad', strategy_version_id, instrument_id, "
                "direction, candle_close_time + interval '4 hours', entry_market, stop_loss, tp1, "
                "tp2, tp3, rr_tp2, score, grade, input_hash, 'demo' from signals where id = :id"
            ),
            {"id": sig.id},
        )


def test_signal_status_can_change(session: Session) -> None:
    sig = _fixture_signal(session)
    sig.status = "active"
    session.flush()
    assert sig.status == "active"


def test_signal_cannot_be_deleted(session: Session) -> None:
    sig = _fixture_signal(session)
    session.delete(sig)
    with pytest.raises(DBAPIError, match="не удаляются"):
        session.flush()


def test_strategy_params_immutable(session: Session) -> None:
    sig = _fixture_signal(session)
    ver = session.get(StrategyVersion, sig.strategy_version_id)
    assert ver is not None
    ver.params = {"swing_len": 3}
    with pytest.raises(DBAPIError, match="неизменяемы"):
        session.flush()


def test_candles_is_hypertable(session: Session) -> None:
    row = session.execute(
        text(
            "select count(*) from timescaledb_information.hypertables "
            "where hypertable_name='candles'"
        )
    ).scalar()
    assert row == 1
