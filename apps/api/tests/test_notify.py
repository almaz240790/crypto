"""Правила уведомлений без БД: тихие часы, лимит, фильтры, текст письма."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from app.models import NotificationSettings, RiskProfile, Signal
from app.notify import in_quiet_hours, limit_reached, position_size, should_notify, signal_text


def _ns(**kw: object) -> NotificationSettings:
    base = dict(
        user_id=1,
        email_signals=True,
        grades=["A", "B"],
        scope="all",
        daily_limit=2,
        unsubscribe_token="t",
    )
    base.update(kw)
    return NotificationSettings(**base)  # type: ignore[arg-type]


def _sig(grade: str = "A", inst: int = 1) -> Signal:
    return Signal(
        public_id="abc",
        strategy_version_id=1,
        instrument_id=inst,
        direction="long",
        candle_close_time=datetime(2026, 10, 25, 16, tzinfo=UTC),
        entry_market=Decimal("100"),
        entry_limit=Decimal("99"),
        stop_loss=Decimal("97"),
        tp1=Decimal("103"),
        tp2=Decimal("105"),
        tp3=Decimal("108"),
        rr_tp2=Decimal("2.5"),
        score=80,
        grade=grade,
        status="pending",
    )


def test_quiet_hours_including_overnight() -> None:
    ns = _ns(quiet_from=22, quiet_to=7)
    assert in_quiet_hours(ns, datetime(2026, 1, 1, 23, tzinfo=UTC))
    assert in_quiet_hours(ns, datetime(2026, 1, 1, 3, tzinfo=UTC))
    assert not in_quiet_hours(ns, datetime(2026, 1, 1, 12, tzinfo=UTC))
    assert not in_quiet_hours(_ns(), datetime(2026, 1, 1, 3, tzinfo=UTC))
    day = _ns(quiet_from=9, quiet_to=18)
    assert in_quiet_hours(day, datetime(2026, 1, 1, 12, tzinfo=UTC))
    assert not in_quiet_hours(day, datetime(2026, 1, 1, 20, tzinfo=UTC))


def test_daily_limit_resets_next_day() -> None:
    ns = _ns(daily_limit=2)
    now = datetime(2026, 1, 1, 10, tzinfo=UTC)
    assert not limit_reached(ns, now)
    ns.sent_today = 2
    assert limit_reached(ns, now)
    assert not limit_reached(ns, datetime(2026, 1, 2, 10, tzinfo=UTC)) and ns.sent_today == 0


def test_should_notify_filters() -> None:
    now = datetime(2026, 1, 1, 10, tzinfo=UTC)
    assert should_notify(_ns(), _sig("A"), now, set())
    assert not should_notify(_ns(), _sig("C"), now, set())
    assert not should_notify(_ns(scope="watchlist"), _sig("A", inst=5), now, {1})
    assert should_notify(_ns(scope="watchlist"), _sig("A", inst=5), now, {5})
    assert not should_notify(_ns(quiet_from=9, quiet_to=12), _sig("A"), now, set())


def test_signal_text_and_position_size() -> None:
    risk = RiskProfile(user_id=1, deposit=Decimal("10000"), risk_pct=Decimal("1"))
    sig = _sig()
    assert position_size(risk, sig).startswith("50.0000 (100.00 USDT")
    assert position_size(None, sig) == "укажите депозит в настройках"
    text = signal_text(sig, "BTCUSDT", risk)
    assert (
        "BTCUSDT" in text
        and "LONG" in text
        and "/signals/abc" in text
        and "103 / 105 / 108" in text
    )
    assert "рекомендац" in text


def test_journal_report_lines_and_digest_due() -> None:
    from datetime import UTC, datetime, timedelta
    from decimal import Decimal

    from app.journal_analytics import TradeRow, analytics
    from app.notify import journal_report_lines, journal_report_text
    from app.workers.notifier import digest_due

    now = datetime(2026, 10, 26, 6, 5, tzinfo=UTC)  # понедельник
    rows = [
        TradeRow(
            "BTCUSDT",
            "long",
            now - timedelta(days=3),
            now - timedelta(days=2),
            Decimal(100),
            Decimal(98),
            Decimal(1),
            Decimal("1.5"),
            7,
            "A",
            Decimal("2.5"),
        ),
        TradeRow(
            "ETHUSDT",
            "short",
            now - timedelta(days=1),
            None,
            Decimal(50),
            Decimal(51),
            None,
            None,
            None,
            None,
            None,
        ),
    ]
    text = "\n".join(journal_report_lines(analytics(rows, Decimal(1000), Decimal("1")), now))
    assert "отчёт по журналу за неделю, 26.10.2026" in text
    assert "Сделок: 2, закрыто 1, итог +1.50 R" in text
    assert "BTCUSDT" in text and "без сигнала" in text
    assert "  пт " in text and "  вс " in text  # входы 23.10 (пт) и 25.10 (вс)
    assert "ранний выход: 1 из 1" in text and "вход без сигнала: 1 из 2" in text
    assert "бюджет 10 USDT" in text and "не является инвестиционной" in text
    assert digest_due(now, None) and digest_due(now, "2026-10-25")
    assert not digest_due(now, "2026-10-26")
    assert not digest_due(now.replace(hour=5), None)
    assert callable(journal_report_text)
