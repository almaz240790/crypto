"""Офлайн-пересчёт уже записанного сигнала — только чтение (задача 7 пакета «Сигналы», план 2.10).

Модуль ничего не пишет в БД. Он читает записанный сигнал и свечи и считает сделку заново
двумя способами, каждый — тем же кодом, что и боевой:

- ``retrack_minutes`` — исправленный 1m-трекер с комиссиями. Вызывается сам
  ``app.workers.tracker.apply_candles`` (тот же путь, что у воркера: ``SignalTracker`` со сроками
  по времени и запись результата за вычетом ``execution_cost_r``), но вместо сессии БД ему даётся
  хранилище в памяти. Трекинг здесь не переписан — он переиспользован;
- ``retrack_h4`` — ``simulate_trade`` на сохранённых H4-свечах с ``DEFAULT_EXECUTION``: эталон
  бэктеста. Свечи берутся так же, как их берут бэктест и ``forward.track_open_signals`` —
  сохранённые ``4h`` из ``candles``, без склейки из минут.

Обе функции чистые: принимают сигнал и свечи, БД не знают, и вызываются для одного сигнала без
отчёта (ежедневная сверка, задача 8). Свечи отсекаются по ``now`` через ``closed_only`` — свеча,
не закрытая к моменту ``now``, на результат не влияет.

**Незакрытая сделка.** Если к моменту ``now`` пересчитанная сделка не закрылась, у неё остаётся
открытый статус (``active`` / ``tp1_hit`` / ``tp2_hit``), а результата нет: ``realized_r``,
``cost_r``, ``closed_at`` и ``duration_hours`` равны ``None``. Доли, уже закрытые на TP1/TP2, за
результат не выдаются — так же, как воркер не пишет ``signal_results`` до закрытия. До какого
момента сделка прослежена — ``tracked_until``.

**Пропуски 1m.** Полнота проверяется от закрытия сигнальной свечи до закрытия пересчитанной
сделки, а если она не закрылась — до ``now``. Порог ``max_gap_minutes`` — самый длинный
допустимый пропуск подряд; при большем сигнал «не пересчитан» (``outcome`` = ``None``). Пропуск
после закрытия сделки на результат не влияет и не считается. Для H4-эталона допуск нулевой:
``simulate_trade`` считает сроки в штуках свечей, поэтому любая недостающая свеча до выхода
делает эталон непригодным.

**Пересечение сделок** (``open_trade_overlap``) — пометка для отчёта по правилу задачи 6
(«одна открытая сделка на инструмент и версию»). Само правило одно — в движке
(``engine.lifecycle.blocking_signal``): его же применяют бэктест и запись кандидата в форварде
и live. Здесь оно только спрашивается о записанных сигналах; отчёт ничего не меняет.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from itertools import batched
from typing import Any, cast

from sqlalchemy import Connection, Engine, text
from sqlalchemy.orm import Session

from app.analysis import params_for_version
from app.db import engine as db_engine
from app.forward import _setup_from_row, _status_from_result
from app.models import Signal, SignalEvent, SignalResult, SignalTracking, StrategyVersion
from app.workers.tracker import OPEN, apply_candles, state_from_json
from engine.backtest import DEFAULT_EXECUTION, simulate_trade
from engine.candles import SIGNAL_TIMEFRAME, Candle, Timeframe, closed_only
from engine.lifecycle import SignalLife, SignalStatus, blocking_signal
from engine.strategies import STRATEGIES
from engine.tracker import interval_start

MINUTE = Timeframe.M1
"""Таймфрейм потока трекера (план 2.10) — тот же, что у воркера."""
DEFAULT_MAX_GAP_MINUTES = 5
"""Самый длинный пропуск 1m-свечей подряд, при котором сигнал ещё считается пересчитанным."""
CANDLE_LOAD_WINDOW = timedelta(days=3)
"""Окно одного запроса свечей: сделка обычно закрывается за 60 ч, дальше можно не читать."""
TRACK_BATCH = 24 * 60
"""Сколько минут подаётся трекеру за один вызов ``apply_candles`` (как порция догона)."""
READ_ONLY_SQL = "SET TRANSACTION READ ONLY"
SNAPSHOT_READ_ONLY_SQL = "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"


# --- соединение только на чтение ---------------------------------------------------------------


@contextmanager
def read_only_connection(bind: Engine | Connection | None = None) -> Iterator[Connection]:
    """Соединение, в котором нельзя писать: любая запись падает с ошибкой PostgreSQL
    «cannot execute … in a read-only transaction».

    - ``Engine`` (или ничего — движок приложения): новое соединение, одна транзакция
      ``REPEATABLE READ, READ ONLY`` на весь блок. Снимок данных один, поэтому пересчёт не видит
      изменений, которые трекер пишет во время работы; в конце — откат.
    - ``Connection`` с уже идущей транзакцией вызывающего: режим только на чтение включается
      внутри точки сохранения (``SET TRANSACTION READ ONLY``) и снимается её откатом. Так блок
      видит незафиксированные данные вызывающего (тесты с фикстурами во внешней транзакции), но
      сам записать ничего не может.
    """
    target = db_engine if bind is None else bind
    if isinstance(target, Connection):
        savepoint = target.begin_nested()
        try:
            target.execute(text(READ_ONLY_SQL))
            yield target
        finally:
            savepoint.rollback()
        return
    with target.connect() as conn:
        transaction = conn.begin()
        try:
            conn.execute(text(SNAPSHOT_READ_ONLY_SQL))
            yield conn
        finally:
            transaction.rollback()


# --- данные ------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Outcome:
    """Итог сделки в одном расчёте — записанном, по 1m или по H4 — в общем виде для сравнения."""

    status: str
    """Статус как в ``signals.status``."""
    tp_hits: int
    """Сколько тейков достигнуто (0–3)."""
    realized_r: Decimal | None
    """Результат в R. ``None`` — результата нет: сделка не закрыта."""
    cost_r: Decimal | None
    """Вычтенные комиссия и проскальзывание в R. У записанного результата ``None`` означает,
    что он записан без комиссий (до задачи 3)."""
    closed_at: datetime | None
    duration_hours: Decimal | None

    @property
    def is_open(self) -> bool:
        return self.status in OPEN

    @property
    def is_closed(self) -> bool:
        return self.status.startswith("closed")


@dataclass(frozen=True, slots=True)
class SignalRow:
    """Записанный сигнал: неизменяемая копия строки ``signals`` и её записанного итога."""

    id: int
    public_id: str
    strategy: str
    version: str
    strategy_version_id: int
    instrument_id: int
    symbol: str
    scope: str
    direction: str
    grade: str
    score: int
    candle_close_time: datetime
    entry_market: Decimal
    entry_limit: Decimal | None
    stop_loss: Decimal
    tp1: Decimal
    tp2: Decimal
    tp3: Decimal
    rr_tp2: Decimal
    recorded: Outcome
    """Что записано в БД сейчас: ``signals.status`` и строка ``signal_results``, если она есть."""

    @property
    def version_label(self) -> str:
        return f"{self.strategy}@{self.version}"


def version_known(version: str) -> bool:
    """Есть ли версия в ``engine.strategies``. Если нет, трекер берёт параметры сделки 1.0.0
    (``app.workers.tracker._params_for``) — отчёт это помечает."""
    return any(key.endswith("@" + version) for key in STRATEGIES)


def _utc(t: datetime) -> datetime:
    return t.astimezone(UTC)


def _version_order(version: str) -> tuple[tuple[int, ...], str]:
    return tuple(int(p) if p.isdigit() else 0 for p in version.split(".")), version


def load_forward_signals(
    conn: Connection, since: datetime, now: datetime, versions: Sequence[str] = ()
) -> list[SignalRow]:
    """Форвард-сигналы (``signals.scope = 'forward'``) с закрытием сигнальной свечи в
    [``since``; ``now``] — любых версий, в том числе архивных и ставших потом live. Live-сигналы
    не читаются. ``versions`` — фильтр: ``1.0.0`` или ``стратегия@1.0.0``; пусто — все.

    Порядок стабильный: стратегия, версия, время сигнальной свечи, инструмент, ``public_id``.
    """
    return load_signals(conn, since, now, versions)


def load_signals(
    conn: Connection,
    since: datetime,
    now: datetime,
    versions: Sequence[str] = (),
    scopes: Sequence[str] = ("forward",),
    include_open: bool = False,
) -> list[SignalRow]:
    """Записанные сигналы областей ``scopes`` с закрытием сигнальной свечи в [``since``; ``now``].

    ``include_open`` — добавить сигналы старше ``since``, у которых сделка ещё открыта (их
    сопровождение продолжается, ежедневная сверка проверяет и его). Порядок и фильтр версий —
    как у ``load_forward_signals``.
    """
    rows = conn.execute(
        text(
            "select s.id, s.public_id, st.slug, sv.version, sv.id, i.id, i.symbol, s.scope, "
            "s.direction, s.grade, s.score, s.candle_close_time, s.entry_market, s.entry_limit, "
            "s.stop_loss, s.tp1, s.tp2, s.tp3, s.rr_tp2, s.status, r.realized_r, r.cost_r, "
            "r.closed_at, r.duration_hours, "
            "(select count(distinct e.type) from signal_events e "
            " where e.signal_id = s.id and e.type in ('tp1', 'tp2', 'tp3')) "
            "from signals s "
            "join strategy_versions sv on sv.id = s.strategy_version_id "
            "join strategies st on st.id = sv.strategy_id "
            "join instruments i on i.id = s.instrument_id "
            "left join signal_results r on r.signal_id = s.id "
            "where s.scope = any(:scopes) and s.candle_close_time <= :now "
            "and (s.candle_close_time >= :since or (:open and s.status = any(:open_statuses)))"
        ),
        {
            "since": since,
            "now": now,
            "scopes": list(scopes),
            "open": include_open,
            "open_statuses": list(OPEN),
        },
    ).all()
    wanted = set(versions)
    out = [
        SignalRow(
            id=r[0],
            public_id=r[1],
            strategy=r[2],
            version=r[3],
            strategy_version_id=r[4],
            instrument_id=r[5],
            symbol=r[6],
            scope=r[7],
            direction=r[8],
            grade=r[9],
            score=r[10],
            candle_close_time=_utc(r[11]),
            entry_market=r[12],
            entry_limit=r[13],
            stop_loss=r[14],
            tp1=r[15],
            tp2=r[16],
            tp3=r[17],
            rr_tp2=r[18],
            recorded=Outcome(
                status=r[19],
                tp_hits=int(r[24]),
                realized_r=r[20],
                cost_r=r[21],
                closed_at=None if r[22] is None else _utc(r[22]),
                duration_hours=r[23],
            ),
        )
        for r in rows
        if not wanted or r[3] in wanted or f"{r[2]}@{r[3]}" in wanted
    ]
    out.sort(
        key=lambda s: (
            s.strategy,
            _version_order(s.version),
            s.candle_close_time,
            s.symbol,
            s.public_id,
        )
    )
    return out


def load_version_labels(conn: Connection) -> list[tuple[str, str]]:
    """Все версии стратегий в БД: (стратегия, версия) — чтобы отклонить опечатку в фильтре."""
    rows = conn.execute(
        text(
            "select st.slug, sv.version from strategy_versions sv "
            "join strategies st on st.id = sv.strategy_id"
        )
    ).all()
    return sorted(((r[0], r[1]) for r in rows), key=lambda v: (v[0], _version_order(v[1])))


def iter_candles(
    conn: Connection,
    instrument_id: int,
    tf: Timeframe,
    start: datetime,
    now: datetime,
    window: timedelta = CANDLE_LOAD_WINDOW,
) -> Iterator[Candle]:
    """Закрытые свечи ``tf`` с ``open_time >= start``, закрывшиеся к ``now``, по порядку.

    Читает окнами по ``window`` и лениво: если потребитель остановился (сделка закрылась),
    следующие окна не запрашиваются. Строка с ``is_closed = false`` не отдаётся, даже если её
    интервал уже прошёл: цены такой свечи могли не дописаться, для пересчёта это пропуск.
    """
    end = interval_start(now, tf)  # свеча с open_time < end закрылась не позже now
    lower = start
    while lower < end:
        upper = min(lower + window, end)
        rows = conn.execute(
            text(
                "select open_time, open, high, low, close, volume, quote_volume, trades "
                "from candles where instrument_id = :i and timeframe = :tf "
                "and open_time >= :a and open_time < :b and is_closed order by open_time"
            ),
            {"i": instrument_id, "tf": tf.value, "a": lower, "b": upper},
        ).all()
        for r in rows:
            yield Candle(_utc(r[0]), r[1], r[2], r[3], r[4], r[5], r[6], r[7])
        lower = upper


def load_candles(
    conn: Connection, instrument_id: int, tf: Timeframe, start: datetime, now: datetime
) -> list[Candle]:
    """То же, что ``iter_candles``, одним запросом и списком."""
    span = max(now - start, tf.delta)
    return list(iter_candles(conn, instrument_id, tf, start, now, window=span))


# --- полнота ряда свечей -----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Gap:
    """Пропуск в ряду: ``candles`` свечей подряд, начиная со свечи с ``open_time = start``."""

    start: datetime
    candles: int


@dataclass(frozen=True, slots=True)
class Completeness:
    """Полнота ряда на отрезке [``start``; ``end``): сколько свечей ожидалось и каких нет."""

    start: datetime
    end: datetime
    expected: int
    gaps: tuple[Gap, ...]

    @property
    def missing(self) -> int:
        return sum(g.candles for g in self.gaps)

    @property
    def longest(self) -> int:
        return max((g.candles for g in self.gaps), default=0)


def check_completeness(
    open_times: Iterable[datetime], start: datetime, end: datetime, tf: Timeframe
) -> Completeness:
    """Каких свечей ``tf`` нет на отрезке [``start``; ``end``).

    ``open_times`` — времена открытия имеющихся свечей по возрастанию; ``start`` — на сетке
    ``tf``. Учитываются пропуски в начале (первая свеча позже ``start``), в середине и в конце
    (ряд обрывается раньше ``end``). Времена вне отрезка не учитываются.
    """
    step = tf.delta
    gaps: list[Gap] = []
    expected_next = start
    for t in open_times:
        if t < start or t >= end:
            continue
        absent = (t - expected_next) // step
        if absent > 0:
            gaps.append(Gap(expected_next, absent))
        expected_next = max(expected_next, t + step)
    if expected_next < end:
        gaps.append(Gap(expected_next, -((expected_next - end) // step)))
    expected = max(0, -((start - end) // step))
    return Completeness(start, end, expected, tuple(gaps))


# --- (а) 1m-трекер -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TrackedEvent:
    """Событие пересчитанной сделки — то, что воркер записал бы в ``signal_events``."""

    type: str
    price: Decimal | None
    at: datetime
    note: str | None


@dataclass(frozen=True, slots=True)
class MinuteRetrack:
    """Пересчёт сигнала исправленным 1m-трекером."""

    outcome: Outcome | None
    """``None`` — «не пересчитан» (причина — в ``reason``)."""
    completeness: Completeness
    events: tuple[TrackedEvent, ...]
    tracked_until: datetime | None
    """Закрытие последней обработанной минуты; у закрытой сделки совпадает с ``closed_at``."""
    reason: str | None = None
    gap_exceeded: bool = False
    """Не пересчитан именно из-за пропуска длиннее допустимого (а не из-за ошибки данных)."""


class _MemoryStore:
    """Хранилище в памяти вместо сессии БД для ``apply_candles``.

    Воркер пользуется двумя методами сессии — ``get`` и ``add``. Здесь они работают со словарём,
    поэтому всё, что воркер «записал» бы (события, состояние, результат), остаётся в памяти, а
    до БД не доходит ничего. Если воркер начнёт звать другой метод сессии, пересчёт упадёт с
    ``AttributeError`` — громко, а не молча.
    """

    def __init__(self, *rows: Any) -> None:
        self._rows: dict[tuple[type, Any], Any] = {}
        self.events: list[SignalEvent] = []
        for row in rows:
            self.add(row)

    def get(self, model: type, key: Any) -> Any:
        return self._rows.get((model, key))

    def add(self, obj: Any) -> None:
        if isinstance(obj, SignalEvent):
            self.events.append(obj)
            return
        key = obj.signal_id if isinstance(obj, SignalTracking | SignalResult) else obj.id
        self._rows[(type(obj), key)] = obj


def _transient_signal(signal: SignalRow) -> Signal:
    """Объект ``Signal`` вне сессии: копия торговых полей в статусе ``pending``. Код воркера и
    форварда читает сигнал из такого объекта и меняет ему статус — запись в БД от этого не
    появляется и строка сигнала не затрагивается."""
    return Signal(
        id=signal.id,
        public_id=signal.public_id,
        strategy_version_id=signal.strategy_version_id,
        instrument_id=signal.instrument_id,
        direction=signal.direction,
        candle_close_time=signal.candle_close_time,
        entry_market=signal.entry_market,
        entry_limit=signal.entry_limit,
        stop_loss=signal.stop_loss,
        tp1=signal.tp1,
        tp2=signal.tp2,
        tp3=signal.tp3,
        rr_tp2=signal.rr_tp2,
        score=signal.score,
        grade=signal.grade,
        status="pending",
        scope=signal.scope,
        input_hash="",
    )


def retrack_minutes(
    signal: SignalRow,
    candles: Iterable[Candle],
    now: datetime,
    max_gap_minutes: int = DEFAULT_MAX_GAP_MINUTES,
) -> MinuteRetrack:
    """Ведёт сигнал заново по 1m-свечам кодом воркера, с комиссиями (задачи 1 и 3).

    ``candles`` — минуты от закрытия сигнальной свечи по порядку (можно ленивый итератор:
    после закрытия сделки он дальше не читается). Свечи, не закрытые к ``now``, отбрасываются.
    Записанные статус, события и состояние трекера не используются: сделка ведётся с нуля.
    """
    sig = _transient_signal(signal)
    store = _MemoryStore(StrategyVersion(id=signal.strategy_version_id, version=signal.version))
    session = cast(Session, store)
    seen: list[datetime] = []
    error: str | None = None
    try:
        for batch in batched(candles, TRACK_BATCH):
            closed = closed_only(batch, MINUTE, now)
            seen.extend(c.open_time for c in closed)
            apply_candles(session, sig, closed, MINUTE)
            if sig.status not in OPEN or len(closed) < len(batch):
                break
    except (ValueError, ArithmeticError) as exc:
        # трекер отверг сигнал или свечу, битая строка свечи, стоп равен входу; ошибка БД сюда
        # не попадает и останавливает пересчёт целиком
        error = f"ошибка трекера или данных: {exc}"

    result: SignalResult | None = store.get(SignalResult, sig.id)
    tracking: SignalTracking | None = store.get(SignalTracking, sig.id)
    closed_at = result.closed_at if result is not None and error is None else None
    completeness = check_completeness(
        seen, signal.candle_close_time, closed_at or interval_start(now, MINUTE), MINUTE
    )
    if error is not None:
        return MinuteRetrack(None, completeness, (), None, error)
    if completeness.longest > max_gap_minutes:
        reason = (
            f"пропуск 1m-свечей {completeness.longest} мин подряд "
            f"(допустимо {max_gap_minutes}), всего нет {completeness.missing} мин"
        )
        return MinuteRetrack(None, completeness, (), None, reason, gap_exceeded=True)
    last = tracking.last_candle_time if tracking is not None else None
    outcome = Outcome(
        status=sig.status,
        tp_hits=state_from_json(tracking.state).hits if tracking is not None else 0,
        realized_r=result.realized_r if result is not None else None,
        cost_r=result.cost_r if result is not None else None,
        closed_at=closed_at,
        duration_hours=result.duration_hours if result is not None else None,
    )
    events = tuple(TrackedEvent(e.type, e.price, e.occurred_at, e.note) for e in store.events)
    return MinuteRetrack(
        outcome, completeness, events, None if last is None else last + MINUTE.delta
    )


# --- (б) H4-эталон -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class H4Retrack:
    """Пересчёт сигнала ``simulate_trade`` на H4 с комиссиями — как в бэктесте."""

    outcome: Outcome | None
    """``None`` — эталон не посчитан (причина — в ``reason``)."""
    tracked_until: datetime | None
    reason: str | None = None


def retrack_h4(signal: SignalRow, candles: Sequence[Candle], now: datetime) -> H4Retrack:
    """Исполняет сигнал на H4-свечах ``simulate_trade(DEFAULT_EXECUTION)`` — эталон бэктеста.

    ``candles`` — сохранённые свечи сигнального таймфрейма по порядку; свечи до закрытия
    сигнальной и не закрытые к ``now`` отбрасываются. Берётся непрерывный ряд от сигнальной
    свечи: ``simulate_trade`` считает сроки в штуках свечей, пропуск сдвинул бы time stop. Если
    сделка закрылась внутри непрерывного ряда — результат годен; если не закрылась, а свечи,
    которая уже должна быть, нет — эталон не посчитан.
    """
    tf = SIGNAL_TIMEFRAME
    expected_next = signal.candle_close_time
    run: list[Candle] = []
    for c in closed_only(candles, tf, now):
        if c.open_time < expected_next:
            continue
        if c.open_time != expected_next:
            break
        run.append(c)
        expected_next += tf.delta
    if not run:
        return H4Retrack(None, None, "нет H4-свечи сразу после сигнальной")
    trade_params = params_for_version(signal.version).trade
    result = simulate_trade(
        _setup_from_row(_transient_signal(signal)), run, trade_params, DEFAULT_EXECUTION
    )
    tracked_until = run[-1].close_time(tf)
    if result.exit_index is None:
        if expected_next < interval_start(now, tf):
            return H4Retrack(
                None,
                tracked_until,
                f"нет H4-свечи {expected_next:%Y-%m-%d %H:%M} UTC: сделка к ней не закрыта",
            )
        outcome = Outcome(_status_from_result(result), result.tp_hits, None, None, None, None)
        return H4Retrack(outcome, tracked_until)
    closed_at = run[result.exit_index].close_time(tf)
    outcome = Outcome(
        status=_status_from_result(result),
        tp_hits=result.tp_hits,
        realized_r=result.realized_r,
        cost_r=result.cost_r,
        closed_at=closed_at,
        duration_hours=Decimal((closed_at - signal.candle_close_time).total_seconds()) / 3600,
    )
    return H4Retrack(outcome, closed_at)


# --- (в) пометка пересечения с открытой сделкой ------------------------------------------------


@dataclass(frozen=True, slots=True)
class TradeSpan:
    """Жизнь сделки одного сигнала — вход правила «одна открытая сделка»."""

    public_id: str
    opened_at: datetime
    """Закрытие сигнальной свечи (рыночный вход)."""
    closed_at: datetime | None
    """``None`` — сделка не закрыта."""
    known: bool = True
    """``False`` — сделку не удалось пересчитать: была ли она открыта, неизвестно."""


@dataclass(frozen=True, slots=True)
class Overlap:
    """Пометка для отчёта: пересекается ли сигнал с открытой сделкой той же версии по
    инструменту. ``flag`` = ``None`` — неизвестно: сделку более раннего сигнала не удалось
    пересчитать."""

    flag: bool | None
    with_public_id: str | None = None


def _signal_life(span: TradeSpan) -> SignalLife:
    """Пересчитанная сделка как вход правила движка. Вход у пересчёта всегда рыночный, поэтому
    сделка либо открыта, либо закрыта; чем именно закрыта, в ``TradeSpan`` нет, а правилу и не
    нужно — все статусы ``closed_*`` оно читает одинаково, по времени закрытия."""
    status = SignalStatus.ACTIVE if span.closed_at is None else SignalStatus.CLOSED_TIME
    return SignalLife(span.public_id, span.opened_at, status, span.closed_at)


def open_trade_overlap(others: Iterable[TradeSpan], at: datetime) -> Overlap:
    """Правило задачи 6 как пометка (только чтение): занят ли инструмент в момент ``at``.

    ``others`` — сделки других сигналов **той же версии по тому же инструменту**. Ответ даёт
    правило движка ``engine.lifecycle.blocking_signal`` — то же, что в ``run_backtest`` и при
    записи кандидата: инструмент занят, если у более раннего сигнала сделка ещё открыта или
    закрылась внутри свечи сигнального таймфрейма, которая заканчивается в ``at``
    (``closed_at > at − H4``).

    Возвращается самая ранняя мешающая сделка. Сравнение — со всеми записанными сигналами, в
    том числе с теми, что сами помечены: это факт пересечения, а не моделирование того, какие
    сигналы появились бы при действующем правиле. Сделка, которую не удалось пересчитать
    (``known=False``), правилу не подаётся: если ни одна известная сделка не мешает, а такая
    среди более ранних есть — ответ «нет данных».
    """
    spans = list(others)
    blocker = blocking_signal((_signal_life(s) for s in spans if s.known), at)
    if blocker is not None:
        return Overlap(True, blocker.ref)
    unknown = min(
        (s for s in spans if not s.known and s.opened_at < at),
        key=lambda s: (s.opened_at, s.public_id),
        default=None,
    )
    if unknown is not None:
        return Overlap(None, unknown.public_id)
    return Overlap(False)
