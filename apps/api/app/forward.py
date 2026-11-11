"""Форвард-тест (задача 1.11): прогон стратегии на живых данных без публикации.

Запускается по расписанию через 1–2 минуты после закрытия каждой свечи H4 (cron ``2 */4 * * *``):
1. догружает свежие свечи H4/D1/W1 и деривативы по REST Binance в БД (временная замена
   сервиса market-data этапа 2);
2. для каждого инструмента вызывает ``evaluate`` на момент последнего закрытия H4 по каждой
   версии стратегии в статусе ``forward`` или ``live``; кандидат записывается в ``signals``
   (статус pending, событие created), повторный запуск ничего не дублирует (уникальный индекс).
   Версия, которой ещё нет в БД, создаётся в статусе ``backtest`` и не оценивается, пока её
   не переведут в forward заявкой в админке. Кандидат не пишется, пока у версии по инструменту
   есть открытая сделка или сделка закрылась внутри сигнальной свечи — то же правило, что в
   бэктесте (``engine.lifecycle.blocking_signal``; см. ``write_candidate``);
3. ведёт открытые форвард-сигналы по свечам H4 тем же кодом, что бэктест (``simulate_trade``):
   меняет статус через ``signal_events``, закрытые — в ``signal_results``.

Результаты видны только в БД и в /debug; пользователям форвард не показывается (план 2.11).
"""

from __future__ import annotations

import logging
import secrets
import sys
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import Candle as CandleRow
from app.models import (
    FundingRateRow,
    Instrument,
    LongShortRatioRow,
    OpenInterestRow,
    Signal,
    SignalEvent,
    SignalResult,
    Strategy,
    StrategyVersion,
)
from app.signal_scope import scope_at_publication
from engine.backtest import DEFAULT_EXECUTION, TradeResult, signal_status, simulate_trade
from engine.candles import Candle, Timeframe
from engine.data.binance import BinanceHistory
from engine.derivatives import FundingRate, LongShortRatio, OpenInterest
from engine.lifecycle import SignalLife, SignalStatus, blocking_signal
from engine.params import StrategyParams
from engine.signal import MarketInputs, NoSignal, SignalCandidate, evaluate, inputs_fingerprint
from engine.strategies import STRATEGIES
from engine.structure import Direction
from engine.trade import TradeSetup

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))

log = logging.getLogger("forward")
STRATEGY_SLUG = "trend-ob-retest"
# Новая версия из кода не оценивается сама: в forward её переводят заявкой в админке (план 2.9).
NEW_VERSION_STATUS = "backtest"
EVALUATED_STATUSES = ("forward", "live")
SKIPPED_VERSION_LOG = "версия %s в статусе %s — не оценивается"
H4_WINDOW = 700
D1_WINDOW = 400
W1_WINDOW = 120
"""Сколько последних закрытых свечей каждого таймфрейма подаётся в ``evaluate``."""
DERIVATIVES_LOOKBACK = timedelta(days=95)
"""За сколько дней до момента расчёта читаются funding, OI и long/short."""
PAIR_LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended(:key, 0))"
"""Блокировка пары (версия, инструмент) до конца транзакции — см. ``lock_signal_pair``."""
INPUTS_FACT = "inputs"
"""Ключ ``signals.rationale_facts``, под которым лежит отпечаток входа ``evaluate``."""
BUSY_LOG = "%s %s %s: кандидат не записан — по инструменту у версии уже есть сделка: сигнал %s (%s)"
"""Пропуск по правилу одной открытой сделки: время сигнальной свечи, инструмент, версия,
``public_id`` мешающего сигнала и его состояние."""
UNREADABLE_SIGNAL_LOG = (
    "%s %s: запись сигнала %s не читается правилом одной открытой сделки (%s) — "
    "сделка считается открытой, новые сигналы версии по инструменту не пишутся"
)
EVENT_BY_STATUS = {
    "active": "activated",
    "tp1_hit": "tp1",
    "tp2_hit": "tp2",
    "closed_tp3": "tp3",
    "closed_be": "be",
    "closed_sl": "sl",
    "closed_time": "time_stop",
    "expired": "expired",
}


def last_h4_close(now: datetime | None = None) -> datetime:
    now = (now or datetime.now(tz=UTC)).astimezone(UTC)
    floored = now.replace(minute=0, second=0, microsecond=0)
    return floored - timedelta(hours=floored.hour % 4)


# --- данные ----------------------------------------------------------------------------------


def refresh_market_data(session: Session, instruments: list[Instrument], now: datetime) -> None:
    """Догружает хвост свечей и деривативов по REST (идемпотентно, upsert)."""
    history = BinanceHistory("futures")
    for inst in instruments:
        for tf, back in ((Timeframe.H4, 10), (Timeframe.D1, 6), (Timeframe.W1, 4)):
            start = now - tf.delta * back
            candles = [
                c
                for c in history.fetch_rest(inst.symbol, tf, start, now)
                if c.close_time(tf) <= now
            ]
            if candles:
                upsert_candles(session, inst.id, tf, candles)
        _refresh_derivatives(session, history, inst, now)
    session.commit()


UPSERT_CHUNK = 2000
"""Строк за один INSERT: 11 параметров на строку, лимит psycopg — 65 535 параметров."""


def upsert_candles(
    session: Session, instrument_id: int, tf: Timeframe, candles: list[Candle]
) -> None:
    """Закрытые свечи в БД (upsert). Строка, записанная раньше незакрытой (market-data пишет идущую
    свечу с ``is_closed = false``), становится закрытой: иначе догрузка исправляла бы цены, а свеча
    оставалась бы «незакрытой» — без неё трекер, алерты и текущая свеча графика."""
    rows = [
        {
            "instrument_id": instrument_id,
            "timeframe": tf.value,
            "open_time": c.open_time,
            "open": c.open,
            "high": c.high,
            "low": c.low,
            "close": c.close,
            "volume": c.volume,
            "quote_volume": c.quote_volume,
            "trades": c.trades,
            "is_closed": True,
        }
        for c in candles
    ]
    for i in range(0, len(rows), UPSERT_CHUNK):
        stmt = insert(CandleRow).values(rows[i : i + UPSERT_CHUNK])
        session.execute(
            stmt.on_conflict_do_update(
                index_elements=["instrument_id", "timeframe", "open_time"],
                set_={
                    k: stmt.excluded[k]
                    for k in (
                        "open",
                        "high",
                        "low",
                        "close",
                        "volume",
                        "quote_volume",
                        "trades",
                        "is_closed",
                    )
                },
            )
        )


def merge_long_short(top: list[dict[str, Any]], glob: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Сливает ряды top/global по времени; если одного ряда нет, берём другой (не 1:1 — так
    было до этой правки, когда global копировался из top)."""
    by_time: dict[datetime, dict[str, Any]] = {}
    for src, key in ((top, "top_traders_ratio"), (glob, "global_ratio")):
        for r in src:
            t = datetime.fromtimestamp(int(r["timestamp"]) / 1000, tz=UTC)
            by_time.setdefault(t, {"time": t})[key] = Decimal(str(r["longShortRatio"]))
    out = []
    for t in sorted(by_time):
        r = by_time[t]
        if "top_traders_ratio" not in r and "global_ratio" not in r:
            continue
        r.setdefault("top_traders_ratio", r.get("global_ratio"))
        r.setdefault("global_ratio", r.get("top_traders_ratio"))
        out.append(r)
    return out


def _refresh_derivatives(
    session: Session, history: BinanceHistory, inst: Instrument, now: datetime
) -> None:
    client = history._client
    base = "https://fapi.binance.com"
    try:
        f = client.get(
            f"{base}/fapi/v1/fundingRate", params={"symbol": inst.symbol, "limit": 12}
        ).json()
        if f:
            stmt = insert(FundingRateRow).values(
                [
                    {
                        "instrument_id": inst.id,
                        "funding_time": datetime.fromtimestamp(
                            int(r["fundingTime"]) / 1000, tz=UTC
                        ),
                        "rate": Decimal(str(r["fundingRate"])),
                    }
                    for r in f
                ]
            )
            session.execute(
                stmt.on_conflict_do_nothing(index_elements=["instrument_id", "funding_time"])
            )
        oi = client.get(
            f"{base}/futures/data/openInterestHist",
            params={"symbol": inst.symbol, "period": "1h", "limit": 48},
        ).json()
        if isinstance(oi, list) and oi:
            stmt = insert(OpenInterestRow).values(
                [
                    {
                        "instrument_id": inst.id,
                        "time": datetime.fromtimestamp(int(r["timestamp"]) / 1000, tz=UTC),
                        "oi_contracts": Decimal(str(r["sumOpenInterest"])),
                        "oi_quote": Decimal(str(r["sumOpenInterestValue"])),
                    }
                    for r in oi
                ]
            )
            session.execute(stmt.on_conflict_do_nothing(index_elements=["instrument_id", "time"]))
        # L/S ratio: топ-трейдеры и все аккаунты — два разных ряда Binance (индикаторы v2)
        top = client.get(
            f"{base}/futures/data/topLongShortAccountRatio",
            params={"symbol": inst.symbol, "period": "1h", "limit": 48},
        ).json()
        glob = client.get(
            f"{base}/futures/data/globalLongShortAccountRatio",
            params={"symbol": inst.symbol, "period": "1h", "limit": 48},
        ).json()
        rows = merge_long_short(
            top if isinstance(top, list) else [], glob if isinstance(glob, list) else []
        )
        if rows:
            stmt = insert(LongShortRatioRow).values([{"instrument_id": inst.id, **r} for r in rows])
            session.execute(
                stmt.on_conflict_do_update(
                    index_elements=["instrument_id", "time"],
                    set_={
                        "top_traders_ratio": stmt.excluded.top_traders_ratio,
                        "global_ratio": stmt.excluded.global_ratio,
                    },
                )
            )
    except Exception as exc:
        print(f"{inst.symbol}: деривативы не обновлены: {type(exc).__name__}: {exc}", flush=True)


def context_candles_due(at: datetime) -> list[tuple[Timeframe, datetime]]:
    """Свечи старших таймфреймов, которые закрываются ровно в момент ``at`` — закрытие сигнальной
    свечи H4: ``(таймфрейм, open_time)``. В 00:00 UTC это дневная свеча, в понедельник 00:00 UTC —
    ещё и недельная (неделя Binance открывается в понедельник). Bias на таком закрытии считается
    уже с ними, как в бэктесте, поэтому к моменту оценки они должны быть записаны закрытыми."""
    at = at.astimezone(UTC)
    if at != at.replace(hour=0, minute=0, second=0, microsecond=0):
        return []
    due = [(Timeframe.D1, at - Timeframe.D1.delta)]
    if at.weekday() == 0:
        due.append((Timeframe.W1, at - Timeframe.W1.delta))
    return due


def closed_candle_exists(
    session: Session, instrument_id: int, tf: Timeframe, open_time: datetime
) -> bool:
    return (
        session.execute(
            text(
                "select 1 from candles where instrument_id=:i and timeframe=:tf "
                "and open_time=:t and is_closed"
            ),
            {"i": instrument_id, "tf": tf.value, "t": open_time},
        ).first()
        is not None
    )


def missing_context_candles(
    session: Session, instrument_id: int, at: datetime
) -> list[tuple[Timeframe, datetime]]:
    """Какие из ``context_candles_due(at)`` ещё не записаны в БД закрытыми."""
    return [
        (tf, open_time)
        for tf, open_time in context_candles_due(at)
        if not closed_candle_exists(session, instrument_id, tf, open_time)
    ]


def _candles(
    session: Session, instrument_id: int, tf: Timeframe, limit: int, at: datetime
) -> list[Candle]:
    """Последние ``limit`` свечей ``tf``, закрытых к моменту ``at``, по возрастанию времени.

    Свеча берётся, только если её интервал закончился не позже ``at`` и строка записана
    закрытой (``is_closed``): идущую свечу market-data хранит с ``is_closed = false`` и
    переписывает, её цены ещё не окончательные.
    """
    rows = session.execute(
        text(
            "select open_time, open, high, low, close, volume, quote_volume, trades from candles "
            "where instrument_id = :i and timeframe = :tf and is_closed and open_time <= :last "
            "order by open_time desc limit :n"
        ),
        {"i": instrument_id, "tf": tf.value, "last": at - tf.delta, "n": limit},
    ).all()
    return [
        Candle(r[0].astimezone(UTC), r[1], r[2], r[3], r[4], r[5], r[6], r[7])
        for r in reversed(rows)
    ]


def load_inputs(session: Session, inst: Instrument, at: datetime) -> MarketInputs:
    """Вход ``evaluate`` на момент ``at`` (закрытие сигнальной свечи) из БД.

    Берётся только то, что известно к ``at``: свечи, закрытые к этому моменту (ровно
    ``H4_WINDOW`` / ``D1_WINDOW`` / ``W1_WINDOW`` последних), и записи funding, OI и long/short
    не позже ``at``. Поэтому вызов с тем же ``at`` позже — при сверке, в разборе сигнала —
    читает то же окно, что и прогон на закрытии свечи, пока сами данные в БД не изменились.
    Раньше окно бралось «последние N строк» без верхней границы: в него попадала идущая свеча
    (движок её отбрасывал, и закрытых оставалось на одну меньше), а при повторном вызове оно
    съезжало вперёд.
    """
    since = at - DERIVATIVES_LOOKBACK
    span = {"i": inst.id, "s": since, "at": at}
    f = session.execute(
        text(
            "select funding_time, rate from funding_rates "
            "where instrument_id=:i and funding_time>=:s and funding_time<=:at order by 1"
        ),
        span,
    ).all()
    oi = session.execute(
        text(
            "select time, oi_quote from open_interest "
            "where instrument_id=:i and time>=:s and time<=:at order by 1"
        ),
        span,
    ).all()
    ls = session.execute(
        text(
            "select time, top_traders_ratio from long_short_ratios "
            "where instrument_id=:i and time>=:s and time<=:at order by 1"
        ),
        span,
    ).all()
    return MarketInputs(
        symbol=inst.symbol,
        h4=_candles(session, inst.id, Timeframe.H4, H4_WINDOW, at),
        d1=_candles(session, inst.id, Timeframe.D1, D1_WINDOW, at),
        w1=_candles(session, inst.id, Timeframe.W1, W1_WINDOW, at),
        funding=[FundingRate(r[0].astimezone(UTC), r[1]) for r in f],
        open_interest=[OpenInterest(r[0].astimezone(UTC), r[1]) for r in oi],
        long_short=[LongShortRatio(r[0].astimezone(UTC), r[1] / (1 + r[1])) for r in ls],
        avg_daily_turnover=inst.avg_volume_30d,
    )


# --- версии стратегий -------------------------------------------------------------------------


def sync_strategy_versions(session: Session) -> dict[str, StrategyVersion]:
    """Строки strategy_versions для всех версий из engine.strategies, в любом статусе.

    Отсутствующая версия создаётся в статусе ``backtest`` (план 2.9, 3.15): в forward её
    переводят только заявкой в админке с подтверждением второго админа. Существующие строки
    не меняются.
    """
    strat = session.scalar(select(Strategy).where(Strategy.slug == STRATEGY_SLUG))
    if strat is None:
        strat = Strategy(
            slug=STRATEGY_SLUG, name="Trend OB retest", description_public="План, раздел 2"
        )
        session.add(strat)
        session.flush()
    out: dict[str, StrategyVersion] = {}
    for key, params in STRATEGIES.items():
        version = key.split("@")[1]
        row = session.scalar(
            select(StrategyVersion).where(
                StrategyVersion.strategy_id == strat.id, StrategyVersion.version == version
            )
        )
        if row is None:
            import json

            row = StrategyVersion(
                strategy_id=strat.id,
                version=version,
                params=json.loads(json.dumps(asdict(params), default=str)),
                status=NEW_VERSION_STATUS,
                created_by="forward.py",
                changelog="автоматически из engine.strategies; в forward — заявкой в админке",
            )
            session.add(row)
            session.flush()
        out[key] = row
    session.commit()
    return out


def evaluated_versions(rows: dict[str, StrategyVersion]) -> dict[str, StrategyVersion]:
    """Версии, которые scheduler и forward оценивают: только в статусах forward и live."""
    return {k: v for k, v in rows.items() if v.status in EVALUATED_STATUSES}


def skipped_versions(rows: dict[str, StrategyVersion]) -> dict[str, str]:
    """Версии вне оценки (backtest, archived): ключ версии → статус, для строки в журнале."""
    return {k: v.status for k, v in rows.items() if v.status not in EVALUATED_STATUSES}


def ensure_strategy_versions(session: Session) -> dict[str, StrategyVersion]:
    """Создаёт недостающие версии (в статусе backtest) и возвращает оцениваемые."""
    return evaluated_versions(sync_strategy_versions(session))


# --- сигналы ----------------------------------------------------------------------------------


def lock_signal_pair(session: Session, version_id: int, instrument_id: int) -> None:
    """Берёт блокировку пары (версия, инструмент) до конца текущей транзакции.

    Запись кандидата — это «проверить и вставить». Уникальный индекс (версия, инструмент,
    ``candle_close_time``) защищает только от повтора той же свечи; правило одной открытой
    сделки смотрит на другие строки пары, и без блокировки два процесса (scheduler и форвард)
    могли бы оба пройти проверку и оба записать сигнал. С блокировкой второй процесс ждёт,
    пока первый зафиксирует или откатит транзакцию, и проверяет уже по её итогу (уровень
    изоляции — READ COMMITTED, как у приложения: запрос после ожидания видит зафиксированное).
    Блокировка рекомендательная (``pg_advisory_xact_lock``), снимается сама при commit/rollback
    и другим запросам к ``signals`` (трекер, API) не мешает.
    """
    session.execute(text(PAIR_LOCK_SQL), {"key": f"signals:{version_id}:{instrument_id}"})


def open_trade_blocker(
    session: Session, version: StrategyVersion, inst: Instrument, at: datetime
) -> SignalLife | None:
    """Сигнал версии, из-за которого инструмент занят в момент ``at``; ``None`` — свободен.

    Само правило — ``engine.lifecycle.blocking_signal``, то же, что в ``run_backtest``; здесь
    только чтение его входа из БД: сигналы версии по инструменту (и форвардные, и live —
    область не важна), статус из ``signals.status``, время закрытия из
    ``signal_results.closed_at``. Статус и время закрытия читаются одним запросом, поэтому
    трекер, закрывающий сделку в эту же секунду, ответа не меняет: сделка либо ещё открыта,
    либо закрылась внутри сигнальной свечи — в обоих случаях инструмент занят.

    Как и в бэктесте, инструмент занимают только сигналы, которые там становятся сделками.
    Кандидат ниже порога публикации или отложенный (``rationale_facts``: ``publishable`` = false
    или ``deferred`` = true) в бэктесте сделкой не становится (``skipped['grade_none']``,
    ``skipped['deferred']``) и инструмент не занимает — его строка сюда не читается. Строка без
    этих пометок считается сделкой.

    Строка, которую правило прочитать не может (закрытый статус без ``signal_results``, время
    закрытия раньше сигнальной свечи — так код не пишет), считается открытой сделкой и пишется
    в журнал как предупреждение: лучше не выдать сигнал, чем открыть вторую сделку поверх
    непонятной первой. Прогон при этом не падает, остальные пары оцениваются как обычно.
    """
    rows = session.execute(
        select(
            Signal.public_id,
            Signal.candle_close_time,
            Signal.status,
            SignalResult.closed_at,
            Signal.rationale_facts["publishable"],
            Signal.rationale_facts["deferred"],
        )
        .outerjoin(SignalResult, SignalResult.signal_id == Signal.id)
        .where(Signal.strategy_version_id == version.id, Signal.instrument_id == inst.id)
    ).all()
    signals: list[SignalLife] = []
    for public_id, opened_at, status, closed_at, publishable, deferred in rows:
        if publishable is False or deferred is True:
            continue  # в бэктесте такой кандидат сделкой не становится
        opened_at = opened_at.astimezone(UTC)
        try:
            life = SignalLife(
                ref=public_id,
                opened_at=opened_at,
                status=SignalStatus(status),
                closed_at=None if closed_at is None else closed_at.astimezone(UTC),
            )
        except ValueError as exc:
            log.warning(UNREADABLE_SIGNAL_LOG, inst.symbol, version.version, public_id, exc)
            life = SignalLife(ref=public_id, opened_at=opened_at, status=SignalStatus.ACTIVE)
        signals.append(life)
    return blocking_signal(signals, at.astimezone(UTC) if at.tzinfo is not None else at)


def _blocker_state(blocker: SignalLife) -> str:
    if blocker.closed_at is None or blocker.status.is_open:
        return f"статус {blocker.status.value}"
    return (
        f"{blocker.status.value}, закрыт {blocker.closed_at:%d.%m %H:%M} UTC — в сигнальной свече"
    )


def write_candidate(
    session: Session,
    version: StrategyVersion,
    inst: Instrument,
    cand: SignalCandidate,
    inputs: MarketInputs | None = None,
) -> bool:
    """Пишет кандидата в ``signals`` (pending + событие created). Область сигнала (``scope``)
    берётся из статуса версии, прочитанного из БД в момент записи, и дальше не меняется
    (план 2.11, правило 5). Если версия к этому моменту ушла из forward/live, сигнал не пишется.

    ``inputs`` — вход, на котором ``evaluate`` дал этого кандидата. Если он передан, вместе с
    сигналом в ``rationale_facts['inputs']`` пишется отпечаток входа
    (``engine.signal.inputs_fingerprint``): по нему ежедневная сверка отличает «данные в БД
    изменились после публикации» от «тот же вход теперь даёт другой сигнал».

    Не пишется и кандидат по занятому инструменту — правило «одна открытая сделка на инструмент
    и версию», как в бэктесте (``open_trade_blocker``): пропуск идёт в журнал на уровне INFO с
    инструментом, версией и ``public_id`` мешающего сигнала. Проверка и вставка идут под
    блокировкой пары (``lock_signal_pair``), она держится до commit вызывающего.

    Правило касается кандидатов, которые в бэктесте становятся сделками. Кандидат ниже порога
    публикации или отложенный пишется, как и раньше (с пометкой в ``rationale_facts``): в
    бэктесте он не сделка, поэтому под правило не подпадает и инструмент не занимает.
    """
    lock_signal_pair(session, version.id, inst.id)
    exists = session.scalar(
        select(Signal.id).where(
            Signal.strategy_version_id == version.id,
            Signal.instrument_id == inst.id,
            Signal.candle_close_time == cand.candle_close_time,
        )
    )
    if exists:
        return False
    status = session.scalar(select(StrategyVersion.status).where(StrategyVersion.id == version.id))
    scope = scope_at_publication(status or "")
    if scope is None:
        log.warning(
            "%s %s: версия в статусе %s — сигнал не записан", inst.symbol, version.version, status
        )
        return False
    becomes_trade = cand.score.publishable and not cand.deferred  # как в run_backtest
    blocker = (
        open_trade_blocker(session, version, inst, cand.candle_close_time)
        if becomes_trade
        else None
    )
    if blocker is not None:
        log.info(
            BUSY_LOG,
            cand.candle_close_time.strftime("%d.%m %H:%M"),
            inst.symbol,
            version.version,
            blocker.ref,
            _blocker_state(blocker),
        )
        return False
    t = cand.trade
    facts: dict[str, Any] = {
        "facts": list(cand.facts),
        "publishable": cand.score.publishable,
        "deferred": cand.deferred,
        "zone": {
            "kind": cand.zone.kind,
            "top": str(cand.zone.top),
            "bottom": str(cand.zone.bottom),
        },
        "flags": cand.filters.flags,
    }
    if inputs is not None:
        facts[INPUTS_FACT] = inputs_fingerprint(inputs, cand.candle_close_time)
    sig = Signal(
        public_id=secrets.token_hex(5),
        strategy_version_id=version.id,
        instrument_id=inst.id,
        direction="long" if cand.direction is Direction.UP else "short",
        candle_close_time=cand.candle_close_time,
        entry_market=t.entry_market,
        entry_limit=t.entry_limit,
        stop_loss=t.stop_loss,
        tp1=t.tp1,
        tp2=t.tp2,
        tp3=t.tp3,
        rr_tp2=t.rr_tp2,
        score=cand.score.total,
        grade=cand.score.grade.value if cand.score.publishable else "C",
        score_breakdown=dict(cand.score.components),
        rationale_facts=facts,
        status="pending",
        scope=scope,
        input_hash=cand.input_hash,
    )
    session.add(sig)
    session.flush()
    session.add(
        SignalEvent(
            signal_id=sig.id, type="created", occurred_at=cand.candle_close_time, source="engine"
        )
    )
    return True


def _setup_from_row(sig: Signal) -> TradeSetup:
    direction = Direction.UP if sig.direction == "long" else Direction.DOWN
    sign = 1 if direction is Direction.UP else -1
    risk = (sig.entry_market - sig.stop_loss) * sign
    return TradeSetup(
        direction,
        sig.entry_market,
        sig.entry_limit or sig.entry_market,
        sig.stop_loss,
        sig.tp1,
        sig.tp2,
        sig.tp3,
        risk,
        sig.rr_tp2,
        (),
    )


def _status_from_result(r: TradeResult) -> str:
    return signal_status(r).value


def track_open_signals(session: Session, versions: dict[str, StrategyVersion]) -> int:
    """Пересчитывает статусы по свечам H4 после сигнальной тем же кодом, что бэктест."""
    version_ids = [v.id for v in versions.values()]
    if not version_ids:
        return 0
    open_rows = session.scalars(
        select(Signal).where(
            Signal.strategy_version_id.in_(version_ids),
            Signal.status.in_(["pending", "active", "tp1_hit", "tp2_hit"]),
        )
    ).all()
    changed = 0
    for sig in open_rows:
        params = STRATEGIES[next(k for k, v in versions.items() if v.id == sig.strategy_version_id)]
        after = session.execute(
            text(
                "select open_time, open, high, low, close, volume, quote_volume, trades "
                "from candles where instrument_id = :i and timeframe = '4h' "
                "and open_time >= :t order by open_time"
            ),
            {"i": sig.instrument_id, "t": sig.candle_close_time},
        ).all()
        candles = [
            Candle(r[0].astimezone(UTC), r[1], r[2], r[3], r[4], r[5], r[6], r[7]) for r in after
        ]
        result = simulate_trade(_setup_from_row(sig), candles, params.trade, DEFAULT_EXECUTION)
        new_status = _status_from_result(result)
        if new_status == sig.status:
            continue
        order = ["pending", "active", "tp1_hit", "tp2_hit"]
        # промежуточные события, если за один прогон пройдено несколько ступеней
        path = (
            order[order.index(sig.status) + 1 : order.index(new_status) + 1]
            if new_status in order
            else ([*order[order.index(sig.status) + 1 :], new_status])
        )
        last_time = (
            candles[result.exit_index].close_time(Timeframe.H4)
            if result.exit_index is not None
            else (candles[-1].close_time(Timeframe.H4) if candles else sig.candle_close_time)
        )
        for st in path:
            session.add(
                SignalEvent(
                    signal_id=sig.id,
                    type=EVENT_BY_STATUS[st],
                    occurred_at=last_time,
                    source="tracker",
                )
            )
        sig.status = new_status
        if new_status.startswith("closed"):
            session.add(
                SignalResult(
                    signal_id=sig.id,
                    realized_r=result.realized_r,
                    realized_r_tp1_only=result.r_if_tp1_only,
                    realized_r_full_tp2=result.r_if_full_tp2,
                    cost_r=result.cost_r,
                    duration_hours=Decimal((last_time - sig.candle_close_time).total_seconds())
                    / 3600,
                    max_favorable_r=result.max_favorable_r,
                    max_adverse_r=result.max_adverse_r,
                    closed_at=last_time,
                    entry_type_used="market",
                )
            )
        changed += 1
    session.commit()
    return changed


# --- прогон -----------------------------------------------------------------------------------


def run_forward(
    symbols: list[str] | None = None,
    refresh: bool = True,
    now: datetime | None = None,
    track: bool = True,
) -> dict[str, int]:
    now = now or datetime.now(tz=UTC)
    at = last_h4_close(now)
    stats = {"instruments": 0, "signals": 0, "no_signal": 0, "tracked": 0}
    with SessionLocal() as session:
        q = select(Instrument).where(Instrument.market_type == "futures", Instrument.is_active)
        if symbols:
            q = q.where(Instrument.symbol.in_(symbols))
        # постоянный порядок: блокировки пар (версия, инструмент) копятся до commit в конце
        # прогона, и два одновременных прогона с разным порядком строк блокировали бы друг друга
        instruments = list(session.scalars(q.order_by(Instrument.id)).all())
        stats["instruments"] = len(instruments)
        if refresh:
            refresh_market_data(session, instruments, now)
        rows = sync_strategy_versions(session)
        for key, status in skipped_versions(rows).items():
            print(SKIPPED_VERSION_LOG % (key, status), flush=True)
        versions = evaluated_versions(rows)
        for inst in instruments:
            inputs = load_inputs(session, inst, at)
            for key, version in versions.items():
                params: StrategyParams = STRATEGIES[key]
                res = evaluate(inputs, at, params)
                if isinstance(res, SignalCandidate):
                    if write_candidate(session, version, inst, res, inputs):
                        stats["signals"] += 1
                        print(
                            f"{at:%d.%m %H:%M} {inst.symbol} {key}: {res.direction} "
                            f"{res.score.grade} {res.score.total}",
                            flush=True,
                        )
                elif isinstance(res, NoSignal) and res.stage not in ("bias", "trigger"):
                    stats["no_signal"] += 1
                    print(
                        f"{at:%d.%m %H:%M} {inst.symbol} {key}: нет сигнала "
                        f"({res.stage}: {res.reason[:80]})",
                        flush=True,
                    )
        session.commit()
        stats["tracked"] = track_open_signals(session, versions) if track else 0
    return stats
