"""NOWPayments: hosted-инвойс (пользователь выбирает монету на странице провайдера) и IPN-вебхук
с подписью HMAC-SHA512. Документация: https://documenter.getpostman.com/view/7907941/S1a32n38.

Проверка подписи — чистая функция ``verify_signature``; сетевые вызовы — только в ``create_invoice``
и ``fetch_payment``. Песочница включается ``NOWPAYMENTS_SANDBOX=true``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import httpx

from app.config import settings

# статусы провайдера → наши
STATUS_MAP = {
    "waiting": "pending",
    "confirming": "pending",
    "confirmed": "pending",
    "sending": "pending",
    "partially_paid": "underpaid",
    "finished": "paid",
    "failed": "failed",
    "refunded": "refunded",
    "expired": "expired",
}


@dataclass(frozen=True, slots=True)
class Invoice:
    invoice_id: str
    url: str


def base_url() -> str:
    return (
        "https://api-sandbox.nowpayments.io/v1"
        if settings.nowpayments_sandbox
        else "https://api.nowpayments.io/v1"
    )


def canonical(body: dict[str, Any]) -> bytes:
    """IPN подписывается JSON с ключами, отсортированными по алфавиту, без пробелов."""
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sign(body: dict[str, Any], secret: str) -> str:
    return hmac.new(secret.encode(), canonical(body), hashlib.sha512).hexdigest()


def verify_signature(body: dict[str, Any], signature: str | None, secret: str | None) -> bool:
    if not secret or not signature:
        return False
    return hmac.compare_digest(sign(body, secret), signature.strip().lower())


def create_invoice(
    order_id: str, amount_usd: Decimal, description: str, success_url: str, cancel_url: str
) -> Invoice:
    if not settings.nowpayments_api_key:
        raise RuntimeError("NOWPAYMENTS_API_KEY не задан")
    payload = {
        "price_amount": float(amount_usd),
        "price_currency": "usd",
        "order_id": order_id,
        "order_description": description,
        "ipn_callback_url": f"{settings.api_public_url}/v1/billing/webhook/nowpayments",
        "success_url": success_url,
        "cancel_url": cancel_url,
        "is_fixed_rate": True,
        "is_fee_paid_by_user": False,
    }
    r = httpx.post(
        f"{base_url()}/invoice",
        json=payload,
        headers={"x-api-key": settings.nowpayments_api_key},
        timeout=20,
    )
    r.raise_for_status()
    data = r.json()
    return Invoice(str(data["id"]), str(data["invoice_url"]))


def fetch_payment(payment_id: str) -> dict[str, Any]:
    """Сверка статуса платежа по id (повторная проверка вебхука, план 3.13)."""
    if not settings.nowpayments_api_key:
        raise RuntimeError("NOWPAYMENTS_API_KEY не задан")
    r = httpx.get(
        f"{base_url()}/payment/{payment_id}",
        headers={"x-api-key": settings.nowpayments_api_key},
        timeout=20,
    )
    r.raise_for_status()
    return dict(r.json())


def parse_ipn(body: dict[str, Any]) -> dict[str, Any]:
    """Нормализованные поля IPN: order_id, payment_id, status, оплачено (в монете и USD), монета."""
    paid_usd: Decimal | None = None
    # outcome_amount — сколько получил мерчант в outcome_currency; для USD-инвойсов
    # ориентируемся на price_amount * actually_paid / pay_amount
    try:
        price = Decimal(str(body.get("price_amount") or 0))
        pay_amount = Decimal(str(body.get("pay_amount") or 0))
        actually = Decimal(str(body.get("actually_paid") or 0))
        if price and pay_amount:
            paid_usd = (price * actually / pay_amount).quantize(Decimal("0.01"))
    except (ArithmeticError, ValueError):
        paid_usd = None
    return {
        "order_id": str(body.get("order_id") or ""),
        "payment_id": str(body.get("payment_id") or "") or None,
        "invoice_id": str(body.get("invoice_id") or "") or None,
        "status": STATUS_MAP.get(str(body.get("payment_status") or ""), "pending"),
        "provider_status": str(body.get("payment_status") or ""),
        "pay_currency": body.get("pay_currency"),
        "actually_paid": body.get("actually_paid"),
        "actually_paid_usd": paid_usd,
        "tx_hash": body.get("payin_hash") or body.get("payout_hash"),
    }
