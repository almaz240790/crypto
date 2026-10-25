"""Мониторинг: оценка снимка (приёмка 2.16 — алерт на имитации пропуска свечи)."""

from __future__ import annotations

from datetime import UTC, datetime

from app.monitor import Component, Snapshot, evaluate, last_h4_close, overall


def _snap(**kw: object) -> Snapshot:
    now = datetime(2026, 10, 25, 16, 5, tzinfo=UTC)  # 5 минут после закрытия H4 16:00
    base = dict(
        now=now,
        heartbeats={"market_data": 1, "scheduler": 30, "tracker": 30, "notifier": 10},
        m1_age_sec=30,
        h4_stale=0,
        h4_total=59,
        engine_last_h4=last_h4_close(now),
        api_db_ok=True,
        redis_ok=True,
    )
    base.update(kw)
    return Snapshot(**base)  # type: ignore[arg-type]


def _by(comps: list[Component]) -> dict[str, Component]:
    return {c.key: c for c in comps}


def test_all_ok() -> None:
    comps = evaluate(_snap())
    assert overall(comps) == "ok" and all(c.status == "ok" for c in comps)


def test_missing_candle_triggers_alert() -> None:
    """Имитация пропуска свечи: у 4 из 59 инструментов нет закрытия H4 спустя > 2 мин."""
    c = _by(evaluate(_snap(h4_stale=4)))
    assert c["candles"].status == "down"  # 4/59 ≈ 6.8 % > 5 %
    assert "4 из 59" in c["candles"].detail
    c2 = _by(evaluate(_snap(h4_stale=2)))
    assert c2["candles"].status == "degraded"
    # в пределах 2 минут после закрытия — ещё не алерт
    early = _snap(now=datetime(2026, 10, 25, 16, 1, tzinfo=UTC), h4_stale=10)
    assert _by(evaluate(early))["candles"].status == "ok"


def test_engine_not_run_and_stream_silent() -> None:
    c = _by(evaluate(_snap(engine_last_h4=datetime(2026, 10, 25, 12, tzinfo=UTC))))
    assert c["engine"].status == "down" and "нет прогона" in c["engine"].detail
    c = _by(evaluate(_snap(m1_age_sec=400)))
    assert c["data"].status == "down"
    c = _by(
        evaluate(
            _snap(heartbeats={"market_data": None, "scheduler": 30, "tracker": 30, "notifier": 10})
        )
    )
    assert c["data"].status == "down"
    c = _by(evaluate(_snap(redis_ok=False)))
    assert c["api"].status == "down" and overall(evaluate(_snap(redis_ok=False))) == "down"


def test_parse_done_key_is_utc_aware() -> None:
    from app.monitor import parse_done_key

    d = parse_done_key("sched:done:BTCUSDT:20261025T0800")
    assert d == datetime(2026, 10, 25, 8, tzinfo=UTC)
    assert d.tzinfo is not None
    assert parse_done_key("sched:done:BTCUSDT:bad") is None
