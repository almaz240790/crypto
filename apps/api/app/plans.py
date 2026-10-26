"""Тарифы и цены (план 3.13, раздел 4). Деньги — только здесь; любое изменение цен — через этот файл
и подтверждение заказчика (план 10.4)."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

FREE, PRO, PREMIUM = "free", "pro", "premium"
PAID_PLANS = (PRO, PREMIUM)
PERIODS = (1, 3, 12)
"""Срок подписки в месяцах: без автопродления (план 3.13)."""
TRIAL_DAYS = 7
GRACE_DAYS = 3


@dataclass(frozen=True, slots=True)
class Plan:
    code: str
    title: str
    price_month: Decimal
    """Цена за 1 месяц, USD."""
    price_year: Decimal
    """Цена за 12 месяцев, USD (из таблицы раздела 4)."""
    quarter_discount: Decimal = Decimal("0.10")
    """Скидка за 3 месяца — 10 % (в плане число не задано; подтвердить у заказчика)."""

    def price(self, months: int) -> Decimal:
        if months == 12:
            return self.price_year
        if months == 3:
            return (self.price_month * 3 * (1 - self.quarter_discount)).quantize(Decimal("0.01"))
        if months == 1:
            return self.price_month
        raise ValueError("срок подписки: 1, 3 или 12 месяцев")


PLANS: dict[str, Plan] = {
    PRO: Plan(PRO, "Pro", Decimal("29.00"), Decimal("249.00")),
    PREMIUM: Plan(PREMIUM, "Premium", Decimal("79.00"), Decimal("690.00")),
}

RANK = {FREE: 0, PRO: 1, PREMIUM: 2}


def catalog() -> list[dict[str, object]]:
    """Для страницы тарифов: цены по всем срокам."""
    return [
        {
            "code": p.code,
            "title": p.title,
            "prices": {str(m): str(p.price(m)) for m in PERIODS},
            "price_month": str(p.price_month),
            "price_year": str(p.price_year),
        }
        for p in PLANS.values()
    ]
