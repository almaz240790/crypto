"""Отчёт пересчёта форвард-сигналов исправленным трекером (задача 7 пакета «Сигналы»).

По каждому записанному форвард-сигналу показывает «было» (что записано в БД) и «стало»
(исправленный 1m-трекер с комиссиями), рядом — H4-эталон бэктеста, пометку пересечения с
открытой сделкой и пропуски минутных свечей. Сами расчёты — в ``app.retrack``; здесь только
сборка отчёта и его вывод: CSV, Markdown и PNG по каждому сигналу (``app.debug.render_png``).

В БД отчёт ничего не пишет: ``run_report`` читает данные в транзакции только на чтение
(``app.retrack.read_only_connection``), а файлы пишет уже после неё.

Отчёт детерминирован: одинаковые данные и одинаковые аргументы (включая ``now``) дают
одинаковые файлы байт в байт. В файлах нет времени запуска — только переданный ``now``; порядок
строк стабильный; имена файлов постоянные, имя PNG складывается из инструмента, времени
сигнальной свечи, версии и ``public_id``.

Как показана незакрытая сделка — см. ``app.retrack`` и примечание в самом отчёте: открытый
статус, без R и длительности, в суммы и средние не входит.

Числа отчёта — результаты на прошлых данных; отчёт проверяет учёт сделок, а не доходность.
"""

from __future__ import annotations

import csv
import io
import re
from bisect import bisect_left
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from sqlalchemy import Connection, Engine

from app.analysis import params_for_version
from app.debug import ACCENT, CONTEXT, DOWN, UP, render_png
from app.retrack import (
    DEFAULT_MAX_GAP_MINUTES,
    MINUTE,
    Completeness,
    H4Retrack,
    MinuteRetrack,
    Outcome,
    Overlap,
    SignalRow,
    TradeSpan,
    iter_candles,
    load_candles,
    load_forward_signals,
    load_version_labels,
    open_trade_overlap,
    read_only_connection,
    retrack_h4,
    retrack_minutes,
    version_known,
)
from engine.backtest import DEFAULT_EXECUTION
from engine.candles import SIGNAL_TIMEFRAME, Candle
from engine.structure import analyze_structure
from engine.tracker import interval_start
from engine.zones import analyze_zones

REPORT_MD = "retrack_report.md"
REPORT_CSV = "retrack_report.csv"
CHART_DIR = "signals"

R_QUANT = Decimal("0.001")
HOURS_QUANT = Decimal("0.01")
"""Точность столбцов ``signal_results`` (``Numeric(8, 3)`` и ``Numeric(10, 2)``): пересчитанные
числа показываются так, как легли бы в БД, и сравниваются с записанными в одной точности."""

CHART_BEFORE = 40
"""Свечей H4 до сигнальной в окне графика."""
CHART_AFTER = 4
"""Свечей H4 после последнего выхода."""
CHART_MAX_AFTER = 120
"""Предел окна после сигнала для сделки, которая ещё открыта (20 суток)."""
GAPS_LISTED = 10
"""Сколько пропусков одного сигнала перечисляется в Markdown; полный список — в CSV."""

DASH = "—"
NOT_RETRACKED = "не пересчитан"
NOT_COMPUTED = "не посчитан"
CLOSED_STATUSES = ("closed_time", "closed_sl", "closed_be", "closed_tp3")
STATUS_LABEL = {
    "pending": "ожидает входа",
    "active": "открыта",
    "tp1_hit": "открыта, TP1 взят",
    "tp2_hit": "открыта, TP2 взят",
    "closed_time": "по времени",
    "closed_sl": "стоп",
    "closed_be": "безубыток после TP1",
    "closed_tp3": "TP3",
    "expired": "лимит истёк",
    "cancelled": "отменён",
}
OVERLAP_LABEL = {True: "да", False: "нет", None: "нет данных"}

NOTE_UNKNOWN_VERSION = (
    "версии нет в engine.strategies: параметры сделки взяты от 1.0.0, как у трекера"
)
NOTE_CANCELLED = "сигнал отменён вручную: пересчёт справочный"
NOTE_NO_CHART = "нет H4-свечей для графика"


# --- параметры и строки отчёта -----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ReportOptions:
    since: datetime
    """Сигналы с закрытием сигнальной свечи не раньше этого момента (UTC)."""
    now: datetime
    """Момент отчёта (UTC): свечи и сигналы позже него не читаются."""
    versions: tuple[str, ...] = ()
    """Фильтр версий: ``1.0.0`` или ``стратегия@1.0.0``; пусто — все."""
    max_gap_minutes: int = DEFAULT_MAX_GAP_MINUTES
    charts: bool = True

    def __post_init__(self) -> None:
        for name, t in (("since", self.since), ("now", self.now)):
            if t.tzinfo is None or t.utcoffset() != timedelta(0):
                raise ValueError(f"{name} должен быть timezone-aware в UTC")
        if self.max_gap_minutes < 0:
            raise ValueError("max_gap_minutes не может быть отрицательным")


def _quantized(x: Decimal | None, quant: Decimal) -> Decimal | None:
    """Округление как в PostgreSQL ``numeric`` (половина — от нуля), без «минус нуля»."""
    if x is None:
        return None
    q = x.quantize(quant, rounding=ROUND_HALF_UP)
    return abs(q) if q == 0 else q


def as_stored(outcome: Outcome) -> Outcome:
    """Итог в точности ``signal_results``: R — до 0.001, длительность — до 0.01 ч."""
    return replace(
        outcome,
        realized_r=_quantized(outcome.realized_r, R_QUANT),
        cost_r=_quantized(outcome.cost_r, R_QUANT),
        duration_hours=_quantized(outcome.duration_hours, HOURS_QUANT),
    )


def chart_name(signal: SignalRow) -> str:
    """Имя PNG сигнала: инструмент, время сигнальной свечи, версия, ``public_id``."""
    raw = (
        f"{signal.symbol}-{signal.candle_close_time:%Y%m%dT%H%M}-"
        f"{signal.version}-{signal.public_id}"
    )
    return re.sub(r"[^A-Za-z0-9._-]", "_", raw) + ".png"


@dataclass(frozen=True, slots=True)
class SignalReport:
    """Строка отчёта по одному сигналу."""

    signal: SignalRow
    minutes: MinuteRetrack
    h4: H4Retrack
    overlap: Overlap
    notes: tuple[str, ...] = ()
    chart: bytes | None = None

    @property
    def was(self) -> Outcome:
        """«Было»: записанный итог."""
        return self.signal.recorded

    @property
    def new(self) -> Outcome | None:
        """«Стало»: 1m-трекер, в точности ``signal_results``. ``None`` — не пересчитан."""
        return None if self.minutes.outcome is None else as_stored(self.minutes.outcome)

    @property
    def ref(self) -> Outcome | None:
        """H4-эталон в точности ``signal_results``. ``None`` — не посчитан."""
        return None if self.h4.outcome is None else as_stored(self.h4.outcome)

    @property
    def delta_r(self) -> Decimal | None:
        """«Стало» − «было» по R, если оба результата есть."""
        new = self.new
        if new is None or new.realized_r is None or self.was.realized_r is None:
            return None
        return new.realized_r - self.was.realized_r

    @property
    def minutes_minus_h4_r(self) -> Decimal | None:
        new, ref = self.new, self.ref
        if new is None or ref is None or new.realized_r is None or ref.realized_r is None:
            return None
        return new.realized_r - ref.realized_r

    @property
    def same_status(self) -> bool | None:
        """Совпал ли статус по 1m и по H4; ``None`` — один из расчётов не получен."""
        new, ref = self.new, self.ref
        return None if new is None or ref is None else new.status == ref.status

    @property
    def chart_file(self) -> str | None:
        return None if self.chart is None else f"{CHART_DIR}/{chart_name(self.signal)}"


@dataclass(frozen=True, slots=True)
class Report:
    options: ReportOptions
    signals: tuple[SignalReport, ...]


# --- сборка ------------------------------------------------------------------------------------


class UnknownVersionError(ValueError):
    """В фильтре версий указана версия, которой нет в БД (опечатка в аргументе)."""


def _check_versions(conn: Connection, versions: Sequence[str]) -> None:
    if not versions:
        return
    known = load_version_labels(conn)
    accepted = {v for _, v in known} | {f"{s}@{v}" for s, v in known}
    unknown = [v for v in versions if v not in accepted]
    if unknown:
        have = ", ".join(f"{s}@{v}" for s, v in known) or "нет ни одной"
        raise UnknownVersionError(f"версии нет в БД: {', '.join(unknown)}; есть: {have}")


def trade_span(signal: SignalRow, minutes: MinuteRetrack, h4: H4Retrack) -> TradeSpan:
    """Жизнь сделки для пометки пересечения: по 1m, а если сигнал не пересчитан — по H4."""
    outcome = minutes.outcome or h4.outcome
    if outcome is None:
        return TradeSpan(signal.public_id, signal.candle_close_time, None, known=False)
    return TradeSpan(signal.public_id, signal.candle_close_time, outcome.closed_at)


def overlap_flags(
    parts: Sequence[tuple[SignalRow, MinuteRetrack, H4Retrack]],
) -> list[Overlap]:
    """Пометка пересечения для каждого сигнала отчёта (правило задачи 6, только чтение).

    Сравниваются сигналы одной версии по одному инструменту — и только сигналы самого отчёта:
    сделки сигналов до ``since`` не учитываются.
    """
    spans: dict[tuple[int, int], list[TradeSpan]] = {}
    for signal, minutes, h4 in parts:
        key = (signal.strategy_version_id, signal.instrument_id)
        spans.setdefault(key, []).append(trade_span(signal, minutes, h4))
    return [
        open_trade_overlap(
            (
                s
                for s in spans[(signal.strategy_version_id, signal.instrument_id)]
                if s.public_id != signal.public_id
            ),
            signal.candle_close_time,
        )
        for signal, _, _ in parts
    ]


def _notes(signal: SignalRow) -> list[str]:
    notes = []
    if not version_known(signal.version):
        notes.append(NOTE_UNKNOWN_VERSION)
    if signal.recorded.status == "cancelled":
        notes.append(NOTE_CANCELLED)
    return notes


def build_report(conn: Connection, options: ReportOptions) -> Report:
    """Читает форвард-сигналы и свечи и пересчитывает каждый сигнал. Только ``SELECT``."""
    _check_versions(conn, options.versions)
    now = options.now
    tf = SIGNAL_TIMEFRAME
    parts: list[tuple[SignalRow, MinuteRetrack, H4Retrack]] = []
    context: list[list[Candle]] = []
    for signal in load_forward_signals(conn, options.since, now, options.versions):
        start = signal.candle_close_time
        minutes = retrack_minutes(
            signal,
            iter_candles(conn, signal.instrument_id, MINUTE, start, now),
            now,
            options.max_gap_minutes,
        )
        try:
            chart_from = start - tf.delta * (CHART_BEFORE + CONTEXT + 1)
            h4_candles = load_candles(conn, signal.instrument_id, tf, chart_from, now)
            h4 = retrack_h4(signal, h4_candles, now)
        except (ValueError, ArithmeticError) as exc:
            h4_candles = []
            h4 = H4Retrack(None, None, f"ошибка данных H4: {exc}")
        parts.append((signal, minutes, h4))
        context.append(h4_candles)
    out: list[SignalReport] = []
    for (signal, minutes, h4), overlap, h4_candles in zip(
        parts, overlap_flags(parts), context, strict=True
    ):
        row = SignalReport(signal, minutes, h4, overlap)
        notes = _notes(signal)
        chart = render_chart(row, h4_candles) if options.charts else None
        if options.charts and chart is None:
            notes.append(NOTE_NO_CHART)
        out.append(replace(row, notes=tuple(notes), chart=chart))
    return Report(options, tuple(out))


# --- график сигнала ----------------------------------------------------------------------------


def _brief(outcome: Outcome | None, missing: str) -> str:
    """Итог одной строкой для заголовка графика."""
    if outcome is None:
        return missing
    label = STATUS_LABEL.get(outcome.status, outcome.status)
    if outcome.realized_r is None:
        return label
    return f"{label} {_r(outcome.realized_r)}R {_hours(outcome.duration_hours)}ч"


def render_chart(row: SignalReport, h4: Sequence[Candle]) -> bytes | None:
    """PNG сигнала на H4: уровни входа, стопа и тейков, события пересчёта по 1m (точки) и
    свеча выхода. ``h4`` — сохранённые свечи с запасом слева для структуры и зон; ``None`` —
    свечей в окне графика нет."""
    signal, tf = row.signal, SIGNAL_TIMEFRAME
    close = signal.candle_close_time
    params = params_for_version(signal.version)
    new, ref = row.new, row.ref
    ends = [close + tf.delta * params.trade.time_stop_candles]
    ends += [o.closed_at for o in (row.was, new, ref) if o is not None and o.closed_at is not None]
    still_open = any(o is not None and o.is_open for o in (new, ref))
    limit = close + tf.delta * CHART_MAX_AFTER
    end = limit if still_open else min(limit, max(ends) + tf.delta * CHART_AFTER)
    candles = [c for c in h4 if c.open_time < end]
    times = [c.open_time for c in candles]
    window = len(candles) - bisect_left(times, close - tf.delta * (CHART_BEFORE + 1))
    if window < 1:
        return None
    index = {t: i for i, t in enumerate(times)}

    def bar_of(moment: datetime) -> int | None:
        """Свеча H4, внутри которой (или закрытием которой) наступил момент."""
        return index.get(interval_start(moment - MINUTE.delta, tf))

    last = len(candles) - 1
    first = min(max(bisect_left(times, close) - 1, 0), last)
    levels = (
        (signal.entry_market, ACCENT, "-"),
        (signal.stop_loss, DOWN, "--"),
        (signal.tp1, UP, ":"),
        (signal.tp2, UP, ":"),
        (signal.tp3, UP, ":"),
    )
    segments = [(first, float(p), last, float(p), color, style) for p, color, style in levels]
    dots = [
        (i, float(e.price))
        for e in row.minutes.events
        if e.price is not None and (i := bar_of(e.at)) is not None
    ]
    marks: list[tuple[int, int, Decimal, str, str | None]] = []
    signal_bar = index.get(close - tf.delta)
    if signal_bar is not None:
        direction = "up" if signal.direction == "long" else "down"
        marks.append(
            (signal_bar, signal_bar, signal.entry_market, f"сигнал {signal.direction}", direction)
        )
    exits = [e for e in row.minutes.events if e.type in ("tp3", "be", "sl", "time_stop")]
    if new is not None and new.realized_r is not None and exits and exits[-1].price is not None:
        exit_bar = bar_of(exits[-1].at)
        if exit_bar is not None:
            label = f"выход 1m: {STATUS_LABEL.get(new.status, new.status)}"
            marks.append(
                (exit_bar, exit_bar, exits[-1].price, label, "up" if new.realized_r > 0 else "down")
            )
    title = (
        f"{signal.symbol} {signal.version_label} {signal.direction} {signal.grade}  "
        f"сигнал {close:%d.%m.%Y %H:%M} UTC  было: {_brief(row.was, DASH)}  "
        f"стало 1m: {_brief(new, NOT_RETRACKED)}  H4: {_brief(ref, NOT_COMPUTED)}"
    )
    structure = analyze_structure(candles, params.structure)
    zones = analyze_zones(candles, structure, params.zones)
    return render_png(
        candles, structure, zones, window, title, marks=marks, segments=segments, dots=dots
    )


# --- итоги -------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Tally:
    """Итог одного расчёта (было / стало по 1m / H4) по сигналам версии."""

    signals: int
    not_computed: int
    open: int
    closed: int
    by_status: tuple[int, ...]
    """Закрытые сделки по статусам, в порядке ``CLOSED_STATUSES``."""
    other: int
    """Ни открыта, ни закрыта: лимит истёк или сигнал отменён."""
    tp1: int
    """Сделок, достигших TP1."""
    with_result: int
    sum_r: Decimal
    avg_r: Decimal | None
    avg_hours: Decimal | None


def tally(outcomes: Sequence[Outcome | None]) -> Tally:
    """Сводит итоги; ``None`` — расчёт по сигналу не получен. В сумму и среднее R входят только
    сделки с результатом, то есть закрытые: открытые сделки результата не имеют."""
    got = [o for o in outcomes if o is not None]
    rs = [o.realized_r for o in got if o.realized_r is not None]
    hours = [o.duration_hours for o in got if o.duration_hours is not None]
    opened = sum(1 for o in got if o.is_open)
    closed = sum(1 for o in got if o.is_closed)
    total = sum(rs, Decimal(0))
    return Tally(
        signals=len(outcomes),
        not_computed=len(outcomes) - len(got),
        open=opened,
        closed=closed,
        by_status=tuple(sum(1 for o in got if o.status == s) for s in CLOSED_STATUSES),
        other=len(got) - opened - closed,
        tp1=sum(1 for o in got if o.tp_hits >= 1),
        with_result=len(rs),
        sum_r=total,
        avg_r=_quantized(total / len(rs), R_QUANT) if rs else None,
        avg_hours=_quantized(sum(hours, Decimal(0)) / len(hours), HOURS_QUANT) if hours else None,
    )


@dataclass(frozen=True, slots=True)
class VersionTotals:
    label: str
    was: Tally
    new: Tally
    ref: Tally
    compared: int
    """Сигналов, посчитанных и по 1m, и по H4."""
    same_status: int
    both_closed: int
    sum_r_minutes: Decimal
    """Сумма R по 1m — только по сделкам, закрытым в обоих расчётах."""
    sum_r_h4: Decimal
    overlaps: int
    overlaps_unknown: int
    without_costs: int
    """Записанных результатов без комиссий (``signal_results.cost_r`` пуст)."""


def version_totals(label: str, rows: Sequence[SignalReport]) -> VersionTotals:
    both = [
        (r.new, r.ref)
        for r in rows
        if r.new is not None
        and r.ref is not None
        and r.new.realized_r is not None
        and r.ref.realized_r is not None
    ]
    return VersionTotals(
        label=label,
        was=tally([r.was for r in rows]),
        new=tally([r.new for r in rows]),
        ref=tally([r.ref for r in rows]),
        compared=sum(1 for r in rows if r.same_status is not None),
        same_status=sum(1 for r in rows if r.same_status),
        both_closed=len(both),
        sum_r_minutes=sum((n.realized_r or Decimal(0) for n, _ in both), Decimal(0)),
        sum_r_h4=sum((h.realized_r or Decimal(0) for _, h in both), Decimal(0)),
        overlaps=sum(1 for r in rows if r.overlap.flag),
        overlaps_unknown=sum(1 for r in rows if r.overlap.flag is None),
        without_costs=sum(1 for r in rows if r.was.realized_r is not None and r.was.cost_r is None),
    )


def totals(report: Report) -> list[VersionTotals]:
    """Итоги по версиям, в порядке строк отчёта. Версии не складываются между собой."""
    groups: dict[str, list[SignalReport]] = {}
    for row in report.signals:
        groups.setdefault(row.signal.version_label, []).append(row)
    return [version_totals(label, rows) for label, rows in groups.items()]


# --- форматирование ----------------------------------------------------------------------------


def _r(x: Decimal | None) -> str:
    """R со знаком, три знака; нет значения — прочерк."""
    q = _quantized(x, R_QUANT)
    if q is None:
        return DASH
    return "0.000" if q == 0 else format(q, "+f")


def _hours(x: Decimal | None) -> str:
    q = _quantized(x, HOURS_QUANT)
    return DASH if q is None else format(q, "f")


def _when(t: datetime | None) -> str:
    return DASH if t is None else f"{t:%d.%m.%Y %H:%M}"


def _iso(t: datetime | None) -> str:
    return "" if t is None else f"{t:%Y-%m-%dT%H:%M:%SZ}"


def _num(x: Decimal | None, quant: Decimal) -> str:
    q = _quantized(x, quant)
    return "" if q is None else format(q, "f")


def _percent(rate: Decimal) -> str:
    return format((rate * 100).normalize(), "f")


def _status(outcome: Outcome | None, missing: str) -> str:
    return missing if outcome is None else STATUS_LABEL.get(outcome.status, outcome.status)


def _gap_text(completeness: Completeness, limit: int | None = None) -> str:
    step = MINUTE.delta
    gaps = completeness.gaps if limit is None else completeness.gaps[:limit]
    parts = [
        f"{g.start:%d.%m %H:%M}–{g.start + step * g.candles:%H:%M} ({g.candles})" for g in gaps
    ]
    rest = len(completeness.gaps) - len(gaps)
    if rest > 0:
        parts.append(f"и ещё {rest}")
    return ", ".join(parts)


def _version_names(report: Report) -> dict[str, str]:
    """Как версия подписана в таблицах: коротко (``1.0.0``), пока стратегия в отчёте одна."""
    strategies = {r.signal.strategy for r in report.signals}
    return {
        r.signal.version_label: r.signal.version if len(strategies) == 1 else r.signal.version_label
        for r in report.signals
    }


# --- CSV ---------------------------------------------------------------------------------------

CSV_COLUMNS = (
    "strategy",
    "version",
    "symbol",
    "public_id",
    "direction",
    "grade",
    "score",
    "signal_candle_close_utc",
    "old_status",
    "old_tp_hits",
    "old_r",
    "old_cost_r",
    "old_closed_at_utc",
    "old_duration_h",
    "m1_result",
    "m1_status",
    "m1_tp_hits",
    "m1_r",
    "m1_cost_r",
    "m1_closed_at_utc",
    "m1_duration_h",
    "m1_tracked_until_utc",
    "m1_reason",
    "delta_r_m1_minus_old",
    "h4_result",
    "h4_status",
    "h4_tp_hits",
    "h4_r",
    "h4_cost_r",
    "h4_closed_at_utc",
    "h4_duration_h",
    "h4_tracked_until_utc",
    "h4_reason",
    "m1_minus_h4_r",
    "m1_h4_same_status",
    "overlaps_open_trade",
    "overlaps_with_public_id",
    "m1_expected_candles",
    "m1_missing_candles",
    "m1_longest_gap",
    "m1_gaps",
    "chart",
    "notes",
)


def _outcome_cells(outcome: Outcome | None) -> list[str]:
    """Статус, тейки, R, комиссия, время закрытия, длительность — пусто, если итога нет."""
    if outcome is None:
        return [""] * 6
    return [
        outcome.status,
        str(outcome.tp_hits),
        _num(outcome.realized_r, R_QUANT),
        _num(outcome.cost_r, R_QUANT),
        _iso(outcome.closed_at),
        _num(outcome.duration_hours, HOURS_QUANT),
    ]


def _yes_no(flag: bool | None) -> str:
    return "" if flag is None else ("да" if flag else "нет")


def render_csv(report: Report) -> str:
    """CSV: одна строка на сигнал, порядок строк как в отчёте. Статусы — как в БД."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for row in report.signals:
        s, new, ref, done = row.signal, row.new, row.ref, row.minutes.completeness
        gaps = ";".join(f"{_iso(g.start)}+{g.candles}" for g in done.gaps)
        writer.writerow(
            [
                s.strategy,
                s.version,
                s.symbol,
                s.public_id,
                s.direction,
                s.grade,
                s.score,
                _iso(s.candle_close_time),
                *_outcome_cells(row.was),
                "пересчитан" if new is not None else NOT_RETRACKED,
                *_outcome_cells(new),
                _iso(row.minutes.tracked_until),
                row.minutes.reason or "",
                _num(row.delta_r, R_QUANT),
                "посчитан" if ref is not None else NOT_COMPUTED,
                *_outcome_cells(ref),
                _iso(row.h4.tracked_until),
                row.h4.reason or "",
                _num(row.minutes_minus_h4_r, R_QUANT),
                _yes_no(row.same_status),
                OVERLAP_LABEL[row.overlap.flag],
                row.overlap.with_public_id or "",
                done.expected,
                done.missing,
                done.longest,
                gaps,
                row.chart_file or "",
                "; ".join(row.notes),
            ]
        )
    return buf.getvalue()


# --- Markdown ----------------------------------------------------------------------------------


def _table(headers: Sequence[str], rows: Sequence[Sequence[str]], right: str = "") -> list[str]:
    """Таблица Markdown; ``right`` — строка из «r» и «l» по столбцам (по умолчанию все «l»)."""
    align = right.ljust(len(headers), "l")

    def line(cells: Sequence[str]) -> str:
        return "| " + " | ".join(str(c).replace("|", "\\|") for c in cells) + " |"

    return [
        line(headers),
        "|" + "|".join("---:" if a == "r" else "---" for a in align) + "|",
        *(line(r) for r in rows),
    ]


def _totals_table(t: VersionTotals) -> list[str]:
    columns = (t.was, t.new, t.ref)

    def row(name: str, *cells: str) -> list[str]:
        return [name, *cells]

    rows = [
        row("Сигналов", *(str(c.signals) for c in columns)),
        row("Не пересчитано", DASH, str(t.new.not_computed), str(t.ref.not_computed)),
        row("Открыто", *(str(c.open) for c in columns)),
        row("Закрыто", *(str(c.closed) for c in columns)),
        *(
            row(f"— {STATUS_LABEL[status]}", *(str(c.by_status[i]) for c in columns))
            for i, status in enumerate(CLOSED_STATUSES)
        ),
    ]
    if any(c.other for c in columns):
        rows.append(row("Лимит истёк или сигнал отменён", *(str(c.other) for c in columns)))
    rows += [
        row("Достигли TP1", *(str(c.tp1) for c in columns)),
        row("Сумма R по закрытым", *(_r(c.sum_r) for c in columns)),
        row("Средний R", *(_r(c.avg_r) for c in columns)),
        row("Средняя длительность, ч", *(_hours(c.avg_hours) for c in columns)),
    ]
    return _table(
        ("Показатель", "Было (записано)", "Стало (1m-трекер)", "H4-эталон (как бэктест)"),
        rows,
        right="lrrr",
    )


def _signal_cell(row: SignalReport) -> str:
    return f"`{row.signal.public_id}` {row.signal.direction} {row.signal.grade}"


def _overlap_cell(overlap: Overlap) -> str:
    if overlap.flag and overlap.with_public_id:
        return f"да (с `{overlap.with_public_id}`)"
    return OVERLAP_LABEL[overlap.flag]


def render_markdown(report: Report) -> str:
    """Markdown для владельца: шапка, итоги по версиям, «было / стало», сравнение 1m и H4,
    пропуски и примечания."""
    o = report.options
    rows = report.signals
    names = _version_names(report)
    fee, slippage = _percent(DEFAULT_EXECUTION.fee_rate), _percent(DEFAULT_EXECUTION.slippage)
    retracked = [r for r in rows if r.new is not None]
    by_gaps = [r for r in rows if r.minutes.gap_exceeded]
    by_error = [r for r in rows if r.new is None and not r.minutes.gap_exceeded]
    compared = [r for r in rows if r.same_status is not None]
    without_costs = sum(1 for r in rows if r.was.realized_r is not None and r.was.cost_r is None)
    out: list[str] = [
        "# Пересчёт форвард-сигналов исправленным трекером",
        "",
        "Отчёт только для чтения: в базу данных ничего не записано. Числа — результаты на прошлых "
        "данных; это проверка учёта сделок, а не оценка доходности.",
        "",
        f"- Сигналы: область forward, сигнальная свеча закрыта с {_when(o.since)} по "
        f"{_when(o.now)} UTC; версии: {', '.join(o.versions) if o.versions else 'все'}.",
        f"- Момент отчёта (now): {_when(o.now)} UTC. Сделка, не закрытая к этому моменту, "
        "показана как открытая.",
        f"- Допустимый пропуск 1m-свечей: {o.max_gap_minutes} мин подряд; при большем сигнал "
        f"помечен «{NOT_RETRACKED}».",
        f"- В столбцах «стало (1m)» и «H4-эталон» вычтены комиссия {fee} % за сторону и "
        f"проскальзывание {slippage} % — как в бэктесте. «Было» — как записано в БД.",
        "",
        "## Коротко",
        "",
        f"- Сигналов: {len(rows)}.",
        f"- Пересчитано по 1m: {len(retracked)} (закрыто "
        f"{sum(1 for r in retracked if r.new is not None and r.new.is_closed)}, открыто "
        f"{sum(1 for r in retracked if r.new is not None and r.new.is_open)}).",
        f"- Не пересчитано из-за пропусков 1m-свечей: {len(by_gaps)}.",
    ]
    if by_error:
        out.append(f"- Не пересчитано из-за ошибки данных: {len(by_error)}.")
    out += [
        f"- H4-эталон посчитан: {sum(1 for r in rows if r.ref is not None)} из {len(rows)}.",
        f"- Статус по 1m и по H4 совпал: {sum(1 for r in compared if r.same_status)} из "
        f"{len(compared)} (сравниваются сигналы, посчитанные обоими способами).",
        "- Пересекаются с открытой сделкой той же версии по инструменту: "
        f"{sum(1 for r in rows if r.overlap.flag)}"
        + (
            f"; нет данных: {sum(1 for r in rows if r.overlap.flag is None)}."
            if any(r.overlap.flag is None for r in rows)
            else "."
        ),
        f"- Записанных результатов без комиссий (до их учёта в трекере): {without_costs}.",
        "",
        "## Итоги по версиям",
        "",
    ]
    if not rows:
        out += ["Сигналов за период нет.", ""]
    for t in totals(report):
        out += [
            f"### {t.label} — сигналов: {t.was.signals}",
            "",
            *_totals_table(t),
            "",
            f"Сравнение 1m и H4: статус совпал у {t.same_status} из {t.compared} сигналов, "
            f"посчитанных обоими способами. По сделкам, закрытым в обоих расчётах "
            f"({t.both_closed}): сумма R по 1m {_r(t.sum_r_minutes)}, по H4 {_r(t.sum_r_h4)}, "
            f"разница {_r(t.sum_r_minutes - t.sum_r_h4)}.",
            "",
            f"Пересекаются с открытой сделкой: {t.overlaps}"
            + (f" (нет данных: {t.overlaps_unknown})" if t.overlaps_unknown else "")
            + f". Не пересчитано по 1m: {t.new.not_computed} из {t.new.signals}.",
            "",
        ]
    if rows:
        head = [
            (names[r.signal.version_label], r.signal.symbol, _when(r.signal.candle_close_time))
            for r in rows
        ]
        out += [
            "## Было / стало",
            "",
            *_table(
                (
                    "Версия",
                    "Инструмент",
                    "Сигнальная свеча, UTC",
                    "Сигнал",
                    "Было: статус",
                    "Было: R",
                    "Было: ч",
                    "Стало (1m): статус",
                    "Стало: R",
                    "Стало: ч",
                    "ΔR",
                ),
                [
                    [
                        *h,
                        _signal_cell(r),
                        _status(r.was, DASH),
                        _r(r.was.realized_r),
                        _hours(r.was.duration_hours),
                        _status(r.new, NOT_RETRACKED),
                        _r(r.new.realized_r if r.new else None),
                        _hours(r.new.duration_hours if r.new else None),
                        _r(r.delta_r),
                    ]
                    for h, r in zip(head, rows, strict=True)
                ],
                right="lllllrrlrrr",
            ),
            "",
            "## 1m-трекер и H4-эталон",
            "",
            *_table(
                (
                    "Версия",
                    "Инструмент",
                    "Сигнальная свеча, UTC",
                    "Сигнал",
                    "1m: статус",
                    "1m: R",
                    "1m: ч",
                    "H4: статус",
                    "H4: R",
                    "H4: ч",
                    "1m − H4, R",
                    "Статус совпал",
                    "Пересечение",
                    "Нет 1m-свечей, мин",
                    "График",
                ),
                [
                    [
                        *h,
                        _signal_cell(r),
                        _status(r.new, NOT_RETRACKED),
                        _r(r.new.realized_r if r.new else None),
                        _hours(r.new.duration_hours if r.new else None),
                        _status(r.ref, NOT_COMPUTED),
                        _r(r.ref.realized_r if r.ref else None),
                        _hours(r.ref.duration_hours if r.ref else None),
                        _r(r.minutes_minus_h4_r),
                        _yes_no(r.same_status) or DASH,
                        _overlap_cell(r.overlap),
                        str(r.minutes.completeness.missing),
                        f"[PNG]({r.chart_file})" if r.chart_file else DASH,
                    ]
                    for h, r in zip(head, rows, strict=True)
                ],
                right="lllllrrlrrrllrl",
            ),
            "",
        ]
    not_done = [r for r in rows if r.new is None or r.ref is None]
    if not_done:
        out += ["## Не пересчитаны", ""]
        for r in not_done:
            who = f"{r.signal.symbol} {_when(r.signal.candle_close_time)} (`{r.signal.public_id}`)"
            if r.new is None:
                out.append(f"- {who}, 1m: {r.minutes.reason}.")
            if r.ref is None:
                out.append(f"- {who}, H4: {r.h4.reason}.")
        out.append("")
    with_gaps = [r for r in rows if r.minutes.completeness.gaps]
    if with_gaps:
        out += [
            "## Пропуски 1m-свечей",
            "",
            "Проверяется отрезок от закрытия сигнальной свечи до закрытия пересчитанной сделки, а "
            "если сделка не закрылась или сигнал не пересчитан — до момента отчёта. В скобках — "
            "длина пропуска в минутах.",
            "",
        ]
        for r in with_gaps:
            done = r.minutes.completeness
            out.append(
                f"- {r.signal.symbol} {_when(r.signal.candle_close_time)} "
                f"(`{r.signal.public_id}`): нет {done.missing} мин из {done.expected}, самый "
                f"длинный пропуск {done.longest} мин: {_gap_text(done, GAPS_LISTED)}."
            )
        out.append("")
    noted = [r for r in rows if r.notes]
    if noted:
        out += ["## Замечания по сигналам", ""]
        out += [
            f"- {r.signal.symbol} {_when(r.signal.candle_close_time)} (`{r.signal.public_id}`): "
            f"{'; '.join(r.notes)}."
            for r in noted
        ]
        out.append("")
    out += [
        "## Как читать отчёт",
        "",
        "1. **Было** — то, что записано в БД сейчас: статус сигнала и строка `signal_results`. "
        "До исправления трекера сделка закрывалась через 15 минут вместо 60 часов. Результат, "
        "записанный до учёта комиссий в трекере, комиссий не содержит.",
        "2. **Стало (1m)** — сигнал проведён заново тем же кодом, что у трекера: по минутным "
        "свечам от закрытия сигнальной свечи, со сроками по времени (выход по времени — через 15 "
        "свечей H4, то есть 60 часов, если TP1 не взят), за вычетом комиссии и проскальзывания.",
        "3. **H4-эталон** — тот же сигнал, исполненный `simulate_trade` на сохранённых H4-свечах "
        "с комиссиями: так считает бэктест. С бэктестом сравнивают именно его.",
        "4. **1m и H4 расходятся законно.** По минутам порядок касаний внутри свечи H4 известен, "
        "а на H4 действует правило «если в одной свече задеты и стоп, и цель — считается стоп». "
        "Выход на H4 записывается закрытием свечи, поэтому при одинаковом исходе длительность по "
        "H4 не меньше, чем по 1m.",
        "5. **Открытая сделка** — сделка, которая к моменту отчёта не закрылась. Результата у неё "
        "ещё нет: R и длительность не показаны, в суммы и средние она не входит, доли, уже "
        "закрытые на TP1 и TP2, за результат не выдаются. После TP1 выхода по времени нет, "
        "поэтому такая сделка может оставаться открытой дольше 60 часов.",
        f"6. **«{NOT_RETRACKED.capitalize()}»** — в минутных свечах от сигнала до закрытия сделки "
        "(или до момента отчёта) есть пропуск длиннее допустимого; результат по 1m для такого "
        "сигнала не показан. Пропуск после закрытия сделки не учитывается. Для H4 допуска нет: "
        "без любой свечи до выхода эталон не считается.",
        "7. **Пересечение** — пометка по правилу «одна открытая сделка на инструмент и версию»: в "
        "момент сигнала у той же версии по тому же инструменту была открыта сделка более раннего "
        "сигнала или она закрылась внутри сигнальной свечи H4. Срок жизни более ранней сделки "
        "берётся из пересчёта по 1m, а если его нет — из H4-эталона. Учитываются только сигналы "
        "этого отчёта. Сравнение идёт со всеми записанными сигналами, включая помеченные: это "
        "факт пересечения, а не расчёт того, какие сигналы появились бы при действующем правиле. "
        "Отчёт правило не применяет и ничего не меняет.",
        "8. **Округление.** R — до 0.001, длительность — до 0.01 часа, как в `signal_results`; "
        "суммы и разницы считаются по округлённым значениям. ΔR = «стало» − «было». Итоги "
        "считаются по каждой версии отдельно, версии между собой не складываются.",
        "9. **Выборка мала.** Отчёт проверяет исправность учёта сделок. О прибыльности стратегии "
        "он ничего не доказывает.",
        "",
    ]
    return "\n".join(out)


# --- запись и запуск ---------------------------------------------------------------------------


def write_report(report: Report, out_dir: Path) -> list[Path]:
    """Пишет ``retrack_report.md``, ``retrack_report.csv`` и ``signals/*.png`` в ``out_dir``.
    Возвращает записанные файлы. Посторонние файлы каталога не трогает."""
    out_dir.mkdir(parents=True, exist_ok=True)
    files = {
        out_dir / REPORT_MD: render_markdown(report).encode("utf-8"),
        out_dir / REPORT_CSV: render_csv(report).encode("utf-8"),
    }
    for row in report.signals:
        if row.chart is not None and row.chart_file is not None:
            files[out_dir / row.chart_file] = row.chart
    for path, data in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return list(files)


def run_report(
    options: ReportOptions, out_dir: Path, bind: Engine | Connection | None = None
) -> tuple[Report, list[Path]]:
    """Пересчёт в транзакции только на чтение и запись файлов отчёта после неё."""
    with read_only_connection(bind) as conn:
        report = build_report(conn, options)
    return report, write_report(report, out_dir)
