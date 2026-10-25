"""Снимки публичной статистики (план 2.4, таблица ``stats_snapshots``).

``build`` — чистая функция: по списку сделок отдаёт агрегаты по ключам (все / по градации /
по инструменту) тем же кодом, что бэктест (``stats_payload`` → ``engine.backtest.summarize``).
``recompute`` пишет снимки в БД по каждой версии стратегии в live/forward и по области целиком;
``find`` достаёт снимок для ``GET /v1/stats``, если запрос ложится на ключ.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import Instrument, StatsSnapshot, StrategyVersion
from app.stats import load_trades, stats_payload
from engine.backtest import BacktestTrade

log = logging.getLogger("snapshots")
SCOPES = ("live", "forward")


@dataclass(frozen=True, slots=True)
class Key:
    scope: str
    strategy_version_id: int | None
    symbol: str | None
    grade: str | None


def build(
    scope: str, version_id: int | None, trades: list[BacktestTrade]
) -> dict[Key, dict[str, Any]]:
    """Агрегаты по ключам: все сделки, каждая градация, каждый инструмент."""
    out: dict[Key, dict[str, Any]] = {Key(scope, version_id, None, None): stats_payload(trades)}
    for g in sorted({t.grade.value for t in trades}):
        sub = [t for t in trades if t.grade.value == g]
        out[Key(scope, version_id, None, g)] = stats_payload(sub)
    for sym in sorted({t.symbol for t in trades}):
        sub = [t for t in trades if t.symbol == sym]
        out[Key(scope, version_id, sym, None)] = stats_payload(sub)
    return out


def recompute(db: Session, now: datetime | None = None) -> int:
    """Пересчитывает все снимки live/forward. Возвращает число записанных снимков."""
    now = now or datetime.now(tz=UTC)
    ids = {s: i for s, i in db.execute(select(Instrument.symbol, Instrument.id)).all()}
    written = 0
    for scope in SCOPES:
        versions = db.scalars(
            select(StrategyVersion.id).where(StrategyVersion.status == scope)
        ).all()
        targets: list[int | None] = [None, *versions]
        db.execute(delete(StatsSnapshot).where(StatsSnapshot.scope == scope))
        for vid in targets:
            trades = load_trades(db, scope, vid)
            start = min((t.signal_time for t in trades), default=None)
            for key, payload in build(scope, vid, trades).items():
                db.add(
                    StatsSnapshot(
                        scope=key.scope,
                        strategy_version_id=key.strategy_version_id,
                        instrument_id=ids.get(key.symbol) if key.symbol else None,
                        grade=key.grade,
                        period_start=start,
                        period_end=now,
                        metrics=payload,
                        computed_at=now,
                    )
                )
                written += 1
    db.commit()
    log.info("снимки статистики: %d", written)
    return written


def find(
    db: Session,
    scope: str,
    strategy_version_id: int | None,
    symbol: str | None,
    grade: str | None,
) -> StatsSnapshot | None:
    inst_id: int | None = None
    if symbol:
        inst_id = db.scalar(select(Instrument.id).where(Instrument.symbol == symbol.upper()))
        if inst_id is None:
            return None
    return db.scalar(
        select(StatsSnapshot).where(
            StatsSnapshot.scope == scope,
            StatsSnapshot.strategy_version_id.is_(None)
            if strategy_version_id is None
            else StatsSnapshot.strategy_version_id == strategy_version_id,
            StatsSnapshot.instrument_id.is_(None)
            if inst_id is None
            else StatsSnapshot.instrument_id == inst_id,
            StatsSnapshot.grade.is_(None)
            if grade is None
            else StatsSnapshot.grade == grade.upper(),
        )
    )
