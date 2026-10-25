"""Фильтры сигнала (план 2.5). Каждый фильтр — чистая функция, возвращающая ``FilterResult``
с действием, вкладом в скоринг и причиной. Итог собирает ``run_filters``.

Действия:
- ``block`` — сигнал не генерируется;
- ``defer`` — отложить публикацию (новости);
- ``flag`` — пометка в карточке, скоринг не меняется (но может менять риск);
- ``pass`` — пройден, может нести бонус/штраф в ``score_delta``.

Все расчёты — только по данным не позже момента ``at`` (закрытие сигнальной свечи).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from enum import StrEnum

from engine.candles import Candle, Timeframe
from engine.derivatives import (
    CalendarEvent,
    FundingRate,
    LiquidationBucket,
    LongShortRatio,
    OpenInterest,
    TokenEvent,
    upto,
)
from engine.indicators import atr
from engine.params import FilterParams
from engine.structure import Direction, EventType, MarketStructure


class FilterAction(StrEnum):
    PASS = "pass"
    BLOCK = "block"
    DEFER = "defer"
    FLAG = "flag"


@dataclass(frozen=True, slots=True)
class FilterResult:
    name: str
    action: FilterAction
    reason: str
    score_delta: int = 0
    risk_multiplier: Decimal = Decimal(1)
    data: dict[str, str] = field(default_factory=dict)

    @property
    def blocks(self) -> bool:
        return self.action is FilterAction.BLOCK


@dataclass(frozen=True, slots=True)
class FilterSummary:
    results: tuple[FilterResult, ...]

    @property
    def blocked(self) -> bool:
        return any(r.action is FilterAction.BLOCK for r in self.results)

    @property
    def deferred(self) -> bool:
        return any(r.action is FilterAction.DEFER for r in self.results)

    @property
    def score_delta(self) -> int:
        return sum(r.score_delta for r in self.results)

    @property
    def risk_multiplier(self) -> Decimal:
        m = Decimal(1)
        for r in self.results:
            m *= r.risk_multiplier
        return m

    @property
    def flags(self) -> list[str]:
        return [r.reason for r in self.results if r.action is FilterAction.FLAG]

    @property
    def block_reasons(self) -> list[str]:
        return [r.reason for r in self.results if r.action is FilterAction.BLOCK]


def _pct(x: Decimal) -> str:
    return f"{x * 100:.3f} %"


def _percentile_rank(values: Sequence[Decimal], x: Decimal) -> Decimal:
    """Доля значений, не превышающих x (0–1)."""
    if not values:
        return Decimal(0)
    return Decimal(sum(1 for v in values if v <= x)) / len(values)


# --- фильтры по свечам -------------------------------------------------------------------


def atr_regime(candles: Sequence[Candle], params: FilterParams) -> FilterResult:
    """ATR/цена в [p10; p90] за ``atr_window`` свечей; иначе блок (флэт или паника)."""
    values = atr(candles, params.atr_period)
    ratios = [
        v / c.close for v, c in zip(values, candles, strict=True) if v is not None and c.close
    ]
    if len(ratios) < params.atr_min_history:
        return FilterResult(
            "atr_regime", FilterAction.PASS, "ATR-режим: мало истории, не проверялся"
        )
    window = ratios[-params.atr_window :]
    current = window[-1]
    rank = _percentile_rank(window, current)
    data = {"atr_pct": _pct(current), "percentile": f"{rank * 100:.0f}"}
    if rank < params.atr_low_pct:
        return FilterResult(
            "atr_regime",
            FilterAction.BLOCK,
            f"ATR-режим: волатильность низкая (p{rank * 100:.0f})",
            data=data,
        )
    if rank > params.atr_high_pct:
        return FilterResult(
            "atr_regime",
            FilterAction.BLOCK,
            f"ATR-режим: волатильность экстремальная (p{rank * 100:.0f})",
            data=data,
        )
    delta = -params.atr_top_decile_penalty if rank > params.atr_top_decile else 0
    return FilterResult(
        "atr_regime", FilterAction.PASS, f"ATR-режим: в норме (p{rank * 100:.0f})", delta, data=data
    )


def volume_filter(candles: Sequence[Candle], bos_index: int, params: FilterParams) -> FilterResult:
    """Объём свечи BOS относительно среднего за ``volume_avg_window``."""
    start = max(0, bos_index - params.volume_avg_window)
    window = candles[start:bos_index]
    if not window:
        return FilterResult("volume", FilterAction.PASS, "Объём: нет истории для среднего")
    avg = sum((c.volume for c in window), Decimal(0)) / len(window)
    if avg == 0:
        return FilterResult("volume", FilterAction.PASS, "Объём: средний объём нулевой")
    ratio = candles[bos_index].volume / avg
    data = {"ratio": f"{ratio:.2f}"}
    if ratio >= params.volume_strong_ratio:
        return FilterResult(
            "volume",
            FilterAction.PASS,
            f"Объём импульса {ratio:.1f}× среднего",
            params.volume_strong_bonus,
            data=data,
        )
    if ratio >= params.volume_min_ratio:
        return FilterResult(
            "volume",
            FilterAction.PASS,
            f"Объём импульса {ratio:.1f}× среднего",
            params.volume_weak_bonus,
            data=data,
        )
    return FilterResult(
        "volume",
        FilterAction.PASS,
        f"Объём импульса {ratio:.1f}× среднего — слабый",
        -params.volume_penalty,
        data=data,
    )


def session_label(at: datetime) -> str:
    h = at.hour
    if 0 <= h < 8:
        return "asia"
    if 8 <= h < 13:
        return "europe"
    if 13 <= h < 21:
        return "us"
    return "late_us"


def session_filter(candles: Sequence[Candle], index: int, params: FilterParams) -> FilterResult:
    """Сессия — информация; выходные с низким объёмом — штраф."""
    c = candles[index]
    label = session_label(c.open_time)
    data = {"session": label}
    if c.open_time.weekday() >= 5:
        start = max(0, index - params.volume_avg_window)
        window = candles[start:index]
        avg = sum((x.volume for x in window), Decimal(0)) / len(window) if window else Decimal(0)
        if avg and c.volume < params.weekend_volume_ratio * avg:
            return FilterResult(
                "session",
                FilterAction.PASS,
                "Выходные, низкая ликвидность",
                -params.weekend_penalty,
                data=data,
            )
    return FilterResult("session", FilterAction.PASS, f"Сессия: {label}", data=data)


def fresh_choch(
    structure: MarketStructure, direction: Direction, index: int, params: FilterParams
) -> FilterResult:
    """CHoCH против направления за последние N свечей без последующего BOS по направлению."""
    recent = [e for e in structure.events if index - e.index < params.choch_lookback]
    against = [e for e in recent if e.type is EventType.CHOCH and e.direction is not direction]
    if not against:
        return FilterResult(
            "fresh_choch", FilterAction.PASS, "Свежего CHoCH против направления нет"
        )
    last = against[-1]
    confirmed_after = any(
        e.type is EventType.BOS and e.direction is direction and e.index > last.index
        for e in recent
    )
    if confirmed_after:
        return FilterResult(
            "fresh_choch", FilterAction.PASS, "CHoCH против был, но перекрыт BOS по направлению"
        )
    return FilterResult(
        "fresh_choch",
        FilterAction.BLOCK,
        f"Свежий CHoCH против направления ({last.time:%d.%m %H:%M} UTC)",
    )


# --- внешние данные ----------------------------------------------------------------------


def news_filter(
    events: Sequence[CalendarEvent], at: datetime, params: FilterParams
) -> FilterResult:
    """Окно вокруг событий высокой важности — отложить; событие в ближайшие 12 ч — штраф."""
    before, after = (
        timedelta(hours=params.news_hours_before),
        timedelta(hours=params.news_hours_after),
    )
    for e in events:
        if e.importance < params.news_min_importance:
            continue
        if e.time - before <= at <= e.time + after:
            return FilterResult(
                "news",
                FilterAction.DEFER,
                f"Новость высокой важности: {e.title} ({e.time:%d.%m %H:%M} UTC)",
            )
    soon = [
        e
        for e in events
        if e.importance >= params.news_min_importance
        and at < e.time <= at + timedelta(hours=params.news_soon_hours)
    ]
    if soon:
        return FilterResult(
            "news",
            FilterAction.PASS,
            f"Новость в ближайшие {params.news_soon_hours} ч: {soon[0].title}",
            -params.news_soon_penalty,
        )
    return FilterResult("news", FilterAction.PASS, "Новостей высокой важности рядом нет")


@dataclass(frozen=True, slots=True)
class ActiveSignalRef:
    symbol: str
    direction: Direction
    correlation: Decimal
    """Корреляция дневных доходностей с инструментом кандидата."""


def correlation_filter(
    symbol: str,
    direction: Direction,
    active: Sequence[ActiveSignalRef],
    btc_bias_direction: Direction | None,
    params: FilterParams,
) -> FilterResult:
    """Активный сигнал по коррелирующему инструменту — пометка и риск пополам.
    Альт против направления BTC-bias — блок."""
    if (
        symbol != params.btc_symbol
        and btc_bias_direction is not None
        and btc_bias_direction is not direction
    ):
        return FilterResult(
            "correlation", FilterAction.BLOCK, f"Направление против bias {params.btc_symbol} на D1"
        )
    same = [
        a
        for a in active
        if a.direction is direction and a.correlation > params.correlation_threshold
    ]
    if same:
        names = ", ".join(a.symbol for a in same)
        return FilterResult(
            "correlation",
            FilterAction.FLAG,
            f"Коррелирует с активным сигналом: {names}",
            -params.correlation_penalty,
            risk_multiplier=params.correlation_risk_multiplier,
        )
    return FilterResult("correlation", FilterAction.PASS, "Коррелирующих активных сигналов нет")


def turnover_filter(avg_daily_turnover: Decimal | None, params: FilterParams) -> FilterResult:
    if avg_daily_turnover is None:
        return FilterResult("turnover", FilterAction.PASS, "Оборот: нет данных")
    if avg_daily_turnover < params.min_daily_turnover:
        return FilterResult(
            "turnover",
            FilterAction.BLOCK,
            f"Средний дневной оборот {avg_daily_turnover / 10**6:.0f} млн USDT ниже порога",
        )
    return FilterResult("turnover", FilterAction.PASS, "Оборот достаточный")


def funding_filter(
    funding: Sequence[FundingRate], at: datetime, direction: Direction, params: FilterParams
) -> FilterResult:
    """Funding против сигнала — бонус; экстремальный в сторону сигнала — блок (перегрев)."""
    rows = upto(funding, at)
    if not rows:
        return FilterResult("funding", FilterAction.PASS, "Funding: нет данных")
    current = rows[-1].rate
    sign = 1 if direction is Direction.UP else -1
    aligned = current * sign  # положительно, если funding «в сторону» сигнала
    history = [
        r.rate * sign for r in rows if r.time >= at - timedelta(days=params.funding_history_days)
    ]
    rank = _percentile_rank(history, aligned)
    data = {"funding": _pct(current), "percentile": f"{rank * 100:.0f}"}
    if aligned >= params.funding_overheat and rank > params.funding_overheat_pct:
        return FilterResult(
            "funding",
            FilterAction.BLOCK,
            f"Funding {_pct(current)} в сторону сигнала — перегрев (p{rank * 100:.0f})",
            data=data,
        )
    if aligned <= -params.funding_contrarian:
        return FilterResult(
            "funding",
            FilterAction.PASS,
            f"Funding {_pct(current)} против сигнала — топливо",
            params.funding_bonus,
            data=data,
        )
    return FilterResult(
        "funding", FilterAction.PASS, f"Funding {_pct(current)} нейтральный", data=data
    )


def open_interest_filter(
    oi: Sequence[OpenInterest],
    candles: Sequence[Candle],
    leg_start: int,
    leg_end: int,
    direction: Direction,
    params: FilterParams,
) -> FilterResult:
    """Изменение OI за импульсную ногу и за 24 ч."""
    at = candles[leg_end].close_time(Timeframe.H4)
    rows = upto(oi, at)
    if len(rows) < 2:
        return FilterResult("open_interest", FilterAction.PASS, "OI: нет данных")
    start_time = candles[leg_start].open_time
    before = [r for r in rows if r.time <= start_time]
    if not before or before[-1].value == 0:
        return FilterResult("open_interest", FilterAction.PASS, "OI: нет данных на начало импульса")
    change = (rows[-1].value - before[-1].value) / before[-1].value
    price_up = candles[leg_end].close > candles[leg_start].close
    with_direction = price_up if direction is Direction.UP else not price_up
    data = {"oi_change": _pct(change)}
    day_ago = [r for r in rows if r.time <= at - timedelta(hours=24)]
    if day_ago and day_ago[-1].value:
        change_24h = (rows[-1].value - day_ago[-1].value) / day_ago[-1].value
        data["oi_change_24h"] = _pct(change_24h)
        atr_values = atr(candles, params.atr_period)
        a = atr_values[leg_end]
        idx_24h = max(0, leg_end - 6)
        price_move = abs(candles[leg_end].close - candles[idx_24h].close)
        if change_24h >= params.oi_accumulation_24h and a is not None and price_move < a:
            return FilterResult(
                "open_interest",
                FilterAction.FLAG,
                f"OI +{change_24h * 100:.0f} % за 24 ч без движения цены — риск каскада ликвидаций",
                data=data,
            )
    if with_direction and change >= params.oi_confirm_change:
        return FilterResult(
            "open_interest",
            FilterAction.PASS,
            f"OI {_pct(change)} за импульс — новые позиции по направлению",
            params.oi_confirm_bonus,
            data=data,
        )
    if with_direction and change < 0:
        return FilterResult(
            "open_interest",
            FilterAction.PASS,
            f"OI {_pct(change)} за импульс — движение на закрытии позиций",
            -params.oi_squeeze_penalty,
            data=data,
        )
    return FilterResult(
        "open_interest", FilterAction.PASS, f"OI {_pct(change)} за импульс", data=data
    )


def liquidation_filter(
    buckets: Sequence[LiquidationBucket],
    at: datetime,
    direction: Direction,
    params: FilterParams,
) -> FilterResult:
    """Кластер ликвидаций против сигнала перед ретестом — аналог снятия ликвидности."""
    rows = upto(buckets, at)
    if len(rows) < params.liq_avg_buckets + 1:
        return FilterResult("liquidations", FilterAction.PASS, "Ликвидации: мало данных")

    def opposite(b: LiquidationBucket) -> Decimal:
        return b.long_usd if direction is Direction.UP else b.short_usd

    recent = rows[-params.liq_recent_buckets :]
    history = rows[-params.liq_avg_buckets - params.liq_recent_buckets : -params.liq_recent_buckets]
    avg = sum((opposite(b) for b in history), Decimal(0)) / len(history) if history else Decimal(0)
    peak = max(opposite(b) for b in recent)
    if avg == 0:
        return FilterResult("liquidations", FilterAction.PASS, "Ликвидации: нет базы для сравнения")
    ratio = peak / avg
    data = {"ratio": f"{ratio:.1f}"}
    if ratio >= params.liq_cluster_ratio:
        side = "лонгов" if direction is Direction.UP else "шортов"
        return FilterResult(
            "liquidations",
            FilterAction.PASS,
            f"Каскад ликвидаций {side} {ratio:.1f}× среднего перед входом",
            params.liq_bonus,
            data=data,
        )
    return FilterResult("liquidations", FilterAction.PASS, "Ликвидации в норме", data=data)


def long_short_filter(
    ratios: Sequence[LongShortRatio], at: datetime, direction: Direction, params: FilterParams
) -> FilterResult:
    rows = upto(ratios, at)
    if not rows:
        return FilterResult("long_short", FilterAction.PASS, "Long/short: нет данных")
    long_pct = rows[-1].long_pct
    crowd = long_pct if direction is Direction.UP else 1 - long_pct
    data = {"crowd_pct": f"{crowd * 100:.0f}"}
    if crowd > params.crowd_threshold:
        return FilterResult(
            "long_short",
            FilterAction.PASS,
            f"Толпа {crowd * 100:.0f} % в сторону сигнала — переполнено",
            -params.crowd_penalty,
            data=data,
        )
    return FilterResult(
        "long_short", FilterAction.PASS, f"Толпа {crowd * 100:.0f} % в сторону сигнала", data=data
    )


def token_events_filter(
    events: Sequence[TokenEvent], at: datetime, direction: Direction, params: FilterParams
) -> FilterResult:
    """Разблокировка ≥ порога в ближайшие 72 ч: лонг — блок, шорт — пометка."""
    soon = [
        e
        for e in events
        if e.kind == "unlock"
        and e.pct_supply >= params.unlock_min_pct
        and at <= e.time <= at + timedelta(hours=params.unlock_hours_ahead)
    ]
    if not soon:
        return FilterResult("token_events", FilterAction.PASS, "Разблокировок рядом нет")
    e = soon[0]
    reason = f"Разблокировка {e.pct_supply * 100:.1f} % предложения {e.time:%d.%m} UTC"
    if direction is Direction.UP:
        return FilterResult("token_events", FilterAction.BLOCK, reason)
    return FilterResult("token_events", FilterAction.FLAG, reason)


def run_filters(results: Sequence[FilterResult]) -> FilterSummary:
    return FilterSummary(tuple(results))
