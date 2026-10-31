"""Сервис свечных паттернов (план 2A.10.1, 2A.10.4; задача 2B.11).

Детекция по закрытию свечи, бэкфилл по истории, отработка через N свечей и агрегаты
с интервалом Уилсона. Паттерны не являются сигналами (2A.10.5); тексты — по 2A.10.6.
"""

from __future__ import annotations

import logging
import math
from dataclasses import asdict, replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import BigInteger, delete, func, insert, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.analysis import params_for_version
from app.chart_data import PAGE, STORED, latest_version, load_candles
from app.models import (
    Instrument,
    Pattern,
    PatternEvent,
    PatternOutcome,
    PatternRulesVersion,
    PatternStatsSnapshot,
)
from engine.candles import Candle, Timeframe, closed_only
from engine.liquidity import Sweep, find_sweeps
from engine.params import StrategyParams
from engine.patterns import (
    DEFAULT_PATTERN_PARAMS,
    PatternMatch,
    PatternParams,
    PatternType,
    detect_patterns,
    outcome_from,
    title,
)
from engine.structure import MarketStructure, Trend, analyze_structure, classify_trend
from engine.zones import Zone, analyze_zones

log = logging.getLogger("patterns")

DETECT_TFS = (Timeframe.M15, Timeframe.H1, Timeframe.H4, Timeframe.D1, Timeframe.W1)
"""Таймфреймы live-детекции (план 2A.10.1: 15m–1w)."""
BACKFILL_TFS = (Timeframe.H4, Timeframe.D1, Timeframe.W1)
"""Для бэкфилла нужна хранимая история (1m хранится недолго, 15m/1h из него не восстановить)."""
HTF: dict[Timeframe, Timeframe] = {
    Timeframe.M15: Timeframe.H1,
    Timeframe.H1: Timeframe.H4,
    Timeframe.H4: Timeframe.D1,
    Timeframe.D1: Timeframe.W1,
}
LOW_N = 30
"""Меньше — «мало данных», процент не показываем (план 2A.10.4)."""
STATS_HORIZON = 5
"""Горизонт по умолчанию в карточке паттерна."""
MIN_HTF = 20


def _dec(x: Decimal | None) -> str | None:
    return None if x is None else format(x.normalize(), "f")


def _num(x: Decimal | float | None) -> Decimal | None:
    return None if x is None else Decimal(str(x))


# --- версия правил --------------------------------------------------------------------------------


def rules_json(params: PatternParams) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in asdict(params).items():
        out[k] = str(v) if isinstance(v, Decimal) else list(v) if isinstance(v, tuple) else v
    return out


def rules_version(
    db: Session, params: PatternParams = DEFAULT_PATTERN_PARAMS
) -> PatternRulesVersion:
    """Строка версии правил; создаётся при первом запуске. Правила после создания не меняются."""
    row = db.scalar(
        select(PatternRulesVersion).where(PatternRulesVersion.version == params.rules_version)
    )
    if row is None:
        row = PatternRulesVersion(version=params.rules_version, rules=rules_json(params))
        db.add(row)
        db.flush()
    return row


# --- входы движка ---------------------------------------------------------------------------------


def strategy_params(db: Session) -> StrategyParams:
    ver = latest_version(db)
    return params_for_version(ver.version if ver else None)


def analysis(
    candles: list[Candle], sp: StrategyParams
) -> tuple[MarketStructure, list[Zone], list[Sweep]]:
    structure = analyze_structure(candles, sp.structure)
    zones = analyze_zones(candles, structure, sp.zones)
    sweeps = find_sweeps(candles, structure.swings)
    return structure, zones, sweeps


def htf_trend_at(
    htf_candles: list[Candle], htf_structure: MarketStructure, htf: Timeframe, at: datetime
) -> Trend | None:
    """Тренд старшего таймфрейма по swing-ам, подтверждённым к моменту ``at`` (без утечки)."""
    if len(htf_candles) < MIN_HTF:
        return None
    swings = [
        s
        for s in htf_structure.swings
        if s.confirmed_index < len(htf_candles)
        and htf_candles[s.confirmed_index].close_time(htf) <= at
    ]
    return classify_trend(swings)


def _with_htf(
    matches: list[PatternMatch],
    candles: list[Candle],
    tf: Timeframe,
    htf_candles: list[Candle],
    htf_structure: MarketStructure | None,
    htf: Timeframe | None,
) -> list[PatternMatch]:
    if htf is None or htf_structure is None:
        return matches
    out = []
    for m in matches:
        t = htf_trend_at(htf_candles, htf_structure, htf, candles[m.index].close_time(tf))
        out.append(replace(m, context=replace(m.context, htf_trend=t)))
    return out


def _load_all(
    db: Session, instrument_id: int, tf: Timeframe, since: datetime | None
) -> list[Candle]:
    if tf not in STORED:
        raise ValueError(f"бэкфилл только по хранимым таймфреймам: {tf.value}")
    rows = db.execute(
        text(
            "select open_time, open, high, low, close, volume, quote_volume, trades from candles "
            "where instrument_id=:i and timeframe=:tf "
            "and (CAST(:s AS timestamptz) is null or open_time >= CAST(:s AS timestamptz)) "
            "order by open_time"
        ),
        {"i": instrument_id, "tf": tf.value, "s": since},
    ).all()
    return [
        Candle(r[0].astimezone(UTC), r[1], r[2], r[3], r[4], r[5], r[6] or Decimal(0), r[7] or 0)
        for r in rows
    ]


# --- запись ---------------------------------------------------------------------------------------


def context_json(m: PatternMatch) -> dict[str, Any]:
    c = m.context
    return {
        "trend": c.trend.value if c.trend else None,
        "htf_trend": c.htf_trend.value if c.htf_trend else None,
        "prior_run": c.prior_run,
        "volume_ratio": _dec(c.volume_ratio),
        "zone_distance_atr": _dec(c.zone_distance_atr),
        "level_distance_atr": _dec(c.level_distance_atr),
        "sweep": c.sweep,
        "pierced": c.pierced,
        "above_ema": c.above_ema,
        "overheat": c.overheat,
    }


def geometry_json(m: PatternMatch, candles: list[Candle]) -> dict[str, Any]:
    return {
        "price": _dec(m.price),
        "atr": _dec(m.atr),
        "candle_time": int(candles[m.index].open_time.timestamp()),
        "candles": [
            [int(c.open_time.timestamp()), _dec(c.open), _dec(c.high), _dec(c.low), _dec(c.close)]
            for c in candles[m.start_index : m.index + 1]
        ],
    }


def store(
    db: Session,
    inst: Instrument,
    tf: Timeframe,
    candles: list[Candle],
    matches: list[PatternMatch],
    rv: PatternRulesVersion,
    source: str,
) -> list[tuple[Pattern, PatternMatch]]:
    """Пишет новые отметки (дубли по уникальному ключу пропускаются) и событие ``confirmed``."""
    if not matches:
        return []
    closes = {candles[m.index].close_time(tf) for m in matches}
    existing = set(
        db.execute(
            select(Pattern.type, Pattern.candle_close_time).where(
                Pattern.instrument_id == inst.id,
                Pattern.timeframe == tf.value,
                Pattern.rules_version_id == rv.id,
                Pattern.candle_close_time.in_(closes),
            )
        ).all()
    )
    out: list[tuple[Pattern, PatternMatch]] = []
    for m in matches:
        close_time = candles[m.index].close_time(tf)
        if (m.type.value, close_time) in existing:
            continue
        row = Pattern(
            instrument_id=inst.id,
            timeframe=tf.value,
            type=m.type.value,
            direction=m.direction.value if m.direction else None,
            status="confirmed",
            start_time=candles[m.start_index].open_time,
            confirm_time=close_time,
            candle_close_time=close_time,
            geometry=geometry_json(m, candles),
            context=context_json(m),
            is_significant=m.significant,
            rules_version_id=rv.id,
            source=source,
        )
        # гонка бэкфилла и live-детектора: дубль по uq_patterns_candle пропускаем (savepoint)
        try:
            with db.begin_nested():
                db.add(row)
                db.flush()
        except IntegrityError:
            if row in db:  # после отката savepoint объект обычно уже вне сессии
                db.expunge(row)
            continue
        db.add(
            PatternEvent(
                pattern_id=row.id,
                type="confirmed",
                occurred_at=close_time,
                details={"source": source, "rules_version": rv.version},
            )
        )
        out.append((row, m))
    return out


# --- live-детекция ---------------------------------------------------------------------------


def detect_and_store(
    db: Session,
    inst: Instrument,
    tf: Timeframe,
    now: datetime,
    params: PatternParams = DEFAULT_PATTERN_PARAMS,
    source: str = "live",
) -> list[Pattern]:
    """Отметки, подтверждённые на закрытии последней закрытой свечи ``tf`` к моменту ``now``."""
    candles, _ = load_candles(db, inst.id, tf, None, PAGE)
    candles = closed_only(candles, tf, now)
    if len(candles) <= params.warmup:
        return []
    sp = strategy_params(db)
    structure, zones, sweeps = analysis(candles, sp)
    matches = detect_patterns(
        candles,
        params,
        structure=structure,
        zones=zones,
        sweeps=sweeps,
        since=len(candles) - 1,
    )
    htf = HTF.get(tf)
    if matches and htf is not None:
        hc, _ = load_candles(db, inst.id, htf, None, 200)
        hc = closed_only(hc, htf, now)
        hs = analyze_structure(hc, sp.structure) if len(hc) >= MIN_HTF else None
        matches = _with_htf(matches, candles, tf, hc, hs, htf)
    rv = rules_version(db, params)
    return [row for row, _ in store(db, inst, tf, candles, matches, rv, source)]


# --- бэкфилл --------------------------------------------------------------------------------------


def backfill(
    db: Session,
    inst: Instrument,
    tf: Timeframe,
    params: PatternParams = DEFAULT_PATTERN_PARAMS,
    since: datetime | None = None,
    now: datetime | None = None,
) -> dict[str, int]:
    """Прогон по всей истории ``tf`` с записью отметок (source=backfill) и готовых отработок."""
    now = now or datetime.now(tz=UTC)
    candles = closed_only(_load_all(db, inst.id, tf, since), tf, now)
    if len(candles) <= params.warmup:
        return {"candles": len(candles), "patterns": 0, "outcomes": 0}
    sp = strategy_params(db)
    structure, zones, sweeps = analysis(candles, sp)
    matches = detect_patterns(candles, params, structure=structure, zones=zones, sweeps=sweeps)
    htf = HTF.get(tf)
    if htf is not None and htf in STORED:
        hc = closed_only(_load_all(db, inst.id, htf, None), htf, now)
        hs = analyze_structure(hc, sp.structure) if len(hc) >= MIN_HTF else None
        matches = _with_htf(matches, candles, tf, hc, hs, htf)
    rv = rules_version(db, params)
    stored = store(db, inst, tf, candles, matches, rv, "backfill")
    n_out = 0
    for row, m in stored:
        after = candles[m.index + 1 :]
        done = []
        for h in params.outcome_horizons:
            if len(after) < h:
                continue
            o = outcome_from(candles[m.index].close, m.direction, after, h, m.atr, params)
            db.add(
                PatternOutcome(
                    pattern_id=row.id,
                    horizon_bars=h,
                    moved_expected=o.hit,
                    move_atr_favorable=o.max_favorable_atr,
                    move_atr_adverse=o.max_adverse_atr,
                )
            )
            done.append(h)
            n_out += 1
        if len(done) == len(params.outcome_horizons):
            row.status = "outcome_recorded"
            db.add(
                PatternEvent(
                    pattern_id=row.id,
                    type="outcome_recorded",
                    occurred_at=candles[min(m.index + max(done), len(candles) - 1)].close_time(tf),
                    details={"horizons": done},
                )
            )
    return {"candles": len(candles), "patterns": len(stored), "outcomes": n_out}


# --- отработка live-отметок ------------------------------------------------------------------


def _candles_after(
    db: Session, instrument_id: int, tf: Timeframe, candle_time: datetime, now: datetime, n: int
) -> list[Candle]:
    if tf in STORED:
        rows = db.execute(
            text(
                "select open_time, open, high, low, close, volume, quote_volume, trades "
                "from candles where instrument_id=:i and timeframe=:tf and open_time > :t "
                "order by open_time limit :n"
            ),
            {"i": instrument_id, "tf": tf.value, "t": candle_time, "n": n},
        ).all()
        cs = [
            Candle(
                r[0].astimezone(UTC), r[1], r[2], r[3], r[4], r[5], r[6] or Decimal(0), r[7] or 0
            )
            for r in rows
        ]
    else:
        cs, _ = load_candles(db, instrument_id, tf, None, PAGE)
        cs = [c for c in cs if c.open_time > candle_time][:n]
    return closed_only(cs, tf, now)


def evaluate_outcomes(
    db: Session,
    now: datetime | None = None,
    params: PatternParams = DEFAULT_PATTERN_PARAMS,
    limit: int = 500,
) -> int:
    """Дописывает отработку по горизонтам, для которых уже закрылось достаточно свечей."""
    now = now or datetime.now(tz=UTC)
    rows = db.scalars(
        select(Pattern)
        .where(Pattern.status == "confirmed")
        .order_by(Pattern.candle_close_time)
        .limit(limit)
    ).all()
    written = 0
    max_h = max(params.outcome_horizons)
    for p in rows:
        tf = Timeframe(p.timeframe)
        if p.candle_close_time + tf.delta * min(params.outcome_horizons) > now:
            continue
        have = set(
            db.scalars(
                select(PatternOutcome.horizon_bars).where(PatternOutcome.pattern_id == p.id)
            ).all()
        )
        candle_time = datetime.fromtimestamp(int(p.geometry["candle_time"]), tz=UTC)
        after = _candles_after(db, p.instrument_id, tf, candle_time, now, max_h)
        ref = Decimal(p.geometry["candles"][-1][4])
        atr_value = Decimal(p.geometry["atr"])
        direction = None if p.direction is None else _dir(p.direction)
        for h in params.outcome_horizons:
            if h in have or len(after) < h:
                continue
            o = outcome_from(ref, direction, after, h, atr_value, params)
            db.add(
                PatternOutcome(
                    pattern_id=p.id,
                    horizon_bars=h,
                    moved_expected=o.hit,
                    move_atr_favorable=o.max_favorable_atr,
                    move_atr_adverse=o.max_adverse_atr,
                )
            )
            have.add(h)
            written += 1
        if have >= set(params.outcome_horizons):
            p.status = "outcome_recorded"
            db.add(
                PatternEvent(
                    pattern_id=p.id,
                    type="outcome_recorded",
                    occurred_at=now,
                    details={"horizons": sorted(have)},
                )
            )
    return written


def _dir(s: str) -> Any:
    from engine.structure import Direction

    return Direction(s)


# --- агрегаты -------------------------------------------------------------------------------------


def wilson(k: int, n: int, z: float = 1.96) -> tuple[Decimal, Decimal]:
    """95 % интервал Уилсона для доли k/n."""
    if n <= 0:
        return Decimal(0), Decimal(0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return Decimal(f"{max(0.0, centre - half):.4f}"), Decimal(f"{min(1.0, centre + half):.4f}")


STATS_SQL = text(
    """
    select p.type, p.timeframe, p.source, o.horizon_bars,
           p.instrument_id, p.is_significant,
           extract(year from p.candle_close_time)::int as year,
           count(*) as n, count(*) filter (where o.moved_expected) as k,
           avg(o.move_atr_favorable) as fav, avg(o.move_atr_adverse) as adv,
           min(p.candle_close_time) as ps, max(p.candle_close_time) as pe
    from pattern_outcomes o join patterns p on p.id = o.pattern_id
    where o.moved_expected is not null
    group by grouping sets (
      (p.type, p.timeframe, p.source, o.horizon_bars),
      (p.type, p.timeframe, p.source, o.horizon_bars, p.is_significant),
      (p.type, p.timeframe, p.source, o.horizon_bars, p.instrument_id),
      (p.type, p.timeframe, p.source, o.horizon_bars, extract(year from p.candle_close_time)::int),
      (p.type, p.timeframe, p.source, o.horizon_bars, p.is_significant,
       extract(year from p.candle_close_time)::int)
    )
    """
)


def snapshot_rows(rows: list[Any], now: datetime) -> list[dict[str, Any]]:
    """Строки ``pattern_stats_snapshots`` из результата STATS_SQL (чистая функция)."""
    out = []
    for r in rows:
        n, k = int(r.n), int(r.k)
        low, high = wilson(k, n)
        out.append(
            {
                "type": r.type,
                "timeframe": r.timeframe,
                "scope": r.source,
                "horizon_bars": int(r.horizon_bars),
                "instrument_id": r.instrument_id,
                "with_context": r.is_significant,
                "year": r.year,
                "period_start": r.ps,
                "period_end": r.pe,
                "n": n,
                "success_rate": Decimal(f"{k / n:.4f}"),
                "ci_low": low,
                "ci_high": high,
                "avg_move_atr": _num(r.fav),
                "avg_adverse_atr": _num(r.adv),
                "computed_at": now,
            }
        )
    return out


def recompute_stats(db: Session, now: datetime | None = None) -> int:
    now = now or datetime.now(tz=UTC)
    rows = snapshot_rows(list(db.execute(STATS_SQL).all()), now)
    db.execute(delete(PatternStatsSnapshot))
    if rows:
        db.execute(insert(PatternStatsSnapshot), rows)
    return len(rows)


def snapshot_dict(s: PatternStatsSnapshot | None, type_: str, horizon: int) -> dict[str, Any]:
    """Карточка статистики: при n < 30 — «мало данных» без процента (план 2A.10.4)."""
    base: dict[str, Any] = {
        "type": type_,
        "title": title(PatternType(type_), None) if type_ in _NEUTRAL else _pair_title(type_),
        "horizon": horizon,
        "n": 0 if s is None else s.n,
        "low_n": s is None or s.n < LOW_N,
        "success_rate": None,
        "ci_low": None,
        "ci_high": None,
        "avg_move_atr": None,
        "avg_adverse_atr": None,
        "period_start": None if s is None or s.period_start is None else s.period_start.isoformat(),
        "period_end": None if s is None or s.period_end is None else s.period_end.isoformat(),
    }
    if s is not None and s.n >= LOW_N:
        base.update(
            success_rate=_dec(s.success_rate),
            ci_low=_dec(s.ci_low),
            ci_high=_dec(s.ci_high),
            avg_move_atr=_dec(s.avg_move_atr),
            avg_adverse_atr=_dec(s.avg_adverse_atr),
        )
    return base


_NEUTRAL = {"doji", "doji_dragonfly", "doji_gravestone", "harami", "inside_bar"}


def _pair_title(type_: str) -> str:
    from engine.structure import Direction

    t = PatternType(type_)
    return f"{title(t, Direction.UP)} / {title(t, Direction.DOWN)}"


def stats_payload(
    db: Session,
    tf: str,
    scope: str,
    horizon: int,
    type_: str | None,
    instrument_id: int | None,
    with_context: bool | None,
) -> dict[str, Any]:
    q = select(PatternStatsSnapshot).where(
        PatternStatsSnapshot.timeframe == tf,
        PatternStatsSnapshot.scope == scope,
        PatternStatsSnapshot.horizon_bars == horizon,
        PatternStatsSnapshot.year.is_(None),
        PatternStatsSnapshot.instrument_id.is_(instrument_id)
        if instrument_id is None
        else PatternStatsSnapshot.instrument_id == instrument_id,
        PatternStatsSnapshot.with_context.is_(None)
        if with_context is None
        else PatternStatsSnapshot.with_context == with_context,
    )
    rows = {s.type: s for s in db.scalars(q).all()}
    types = [type_] if type_ else [t.value for t in PatternType]
    items = [snapshot_dict(rows.get(t), t, horizon) for t in types]
    payload: dict[str, Any] = {
        "scope": scope,
        "tf": tf,
        "horizon": horizon,
        "with_context": with_context,
        "items": items,
        "note": (
            "Историческая отработка по закрытым свечам: доля случаев, когда цена прошла ≥ 1 ATR "
            f"в сторону паттерна за {horizon} свечей. При n < {LOW_N} процент не показывается. "
            "Паттерны не являются сигналами и рекомендациями."
        ),
        "computed_at": max((s.computed_at for s in rows.values()), default=None),
    }
    if type_:
        by_year = db.scalars(
            select(PatternStatsSnapshot)
            .where(
                PatternStatsSnapshot.timeframe == tf,
                PatternStatsSnapshot.scope == scope,
                PatternStatsSnapshot.horizon_bars == horizon,
                PatternStatsSnapshot.type == type_,
                PatternStatsSnapshot.instrument_id.is_(None),
                PatternStatsSnapshot.year.is_not(None),
                PatternStatsSnapshot.with_context.is_(None)
                if with_context is None
                else PatternStatsSnapshot.with_context == with_context,
            )
            .order_by(PatternStatsSnapshot.year)
        ).all()
        payload["by_year"] = [{"year": s.year, **snapshot_dict(s, type_, horizon)} for s in by_year]
        ctx = db.scalars(
            select(PatternStatsSnapshot).where(
                PatternStatsSnapshot.timeframe == tf,
                PatternStatsSnapshot.scope == scope,
                PatternStatsSnapshot.horizon_bars == horizon,
                PatternStatsSnapshot.type == type_,
                PatternStatsSnapshot.instrument_id.is_(None),
                PatternStatsSnapshot.year.is_(None),
                PatternStatsSnapshot.with_context.is_not(None),
            )
        ).all()
        payload["by_context"] = {
            ("significant" if s.with_context else "found"): snapshot_dict(s, type_, horizon)
            for s in ctx
        }
    if payload["computed_at"] is not None:
        payload["computed_at"] = payload["computed_at"].isoformat()
    return payload


def pattern_dict(p: Pattern) -> dict[str, Any]:
    """Отметка для API/слоя графика (2B.12) и debug-страницы."""
    from engine.structure import Direction

    t = PatternType(p.type)
    d = None if p.direction is None else Direction(p.direction)
    return {
        "id": p.id,
        "type": p.type,
        "title": title(t, d),
        "direction": p.direction,
        "status": p.status,
        "significant": p.is_significant,
        "t": int(p.geometry.get("candle_time", 0)),
        "start_t": int(p.start_time.timestamp()),
        "confirm_t": int(p.confirm_time.timestamp()),
        "price": p.geometry.get("price"),
        "atr": p.geometry.get("atr"),
        "context": p.context,
        "source": p.source,
        "tf": p.timeframe,
    }


def pattern_view_dict(p: Pattern) -> dict[str, Any]:
    """Отметка для patterns?view=chart: без ``source`` и ``tf`` (они в запросе), ``context`` —
    только у значимых (его показывает подсказка значимого паттерна; полный элемент — ``ids=``)."""
    d = pattern_dict(p)
    del d["source"], d["tf"]
    if not p.is_significant:
        del d["context"]
    return d


IDS_MAX = 20
"""patterns?ids=…: сколько полных элементов можно запросить разом."""


def _chart_filter(
    inst: Instrument, tf: Timeframe, since: datetime | None, until: datetime | None
) -> list[Any]:
    """Отбор отметок графика за диапазон — общий у patterns и found (счётчики = элементы)."""
    where: list[Any] = [Pattern.instrument_id == inst.id, Pattern.timeframe == tf.value]
    if since is not None:
        where.append(Pattern.candle_close_time >= since)
    if until is not None:
        where.append(Pattern.candle_close_time <= until)
    return where


def chart_patterns(
    db: Session,
    inst: Instrument,
    tf: Timeframe,
    since: datetime | None,
    until: datetime | None,
    limit: int = 300,
    *,
    view: str | None = None,
    ids: list[int] | None = None,
) -> dict[str, Any]:
    """Отметки для слоя графика и панели «Найдено» (2B.12) плюс историческая отработка по типам.

    ``view="chart"`` — облегчённые элементы (:func:`pattern_view_dict`) и ``total`` — сколько
    отметок в диапазоне без учёта ``limit``. ``ids`` — только эти отметки, полными элементами;
    ``since``/``until``/``limit`` тогда не применяются."""
    if ids is not None:
        where = [
            Pattern.instrument_id == inst.id,
            Pattern.timeframe == tf.value,
            Pattern.id.in_(ids),
        ]
        rows = db.scalars(
            select(Pattern).where(*where).order_by(Pattern.candle_close_time.desc())
        ).all()
    else:
        where = _chart_filter(inst, tf, since, until)
        rows = db.scalars(
            select(Pattern).where(*where).order_by(Pattern.candle_close_time.desc()).limit(limit)
        ).all()
    light = view == "chart" and ids is None
    items = [pattern_view_dict(p) if light else pattern_dict(p) for p in reversed(rows)]
    types = sorted({p.type for p in rows})
    snaps = {
        s.type: s
        for s in db.scalars(
            select(PatternStatsSnapshot).where(
                PatternStatsSnapshot.timeframe == tf.value,
                PatternStatsSnapshot.scope == "backfill",
                PatternStatsSnapshot.horizon_bars == STATS_HORIZON,
                PatternStatsSnapshot.instrument_id.is_(None),
                PatternStatsSnapshot.with_context.is_(None),
                PatternStatsSnapshot.year.is_(None),
                PatternStatsSnapshot.type.in_(types),
            )
        ).all()
    }
    out: dict[str, Any] = {
        "symbol": inst.symbol,
        "tf": tf.value,
        "items": items,
        "stats": {t: snapshot_dict(snaps.get(t), t, STATS_HORIZON) for t in types},
        "horizon": STATS_HORIZON,
        "note": "Паттерны считаются по закрытым свечам и не являются сигналами.",
    }
    if view == "chart":
        if ids is not None or len(rows) < limit:
            out["total"] = len(rows)
        else:
            out["total"] = _count(db, where)
    return out


def _count(db: Session, where: list[Any]) -> int:
    return int(db.scalar(select(func.count()).select_from(Pattern).where(*where)) or 0)


def pattern_counts(
    db: Session, inst: Instrument, tf: Timeframe, since: datetime | None, until: datetime | None
) -> dict[str, Any]:
    """Счётчики для /chart/found: сколько отметок в диапазоне и время свечи (``t``) значимых —
    по ним клиент считает «Найдено (n)» в видимом диапазоне до загрузки элементов."""
    where = _chart_filter(inst, tf, since, until)
    total = _count(db, where)
    t = func.coalesce(Pattern.geometry["candle_time"].astext.cast(BigInteger), 0)
    significant = db.scalars(
        select(t).where(*where, Pattern.is_significant.is_(True)).order_by(t)
    ).all()
    return {"total": total, "significant_t": [int(x) for x in significant]}
