"""Общие фикстуры тестов API.

Сигналы по умолчанию закрыты (ADR-0013, ``SIGNALS_PUBLIC=false``): видят их только admin и owner.
Тесты, написанные до этого решения, проверяют поведение открытых сигналов — и тем самым то, что
включённый выключатель возвращает его без изменений, — поэтому для них выключатель включён.
Матрица доступа при закрытых сигналах — ``test_signals_access.py``: там фикстура
``signals_closed`` выключает его поверх этой.
"""

from __future__ import annotations

import pytest

from app.config import settings


@pytest.fixture(autouse=True)
def signals_public(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "signals_public", True)
