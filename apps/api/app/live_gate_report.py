"""Отчёт «готовность к live» по версии стратегии и списку инструментов (задача 9 пакета
«Сигналы»; план 2.7, 2.9, 2.11, раздел 9 — DoD этапа 1, 3.19; 10.3 — задача 1.10).

Отчёт ничего не решает и статусов версий не меняет. Он сводит в один Markdown-файл форвард,
бэктест той же версии на том же списке инструментов и таблицу критериев плана со статусами
«выполнено», «не выполнено» и «нужно решение человека». Решение о выпуске в live принимает
владелец (план 10.4, ADR-0012).

Из чего состоит:

- **Форвард** (``build_forward``) — опубликованные форвард-сигналы версии (``signals.scope =
  'forward'`` и ``signals.published``) по инструментам списка. Каждый сигнал пересчитывается тем
  же кодом, что в боевом пути (``app.retrack``): 1m — исправленный трекер с комиссиями, H4 —
  ``simulate_trade``, эталон бэктеста. Трекинг здесь не переписан. Чтение — только в транзакции
  на чтение (``retrack.read_only_connection`` у вызывающего).
- **Бэктест** (``run_backtests``) — ``engine.backtest.run_backtest`` по каждому инструменту.
  Вход инструмента даёт вызывающий: скрипт ``scripts/live_gate_report.py`` берёт его
  загрузчиками ``scripts/backtest.py``. Свечи, не закрытые к ``now``, отсекаются здесь
  (``one_trade_report.bounded``) и в движок не попадают.
- **Статистика** — чистые функции без БД: бутстреп-интервал среднего R (``mean_interval``,
  генератор псевдослучайных чисел с заданным зерном), скользящие окна (``rolling_windows``) и
  место форварда в их распределении (``percentile_rank``).
- **Критерии** (``evaluate_criteria``) и раздел «Отличия форварда от бэктеста».

Отчёт детерминирован: одинаковые данные и аргументы дают одинаковый файл байт в байт. Текущее
время не используется нигде: момент отчёта ``now`` передаётся явно, бутстреп идёт от зерна.

Все числа — результаты на прошлых данных, а не обещание результата.
"""

from __future__ import annotations

import math
import random
from bisect import bisect_left
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum
from functools import partial
from multiprocessing import get_context
from pathlib import Path
from typing import Any

from sqlalchemy import Connection, text

from app.monitor import RECONCILE_KEY, RECONCILE_STALE
from app.one_trade_report import DEFAULT_WINDOW, bounded
from app.retrack import (
    DEFAULT_MAX_GAP_MINUTES,
    MINUTE,
    H4Retrack,
    MinuteRetrack,
    Outcome,
    SignalRow,
    TradeSpan,
    iter_candles,
    load_candles,
    load_signals,
    open_trade_overlap,
    retrack_h4,
    retrack_minutes,
)
from app.retrack_report import (
    NOT_COMPUTED,
    NOT_RETRACKED,
    STATUS_LABEL,
    as_stored,
    trade_span,
)
from engine.backtest import (
    DEFAULT_EXECUTION,
    BacktestTrade,
    Metrics,
    TradeResult,
    TradeStatus,
    breakdown,
    run_backtest,
    summarize,
)
from engine.candles import SIGNAL_TIMEFRAME
from engine.params import StrategyParams
from engine.scoring import Grade
from engine.signal import MarketInputs
from engine.strategies import STRATEGIES
from engine.structure import Direction

DEFAULT_SAMPLES = 10_000
"""Сколько бутстреп-выборок строится для каждого интервала."""
DEFAULT_SEED = 20261105
"""Зерно генератора бутстрепа по умолчанию (дата пакета «Сигналы»): с ним отчёт воспроизводим."""
CONFIDENCE = Decimal("0.95")
"""Уровень доверительного интервала (двусторонний)."""
ONE_SIDED_Z = Decimal("1.645")
"""Квантиль нормального распределения для одностороннего критерия на уровне 95 %."""

THREE_MONTHS = timedelta(days=91)
"""«3 месяца» плана 2.9 и 3.19 — здесь 91 день (13 недель)."""
WINDOW_STEP = timedelta(days=1)
"""Шаг скользящих окон бэктеста."""
MIN_BACKTEST_YEARS = 3
"""План 2.9: бэктест не короче 3 лет."""
MIN_TRADES = 200
"""План 2.9 и DoD этапа 1: не меньше 200 сделок."""
MIN_PROFIT_FACTOR = Decimal("1.4")
"""План 2.9 и DoD этапа 1: профит-фактор не ниже 1.4."""
MAX_DRAWDOWN_R = Decimal(20)
"""DoD этапа 1: просадка меньше 20 R при риске 1 % на сделку."""
RISK_PER_TRADE = Decimal("0.01")
"""Фиксированный риск на сделку, при котором план 2.11 считает просадку в процентах."""
SMALL_SAMPLE = 20
"""Градация, у которой закрытых сделок меньше, помечается как малая выборка."""
OUT_OF_SAMPLE_FROM = datetime(2025, 1, 1, tzinfo=UTC)
"""Граница in-sample / out-of-sample walk-forward плана 2.11 (2022–2024 / 2025–2026)."""

R_QUANT = Decimal("0.01")
R3_QUANT = Decimal("0.001")
PF_QUANT = Decimal("0.01")
SHARE_QUANT = Decimal("0.1")
DASH = "—"

ONE_TRADE_DOC = "docs/backtests/2026-11-11-one-open-trade.md"
ONE_TRADE_RULE_FROM = datetime(2026, 11, 12, 4, 39, tzinfo=UTC)
"""Когда правило одной открытой сделки заработало при записи кандидата (задача 6, PR #153).
Только для текста отчёта: форвард-сигналы проверяются правилом все, с любой датой."""
DIRECTION_LABEL = {Direction.DOWN: "шорт", Direction.UP: "лонг"}
DIRECTION_TITLE = {Direction.DOWN: "Шорт", Direction.UP: "Лонг"}
GRADES = (Grade.A, Grade.B, Grade.C)

_TRADE_STATUS = {
    "closed_sl": TradeStatus.CLOSED_SL,
    "closed_be": TradeStatus.CLOSED_BE,
    "closed_tp3": TradeStatus.CLOSED_TP3,
    "closed_time": TradeStatus.CLOSED_TIME,
    "expired": TradeStatus.EXPIRED,
}
"""Статус сигнала (``signals.status``) → статус сделки бэктеста; остальные — открытая сделка."""

Loader = Callable[[str], MarketInputs | None]
"""Вход бэктеста по инструменту; ``None`` — данных нет или мало."""


def resolve_version(value: str) -> str:
    """``1.2.0`` или ``trend-ob-retest@1.2.0`` → ключ ``engine.strategies``."""
    if value in STRATEGIES:
        return value
    matches = [key for key in STRATEGIES if key.endswith("@" + value)]
    if len(matches) != 1:
        known = ", ".join(sorted(STRATEGIES))
        raise ValueError(
            f"версии {value} нет в engine.strategies (или их несколько); есть: {known}"
        )
    return matches[0]


def same_rules(a: StrategyParams, b: StrategyParams) -> bool:
    """Одинаковы ли правила версий без учёта названия и списка инструментов."""
    return replace(a, version="", symbols=None) == replace(b, version="", symbols=None)


# --- параметры отчёта --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class GateOptions:
    version: str
    """Версия из ``engine.strategies``, например ``trend-ob-retest@1.2.0``."""
    symbols: tuple[str, ...]
    """Список инструментов — один для форварда и бэктеста."""
    symbols_label: str
    """Откуда список: ``mvp20``, ``all``, имя файла, «список версии»."""
    start: datetime
    """Начало бэктеста: закрытия H4 не раньше этого момента (UTC)."""
    end: datetime
    """Конец бэктеста: закрытия H4 не позже этого момента (UTC)."""
    now: datetime
    """Момент отчёта (UTC): форвард-сигналы и свечи позже него не читаются; свеча, не закрытая
    к этому моменту, не попадает ни в форвард, ни в бэктест."""
    since: datetime | None = None
    """Начало форварда (UTC). ``None`` — переход версии в форвард по журналу смен статуса
    (``forward_timeline``)."""
    samples: int = DEFAULT_SAMPLES
    seed: int = DEFAULT_SEED
    window: int = DEFAULT_WINDOW
    """Сколько последних свечей H4 видит расчёт сигнала — как в ``scripts/backtest.py``."""
    max_gap_minutes: int = DEFAULT_MAX_GAP_MINUTES
    command: str = ""
    """Команда, которой отчёт воспроизводится (печатается в отчёте как есть)."""

    def __post_init__(self) -> None:
        moments = [("start", self.start), ("end", self.end), ("now", self.now)]
        if self.since is not None:
            moments.append(("since", self.since))
        for name, t in moments:
            if t.tzinfo is None or t.utcoffset() != timedelta(0):
                raise ValueError(f"{name} должен быть timezone-aware в UTC")
        if self.version not in STRATEGIES:
            known = ", ".join(sorted(STRATEGIES))
            raise ValueError(f"версии {self.version} нет в engine.strategies; есть: {known}")
        if not self.symbols:
            raise ValueError("список инструментов пуст")
        if self.end < self.start:
            raise ValueError("конец бэктеста раньше начала")
        if self.now < self.end:
            raise ValueError("момент отчёта now раньше конца бэктеста")
        if self.since is not None and self.since > self.now:
            raise ValueError("начало форварда since позже момента отчёта now")
        if self.samples < 1:
            raise ValueError("число бутстреп-выборок должно быть не меньше 1")
        if self.max_gap_minutes < 0:
            raise ValueError("max_gap_minutes не может быть отрицательным")

    @property
    def params(self) -> StrategyParams:
        return STRATEGIES[self.version]

    @property
    def number(self) -> str:
        """Номер версии без названия стратегии: ``1.2.0``."""
        return self.version.rsplit("@", 1)[-1]


def report_name(version: str, now: datetime) -> str:
    """Имя файла по умолчанию: ``<дата отчёта>-live-gate-<номер версии>.md``."""
    return f"{now:%Y-%m-%d}-live-gate-{version.rsplit('@', 1)[-1]}.md"


# --- форвард -----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ForwardSignal:
    """Форвард-сигнал и два его пересчёта."""

    signal: SignalRow
    minutes: MinuteRetrack
    h4: H4Retrack
    blocked_by: str | None = None
    """``public_id`` сигнала, сделка которого занимала инструмент: по правилу одной открытой
    сделки (задача 6) этот сигнал не был бы записан. Такой сигнал в метрики не входит."""
    overlap_unknown: str | None = None
    """``public_id`` более раннего сигнала, сделку которого пересчитать не удалось: занят ли был
    инструмент, неизвестно. Сигнал входит в метрики."""
    cancelled_at: datetime | None = None
    """Момент ручной отмены (``admin.cancel_signal``, событие ``cancelled``) не позже момента
    отчёта; ``None`` — к моменту отчёта сигнал не отменён."""

    @property
    def counted(self) -> bool:
        """Входит ли сигнал в метрики форварда."""
        return self.blocked_by is None

    @property
    def cancelled(self) -> bool:
        """Сигнал отменён вручную к моменту отчёта."""
        return self.cancelled_at is not None

    @property
    def span(self) -> TradeSpan:
        """Жизнь сделки для правила одной сделки: по 1m, а без него по H4."""
        return trade_span(self.signal, self.minutes, self.h4)

    @property
    def m1(self) -> Outcome | None:
        """1m-трекер с комиссиями, в точности ``signal_results``; ``None`` — не пересчитан."""
        return None if self.minutes.outcome is None else as_stored(self.minutes.outcome)

    @property
    def ref(self) -> Outcome | None:
        """H4-эталон бэктеста, в точности ``signal_results``; ``None`` — не посчитан."""
        return None if self.h4.outcome is None else as_stored(self.h4.outcome)


@dataclass(frozen=True, slots=True)
class Forward:
    label: str
    """Версия, сигналы которой читались: ``стратегия@номер``."""
    in_db: bool
    """Есть ли версия в ``strategy_versions``. Нет — в форвард она не выпускалась."""
    status: str | None
    """Статус версии в БД на момент чтения."""
    since: datetime | None
    """Начало форварда: с него читаются сигналы. ``None`` — форвард не начинался."""
    since_source: str
    now: datetime
    signals: tuple[ForwardSignal, ...]
    outside: tuple[str, ...] = ()
    """Инструменты форвард-сигналов версии вне списка (такие сигналы не учитываются)."""
    outside_count: int = 0
    entered: datetime | None = None
    """Первый переход версии в форвард (``forward_timeline``); ``None`` — к моменту отчёта
    версия в форвард не переходила или перехода в журнале нет."""
    entered_note: str = ""
    """Откуда взят переход или почему его нет — для отчёта."""
    intervals: tuple[tuple[datetime, datetime | None], ...] = ()
    """Когда версия была в статусе forward (``forward_timeline``); пусто — отрезков в журнале
    нет, и форвардом считается всё от ``since``."""
    exit_note: str = ""
    """Как версия вышла из форварда, если вышла и больше не вернулась."""
    closes: tuple[tuple[str, datetime | None], ...] = ()
    """Последнее закрытие H4 не позже ``now`` по каждому инструменту списка (``data_boundary``);
    ``None`` — закрытых свечей нет."""

    @property
    def data_end(self) -> datetime | None:
        """Граница данных: последнее закрытие H4 хотя бы по одному инструменту списка."""
        return max((t for _, t in self.closes if t is not None), default=None)

    @property
    def exit(self) -> datetime | None:
        """Выход из форварда, после которого версия в него не вернулась (к моменту отчёта)."""
        return self.intervals[-1][1] if self.intervals else None

    @property
    def end(self) -> datetime | None:
        """Конец форварда: момент отчёта, но не позже границы данных и выхода из форварда."""
        if self.data_end is None:
            return None
        return min(t for t in (self.now, self.data_end, self.exit) if t is not None)

    @property
    def spans(self) -> tuple[tuple[datetime, datetime], ...]:
        """Отрезки в статусе forward внутри [начало форварда; конец]."""
        if self.since is None or self.end is None:
            return ()
        out = []
        for a, b in self.intervals or ((self.since, None),):
            lo, hi = max(a, self.since), min(b or self.end, self.end)
            if hi > lo:
                out.append((lo, hi))
        return tuple(out)

    @property
    def period(self) -> timedelta | None:
        """Длина форварда — время в статусе forward от начала до конца."""
        if self.since is None or self.end is None:
            return None
        return sum((hi - lo for lo, hi in self.spans), timedelta(0))

    @property
    def interrupted(self) -> bool:
        """Версия выходила из форварда и возвращалась: в длину перерывы не входят."""
        return len(self.spans) > 1

    @property
    def stale(self) -> bool:
        """Данные H4 обрываются раньше последнего закрытия H4 к концу форварда."""
        target = self.now if self.exit is None else min(self.now, self.exit)
        return self.data_end is None or self.data_end < last_close(target)

    @property
    def lagging(self) -> tuple[tuple[str, datetime | None], ...]:
        """Инструменты, у которых свечи H4 кончаются раньше конца форварда: сигналы по ним
        после этой даты не могли появиться."""
        end = self.end
        if end is None:
            return ()
        return tuple((sym, t) for sym, t in self.closes if t is None or t < last_close(end))

    @property
    def rule_gaps(self) -> tuple[ForwardSignal, ...]:
        """Подавленные сигналы, сделка которых шла и после включения правила одной сделки: пока
        она шла, живой режим считал инструмент занятым и мог не записать сигналы, которые
        бэктест взял бы."""
        if self.end is None or self.end <= ONE_TRADE_RULE_FROM:
            return ()
        return tuple(
            s
            for s in self.blocked
            if not s.span.known
            or s.span.closed_at is None
            or s.span.closed_at > ONE_TRADE_RULE_FROM
        )

    @property
    def counted(self) -> tuple[ForwardSignal, ...]:
        """Сигналы, которые входят в метрики (без подавленных правилом одной сделки)."""
        return tuple(s for s in self.signals if s.counted)

    @property
    def blocked(self) -> tuple[ForwardSignal, ...]:
        return tuple(s for s in self.signals if not s.counted)


def last_close(now: datetime) -> datetime:
    """Последнее закрытие свечи H4 не позже ``now``."""
    step = SIGNAL_TIMEFRAME.delta
    return now - (now - datetime(1970, 1, 1, tzinfo=UTC)) % step


@dataclass(frozen=True, slots=True)
class StatusChange:
    """Смена статуса версии: из заявки (``status_change_requests``) или из аудит-лога, если
    статус сменили без заявки (замена live-версии, миграция по поручению владельца)."""

    from_status: str
    to_status: str
    at: datetime
    how: str
    """Откуда известно — для текста отчёта."""


HOW_REQUEST = "решение по заявке"
HOW_REPLACED = "замена live-версии"
HOW_DELEGATED = "миграция по поручению владельца"
ENTRY_NOTE = {
    HOW_REQUEST: "решение по заявке на переход в форвард",
    HOW_REPLACED: "возврат в форвард при замене live-версии",
    HOW_DELEGATED: "переход в форвард миграцией по поручению владельца",
}


@dataclass(frozen=True, slots=True)
class VersionRow:
    """Строка версии в ``strategy_versions`` и все известные смены её статуса."""

    created_at: datetime
    status: str
    changes: tuple[StatusChange, ...] = ()
    """По времени."""


def load_version(conn: Connection, label: str) -> VersionRow | None:
    """Строка версии ``стратегия@номер`` и смены её статуса: применённые заявки и записи
    аудит-лога о сменах без заявки — понижение заменённой live-версии в форвард
    (``version.status`` с ``reason = replaced``) и архивирование миграцией
    (``status.delegated``)."""
    slug, _, number = label.rpartition("@")
    row = conn.execute(
        text(
            "select sv.id, sv.created_at, sv.status from strategy_versions sv "
            "join strategies st on st.id = sv.strategy_id "
            "where st.slug = :slug and sv.version = :version"
        ),
        {"slug": slug, "version": number},
    ).first()
    if row is None:
        return None
    changes = [
        StatusChange(str(c[0]), str(c[1]), c[2].astimezone(UTC), HOW_REQUEST)
        for c in conn.execute(
            text(
                "select from_status, to_status, decided_at from status_change_requests "
                "where strategy_version_id = :id and decision = 'applied' "
                "and decided_at is not null"
            ),
            {"id": row[0]},
        ).all()
    ]
    audit = conn.execute(
        text(
            "select action, payload ->> 'from', payload ->> 'to', created_at from admin_audit "
            "where target = :target and payload ? 'from' and payload ? 'to' and ("
            "(action = 'version.status' and payload ->> 'reason' = 'replaced') "
            "or action = 'status.delegated')"
        ),
        {"target": f"strategy_version:{row[0]}"},
    ).all()
    for action, frm, to, at in audit:
        how = HOW_REPLACED if action == "version.status" else HOW_DELEGATED
        changes.append(StatusChange(str(frm), str(to), at.astimezone(UTC), how))
    changes.sort(key=lambda c: (c.at, c.from_status, c.to_status))
    return VersionRow(row[1].astimezone(UTC), str(row[2]), tuple(changes))


@dataclass(frozen=True, slots=True)
class ForwardTimeline:
    """Когда версия была в статусе forward (только тогда она пишет форвард-сигналы)."""

    intervals: tuple[tuple[datetime, datetime | None], ...]
    """Отрезки ``[начало; конец)`` в статусе forward до ``now``; ``None`` — ещё в форварде."""
    note: str
    """Откуда начало или почему форварда нет."""
    exit_note: str = ""
    """Как и когда версия вышла из форварда (последний выход), если вышла."""

    @property
    def entered(self) -> datetime | None:
        return self.intervals[0][0] if self.intervals else None


def forward_timeline(version: VersionRow, now: datetime) -> ForwardTimeline:
    """Отрезки, когда версия была в статусе forward, по сменам статуса до ``now``.

    Начальный статус — ``from_status`` первой смены, а без смен — статус сейчас; с ним версия
    живёт от создания строки. До задачи 4 версии создавались сразу в форварде, с задачи 4 — в
    статусе backtest. Выход из форварда (в archived, backtest или live) отрезок заканчивает:
    live-версия пишет сигналы с областью live, а отчёт читает только форвард."""
    state = version.changes[0].from_status if version.changes else version.status
    start: datetime | None = version.created_at if state == "forward" else None
    note = f"создание версии в статусе {state}" if start is not None else ""
    exit_note = ""
    intervals: list[tuple[datetime, datetime | None]] = []
    for c in version.changes:
        if c.at > now:
            break
        if c.to_status == "forward" and start is None:
            start = c.at
            if not intervals:
                note = ENTRY_NOTE.get(c.how, c.how)
        elif c.to_status != "forward" and start is not None:
            intervals.append((start, c.at))
            start = None
            exit_note = (
                f"версия вышла из форварда {_when(c.at)} UTC в статус {c.to_status} ({c.how})"
            )
        state = c.to_status
    if start is not None:
        if start > now:
            start = None
        else:
            intervals.append((start, None))
            exit_note = ""
    if not intervals:
        first = next((c for c in version.changes if c.to_status == "forward"), None)
        if version.created_at > now or (first is not None and first.at > now):
            when = version.created_at if first is None else first.at
            return ForwardTimeline(
                (), f"версия перешла в форвард {_when(when)} UTC — позже момента отчёта"
            )
        return ForwardTimeline(
            (), f"версия в форвард не переходила (статус в БД — {version.status})"
        )
    return ForwardTimeline(tuple(intervals), note, exit_note)


def data_boundary(conn: Connection, symbols: Sequence[str], now: datetime) -> dict[str, datetime]:
    """Последнее закрытие H4 не позже ``now`` по каждому инструменту списка; инструментов без
    закрытых свечей в ответе нет. Граница ограничена ``now`` — поэтому повторный отчёт с теми
    же аргументами на пополнившейся базе даёт тот же результат."""
    tf = SIGNAL_TIMEFRAME
    rows = conn.execute(
        text(
            "select i.symbol, x.open_time from instruments i cross join lateral ("
            "select c.open_time from candles c where c.instrument_id = i.id "
            "and c.timeframe = :tf and c.is_closed and c.open_time <= :last "
            "order by c.open_time desc limit 1) x "
            "where i.symbol = any(:symbols) and i.market_type = 'futures'"
        ),
        {"tf": tf.value, "last": now - tf.delta, "symbols": list(symbols)},
    ).all()
    return {str(r[0]): r[1].astimezone(UTC) + tf.delta for r in rows}


def apply_one_trade_rule(signals: Sequence[ForwardSignal]) -> list[ForwardSignal]:
    """Правило одной открытой сделки (задача 6) над форвардом, по времени сигнала.

    До задачи 6 запись кандидата это правило не проверяла, и в форварде могут быть сигналы,
    которых бэктест не взял бы. Каждому сигналу правило движка (``open_trade_overlap`` →
    ``engine.lifecycle.blocking_signal``) задаёт вопрос: занят ли инструмент сделкой более
    раннего **неподавленного** сигнала той же версии — так же, как в ``run_backtest``. Сделка —
    по 1m-пересчёту, а без него по H4 (``ForwardSignal.span``), как у правила в живом режиме.
    Сигнал, отменённый вручную, с момента отмены инструмент не занимает — как в
    ``engine.lifecycle``. Сигналы до начала форварда не учитываются."""
    taken: dict[int, list[tuple[TradeSpan, datetime | None]]] = {}
    out: list[ForwardSignal] = []
    for s in sorted(signals, key=lambda x: (x.signal.candle_close_time, x.signal.public_id)):
        sig = s.signal
        at = sig.candle_close_time
        spans = taken.setdefault(sig.instrument_id, [])
        live = [span for span, cancelled in spans if cancelled is None or cancelled > at]
        overlap = open_trade_overlap(live, at)
        if overlap.flag is True:
            out.append(replace(s, blocked_by=overlap.with_public_id))
            continue
        spans.append((s.span, s.cancelled_at))
        unknown = overlap.with_public_id if overlap.flag is None else None
        out.append(replace(s, overlap_unknown=unknown))
    order = {id(s.signal): i for i, s in enumerate(signals)}
    return sorted(out, key=lambda x: order[id(x.signal)])


def load_cancellations(
    conn: Connection, signal_ids: Sequence[int], now: datetime
) -> dict[int, datetime]:
    """Момент ручной отмены сигнала (событие ``cancelled``) — только отмены не позже ``now``."""
    if not signal_ids:
        return {}
    rows = conn.execute(
        text(
            "select signal_id, min(occurred_at) from signal_events "
            "where type = 'cancelled' and signal_id = any(:ids) and occurred_at <= :now "
            "group by signal_id"
        ),
        {"ids": list(signal_ids), "now": now},
    ).all()
    return {int(r[0]): r[1].astimezone(UTC) for r in rows}


def build_forward(
    conn: Connection,
    label: str,
    symbols: Sequence[str],
    now: datetime,
    since: datetime | None = None,
    max_gap_minutes: int = DEFAULT_MAX_GAP_MINUTES,
) -> Forward:
    """Форвард версии ``label`` по инструментам ``symbols``: сигналы и их пересчёты. Только
    ``SELECT``; ``conn`` — соединение только на чтение.

    Начало форварда — первый переход версии в форвард по журналу смен статуса
    (``forward_timeline``); ``since`` раньше перехода не уводит, а без перехода в журнале —
    задаёт начало сам. Длина — время в статусе forward до ``now``, границы данных H4
    (``data_boundary``) и выхода из форварда. Сигналы — опубликованные (``signals.published``)
    форвард-сигналы с закрытием сигнальной свечи в [начало; ``now``]; live-сигналы, кандидаты
    ниже порога публикации и отложенные не читаются.
    """
    found = data_boundary(conn, symbols, now)
    closes = tuple((sym, found.get(sym)) for sym in dict.fromkeys(symbols))
    version = load_version(conn, label)
    if version is None:
        return Forward(label, False, None, None, "", now, (), closes=closes)
    timeline = forward_timeline(version, now)
    entered, note = timeline.entered, timeline.note
    if since is not None and (entered is None or since >= entered):
        start: datetime | None = since
        source = "--since"
    elif entered is not None:
        start = entered
        source = note + ("; --since раньше перехода" if since is not None else "")
    else:
        start, source = None, ""
    base = Forward(
        label,
        True,
        version.status,
        start,
        source,
        now,
        (),
        entered=entered,
        entered_note=note,
        intervals=timeline.intervals,
        exit_note=timeline.exit_note,
        closes=closes,
    )
    if start is None:
        return base
    wanted = set(symbols)
    rows = load_signals(conn, start, now, versions=(label,), scopes=("forward",))
    outside = [s for s in rows if s.symbol not in wanted]
    inside = [s for s in rows if s.symbol in wanted]
    cancelled = load_cancellations(conn, [s.id for s in inside], now)
    out: list[ForwardSignal] = []
    for signal in inside:
        at = signal.candle_close_time
        minutes = retrack_minutes(
            signal, iter_candles(conn, signal.instrument_id, MINUTE, at, now), now, max_gap_minutes
        )
        try:
            h4 = retrack_h4(
                signal, load_candles(conn, signal.instrument_id, SIGNAL_TIMEFRAME, at, now), now
            )
        except (ValueError, ArithmeticError) as exc:
            h4 = H4Retrack(None, None, f"ошибка данных H4: {exc}")
        out.append(ForwardSignal(signal, minutes, h4, cancelled_at=cancelled.get(signal.id)))
    return replace(
        base,
        signals=tuple(apply_one_trade_rule(out)),
        outside=tuple(sorted({s.symbol for s in outside})),
        outside_count=len(outside),
    )


def as_trade(signal: SignalRow, outcome: Outcome) -> BacktestTrade:
    """Пересчитанный форвард-сигнал в виде сделки бэктеста — чтобы метрики форварда считались
    той же функцией ``summarize``, что и метрики бэктеста. Незакрытая сделка — ``OPEN``: в
    суммы и средние она не входит, как и в бэктесте."""
    status = _TRADE_STATUS.get(outcome.status, TradeStatus.OPEN)
    result = TradeResult(
        status=status,
        realized_r=outcome.realized_r if outcome.realized_r is not None else Decimal(0),
        r_if_tp1_only=None,
        r_if_full_tp2=None,
        tp_hits=outcome.tp_hits,
        entry_index=0,
        exit_index=None,
        max_favorable_r=Decimal(0),
        max_adverse_r=Decimal(0),
        cost_r=outcome.cost_r if outcome.cost_r is not None else Decimal(0),
    )
    return BacktestTrade(
        symbol=signal.symbol,
        direction=Direction.UP if signal.direction == "long" else Direction.DOWN,
        signal_time=signal.candle_close_time,
        grade=Grade(signal.grade),
        score=signal.score,
        rr_tp2=signal.rr_tp2,
        entry=signal.entry_market,
        stop=signal.stop_loss,
        tp1=signal.tp1,
        tp2=signal.tp2,
        tp3=signal.tp3,
        result=result,
        exit_time=outcome.closed_at,
    )


CANCELLED_OUTCOME = Outcome(
    status="closed_time",
    tp_hits=0,
    realized_r=Decimal(0),
    cost_r=Decimal(0),
    closed_at=None,
    duration_hours=None,
)
"""Отменённый вручную сигнал в статистике — закрытая сделка с 0 R (план 2.10, ``app.stats``)."""


def forward_trades(signals: Sequence[ForwardSignal], method: str) -> list[BacktestTrade]:
    """Сделки форварда по расчёту ``method`` (``"h4"`` или ``"1m"``). Не входят: сигналы,
    подавленные правилом одной сделки, и сигналы, которые этим расчётом посчитать не удалось.

    Отменённый вручную сигнал в 1m — 0 R, как в статистике сайта (план 2.10); в H4-эталоне — тот
    результат, который был бы без отмены (справочно, отчёт это помечает)."""
    out = []
    for s in signals:
        if not s.counted:
            continue
        if method == "1m" and s.cancelled:
            out.append(as_trade(s.signal, CANCELLED_OUTCOME))
            continue
        outcome = s.ref if method == "h4" else s.m1
        if outcome is not None:
            out.append(as_trade(s.signal, outcome))
    return out


# --- бэктест -----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SymbolRun:
    """Бэктест одного инструмента."""

    symbol: str
    h4: int
    funding: int
    open_interest: int
    long_short: int
    """Размеры входа после отсечения по ``now`` — чтобы в отчёте было видно, на чём считали."""
    first_close: datetime | None
    last_close: datetime | None
    """Первое и последнее закрытие H4 инструмента внутри периода бэктеста."""
    evaluated: int
    busy: int
    trades: tuple[BacktestTrade, ...]


@dataclass(frozen=True, slots=True)
class Backtest:
    runs: tuple[SymbolRun, ...]
    """Инструменты с данными, в порядке списка."""
    missing: tuple[str, ...]
    """Инструменты списка без данных (или с короткой историей)."""

    @property
    def trades(self) -> list[BacktestTrade]:
        return [t for r in self.runs for t in r.trades]


def backtest_symbol(inp: MarketInputs, options: GateOptions) -> SymbolRun:
    """Бэктест инструмента тем же ``run_backtest``, что у ``scripts/backtest.py``. Инструменты
    в бэктесте друг на друга не влияют, поэтому прогон по одному даёт те же сделки, что общий."""
    tf = SIGNAL_TIMEFRAME
    inp = bounded(inp, options.now)
    run = run_backtest(
        [inp], options.params, options.start, options.end, DEFAULT_EXECUTION, options.window
    )
    closes = [t for c in inp.h4 if options.start <= (t := c.close_time(tf)) <= options.end]
    return SymbolRun(
        symbol=inp.symbol,
        h4=len(inp.h4),
        funding=len(inp.funding),
        open_interest=len(inp.open_interest),
        long_short=len(inp.long_short),
        first_close=closes[0] if closes else None,
        last_close=closes[-1] if closes else None,
        evaluated=run.evaluated,
        busy=run.skipped["busy"],
        trades=tuple(run.trades),
    )


def _run_symbol(load: Loader, options: GateOptions, symbol: str) -> SymbolRun | None:
    inp = load(symbol)
    return None if inp is None else backtest_symbol(inp, options)


def run_backtests(
    symbols: Sequence[str], load: Loader, options: GateOptions, jobs: int = 1
) -> Backtest:
    """Бэктест по каждому инструменту, в порядке списка. ``jobs`` > 1 — в стольких процессах;
    на результат не влияет. Для процессов ``load`` должен быть функцией уровня модуля (или
    ``functools.partial`` от неё)."""
    ordered = list(dict.fromkeys(symbols))
    work = partial(_run_symbol, load, options)
    if jobs <= 1 or len(ordered) <= 1:
        results = [work(s) for s in ordered]
    else:
        with ProcessPoolExecutor(max_workers=jobs, mp_context=get_context("spawn")) as pool:
            results = list(pool.map(work, ordered))
    runs = tuple(r for r in results if r is not None)
    missing = tuple(s for s, r in zip(ordered, results, strict=True) if r is None)
    return Backtest(runs, missing)


# --- статистика (чистые функции) ---------------------------------------------------------------


def percentile(values: Sequence[Decimal], q: Decimal) -> Decimal:
    """Перцентиль ``q`` (0–1) с линейной интерполяцией между соседними значениями — как
    ``numpy.percentile`` по умолчанию. ``values`` сортируются здесь."""
    if not values:
        raise ValueError("перцентиль пустого набора не определён")
    if not Decimal(0) <= q <= Decimal(1):
        raise ValueError("q должен быть от 0 до 1")
    xs = sorted(values)
    pos = q * (len(xs) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def percentile_rank(values: Sequence[Decimal], x: Decimal) -> Decimal:
    """Место ``x`` в распределении ``values`` (0–1): доля значений меньше ``x`` плюс половина
    равных ему."""
    if not values:
        raise ValueError("место в пустом распределении не определено")
    below = sum(1 for v in values if v < x)
    equal = sum(1 for v in values if v == x)
    return (Decimal(below) + Decimal(equal) / 2) / len(values)


def bootstrap_means(values: Sequence[Decimal], size: int, samples: int, seed: int) -> list[Decimal]:
    """Средние ``samples`` выборок по ``size`` значений из ``values`` с возвращением.

    Генератор — ``random.Random(seed)``: при том же зерне и тех же значениях результат тот же на
    любой машине. Суммы — в ``Decimal``, без накопления ошибки округления.
    """
    if not values:
        raise ValueError("бутстреп по пустому набору не определён")
    if size < 1 or samples < 1:
        raise ValueError("размер выборки и число выборок должны быть не меньше 1")
    rng = random.Random(seed)
    n = len(values)
    out = []
    for _ in range(samples):
        total = Decimal(0)
        for _ in range(size):
            total += values[rng.randrange(n)]
        out.append(total / size)
    return out


@dataclass(frozen=True, slots=True)
class Interval:
    """Бутстреп-интервал среднего R: в ``level`` случаев среднее ``size`` сделок, взятых из
    сделок бэктеста, лежит в [``low``; ``high``]."""

    size: int
    low: Decimal
    high: Decimal
    level: Decimal = CONFIDENCE

    def contains(self, x: Decimal) -> bool:
        return self.low <= x <= self.high


def mean_interval(
    values: Sequence[Decimal],
    samples: int,
    seed: int,
    size: int | None = None,
    level: Decimal = CONFIDENCE,
) -> Interval:
    """Двусторонний бутстреп-интервал среднего (перцентильный метод).

    ``size`` = ``None`` — выборки того же размера, что и ``values``: доверительный интервал
    среднего R самого бэктеста. Меньший ``size`` — в каких пределах бывает среднее ``size``
    сделок с тем же распределением, что в бэктесте: с этим сравнивается форвард из ``size``
    сделок («в пределах доверительного интервала бэктеста», план 2.9).
    """
    n = len(values) if size is None else size
    means = bootstrap_means(values, n, samples, seed)
    tail = (1 - level) / 2
    return Interval(n, percentile(means, tail), percentile(means, 1 - tail), level)


def trades_needed(values: Sequence[Decimal], z: Decimal = ONE_SIDED_Z) -> int | None:
    """Сколько сделок с таким же средним и разбросом нужно, чтобы средний R > 0 был отличим от
    нуля (односторонний критерий, нормальное приближение): ``(z · σ / μ)²``, с округлением
    вверх. ``None`` — средний R не больше нуля или сделок меньше двух."""
    n = len(values)
    if n < 2:
        return None
    mean = sum(values, Decimal(0)) / n
    if mean <= 0:
        return None
    variance = sum(((v - mean) ** 2 for v in values), Decimal(0)) / (n - 1)
    return math.ceil((z * variance.sqrt() / mean) ** 2)


@dataclass(frozen=True, slots=True)
class Window:
    """Окно бэктеста [``start``; ``end``): сделки с сигналом внутри окна."""

    start: datetime
    end: datetime
    trades: int
    closed: int
    sum_r: Decimal


def rolling_windows(
    trades: Sequence[BacktestTrade],
    start: datetime,
    end: datetime,
    length: timedelta,
    step: timedelta = WINDOW_STEP,
) -> list[Window]:
    """Скользящие окна длины ``length`` с шагом ``step``: от ``start``, пока окно целиком внутри
    [``start``; ``end``]. Сделка относится к окну по времени сигнала; сумма R — по закрытым
    сделкам, как в ``summarize``."""
    if length <= timedelta(0) or step <= timedelta(0):
        raise ValueError("длина окна и шаг должны быть положительными")
    times = sorted(t.signal_time for t in trades)
    closed = sorted(
        ((t.signal_time, t.realized_r) for t in trades if t.result.closed), key=lambda x: x[0]
    )
    closed_times = [t for t, _ in closed]
    prefix = [Decimal(0)]
    for _, r in closed:
        prefix.append(prefix[-1] + r)
    out = []
    ws = start
    while ws + length <= end:
        we = ws + length
        lo, hi = bisect_left(closed_times, ws), bisect_left(closed_times, we)
        out.append(
            Window(
                ws,
                we,
                bisect_left(times, we) - bisect_left(times, ws),
                hi - lo,
                prefix[hi] - prefix[lo],
            )
        )
        ws += step
    return out


@dataclass(frozen=True, slots=True)
class WindowStats:
    """Распределение результатов по скользящим окнам одной длины."""

    length: timedelta
    count: int
    trades: tuple[Decimal, Decimal, Decimal]
    """Сделок в окне: p10, медиана, p90."""
    sum_r: tuple[Decimal, Decimal, Decimal]
    """Сумма R окна: p10, медиана, p90."""
    empty: int
    """Окон без сделок."""
    negative: int
    """Окон с отрицательной суммой R."""
    trade_counts: tuple[Decimal, ...]
    sums: tuple[Decimal, ...]


QUANTILES = (Decimal("0.1"), Decimal("0.5"), Decimal("0.9"))


def window_stats(windows: Sequence[Window], length: timedelta) -> WindowStats | None:
    """Сводка по окнам; ``None`` — окон нет (период бэктеста короче окна)."""
    if not windows:
        return None
    counts = tuple(Decimal(w.trades) for w in windows)
    sums = tuple(w.sum_r for w in windows)
    p10, p50, p90 = (percentile(counts, q) for q in QUANTILES)
    s10, s50, s90 = (percentile(sums, q) for q in QUANTILES)
    return WindowStats(
        length=length,
        count=len(windows),
        trades=(p10, p50, p90),
        sum_r=(s10, s50, s90),
        empty=sum(1 for w in windows if w.trades == 0),
        negative=sum(1 for w in windows if w.sum_r < 0),
        trade_counts=counts,
        sums=sums,
    )


# --- сверка (задача 8) -------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ReconcileState:
    """Итог последней ежедневной сверки — то, что уведомитель кладёт в Redis ``reconcile:last``
    (или выводит ``scripts/reconcile.py --json``)."""

    source: str
    at: datetime | None = None
    since: datetime | None = None
    checked: int = 0
    critical: int = 0
    warnings: int = 0
    explained: int = 0
    legacy: int = 0
    """Результаты, записанные до учёта комиссий: не сверяются (задача 10)."""
    hidden: int = 0
    unchecked: tuple[str, ...] = ()
    """Сигналы, которые сверка не смогла проверить (нет 1m и H4, неизвестная версия)."""
    lines: tuple[str, ...] = ()
    failed: str | None = None
    error: str | None = None
    """Итог не читается (не тот формат)."""


def parse_reconcile(raw: Mapping[str, Any] | None, source: str) -> ReconcileState | None:
    """Итог сверки из JSON ``reconcile:last``; ``None`` — итог не передан."""
    if raw is None:
        return None
    try:
        at = datetime.fromisoformat(str(raw["at"])).astimezone(UTC)
        if raw.get("failed"):
            return ReconcileState(source, at=at, failed=str(raw["failed"]))
        since = raw.get("since")
        return ReconcileState(
            source,
            at=at,
            since=None if since is None else datetime.fromisoformat(str(since)).astimezone(UTC),
            checked=int(raw["checked"]),
            critical=int(raw["critical"]),
            warnings=int(raw["warnings"]),
            explained=int(raw.get("explained", 0)),
            legacy=int(raw.get("legacy", 0)),
            hidden=int(raw.get("hidden", 0)),
            unchecked=tuple(str(u) for u in raw.get("unchecked", [])),
            lines=tuple(str(line) for line in raw.get("lines", [])),
        )
    except (KeyError, TypeError, ValueError) as exc:
        return ReconcileState(source, error=f"{type(exc).__name__}: {exc}")


# --- критерии ----------------------------------------------------------------------------------


class Status(StrEnum):
    MET = "выполнено"
    NOT_MET = "не выполнено"
    HUMAN = "нужно решение человека"


@dataclass(frozen=True, slots=True)
class Criterion:
    name: str
    source: str
    value: str
    status: Status


@dataclass(frozen=True, slots=True)
class Report:
    options: GateOptions
    forward: Forward
    backtest: Backtest
    reconcile: ReconcileState | None = None
    dropped: tuple[str, ...] = ()
    """Инструменты, отброшенные списком версии (``StrategyParams.symbols``)."""


@dataclass(frozen=True, slots=True)
class Analysis:
    """Всё, что считается по отчёту: метрики, интервалы, окна, критерии."""

    backtest: Metrics
    forward_h4: Metrics
    forward_m1: Metrics
    forward_closed_r: tuple[Decimal, ...]
    """R закрытых форвард-сделок по H4-пересчёту, по времени сигнала."""
    interval: Interval | None
    """Доверительный интервал среднего R бэктеста."""
    forward_interval: Interval | None
    """Пределы среднего R для числа закрытых форвард-сделок."""
    reference_intervals: tuple[Interval, ...]
    windows: tuple[WindowStats, ...]
    forward_windows: WindowStats | None
    """Окна длины форварда (если форвард есть)."""
    needed: int | None
    criteria: tuple[Criterion, ...]


def _closed_r(trades: Sequence[BacktestTrade]) -> list[Decimal]:
    closed = sorted((t for t in trades if t.result.closed), key=lambda t: t.signal_time)
    return [t.realized_r for t in closed]


def _add_years(t: datetime, years: int) -> datetime:
    try:
        return t.replace(year=t.year + years)
    except ValueError:  # 29 февраля
        return t.replace(year=t.year + years, day=28)


REFERENCE_SIZES = (10, 20)
"""Сколько сделок, кроме форварда и ожидаемых за 3 месяца, показывать в таблице пределов."""


def analyze(report: Report) -> Analysis:
    """Считает по отчёту метрики, интервалы, окна и критерии. Все интервалы строятся от одного
    зерна: интервал для одного и того же числа сделок всегда одинаков."""
    o = report.options
    trades = report.backtest.trades
    rs = _closed_r(trades)
    fwd = report.forward
    fwd_h4 = forward_trades(fwd.signals, "h4")
    fwd_rs = tuple(_closed_r(fwd_h4))
    interval = mean_interval(rs, o.samples, o.seed) if rs else None
    forward_interval = (
        mean_interval(rs, o.samples, o.seed, size=len(fwd_rs)) if rs and fwd_rs else None
    )
    days = Decimal((o.end - o.start).total_seconds()) / 86400
    per_quarter = (
        Decimal(len(trades)) * Decimal(THREE_MONTHS.days) / days if days > 0 else Decimal(0)
    )
    quarter = int(per_quarter.to_integral_value(ROUND_HALF_UP))
    sizes = sorted({n for n in (quarter, *REFERENCE_SIZES) if n and n != len(fwd_rs)})
    reference = tuple(mean_interval(rs, o.samples, o.seed, size=n) for n in sizes) if rs else ()
    lengths = [THREE_MONTHS]
    period = fwd.period
    if fwd.in_db and period is not None and period >= timedelta(days=1):
        lengths.append(period)
    stats: list[WindowStats] = []
    forward_windows = None
    for length in lengths:
        ws = window_stats(rolling_windows(trades, o.start, o.end, length), length)
        if ws is None:
            continue
        if fwd.in_db and length == period:
            forward_windows = ws
        if all(s.length != length for s in stats):
            stats.append(ws)
    analysis = Analysis(
        backtest=summarize(trades),
        forward_h4=summarize(fwd_h4),
        forward_m1=summarize(forward_trades(fwd.signals, "1m")),
        forward_closed_r=fwd_rs,
        interval=interval,
        forward_interval=forward_interval,
        reference_intervals=reference,
        windows=tuple(stats),
        forward_windows=forward_windows,
        needed=trades_needed(rs),
        criteria=(),
    )
    return replace(analysis, criteria=tuple(evaluate_criteria(report, analysis)))


def evaluate_criteria(report: Report, a: Analysis) -> list[Criterion]:
    """Таблица критериев плана. То, что код проверить не может (ревью человеком, бета, юридические
    тексты), получает «нужно решение человека»."""
    o = report.options
    m = a.backtest
    fwd = report.forward
    out: list[Criterion] = []

    years = Decimal((o.end - o.start).total_seconds()) / (Decimal("365.25") * 86400)
    long_enough = _add_years(o.start, MIN_BACKTEST_YEARS) <= o.end
    out.append(
        Criterion(
            f"Бэктест не короче {MIN_BACKTEST_YEARS} лет",
            "план 2.9",
            f"{_date(o.start)} — {_date(o.end)}, {_q(years, SHARE_QUANT)} года",
            Status.MET if long_enough else Status.NOT_MET,
        )
    )
    out.append(
        Criterion(
            f"Не меньше {MIN_TRADES} сделок",
            "план 2.9; DoD этапа 1",
            f"закрытых сделок: {m.closed}",
            Status.MET if m.closed >= MIN_TRADES else Status.NOT_MET,
        )
    )
    pf = m.profit_factor
    pf_ok = m.closed > 0 and (pf is None or pf >= MIN_PROFIT_FACTOR)
    out.append(
        Criterion(
            f"Профит-фактор не ниже {MIN_PROFIT_FACTOR}",
            "план 2.9; DoD этапа 1",
            _pf(pf) if m.closed else "сделок нет",
            Status.MET if pf_ok else Status.NOT_MET,
        )
    )

    out.append(_forward_length(fwd))

    out.append(_forward_in_interval(fwd, a))

    grade_means = [(g, breakdown_mean(report.backtest.trades, g)) for g in GRADES]
    cells = ", ".join(f"{g.value} {_r(mean)} ({n})" for g, (mean, n) in grade_means)
    small = [f"{g.value} ({n})" for g, (_, n) in grade_means if n < SMALL_SAMPLE]
    if any(mean is None for _, (mean, _) in grade_means):
        status = Status.HUMAN
        cells += "; у градации нет закрытых сделок — порядок не проверить"
    else:
        a_mean, b_mean, c_mean = (mean for _, (mean, _) in grade_means)
        assert a_mean is not None and b_mean is not None and c_mean is not None
        status = Status.MET if a_mean > b_mean > c_mean else Status.NOT_MET
    if small:
        cells += f"; мало сделок (меньше {SMALL_SAMPLE}): {', '.join(small)}"
    out.append(
        Criterion(
            "Средний R на бэктесте: A > B > C",
            "план 2.7; DoD этапа 1 (монотонность)",
            cells,
            status,
        )
    )

    dd = m.max_drawdown_r
    out.append(
        Criterion(
            f"Просадка меньше {MAX_DRAWDOWN_R} R при риске 1 % на сделку",
            "DoD этапа 1",
            f"{_q(dd, R_QUANT)} R ≈ {_q(dd * RISK_PER_TRADE * 100, R_QUANT)} % депозита",
            Status.MET if m.closed and dd < MAX_DRAWDOWN_R else Status.NOT_MET,
        )
    )
    out.append(
        Criterion(
            "Ревью логики сигналов человеком",
            "DoD этапа 1; план 10.4",
            "кодом не проверяется",
            Status.HUMAN,
        )
    )
    out.append(
        Criterion(
            "Ревью 20 примеров на правило",
            "CLAUDE.md; план 10.4",
            f"правило одной открытой сделки — 20 примеров на версию в `{ONE_TRADE_DOC}`; "
            "исправленный трекер — графики отчёта пересчёта (задача 7); остальные правила "
            "кодом не проверяются",
            Status.HUMAN,
        )
    )
    out.append(_reconcile_criterion(report.reconcile, o.now))
    out.append(
        Criterion(
            "Бета на 30 пользователях не меньше 2 недель",
            "3.19 (релиз 1.0)",
            "кодом не проверяется",
            Status.HUMAN,
        )
    )
    out.append(
        Criterion(
            "Юридические тексты утверждены",
            "3.19 (релиз 1.0); план 8",
            "кодом не проверяется",
            Status.HUMAN,
        )
    )
    return out


def breakdown_mean(trades: Sequence[BacktestTrade], grade: Grade) -> tuple[Decimal | None, int]:
    """Средний R и число закрытых сделок градации."""
    m = breakdown(trades, lambda t: t.grade.value).get(grade.value)
    return (None, 0) if m is None else (m.avg_r, m.closed)


def _forward_length(fwd: Forward) -> Criterion:
    """Длина форварда: от перехода версии в форвард (или ``--since``) до границы данных."""
    name = "Форвард не короче 3 месяцев"
    source = "план 2.9; 3.19 (релиз 1.0)"
    if not fwd.in_db:
        value = f"версии {fwd.label} нет в БД: в форвард она не выпускалась"
        return Criterion(name, source, value, Status.NOT_MET)
    if fwd.since is None:
        return Criterion(name, source, fwd.entered_note, Status.NOT_MET)
    if fwd.end is None:
        value = "закрытых свечей H4 по инструментам списка до момента отчёта нет"
        return Criterion(name, source, value, Status.NOT_MET)
    period = fwd.period or timedelta(0)
    value = f"{_date(fwd.since)} — {_date(fwd.end)}, {_days(period)}"
    if fwd.stale:
        value += f"; данные H4 только до {_when(fwd.data_end)} UTC — раньше конца форварда"
    if fwd.exit_note:
        value += f"; {fwd.exit_note}"
    status = Status.MET if period >= THREE_MONTHS else Status.NOT_MET
    if fwd.interrupted:
        gaps = ", ".join(f"{_date(lo)} — {_date(hi)}" for lo, hi in fwd.spans)
        value += f"; версия выходила из форварда, в длину вошли только отрезки в форварде: {gaps}"
        status = Status.HUMAN if status is Status.MET else status
    if fwd.entered is None:
        # начало задано --since, а перехода в форвард в журнале нет
        value += f"; {fwd.entered_note}"
        has_signals = bool(fwd.signals) or fwd.outside_count > 0
        status = Status.HUMAN if has_signals and status is Status.MET else Status.NOT_MET
    return Criterion(name, source, value, status)


def _forward_in_interval(fwd: Forward, a: Analysis) -> Criterion:
    name = "Форвард в пределах доверительного интервала бэктеста"
    source = "план 2.9; 3.19 (релиз 1.0)"
    if not fwd.signals:
        return Criterion(name, source, "форвард-сигналов нет", Status.NOT_MET)
    if not fwd.counted:
        value = "все форвард-сигналы подавило бы правило одной открытой сделки"
        return Criterion(name, source, value, Status.NOT_MET)
    if not a.forward_closed_r:
        return Criterion(name, source, "закрытых форвард-сделок нет", Status.NOT_MET)
    mean = sum(a.forward_closed_r, Decimal(0)) / len(a.forward_closed_r)
    interval = a.forward_interval
    if interval is None:
        return Criterion(name, source, "у бэктеста нет закрытых сделок", Status.NOT_MET)
    value = (
        f"средний R форварда (H4) {_r(mean)}, закрытых сделок {len(a.forward_closed_r)}; "
        f"пределы для стольких сделок [{_r(interval.low)}; {_r(interval.high)}]"
    )
    blocked = len(fwd.blocked)
    if blocked:
        value += f"; без {blocked} сигн., подавленных правилом одной сделки"
    missing = sum(1 for s in fwd.counted if s.ref is None)
    cancelled = sum(1 for s in fwd.counted if s.cancelled)
    unknown = sum(1 for s in fwd.counted if s.overlap_unknown is not None)
    doubts = []
    if missing:
        doubts.append(f"без H4-эталона сигналов: {missing}")
    if cancelled:
        doubts.append(
            f"отменено вручную: {cancelled} (в H4-эталоне посчитаны как без отмены — решите, "
            "учитывать ли их)"
        )
    if unknown:
        doubts.append(
            f"занятость инструмента не проверить (нет пересчёта более раннего): {unknown}"
        )
    if fwd.rule_gaps:
        doubts.append(
            f"после включения правила одной сделки ({_date(ONE_TRADE_RULE_FROM)}) живой режим "
            "мог не записать сигналы, которые бэктест взял бы: инструмент занимал подавленный "
            f"сигнал — {_gap_list(fwd)}"
        )
    if fwd.lagging:
        doubts.append(
            f"у {len(fwd.lagging)} инструм. свечи H4 кончаются раньше конца форварда — сигналы "
            "по ним могли не появиться"
        )
    if doubts:
        return Criterion(name, source, f"{value}; {'; '.join(doubts)}", Status.HUMAN)
    return Criterion(name, source, value, Status.MET if interval.contains(mean) else Status.NOT_MET)


def _gap_list(fwd: Forward) -> str:
    parts = []
    for s in fwd.rule_gaps:
        span = s.span
        until = (
            "сделку не пересчитать"
            if not span.known
            else "сделка не закрыта"
            if span.closed_at is None
            else f"до {_when(span.closed_at)} UTC"
        )
        parts.append(f"{s.signal.symbol} `{s.signal.public_id}` ({until})")
    return ", ".join(parts)


def _reconcile_criterion(state: ReconcileState | None, now: datetime) -> Criterion:
    name = "Нет расхождений в ежедневной сверке"
    source = "задача 8; план, раздел 11"
    if state is None:
        return Criterion(
            name,
            source,
            f"итог сверки не передан (Redis `{RECONCILE_KEY}` — аргумент --reconcile-json "
            "или --reconcile-redis)",
            Status.HUMAN,
        )
    if state.error is not None:
        return Criterion(name, source, f"итог сверки не читается: {state.error}", Status.HUMAN)
    assert state.at is not None
    if state.failed is not None:
        return Criterion(
            name,
            source,
            f"сверка {_when(state.at)} UTC не выполнена: {state.failed}",
            Status.NOT_MET,
        )
    window = "" if state.since is None else f" (сигналы с {_when(state.since)} UTC)"
    value = (
        f"сверка {_when(state.at)} UTC{window}: проверено сигналов {state.checked}, "
        f"критичных расхождений {state.critical}, предупреждений {state.warnings}"
    )
    if state.unchecked:
        value += f", не удалось сверить {len(state.unchecked)}"
    if state.legacy:
        value += f", результатов до учёта комиссий (не сверяются) {state.legacy}"
    if now - state.at > RECONCILE_STALE:
        hours = int(RECONCILE_STALE.total_seconds() // 3600)
        return Criterion(
            name, source, f"{value}; итог старше {hours} ч на момент отчёта", Status.HUMAN
        )
    if state.critical or state.warnings:
        return Criterion(name, source, value, Status.NOT_MET)
    if state.unchecked:
        shown = "; ".join(state.unchecked[:3]) + ("; …" if len(state.unchecked) > 3 else "")
        return Criterion(name, source, f"{value} ({shown})", Status.HUMAN)
    return Criterion(name, source, value, Status.MET)


# --- форматирование ----------------------------------------------------------------------------


def _q(x: Decimal, quant: Decimal) -> Decimal:
    """Округление половины от нуля, без «минус нуля»."""
    q = x.quantize(quant, rounding=ROUND_HALF_UP)
    return abs(q) if q == 0 else q


def _r(x: Decimal | None, quant: Decimal = R_QUANT) -> str:
    """R со знаком; нет значения — прочерк."""
    if x is None:
        return DASH
    q = _q(x, quant)
    return str(q) if q == 0 else format(q, "+f")


def _pf(x: Decimal | None) -> str:
    return "нет убыточных" if x is None else str(_q(x, PF_QUANT))


def _share(part: int, whole: int) -> str:
    if whole == 0:
        return DASH
    return f"{_q(Decimal(part) * 100 / whole, SHARE_QUANT)} %"


def _rate(x: Decimal | None) -> str:
    """Доля 0–1 как проценты с одним знаком."""
    return DASH if x is None else f"{_q(x * 100, SHARE_QUANT)} %"


def _num(x: Decimal, quant: Decimal = SHARE_QUANT) -> str:
    q = _q(x, quant)
    return format(q.normalize(), "f") if q == q.to_integral_value() else str(q)


def _int(n: int) -> str:
    return f"{n:,}".replace(",", " ")


def _date(t: datetime | None) -> str:
    return DASH if t is None else f"{t:%d.%m.%Y}"


def _when(t: datetime | None) -> str:
    return DASH if t is None else f"{t:%d.%m.%Y %H:%M}"


def _days(td: timedelta) -> str:
    if td % timedelta(days=1) == timedelta(0):
        return f"{td.days} дн."
    return f"{_q(Decimal(td.total_seconds()) / 86400, SHARE_QUANT)} дн."


def _table(headers: Sequence[str], rows: Sequence[Sequence[object]], align: str = "") -> list[str]:
    """Таблица Markdown; ``align`` — строка из «r» и «l» по столбцам (по умолчанию все «l»)."""
    spec = align.ljust(len(headers), "l")

    def line(cells: Sequence[object]) -> str:
        return "| " + " | ".join(str(c).replace("|", "\\|") for c in cells) + " |"

    return [
        line(headers),
        "|" + "|".join("---:" if a == "r" else "---" for a in spec) + "|",
        *(line(r) for r in rows),
    ]


METRICS_HEADERS = (
    "Срез",
    "Сделок",
    "Закрыто",
    "Открыто",
    "Прибыльных",
    "Средний R",
    "PF",
    "Сумма R",
    "Просадка R",
)
METRICS_ALIGN = "lrrrrrrrr"


def _metrics_row(name: str, m: Metrics) -> list[str]:
    return [
        name,
        str(m.signals),
        str(m.closed),
        str(m.open),
        _rate(m.winrate),
        _r(m.avg_r),
        _pf(m.profit_factor) if m.closed else DASH,
        _r(m.sum_r) if m.closed else DASH,
        str(_q(m.max_drawdown_r, R_QUANT)) if m.closed else DASH,
    ]


def _slices(trades: Sequence[BacktestTrade]) -> list[tuple[str, Metrics]]:
    """Срезы: все, по направлению, по градации."""
    out = [("Все", summarize(trades))]
    for d in (Direction.DOWN, Direction.UP):
        out.append((DIRECTION_TITLE[d], summarize([t for t in trades if t.direction is d])))
    for g in GRADES:
        out.append((f"Градация {g.value}", summarize([t for t in trades if t.grade is g])))
    return out


def _outcome_cell(outcome: Outcome | None, missing: str, reason: str | None) -> str:
    if outcome is None:
        return f"{missing}: {reason}" if reason else missing
    label = STATUS_LABEL.get(outcome.status, outcome.status)
    if outcome.realized_r is None:
        return label
    return f"{label} {_r(outcome.realized_r, R3_QUANT)}"


# --- Markdown ----------------------------------------------------------------------------------


def render_markdown(report: Report, analysis: Analysis | None = None) -> str:
    """Отчёт для владельца целиком."""
    a = analysis or analyze(report)
    o = report.options
    out: list[str] = [f"# Готовность к live: {o.version}", ""]
    out += [
        "Отчёт задачи 9 пакета «Сигналы» (`docs/signals/2026-11-05-task-pack.md`): форвард против "
        "бэктеста той же версии на том же списке инструментов и таблица критериев плана (2.7, "
        "2.9, раздел 9 — DoD этапа 1, 3.19). Решение о выпуске в live принимает владелец "
        "(план 10.4); скрипт статусов версий не меняет и в базу данных ничего не пишет.",
        "",
        "Все числа — результаты на прошлых данных, а не обещание результата. Три месяца форварда "
        "проверяют исправность конвейера, а не прибыльность: выборки маленькие.",
        "",
    ]
    out += _render_parameters(report)
    out += _render_summary(report, a)
    out += _render_criteria(a)
    out += _render_forward(report, a)
    out += _render_backtest(report, a)
    out += _render_differences(report, a)
    if o.command:
        out += ["## Как воспроизвести", "", "```", o.command, "```", ""]
        out += [
            "Одинаковые данные и аргументы дают тот же файл байт в байт: текущее время не "
            "используется, бутстреп идёт от зерна.",
            "",
        ]
    return "\n".join(out).rstrip("\n") + "\n"


def _render_parameters(report: Report) -> list[str]:
    o = report.options
    p = o.params
    fwd = report.forward
    fee = format((DEFAULT_EXECUTION.fee_rate * 100).normalize(), "f")
    slip = format((DEFAULT_EXECUTION.slippage * 100).normalize(), "f")
    if not fwd.in_db:
        forward = "версии нет в БД (`strategy_versions`)"
    elif fwd.since is None:
        forward = f"не начинался: {fwd.entered_note}"
    else:
        source = "аргумент --since" if fwd.since_source == "--since" else fwd.since_source
        forward = (
            f"{_when(fwd.since)} — {_when(fwd.end)} UTC; начало — {source}; статус версии в "
            f"БД — {fwd.status}"
        )
        if fwd.entered is not None and fwd.since_source == "--since":
            forward += f"; переход в форвард — {_when(fwd.entered)} UTC ({fwd.entered_note})"
        elif fwd.entered is None:
            forward += f"; {fwd.entered_note}"
        if fwd.exit_note:
            forward += f"; {fwd.exit_note}"
        if fwd.interrupted:
            forward += "; отрезки в форварде: " + ", ".join(
                f"{_when(lo)} — {_when(hi)}" for lo, hi in fwd.spans
            )
    if fwd.data_end is None:
        boundary = "закрытых свечей H4 по инструментам списка до момента отчёта нет"
    else:
        boundary = (
            f"закрытые свечи H4 хотя бы по одному инструменту списка — до {_when(fwd.data_end)} UTC"
        )
        if fwd.stale:
            boundary += " — **раньше конца форварда**: форвард считается до этой границы"
        if fwd.lagging:
            boundary += "; **раньше конца форварда кончаются** у " + ", ".join(
                f"{sym} ({'нет свечей' if t is None else _when(t)})" for sym, t in fwd.lagging
            )
    rows = [
        ("Версия", f"`{o.version}`"),
        ("Инструменты", f"{o.symbols_label}, {len(o.symbols)}: {', '.join(o.symbols)}"),
        (
            "Бэктест",
            f"закрытия H4 с {_date(o.start)} по {_date(o.end)}; рыночный вход; комиссия "
            f"{fee} % за сторону, проскальзывание {slip} %",
        ),
        ("Момент отчёта", f"{_when(o.now)} UTC"),
        ("Граница данных", boundary),
        ("Форвард", forward),
        ("Бутстреп", f"{_int(o.samples)} выборок, зерно {o.seed}"),
        (
            "Сверка (задача 8)",
            "не передана" if report.reconcile is None else report.reconcile.source,
        ),
    ]
    if report.dropped:
        rows.insert(2, ("Вне списка версии, отброшены", ", ".join(report.dropped)))
    if p.symbols is not None:
        twins = [
            k
            for k, v in STRATEGIES.items()
            if k != o.version and v.symbols is None and same_rules(v, p)
        ]
        if twins:
            rows.insert(
                2,
                (
                    "Правила версии",
                    f"те же, что у `{twins[0]}`, но только по списку инструментов версии",
                ),
            )
    return ["## Параметры", "", *_table(("", ""), rows), ""]


def _render_summary(report: Report, a: Analysis) -> list[str]:
    m = a.backtest
    fwd = report.forward
    out = ["## Коротко", ""]
    out.append(
        f"- Бэктест: закрытых сделок {m.closed}, прибыльных {_rate(m.winrate)}, средний R "
        f"{_r(m.avg_r)}, PF {_pf(m.profit_factor) if m.closed else DASH}, сумма "
        f"{_r(m.sum_r)} R, наибольшая просадка {_q(m.max_drawdown_r, R_QUANT)} R."
    )
    if not fwd.signals:
        out.append(f"- Форвард: {_no_forward_reason(fwd)}.")
    else:
        h4, m1 = a.forward_h4, a.forward_m1
        out.append(
            f"- Форвард: сигналов {len(fwd.signals)} за {_days(fwd.period or timedelta(0))}"
            + _blocked_tail(fwd)
            + f". По H4-пересчёту (эталон бэктеста) закрыто {h4.closed}, средний R "
            f"{_r(h4.avg_r)}, сумма {_r(h4.sum_r)} R; по 1m-трекеру закрыто {m1.closed}, средний "
            f"R {_r(m1.avg_r)}, сумма {_r(m1.sum_r)} R."
        )
    counts = {s: sum(1 for c in a.criteria if c.status is s) for s in Status}
    out.append(
        f"- Критерии ({len(a.criteria)}): выполнено {counts[Status.MET]}, не выполнено "
        f"{counts[Status.NOT_MET]}, нужно решение человека {counts[Status.HUMAN]}."
    )
    failed = [c.name for c in a.criteria if c.status is Status.NOT_MET]
    if failed:
        out.append(f"- Не выполнено: {'; '.join(failed)}.")
    out.append("")
    return out


def _blocked_tail(fwd: Forward) -> str:
    """Хвост фразы о сигналах, подавленных правилом одной сделки."""
    n = len(fwd.blocked)
    if not n:
        return ""
    return (
        f", из них {n} подавило бы правило одной открытой сделки — в метрики они не входят "
        f"(в форварде правило действует с {_date(ONE_TRADE_RULE_FROM)})"
    )


def _no_forward_reason(fwd: Forward) -> str:
    if not fwd.in_db:
        return (
            f"форвард-сигналов нет — версии `{fwd.label}` нет в БД (`strategy_versions`), в "
            "форвард она не выпускалась"
        )
    if fwd.since is None:
        return f"форвард-сигналов нет — {fwd.entered_note}"
    tail = f" (ещё {fwd.outside_count} вне списка инструментов)" if fwd.outside_count else ""
    return (
        f"форвард-сигналов нет — с {_when(fwd.since)} по {_when(fwd.now)} UTC версия не "
        f"опубликовала ни одного сигнала по инструментам списка{tail}"
    )


def _render_criteria(a: Analysis) -> list[str]:
    rows = [
        (str(i), c.name, c.source, c.value, f"**{c.status.value}**")
        for i, c in enumerate(a.criteria, 1)
    ]
    return [
        "## Критерии",
        "",
        *_table(("№", "Критерий", "Источник", "Значение", "Статус"), rows, "r"),
        "",
        "«Нужно решение человека» — пункт, который код проверить не может или по которому данных "
        "недостаточно. Сравнение форварда с бэктестом — по H4-пересчёту: так же исполняет сделки "
        "бэктест (риск 1 пакета «Сигналы»). При малом числе форвард-сделок пределы среднего R "
        "широкие и пункт «форвард в пределах доверительного интервала» выполняется почти при любом "
        "форварде — смотрите и место форварда в "
        "скользящих окнах бэктеста.",
        "",
        "Сверка: в отчёт попадает итог последней ежедневной сверки (сигналы за 7 дней и открытые "
        "сделки). Итоги прошлых дней не хранятся — расхождения за весь форвард видны в письмах "
        "владельцу и инцидентах монитора («Сверка сигналов» на /status).",
        "",
    ]


def _render_forward(report: Report, a: Analysis) -> list[str]:
    fwd = report.forward
    o = report.options
    out = ["## Форвард", ""]
    out.append(
        "Опубликованные форвард-сигналы версии (`signals.scope = 'forward'` и "
        "`signals.published`) по инструментам списка, закрытие сигнальной свечи — с начала "
        "форварда по момент отчёта. Live-сигналы, кандидаты ниже порога публикации и отложенные "
        "не входят."
    )
    out.append("")
    if not fwd.signals:
        out += [f"**{_no_forward_reason(fwd)[0].upper()}{_no_forward_reason(fwd)[1:]}.**", ""]
        twins = [
            k
            for k, v in STRATEGIES.items()
            if k != o.version and v.symbols is None and same_rules(v, o.params)
        ]
        if o.params.symbols is not None and twins:
            out += [
                f"Правила этой версии совпадают с `{twins[0]}`, а правило одной открытой сделки "
                "действует по инструменту, поэтому её форвард можно измерить сигналами "
                f"`{twins[0]}` по тем же инструментам: `--version "
                f"{twins[0].rsplit('@', 1)[-1]} --symbols <список>`.",
                "",
            ]
        return out
    period = fwd.period or timedelta(0)
    out.append(
        f"Период: {_when(fwd.since)} — {_when(fwd.end)} UTC ({_days(period)}). Сигналов: "
        f"{len(fwd.signals)}."
        + (
            f" Сигналов версии по инструментам вне списка: {fwd.outside_count} "
            f"({', '.join(fwd.outside)}), они не учитываются."
            if fwd.outside_count
            else ""
        )
    )
    out.append("")
    out.append(
        "Каждый сигнал пересчитан тем же кодом, что в боевом пути (`app.retrack`): **1m** — "
        "исправленный трекер с комиссиями (так ведутся форвард и live), **H4** — `simulate_trade` "
        "с комиссиями, эталон бэктеста. Записанный в БД итог показан в таблице сигналов для "
        "справки. Незакрытая сделка в суммы и средние не входит. Отменённый вручную сигнал в 1m "
        "— 0 R, как в статистике сайта (план 2.10), в H4-эталоне — результат без отмены."
    )
    out.append("")
    if fwd.blocked:
        out += [
            f"**Правило одной открытой сделки.** {len(fwd.blocked)} сигн. записаны, когда "
            "инструмент был занят сделкой более раннего сигнала той же версии: до "
            f"{_date(ONE_TRADE_RULE_FROM)} (задача 6) запись кандидата это правило не "
            "проверяла. Бэктест таких сигналов не берёт, поэтому в метрики форварда они не "
            "входят; в таблице сигналов они помечены. Сделка — по 1m-пересчёту, как у правила "
            "в живом режиме; сигналы до начала форварда не учитываются.",
            "",
        ]
    if fwd.rule_gaps:
        out += [
            f"После включения правила ({_date(ONE_TRADE_RULE_FROM)}) живой режим считал "
            "инструмент занятым, пока шла сделка подавленного сигнала, и мог не записать "
            f"сигналы, которые бэктест взял бы: {_gap_list(fwd)}.",
            "",
        ]
    rows = []
    not_m1 = sum(1 for s in fwd.counted if s.m1 is None and not s.cancelled)
    not_h4 = sum(1 for s in fwd.counted if s.ref is None)
    for name, m, missing in (
        ("1m-трекер", a.forward_m1, not_m1),
        ("H4-эталон", a.forward_h4, not_h4),
    ):
        row = _metrics_row(name, m)
        rows.append([row[0], str(missing), *row[1:]])
    headers = ("Расчёт", "Не посчитан", *METRICS_HEADERS[1:])
    out += [*_table(headers, rows, "lr" + METRICS_ALIGN[1:]), ""]

    out += ["### По направлению и градации", ""]
    rows = []
    for (name, h4), (_, m1) in zip(
        _slices(forward_trades(fwd.signals, "h4")),
        _slices(forward_trades(fwd.signals, "1m")),
        strict=True,
    ):
        rows.append(_metrics_row(f"{name}, H4", h4))
        rows.append(_metrics_row(f"{name}, 1m", m1))
    out += [*_table(METRICS_HEADERS, rows, METRICS_ALIGN), ""]

    same = sum(
        1
        for s in fwd.counted
        if s.m1 is not None and s.ref is not None and s.m1.status == s.ref.status
    )
    both = sum(1 for s in fwd.counted if s.m1 is not None and s.ref is not None)
    out += [
        f"Статус по 1m и по H4 совпал у {same} из {both} сигналов, посчитанных обоими способами. "
        "Расхождения законны: на 1m порядок касаний внутри H4-свечи известен, бэктест считает "
        "«стоп первым».",
        "",
    ]

    out += ["### Сигналы", ""]
    signal_rows: list[tuple[str, ...]] = []
    for s in fwd.signals:
        sig = s.signal
        recorded = sig.recorded
        rec = STATUS_LABEL.get(recorded.status, recorded.status)
        if recorded.realized_r is not None:
            rec += f" {_r(recorded.realized_r, R3_QUANT)}"
            if recorded.cost_r is None:
                rec += " (без комиссий)"
        signal_rows.append(
            (
                f"`{sig.public_id}`",
                sig.symbol,
                _when(sig.candle_close_time),
                DIRECTION_LABEL[Direction.UP if sig.direction == "long" else Direction.DOWN],
                sig.grade,
                rec,
                _outcome_cell(s.m1, NOT_RETRACKED, s.minutes.reason),
                _outcome_cell(s.ref, NOT_COMPUTED, s.h4.reason),
                _signal_note(s),
            )
        )
    signal_headers = (
        "Сигнал",
        "Инструмент",
        "Сигнал, UTC",
        "Направление",
        "Градация",
        "Записано в БД",
        "1m",
        "H4",
        "Пометка",
    )
    out += [*_table(signal_headers, signal_rows), ""]
    return out


def _signal_note(s: ForwardSignal) -> str:
    notes = []
    if s.blocked_by is not None:
        notes.append(f"инструмент занят сделкой `{s.blocked_by}` — в метрики не входит")
    if s.overlap_unknown is not None:
        notes.append(f"занятость не проверить: нет пересчёта `{s.overlap_unknown}`")
    if s.cancelled:
        notes.append("отменён вручную: в 1m — 0 R, H4 — справочно")
    return "; ".join(notes) or DASH


def _render_backtest(report: Report, a: Analysis) -> list[str]:
    o = report.options
    bt = report.backtest
    trades = bt.trades
    m = a.backtest
    out = ["## Бэктест", ""]
    out.append(
        f"Версия `{o.version}` на том же списке инструментов, закрытия H4 с {_date(o.start)} по "
        f"{_date(o.end)}; `engine.backtest.run_backtest` с правилом одной открытой сделки, "
        f"исполнение по H4 с комиссиями. Данные — до {_when(o.now)} UTC: сделка, не закрывшаяся "
        "к этому моменту, показана открытой и в суммы не входит."
    )
    out.append("")
    evaluated = sum(r.evaluated for r in bt.runs)
    busy = sum(r.busy for r in bt.runs)
    line = (
        f"Инструментов с данными: {len(bt.runs)} из {len(o.symbols)}. Оценено закрытий H4: "
        f"{_int(evaluated)}; пропущено правилом одной сделки: {_int(busy)}."
    )
    if bt.missing:
        line += f" Нет данных или мало истории: {', '.join(bt.missing)}."
    closes = [r.last_close for r in bt.runs if r.last_close is not None]
    if closes and max(closes) < last_close(o.end):
        line += (
            f" Последнее закрытие H4 в данных — {_when(max(closes))} UTC, раньше конца бэктеста."
        )
    out += [line, ""]

    rows = [_metrics_row(name, mm) for name, mm in _slices(trades)]
    rows.append(
        _metrics_row(
            "до 2025 (in-sample)",
            summarize([t for t in trades if t.signal_time < OUT_OF_SAMPLE_FROM]),
        )
    )
    rows.append(
        _metrics_row(
            "с 2025 (out-of-sample)",
            summarize([t for t in trades if t.signal_time >= OUT_OF_SAMPLE_FROM]),
        )
    )
    for year, mm in breakdown(trades, lambda t: str(t.signal_time.year)).items():
        rows.append(_metrics_row(year, mm))
    out += [*_table(METRICS_HEADERS, rows, METRICS_ALIGN), ""]
    out += [
        f"Наибольшая просадка {_q(m.max_drawdown_r, R_QUANT)} R — при риске 1 % на сделку около "
        f"{_q(m.max_drawdown_r * RISK_PER_TRADE * 100, R_QUANT)} % депозита (план 2.11; без "
        "сложного процента). In-sample / out-of-sample — разбиение walk-forward плана 2.11.",
        "",
    ]

    out += ["### По инструментам", ""]
    late = o.start + timedelta(days=30)
    symbol_rows: list[tuple[str, ...]] = []
    for r in bt.runs:
        mm = summarize(r.trades)
        symbol_rows.append(
            (
                r.symbol,
                _date(r.first_close)
                + (" (позже начала)" if r.first_close and r.first_close > late else ""),
                _int(r.h4),
                _int(r.funding),
                _int(r.open_interest),
                _int(r.long_short),
                str(mm.signals),
                _r(mm.sum_r) if mm.closed else DASH,
                _pf(mm.profit_factor) if mm.closed else DASH,
            )
        )
    symbol_headers = (
        "Инструмент",
        "Первое закрытие H4",
        "Свечей H4",
        "Funding",
        "OI",
        "Long/short",
        "Сделок",
        "Сумма R",
        "PF",
    )
    out += [*_table(symbol_headers, symbol_rows, "llrrrrrrr"), ""]

    out += _render_expectation(report, a)
    out += _render_intervals(report, a)
    out += _render_windows(report, a)
    return out


def _render_expectation(report: Report, a: Analysis) -> list[str]:
    o = report.options
    trades = report.backtest.trades
    days = Decimal((o.end - o.start).total_seconds()) / 86400
    out = ["### Ожидаемое число сделок за период форварда", ""]
    if days <= 0:
        return [*out, "Период бэктеста пустой.", ""]
    rate = Decimal(len(trades)) / days
    lengths = [s.length for s in a.windows] or [THREE_MONTHS]
    skewed = False
    for length in lengths:
        expected = rate * Decimal(length.total_seconds()) / 86400
        stats = next((s for s in a.windows if s.length == length), None)
        text_ = (
            f"- За {_days(length)}"
            + (
                " (3 месяца, минимальный форвард по плану 2.9)"
                if length == THREE_MONTHS
                else " (длина форварда)"
            )
            + f": в среднем {_num(expected)} при темпе бэктеста (сделок {len(trades)} за "
            f"{_num(days, Decimal(1))} дн.)"
        )
        if stats is not None:
            p10, p50, p90 = stats.trades
            skewed = skewed or p50 < expected
            text_ += (
                f"; по скользящим окнам — медиана {_num(p50)}, p10 {_num(p10)}, p90 {_num(p90)}"
            )
        out.append(text_ + ".")
    if report.forward.signals:
        fwd = report.forward
        out.append(f"- Форвард: сигналов {len(fwd.signals)}{_blocked_tail(fwd)}.")
    out.append("")
    if skewed:
        out += [
            "Медиана по окнам ниже среднего: сделки бэктеста идут неравномерно, сериями в "
            "отдельные месяцы.",
            "",
        ]
    return out


def _render_intervals(report: Report, a: Analysis) -> list[str]:
    o = report.options
    out = ["### Доверительный интервал среднего R", ""]
    if a.interval is None:
        return [*out, "У бэктеста нет закрытых сделок: интервал не определён.", ""]
    m = a.backtest
    level = _q(CONFIDENCE * 100, Decimal(1))
    out.append(
        f"Средний R бэктеста {_r(m.avg_r)}, закрытых сделок {m.closed}. {level} % бутстреп-"
        f"интервал (перцентильный, {_int(o.samples)} выборок с возвращением, зерно {o.seed}): "
        f"[{_r(a.interval.low)}; {_r(a.interval.high)}]."
    )
    out.append("")
    out.append(
        "С форвардом сравнивается не этот интервал, а пределы, в которых бывает средний R "
        "такого же числа сделок, взятых из сделок бэктеста: чем меньше сделок, тем шире пределы. "
        "Это и есть «в пределах доверительного интервала бэктеста» для форварда (план 2.9)."
    )
    out.append("")
    rows = []
    intervals = list(a.reference_intervals)
    if a.forward_interval is not None:
        intervals.append(a.forward_interval)
    for iv in sorted(intervals, key=lambda i: i.size):
        who = "столько закрытых сделок у форварда" if iv is a.forward_interval else ""
        rows.append((str(iv.size), f"[{_r(iv.low)}; {_r(iv.high)}]", who))
    out += [*_table(("Сделок", f"Пределы среднего R ({level} %)", ""), rows, "rl"), ""]
    if a.forward_closed_r:
        mean = sum(a.forward_closed_r, Decimal(0)) / len(a.forward_closed_r)
        out += [
            f"Средний R форварда по H4-пересчёту: {_r(mean)}, закрытых сделок "
            f"{len(a.forward_closed_r)}.",
            "",
        ]
    if a.needed is not None:
        days = Decimal((o.end - o.start).total_seconds()) / 86400
        rate = Decimal(len(report.backtest.trades)) / days if days > 0 else Decimal(0)
        months = (
            f", при темпе бэктеста это около {_num(Decimal(a.needed) / rate / Decimal('30.44'))} "
            "мес."
            if rate > 0
            else ""
        )
        out += [
            "Сколько закрытых сделок с таким же средним и разбросом, как в бэктесте, нужно, чтобы "
            "средний R > 0 был отличим от нуля (односторонний критерий 95 %, нормальное "
            f"приближение, (1.645 · σ / μ)²): {a.needed}{months}",
            "",
        ]
    return out


def _render_windows(report: Report, a: Analysis) -> list[str]:
    out = ["### Скользящие окна", ""]
    if not a.windows:
        return [*out, "Период бэктеста короче окна.", ""]
    lengths = "3 месяца и длины форварда" if len(a.windows) > 1 else "3 месяца"
    out.append(
        f"Окна длиной {lengths} по сделкам бэктеста, сдвиг {_days(WINDOW_STEP)}; сделка "
        "относится к окну по времени сигнала, сумма R — по закрытым сделкам."
    )
    out.append("")
    rows = []
    for s in a.windows:
        t10, t50, t90 = s.trades
        s10, s50, s90 = s.sum_r
        rows.append(
            (
                _days(s.length),
                _int(s.count),
                f"{_num(t10)} / {_num(t50)} / {_num(t90)}",
                _share(s.empty, s.count),
                f"{_r(s10)} / {_r(s50)} / {_r(s90)}",
                _share(s.negative, s.count),
            )
        )
    headers = (
        "Окно",
        "Окон",
        "Сделок: p10 / медиана / p90",
        "Без сделок",
        "Сумма R: p10 / медиана / p90",
        "В минусе",
    )
    out += [*_table(headers, rows, "lrrrrr"), ""]
    fwd = report.forward
    stats = a.forward_windows
    if fwd.counted and stats is not None:
        count = Decimal(len(fwd.counted))
        total = sum(a.forward_closed_r, Decimal(0))
        out += [
            f"Место форварда среди окон той же длины ({_days(stats.length)}): по числу сигналов "
            f"({len(fwd.counted)}) — перцентиль {_rate(percentile_rank(stats.trade_counts, count))}"
            f", по сумме R по H4-пересчёту ({_r(total)}) — перцентиль "
            f"{_rate(percentile_rank(stats.sums, total))}. Перцентиль 50 % — как у типичного окна "
            "бэктеста; близко к 0 % или 100 % — форвард необычен для бэктеста.",
            "",
        ]
    elif fwd.counted:
        out += ["Форвард короче суток или длиннее бэктеста: окон его длины нет.", ""]
    return out


def _render_differences(report: Report, a: Analysis) -> list[str]:
    fwd = report.forward
    bt = report.backtest
    rec = report.reconcile
    out = ["## Отличия форварда от бэктеста", ""]
    m1_h4 = ""
    both = [s for s in fwd.counted if s.m1 is not None and s.ref is not None]
    if both:
        same = sum(
            1
            for s in both
            if s.m1 is not None and s.ref is not None and s.m1.status == s.ref.status
        )
        m1_h4 = f" В этом форварде статус по 1m и H4 совпал у {same} из {len(both)} сигналов."
    if rec is not None and rec.error is None and rec.failed is None:
        m1_h4 += (
            f" Сверка {_when(rec.at)} UTC насчитала {rec.explained} отличий записи от эталона H4 "
            "из-за хода цены внутри свечи (не тревога, ADR-0014)."
        )
    missing = f" В этом прогоне без данных: {', '.join(bt.missing)}." if bt.missing else ""
    items = [
        "**Исполнение: H4 против 1m.** Бэктест исполняет сделку по свечам H4 и при касании стопа "
        "и цели в одной свече считает стоп. Форвард и live ведёт 1m-трекер: он видит порядок "
        "касаний внутри H4-свечи, поэтому результаты законно расходятся. С бэктестом сравнивается "
        f"H4-пересчёт форварда; 1m-результат показан рядом.{m1_h4}",
        "**Фильтр оборота работает только в форварде и live.** `forward.load_inputs` подаёт в "
        "движок средний дневной оборот инструмента (`instruments.avg_volume_30d` → "
        "`avg_daily_turnover`), бэктест — нет, и в бэктесте этот фильтр не срабатывает никогда "
        "(ADR-0013).",
        "**Окно старших таймфреймов.** Бэктест подаёт всю загруженную историю D1 и W1, live — "
        "последние 400 дневных и 120 недельных свечей (ADR-0013). На сигнал это может повлиять "
        "только через самую старую свечу окна.",
        "**Фильтры новостей, корреляции/BTC-bias, ликвидаций и разблокировок не получают данных "
        "нигде** — ни в бэктесте, ни в форварде. Между ними расхождения нет, с планом 2.5 есть: "
        "эти фильтры сигнал не блокируют и баллы не меняют.",
        "**Правило одной открытой сделки** (задача 6). В бэктесте оно было всегда, при записи "
        f"форвард-кандидата — только с {_date(ONE_TRADE_RULE_FROM)}. Форвард-сигналы, которые "
        "оно подавило бы, в метрики не входят" + _blocked_count(fwd) + ". Правило в живом "
        "режиме смотрит на сделку по 1m-трекеру, бэктест — по H4: если по 1m сделка закрылась "
        "раньше, следующий сигнал в живом режиме будет, а в бэктесте нет. Лимитный вход (п. 3 "
        "задачи 6): сейчас везде рыночный вход, и расхождения нет. При лимитном входе оно "
        "появится: бэктест заранее знает, что лимит истёк, и инструмент им не занят; живой "
        "режим этого не знает и считает ожидающий лимит открытой сделкой — в live будут "
        f"подавлены сигналы, которые бэктест взял бы (`{ONE_TRADE_DOC}`).",
        "**Вход по цене закрытия сигнальной свечи** — и в бэктесте, и в форварде. Задержка "
        "публикации (десятки секунд после закрытия H4) и цена, по которой пользователь входит на "
        "самом деле, в результате не учитываются.",
        "**Делистинги.** Бэктест идёт только по инструментам, которые есть в базе сейчас: пары, "
        "снятые с торгов, в историю не попадают (план 2.11 требует их учитывать — риск "
        "переоценки). Из списка 60 пар прогона №9 снят с торгов только EOSUSDT; в базе production "
        f"его нет.{missing}",
        "**Версия выбрана после просмотра результатов.** Параметры 1.1 подобраны walk-forward на "
        "2022–2024; 1.2 — это 1.1 без лонгов, решение принято по результатам 2022–2026 целиком "
        "(прогоны №4 и №5, `docs/backtests/2026-10-25-longs.md`); 1.2.1 — 1.2 на 20 парах MVP, "
        "решение принято после прогона №9, где остальные 39 пар дали около нуля. Поэтому бэктест "
        "этих версий — не проверка на новых данных, часть преимущества может быть подгонкой. "
        "Форвард — первая проверка на данных, которых при выборе не видели.",
    ]
    out += [f"{i}. {item}" for i, item in enumerate(items, 1)]
    out.append("")
    return out


def _blocked_count(fwd: Forward) -> str:
    n = len(fwd.blocked)
    return f" (в этом форварде — {n})" if n else " (в этом форварде таких нет)"


def _dec(x: Decimal | None, quant: Decimal = R_QUANT) -> str | None:
    return None if x is None else str(_q(x, quant))


def summary_json(report: Report, analysis: Analysis | None = None) -> dict[str, Any]:
    """Короткая сводка отчёта для админки: параметры, итог форварда и бэктеста, критерии.
    Числа — строками (``Decimal``); времена — ISO 8601 в UTC."""
    a = analysis or analyze(report)
    o = report.options
    fwd = report.forward
    m = a.backtest

    def iso(t: datetime | None) -> str | None:
        return None if t is None else t.isoformat()

    return {
        "version": o.version,
        "symbols_label": o.symbols_label,
        "symbols": list(o.symbols),
        "backtest_from": iso(o.start),
        "backtest_to": iso(o.end),
        "now": iso(o.now),
        "forward": {
            "version": fwd.label,
            "in_db": fwd.in_db,
            "status": fwd.status,
            "since": iso(fwd.since),
            "end": iso(fwd.end),
            "days": None
            if fwd.period is None
            else _dec(Decimal(fwd.period.total_seconds()) / 86400, SHARE_QUANT),
            "signals": len(fwd.signals),
            "counted": len(fwd.counted),
            "closed_h4": a.forward_h4.closed,
            "avg_r_h4": _dec(a.forward_h4.avg_r),
            "closed_1m": a.forward_m1.closed,
            "avg_r_1m": _dec(a.forward_m1.avg_r),
        },
        "backtest": {
            "closed": m.closed,
            "winrate": _dec(m.winrate, Decimal("0.001")),
            "avg_r": _dec(m.avg_r),
            "profit_factor": _dec(m.profit_factor, PF_QUANT),
            "sum_r": _dec(m.sum_r) if m.closed else None,
            "max_drawdown_r": _dec(m.max_drawdown_r) if m.closed else None,
        },
        "criteria": [
            {"name": c.name, "source": c.source, "value": c.value, "status": c.status.value}
            for c in a.criteria
        ],
        "counts": {s.name.lower(): sum(1 for c in a.criteria if c.status is s) for s in Status},
    }


def write_report(text_: str, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text_.encode("utf-8"))
    return path
