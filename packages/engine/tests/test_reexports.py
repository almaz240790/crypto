"""Имена, перенесённые из одного модуля движка в другой, доступны и по прежнему пути импорта.

``interval_start`` переехал из ``engine.tracker`` в ``engine.candles`` (им пользуются трекер и
правило ``engine.occupancy``). Код вне этой ветки импортирует его из ``engine.tracker``; для
``engine.*`` включён ``mypy --strict``, а он не считает импортированное имя экспортом модуля без
явного ``as``. Поэтому проверяется не только импорт во время выполнения, но и сам mypy.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import engine.candles
import engine.tracker

ROOT = Path(__file__).resolve().parents[3]
MOVED = {"engine.tracker": ("interval_start",)}
"""Модуль прежнего пути → имена, которые из него по-прежнему импортируют."""


def test_moved_names_are_the_same_objects() -> None:
    assert engine.tracker.interval_start is engine.candles.interval_start


def test_moved_names_pass_mypy_strict(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    api = pytest.importorskip("mypy.api")
    lines = [f"from {mod} import {name}" for mod, names in MOVED.items() for name in names]
    lines += [f"print({name})" for names in MOVED.values() for name in names]
    snippet = tmp_path / "uses_old_paths.py"
    snippet.write_text("\n".join(lines) + "\n")
    monkeypatch.setenv("MYPYPATH", str(ROOT / "packages" / "engine"))
    out, err, code = api.run(
        [
            "--config-file",
            str(ROOT / "pyproject.toml"),
            "--no-incremental",
            "--cache-dir",
            str(tmp_path / "cache"),
            str(snippet),
        ]
    )
    assert code == 0, out + err
