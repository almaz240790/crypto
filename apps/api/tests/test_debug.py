"""Служебные страницы /debug: доступ по токену и рендер PNG на синтетических данных."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app import debug
from app.config import settings
from app.main import app
from engine.candles import Candle, Timeframe
from engine.structure import analyze_structure
from engine.zones import analyze_zones


def _candles(n: int = 120) -> list[Candle]:
    t0 = datetime(2024, 1, 1, tzinfo=UTC)
    out = []
    for i in range(n):
        base = 100 + 10 * ((i // 7) % 3) + (i % 7)  # зигзаг с перехлёстом
        out.append(
            Candle(
                open_time=t0 + Timeframe.H4.delta * i,
                open=Decimal(base),
                high=Decimal(base + 2),
                low=Decimal(base - 2),
                close=Decimal(base + 1),
                volume=Decimal(1),
            )
        )
    return out


def test_render_png_produces_image() -> None:
    candles = _candles()
    s = analyze_structure(candles)
    png = debug.render_png(candles, s, analyze_zones(candles, s), 80, "test")
    assert png[:8] == b"\x89PNG\r\n\x1a\n"


def test_debug_disabled_without_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "debug_token", None)
    client = TestClient(app)
    assert client.get("/debug/structure/BTCUSDT.png?token=x").status_code == 404


def test_debug_requires_correct_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "debug_token", "secret")
    monkeypatch.setattr(debug, "load_candles", lambda *a, **k: _candles())
    client = TestClient(app)
    assert client.get("/debug/structure/BTCUSDT.png?token=wrong").status_code == 403
    ok = client.get("/debug/structure/btcusdt.png?token=secret&n=80")
    assert ok.status_code == 200 and ok.headers["content-type"] == "image/png"
    js = client.get("/debug/structure/BTCUSDT.json?token=secret&n=80").json()
    assert js["symbol"] == "BTCUSDT" and "events" in js and "zones" in js
