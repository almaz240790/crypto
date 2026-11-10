"""Версия trend-ob-retest 1.0.0 — в архив (решение владельца 2026-11-05, делегировано Fable; ADR-0012).

Revision ID: 0023
Revises: 0022
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None

_PAYLOAD = (
    '{"from": "forward", "to": "archived", "decided_at": "2026-11-05", '
    '"by": "Fable по поручению владельца (ADR-0012)", '
    '"reason": "версия 1.0 убыточна на истории (PF 0.93, −23.7 R), засоряет форвард"}'
)


def _version_id(conn: sa.Connection) -> int | None:
    row = conn.execute(
        sa.text(
            "SELECT v.id FROM strategy_versions v JOIN strategies s ON s.id = v.strategy_id "
            "WHERE s.slug = 'trend-ob-retest' AND v.version = '1.0.0'"
        )
    ).first()
    return None if row is None else int(row[0])


def _owner_id(conn: sa.Connection) -> int | None:
    row = conn.execute(
        sa.text(
            "SELECT id FROM users WHERE role = 'owner' AND deleted_at IS NULL ORDER BY id LIMIT 1"
        )
    ).first()
    return None if row is None else int(row[0])


def upgrade() -> None:
    conn = op.get_bind()
    vid = _version_id(conn)
    if vid is None:
        return
    status = conn.execute(
        sa.text("SELECT status FROM strategy_versions WHERE id = :id"), {"id": vid}
    ).scalar_one()
    if status != "forward":
        return
    conn.execute(
        sa.text(
            "UPDATE strategy_versions SET status = 'archived', approved_by = 'ADR-0012' "
            "WHERE id = :id"
        ),
        {"id": vid},
    )
    actor = _owner_id(conn)
    if actor is not None:
        conn.execute(
            sa.text(
                "INSERT INTO admin_audit (actor_id, action, target, payload) "
                "VALUES (:a, 'status.delegated', :t, CAST(:p AS jsonb))"
            ),
            {"a": actor, "t": f"strategy_version:{vid}", "p": _PAYLOAD},
        )


def downgrade() -> None:
    conn = op.get_bind()
    vid = _version_id(conn)
    if vid is None:
        return
    conn.execute(
        sa.text(
            "UPDATE strategy_versions SET status = 'forward', approved_by = NULL "
            "WHERE id = :id AND status = 'archived' AND approved_by = 'ADR-0012'"
        ),
        {"id": vid},
    )
    conn.execute(
        sa.text("DELETE FROM admin_audit WHERE action = 'status.delegated' AND target = :t"),
        {"t": f"strategy_version:{vid}"},
    )
