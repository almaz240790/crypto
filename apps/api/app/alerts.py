"""Алерты на графике (план 2A.6; задача 2B.13): условия, проверка, срабатывание, доставка.

Типы: price (по 1m-свечам, ≤ 60 с), indicator (RSI/EMA/ATR по закрытию свечи TF),
zone (цена вошла в активную зону), structure (BOS/CHoCH), pattern (подтверждён свечной паттерн).
Срабатывание идемпотентно по (alert_id, triggered_at). Доставка — push/email по настройкам.

Доставка (ADR-0004, раздел «Доставка через уведомитель»): исходящая очередь — сами строки
``alert_triggers``. Срабатывание пишется с ``details.delivery.status = queued`` в той же транзакции,
что и проверка (``_fire``). Если у процесса воркера есть и ключ почты, и ключи Web Push
(``can_deliver_inline``, локальная разработка), он доставляет сразу; иначе (на Railway ключи есть
только у уведомителя) строку забирает уведомитель (``deliver_pending``), воркер лишь будит его
сообщением в Redis-канал ``CHANNEL_TRIGGERED``. Тексты, ссылки, настройки пользователя (тихие часы,
лимит, каналы) и отписка в обоих путях одни и те же (``notify_trigger``).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol

from sqlalchemy import DateTime, cast, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.chart_data import PAGE, bucket_start, load_candles
from app.config import settings
from app.mail import MailError, send_mail
from app.mail import configured as mail_configured
from app.models import (
    Alert,
    AlertTrigger,
    FigureEvent,
    FigureRow,
    Instrument,
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
"""Попыток доставки; после последней ошибки — ``failed``, строка больше не берётся."""
DELIVERY_RETRY_AFTER = timedelta(seconds=30)
"""Пауза перед повтором; удваивается с каждой попыткой (30 с … 8 мин, всего ~15 мин)."""
DELIVERY_MAX_AGE = timedelta(hours=24)
"""Срабатывание старше (по ``created_at``) не доставляется — ``expired``: уведомление о цене
суточной давности уже вводит в заблуждение. Простой уведомителя (выкладка, перезапуск, сбой на
часы) ничего не теряет: строки ждут в БД, после старта уходят с пометкой времени."""
DELIVERY_LATE = timedelta(minutes=5)
"""Доставлено позже этого после записи срабатывания — в push добавляется время срабатывания (в
письме оно есть всегда): уведомление «с опозданием» не выдаётся за свежее."""
DELIVERY_BATCH = 200
"""Сколько срабатываний уведомитель берёт за один проход."""
_not_ready_warned = False


class MailSender(Protocol):
    def __call__(
        self, to: str, subject: str, text: str, idempotency_key: str | None = None
    ) -> None: ...


class PushSender(Protocol):
    def __call__(self, db: Session, user_id: int, payload: dict[str, Any]) -> int: ...


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


def delivery_ready() -> bool:
    """Может ли этот процесс разбирать очередь срабатываний (``deliver_pending``).

    Локально и на staging — всегда: без ключей письмо пишется в лог, push пропускается, как и
    раньше. В production — только с ключом почты и ключами Web Push: иначе письмо ушло бы в лог,
    push молча пропустился бы, а срабатывание отметилось бы доставленным. Без ключей строки ждут
    в очереди процесс, у которого они есть (до ``DELIVERY_MAX_AGE``), в лог — предупреждение.
    """
    return can_deliver_inline() or not settings.is_production


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
) -> int:
    """Push и письмо по настройкам пользователя; тихие часы и дневной лимит соблюдаются.

    Доставлено — ``notified = True`` и ``delivery.status = sent``. Подавлено (нет пользователя,
    тихие часы, дневной лимит) — ``delivery.status = suppressed`` с причиной, ``notified`` остаётся
    False, как и раньше. Письмо идёт с ключом идемпотентности ``alert-trigger-{id}``, push — с
    ``tag`` ``alert-{id}``: повтор после сбоя не даёт второго письма, а push заменяет прежний.
    ``mail`` / ``push`` — отправители (по умолчанию Resend и Web Push; в тестах — подмены).
    """
    mail = mail or _alert_mail
    push = push or send_to_user
    now = now or datetime.now(tz=UTC)
    user = db.get(User, alert.user_id)
    if user is None or user.deleted_at is not None:
        _set_delivery(trig, status=SUPPRESSED, reason="no_user")
        return 0
    ns = settings_for(db, user)
    symbol = _symbol(db, alert.instrument_id) if alert.instrument_id else None
    if alert.instrument_id is None and trig.details.get("symbol"):
        symbol = str(trig.details["symbol"])
    text = condition_text(alert, symbol)
    price = f" по {_fmt(trig.price)}" if trig.price is not None else ""
    tf = alert.timeframe or trig.details.get("tf") or "4h"
    url = f"/chart/{symbol}/{tf}" if symbol else "/alerts"
    if in_quiet_hours(ns, now):
        _set_delivery(trig, status=SUPPRESSED, reason="quiet_hours")
        return 0
    if limit_reached(ns, now):
        _set_delivery(trig, status=SUPPRESSED, reason="daily_limit")
        return 0
    sent = 0
    if ns.push_alerts:
        late = ""
        if trig.created_at is not None and now - trig.created_at > DELIVERY_LATE:
            late = f" (сработал {trig.triggered_at:%d.%m %H:%M} UTC)"
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
    if ns.email_alerts and user.email_verified_at is not None:
        mail(
            user.email,
            f"Алерт: {text}",
            f"{text}{price}.\nВремя: {trig.triggered_at:%d.%m %H:%M UTC}\n"
            f"{settings.frontend_url}{url}\n\n{DISCLAIMER}" + unsubscribe_footer(ns),
            idempotency_key=f"alert-trigger-{trig.id}",
        )
        ns.sent_today += 1
        sent += 1
    trig.notified = True
    _set_delivery(trig, status=SENT)
    return sent


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


def deliver_pending(
    db: Session,
    now: datetime | None = None,
    *,
    mail: MailSender | None = None,
    push: PushSender | None = None,
    limit: int = DELIVERY_BATCH,
) -> int:
    """Уведомитель: доставить срабатывания из очереди (``alert_triggers`` со статусом ``queued``).

    Пока уведомитель лежит, строки ждут в БД — ничего не теряется (до ``DELIVERY_MAX_AGE``).
    Каждое срабатывание — в своей транзакции; строка берётся ``FOR UPDATE SKIP LOCKED`` и
    перепроверяется под блокировкой: второй экземпляр уведомителя (выкладка без простоя) её
    пропустит, а уже доставленную не тронет. Исключение при доставке (сеть, 429/5xx почты, БД) —
    попытка засчитывается, повтор через ``DELIVERY_RETRY_AFTER`` × 2ⁿ; после
    ``DELIVERY_MAX_ATTEMPTS`` — ``failed``, и «ядовитое» срабатывание не держит очередь. Сбой
    между отправкой и фиксацией даёт повтор, но не второе письмо: ключ идемпотентности тот же.
    Тихие часы и лимит проверяются на момент доставки. Возвращает число решённых срабатываний.
    В production без ключей почты и Web Push ничего не делает (``delivery_ready``).
    """
    global _not_ready_warned
    if not delivery_ready():
        if not _not_ready_warned:
            log.warning(
                "доставка алертов: нет ключа почты или Web Push — очередь ждёт процесс с ними"
            )
            _not_ready_warned = True
        return 0
    now = now or datetime.now(tz=UTC)
    done = 0
    for tid in pending_ids(db, now, limit):
        try:
            trig = db.get(AlertTrigger, tid, with_for_update={"skip_locked": True})
            if trig is None or trig.notified or delivery_state(trig).get("status") != QUEUED:
                db.rollback()  # занято другим экземпляром или уже решено
                continue
            alert = db.get(Alert, trig.alert_id)
            if alert is None:
                _set_delivery(trig, status=SUPPRESSED, reason="no_alert")
            elif trig.created_at < now - DELIVERY_MAX_AGE:
                _set_delivery(trig, status=EXPIRED)
                log.warning("срабатывание %s: старше %s — не доставляем", tid, DELIVERY_MAX_AGE)
            else:
                notify_trigger(db, alert, trig, now, mail=mail, push=push)
            db.commit()
            done += 1
        except Exception as exc:
            log.exception("срабатывание %s: ошибка доставки", tid)
            db.rollback()
            _count_failure(db, tid, exc, now)
    return done


def _count_failure(db: Session, tid: int, exc: Exception, now: datetime) -> None:
    """Засчитать попытку: повтор через паузу, после последней (или при постоянном отказе
    почты — неверный адрес) — ``failed``."""
    try:
        trig = db.get(AlertTrigger, tid, with_for_update=True)
        if trig is None or trig.notified or delivery_state(trig).get("status") != QUEUED:
            db.rollback()
            return
        attempts = int(delivery_state(trig).get("attempts", 0)) + 1
        fields: dict[str, Any] = {"attempts": attempts, "error": str(exc)[:200]}
        if isinstance(exc, MailError) and exc.permanent:
            fields["status"] = FAILED
            log.error("срабатывание %s: письмо отклонено (%s), не повторяем", tid, exc)
        elif attempts >= DELIVERY_MAX_ATTEMPTS:
            fields["status"] = FAILED
            log.error("срабатывание %s: %d ошибок доставки, больше не пытаемся", tid, attempts)
        else:
            fields["retry_at"] = (now + DELIVERY_RETRY_AFTER * 2 ** (attempts - 1)).isoformat()
        _set_delivery(trig, **fields)
        db.commit()
    except Exception:
        log.exception("срабатывание %s: учёт ошибки доставки", tid)
        db.rollback()


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
        except Exception:
            # точка сохранения откатилась, строка осталась queued — повторит уведомитель
            log.exception("алерт %s: доставка (повторит уведомитель)", alert.id)
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
