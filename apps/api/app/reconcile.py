"""Ежедневная сверка записанных сигналов с офлайн-пересчётом — только чтение
(задача 8 пакета «Сигналы»; план 2.8 и раздел 11, риск «ошибка в коде движка на проде,
разошедшаяся с бэктестом»).

Сверка ничего не исправляет и ничего не пишет в БД: она читает записанные сигналы (forward и
live) за последние дни, пересчитывает каждый тем же кодом, что и боевой, и возвращает список
расхождений. Что с ним делать — решает монитор (``app.monitor``: компонент «Сверка сигналов» на
/status и письмо владельцу).

Что проверяется по каждому сигналу:

1. **Сигнал воспроизводится** (``check_replay``). ``replay()`` на входе из БД на момент
   закрытия сигнальной свечи (``forward.load_inputs`` — только то, что известно к этому моменту):

   - ``input_hash`` не совпал — свечи H4 в БД уже не те, на которых сигнал появился:
     предупреждение «входные данные изменились после публикации»;
   - хэш совпал и торговые поля совпали — сигнал воспроизведён;
   - хэш совпал, торговые поля — нет. Тут решает отпечаток входа, записанный вместе с сигналом
     (``rationale_facts['inputs']``, ADR-0013): отпечаток другой — изменились старшие таймфреймы
     или деривативы, это тоже «входные данные изменились»; отпечаток тот же — **расхождение
     логики** (критично): тот же вход даёт другой сигнал. У сигнала, записанного до отпечатка,
     причину определить нечем — отдельное предупреждение «не воспроизводится».

2. **Сопровождение воспроизводится** (``check_result``). Сделка ведётся заново двумя способами
   (``app.retrack``): по 1m-свечам кодом воркера-трекера и ``simulate_trade`` на H4 с комиссиями
   — эталон бэктеста.

   - Запись в БД расходится с пересчётом по 1m — **трекер разошёлся с пересчётом** (критично):
     код и данные те же, результат обязан совпасть.
   - Запись расходится с эталоном H4 (другой статус или \\|ΔR\\| больше порога), а по 1m
     совпадает — это не ошибка: внутри H4-свечи цена прошла уровни в порядке, которого бэктест
     не видит. Такие случаи считаются (``explained``), но не тревожат.
   - 1m-пересчёт невозможен (пропуски минут), а с H4 запись расходится — предупреждение.

   Результаты, записанные до учёта комиссий (``signal_results.cost_r`` пуст), не сверяются и
   считаются отдельно (``legacy``): они записаны прежним трекером, их исправляет задача 10.

3. **Инварианты** (``check_invariants``, ``check_tracking``, ``open_overlaps``): time stop
   рыночного входа — ровно через срок версии (60 ч) ± 1 мин; ни одного события раньше первой
   минуты после сигнала; открытый сигнал трекер ведёт (последняя обработанная минута не отстаёт
   от имеющихся свечей); у версии по инструменту не больше одной открытой сделки (задача 6).

Все проверки — чистые функции от прочитанных данных; ``run_reconcile`` только читает БД и
собирает их в ``Report``.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum
from typing import Any

from sqlalchemy import Connection, text
from sqlalchemy.orm import Session

from app.analysis import params_for_version
from app.forward import INPUTS_FACT, INPUTS_UPTO_FACT, load_inputs
from app.models import Instrument
from app.retrack import (
    DEFAULT_MAX_GAP_MINUTES,
    H4Retrack,
    MinuteRetrack,
    Outcome,
    SignalRow,
    iter_candles,
    load_candles,
    load_signals,
    retrack_h4,
    retrack_minutes,
)
from app.workers.tracker import OPEN
from engine.candles import SIGNAL_TIMEFRAME, Candle, Timeframe, closed_only
from engine.params import StrategyParams
from engine.signal import (
    MarketInputs,
    NoSignal,
    SignalCandidate,
    input_hash,
    inputs_fingerprint,
    replay,
    trim_inputs,
)
from engine.strategies import STRATEGIES
from engine.structure import Direction
from engine.tracker import interval_start

MINUTE = Timeframe.M1
CRITICAL, WARNING = "critical", "warning"

DEFAULT_DAYS = 7
"""За сколько последних дней сверяются сигналы (открытые сделки сверяются любой давности)."""
DEFAULT_R_TOLERANCE = Decimal("0.05")
"""Порог \\|ΔR\\| между записанным результатом и эталоном H4."""
TRACKER_R_EPS = Decimal("0.001")
"""Допуск на округление ``signal_results.realized_r`` (NUMERIC(8, 3))."""
LAG_GRACE = timedelta(minutes=10)
"""Сколько трекеру можно отставать от пересчёта: он ведёт сигналы раз в минуту."""
TIME_STOP_TOLERANCE = timedelta(minutes=1)
STALE_TRACKING = timedelta(minutes=15)
"""Открытый сигнал не ведётся, если обработанные минуты отстают от имеющихся больше этого."""
NOT_TRADED = ("expired", "cancelled")
"""Статусы, при которых результата сделки нет: лимит истёк или сигнал снят вручную."""


class Kind(StrEnum):
    LOGIC = "logic_mismatch"
    INPUTS = "inputs_changed"
    UNVERIFIED = "replay_unverified"
    TRACKER = "tracker_mismatch"
    RESULT = "result_mismatch"
    TIME_STOP = "time_stop_duration"
    EARLY_EVENT = "event_too_early"
    NOT_TRACKED = "open_not_tracked"
    OVERLAP = "open_trades_overlap"
    OVERLAP_LEGACY = "open_trades_overlap_legacy"


SEVERITY: Mapping[Kind, str] = {
    Kind.LOGIC: CRITICAL,
    Kind.INPUTS: WARNING,
    Kind.UNVERIFIED: WARNING,
    Kind.TRACKER: CRITICAL,
    Kind.RESULT: WARNING,
    Kind.TIME_STOP: CRITICAL,
    Kind.EARLY_EVENT: CRITICAL,
    Kind.NOT_TRACKED: CRITICAL,
    Kind.OVERLAP: CRITICAL,
    Kind.OVERLAP_LEGACY: WARNING,
}
TITLE: Mapping[Kind, str] = {
    Kind.LOGIC: "расхождение логики",
    Kind.INPUTS: "входные данные изменились после публикации",
    Kind.UNVERIFIED: "сигнал не воспроизводится, причина не определима",
    Kind.TRACKER: "трекер разошёлся с пересчётом по 1m",
    Kind.RESULT: "результат расходится с эталоном H4",
    Kind.TIME_STOP: "time stop не в срок",
    Kind.EARLY_EVENT: "событие раньше первой минуты после сигнала",
    Kind.NOT_TRACKED: "открытый сигнал не ведётся трекером",
    Kind.OVERLAP: "несколько открытых сделок по инструменту",
    Kind.OVERLAP_LEGACY: "несколько открытых сделок по инструменту, записаны до правила",
}


@dataclass(frozen=True, slots=True)
class Finding:
    """Одно расхождение по одному сигналу."""

    kind: Kind
    public_id: str
    symbol: str
    version: str
    message: str

    @property
    def severity(self) -> str:
        return SEVERITY[self.kind]

    def line(self) -> str:
        return f"{self.symbol} {self.version} {self.public_id}: {TITLE[self.kind]} — {self.message}"


def _finding(kind: Kind, signal: SignalRow, message: str) -> Finding:
    return Finding(kind, signal.public_id, signal.symbol, signal.version, message)


@dataclass(frozen=True, slots=True)
class Publication:
    """Что записано рядом с сигналом, кроме торговых полей и итога (``SignalRow``)."""

    input_hash: str
    fingerprint: Mapping[str, str] | None
    """Отпечаток входа из ``rationale_facts['inputs']``; ``None`` — сигнал записан до него."""
    publishable: bool
    deferred: bool
    first_event_at: datetime | None
    """Самое раннее событие сопровождения (всё, кроме ``created``)."""
    entry_type: str | None
    """``signal_results.entry_type_used``; ``None`` — результата нет."""
    tracked_to: datetime | None
    """До какого момента трекер обработал минуты (закрытие последней обработанной)."""
    inputs_upto: Mapping[str, str | None] | None = None
    """Время последней записи каждого ряда деривативов, которую видел прогон
    (``rationale_facts['inputs_upto']``); ``None`` — сигнал записан до этой отметки."""


def _dt(t: datetime) -> str:
    return f"{t.astimezone(UTC):%d.%m %H:%M} UTC"


def _r(x: Decimal | None) -> str:
    return "—" if x is None else f"{x:+.2f} R"


def _num(x: Decimal) -> str:
    return format(x.normalize(), "f")


def _outcome(o: Outcome) -> str:
    if o.closed_at is None:
        return o.status
    return f"{o.status} {_r(o.realized_r)}, закрыт {_dt(o.closed_at)}"


# --- 1. сигнал воспроизводится -----------------------------------------------------------------

_FIELD_TITLES = {
    "direction": "направление",
    "entry_market": "вход",
    "entry_limit": "лимитный вход",
    "stop_loss": "стоп",
    "tp1": "TP1",
    "tp2": "TP2",
    "tp3": "TP3",
    "rr_tp2": "R:R до TP2",
    "score": "скоринг",
    "grade": "градация",
    "publishable": "выше порога публикации",
    "deferred": "отложен",
}


def _recorded_fields(signal: SignalRow, pub: Publication) -> dict[str, object]:
    return {
        "direction": signal.direction,
        "entry_market": signal.entry_market,
        "entry_limit": signal.entry_limit,
        "stop_loss": signal.stop_loss,
        "tp1": signal.tp1,
        "tp2": signal.tp2,
        "tp3": signal.tp3,
        "rr_tp2": signal.rr_tp2,
        "score": signal.score,
        "grade": signal.grade,
        "publishable": pub.publishable,
        "deferred": pub.deferred,
    }


def _candidate_fields(cand: SignalCandidate) -> dict[str, object]:
    """Те же поля, какими их пишет ``forward.write_candidate``."""
    t = cand.trade
    return {
        "direction": "long" if cand.direction is Direction.UP else "short",
        "entry_market": t.entry_market,
        "entry_limit": t.entry_limit,
        "stop_loss": t.stop_loss,
        "tp1": t.tp1,
        "tp2": t.tp2,
        "tp3": t.tp3,
        "rr_tp2": t.rr_tp2,
        "score": cand.score.total,
        "grade": cand.score.grade.value if cand.score.publishable else "C",
        "publishable": cand.score.publishable,
        "deferred": cand.deferred,
    }


def _same(recorded: object, computed: object) -> bool:
    """Равны ли записанное и вычисленное значение. Число из БД округлено до точности колонки —
    вычисленное округляется так же (PostgreSQL округляет половину от нуля)."""
    if isinstance(recorded, Decimal) and isinstance(computed, Decimal):
        exponent = recorded.as_tuple().exponent
        if isinstance(exponent, int) and exponent < 0:
            computed = computed.quantize(Decimal(1).scaleb(exponent), ROUND_HALF_UP)
        return recorded == computed
    return recorded == computed


def _show(x: object) -> str:
    if isinstance(x, Decimal):
        return _num(x)
    if isinstance(x, bool):
        return "да" if x else "нет"
    return "—" if x is None else str(x)


def replay_difference(
    signal: SignalRow, pub: Publication, result: SignalCandidate | NoSignal
) -> str | None:
    """Чем пересчитанный сигнал отличается от записанного; ``None`` — ничем."""
    if isinstance(result, NoSignal):
        return f"сигнала нет (этап {result.stage}: {result.reason[:120]})"
    recorded, computed = _recorded_fields(signal, pub), _candidate_fields(result)
    diff = [
        f"{_FIELD_TITLES[k]} {_show(recorded[k])} → {_show(computed[k])}"
        for k in recorded
        if not _same(recorded[k], computed[k])
    ]
    return ", ".join(diff) or None


def check_replay(
    signal: SignalRow, pub: Publication, inputs: MarketInputs, params: StrategyParams
) -> Finding | None:
    """Воспроизводится ли записанный сигнал на входе ``inputs`` (из БД на момент сигнала).

    Ряды деривативов обрезаются по отметкам, записанным вместе с сигналом (``inputs_upto``):
    записи с временем ``at`` приходят по REST уже после оценки, живой прогон их не видел.
    """
    at = signal.candle_close_time
    if pub.inputs_upto is not None:
        inputs = trim_inputs(inputs, pub.inputs_upto)
    h4 = closed_only(inputs.h4, SIGNAL_TIMEFRAME, at)
    if input_hash(h4, params.version, params.hash_candles) != pub.input_hash:
        return _finding(
            Kind.INPUTS,
            signal,
            "свечи H4 в БД не те, на которых появился сигнал (input_hash не совпал)",
        )
    diff = replay_difference(signal, pub, replay(inputs, at, params))
    if diff is None:
        return None
    if pub.fingerprint is None:
        return _finding(
            Kind.UNVERIFIED,
            signal,
            f"пересчёт: {diff}. Свечи H4 те же; сигнал записан до отпечатка входа, поэтому "
            "изменились ли старшие таймфреймы и деривативы, проверить нечем",
        )
    now_fp = inputs_fingerprint(inputs, at)
    changed = sorted(
        k for k in {*now_fp, *pub.fingerprint} if now_fp.get(k) != pub.fingerprint.get(k)
    )
    if changed:
        return _finding(
            Kind.INPUTS,
            signal,
            f"после публикации изменились ряды: {', '.join(changed)}. На нынешних данных: {diff}",
        )
    return _finding(Kind.LOGIC, signal, f"тот же вход даёт другой сигнал: {diff}")


# --- 2. сопровождение воспроизводится ----------------------------------------------------------


def compare_minutes(
    signal: SignalRow, minutes: Outcome, events_at: Sequence[datetime], now: datetime
) -> str | None:
    """Чем запись в БД отличается от пересчёта по 1m кодом трекера; ``None`` — ничем.

    ``events_at`` — времена событий пересчёта. Трекер ведёт сигналы раз в минуту, поэтому
    отставание записи на ``LAG_GRACE`` расхождением не считается.
    """
    rec = signal.recorded
    if rec.is_closed:
        if not minutes.is_closed:
            return f"в БД {_outcome(rec)}; пересчёт сделку не закрывает ({minutes.status})"
        same_r = (
            rec.realized_r is not None
            and minutes.realized_r is not None
            and abs(rec.realized_r - minutes.realized_r) <= TRACKER_R_EPS
        )
        if rec.status != minutes.status or not same_r or rec.closed_at != minutes.closed_at:
            return f"в БД {_outcome(rec)}; пересчёт: {_outcome(minutes)}"
        return None
    if minutes.is_closed:
        if minutes.closed_at is not None and now - minutes.closed_at > LAG_GRACE:
            return f"в БД сделка открыта ({rec.status}); пересчёт: {_outcome(minutes)}"
        return None
    if rec.status == minutes.status:
        return None
    last_event = max(events_at, default=None)
    if rec.tp_hits > minutes.tp_hits:
        return f"в БД {rec.status}; пересчёт такого события не видит ({minutes.status})"
    if last_event is not None and now - last_event > LAG_GRACE:
        return f"в БД {rec.status}; по пересчёту уже {minutes.status} с {_dt(last_event)}"
    return None


def compare_h4(
    signal: SignalRow,
    h4: Outcome,
    tracked_until: datetime | None,
    now: datetime,
    r_tolerance: Decimal,
) -> str | None:
    """Чем запись в БД отличается от эталона бэктеста (``simulate_trade`` на H4 с комиссиями).

    Эталон видит только закрытые свечи H4, запись — минуты: сравнивается то, что оба уже могли
    увидеть. ``tracked_until`` — закрытие последней свечи, поданной в эталон.
    """
    rec = signal.recorded
    if h4.is_closed:
        if rec.is_closed:
            far = (
                rec.realized_r is None
                or h4.realized_r is None
                or abs(rec.realized_r - h4.realized_r) > r_tolerance
            )
            if rec.status != h4.status or far:
                return f"в БД {_outcome(rec)}; эталон H4: {_outcome(h4)}"
            return None
        if h4.closed_at is not None and now - h4.closed_at > LAG_GRACE:
            return f"в БД сделка открыта ({rec.status}); эталон H4: {_outcome(h4)}"
        return None
    if rec.is_closed and rec.closed_at is not None and tracked_until is not None:
        # свеча H4, внутри которой сделка закрыта по записи; эталон её уже видел?
        candle_end = (
            interval_start(rec.closed_at - MINUTE.delta, SIGNAL_TIMEFRAME) + SIGNAL_TIMEFRAME.delta
        )
        if candle_end <= tracked_until:
            return f"в БД {_outcome(rec)}; по эталону H4 сделка ещё открыта ({h4.status})"
    return None


@dataclass(frozen=True, slots=True)
class ResultCheck:
    finding: Finding | None = None
    legacy: bool = False
    """Результат записан до учёта комиссий — не сверяется."""
    explained: bool = False
    """С эталоном H4 запись расходится, с пересчётом по 1m совпадает: ход цены внутри свечи."""
    unchecked: str | None = None
    """Сверить не удалось — причина."""


def ambiguous_candle(
    signal: SignalRow, candles: Sequence[Candle], outcomes: Iterable[Outcome | None]
) -> bool:
    """Может ли отличие эталона H4 от пересчёта по минутам объясняться порядком цен внутри свечи.

    Берётся сохранённая свеча H4, внутри которой закрылась первая из двух сделок (её видел
    ``simulate_trade``). Объяснение возможно, только если эта свеча коснулась и цены входа (стопа
    или безубытка), и первой цели: тогда по одной свече H4 не видно, что было раньше, а минуты
    видят. Иначе H4 и минуты обязаны совпасть, и отличие — повод разбираться: тот же код трекера
    в пересчёте повторил бы собственную ошибку, сравнение с ним её не покажет.
    """
    closes = [o.closed_at for o in outcomes if o is not None and o.closed_at is not None]
    if not closes:
        return False
    start = interval_start(min(closes) - MINUTE.delta, SIGNAL_TIMEFRAME)
    candle = next((c for c in candles if c.open_time == start), None)
    if candle is None:
        return False
    if signal.direction == "long":
        return candle.low <= signal.entry_market and candle.high >= signal.tp1
    return candle.high >= signal.entry_market and candle.low <= signal.tp1


def check_result(
    signal: SignalRow,
    minutes: MinuteRetrack,
    h4: H4Retrack,
    now: datetime,
    r_tolerance: Decimal = DEFAULT_R_TOLERANCE,
    candles: Sequence[Candle] = (),
) -> ResultCheck:
    """Сверяет записанные статус и результат сделки с двумя пересчётами (см. описание модуля).

    ``candles`` — сохранённые свечи H4 после сигнала (те же, что получил эталон): по ним
    решается, объясняется ли отличие от эталона ходом цены внутри свечи (``ambiguous_candle``).
    """
    rec = signal.recorded
    if rec.status in NOT_TRADED:
        return ResultCheck()
    if rec.is_closed and rec.cost_r is None:
        return ResultCheck(legacy=True)
    if minutes.outcome is not None:
        message = compare_minutes(signal, minutes.outcome, [e.at for e in minutes.events], now)
        if message is not None:
            return ResultCheck(_finding(Kind.TRACKER, signal, message))
    if h4.outcome is not None:
        message = compare_h4(signal, h4.outcome, h4.tracked_until, now, r_tolerance)
        if message is not None:
            if minutes.outcome is not None:
                if ambiguous_candle(signal, candles, (minutes.outcome, h4.outcome)):
                    return ResultCheck(explained=True)
                return ResultCheck(
                    _finding(
                        Kind.RESULT,
                        signal,
                        f"{message}. Пересчёт по 1m совпадает с записью, но свеча H4, где "
                        "сделки разошлись, не касалась и входа, и первой цели — порядком цен "
                        "внутри свечи это не объясняется",
                    )
                )
            return ResultCheck(
                _finding(
                    Kind.RESULT,
                    signal,
                    f"{message}. По 1m проверить нельзя: {minutes.reason or 'нет данных'}",
                )
            )
    if minutes.outcome is None and h4.outcome is None:
        return ResultCheck(
            unchecked=f"{signal.symbol} {signal.version} {signal.public_id}: "
            f"1m — {minutes.reason or 'нет данных'}; H4 — {h4.reason or 'нет данных'}"
        )
    return ResultCheck()


# --- 3. инварианты -----------------------------------------------------------------------------


def check_invariants(signal: SignalRow, pub: Publication, params: StrategyParams) -> list[Finding]:
    """Инварианты записи одного сигнала: первое событие и срок time stop."""
    out: list[Finding] = []
    at = signal.candle_close_time
    first_allowed = at + MINUTE.delta
    if pub.first_event_at is not None and pub.first_event_at < first_allowed:
        out.append(
            _finding(
                Kind.EARLY_EVENT,
                signal,
                f"событие в {_dt(pub.first_event_at)}, а первая минута после сигнала закрывается "
                f"в {_dt(first_allowed)}",
            )
        )
    rec = signal.recorded
    market = (pub.entry_type or "market") == "market"
    if rec.status == "closed_time" and rec.closed_at is not None and market:
        if rec.cost_r is None:
            return out  # записан прежним трекером — считается в legacy
        expected = SIGNAL_TIMEFRAME.delta * params.trade.time_stop_candles
        actual = rec.closed_at - at
        if abs(actual - expected) > TIME_STOP_TOLERANCE:
            out.append(
                _finding(
                    Kind.TIME_STOP,
                    signal,
                    f"закрыт по времени через {actual.total_seconds() / 3600:.2f} ч после сигнала, "
                    f"срок версии — {expected.total_seconds() / 3600:.0f} ч",
                )
            )
    return out


def check_tracking(
    signal: SignalRow, pub: Publication, last_minute_close: datetime | None
) -> Finding | None:
    """Ведёт ли трекер открытый сигнал. ``last_minute_close`` — закрытие последней 1m-свечи
    инструмента в БД; если свечей нет, это забота компонента «Данные с биржи», не сверки."""
    if signal.recorded.status not in OPEN or last_minute_close is None:
        return None
    done_to = pub.tracked_to or signal.candle_close_time
    if last_minute_close - done_to <= STALE_TRACKING:
        return None
    return _finding(
        Kind.NOT_TRACKED,
        signal,
        f"статус {signal.recorded.status}, минуты обработаны до {_dt(done_to)}, а свечи в БД "
        f"есть до {_dt(last_minute_close)}. Пока сигнал открыт, новые сигналы версии по "
        "инструменту не выпускаются",
    )


@dataclass(frozen=True, slots=True)
class OpenTrade:
    """Открытая сделка — строка для проверки «одна открытая сделка на инструмент и версию»."""

    public_id: str
    symbol: str
    version: str
    strategy_version_id: int
    instrument_id: int
    opened_at: datetime
    rule_era: bool = True
    """Записан кодом, в котором уже было правило одной открытой сделки (задача 6)."""


def open_overlaps(trades: Iterable[OpenTrade]) -> list[Finding]:
    """Пары (версия, инструмент) с несколькими открытыми сделками; расхождение — на поздней.

    Критично, только если поздний сигнал записан кодом с правилом (``rule_era``): тогда правило
    нарушено. Пересечение, где поздний сигнал записан до правила, — наследство, предупреждение.
    """
    groups: dict[tuple[int, int], list[OpenTrade]] = defaultdict(list)
    for t in trades:
        groups[(t.strategy_version_id, t.instrument_id)].append(t)
    out: list[Finding] = []
    for group in groups.values():
        if len(group) < 2:
            continue
        group.sort(key=lambda t: (t.opened_at, t.public_id))
        last = group[-1]
        others = ", ".join(f"{t.public_id} от {_dt(t.opened_at)}" for t in group[:-1])
        out.append(
            Finding(
                Kind.OVERLAP if last.rule_era else Kind.OVERLAP_LEGACY,
                last.public_id,
                last.symbol,
                last.version,
                f"открыто сделок: {len(group)}; раньше открыты {others}",
            )
        )
    out.sort(key=lambda f: (f.symbol, f.version, f.public_id))
    return out


# --- отчёт -------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Report:
    now: datetime
    since: datetime
    checked: int
    """Сколько сигналов проверено."""
    findings: tuple[Finding, ...]
    explained: int = 0
    legacy: int = 0
    hidden: int = 0
    """Из проверенных — кандидатов ниже порога публикации и отложенных: у них проверяется только
    воспроизводимость (движок не скрыл ли сигнал по ошибке)."""
    unchecked: tuple[str, ...] = ()

    @property
    def critical(self) -> int:
        return sum(1 for f in self.findings if f.severity == CRITICAL)

    @property
    def warnings(self) -> int:
        return sum(1 for f in self.findings if f.severity == WARNING)

    def summary(self) -> str:
        """Одна строка для журнала."""
        days = (self.now - self.since).days
        parts = [
            f"сверка за {days} дн.: проверено сигналов {self.checked}",
            f"критичных расхождений {self.critical}",
            f"предупреждений {self.warnings}",
        ]
        if self.explained:
            parts.append(f"отличий от эталона H4 из-за хода цены внутри свечи {self.explained}")
        if self.hidden:
            parts.append(f"из них скрытых кандидатов {self.hidden}")
        if self.legacy:
            parts.append(f"результатов до учёта комиссий (не сверяются) {self.legacy}")
        if self.unchecked:
            parts.append(f"не удалось сверить сопровождение {len(self.unchecked)}")
        return ", ".join(parts)

    def lines(self) -> list[str]:
        """Расхождения по одному в строке — сначала критичные."""
        ordered = sorted(self.findings, key=lambda f: (f.severity != CRITICAL, f.symbol, f.version))
        return [("КРИТИЧНО " if f.severity == CRITICAL else "") + f.line() for f in ordered]

    def to_json(self) -> dict[str, Any]:
        """Состояние для монитора (Redis ``reconcile:last``)."""
        return {
            "at": self.now.isoformat(),
            "since": self.since.isoformat(),
            "checked": self.checked,
            "critical": self.critical,
            "warnings": self.warnings,
            "explained": self.explained,
            "legacy": self.legacy,
            "hidden": self.hidden,
            "unchecked": list(self.unchecked),
            "lines": self.lines(),
            "findings": [
                {
                    "kind": f.kind.value,
                    "severity": f.severity,
                    "public_id": f.public_id,
                    "symbol": f.symbol,
                    "version": f.version,
                    "message": f.message,
                }
                for f in self.findings
            ],
        }


# --- чтение БД ---------------------------------------------------------------------------------


def load_publications(conn: Connection, signal_ids: Sequence[int]) -> dict[int, Publication]:
    if not signal_ids:
        return {}
    rows = conn.execute(
        text(
            "select s.id, s.input_hash, s.rationale_facts, r.entry_type_used, t.last_candle_time, "
            "(select min(e.occurred_at) from signal_events e "
            " where e.signal_id = s.id and e.type <> 'created') "
            "from signals s "
            "left join signal_results r on r.signal_id = s.id "
            "left join signal_tracking t on t.signal_id = s.id "
            "where s.id = any(:ids)"
        ),
        {"ids": list(signal_ids)},
    ).all()
    out: dict[int, Publication] = {}
    for sid, hash_, facts, entry_type, last_candle, first_event in rows:
        facts = facts or {}
        fingerprint = facts.get(INPUTS_FACT)
        marks = facts.get(INPUTS_UPTO_FACT)
        out[sid] = Publication(
            input_hash=hash_,
            fingerprint=fingerprint if isinstance(fingerprint, dict) else None,
            publishable=facts.get("publishable") is not False,
            deferred=facts.get("deferred") is True,
            first_event_at=None if first_event is None else first_event.astimezone(UTC),
            entry_type=entry_type,
            tracked_to=(
                None if last_candle is None else last_candle.astimezone(UTC) + MINUTE.delta
            ),
            inputs_upto=marks if isinstance(marks, dict) else None,
        )
    return out


def load_open_trades(conn: Connection) -> list[OpenTrade]:
    """Все открытые сделки — любой области и давности. Только опубликованные сигналы: кандидат
    ниже порога публикации и отложенный сделкой не считается (как в ``open_trade_blocker``)."""
    rows = conn.execute(
        text(
            "select s.public_id, i.symbol, sv.version, sv.id, i.id, s.candle_close_time, "
            "s.rationale_facts ? 'inputs' "  # есть отпечаток — записан с правилом
            "from signals s "
            "join strategy_versions sv on sv.id = s.strategy_version_id "
            "join instruments i on i.id = s.instrument_id "
            "where s.status = any(:open) and s.published"
        ),
        {"open": list(OPEN)},
    ).all()
    return [OpenTrade(r[0], r[1], r[2], r[3], r[4], r[5].astimezone(UTC), r[6]) for r in rows]


def last_minute_close(conn: Connection, instrument_id: int, now: datetime) -> datetime | None:
    """Закрытие последней закрытой 1m-свечи инструмента к моменту ``now``."""
    t = conn.execute(
        text(
            "select max(open_time) from candles where instrument_id = :i and timeframe = '1m' "
            "and is_closed and open_time < :end"
        ),
        {"i": instrument_id, "end": interval_start(now, MINUTE)},
    ).scalar()
    return None if t is None else t.astimezone(UTC) + MINUTE.delta


def run_reconcile(
    conn: Connection,
    now: datetime,
    days: int = DEFAULT_DAYS,
    r_tolerance: Decimal = DEFAULT_R_TOLERANCE,
    max_gap_minutes: int = DEFAULT_MAX_GAP_MINUTES,
) -> Report:
    """Сверяет сигналы forward и live за последние ``days`` дней (и все открытые сделки).

    ``conn`` — соединение только на чтение (``retrack.read_only_connection``): сверка ничего не
    пишет и не исправляет. Воспроизводимость сигнала проверяется у сигналов окна; сопровождение и
    инварианты — ещё и у сделок старше окна, которые открыты или закрылись внутри окна.
    """
    since = now - timedelta(days=days)
    # скрытые кандидаты окна (ниже порога, отложенные) — только на воспроизводимость: движок,
    # ошибочно скрывший сигнал, виден лишь так; сделкой они не были, трекер их не ведёт
    signals = load_signals(
        conn, since, now, scopes=("forward", "live"), include_open=True, published_only=False
    )
    pubs = load_publications(conn, [s.id for s in signals])
    findings: list[Finding] = []
    unchecked: list[str] = []
    explained = legacy = hidden = 0
    instruments: dict[int, Instrument | None] = {}
    minute_ends: dict[int, datetime | None] = {}
    with Session(bind=conn, join_transaction_mode="create_savepoint") as session:
        for signal in signals:
            pub = pubs[signal.id]
            at = signal.candle_close_time
            params = STRATEGIES.get(signal.version_label)
            if at >= since:
                if signal.instrument_id not in instruments:
                    instruments[signal.instrument_id] = session.get(
                        Instrument, signal.instrument_id
                    )
                inst = instruments[signal.instrument_id]
                if params is None or inst is None:
                    unchecked.append(
                        f"{signal.symbol} {signal.version} {signal.public_id}: версии "
                        f"{signal.version_label} нет в коде — сигнал не пересчитан"
                    )
                else:
                    finding = check_replay(signal, pub, load_inputs(session, inst, at), params)
                    if finding is not None:
                        findings.append(finding)
            if not pub.publishable or pub.deferred:
                hidden += 1  # не сделка: сопровождения и итога у кандидата нет
                continue
            minutes = retrack_minutes(
                signal,
                iter_candles(conn, signal.instrument_id, MINUTE, at, now),
                now,
                max_gap_minutes,
            )
            h4_candles = load_candles(conn, signal.instrument_id, SIGNAL_TIMEFRAME, at, now)
            h4 = retrack_h4(signal, h4_candles, now)
            result = check_result(signal, minutes, h4, now, r_tolerance, h4_candles)
            if result.finding is not None:
                findings.append(result.finding)
            explained += result.explained
            legacy += result.legacy
            if result.unchecked is not None:
                unchecked.append(result.unchecked)
            findings.extend(
                check_invariants(signal, pub, params or params_for_version(signal.version))
            )
            if signal.recorded.status in OPEN:
                if signal.instrument_id not in minute_ends:
                    minute_ends[signal.instrument_id] = last_minute_close(
                        conn, signal.instrument_id, now
                    )
                stuck = check_tracking(signal, pub, minute_ends[signal.instrument_id])
                if stuck is not None:
                    findings.append(stuck)
    findings.extend(open_overlaps(load_open_trades(conn)))
    return Report(
        now=now,
        since=since,
        checked=len(signals),
        findings=tuple(findings),
        explained=explained,
        legacy=legacy,
        hidden=hidden,
        unchecked=tuple(unchecked),
    )
