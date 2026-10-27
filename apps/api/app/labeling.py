"""Разметка кандидатов фигур (план 2A.10.2, шаг 2; задача 4B.2): очередь, согласие, каппа Коэна.

Метка принимается при согласии ≥ 2 разметчиков; согласованность — попарная каппа Коэна.
"""

from __future__ import annotations

import random
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import FigureRow, MlLabel, User

LABELS = ("figure", "not_figure", "unsure")
MIN_AGREE = 2
TARGET_PER_TYPE = 600
"""План 2A.10.2: ≥ 600 размеченных кандидатов на тип."""


def cohen_kappa(a: Sequence[str], b: Sequence[str]) -> float | None:
    """Каппа Коэна для двух разметчиков по общим кандидатам (None — меньше двух пар)."""
    n = len(a)
    if n < 2 or n != len(b):
        return None
    cats = sorted(set(a) | set(b))
    po = sum(1 for x, y in zip(a, b, strict=True) if x == y) / n
    ca, cb = Counter(a), Counter(b)
    pe = sum((ca[c] / n) * (cb[c] / n) for c in cats)
    if pe == 1.0:
        return 1.0
    return round((po - pe) / (1 - pe), 4)


def consensus(labels: Iterable[str]) -> str | None:
    """Метка при согласии ≥ 2 разметчиков; None — согласия нет."""
    c = Counter(labels)
    if not c:
        return None
    label, n = c.most_common(1)[0]
    return label if n >= MIN_AGREE else None


def next_candidate(
    db: Session, labeler: User, rng: random.Random | None = None
) -> FigureRow | None:
    """Случайный ещё не размеченный этим человеком кандидат; типы с меньшим числом меток — чаще."""
    rng = rng or random.Random()
    done = select(MlLabel.candidate_figure_id).where(MlLabel.labeler_id == labeler.id)
    counts = dict(
        db.execute(
            select(FigureRow.type, func.count(MlLabel.id))
            .join(MlLabel, MlLabel.candidate_figure_id == FigureRow.id)
            .group_by(FigureRow.type)
        ).all()
    )
    pool = db.scalars(
        select(FigureRow)
        .where(FigureRow.status.in_(("confirmed", "invalidated")), FigureRow.id.not_in(done))
        .order_by(func.random())
        .limit(200)
    ).all()
    if not pool:
        return None
    weights = [1.0 / (1 + counts.get(f.type, 0)) for f in pool]
    return rng.choices(pool, weights=weights, k=1)[0]


def stats(db: Session) -> dict[str, Any]:
    rows = db.execute(
        select(
            MlLabel.candidate_figure_id,
            MlLabel.labeler_id,
            MlLabel.label,
            MlLabel.time_spent_s,
            FigureRow.type,
        ).join(FigureRow, FigureRow.id == MlLabel.candidate_figure_id)
    ).all()
    by_cand: dict[int, dict[int, str]] = defaultdict(dict)
    per_labeler: dict[int, dict[str, Any]] = defaultdict(
        lambda: {"n": 0, "time_s": 0, "labels": Counter()}
    )
    per_type: Counter[str] = Counter()
    for cand, labeler, label, t, ftype in rows:
        by_cand[cand][labeler] = label
        per_labeler[labeler]["n"] += 1
        per_labeler[labeler]["time_s"] += int(t or 0)
        per_labeler[labeler]["labels"][label] += 1
        per_type[ftype] += 1
    labelers = sorted(per_labeler)
    kappa: list[dict[str, Any]] = []
    for i, a in enumerate(labelers):
        for b in labelers[i + 1 :]:
            common = [c for c, m in by_cand.items() if a in m and b in m]
            k = cohen_kappa([by_cand[c][a] for c in common], [by_cand[c][b] for c in common])
            kappa.append({"a": a, "b": b, "n": len(common), "kappa": k})
    agreed = Counter(consensus(m.values()) for m in by_cand.values() if len(m) >= MIN_AGREE)
    names = (
        dict(db.execute(select(User.id, User.email).where(User.id.in_(labelers))).all())
        if labelers
        else {}
    )
    return {
        "labelers": [
            {
                "id": lid,
                "email": names.get(lid),
                "n": v["n"],
                "avg_time_s": round(v["time_s"] / v["n"], 1) if v["n"] else 0,
                "labels": dict(v["labels"]),
            }
            for lid, v in per_labeler.items()
        ],
        "kappa": kappa,
        "candidates_labeled": len(by_cand),
        "consensus": {k or "no_agreement": n for k, n in agreed.items()},
        "per_type": dict(per_type),
        "target_per_type": TARGET_PER_TYPE,
        "generated_at": datetime.now(tz=UTC).isoformat(),
    }
