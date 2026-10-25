"""Форвард-тест (задача 1.11): прогон стратегии на живых данных без публикации.

Запускается по расписанию через 1–2 минуты после закрытия каждой свечи H4 (cron ``2 */4 * * *``):
1. догружает свежие свечи H4/D1/W1 и деривативы по REST Binance в БД (временная замена
   сервиса market-data этапа 2);
2. для каждого инструмента вызывает ``evaluate`` на момент последнего закрытия H4 по каждой
   версии стратегии в статусе ``forward``; кандидат записывается в ``signals`` (статус pending,
   событие created), повторный запуск ничего не дублирует (уникальный индекс);
3. ведёт открытые форвард-сигналы по свечам H4 тем же кодом, что бэктест (``simulate_trade``):
   меняет статус через ``signal_events``, закрытые — в ``signal_results``.

Результаты видны только в БД и в /debug; пользователям форвард не показывается (план 2.11).
"""

from __future__ import annotations

import secrets
import sys
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

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
from engine.backtest import DEFAULT_EXECUTION, TradeResult, TradeStatus, simulate_trade
from engine.candles import Candle, Timeframe
from engine.data.binance import BinanceHistory
from engine.derivatives import FundingRate, LongShortRatio, OpenInterest
from engine.params import StrategyParams
from engine.signal import MarketInputs, NoSignal, SignalCandidate, evaluate
from engine.strategies import STRATEGIES
from engine.structure import Direction
from engine.trade import TradeSetup

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))

STRATEGY_SLUG = "trend-ob-retest"
H4_WINDOW = 700
STATUS_BY_RESULT = {
    TradeStatus.EXPIRED: "expired",
    TradeStatus.CLOSED_SL: "closed_sl",
    TradeStatus.CLOSED_BE: "closed_be",
    TradeStatus.CLOSED_TP3: "closed_tp3",
    TradeStatus.CLOSED_TIME: "closed_time",
}
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
                    for k in ("open", "high", "low", "close", "volume", "quote_volume", "trades")
                },
            )
        )


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
        ls = client.get(
            f"{base}/futures/data/topLongShortAccountRatio",
            params={"symbol": inst.symbol, "period": "1h", "limit": 48},
        ).json()
        if isinstance(ls, list) and ls:
            stmt = insert(LongShortRatioRow).values(
                [
                    {
                        "instrument_id": inst.id,
                        "time": datetime.fromtimestamp(int(r["timestamp"]) / 1000, tz=UTC),
                        "top_traders_ratio": Decimal(str(r["longShortRatio"])),
                        "global_ratio": Decimal(str(r["longShortRatio"])),
                    }
                    for r in ls
                ]
            )
            session.execute(stmt.on_conflict_do_nothing(index_elements=["instrument_id", "time"]))
    except Exception as exc:
        print(f"{inst.symbol}: деривативы не обновлены: {type(exc).__name__}: {exc}", flush=True)


def _candles(session: Session, instrument_id: int, tf: Timeframe, limit: int) -> list[Candle]:
    rows = session.execute(
        text(
            "select open_time, open, high, low, close, volume, quote_volume, trades from candles "
            "where instrument_id = :i and timeframe = :tf order by open_time desc limit :n"
        ),
        {"i": instrument_id, "tf": tf.value, "n": limit},
    ).all()
    return [
        Candle(r[0].astimezone(UTC), r[1], r[2], r[3], r[4], r[5], r[6], r[7])
        for r in reversed(rows)
    ]


def load_inputs(session: Session, inst: Instrument, at: datetime) -> MarketInputs:
    since = at - timedelta(days=95)
    f = session.execute(
        text(
            "select funding_time, rate from funding_rates "
            "where instrument_id=:i and funding_time>=:s order by 1"
        ),
        {"i": inst.id, "s": since},
    ).all()
    oi = session.execute(
        text(
            "select time, oi_quote from open_interest "
            "where instrument_id=:i and time>=:s order by 1"
        ),
        {"i": inst.id, "s": since},
    ).all()
    ls = session.execute(
        text(
            "select time, top_traders_ratio from long_short_ratios "
            "where instrument_id=:i and time>=:s order by 1"
        ),
        {"i": inst.id, "s": since},
    ).all()
    return MarketInputs(
        symbol=inst.symbol,
        h4=_candles(session, inst.id, Timeframe.H4, H4_WINDOW),
        d1=_candles(session, inst.id, Timeframe.D1, 400),
        w1=_candles(session, inst.id, Timeframe.W1, 120),
        funding=[FundingRate(r[0].astimezone(UTC), r[1]) for r in f],
        open_interest=[OpenInterest(r[0].astimezone(UTC), r[1]) for r in oi],
        long_short=[LongShortRatio(r[0].astimezone(UTC), r[1] / (1 + r[1])) for r in ls],
        avg_daily_turnover=inst.avg_volume_30d,
    )


# --- версии стратегий -------------------------------------------------------------------------


def ensure_strategy_versions(session: Session) -> dict[str, StrategyVersion]:
    """Создаёт strategies/strategy_versions для версий из engine.strategies (статус forward)."""
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
                status="forward",
                created_by="forward.py",
                changelog="автоматически из engine.strategies",
            )
            session.add(row)
            session.flush()
        out[key] = row
    session.commit()
    return {k: v for k, v in out.items() if v.status in ("forward", "live")}


# --- сигналы ----------------------------------------------------------------------------------


def write_candidate(
    session: Session, version: StrategyVersion, inst: Instrument, cand: SignalCandidate
) -> bool:
    exists = session.scalar(
        select(Signal.id).where(
            Signal.strategy_version_id == version.id,
            Signal.instrument_id == inst.id,
            Signal.candle_close_time == cand.candle_close_time,
        )
    )
    if exists:
        return False
    t = cand.trade
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
        rationale_facts={
            "facts": list(cand.facts),
            "publishable": cand.score.publishable,
            "deferred": cand.deferred,
            "zone": {
                "kind": cand.zone.kind,
                "top": str(cand.zone.top),
                "bottom": str(cand.zone.bottom),
            },
            "flags": cand.filters.flags,
        },
        status="pending",
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
    if r.status in STATUS_BY_RESULT:
        return STATUS_BY_RESULT[r.status]
    return {0: "active", 1: "tp1_hit", 2: "tp2_hit"}[min(r.tp_hits, 2)]


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
        instruments = list(session.scalars(q).all())
        stats["instruments"] = len(instruments)
        if refresh:
            refresh_market_data(session, instruments, now)
        versions = ensure_strategy_versions(session)
        for inst in instruments:
            inputs = load_inputs(session, inst, at)
            for key, version in versions.items():
                params: StrategyParams = STRATEGIES[key]
                res = evaluate(inputs, at, params)
                if isinstance(res, SignalCandidate):
                    if write_candidate(session, version, inst, res):
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
