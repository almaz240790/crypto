"""Правило «одна открытая сделка на инструмент и версию» (``engine.lifecycle``; задача 6).

Чистое правило: статусы, границы свечи выхода, отсутствие «утечки будущего», проверка входа и
совпадение с прежним правилом ``run_backtest`` (``i <= busy_until``).
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta, timezone

import pytest

import engine.lifecycle as lifecycle
import engine.tracker as tracker
from engine.candles import SIGNAL_TIMEFRAME, Timeframe
from engine.lifecycle import SignalLife, SignalStatus, blocking_signal

T0 = datetime(2026, 11, 2, 8, tzinfo=UTC)
H4 = SIGNAL_TIMEFRAME.delta
M1 = timedelta(minutes=1)
AT = T0 + H4 * 5
"""Момент проверки: закрытие сигнальной свечи нового кандидата."""

OPEN = (
    SignalStatus.PENDING,
    SignalStatus.ACTIVE,
    SignalStatus.TP1_HIT,
    SignalStatus.TP2_HIT,
)
CLOSED = (
    SignalStatus.CLOSED_TP3,
    SignalStatus.CLOSED_BE,
    SignalStatus.CLOSED_SL,
    SignalStatus.CLOSED_TIME,
)
NO_TRADE = (SignalStatus.EXPIRED, SignalStatus.CANCELLED)


def life(
    status: SignalStatus,
    closed_at: datetime | None = None,
    opened_at: datetime = T0,
    ref: str = "a",
) -> SignalLife:
    return SignalLife(ref, opened_at, status, closed_at)


def busy(signals: list[SignalLife], at: datetime = AT) -> bool:
    return blocking_signal(signals, at) is not None


# --- статусы -----------------------------------------------------------------------------------


def test_every_status_is_decided_by_the_rule() -> None:
    """Новый статус в ``SignalStatus`` должен попасть ровно в одну группу правила."""
    assert set(SignalStatus) == {*OPEN, *CLOSED, *NO_TRADE}
    assert all(s.is_open and not s.is_closed for s in OPEN)
    assert all(s.is_closed and not s.is_open for s in CLOSED)
    assert all(not s.is_open and not s.is_closed for s in NO_TRADE)


def test_signal_status_is_the_one_the_tracker_exports() -> None:
    assert tracker.SignalStatus is SignalStatus


def test_no_signals_means_free() -> None:
    assert blocking_signal([], AT) is None


@pytest.mark.parametrize("status", OPEN)
def test_open_signal_blocks(status: SignalStatus) -> None:
    signal = life(status)
    assert blocking_signal([signal], AT) is signal
    # сколько бы ни прошло времени: открытая сделка занимает инструмент, пока не закроется
    assert blocking_signal([signal], T0 + H4) is signal
    assert blocking_signal([signal], AT + H4 * 1000) is signal


@pytest.mark.parametrize("status", CLOSED)
def test_closed_trade_blocks_only_the_candle_it_closed_in(status: SignalStatus) -> None:
    # закрылась внутри свечи (AT − H4; AT] — на её закрытии инструмент ещё занят
    for closed_at in (AT - H4 + M1, AT - H4 * 0.5, AT - M1, AT):
        signal = life(status, closed_at)
        assert blocking_signal([signal], AT) is signal, closed_at
        assert not busy([signal], AT + H4), closed_at  # на следующем закрытии — свободен
    # ровно на открытии этой свечи (закрытие предыдущей) и раньше — свободен
    assert not busy([life(status, AT - H4)])
    assert not busy([life(status, AT - H4 - M1)])
    assert not busy([life(status, T0 + M1)])


@pytest.mark.parametrize("status", NO_TRADE)
def test_expired_and_cancelled_never_block(status: SignalStatus) -> None:
    assert not busy([life(status)])
    assert not busy([life(status)], T0 + H4)
    # даже если время истечения или отмены известно и попадает в сигнальную свечу
    assert not busy([life(status, AT - M1)])
    assert not busy([life(status, AT)])


def test_earliest_blocker_is_returned_in_any_input_order() -> None:
    first = life(SignalStatus.ACTIVE, ref="b")
    same_time = life(SignalStatus.TP1_HIT, ref="c")
    later = life(SignalStatus.CLOSED_SL, AT - M1, opened_at=T0 + H4, ref="a")
    free = life(SignalStatus.CLOSED_TIME, T0 + H4, ref="0")
    signals = [later, same_time, free, first]
    for seed in range(10):
        random.Random(seed).shuffle(signals)
        assert blocking_signal(iter(signals), AT) is first  # и итератор годится: один проход
    assert blocking_signal([later, free], AT) is later


def test_window_is_the_signal_timeframe(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ширина «свечи выхода» берётся из ``SIGNAL_TIMEFRAME``, а не зашита числом."""
    signal = life(SignalStatus.CLOSED_SL, AT - timedelta(hours=2))
    assert busy([signal])
    monkeypatch.setattr(lifecycle, "SIGNAL_TIMEFRAME", Timeframe.H1)
    assert not busy([signal])
    assert busy([life(SignalStatus.CLOSED_SL, AT - timedelta(minutes=59))])


# --- без утечки будущего -----------------------------------------------------------------------


def test_signals_appearing_at_or_after_the_moment_do_not_matter() -> None:
    for status in OPEN:
        assert not busy([life(status, opened_at=AT)])
        assert not busy([life(status, opened_at=AT + H4)])
    assert not busy([life(SignalStatus.CLOSED_SL, AT + H4 * 2, opened_at=AT + H4)])
    # а тот же сигнал, появившийся свечой раньше, мешает
    assert busy([life(SignalStatus.ACTIVE, opened_at=AT - H4)])


def test_trade_open_at_the_moment_blocks_whether_or_not_its_future_close_is_known() -> None:
    known_now = life(SignalStatus.ACTIVE)
    known_later = life(SignalStatus.CLOSED_TP3, AT + H4 * 3)
    assert busy([known_now]) and busy([known_later])


def known_at(history: list[SignalLife], at: datetime) -> list[SignalLife]:
    """Что о сигналах известно в момент ``at``: появившиеся раньше; сделка, которая закроется
    позже, пока открыта."""
    out = []
    for s in history:
        if s.opened_at >= at:
            continue
        if s.closed_at is not None and s.closed_at > at:
            out.append(SignalLife(s.ref, s.opened_at, SignalStatus.ACTIVE))
        else:
            out.append(s)
    return out


def test_answer_does_not_depend_on_what_happens_after_the_moment() -> None:
    """Утечка будущего: ответ по полной истории (с более поздними сигналами и закрытиями)
    совпадает с ответом по тому, что было известно в момент ``at``. Сделки — рыночного входа:
    открыты, пока не закрыты."""
    rng = random.Random(606)
    checked = blocked = 0
    for _ in range(300):
        history: list[SignalLife] = []
        for n in range(rng.randint(0, 6)):
            opened = T0 + H4 * rng.randint(0, 40)
            if rng.random() < 0.2:
                history.append(SignalLife(f"s{n}", opened, rng.choice(OPEN)))
                continue
            closed = opened + M1 * rng.randint(1, 80 * 60)
            history.append(SignalLife(f"s{n}", opened, rng.choice(CLOSED), closed))
        for _moment in range(20):
            at = T0 + H4 * rng.randint(0, 60)
            full = blocking_signal(history, at)
            then = blocking_signal(known_at(history, at), at)
            assert (full.ref if full else None) == (then.ref if then else None), (history, at)
            checked += 1
            blocked += full is not None
    assert 0 < blocked < checked  # проверены и «занят», и «свободен»


def test_limit_order_divergence_is_only_in_what_is_known() -> None:
    """Требование 3: живой режим не знает, что лимит истечёт, — ожидающий ордер (``pending``)
    занимает инструмент; бэктест знает исход сразу — ``expired`` не занимает. Правило одно,
    разница только в статусе, известном на момент проверки. То же с отменённым сигналом."""
    at = T0 + H4 * 2
    assert busy([life(SignalStatus.PENDING)], at)
    assert not busy([life(SignalStatus.EXPIRED)], at)
    assert busy([life(SignalStatus.ACTIVE)], at)
    assert not busy([life(SignalStatus.CANCELLED)], at)


# --- проверка входа ----------------------------------------------------------------------------


def test_naive_and_non_utc_times_are_rejected() -> None:
    naive = datetime(2026, 11, 2, 8)
    msk = datetime(2026, 11, 2, 11, tzinfo=timezone(timedelta(hours=3)))
    for bad in (naive, msk):
        with pytest.raises(ValueError, match="opened_at должен быть timezone-aware в UTC"):
            SignalLife("a", bad, SignalStatus.ACTIVE)
        with pytest.raises(ValueError, match="closed_at должен быть timezone-aware в UTC"):
            SignalLife("a", T0, SignalStatus.CLOSED_SL, bad)
        with pytest.raises(ValueError, match="at должен быть timezone-aware в UTC"):
            blocking_signal([], bad)


@pytest.mark.parametrize("status", CLOSED)
def test_closed_status_requires_close_time(status: SignalStatus) -> None:
    with pytest.raises(ValueError, match="без времени закрытия"):
        SignalLife("a", T0, status)


def test_close_before_the_signal_candle_is_rejected() -> None:
    with pytest.raises(ValueError, match="раньше сигнальной свечи"):
        SignalLife("a", T0, SignalStatus.CLOSED_SL, T0 - M1)
    assert SignalLife("a", T0, SignalStatus.CLOSED_SL, T0 + M1).closed_at == T0 + M1


# --- то же правило, что было в run_backtest ----------------------------------------------------


def test_matches_the_candle_index_rule_of_run_backtest() -> None:
    """Прежний ``run_backtest`` пропускал свечи ``i <= busy_until``: до свечи выхода включительно,
    а при незакрытой сделке — до конца данных; истёкший лимит не занимал ничего. Правило по
    времени даёт тот же ответ на каждой свече — и на ряду с пропусками свечей."""
    rng = random.Random(6)
    answers = {True: 0, False: 0}
    for _ in range(300):
        closes: list[datetime] = []  # закрытия свечей H4 по сетке, местами с пропусками
        t = T0
        for _candle in range(rng.randint(5, 80)):
            t += H4 * rng.choice([1, 1, 1, 1, 1, 2, 7])
            closes.append(t)
        signals: list[SignalLife] = []
        busy_until = -1
        for i, at in enumerate(closes):
            expected = i <= busy_until
            assert busy(signals, at) is expected, (signals, at)
            answers[expected] += 1
            if expected or rng.random() > 0.4:
                continue
            outcome = rng.choice(["closed", "closed", "closed", "expired", "open"])
            if outcome == "closed" and i + 1 < len(closes):
                exit_index = rng.randint(i + 1, min(len(closes) - 1, i + 16))
                busy_until = exit_index
                signals.append(SignalLife(f"s{i}", at, rng.choice(CLOSED), closes[exit_index]))
            elif outcome == "expired":
                signals.append(SignalLife(f"s{i}", at, SignalStatus.EXPIRED))
            else:  # данные закончились раньше выхода
                busy_until = len(closes)
                signals.append(SignalLife(f"s{i}", at, rng.choice(OPEN[1:])))
    assert answers[True] > 1000 and answers[False] > 1000
