"""Алерты на графике (план 2A.6; задача 2B.13): условия, проверка, срабатывание, доставка.

Типы: price (по 1m-свечам, ≤ 60 с), indicator (RSI/EMA/ATR по закрытию свечи TF),
zone (цена вошла в активную зону), structure (BOS/CHoCH), pattern (подтверждён свечной паттерн).
Срабатывание идемпотентно по (alert_id, triggered_at). Доставка — push/email по настройкам.

Доставка (ADR-0004, раздел «Доставка через уведомитель»): исходящая очередь — сами строки
``alert_triggers``. Срабатывание пишется с ``details.delivery.status = queued`` в той же транзакции,
что и проверка (``_fire``). Если у процесса воркера есть и ключ почты, и ключи Web Push
(``can_deliver_inline``, локальная разработка), он доставляет сразу; иначе (на Railway ключи есть
только у уведомителя) строку забирает уведомитель (``deliver_batch``), воркер лишь будит его
сообщением в Redis-канал ``CHANNEL_TRIGGERED``. Тексты, ссылки, настройки пользователя (тихие часы,
лимит, каналы) и отписка в обоих путях одни и те же (``notify_trigger``). Каналы независимы: канал
без ключей ждёт (``channels_ready``), сбой одного не мешает другому.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol

from sqlalchemy import DateTime, cast, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.chart_data import PAGE, bucket_start, load_candles
from app.config import settings
from app.mail import MailError, provider_wide, send_mail
from app.mail import configured as mail_configured
from app.models import (
    Alert,
    AlertTrigger,
    FigureEvent,
    FigureRow,
    Instrument,
    NotificationSettings,
    Pattern,
    User,
    Watchlist,
    WatchlistItem,
)
from app.notify import in_quiet_hours, limit_reached, settings_for, unsubscribe_footer
from app.push import enabled as push_enabled
from app.push import send_to_user
from engine.candles import Candle, Timeframe, closed_only
from engine.indicators import atr, ema, rsi
from engine.patterns import PatternType, title
from engine.structure import Direction, analyze_structure
from engine.zones import analyze_zones

log = logging.getLogger("alerts")

TYPES = ("price", "indicator", "zone", "structure", "pattern", "figure")
FREQUENCIES = ("once", "every", "once_per_bar")
BAR_TFS = (Timeframe.M15, Timeframe.H1, Timeframe.H4, Timeframe.D1, Timeframe.W1)
STRUCTURE_TFS = (Timeframe.H4, Timeframe.D1)
DEFAULT_EXPIRES_DAYS = 30
INDICATOR_PERIODS = {"rsi": 14, "ema": 50, "atr": 14}
PRICE_OPS = ("cross_up", "cross_down", "enter_range")
INDICATOR_OPS = ("above", "below", "cross_up", "cross_down", "price_cross_up", "price_cross_down")
DISCLAIMER = "Алерт — уведомление по вашему условию, не рекомендация."
CHANNEL_TRIGGERED = "alerts.triggered"
"""Redis-канал: воркер алертов будит уведомитель — появились срабатывания для доставки."""
QUEUED, SENT, SUPPRESSED, EXPIRED, FAILED = "queued", "sent", "suppressed", "expired", "failed"
"""``details.delivery.status``: ждёт доставки / доставлено / подавлено настройками (тихие часы,
лимит, нет пользователя) / устарело / не доставлено после всех попыток. Строки без отметки
(записаны до этой схемы) уведомитель не трогает."""
DELIVERY_MAX_ATTEMPTS = 6
"""Попыток доставки; после последней ошибки — ``failed``, строка больше не берётся. Не касается
отказов почты не из-за письма (``provider_wide``): их повторяют до ``DELIVERY_MAX_AGE``."""
DELIVERY_RETRY_AFTER = timedelta(seconds=30)
"""Пауза перед повтором; удваивается с каждой попыткой (30 с … 8 мин)."""
DELIVERY_MAX_AGE = timedelta(hours=24)
"""Срабатывание старше (по ``created_at``) не доставляется — ``expired``: уведомление о цене
суточной давности уже вводит в заблуждение. Простой уведомителя (выкладка, перезапуск, сбой на
часы) ничего не теряет: строки ждут в БД, после старта уходят с пометкой времени."""
DELIVERY_LATE = timedelta(minutes=5)
"""Доставлено позже этого после записи срабатывания — в push добавляется время срабатывания (в
письме оно есть всегда): уведомление «с опозданием» не выдаётся за свежее."""
DELIVERY_BACKOFF_MAX = 4
"""Пауза между повторами растёт до ``DELIVERY_RETRY_AFTER`` × 2⁴ = 8 мин и дальше не растёт
(повторы после отказа провайдера идут до ``DELIVERY_MAX_AGE``)."""
DELIVERY_HOLD = timedelta(minutes=10)
"""Канал, который этот процесс доставить не может (в production нет его ключей), ждёт столько
до следующей проверки; попытка не засчитывается."""
DELIVERY_BATCH = 200
"""Сколько срабатываний уведомитель берёт за один проход."""
_not_ready_warned = False
_waiting_warned: set[str] = set()


class MailSender(Protocol):
    def __call__(
        self, to: str, subject: str, text: str, idempotency_key: str | None = None
    ) -> None: ...


class PushSender(Protocol):
    def __call__(self, db: Session, user_id: int, payload: dict[str, Any]) -> int: ...


class DeliveryIncompleteError(Exception):
    """Канал доставки не сработал (``cause``); ``done`` — что решено в этой попытке: ушедшие
    каналы (``push_done`` / ``mail_done``) и письмо, которое слать не надо (``mail_skipped`` —
    лимит, ``mail_refused`` — адрес отклонён): повтор их не повторяет."""

    def __init__(self, cause: Exception, done: dict[str, Any]) -> None:
        super().__init__(str(cause))
        self.cause = cause
        self.done = done


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
    if type_ == "figure":
        from engine.figures import FigureType

        if timeframe is not None and timeframe not in ("4h", "1d", "1w"):
            raise ValueError("фигуры: таймфрейм 4h, 1d, 1w или любой")
        ftypes = [str(t) for t in (cond.get("types") or [])]
        for t in ftypes:
            try:
                FigureType(t)
            except ValueError as e:
                raise ValueError(f"неизвестная фигура: {t}") from e
        d = cond.get("dir", "any")
        if d not in ("up", "down", "any"):
            raise ValueError("направление: up, down или any")
        return {"types": ftypes, "dir": d, "min_quality": float(cond.get("min_quality") or 0.6)}
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
    if alert.type == "figure":
        from engine.figures import TITLES, FigureType

        fnames = ", ".join(TITLES[FigureType(t)].lower() for t in c["types"]) or "фигура"
        fd = {"up": " вверх", "down": " вниз", "any": ""}[c["dir"]]
        return f"{sym}{tf or ' любой TF'}: подтверждена {fnames}{fd}"
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


def can_deliver_inline() -> bool:
    """Доставлять ли срабатывания прямо из воркера алертов: только когда у процесса есть и ключ
    почты, и ключи Web Push (локальная разработка с полным ``.env``). Иначе срабатывание ждёт
    уведомителя — на Railway ключи есть только у него."""
    return mail_configured() and push_enabled()


def channels_ready() -> dict[str, bool]:
    """Какие каналы этот процесс может доставить: ``{"mail": …, "push": …}``.

    Локально и на staging — оба: без ключей письмо пишется в лог, push пропускается, как и раньше.
    В production — каждый по своим ключам: без ключа почты письмо ушло бы в лог, без ключей Web
    Push push молча пропустился бы, а срабатывание отметилось бы доставленным. Канал без ключей
    ждёт (``DELIVERY_HOLD``), другой канал это не задерживает.
    """
    if not settings.is_production:
        return {"mail": True, "push": True}
    return {"mail": mail_configured(), "push": push_enabled()}


def delivery_ready() -> bool:
    """Может ли этот процесс разбирать очередь срабатываний (``deliver_pending``): локально и на
    staging — всегда, в production — если есть ключи хотя бы одного канала."""
    return any(channels_ready().values())


def delivery_state(trig: AlertTrigger) -> dict[str, Any]:
    """Служебная отметка доставки ``details.delivery`` (в API не отдаётся, см. ``trigger_dict``)."""
    return dict(trig.details.get("delivery") or {})


def _set_delivery(trig: AlertTrigger, **fields: Any) -> None:
    trig.details = {**trig.details, "delivery": {**delivery_state(trig), **fields}}


def _alert_mail(to: str, subject: str, text: str, idempotency_key: str | None = None) -> None:
    """Письмо алерта в строгом режиме: отказ провайдера — исключение (``MailError``), и
    срабатывание не отмечается доставленным; временный отказ — повтор, постоянный — ``failed``."""
    send_mail(to, subject, text, idempotency_key=idempotency_key, strict=True)


def notify_trigger(
    db: Session,
    alert: Alert,
    trig: AlertTrigger,
    now: datetime | None = None,
    *,
    mail: MailSender | None = None,
    push: PushSender | None = None,
    ready: Mapping[str, bool] | None = None,
    hold: timedelta = DELIVERY_HOLD,
) -> int:
    """Push и письмо по настройкам пользователя; тихие часы и дневной лимит соблюдаются.

    Доставлено — ``notified = True`` и ``delivery.status = sent``. Подавлено (нет пользователя,
    тихие часы, дневной лимит) — ``delivery.status = suppressed`` с причиной, ``notified`` остаётся
    False, как и раньше. Письмо идёт с ключом идемпотентности ``alert-trigger-{id}``, push — с
    ``tag`` ``alert-{id}``: повтор после сбоя не даёт второго письма, а push заменяет прежний.

    Каналы независимы: сбой push не мешает письму и наоборот — ``DeliveryIncompleteError`` с тем,
    что ушло (``push_done`` / ``mail_done``); повтор шлёт только недоставленное. Канал, который
    этот процесс сейчас доставить не может (``ready``: в production нет ключей), ждёт —
    ``waiting`` и ``retry_at`` через ``hold``, попытка не засчитывается.

    Постоянный отказ почты (неверный адрес получателя) решает только судьбу письма
    (``mail_refused``, повтор его не шлёт), а не всего срабатывания: push, упавший в той же попытке
    или ждущий ключей, уходит на повторе. Push дошёл — срабатывание доставлено (``sent``,
    ``notified``); push не нужен — ``failed``.

    Тихие часы и лимит решают один раз — пока ни один канал не ушёл. Срабатывание, по которому
    что-то уже доставлено, повтор не подавляет (иначе push, не ушедший из-за сбоя, пропал бы
    из-за лимита, который исчерпало его же письмо); только письмо на повторе снова сверяется с
    лимитом (``mail_skipped``) — его могли исчерпать другие срабатывания.
    ``mail`` / ``push`` — отправители (по умолчанию Resend и Web Push; в тестах — подмены).
    """
    mail = mail or _alert_mail
    push = push or send_to_user
    ready = ready if ready is not None else channels_ready()
    now = now or datetime.now(tz=UTC)
    user = db.get(User, alert.user_id)
    if user is None or user.deleted_at is not None:
        _set_delivery(trig, status=SUPPRESSED, reason="no_user")
        return 0
    # настройки — под блокировкой строки: два уведомителя бок о бок (выкладка) не превысят
    # дневной лимит, увеличивая счётчик писем одновременно
    ns = db.get(NotificationSettings, user.id, with_for_update=True, populate_existing=True)
    if ns is None:
        ns = settings_for(db, user)
    symbol = _symbol(db, alert.instrument_id) if alert.instrument_id else None
    if alert.instrument_id is None and trig.details.get("symbol"):
        symbol = str(trig.details["symbol"])
    text = condition_text(alert, symbol)
    price = f" по {_fmt(trig.price)}" if trig.price is not None else ""
    tf = alert.timeframe or trig.details.get("tf") or "4h"
    url = f"/chart/{symbol}/{tf}" if symbol else "/alerts"
    state = delivery_state(trig)
    admitted = bool(state.get("push_done") or state.get("mail_done"))
    if not admitted and in_quiet_hours(ns, now):
        _set_delivery(trig, status=SUPPRESSED, reason="quiet_hours")
        return 0
    if not admitted and limit_reached(ns, now):
        _set_delivery(trig, status=SUPPRESSED, reason="daily_limit")
        return 0
    done: dict[str, Any] = {}
    waiting: list[str] = []
    failure: Exception | None = None
    sent = 0
    want_mail = (
        ns.email_alerts
        and user.email_verified_at is not None
        and not state.get("mail_done")
        and not state.get("mail_skipped")
        and not state.get("mail_refused")
    )
    if want_mail and admitted and limit_reached(ns, now):
        want_mail = False
        done["mail_skipped"] = "daily_limit"
    if ns.push_alerts and not state.get("push_done"):
        late = ""
        if trig.created_at is not None and now - trig.created_at > DELIVERY_LATE:
            late = f" (сработал {trig.triggered_at:%d.%m %H:%M} UTC)"
        if not ready.get("push"):
            waiting.append("push")
        else:
            try:
                sent += push(
                    db,
                    user.id,
                    {
                        "title": "Алерт",
                        "body": f"{text}{price}{late}",
                        "url": url,
                        "tag": f"alert-{trig.id}",
                    },
                )
                done["push_done"] = True
            except Exception as exc:
                log.warning("срабатывание %s: push не отправлен (%s)", trig.id, exc)
                failure = exc
    if want_mail and not ready.get("mail"):
        waiting.append("mail")
    elif want_mail:
        try:
            mail(
                user.email,
                f"Алерт: {text}",
                f"{text}{price}.\nВремя: {trig.triggered_at:%d.%m %H:%M UTC}\n"
                f"{settings.frontend_url}{url}\n\n{DISCLAIMER}" + unsubscribe_footer(ns),
                idempotency_key=f"alert-trigger-{trig.id}",
            )
            done["mail_done"] = True
            ns.sent_today += 1
            sent += 1
        except MailError as exc:
            if not exc.permanent:
                failure = exc  # ошибка письма важнее: по ней видно, отказ ли это провайдера
            else:
                # неверный адрес: повтор письма не поможет, но push это не отменяет
                done["mail_refused"] = str(exc)[:200]
                log.error("срабатывание %s: письмо отклонено (%s), не повторяем", trig.id, exc)
        except Exception as exc:
            failure = exc
    if failure is not None:
        raise DeliveryIncompleteError(failure, done)
    if waiting:
        _warn_waiting(waiting)
        _set_delivery(trig, **done, waiting=waiting, retry_at=(now + hold).isoformat())
        return sent
    if "mail_refused" in done and not (state.get("push_done") or done.get("push_done")):
        # письмо отклонено, а push не нужен (или выключен): доставить нечем
        _set_delivery(trig, status=FAILED, waiting=[], error=done["mail_refused"], **done)
        return sent
    trig.notified = True
    _set_delivery(trig, status=SENT, waiting=[], **done)
    return sent


def _warn_waiting(channels: list[str]) -> None:
    """Один раз на процесс и канал: канал ждёт ключей (или восстановления провайдера)."""
    for ch in channels:
        if ch not in _waiting_warned:
            _waiting_warned.add(ch)
            log.warning(
                "доставка алертов: канал %s сейчас недоступен (нет ключей или сбой провайдера) — "
                "срабатывания ждут, другой канал уходит",
                ch,
            )


def pending_ids(db: Session, now: datetime, limit: int = DELIVERY_BATCH) -> list[int]:
    """Срабатывания в очереди: ``queued``, ещё не доставлены и пауза после ошибки истекла."""
    status = func.jsonb_extract_path_text(AlertTrigger.details, "delivery", "status")
    retry_at = func.jsonb_extract_path_text(AlertTrigger.details, "delivery", "retry_at")
    return list(
        db.scalars(
            select(AlertTrigger.id)
            .where(AlertTrigger.notified.is_(False), status == QUEUED)
            .where(or_(retry_at.is_(None), cast(retry_at, DateTime(timezone=True)) <= now))
            .order_by(AlertTrigger.id)
            .limit(limit)
        ).all()
    )


@dataclass(frozen=True, slots=True)
class DeliveryPass:
    """Итог одного прохода очереди (``deliver_batch``)."""

    decided: int
    """Срабатываний решено: доставлено, подавлено, устарело или ``failed``."""
    handled: int
    """Срабатываний обработано этим экземпляром: решено, отложено (канал ждёт) или засчитана
    ошибка. Строки, занятые другим экземпляром, сюда не входят."""
    full: bool
    """Выборка была полной (``limit`` строк): в очереди, скорее всего, есть ещё."""


def deliver_batch(
    db: Session,
    now: datetime | None = None,
    *,
    mail: MailSender | None = None,
    push: PushSender | None = None,
    limit: int = DELIVERY_BATCH,
    progress: Callable[[], None] | None = None,
) -> DeliveryPass:
    """Уведомитель: один проход очереди (``alert_triggers`` со статусом ``queued``).

    Пока уведомитель лежит, строки ждут в БД — ничего не теряется (до ``DELIVERY_MAX_AGE``).
    Каждое срабатывание — в своей транзакции; строка берётся ``FOR UPDATE SKIP LOCKED`` и
    перепроверяется под блокировкой: второй экземпляр уведомителя (выкладка без простоя) её
    пропустит, а уже доставленную не тронет. Исключение при доставке — попытка засчитывается
    (``_count_failure``), повтор через паузу. Сбой между отправкой и фиксацией даёт повтор, но не
    второе письмо: ключ идемпотентности тот же. Тихие часы и лимит проверяются на момент доставки.

    Почта отказала не из-за письма (``provider_wide``: ключ, отправитель, лимит, сбой
    провайдера, сеть) — до конца прохода письма не отправляются, а ждут ``DELIVERY_RETRY_AFTER``:
    при таймаутах сети проход не растягивается на 15 с × размер очереди, а push по остальным
    срабатываниям уходит сразу. В production без ключей обоих каналов ничего не делает.

    ``progress`` вызывается перед каждым срабатыванием: по нему уведомитель видит, что очередь
    движется, и пишет heartbeat доставки (``Notifier.alerts_loop``); застрявший проход монитор
    покажет, а не спрячет за свежим heartbeat основного цикла.
    """
    global _not_ready_warned
    if not delivery_ready():
        if not _not_ready_warned:
            log.warning(
                "доставка алертов: нет ключа почты и Web Push — очередь ждёт процесс с ними"
            )
            _not_ready_warned = True
        return DeliveryPass(0, 0, False)
    now = now or datetime.now(tz=UTC)
    ready = channels_ready()
    hold = DELIVERY_HOLD
    decided = handled = 0
    ids = pending_ids(db, now, limit)
    for tid in ids:
        if progress is not None:
            progress()
        try:
            trig = db.get(AlertTrigger, tid, with_for_update={"skip_locked": True})
            if trig is None or trig.notified or delivery_state(trig).get("status") != QUEUED:
                db.rollback()  # занято другим экземпляром или уже решено
                continue
            alert = db.get(Alert, trig.alert_id)
            if alert is None:
                _set_delivery(trig, status=SUPPRESSED, reason="no_alert")
            elif trig.created_at < now - DELIVERY_MAX_AGE:
                _expire(trig)
            else:
                notify_trigger(db, alert, trig, now, mail=mail, push=push, ready=ready, hold=hold)
            final = delivery_state(trig).get("status") != QUEUED
            db.commit()
            decided += final
            handled += 1
        except Exception as exc:
            cause = exc.cause if isinstance(exc, DeliveryIncompleteError) else exc
            if isinstance(cause, MailError | OSError) or provider_wide(cause):
                # отказ провайдера или сеть (у push-сервиса ошибки сети и таймаут — OSError):
                # причина видна по сообщению, трассировка на каждую попытку только забивает лог
                log.warning("срабатывание %s: не доставлено (%s), повтор позже", tid, cause)
            else:
                log.exception("срабатывание %s: ошибка доставки", tid)
            db.rollback()
            handled += _count_failure(db, tid, exc, now)
            if ready["mail"] and provider_wide(cause):
                ready = {**ready, "mail": False}  # почта лежит — письма ждут, push идёт
                hold = DELIVERY_RETRY_AFTER
    return DeliveryPass(decided, handled, len(ids) >= limit)


def deliver_pending(
    db: Session,
    now: datetime | None = None,
    *,
    mail: MailSender | None = None,
    push: PushSender | None = None,
    limit: int = DELIVERY_BATCH,
) -> int:
    """Один проход очереди (``deliver_batch``); возвращает число решённых срабатываний."""
    return deliver_batch(db, now, mail=mail, push=push, limit=limit).decided


def _expire(trig: AlertTrigger) -> None:
    """Срабатывание старше ``DELIVERY_MAX_AGE`` — ``expired``. Если какой-то канал уже ушёл
    (другой ждал ключей или упирался в сбой), пользователь уведомлён: ``notified``."""
    state = delivery_state(trig)
    trig.notified = bool(state.get("push_done") or state.get("mail_done"))
    _set_delivery(trig, status=EXPIRED)
    log.warning("срабатывание %s: старше %s — больше не доставляем", trig.id, DELIVERY_MAX_AGE)


def _count_failure(db: Session, tid: int, exc: Exception, now: datetime) -> int:
    """Засчитать попытку (в новой транзакции после отката): 1 — учтено, 0 — нет."""
    try:
        trig = db.get(AlertTrigger, tid, with_for_update=True)
        if trig is None or trig.notified or delivery_state(trig).get("status") != QUEUED:
            db.rollback()
            return 0
        _apply_failure(db, trig, exc, now)
        db.commit()
        return 1
    except Exception:
        log.exception("срабатывание %s: учёт ошибки доставки", tid)
        db.rollback()
        return 0


def _apply_failure(db: Session, trig: AlertTrigger, exc: Exception, now: datetime) -> None:
    """Попытка не удалась: повтор через паузу ``DELIVERY_RETRY_AFTER`` × 2ⁿ (не больше
    × 2^``DELIVERY_BACKOFF_MAX``) или ``failed``.

    - Отказ почты не из-за письма (``provider_wide``: ключ, MAIL_FROM, лимит, сбой провайдера,
      сеть) — повтор, пока срабатывание не устарело (``DELIVERY_MAX_AGE``): после исправления
      настроек письмо уйдёт, а не пропадёт.
    - Остальное (сбой push, ошибка в данных) — не больше ``DELIVERY_MAX_ATTEMPTS`` попыток:
      «ядовитое» срабатывание не держит очередь.

    Постоянный отказ почты (неверный адрес получателя) сюда не доходит: ``notify_trigger``
    отмечает его у письма (``mail_refused``) и решает судьбу срабатывания по push.

    Ушедшие в этой попытке каналы (``DeliveryIncompleteError.done``) отмечаются, а ушедшее письмо
    засчитывается в дневной лимит здесь же: увеличение счётчика в ``notify_trigger`` пропало при
    откате вместе со всей попыткой.
    """
    state = delivery_state(trig)
    attempts = int(state.get("attempts", 0)) + 1
    cause = exc.cause if isinstance(exc, DeliveryIncompleteError) else exc
    fields: dict[str, Any] = {"attempts": attempts, "error": str(cause)[:200]}
    if isinstance(exc, DeliveryIncompleteError):
        fields.update(exc.done)  # ушедшие каналы повтор не шлёт
        if exc.done.get("mail_done") and not state.get("mail_done"):
            _count_sent_mail(db, trig, now)
    if attempts >= DELIVERY_MAX_ATTEMPTS and not provider_wide(cause):
        fields["status"] = FAILED
        log.error("срабатывание %s: %d ошибок доставки, больше не пытаемся", trig.id, attempts)
    else:
        backoff = DELIVERY_RETRY_AFTER * 2 ** min(attempts - 1, DELIVERY_BACKOFF_MAX)
        fields["retry_at"] = (now + backoff).isoformat()
    _set_delivery(trig, **fields)


def _count_sent_mail(db: Session, trig: AlertTrigger, now: datetime) -> None:
    """Письмо по срабатыванию ушло — +1 к дневному счётчику писем пользователя."""
    alert = db.get(Alert, trig.alert_id)
    ns = (
        db.get(NotificationSettings, alert.user_id, with_for_update=True, populate_existing=True)
        if alert is not None
        else None
    )
    if ns is None:
        return
    limit_reached(ns, now)  # обнуляет счётчик, если наступил новый день
    ns.sent_today += 1


def _symbol(db: Session, instrument_id: int) -> str:
    return db.scalar(select(Instrument.symbol).where(Instrument.id == instrument_id)) or "?"


def _fire(
    db: Session, alert: Alert, at: datetime, price: Decimal | None, details: dict[str, Any]
) -> int:
    row = trigger(db, alert, at, price, details)
    if row is None:
        return 0
    # в очередь — в той же транзакции, что и срабатывание: без ключей доставит уведомитель
    _set_delivery(row, status=QUEUED)
    if can_deliver_inline():
        try:
            with db.begin_nested():
                notify_trigger(db, alert, row, at)
        except Exception as exc:
            # точка сохранения откатилась, строка осталась queued — повторит уведомитель; что
            # успело уйти (и письмо в дневном лимите), отмечается, как и у уведомителя
            log.exception("алерт %s: доставка (повторит уведомитель)", alert.id)
            try:
                with db.begin_nested():
                    _apply_failure(db, row, exc, datetime.now(tz=UTC))
            except Exception:
                log.exception("алерт %s: учёт ошибки доставки", alert.id)
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


def figure_matches(cond: dict[str, Any], alert_tf: str | None, r: FigureRow) -> bool:
    if alert_tf is not None and r.timeframe != alert_tf:
        return False
    if cond["types"] and r.type not in cond["types"]:
        return False
    if cond["dir"] != "any" and r.direction != cond["dir"]:
        return False
    return float(r.quality) >= float(cond.get("min_quality") or 0)


def evaluate_figures(db: Session, since_id: int, limit: int = 500) -> tuple[int, int]:
    """Алерты по переходам фигур в «подтверждена» (события с id > since_id)."""
    rows = db.execute(
        select(FigureEvent, FigureRow)
        .join(FigureRow, FigureRow.id == FigureEvent.figure_id)
        .where(
            FigureEvent.id > since_id, FigureEvent.type == "confirmed", FigureRow.source == "live"
        )
        .order_by(FigureEvent.id)
        .limit(limit)
    ).all()
    last = db.scalar(
        select(FigureEvent.id)
        .where(FigureEvent.id > since_id)
        .order_by(FigureEvent.id.desc())
        .limit(1)
    )
    if not rows:
        return (last or since_id), 0
    alerts = _active(db, "figure", None)
    fired = 0
    cache: dict[int, set[int]] = {}
    for ev, r in rows:
        for a in alerts:
            if a.instrument_id is None:
                ids = cache.setdefault(a.user_id, _watchlist_ids(db, a.user_id))
                if r.instrument_id not in ids:
                    continue
            elif a.instrument_id != r.instrument_id:
                continue
            if not figure_matches(a.condition, a.timeframe, r) or not may_trigger(
                a, ev.occurred_at
            ):
                continue
            from engine.figures import TITLES, FigureType

            fired += _fire(
                db,
                a,
                ev.occurred_at,
                r.breakout_level,
                {
                    "figure_id": r.id,
                    "type": r.type,
                    "title": TITLES[FigureType(r.type)],
                    "quality": float(r.quality),
                    "symbol": _symbol(db, r.instrument_id),
                    "tf": r.timeframe,
                },
            )
    return rows[-1][0].id, fired


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
        "details": {k: v for k, v in t.details.items() if k != "delivery"},
        "notified": t.notified,
    }


def default_expiry(now: datetime, days: int = DEFAULT_EXPIRES_DAYS) -> datetime:
    return now + timedelta(days=days)


def active_count(db: Session, user_id: int) -> int:
    return len(
        db.scalars(select(Alert.id).where(Alert.user_id == user_id, Alert.status == "active")).all()
    )
