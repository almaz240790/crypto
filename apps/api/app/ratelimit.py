"""Защита от перебора (план, раздел 6: «rate limit, Turnstile»): счётчики в Redis по окнам.

``hit(key, limit, window)`` — True, если попытка в пределах лимита. Без Redis (локально, тесты)
используется память процесса, чтобы логика проверялась без инфраструктуры. Сбой Redis не
блокирует вход: лучше пропустить, чем положить авторизацию.

Режим ``strict`` (вход в админку, ADR-0011): окно скользящее (текущее окно + доля прошлого), чтобы
на границе окон не открывался двойной запас попыток; при сбое Redis счёт идёт в памяти процесса.
``take``/``give_back`` — лимит только по неудачам (верный пароль возвращает попытку владельцу);
``hit_total`` — счётчик на весь срок жизни (билет второго шага), без привязки к часам.
"""

from __future__ import annotations

import hmac
import ipaddress
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
# Вход в админку (ADR-0011): строже, чем на сайте; при сбое Redis — счётчик в памяти (strict)
ADMIN_LOGIN_PER_EMAIL = (5, 900)  # 5 попыток пароля за 15 минут на адрес
ADMIN_LOGIN_PER_IP = (10, 900)
ADMIN_CODE_PER_USER = (10, 900)  # 10 кодов за 15 минут на аккаунт (TOTP — 6 цифр)
ADMIN_CODE_PER_IP = (20, 900)
ADMIN_WRONG_CODES_PER_TICKET = 5  # 5-й неверный код сжигает билет — снова пароль или ссылка
ADMIN_MAIL_PER_EMAIL = (3, 3600)  # письма со ссылкой входа в админку
ADMIN_MAIL_PER_IP = (10, 3600)


class Counter(Protocol):
    def incr(self, key: str) -> Any: ...
    def expire(self, key: str, seconds: int) -> Any: ...
    def get(self, key: str) -> Any: ...
    def decr(self, key: str) -> Any: ...


class MemoryCounter:
    """Счётчик в памяти: для тестов и запуска без Redis."""

    def __init__(self) -> None:
        self.values: dict[str, int] = {}

    def incr(self, key: str) -> int:
        self.values[key] = self.values.get(key, 0) + 1
        return self.values[key]

    def expire(self, key: str, seconds: int) -> None:
        return None

    def get(self, key: str) -> int:
        return self.values.get(key, 0)

    def decr(self, key: str) -> int:
        self.values[key] = max(0, self.values.get(key, 0) - 1)
        return self.values[key]


_memory = MemoryCounter()


def _counter() -> Counter:
    if not settings.redis_url:
        return _memory
    return redis.from_url(settings.redis_url, socket_timeout=2)


def _keys(key: str, window: int, now: float) -> tuple[str, str, float]:
    """Ключ текущего и прошлого окна и доля прошлого окна, которая ещё «видна» скользящему окну."""
    bucket = int(now // window)
    return f"rate:{key}:{bucket}", f"rate:{key}:{bucket - 1}", 1 - (now % window) / window


def _read(c: Counter, key: str) -> int:
    v = c.get(key)
    return int(v) if v else 0


def hit(
    key: str, limit: int, window: int, counter: Counter | None = None, *, strict: bool = False
) -> bool:
    """Регистрирует попытку; False — лимит исчерпан для текущего окна.

    ``strict`` (вход в админку): скользящее окно; при сбое Redis — счёт в памяти процесса."""
    cur, prev, share = _keys(key, window, time.time())
    try:
        c = counter or _counter()
        n = int(c.incr(cur))
        c.expire(cur, window * 2 if strict else window)
        p = _read(c, prev) if strict else 0
    except Exception:
        if not strict:
            return True
        n, p = _memory.incr(cur), _memory.get(prev)
    return n + p * share <= limit


def take(key: str, limit: int, window: int, counter: Counter | None = None) -> tuple[bool, str]:
    """Как ``hit(strict=True)``, но возвращает ключ окна: попытку можно вернуть (:func:`give_back`).

    Так лимит считает только неудачи (верный пароль возвращает попытку), а одновременные запросы
    всё равно не превышают лимит: каждый занимает попытку до проверки пароля."""
    cur, prev, share = _keys(key, window, time.time())
    try:
        c = counter or _counter()
        n = int(c.incr(cur))
        c.expire(cur, window * 2)
        p = _read(c, prev)
    except Exception:
        n, p = _memory.incr(cur), _memory.get(prev)
    return n + p * share <= limit, cur


def give_back(bucket_key: str, counter: Counter | None = None) -> None:
    """Вернуть попытку, занятую :func:`take` (удачный вход)."""
    try:
        c = counter or _counter()
        c.decr(bucket_key)
    except Exception:
        _memory.values[bucket_key] = max(0, _memory.values.get(bucket_key, 0) - 1)


def hit_total(key: str, limit: int, ttl: int, counter: Counter | None = None) -> bool:
    """Счётчик на весь срок ``ttl`` с первой попытки (без окон по часам); False — лимит исчерпан."""
    k = f"rate:{key}:total"
    try:
        c = counter or _counter()
        n = int(c.incr(k))
        if n == 1:
            c.expire(k, ttl)
    except Exception:
        n = _memory.incr(k)
    return n <= limit


def _ip(value: str | None) -> str | None:
    """Нормальный IP-адрес или None: в аудит, сеансы и письма не попадает произвольный текст."""
    if not value:
        return None
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


PROXY_HEADER = "x-pl-proxy"
PROXY_IP_HEADER = "x-pl-client-ip"


def from_site_proxy(request: Request) -> bool:
    """Запрос пришёл через прокси сайта (/v1 в Next) с общим секретом PROXY_SECRET."""
    secret = settings.proxy_secret
    got = request.headers.get(PROXY_HEADER)
    return bool(secret) and got is not None and hmac.compare_digest(got, secret or "")


def client_ip(request: Request) -> str:
    """IP клиента для лимитов и аудита (ADR-0011).

    Если задан PROXY_SECRET и запрос подписан прокси сайта — адрес, который прокси увидел сам
    (заголовок ``x-pl-client-ip``). Иначе — первое значение ``X-Forwarded-For`` (как раньше:
    его может подставить клиент, см. ADR-0011, «Известные ограничения»). Всегда — только
    правильный IP-адрес, иначе адрес соединения."""
    if from_site_proxy(request):
        ip = _ip(request.headers.get(PROXY_IP_HEADER))
        if ip:
            return ip
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        ip = _ip(fwd.split(",")[0])
        if ip:
            return ip
    return (_ip(request.client.host) if request.client else None) or "?"


def guard(
    request: Request,
    scope: str,
    subject: str | None,
    per_subject: tuple[int, int],
    per_ip: tuple[int, int] | None = None,
    *,
    strict: bool = False,
) -> None:
    """Бросает 429, если лимит по субъекту (email и т. п.) или по IP исчерпан."""
    ok = True
    if subject:
        ok = hit(f"{scope}:s:{subject.lower()}", *per_subject, strict=strict)
    if per_ip:
        ok = hit(f"{scope}:ip:{client_ip(request)}", *per_ip, strict=strict) and ok
    if not ok:
        minutes = max(1, (per_ip or per_subject)[1] // 60)
        raise HTTPException(429, f"слишком много попыток, подождите {minutes} мин")
