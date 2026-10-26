"""Жизненный цикл подписки (план 3.13): напоминания по датам, истечение с льготным периодом."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.models import Subscription
from app.subscriptions import is_expired, reminder_due, reminder_text


def _sub(end: datetime, **flags: bool) -> Subscription:
    s = Subscription(user_id=1, plan="pro", status="active", current_period_end=end)
    s.reminded_7 = flags.get("r7", False)
    s.reminded_3 = flags.get("r3", False)
    s.reminded_0 = flags.get("r0", False)
    return s


def test_reminders_by_date() -> None:
    end = datetime(2026, 11, 10, 12, tzinfo=UTC)
    assert reminder_due(_sub(end), end - timedelta(days=20)) is None
    assert reminder_due(_sub(end), end - timedelta(days=7)) == 7
    assert reminder_due(_sub(end, r7=True), end - timedelta(days=5)) is None
    assert reminder_due(_sub(end, r7=True), end - timedelta(days=3)) == 3
    assert reminder_due(_sub(end, r7=True, r3=True), end - timedelta(hours=12)) == 0
    assert reminder_due(_sub(end, r7=True, r3=True, r0=True), end) is None
    # оплатил на 2 дня: сразу «3», а не «7» и «3» подряд; за 12 часов — «0»
    assert reminder_due(_sub(end), end - timedelta(days=2)) == 3
    assert reminder_due(_sub(end), end - timedelta(hours=12)) == 0
    # после льготных дней напоминать поздно
    assert reminder_due(_sub(end), end + timedelta(days=4)) is None


def test_expiry_with_grace() -> None:
    end = datetime(2026, 11, 10, 12, tzinfo=UTC)
    assert not is_expired(_sub(end), end + timedelta(days=2))
    assert not is_expired(_sub(end), end + timedelta(days=3))
    assert is_expired(_sub(end), end + timedelta(days=3, minutes=1))


def test_reminder_text_mentions_date_and_link() -> None:
    end = datetime(2026, 11, 10, 12, tzinfo=UTC)
    subject, body = reminder_text(_sub(end), 7)
    assert "7 дн" in subject and "10.11.2026" in body and "/pricing" in body
    subject, body = reminder_text(_sub(end), 0)
    assert "сегодня" in subject and "Free" in body
