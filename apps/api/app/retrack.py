"""Пересчёт форвард-сигналов, записанных с ошибкой учёта (задание «сигналы», задачи 7 и 10).

До задачи 1 трекер считал сроки в штуках поданных 1m-свечей: сделка без TP1 закрывалась time
stop через 15 минут вместо 60 часов (15 свечей H4). До задачи 3 результат писался без комиссии и
проскальзывания. Решение (ADR-0012): старые результаты пересчитываются из сохранённых 1m-свечей,
а где свечей не хватает — помечаются недействительными; автоматически, без ручных шагов. Задание
выполняется один раз — при старте трекера (``run``, отметка в ``deploy_jobs``).

1. **Кандидаты** — закрытые форвард-сигналы (``signals.scope = 'forward'``) любых версий, в том
   числе архивных, со свечой сигнала не раньше ``SINCE``. Live-сигналы не трогаются.
2. **Что с каждым** (``plan_signal``):
   - исход противоречит срокам H4 (``deadline_problem``: time stop или истечение раньше срока) —
     сигнал заново ведётся по сохранённым 1m-свечам тем же трекером, что ведёт сигналы
     (``replay``), результат — за вычетом комиссии и проскальзывания, как в бэктесте
     (``app.workers.tracker.result_values``); вид ``retrack``;
   - исход верный, но результат записан без комиссий (``cost_r`` NULL) — результат пересчитывается
     из сохранённого состояния трекера (``SignalTracker.result``), события не меняются; вид
     ``fees``;
   - в 1m-свечах пропуск, который мог скрыть касание стопа или цели (``gap_risk``: свеча H4 над
     пропуском доходит до действующего стопа или следующей цели, её нет, или в пропуске срок
     time stop), или свечей нет вовсе — результат недействителен: статус ``voided``, строка
     ``signal_results`` уходит в архив, в статистику сигнал не входит; вид ``void``.
3. **Отчёт и применение** (``run``): сначала в журнал — полный отчёт «было / стало» по каждому
   сигналу (dry-run, ничего не пишет), затем применение, по одному сигналу в транзакции (строка
   сигнала под ``FOR UPDATE``). Исходные строки ``signal_events`` не меняются: новые события
   пишутся с ``source = 'retrack'``, событие ``corrected`` / ``voided`` объясняет исправление,
   заменённые события, прежние ``signal_results`` и ``signal_tracking`` — в
   ``signal_corrections``. Статус сигнала — по последнему новому событию; если пересчитанная
   сделка ещё открыта (после TP1), трекер ведёт её дальше с нового состояния.
4. **Повторный запуск ничего не меняет**: одно исправление на сигнал и задание (уникальность в
   ``signal_corrections``), после завершения — отметка ``deploy_jobs``. Уведомления по
   исправлениям не уходят (``source = 'retrack'``). В конце пересчитываются снимки статистики, и
   плашка над форвард-статистикой снимается (``app.corrections.forward_notice_shown``).
"""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.corrections import CORRECTION_SOURCE, RETRACK_JOB, VOIDED, current_event, job_done
from app.db import SessionLocal
from app.forward import _setup_from_row
from app.models import (
    DeployJob,
    Instrument,
    Signal,
    SignalCorrection,
    SignalEvent,
    SignalResult,
    SignalTracking,
    StrategyVersion,
)
from app.snapshots import recompute
from app.workers.tracker import (
    EVENT_TYPE,
    _candles_after,
    _params_for,
    event_note,
    result_values,
    state_from_json,
    state_to_json,
)
from engine.backtest import DEFAULT_EXECUTION, execution_cost_r
from engine.candles import SIGNAL_TIMEFRAME, Candle, Timeframe
from engine.params import TradeParams
from engine.structure import Direction
from engine.tracker import SignalStatus, SignalTracker, TrackerEvent, TrackerResult, interval_start
from engine.trade import TradeSetup

log = logging.getLogger("retrack")

SINCE = datetime(2026, 10, 26, tzinfo=UTC)
"""Начало форварда с ошибкой учёта: более ранние сигналы задание не трогает."""
STREAM = Timeframe.M1
"""Таймфрейм пересчёта — тот же, что у трекера-воркера (план 2.10)."""
CLOSED = ("closed_tp3", "closed_be", "closed_sl", "closed_time", "expired")
"""Записанные исходы, которые проверяет задание (открытые ведёт трекер, отменённые не трогаем)."""
CLOSING_EVENTS = ("tp3", "be", "sl", "time_stop", "expired")
GAPS_IN_NOTE = 3
"""Сколько пропусков перечислять в пояснении (остальные — числом)."""

RETRACK, FEES, VOID, OK, DONE = "retrack", "fees", "void", "ok", "done"
"""Виды решения: пересчёт по 1m; только комиссии; недействителен; без изменений; уже исправлен."""

STATUS_RU = {
    "pending": "ожидает входа",
    "active": "в сделке",
    "tp1_hit": "в сделке после TP1",
    "tp2_hit": "в сделке после TP2",
    "closed_tp3": "TP3",
    "closed_be": "безубыток",
    "closed_sl": "стоп",
    "closed_time": "по времени",
    "expired": "вход не исполнен",
    "cancelled": "отменён",
    VOIDED: "недействителен",
}


def _when(t: datetime) -> str:
    return f"{t.astimezone(UTC):%d.%m.%Y %H:%M} UTC"


def _span(d: timedelta) -> str:
    minutes = int(d.total_seconds() // 60)
    return f"{minutes} мин" if minutes < 60 else f"{Decimal(minutes) / 60:.1f} ч"


def _r(x: Decimal) -> str:
    return f"{x:+.3f} R"


# --- проверка записанного исхода ---------------------------------------------------------------


def deadline_problem(
    signal_close: datetime,
    status: str,
    events: Sequence[tuple[str, datetime]],
    params: TradeParams,
) -> str | None:
    """Чем записанный исход противоречит срокам в свечах H4 (план 2.6); ``None`` — согласован.

    Трекер ведёт вход по рынку: time stop — не раньше ``signal_close + time_stop_candles × H4``;
    истечения у рыночного входа нет (у лимитного — не раньше ``limit_expiry_candles × H4``).
    ``events`` — (тип, момент) действующих событий сигнала по порядку записи."""
    h4 = SIGNAL_TIMEFRAME.delta
    last = {t: at for t, at in events}
    if status == "closed_time":
        deadline = signal_close + h4 * params.time_stop_candles
        at = last.get("time_stop")
        if at is None:
            return "закрыт по времени, но события time stop нет"
        if at < deadline:
            return (
                f"закрыт по времени {_when(at)} — через {_span(at - signal_close)} после сигнала, "
                f"раньше срока {_when(deadline)} ({params.time_stop_candles} свечей H4)"
            )
    elif status == "expired":
        at = last.get("expired")
        when = f" {_when(at)}" if at is not None else ""
        return f"помечен истёкшим{when}, а вход по рынку не истекает"
    return None


# --- пересчёт по 1m-свечам ---------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Gap:
    """Пропуск 1m-свечей: минуты с ``open_time`` в ``[start, end)``."""

    start: datetime
    end: datetime
    risk: str | None
    """Почему пропуск мог изменить исход; ``None`` — не мог."""

    @property
    def minutes(self) -> int:
        return (self.end - self.start) // STREAM.delta

    def text(self) -> str:
        what = f"{_when(self.start)}–{self.end.astimezone(UTC):%H:%M} UTC ({self.minutes} мин)"
        return f"{what}: {self.risk}" if self.risk else what


@dataclass(frozen=True, slots=True)
class Replay:
    """Итог пересчёта: трекер в конечном состоянии, его события с пояснениями, последняя поданная
    минута (``open_time``) и пропуски в окне сделки."""

    tracker: SignalTracker
    events: tuple[tuple[TrackerEvent, str | None], ...]
    last_candle: datetime | None
    gaps: tuple[Gap, ...]

    @property
    def risky(self) -> tuple[Gap, ...]:
        return tuple(g for g in self.gaps if g.risk)


def _levels(tracker: SignalTracker) -> tuple[Decimal, Decimal | None, datetime | None]:
    """Действующие стоп, следующая цель и срок time stop (``None`` — после TP1 срока нет)."""
    s, setup = tracker.state, tracker.setup
    tps = (setup.tp1, setup.tp2, setup.tp3)
    if s.status is SignalStatus.PENDING:  # вход по рынку — с закрытия сигнальной свечи
        assert tracker.signal_close is not None
        deadline = tracker.signal_close + SIGNAL_TIMEFRAME.delta * tracker.params.time_stop_candles
        return setup.stop_loss, setup.tp1, deadline
    assert s.stop is not None
    next_tp = tps[s.hits] if s.hits < len(tps) else None
    return s.stop, next_tp, s.deadline_at if s.hits == 0 else None


def gap_risk(
    setup: TradeSetup,
    stop: Decimal,
    next_tp: Decimal | None,
    deadline: datetime | None,
    start: datetime,
    end: datetime,
    h4: Mapping[datetime, Candle],
) -> str | None:
    """Мог ли пропуск минут ``[start, end)`` изменить исход; ``None`` — не мог.

    Событие в пропуске возможно, только если цена дошла до действующего стопа или следующей цели:
    дальние цели — после ближней. Это проверяется по закрытым свечам H4 над пропуском (их
    диапазон шире пропуска — проверка с запасом). Если в пропуске срок time stop, цену выхода по
    1m не восстановить."""
    if deadline is not None and start < deadline <= end:
        return f"в пропуске срок time stop {_when(deadline)}"
    up = setup.direction is Direction.UP
    t = interval_start(start, SIGNAL_TIMEFRAME)
    while t < end:
        bar = h4.get(t)
        if bar is None:
            return f"нет свечи H4 {_when(t)}"
        if (bar.low <= stop) if up else (bar.high >= stop):
            return f"свеча H4 {_when(t)} доходит до стопа"
        if next_tp is not None and ((bar.high >= next_tp) if up else (bar.low <= next_tp)):
            return f"свеча H4 {_when(t)} доходит до цели"
        t += SIGNAL_TIMEFRAME.delta
    return None


def replay(
    setup: TradeSetup,
    params: TradeParams,
    signal_close: datetime,
    minutes: Sequence[Candle],
    h4: Mapping[datetime, Candle],
) -> Replay:
    """Ведёт сигнал заново по закрытым 1m-свечам после сигнальной — тем же ``SignalTracker`` и с
    теми же параметрами, что трекер-воркер (вход по рынку, сроки по времени H4). Останавливается
    на закрытии сделки. Пропуски минут между закрытием сигнальной свечи и последней поданной
    минутой оцениваются ``gap_risk`` по состоянию сделки перед пропуском."""
    tracker = SignalTracker(
        setup, params, "market", None, signal_close=signal_close, timeframe=STREAM
    )
    expected = signal_close
    events: list[tuple[TrackerEvent, str | None]] = []
    gaps: list[Gap] = []
    last: datetime | None = None
    for c in minutes:
        if c.open_time < signal_close:
            continue
        if c.open_time > expected:
            stop, next_tp, deadline = _levels(tracker)
            risk = gap_risk(setup, stop, next_tp, deadline, expected, c.open_time, h4)
            gaps.append(Gap(expected, c.open_time, risk))
        events.extend((e, event_note(e, tracker)) for e in tracker.step(c))
        last = c.open_time
        expected = c.open_time + STREAM.delta
        if not tracker.state.status.is_open:
            break
    return Replay(tracker, tuple(events), last, tuple(gaps))


# --- решение по сигналу ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Outcome:
    status: str
    realized_r: Decimal | None = None
    cost_r: Decimal | None = None
    closed_at: datetime | None = None
    duration_hours: Decimal | None = None

    def text(self) -> str:
        parts = [STATUS_RU.get(self.status, self.status)]
        if self.realized_r is not None:
            fee = "без комиссий" if self.cost_r is None else f"комиссия {self.cost_r:.3f} R"
            parts.append(f"{_r(self.realized_r)} ({fee})")
        if self.closed_at is not None:
            dur = "" if self.duration_hours is None else f", {self.duration_hours:.2f} ч"
            parts.append(f"закрыт {_when(self.closed_at)}{dur}")
        return ", ".join(parts)

    def as_json(self) -> dict[str, str | None]:
        return {
            "status": self.status,
            "realized_r": None if self.realized_r is None else str(self.realized_r),
            "cost_r": None if self.cost_r is None else str(self.cost_r),
            "closed_at": None if self.closed_at is None else self.closed_at.isoformat(),
            "duration_hours": None if self.duration_hours is None else str(self.duration_hours),
        }


@dataclass(frozen=True, slots=True)
class Plan:
    signal_id: int
    public_id: str
    symbol: str
    version: str
    kind: str
    reason: str
    before: Outcome
    after: Outcome | None = None
    why_void: str | None = None
    replay: Replay | None = None
    fees: TrackerResult | None = None

    def line(self) -> str:
        head = f"{self.public_id} {self.symbol} {self.version}: {self.kind}"
        body = f"было — {self.before.text()}"
        if self.kind == VOID:
            body += f"; стало — недействителен ({self.why_void})"
        elif self.after is not None:
            body += f"; стало — {self.after.text()}"
        safe = [g for g in (self.replay.gaps if self.replay else ()) if not g.risk]
        if safe and self.kind == RETRACK:
            body += f"; пропуски без влияния: {sum(g.minutes for g in safe)} мин"
        return f"{head} | {self.reason} | {body}"

    def as_json(self) -> dict[str, Any]:
        gaps = self.replay.gaps if self.replay else ()
        return {
            "id": self.public_id,
            "symbol": self.symbol,
            "version": self.version,
            "kind": self.kind,
            "reason": self.reason,
            "before": self.before.as_json(),
            "after": None if self.after is None else self.after.as_json(),
            "why_void": self.why_void,
            "gaps": [
                {"from": g.start.isoformat(), "to": g.end.isoformat(), "risk": g.risk} for g in gaps
            ],
        }


def _outcome(status: str, res: SignalResult | None) -> Outcome:
    if res is None:
        return Outcome(status)
    return Outcome(status, res.realized_r, res.cost_r, res.closed_at, res.duration_hours)


def _fees(db: Session, sig: Signal, params: TradeParams, res: SignalResult) -> TrackerResult:
    """Результат верного исхода за вычетом комиссии — из сохранённого состояния трекера (результат
    в нём до вычета, без округления), как при закрытии. Без состояния — из записанного
    результата и ``execution_cost_r`` от входа по рынку."""
    row = db.get(SignalTracking, sig.id)
    if row is not None:
        state = state_from_json(row.state)
        if state.status.value == sig.status:
            tracker = SignalTracker(
                _setup_from_row(sig),
                params,
                "market",
                state,
                signal_close=sig.candle_close_time.astimezone(UTC),
                timeframe=Timeframe(row.timeframe),
            )
            return tracker.result(DEFAULT_EXECUTION)
    setup = _setup_from_row(sig)
    cost = execution_cost_r(setup.entry_market, setup.risk, DEFAULT_EXECUTION)
    return TrackerResult(
        realized_r=res.realized_r - cost,
        r_if_tp1_only=None if res.realized_r_tp1_only is None else res.realized_r_tp1_only - cost,
        r_if_full_tp2=None if res.realized_r_full_tp2 is None else res.realized_r_full_tp2 - cost,
        cost_r=cost,
    )


def _replay_outcome(sig: Signal, rp: Replay) -> Outcome:
    st = rp.tracker.state
    if not st.status.is_closed or rp.last_candle is None:
        return Outcome(st.status.value)
    v = result_values(sig, rp.tracker, rp.last_candle + STREAM.delta)
    return Outcome(
        st.status.value, v["realized_r"], v["cost_r"], v["closed_at"], v["duration_hours"]
    )


def plan_signal(db: Session, sig: Signal) -> Plan:
    """Решение по одному сигналу (только чтение)."""
    symbol = db.scalar(select(Instrument.symbol).where(Instrument.id == sig.instrument_id))
    version = db.scalar(
        select(StrategyVersion.version).where(StrategyVersion.id == sig.strategy_version_id)
    )
    res = db.get(SignalResult, sig.id)
    before = _outcome(sig.status, res)
    base: dict[str, Any] = {
        "signal_id": sig.id,
        "public_id": sig.public_id,
        "symbol": symbol or "?",
        "version": version or "?",
        "before": before,
    }
    done = db.scalar(
        select(SignalCorrection.id).where(
            SignalCorrection.signal_id == sig.id, SignalCorrection.job == RETRACK_JOB
        )
    )
    if done is not None:
        return Plan(kind=DONE, reason="уже исправлен этим заданием", **base)
    params = _params_for(db, sig)
    close = sig.candle_close_time.astimezone(UTC)
    events = db.execute(
        select(SignalEvent.type, SignalEvent.occurred_at)
        .where(SignalEvent.signal_id == sig.id, current_event())
        .order_by(SignalEvent.id)
    ).all()
    recorded = [(t, at.astimezone(UTC)) for t, at in events]
    problem = deadline_problem(close, sig.status, recorded, params)
    if problem is None and res is None and sig.status != "expired":
        problem = "закрыт, но результат не записан"
    if problem is None:
        if res is None or res.cost_r is not None:
            return Plan(kind=OK, reason="исход согласован со сроками, комиссия учтена", **base)
        fees = _fees(db, sig, params, res)
        after = Outcome(sig.status, fees.realized_r, fees.cost_r, res.closed_at, res.duration_hours)
        reason = "исход верный, результат записан без комиссии и проскальзывания"
        return Plan(kind=FEES, reason=reason, after=after, fees=fees, **base)
    minutes = _candles_after(db, sig.instrument_id, close, STREAM)
    h4 = {c.open_time: c for c in _candles_after(db, sig.instrument_id, close, SIGNAL_TIMEFRAME)}
    rp = replay(_setup_from_row(sig), params, close, minutes, h4)
    if rp.last_candle is None:
        why = "после сигнала нет ни одной закрытой 1m-свечи"
        return Plan(kind=VOID, reason=problem, why_void=why, replay=rp, **base)
    if rp.risky:
        shown = "; ".join(g.text() for g in rp.risky[:GAPS_IN_NOTE])
        more = len(rp.risky) - GAPS_IN_NOTE
        why = f"пропуски 1m-свечей: {shown}" + (f"; и ещё {more}" if more > 0 else "")
        return Plan(kind=VOID, reason=problem, why_void=why, replay=rp, **base)
    return Plan(kind=RETRACK, reason=problem, after=_replay_outcome(sig, rp), replay=rp, **base)


# --- применение --------------------------------------------------------------------------------


def _json(v: object) -> object:
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, datetime):
        return v.isoformat()
    return v


def _image(row: SignalResult | SignalTracking | None) -> dict[str, Any] | None:
    """Все столбцы строки в JSON — архив для ``signal_corrections`` и отката миграции."""
    if row is None:
        return None
    return {c.name: _json(getattr(row, c.key)) for c in row.__table__.columns}


def note_text(plan: Plan, now: datetime) -> str:
    """Пояснение исправления — текст события ``corrected`` / ``voided``."""
    day = f"{now.astimezone(UTC):%d.%m.%Y}"
    if plan.kind == VOID:
        return (
            f"Результат недействителен ({day}): {plan.reason}. Пересчитать нельзя — "
            f"{plan.why_void}. Сигнал исключён из статистики. Было: {plan.before.text()}."
        )
    assert plan.after is not None
    if plan.kind == FEES:
        assert plan.fees is not None
        return (
            f"Результат исправлен {day}: {plan.reason}. Было: {plan.before.text()}. "
            f"Стало: {plan.after.text()}. Исход сделки не менялся."
        )
    text = (
        f"Исход пересчитан {day}: {plan.reason}. Пересчёт по сохранённым 1m-свечам тем же "
        "трекером: сроки в свечах H4, комиссия и проскальзывание как в бэктесте. "
        f"Было: {plan.before.text()}. Стало: {plan.after.text()}."
    )
    safe = [g for g in (plan.replay.gaps if plan.replay else ()) if not g.risk]
    if safe:
        text += (
            f" В 1m-свечах пропуски ({sum(g.minutes for g in safe)} мин), исход они не меняют: "
            "свечи H4 над ними не доходят до стопа и цели."
        )
    return text


def apply_plan(db: Session, sig: Signal, plan: Plan, now: datetime) -> SignalCorrection | None:
    """Применяет решение к сигналу в текущей транзакции. ``None`` — менять нечего."""
    if plan.kind in (OK, DONE):
        return None
    events = db.scalars(
        select(SignalEvent).where(SignalEvent.signal_id == sig.id).order_by(SignalEvent.id)
    ).all()
    res = db.get(SignalResult, sig.id)
    tracking = db.get(SignalTracking, sig.id)
    corr = SignalCorrection(
        signal_id=sig.id,
        job=RETRACK_JOB,
        kind=plan.kind,
        status_before=sig.status,
        result_before=_image(res),
        tracking_before=_image(tracking),
    )
    superseded: list[int] = []
    if plan.kind == RETRACK:
        rp = plan.replay
        assert rp is not None and rp.last_candle is not None
        superseded = [e.id for e in events if e.type != "created"]
        for e, why in rp.events:
            db.add(
                SignalEvent(
                    signal_id=sig.id,
                    type=EVENT_TYPE[e.type.value],
                    price=e.price,
                    occurred_at=e.at,
                    source=CORRECTION_SOURCE,
                    note=why,
                )
            )
        st = rp.tracker.state
        if tracking is None:
            tracking = SignalTracking(signal_id=sig.id)
            db.add(tracking)
        tracking.state = state_to_json(st)
        tracking.timeframe = STREAM.value
        tracking.last_candle_time = rp.last_candle
        tracking.updated_at = now
        if st.status.is_closed:
            values = result_values(sig, rp.tracker, rp.last_candle + STREAM.delta)
            if res is None:
                db.add(SignalResult(signal_id=sig.id, **values))
            else:
                for k, v in values.items():
                    setattr(res, k, v)
        elif res is not None:
            db.delete(res)  # сделка снова открыта: результат появится при закрытии
        sig.status = st.status.value
    elif plan.kind == FEES:
        assert res is not None and plan.fees is not None
        res.realized_r = plan.fees.realized_r
        res.realized_r_tp1_only = plan.fees.r_if_tp1_only
        res.realized_r_full_tp2 = plan.fees.r_if_full_tp2
        res.cost_r = plan.fees.cost_r
    else:
        superseded = [e.id for e in events if e.type in CLOSING_EVENTS]
        if res is not None:
            db.delete(res)
        sig.status = VOIDED
    explain = SignalEvent(
        signal_id=sig.id,
        type="voided" if plan.kind == VOID else "corrected",
        occurred_at=now,
        source=CORRECTION_SOURCE,
        note=note_text(plan, now),
    )
    db.add(explain)
    db.flush()
    corr.note_event_id = explain.id
    corr.note = explain.note or ""
    corr.superseded_event_ids = superseded
    corr.status_after = sig.status
    corr.result_after = _image(db.get(SignalResult, sig.id))
    db.add(corr)
    db.flush()
    return corr


# --- задание целиком ---------------------------------------------------------------------------


def _candidate_ids(db: Session, since: datetime) -> list[int]:
    return list(
        db.scalars(
            select(Signal.id)
            .where(
                Signal.scope == "forward",
                Signal.candle_close_time >= since,
                Signal.status.in_(CLOSED),
            )
            .order_by(Signal.candle_close_time, Signal.id)
        ).all()
    )


def _totals(plans: Sequence[Plan]) -> list[str]:
    """Итоги по версиям: закрытые сделки и сумма R до и после (недействительные не входят)."""
    out = []
    for ver in sorted({p.version for p in plans}):
        mine = [p for p in plans if p.version == ver]
        before = [p.before.realized_r for p in mine if p.before.realized_r is not None]
        after = [
            r
            for p in mine
            if p.kind != VOID and (r := (p.after or p.before).realized_r) is not None
        ]
        kinds = ", ".join(f"{k} {n}" for k, n in sorted(Counter(p.kind for p in mine).items()))
        out.append(
            f"{ver}: сигналов {len(mine)} ({kinds}); "
            f"было закрытых {len(before)}, сумма {_r(sum(before, Decimal(0)))}; "
            f"стало {len(after)}, сумма {_r(sum(after, Decimal(0)))}"
        )
    return out


def run(
    session_factory: Callable[[], Session] = SessionLocal,
    now: datetime | None = None,
    since: datetime = SINCE,
) -> dict[str, Any] | None:
    """Задание целиком: отчёт (dry-run) в журнал, применение по сигналу в транзакции, снимки
    статистики, отметка ``deploy_jobs``. ``None`` — задание уже выполнено. Если какой-то сигнал
    не применился, отметки нет: при следующем старте задание продолжится (применённые сигналы
    не повторяются)."""
    now = now or datetime.now(tz=UTC)
    with session_factory() as db:
        if job_done(db, RETRACK_JOB):
            log.info("пересчёт форварда (%s) уже выполнен", RETRACK_JOB)
            return None
        ids = _candidate_ids(db, since)
        plans = []
        for sid in ids:
            sig = db.get(Signal, sid)
            assert sig is not None
            plans.append(plan_signal(db, sig))
        db.rollback()  # отчёт только читает
        log.info(
            "пересчёт форварда с %s: отчёт до применения (dry-run), сигналов %d",
            since.date().isoformat(),
            len(plans),
        )
        for p in plans:
            log.info("  %s", p.line())
        for line in _totals(plans):
            log.info("  итог %s", line)

        applied: Counter[str] = Counter()
        failed: list[str] = []
        after: list[Plan] = []
        for sid in ids:
            try:
                sig = db.scalars(select(Signal).where(Signal.id == sid).with_for_update()).one()
                plan = plan_signal(db, sig)
                corr = apply_plan(db, sig, plan, now)
                db.commit()
            except Exception:
                db.rollback()
                log.exception("пересчёт форварда: сигнал id %s не применён", sid)
                failed.append(str(sid))
                continue
            applied[plan.kind] += 1
            after.append(plan)
            if corr is not None:
                log.info("применено: %s", plan.line())
        summary: dict[str, Any] = {
            "since": since.isoformat(),
            "signals": len(ids),
            "applied": dict(sorted(applied.items())),
            "failed": failed,
            "totals": _totals(after),
            "report": [p.as_json() for p in plans],
        }
        if failed:
            log.error(
                "пересчёт форварда: не применены %d сигналов (%s) — задание продолжится при "
                "следующем старте трекера",
                len(failed),
                ", ".join(failed),
            )
            return summary
        recompute(db, now)
        db.execute(
            insert(DeployJob)
            .values(name=RETRACK_JOB, completed_at=now, summary=summary)
            .on_conflict_do_nothing(index_elements=["name"])
        )
        db.commit()
        log.info(
            "пересчёт форварда завершён: %s; снимки статистики пересчитаны, плашка снята",
            ", ".join(f"{k} {n}" for k, n in sorted(applied.items())) or "менять нечего",
        )
        return summary
