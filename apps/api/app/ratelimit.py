"""Защита от перебора (план, раздел 6: «rate limit, Turnstile»): счётчики в Redis по окнам.

``hit(key, limit, window)`` — True, если попытка в пределах лимита. Без Redis (локально, тесты)
используется память процесса, чтобы логика проверялась без инфраструктуры. Сбой Redis не
блокирует вход: лучше пропустить, чем положить авторизацию.
"""

from __future__ import annotations

import time
from typing import Any, Protocol

import redis
from fastapi import HTTPException, Request

from app.config import settings

# окна и лимиты: попыток за окно (секунды)
LOGIN_PER_EMAIL = (10, 900)  # 10 за 15 минут на email
LOGIN_PER_IP = (30, 900)  # 30 за 15 минут с одного IP
TWO_FACTOR_PER_IP = (10, 900)
REGISTER_PER_IP = (5, 3600)
MAIL_PER_EMAIL = (5, 3600)  # письма: magic link, сброс пароля, повторная отправка


class Counter(Protocol):
    def incr(self, key: str) -> Any: ...
    def expire(self, key: str, seconds: int) -> Any: ...


class MemoryCounter:
    """Счётчик в памяти: для тестов и запуска без Redis."""

    def __init__(self) -> None:
        self.values: dict[str, int] = {}

    def incr(self, key: str) -> int:
        self.values[key] = self.values.get(key, 0) + 1
        return self.values[key]

    def expire(self, key: str, seconds: int) -> None:
        return None


_memory = MemoryCounter()


def _counter() -> Counter:
    if not settings.redis_url:
        return _memory
    return redis.from_url(settings.redis_url, socket_timeout=2)


def hit(key: str, limit: int, window: int, counter: Counter | None = None) -> bool:
    """Регистрирует попытку; False — лимит исчерпан для текущего окна."""
    bucket = int(time.time() // window)
    k = f"rate:{key}:{bucket}"
    try:
        c = counter or _counter()
        n = int(c.incr(k))
        c.expire(k, window)
    except Exception:
        return True
    return n <= limit


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "?"


def guard(
    request: Request,
    scope: str,
    subject: str | None,
    per_subject: tuple[int, int],
    per_ip: tuple[int, int] | None = None,
) -> None:
    """Бросает 429, если лимит по субъекту (email и т. п.) или по IP исчерпан."""
    ok = True
    if subject:
        ok = hit(f"{scope}:s:{subject.lower()}", *per_subject)
    if per_ip:
        ok = hit(f"{scope}:ip:{client_ip(request)}", *per_ip) and ok
    if not ok:
        minutes = max(1, (per_ip or per_subject)[1] // 60)
        raise HTTPException(429, f"слишком много попыток, подождите {minutes} мин")
