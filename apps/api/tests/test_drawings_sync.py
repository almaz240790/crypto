"""Синхронизация рисунков (план 2A.5): конфликт двух устройств решается по updated_at."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.drawings_sync import FIB_LEVELS_MAX, fib_levels, merge, resolve
from app.entitlements import ENTITLEMENTS


def test_resolve_last_write_wins_and_delete_on_tie() -> None:
    a = {"client_id": "x", "updated_at": 100, "deleted_at": None, "text": "A"}
    b = {"client_id": "x", "updated_at": 200, "deleted_at": None, "text": "B"}
    assert resolve(a, b)["text"] == "B"
    assert resolve(b, a)["text"] == "B"
    assert resolve(None, a) is a
    gone = {"client_id": "x", "updated_at": 200, "deleted_at": 200}
    assert resolve(b, gone) is gone
    assert resolve(gone, b) is gone


def test_merge_two_devices_converges() -> None:
    server = [{"client_id": "1", "updated_at": 10}, {"client_id": "2", "updated_at": 50}]
    device = [
        {"client_id": "2", "updated_at": 40, "text": "старее"},
        {"client_id": "3", "updated_at": 5},
    ]
    out = merge(server, device)
    assert [d["client_id"] for d in out] == ["3", "1", "2"]
    assert "text" not in next(d for d in out if d["client_id"] == "2")
    # слияние в другом порядке даёт тот же результат
    out2 = merge(device, server)
    assert {d["client_id"]: d["updated_at"] for d in out2} == {
        d["client_id"]: d["updated_at"] for d in out
    }


def test_drawing_limits_by_plan() -> None:
    assert ENTITLEMENTS["free"].drawings_limit == 10 and not ENTITLEMENTS["free"].drawings_sync
    assert ENTITLEMENTS["pro"].drawings_limit == 100 and ENTITLEMENTS["pro"].layouts_limit == 5
    assert ENTITLEMENTS["premium"].drawings_limit is None


# --- уровни Фибоначчи (план 2A.5; ADR-0009, «Рисование», дополнение 2026-11-11) ------------------

FIB_DEFAULT = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1, 1.272, 1.618]


def test_fib_levels_normalised_like_the_client() -> None:
    """Хранится то же, что приводит клиент (normalizeFibLevels): по возрастанию, без повторов,
    3 знака; отрицательные (цели по движению) остаются."""
    assert fib_levels("fib", [1, 0.5, 0.5, -0.618, 0, 1.618]) == [-0.618, 0, 0.5, 1, 1.618]
    assert fib_levels("fib", [0.30000000000000004, 0.1 + 0.2, 0.3]) == [0.3]
    assert fib_levels("fib", [0.61803398875, 1.27201965, 2.618]) == [0.618, 1.272, 2.618]
    # половина — вверх, как Math.round клиента (а не к чётному, как round)
    assert fib_levels("fib", [0.0005, 0.0015, -0.0005]) == [0, 0.001, 0.002]
    zero = fib_levels("fib", [-0.0001, -0.0])
    assert zero == [0] and str(zero[0]) == "0.0"
    # границы: ровно 24 значения и ровно ±10 — можно
    assert fib_levels("fib", [i / 10 for i in range(24)]) == [i / 10 for i in range(24)]
    assert fib_levels("fib", [-10, 10]) == [-10, 10]
    # уже приведённый набор приведение не меняет
    assert fib_levels("fib", FIB_DEFAULT) == FIB_DEFAULT
    preset = [-1, -0.618, -0.272, *FIB_DEFAULT, 2.618]
    assert fib_levels("fib", preset) == preset


def test_fib_levels_default_and_other_types() -> None:
    """Набора нет или он пуст — NULL («уровни по умолчанию»); у других типов уровней нет."""
    assert fib_levels("fib", None) is None
    assert fib_levels("fib", []) is None
    for kind in ("trend", "hline", "rect", "position-long", "note"):
        assert fib_levels(kind, [0, 0.5, 1]) is None
        # и мусор у чужого типа запись не роняет: поле просто не хранится
        assert fib_levels(kind, [float("nan"), 99.0] * 20) is None


def test_fib_levels_rejects_garbage() -> None:
    with pytest.raises(ValueError, match="не больше 24"):
        fib_levels("fib", [i / 100 for i in range(FIB_LEVELS_MAX + 1)])
    for bad in (float("nan"), float("inf"), float("-inf"), 11.0, -10.001, 10.0004):
        with pytest.raises(ValueError, match="от −10 до 10"):
            fib_levels("fib", [0, bad, 1])


# --- /v1/drawings на реальной БД (в CI — Postgres с миграциями) ----------------------------------


def _db_available() -> bool:
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError, OperationalError

    from app.db import engine

    try:
        with engine.connect() as conn:
            conn.execute(text("select 1 from drawings limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


db_only = pytest.mark.skipif(not _db_available(), reason="БД с миграциями недоступна")


class Api:
    """Запросы /v1/drawings от имени тестового пользователя по его инструменту."""

    def __init__(self, client: TestClient, symbol: str) -> None:
        self.client = client
        self.symbol = symbol

    def item(self, client_id: str, **over: Any) -> dict[str, Any]:
        base: dict[str, Any] = {
            "client_id": client_id,
            "symbol": self.symbol,
            "timeframe": None,
            "type": "fib",
            "points": [
                {"time": 1_792_000_000, "price": 100},
                {"time": 1_792_144_000, "price": 120},
            ],
            "style": {"color": "text2", "width": 1, "dashed": False},
            "text": None,
            "levels": None,
            "locked": False,
            "updated_at": 1_000,
            "deleted_at": None,
        }
        return {**base, **over}

    def put(self, items: list[dict[str, Any]]) -> Any:
        # тело — строкой: NaN и Infinity кодировщик запроса тестового клиента не пропускает
        return self.client.put(
            "/v1/drawings",
            content=json.dumps(items, allow_nan=True),
            headers={"content-type": "application/json"},
        )

    def stored(self) -> dict[str, Any]:
        r = self.client.get(f"/v1/drawings?symbol={self.symbol}")
        assert r.status_code == 200, r.text
        return {d["client_id"]: d["levels"] for d in r.json()["items"]}


@pytest.fixture
def api() -> Iterator[Api]:
    """Пользователь и инструмент в одной транзакции: обработчик коммитит только точку сохранения,
    всё откатывается в конце теста."""
    from app import auth
    from app.db import engine
    from app.main import app
    from app.models import Instrument, User

    conn = engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    tag = datetime.now(tz=UTC).strftime("%H%M%S%f")
    # админ: без лимита рисунков и без обращения к подпискам
    user = User(email=f"fib-{tag}@example.com", role="admin")
    inst = Instrument(
        exchange="binance", symbol=f"FIB{tag[-6:]}USDT", base="FIB", quote="USDT",
        market_type="futures", tick_size=Decimal("0.1"), lot_size=Decimal(1),
    )  # fmt: skip
    db.add_all([user, inst])
    db.flush()
    app.dependency_overrides[auth.get_db] = lambda: db
    app.dependency_overrides[auth.current_user] = lambda: user
    try:
        yield Api(TestClient(app), inst.symbol)
    finally:
        app.dependency_overrides.pop(auth.get_db, None)
        app.dependency_overrides.pop(auth.current_user, None)
        db.close()
        outer.rollback()
        conn.close()


@db_only
def test_api_fib_levels_round_trip_normalised(api: Api) -> None:
    r = api.put([api.item("fib_a", levels=[1, 0.5, 0.5, -0.618, 0.30000000000000004, 0])])
    assert r.status_code == 200, r.text
    assert r.json()["items"][0]["levels"] == [-0.618, 0, 0.3, 0.5, 1]
    # новая версия того же рисунка (переключили уровень): побеждает по updated_at
    r = api.put([api.item("fib_a", levels=[-1, 0, 1, 2.618], updated_at=2_000)])
    assert r.status_code == 200, r.text
    assert r.json()["items"][0]["levels"] == [-1, 0, 1, 2.618]
    # более старая версия уровни не возвращает
    r = api.put([api.item("fib_a", levels=[0, 1], updated_at=1_500)])
    assert r.json()["items"][0]["levels"] == [-1, 0, 1, 2.618]
    # набора нет и пустой набор — NULL: клиент рисует уровни по умолчанию
    r = api.put([api.item("fib_b"), api.item("fib_c", levels=[])])
    assert [d["levels"] for d in r.json()["items"]] == [None, None]
    assert api.stored() == {"fib_a": [-1, 0, 1, 2.618], "fib_b": None, "fib_c": None}


@db_only
def test_api_fib_levels_rejected_with_422_and_nothing_stored(api: Api) -> None:
    cases: dict[str, list[float]] = {
        "25 значений": [i / 100 for i in range(25)],
        "NaN": [0, float("nan"), 1],
        "Infinity": [0, float("inf")],
        "11": [0, 11],
        "-10.5": [-10.5, 0],
    }
    for name, levels in cases.items():
        # вместе с негодным рисунком не сохраняется и годный из того же пакета
        r = api.put([api.item("ok_1", levels=[0, 1]), api.item("bad_1", levels=levels)])
        assert r.status_code == 422, f"{name}: {r.status_code} {r.text}"
        detail = r.json()["detail"]
        assert isinstance(detail, str) and detail.startswith("bad_1: "), name
        assert "Фибоначчи" in detail, name
    assert api.stored() == {}
    # ровно 24 значения и ровно ±10 — принимаются
    edge = [-10, 10, *[i / 100 for i in range(22)]]
    r = api.put([api.item("edge", levels=edge)])
    assert r.status_code == 200, r.text
    assert r.json()["items"][0]["levels"] == sorted(edge)


@db_only
def test_api_levels_of_other_types_are_not_stored(api: Api) -> None:
    """Уровни есть только у Фибоначчи: у линии поле не хранится — и запись не падает, даже если в
    нём мусор (иначе один такой рисунок остановил бы всю офлайн-очередь клиента)."""
    garbage = [float("nan"), 99, *[i / 100 for i in range(30)]]
    r = api.put(
        [
            api.item("line_1", type="trend", levels=[0, 0.5, 1]),
            api.item("line_2", type="hline", levels=garbage),
            api.item("fib_1", levels=[0, 1]),
        ]
    )
    assert r.status_code == 200, r.text
    assert [d["levels"] for d in r.json()["items"]] == [None, None, [0, 1]]
    assert api.stored() == {"line_1": None, "line_2": None, "fib_1": [0, 1]}
