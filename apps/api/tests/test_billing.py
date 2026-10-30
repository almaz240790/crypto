"""Биллинг (план 3.13): цена заказа, продление срока, подпись IPN, разбор статусов."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.billing import MONTH, extend_from, quote
from app.models import PromoCode
from app.payments import nowpayments
from app.plans import PLANS, catalog


def test_prices_and_discounts() -> None:
    assert PLANS["pro"].price(1) == Decimal("9.00")
    assert PLANS["pro"].price(12) == Decimal("76.00")
    assert PLANS["pro"].price(3) == Decimal("24.30")  # 27 − 10 %
    assert PLANS["premium"].price(1) == Decimal("19.00")
    assert PLANS["premium"].price(12) == Decimal("160.00")
    with pytest.raises(ValueError):
        PLANS["pro"].price(6)
    assert {p["code"] for p in catalog()} == {"pro", "premium"}


def test_quote_with_promo_and_balance() -> None:
    q = quote("pro", 1)
    assert (q.price, q.discount, q.amount_due) == (
        Decimal("9.00"),
        Decimal("0.00"),
        Decimal("9.00"),
    )
    promo = PromoCode(code="WELCOME20", percent=20, fixed_usd=Decimal(0))
    q = quote("pro", 12, promo)
    assert q.discount == Decimal("15.20") and q.amount_due == Decimal("60.80")
    q = quote("premium", 1, promo=None, balance=Decimal("100"))
    assert q.balance_applied == Decimal("19.00") and q.amount_due == Decimal("0.00")
    q = quote("premium", 1, promo=None, balance=Decimal("10"))
    assert q.balance_applied == Decimal("10.00") and q.amount_due == Decimal("9.00")
    with pytest.raises(ValueError):
        quote("pro", 1, PromoCode(code="X", percent=10, fixed_usd=Decimal(0), plan="premium"))
    with pytest.raises(ValueError):
        quote("free", 1)


def test_extend_from_adds_to_remaining_term() -> None:
    now = datetime(2026, 10, 26, tzinfo=UTC)
    assert extend_from(None, now, 1) == now + MONTH
    future = now + timedelta(days=10)
    assert extend_from(future, now, 3) == future + 3 * MONTH
    past = now - timedelta(days=5)
    assert extend_from(past, now, 12) == now + 12 * MONTH


def test_ipn_signature_and_parse() -> None:
    body = {
        "payment_id": 123,
        "payment_status": "finished",
        "order_id": "pay_abc",
        "price_amount": 29,
        "price_currency": "usd",
        "pay_amount": 29.5,
        "actually_paid": 29.5,
        "pay_currency": "usdttrc20",
        "payin_hash": "0xabc",
    }
    sig = nowpayments.sign(body, "secret")
    assert nowpayments.verify_signature(body, sig, "secret")
    assert nowpayments.verify_signature(body, sig.upper(), "secret")
    assert not nowpayments.verify_signature(body, sig, "other")
    assert not nowpayments.verify_signature(body, None, "secret")
    assert not nowpayments.verify_signature(body, sig, None)
    # смена любого поля ломает подпись
    assert not nowpayments.verify_signature({**body, "actually_paid": 1}, sig, "secret")
    upd = nowpayments.parse_ipn(body)
    assert upd["status"] == "paid" and upd["order_id"] == "pay_abc"
    assert upd["actually_paid_usd"] == Decimal("29.00") and upd["tx_hash"] == "0xabc"
    assert (
        nowpayments.parse_ipn({**body, "payment_status": "partially_paid", "actually_paid": 20})[
            "status"
        ]
        == "underpaid"
    )
    assert nowpayments.parse_ipn({"payment_status": "weird"})["status"] == "pending"
