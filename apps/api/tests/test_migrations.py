"""Миграции Alembic: одна голова и разные идентификаторы ревизий.

Параллельные ветки продолжают одну и ту же ревизию (так было с 0022 — область сигнала и вход в
админку, ADR-0011). После сведения веток две головы или два одинаковых идентификатора ломают
``alembic upgrade head`` на выкладке — этот тест ловит это до выкладки. Без БД."""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

API = Path(__file__).resolve().parents[1]
VERSIONS = API / "alembic" / "versions"
REVISION = re.compile(r'^revision\s*(?::\s*str\s*)?=\s*"([^"]+)"', re.M)
DOWN = re.compile(r'^down_revision\s*(?::[^=]*)?=\s*(?:"([^"]+)"|None)', re.M)


def _revisions() -> dict[str, str | None]:
    out: list[tuple[str, str | None]] = []
    for path in sorted(VERSIONS.glob("*.py")):
        text = path.read_text(encoding="utf-8")
        rev, down = REVISION.search(text), DOWN.search(text)
        assert rev and down, f"{path.name}: нет revision / down_revision"
        out.append((rev.group(1), down.group(1)))
    counts = Counter(r for r, _ in out)
    assert [r for r, n in counts.items() if n > 1] == [], "одинаковые идентификаторы ревизий"
    return dict(out)


def test_revision_ids_are_unique_and_fit_the_version_column() -> None:
    revs = _revisions()
    assert len(revs) >= 22
    # alembic_version.version_num — VARCHAR(32)
    assert all(0 < len(r) <= 32 for r in revs)
    assert all(down is None or down in revs for down in revs.values())


def test_single_head_and_linear_history() -> None:
    revs = _revisions()
    parents = Counter(d for d in revs.values() if d is not None)
    forks = sorted(d for d, n in parents.items() if n > 1)
    assert forks == [], f"две ревизии продолжают одну: {forks} — сцепите их по очереди"
    cfg = Config()
    cfg.set_main_option("script_location", str(API / "alembic"))
    assert len(ScriptDirectory.from_config(cfg).get_heads()) == 1


def test_admin_login_revision_follows_strategy_archive() -> None:
    """ADR-0011: ревизия входа в админку при сведении веток встала после 0023."""
    assert "0024" in _revisions()


def test_cost_r_revision_follows_admin_login() -> None:
    """Задача 3: ``signal_results.cost_r`` писалась на базе 0021 как 0023; при сведении с архивом
    версии 1.0.0 (0023) и входом в админку (0024) стала ревизией 0025 после 0024."""
    assert _revisions()["0025"] == "0024"


def test_signal_corrections_revision_follows_cost_r() -> None:
    """Задачи 7 и 10: исправления исходов форварда (``signal_corrections``, ``deploy_jobs``) —
    ревизия 0026 после 0025. Если параллельная ветка займёт 0026 раньше, ревизию переименовать
    при сведении (0027 после 0026)."""
    assert _revisions()["0026"] == "0025"
