"""Жизненный цикл подписки (план 3.13, задача 3.2): напоминания за 7/3/0 дней, истечение,
льготный период и даунгрейд, повторная сверка ожидающих платежей. Чистые проверки отделены от БД.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.billing import apply_provider_update
from app.config import settings
from app.mail import send_mail
from app.models import Payment, Subscription, User
from app.payments import nowpayments
from app.plans import GRACE_DAYS, PLANS

log = logging.getLogger("subscriptions")
REMINDERS = (7, 3, 0)
PENDING_MAX_AGE = timedelta(hours=48)


def reminder_due(sub: Subscription, now: datetime) -> int | None:
    """Какое напоминание пора слать: 7, 3 или 0 (день окончания). None — ничего.

    Шлётся самое «позднее» из ещё не отправленных: если пользователь оплатил на 2 дня, он получит
    только «0», а не три письма подряд.
    """
    left = (sub.current_period_end - now).total_seconds() / 86400
    if left < -GRACE_DAYS:
        return None
    for days, sent in ((0, sub.reminded_0), (3, sub.reminded_3), (7, sub.reminded_7)):
        # «0» — последний день: осталось меньше суток
        if left <= max(days, 1) and not sent:
            return days
    return None


def is_expired(sub: Subscription, now: datetime) -> bool:
    """Срок и льготные дни прошли — подписка переводится в expired (доступ Free)."""
    return sub.current_period_end + timedelta(days=GRACE_DAYS) < now


def _mark(sub: Subscription, days: int) -> None:
    if days == 7:
        sub.reminded_7 = True
    elif days == 3:
        sub.reminded_3 = sub.reminded_7 = True
    else:
        sub.reminded_0 = sub.reminded_3 = sub.reminded_7 = True


def reminder_text(sub: Subscription, days: int) -> tuple[str, str]:
    title = PLANS[sub.plan].title
    until = sub.current_period_end.strftime("%d.%m.%Y")
    link = f"{settings.frontend_url}/pricing"
    if days == 0:
        return (
            f"Тариф {title} заканчивается сегодня",
            f"Срок тарифа {title} истекает {until} (UTC). Ещё {GRACE_DAYS} дня доступ сохраняется, "
            f"затем аккаунт перейдёт на Free; данные не удаляются.\nПродлить: {link}",
        )
    return (
        f"Тариф {title} заканчивается через {days} дн.",
        f"Срок тарифа {title} истекает {until} (UTC). Оплата продлевает срок, а не заменяет его, "
        f"поэтому продлевать можно заранее.\nПродлить: {link}",
    )


def run_reminders(db: Session, now: datetime | None = None) -> dict[str, int]:
    """Раз в час: напоминания и перевод истёкших в expired. Возвращает счётчики."""
    now = now or datetime.now(tz=UTC)
    sent = expired = 0
    subs = db.scalars(
        select(Subscription).where(Subscription.status.in_(["active", "trialing"]))
    ).all()
    for sub in subs:
        if is_expired(sub, now):
            sub.status = "expired"
            expired += 1
            user = db.get(User, sub.user_id)
            if user is not None and user.deleted_at is None:
                send_mail(
                    user.email,
                    "Тариф переведён на Free",
                    f"Срок тарифа {PLANS[sub.plan].title} и льготные дни прошли. Теперь действует "
                    f"Free: сигналы градации A с задержкой 12 часов. Данные сохранены.\n"
                    f"Вернуть тариф: {settings.frontend_url}/pricing",
                )
            continue
        days = reminder_due(sub, now)
        if days is None:
            continue
        user = db.get(User, sub.user_id)
        if user is not None and user.deleted_at is None and settings.billing_enabled:
            subject, body = reminder_text(sub, days)
            send_mail(user.email, subject, body)
            sent += 1
        _mark(sub, days)
    db.commit()
    if sent or expired:
        log.info("напоминаний: %d, истекло: %d", sent, expired)
    return {"reminders": sent, "expired": expired}


def reconcile_pending(db: Session, now: datetime | None = None) -> dict[str, int]:
    """Повторная сверка ожидающих платежей у провайдера (на случай потерянного вебхука)."""
    now = now or datetime.now(tz=UTC)
    checked = changed = 0
    rows = db.scalars(
        select(Payment).where(
            Payment.status == "pending",
            Payment.provider == "nowpayments",
            Payment.created_at >= now - PENDING_MAX_AGE,
        )
    ).all()
    for p in rows:
        if p.provider_payment_id:
            try:
                data = nowpayments.fetch_payment(p.provider_payment_id)
            except Exception:
                log.warning("сверка %s: провайдер недоступен", p.public_id)
                continue
            checked += 1
            before = p.status
            apply_provider_update(db, p, nowpayments.parse_ipn({**data, "order_id": p.public_id}))
            changed += p.status != before
        elif p.expires_at is not None and p.expires_at + timedelta(hours=2) < now:
            # инвойс так и не был открыт/оплачен — ни одного IPN за 2,5 часа
            p.status = "expired"
            changed += 1
    db.commit()
    return {"checked": checked, "changed": changed}


def run_hourly(db: Session) -> dict[str, Any]:
    out: dict[str, Any] = {}
    out.update(run_reminders(db))
    out.update(reconcile_pending(db))
    return out
