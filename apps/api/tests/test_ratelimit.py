"""Защита от перебора (раздел 6): счётчики по окнам, 429 при превышении."""

from __future__ import annotations

import pytest
from fastapi import HTTPException, Request

from app import ratelimit
from app.ratelimit import MemoryCounter, client_ip, guard, hit


def _req(ip: str = "10.0.0.1", fwd: str | None = None) -> Request:
    headers = [(b"x-forwarded-for", fwd.encode())] if fwd else []
    return Request(
        {"type": "http", "headers": headers, "client": (ip, 1234), "method": "POST", "path": "/"}
    )


def test_hit_counts_within_window() -> None:
    c = MemoryCounter()
    assert all(hit("k", 3, 60, c) for _ in range(3))
    assert not hit("k", 3, 60, c)
    assert hit("other", 3, 60, c)


def test_client_ip_prefers_forwarded_header() -> None:
    assert client_ip(_req("10.0.0.1")) == "10.0.0.1"
    assert client_ip(_req("10.0.0.1", "203.0.113.5, 10.0.0.2")) == "203.0.113.5"


def test_guard_raises_429_per_subject_and_per_ip(monkeypatch: pytest.MonkeyPatch) -> None:
    c = MemoryCounter()
    monkeypatch.setattr(ratelimit, "_counter", lambda: c)
    for _ in range(2):
        guard(_req(), "login", "A@x.io", (2, 900), (100, 900))
    with pytest.raises(HTTPException) as e:
        guard(_req(), "login", "a@x.io", (2, 900), (100, 900))  # регистр email не важен
    assert e.value.status_code == 429 and "15 мин" in e.value.detail
    # другой email с того же IP: лимит по email свой, по IP ещё не исчерпан
    guard(_req(), "login", "b@x.io", (2, 900), (100, 900))
    # лимит по IP без субъекта
    for _ in range(3):
        guard(_req("1.1.1.1"), "register", None, (3, 60), (3, 60))
    with pytest.raises(HTTPException):
        guard(_req("1.1.1.1"), "register", None, (3, 60), (3, 60))


def test_counter_failure_does_not_block() -> None:
    class Broken:
        def incr(self, key: str) -> int:
            raise ConnectionError("redis down")

        def expire(self, key: str, seconds: int) -> None:
            return None

    assert hit("k", 1, 60, Broken())
