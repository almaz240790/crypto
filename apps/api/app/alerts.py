"""Алерты на графике (план 2A.6; задача 2B.13): условия, проверка, срабатывание, доставка.

Типы: price (по 1m-свечам, ≤ 60 с), indicator (RSI/EMA/ATR по закрытию свечи TF),
zone (цена вошла в активную зону), structure (BOS/CHoCH), pattern (подтверждён свечной паттерн).
Срабатывание идемпотентно по (alert_id, triggered_at). Доставка — push/email по настройкам.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.chart_data import PAGE, bucket_start, load_candles
from app.config import settings
from app.mail import send_mail
from app.models import (
    Alert,
    AlertTrigger,
    Instrument,
    Pattern,
    User,
    Watchlist,
    WatchlistItem,
)
from app.notify import in_quiet_hours, limit_reached, settings_for, unsubscribe_footer
from app.push import send_to_user
from engine.candles import Candle, Timeframe, closed_only
from engine.indicators import atr, ema, rsi
from engine.patterns import PatternType, title
from engine.structure import Direction, analyze_structure
from engine.zones import analyze_zones

log = logging.getLogger("alerts")

TYPES = ("price", "indicator", "zone", "structure", "pattern")
FREQUENCIES = ("once", "every", "once_per_bar")
BAR_TFS = (Timeframe.M15, Timeframe.H1, Timeframe.H4, Timeframe.D1, Timeframe.W1)
STRUCTURE_TFS = (Timeframe.H4, Timeframe.D1)
DEFAULT_EXPIRES_DAYS = 30
INDICATOR_PERIODS = {"rsi": 14, "ema": 50, "atr": 14}
PRICE_OPS = ("cross_up", "cross_down", "enter_range")
INDICATOR_OPS = ("above", "below", "cross_up", "cross_down", "price_cross_up", "price_cross_down")
DISCLAIMER = "Алерт — уведомление по вашему условию, не рекомендация."


# --- валидация условий ----------------------------------------------------------------------------


def _dec(x: Any) -> Decimal:
    try:
        d = Decimal(str(x))
    except (InvalidOperation, ValueError, TypeError) as e:
        raise ValueError(f"не число: {x!r}") from e
    if not d.is_finite():
        raise ValueError("не число")
    return d


def validate_condition(type_: str, cond: dict[str, Any], timeframe: str | None) -> dict[str, Any]:
    """Нормализует условие или бросает ValueError с текстом для пользователя."""
    if type_ not in TYPES:
        raise ValueError("неизвестный тип алерта")
    if type_ == "price":
        op = cond.get("op")
        if op not in PRICE_OPS:
            raise ValueError("условие цены: cross_up, cross_down или enter_range")
        out: dict[str, Any] = {"op": op, "price": str(_dec(cond.get("price")))}
        if op == "enter_range":
            out["price2"] = str(_dec(cond.get("price2")))
            if out["price"] == out["price2"]:
                raise ValueError("границы диапазона совпадают")
        return out
    if type_ == "indicator":
        if timeframe not in {t.value for t in BAR_TFS}:
            raise ValueError("алерт по индикатору: таймфрейм 15m–1w")
        ind = cond.get("indicator")
        if ind not in INDICATOR_PERIODS:
            raise ValueError("индикатор: rsi, ema или atr")
        op = cond.get("op")
        if op not in INDICATOR_OPS or (op.startswith("price_") and ind != "ema"):
            raise ValueError("условие индикатора не поддерживается")
        period = int(cond.get("period") or INDICATOR_PERIODS[ind])
        if not 2 <= period <= 500:
            raise ValueError("период 2–500")
        out = {"indicator": ind, "op": op, "period": period}
        if not op.startswith("price_"):
            out["value"] = str(_dec(cond.get("value")))
        return out
    if type_ in ("zone", "structure"):
        if timeframe not in {t.value for t in STRUCTURE_TFS}:
            raise ValueError("зоны и структура: таймфрейм 4h или 1d")
        d = cond.get("dir", "any")
        if d not in ("up", "down", "any"):
            raise ValueError("направление: up, down или any")
        if type_ == "zone":
            kind = cond.get("kind", "any")
            if kind not in ("ob", "sd", "fvg", "any"):
                raise ValueError("зона: ob, sd, fvg или any")
            return {"kind": kind, "dir": d}
        ev = cond.get("event", "any")
        if ev not in ("bos", "choch", "any"):
            raise ValueError("событие: bos, choch или any")
        return {"event": ev, "dir": d}
    # pattern
    if timeframe is not None and timeframe not in {t.value for t in BAR_TFS}:
        raise ValueError("паттерны: таймфрейм 15m–1w или любой")
    types = [str(t) for t in (cond.get("types") or [])]
    for t in types:
        try:
            PatternType(t)
        except ValueError as e:
            raise ValueError(f"неизвестный паттерн: {t}") from e
    d = cond.get("dir", "any")
    if d not in ("up", "down", "any"):
        raise ValueError("направление: up, down или any")
    return {"types": types, "dir": d, "significant_only": bool(cond.get("significant_only", False))}


# --- тексты ---------------------------------------------------------------------------------------


def _fmt(x: Any) -> str:
    return format(Decimal(str(x)).normalize(), "f")


def condition_text(alert: Alert, symbol: str | None) -> str:
    """Человекочитаемое условие без оценочных слов."""
    c = alert.condition
    sym = symbol or "вотчлист"
    tf = (
        f" {alert.timeframe.upper() if alert.timeframe != '4h' else 'H4'}"
        if alert.timeframe
        else ""
    )
    if alert.type == "price":
        if c["op"] == "cross_up":
            return f"{sym}: цена пересекла {_fmt(c['price'])} вверх"
        if c["op"] == "cross_down":
            return f"{sym}: цена пересекла {_fmt(c['price'])} вниз"
        lo, hi = sorted((Decimal(c["price"]), Decimal(c["price2"])))
        return f"{sym}: цена вошла в диапазон {_fmt(lo)}–{_fmt(hi)}"
    if alert.type == "indicator":
        name = f"{c['indicator'].upper()}({c['period']})"
        ops = {
            "above": f"{name} выше {c.get('value')}",
            "below": f"{name} ниже {c.get('value')}",
            "cross_up": f"{name} пересёк {c.get('value')} вверх",
            "cross_down": f"{name} пересёк {c.get('value')} вниз",
            "price_cross_up": f"цена пересекла {name} вверх",
            "price_cross_down": f"цена пересекла {name} вниз",
        }
        return f"{sym}{tf}: {ops[c['op']]}"
    if alert.type == "zone":
        kind = "зону" if c["kind"] == "any" else f"зону {c['kind'].upper()}"
        d = {"up": " спроса", "down": " предложения", "any": ""}[c["dir"]]
        return f"{sym}{tf}: цена вошла в активную {kind}{d}"
    if alert.type == "structure":
        ev = "BOS/CHoCH" if c["event"] == "any" else c["event"].upper()
        d = {"up": " вверх", "down": " вниз", "any": ""}[c["dir"]]
        return f"{sym}{tf}: {ev}{d}"
    names = ", ".join(_pattern_name(t) for t in c["types"]) or "свечной паттерн"
    sig = " (значимый)" if c.get("significant_only") else ""
    d = {"up": " бычий", "down": " медвежий", "any": ""}[c["dir"]]
    return f"{sym}{tf or ' любой TF'}: подтверждён{d} {names}{sig}"


def _pattern_name(t: str) -> str:
    pt = PatternType(t)
    neutral = title(pt, None)
    if neutral != t:
        return neutral
    up = title(pt, Direction.UP).split(" (")[0]
    return up.replace("Бычье ", "").replace("Бычья ", "").lower()


# --- проверка условий (чистые функции) ------------------------------------------------------------


def price_hit(cond: dict[str, Any], prev_close: Decimal, c: Candle) -> Decimal | None:
    """Цена срабатывания или None. Пересечение — относительно close предыдущей минуты."""
    p = Decimal(cond["price"])
    if cond["op"] == "cross_up":
        return p if prev_close < p <= c.high else None
    if cond["op"] == "cross_down":
        return p if prev_close > p >= c.low else None
    lo, hi = sorted((p, Decimal(cond["price2"])))
    was_inside = lo <= prev_close <= hi
    touched = c.low <= hi and c.high >= lo
    return c.close if touched and not was_inside else None


def indicator_hit(
    cond: dict[str, Any], candles: list[Candle]
) -> tuple[Decimal | None, dict[str, Any]]:
    """(цена срабатывания, детали) по закрытым свечам; None — условие не выполнено."""
    if len(candles) < cond["period"] + 2:
        return None, {}
    fn = {"rsi": rsi, "ema": ema, "atr": atr}[cond["indicator"]]
    series = fn(candles, cond["period"])
    cur, prev = series[-1], series[-2]
    if cur is None or prev is None:
        return None, {}
    last, before = candles[-1], candles[-2]
    details = {"value": _fmt(cur), "prev": _fmt(prev)}
    op = cond["op"]
    if op == "price_cross_up":
        return (last.close, details) if before.close <= prev and last.close > cur else (None, {})
    if op == "price_cross_down":
        return (last.close, details) if before.close >= prev and last.close < cur else (None, {})
    thr = Decimal(cond["value"])
    ok = {
        "above": cur > thr,
        "below": cur < thr,
        "cross_up": prev < thr <= cur,
        "cross_down": prev > thr >= cur,
    }[op]
    return (last.close, details) if ok else (None, {})


def zone_hit(cond: dict[str, Any], candles: list[Candle]) -> dict[str, Any] | None:
    """Первое касание активной зоны на последней закрытой свече."""
    if len(candles) < 50:
        return None
    structure = analyze_structure(candles)
    zones = analyze_zones(candles, structure)
    last = len(candles) - 1
    for z in zones:
        if z.touched_index != last or z.invalidated_index is not None:
            continue
        if cond["kind"] != "any" and z.kind.value != cond["kind"]:
            continue
        if cond["dir"] != "any" and z.direction.value != cond["dir"]:
            continue
        return {
            "kind": z.kind.value,
            "dir": z.direction.value,
            "top": _fmt(z.top),
            "bottom": _fmt(z.bottom),
        }
    return None


def structure_hit(cond: dict[str, Any], candles: list[Candle]) -> dict[str, Any] | None:
    if len(candles) < 50:
        return None
    structure = analyze_structure(candles)
    last = len(candles) - 1
    for e in structure.events:
        if e.index != last:
            continue
        if cond["event"] != "any" and e.type.value != cond["event"]:
            continue
        if cond["dir"] != "any" and e.direction.value != cond["dir"]:
            continue
        return {"event": e.type.value, "dir": e.direction.value, "level": _fmt(e.level)}
    return None


def pattern_matches(cond: dict[str, Any], alert_tf: str | None, p: Pattern) -> bool:
    if alert_tf is not None and p.timeframe != alert_tf:
        return False
    if cond["types"] and p.type not in cond["types"]:
        return False
    if cond["dir"] != "any" and p.direction != cond["dir"]:
        return False
    return not (cond.get("significant_only") and not p.is_significant)


def may_trigger(alert: Alert, at: datetime) -> bool:
    """Статус, срок и частота (once / every / once_per_bar)."""
    if alert.status != "active":
        return False
    if alert.expires_at is not None and at > alert.expires_at:
        return False
    if alert.frequency == "once":
        return alert.triggers_count == 0
    if alert.frequency == "once_per_bar":
        last = alert.last_triggered_at
        if last is None:
            return True
        tf = Timeframe(alert.timeframe) if alert.timeframe else Timeframe.M1
        return bucket_start(tf, at) > last
    return True


# --- срабатывание и доставка ----------------------------------------------------------------------


def trigger(
    db: Session, alert: Alert, at: datetime, price: Decimal | None, details: dict[str, Any]
) -> AlertTrigger | None:
    """Пишет срабатывание (идемпотентно по времени) и обновляет алерт. None — уже было."""
    row = AlertTrigger(alert_id=alert.id, triggered_at=at, price=price, details=details)
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        return None
    alert.last_triggered_at = at
    alert.triggers_count += 1
    if alert.frequency == "once":
        alert.status = "triggered"
    return row


def notify_trigger(
    db: Session, alert: Alert, trig: AlertTrigger, now: datetime | None = None
) -> int:
    """Push и письмо по настройкам пользователя; тихие часы и дневной лимит соблюдаются."""
    now = now or datetime.now(tz=UTC)
    user = db.get(User, alert.user_id)
    if user is None or user.deleted_at is not None:
        return 0
    ns = settings_for(db, user)
    symbol = _symbol(db, alert.instrument_id) if alert.instrument_id else None
    if alert.instrument_id is None and trig.details.get("symbol"):
        symbol = str(trig.details["symbol"])
    text = condition_text(alert, symbol)
    price = f" по {_fmt(trig.price)}" if trig.price is not None else ""
    tf = alert.timeframe or trig.details.get("tf") or "4h"
    url = f"/chart/{symbol}/{tf}" if symbol else "/alerts"
    sent = 0
    if in_quiet_hours(ns, now) or limit_reached(ns, now):
        return 0
    if ns.push_alerts:
        sent += send_to_user(
            db,
            user.id,
            {"title": "Алерт", "body": f"{text}{price}", "url": url, "tag": f"alert-{trig.id}"},
        )
    if ns.email_alerts and user.email_verified_at is not None:
        send_mail(
            user.email,
            f"Алерт: {text}",
            f"{text}{price}.\nВремя: {trig.triggered_at:%d.%m %H:%M UTC}\n"
            f"{settings.frontend_url}{url}\n\n{DISCLAIMER}" + unsubscribe_footer(ns),
        )
        ns.sent_today += 1
        sent += 1
    trig.notified = True
    return sent


def _symbol(db: Session, instrument_id: int) -> str:
    return db.scalar(select(Instrument.symbol).where(Instrument.id == instrument_id)) or "?"


def _fire(
    db: Session, alert: Alert, at: datetime, price: Decimal | None, details: dict[str, Any]
) -> int:
    row = trigger(db, alert, at, price, details)
    if row is None:
        return 0
    try:
        notify_trigger(db, alert, row, at)
    except Exception:
        log.exception("алерт %s: доставка", alert.id)
    return 1


def _active(db: Session, type_: str, instrument_id: int | None) -> list[Alert]:
    q = select(Alert).where(Alert.status == "active", Alert.type == type_)
    if instrument_id is not None:
        q = q.where(Alert.instrument_id == instrument_id)
    return list(db.scalars(q).all())


# --- точки входа воркера --------------------------------------------------------------------------


def evaluate_price(db: Session, inst: Instrument, close_time: datetime) -> int:
    """Ценовые алерты по 1m-свече, закрывшейся в ``close_time``."""
    alerts = _active(db, "price", inst.id)
    if not alerts:
        return 0
    candles, _ = load_candles(db, inst.id, Timeframe.M1, None, 3)
    candles = closed_only(candles, Timeframe.M1, close_time)
    if len(candles) < 2 or candles[-1].close_time(Timeframe.M1) != close_time:
        return 0
    prev, cur = candles[-2].close, candles[-1]
    fired = 0
    for a in alerts:
        if not may_trigger(a, close_time):
            continue
        p = price_hit(a.condition, prev, cur)
        if p is not None:
            fired += _fire(db, a, close_time, p, {"close": _fmt(cur.close), "tf": "1m"})
    return fired


def evaluate_bars(db: Session, inst: Instrument, tf: Timeframe, close_time: datetime) -> int:
    """Индикаторы, зоны и структура по закрытию свечи ``tf``."""
    alerts = [
        a
        for t in ("indicator", "zone", "structure")
        for a in _active(db, t, inst.id)
        if a.timeframe == tf.value
    ]
    if not alerts:
        return 0
    candles, _ = load_candles(db, inst.id, tf, None, PAGE)
    candles = closed_only(candles, tf, close_time)
    if not candles or candles[-1].close_time(tf) != close_time:
        return 0
    fired = 0
    for a in alerts:
        if not may_trigger(a, close_time):
            continue
        if a.type == "indicator":
            price, details = indicator_hit(a.condition, candles)
            if price is not None:
                fired += _fire(db, a, close_time, price, {**details, "tf": tf.value})
        elif a.type == "zone":
            d = zone_hit(a.condition, candles)
            if d is not None:
                fired += _fire(db, a, close_time, candles[-1].close, {**d, "tf": tf.value})
        else:
            d = structure_hit(a.condition, candles)
            if d is not None:
                fired += _fire(db, a, close_time, candles[-1].close, {**d, "tf": tf.value})
    return fired


def _watchlist_ids(db: Session, user_id: int) -> set[int]:
    return set(
        db.scalars(
            select(WatchlistItem.instrument_id)
            .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
            .where(Watchlist.user_id == user_id)
        ).all()
    )


def evaluate_patterns(db: Session, since_id: int, limit: int = 500) -> tuple[int, int]:
    """Алерты по новым live-отметкам паттернов с id > since_id → (новый курсор, сработало)."""
    rows = db.scalars(
        select(Pattern)
        .where(Pattern.id > since_id, Pattern.source == "live")
        .order_by(Pattern.id)
        .limit(limit)
    ).all()
    if not rows:
        return since_id, 0
    alerts = _active(db, "pattern", None)
    fired = 0
    cache: dict[int, set[int]] = {}
    for p in rows:
        for a in alerts:
            if a.instrument_id is None:
                ids = cache.setdefault(a.user_id, _watchlist_ids(db, a.user_id))
                if p.instrument_id not in ids:
                    continue
            elif a.instrument_id != p.instrument_id:
                continue
            if not pattern_matches(a.condition, a.timeframe, p) or not may_trigger(
                a, p.confirm_time
            ):
                continue
            sym = _symbol(db, p.instrument_id)
            fired += _fire(
                db,
                a,
                p.confirm_time,
                Decimal(p.geometry["candles"][-1][4]) if p.geometry.get("candles") else None,
                {
                    "pattern_id": p.id,
                    "type": p.type,
                    "title": title(
                        PatternType(p.type), Direction(p.direction) if p.direction else None
                    ),
                    "significant": p.is_significant,
                    "symbol": sym,
                    "tf": p.timeframe,
                },
            )
    return rows[-1].id, fired


def expire(db: Session, now: datetime | None = None) -> int:
    now = now or datetime.now(tz=UTC)
    rows = db.scalars(
        select(Alert).where(
            Alert.status == "active", Alert.expires_at.is_not(None), Alert.expires_at < now
        )
    ).all()
    for a in rows:
        a.status = "expired"
    return len(rows)


# --- API ------------------------------------------------------------------------------------------


def alert_dict(a: Alert, symbol: str | None, last: AlertTrigger | None = None) -> dict[str, Any]:
    return {
        "id": a.id,
        "symbol": symbol,
        "timeframe": a.timeframe,
        "type": a.type,
        "condition": a.condition,
        "text": condition_text(a, symbol),
        "frequency": a.frequency,
        "expires_at": a.expires_at.isoformat() if a.expires_at else None,
        "status": a.status,
        "drawing_client_id": a.drawing_client_id,
        "note": a.note,
        "last_triggered_at": a.last_triggered_at.isoformat() if a.last_triggered_at else None,
        "triggers_count": a.triggers_count,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "last_trigger": trigger_dict(last) if last else None,
    }


def trigger_dict(t: AlertTrigger) -> dict[str, Any]:
    return {
        "id": t.id,
        "alert_id": t.alert_id,
        "triggered_at": t.triggered_at.isoformat(),
        "price": _fmt(t.price) if t.price is not None else None,
        "details": t.details,
        "notified": t.notified,
    }


def default_expiry(now: datetime, days: int = DEFAULT_EXPIRES_DAYS) -> datetime:
    return now + timedelta(days=days)


def active_count(db: Session, user_id: int) -> int:
    return len(
        db.scalars(select(Alert.id).where(Alert.user_id == user_id, Alert.status == "active")).all()
    )
