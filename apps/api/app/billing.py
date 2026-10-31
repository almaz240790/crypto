"""Подписки и платежи (план 3.13): цена заказа, промокоды, баланс, продление срока, применение
платежа по вебхуку. Чистые расчёты отделены от БД: ``quote`` и ``extend_from`` без сессии.
"""

from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.mail import send_mail
from app.models import BalanceEntry, Payment, PromoCode, Subscription, User
from app.plans import FREE, GRACE_DAYS, PAID_PLANS, PERIODS, PLANS, RANK

log = logging.getLogger("billing")
ZERO = Decimal("0.00")
MONTH = timedelta(days=30)
UNDERPAID_TOLERANCE = Decimal("0.98")
"""Оплачено ≥ 98 % — считаем оплаченным (сетевые комиссии, округления провайдера)."""


@dataclass(frozen=True, slots=True)
class Quote:
    plan: str
    months: int
    price: Decimal
    discount: Decimal
    balance_applied: Decimal
    amount_due: Decimal
    promo_code: str | None


def quote(
    plan: str,
    months: int,
    promo: PromoCode | None = None,
    balance: Decimal = ZERO,
) -> Quote:
    if plan not in PAID_PLANS:
        raise ValueError("тариф: pro или premium")
    if months not in PERIODS:
        raise ValueError("срок: 1, 3 или 12 месяцев")
    price = PLANS[plan].price(months)
    discount = ZERO
    code = None
    if promo is not None:
        if promo.plan and promo.plan != plan:
            raise ValueError("промокод не для этого тарифа")
        discount = (price * Decimal(promo.percent) / 100).quantize(Decimal("0.01"))
        discount += Decimal(promo.fixed_usd)
        discount = min(discount, price)
        code = promo.code
    after = price - discount
    applied = min(max(balance, ZERO), after)
    return Quote(plan, months, price, discount, applied, after - applied, code)


def extend_from(current_end: datetime | None, now: datetime, months: int) -> datetime:
    """Оплата продлевает срок: от конца текущего периода, если он ещё не прошёл (план 3.13)."""
    base = current_end if current_end is not None and current_end > now else now
    return base + MONTH * months


# --- доступ к БД ---------------------------------------------------------------------------------


def balance_of(db: Session, user_id: int) -> Decimal:
    v = db.scalar(select(func.sum(BalanceEntry.amount_usd)).where(BalanceEntry.user_id == user_id))
    return Decimal(v or 0).quantize(Decimal("0.01"))


def find_promo(db: Session, code: str | None, now: datetime) -> PromoCode | None:
    if not code:
        return None
    promo = db.scalar(select(PromoCode).where(PromoCode.code == code.strip().upper()))
    if promo is None or not promo.active:
        raise ValueError("промокод не найден")
    if promo.expires_at is not None and promo.expires_at < now:
        raise ValueError("промокод истёк")
    if promo.max_uses is not None and promo.used >= promo.max_uses:
        raise ValueError("промокод уже использован")
    return promo


def subscription_of(db: Session, user_id: int) -> Subscription | None:
    return db.scalar(select(Subscription).where(Subscription.user_id == user_id))


def plan_for(db: Session, user: User, now: datetime | None = None) -> str:
    """Действующий тариф с учётом grace period. До включения биллинга все — Pro (лендинг)."""
    if not settings.billing_enabled:
        return "pro"
    now = now or datetime.now(tz=UTC)
    sub = subscription_of(db, user.id)
    if sub is None:
        return FREE
    if sub.current_period_end + timedelta(days=GRACE_DAYS) >= now:
        return sub.plan
    return FREE


def new_public_id() -> str:
    return "pay_" + secrets.token_urlsafe(12).replace("-", "").replace("_", "")[:16]


def create_payment(
    db: Session, user: User, q: Quote, provider: str, now: datetime | None = None
) -> Payment:
    now = now or datetime.now(tz=UTC)
    p = Payment(
        public_id=new_public_id(),
        user_id=user.id,
        plan=q.plan,
        months=q.months,
        price_usd=q.price,
        discount_usd=q.discount,
        balance_applied_usd=q.balance_applied,
        amount_due_usd=q.amount_due,
        promo_code=q.promo_code,
        provider=provider,
        status="pending",
        expires_at=now + timedelta(minutes=30) if q.amount_due > 0 else None,
    )
    db.add(p)
    db.flush()
    return p


def activate(db: Session, payment: Payment, now: datetime | None = None) -> Subscription:
    """Платёж оплачен: списать баланс, продлить/создать подписку, учесть промокод. Идемпотентно."""
    now = now or datetime.now(tz=UTC)
    if payment.status == "paid" and payment.paid_at is not None:
        sub = subscription_of(db, payment.user_id)
        assert sub is not None
        return sub
    sub = subscription_of(db, payment.user_id)
    if sub is None:
        sub = Subscription(
            user_id=payment.user_id,
            plan=payment.plan,
            status="active",
            provider=payment.provider,
            current_period_end=now,
        )
        db.add(sub)
        db.flush()
    if RANK[payment.plan] > RANK[sub.plan] and sub.current_period_end > now:
        # апгрейд: остаток старого тарифа — на баланс пропорционально
        days_left = Decimal((sub.current_period_end - now).days)
        credit = (PLANS[sub.plan].price_month / 30 * days_left).quantize(Decimal("0.01"))
        if credit > 0:
            db.add(
                BalanceEntry(
                    user_id=payment.user_id,
                    amount_usd=credit,
                    kind="upgrade_credit",
                    payment_id=payment.id,
                    note=f"остаток {sub.plan} за {days_left} дн.",
                )
            )
        sub.current_period_end = extend_from(None, now, payment.months)
    elif RANK[payment.plan] < RANK[sub.plan] and sub.current_period_end > now:
        # даунгрейд оплачивается наперёд: новый тариф начнётся после текущего срока
        sub.current_period_end = extend_from(sub.current_period_end, now, payment.months)
    else:
        sub.current_period_end = extend_from(sub.current_period_end, now, payment.months)
    sub.plan = payment.plan
    sub.status = "active"
    sub.provider = payment.provider
    sub.reminded_7 = sub.reminded_3 = sub.reminded_0 = False
    if payment.balance_applied_usd > 0:
        db.add(
            BalanceEntry(
                user_id=payment.user_id,
                amount_usd=-payment.balance_applied_usd,
                kind="subscription",
                payment_id=payment.id,
                note=f"{payment.plan} × {payment.months} мес.",
            )
        )
    if payment.promo_code:
        promo = db.scalar(select(PromoCode).where(PromoCode.code == payment.promo_code))
        if promo is not None:
            promo.used += 1
    payment.status = "paid"
    payment.paid_at = now
    db.flush()
    return sub


def apply_provider_update(
    db: Session, payment: Payment, upd: dict[str, Any], now: datetime | None = None
) -> str:
    """Применяет нормализованное событие провайдера. Возвращает итоговый статус платежа.

    Идемпотентно: повторный вебхук с тем же статусом ничего не меняет; «paid» не откатывается.
    Переплата → на баланс; недоплата → остаток на баланс и письмо.
    """
    now = now or datetime.now(tz=UTC)
    payment.raw = {**(payment.raw or {}), "last": {k: str(v) for k, v in upd.items()}}
    if upd.get("payment_id"):
        payment.provider_payment_id = str(upd["payment_id"])
    if upd.get("pay_currency"):
        payment.pay_currency = str(upd["pay_currency"])
    if upd.get("actually_paid") is not None:
        payment.actually_paid = Decimal(str(upd["actually_paid"]))
    if upd.get("actually_paid_usd") is not None:
        payment.actually_paid_usd = Decimal(str(upd["actually_paid_usd"]))
    if upd.get("tx_hash"):
        payment.tx_hash = str(upd["tx_hash"])
    if payment.status == "paid":
        return "paid"
    status = str(upd.get("status") or "pending")
    paid_usd = payment.actually_paid_usd
    if (
        status == "underpaid"
        and paid_usd is not None
        and paid_usd >= (payment.amount_due_usd * UNDERPAID_TOLERANCE)
    ):
        status = "paid"
    if status == "paid":
        activate(db, payment, now)
        if paid_usd is not None and paid_usd > payment.amount_due_usd + Decimal("0.50"):
            extra = (paid_usd - payment.amount_due_usd).quantize(Decimal("0.01"))
            db.add(
                BalanceEntry(
                    user_id=payment.user_id,
                    amount_usd=extra,
                    kind="overpayment",
                    payment_id=payment.id,
                    note="переплата по инвойсу",
                )
            )
        _mail(db, payment, "paid")
    elif status == "underpaid":
        if payment.status != "underpaid":
            payment.status = "underpaid"
            if paid_usd and paid_usd > 0:
                db.add(
                    BalanceEntry(
                        user_id=payment.user_id,
                        amount_usd=paid_usd,
                        kind="underpayment_credit",
                        payment_id=payment.id,
                        note="частичная оплата зачислена на баланс",
                    )
                )
            _mail(db, payment, "underpaid")
    elif status in ("expired", "failed", "refunded"):
        if payment.status == "pending":
            payment.status = status
    db.flush()
    return payment.status


def _mail(db: Session, payment: Payment, kind: str) -> None:
    user = db.get(User, payment.user_id)
    if user is None:
        return
    if kind == "paid":
        sub = subscription_of(db, payment.user_id)
        until = sub.current_period_end.strftime("%d.%m.%Y") if sub else "—"
        send_mail(
            user.email,
            f"Оплата получена: {PLANS[payment.plan].title} до {until}",
            f"Спасибо. Тариф {PLANS[payment.plan].title} действует до {until} (UTC).\n"
            f"История платежей: {settings.frontend_url}/billing",
        )
    elif kind == "underpaid":
        paid = payment.actually_paid_usd or ZERO
        rest = (payment.amount_due_usd - paid).quantize(Decimal("0.01"))
        send_mail(
            user.email,
            "Оплата пришла не полностью",
            f"По инвойсу {payment.public_id} получено {paid} USD из {payment.amount_due_usd} USD.\n"
            f"Полученная сумма зачислена на ваш баланс. Чтобы активировать тариф, оформите "
            f"новый инвойс на {rest} USD: {settings.frontend_url}/pricing — баланс применится "
            "автоматически.",
        )


def billing_status(db: Session, user: User, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(tz=UTC)
    sub = subscription_of(db, user.id)
    plan = plan_for(db, user, now)
    return {
        "plan": plan,
        "billing_enabled": settings.billing_enabled,
        "balance_usd": str(balance_of(db, user.id)),
        "subscription": None
        if sub is None
        else {
            "plan": sub.plan,
            "status": sub.status,
            "provider": sub.provider,
            "current_period_end": sub.current_period_end.isoformat(),
            "trial_end": sub.trial_end.isoformat() if sub.trial_end else None,
            "in_grace": sub.current_period_end < now
            and sub.current_period_end + timedelta(days=GRACE_DAYS) >= now,
            "days_left": max(0, (sub.current_period_end - now).days),
        },
    }


def payment_out(p: Payment) -> dict[str, Any]:
    return {
        "id": p.public_id,
        "plan": p.plan,
        "months": p.months,
        "price_usd": str(p.price_usd),
        "discount_usd": str(p.discount_usd),
        "balance_applied_usd": str(p.balance_applied_usd),
        "amount_due_usd": str(p.amount_due_usd),
        "promo_code": p.promo_code,
        "provider": p.provider,
        "status": p.status,
        "invoice_url": p.invoice_url,
        "pay_currency": p.pay_currency,
        "actually_paid": str(p.actually_paid) if p.actually_paid is not None else None,
        "actually_paid_usd": str(p.actually_paid_usd) if p.actually_paid_usd is not None else None,
        "tx_hash": p.tx_hash,
        "expires_at": p.expires_at.isoformat() if p.expires_at else None,
        "paid_at": p.paid_at.isoformat() if p.paid_at else None,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }
