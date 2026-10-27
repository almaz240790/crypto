"""Синхронизация рисунков (план 2A.5): конфликт двух устройств решается по updated_at."""

from __future__ import annotations

from app.drawings_sync import merge, resolve
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
