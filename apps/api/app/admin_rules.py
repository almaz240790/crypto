"""Правила админки без БД (план 3.15, 10.4): переходы статусов и четырёхглазое подтверждение."""

from __future__ import annotations

ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "backtest": {"forward", "archived"},
    "forward": {"live", "backtest", "archived"},
    "live": {"forward", "archived"},
    "archived": {"backtest"},
}
MIN_REASON = 20


def transition_allowed(from_status: str, to_status: str) -> bool:
    return to_status in ALLOWED_TRANSITIONS.get(from_status, set())


def can_decide(
    requester_id: int, decider_id: int, decider_role: str, override_reason: str | None
) -> tuple[bool, str]:
    """Решение принимает другой человек. Исключение: владелец может подтвердить свою заявку,
    если в команде пока один админ, — только с письменным обоснованием; это попадает в аудит."""
    if requester_id != decider_id:
        return True, ""
    if decider_role == "owner" and override_reason and len(override_reason.strip()) >= MIN_REASON:
        return True, "owner-override"
    return False, "заявку подтверждает другой админ (владелец — с обоснованием от 20 символов)"
