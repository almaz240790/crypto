"""LLM-шлюз (план 2A.10.3; задача 2B.14): факты → текст, постпроверка чисел, кэш, лимиты, бюджет.

Единственная точка вызова Claude API. Промпты лежат в ``apps/llm-gateway/prompts`` с версией
в имени файла. При любом сбое, отклонении постпроверкой или превышении бюджета пользователь
получает шаблонный текст, составленный из тех же фактов.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.chart_data import LAYER_TFS
from app.config import settings
from app.entitlements import entitlements_for
from app.models import Instrument, LlmRequest, Pattern, PatternStatsSnapshot, User
from app.patterns import LOW_N, STATS_HORIZON, pattern_dict, snapshot_dict
from engine.candles import Timeframe

log = logging.getLogger("llm")

PROMPT_VERSION = "explain_pattern.v1"
MAX_OUTPUT_TOKENS = 400
MAX_INPUT_CHARS = 12_000
"""≈ 4 000 токенов входа (план 2A.10.3)."""
CACHE_TTL = 24 * 3600
DAILY_LIMITS: dict[str, int | None] = {"free": 0, "pro": 20, "premium": 100}
PRICES_USD_PER_MTOK: dict[str, tuple[float, float]] = {
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-opus-5-5": (4.0, 20.0),
}
FOOTER = "Текст составлен по данным графика на {at} UTC, не является рекомендацией."
FORBIDDEN = (
    "покупай",
    "продавай",
    "входите",
    "рекоменд",
    "предсказ",
    "вероятность роста",
    "вероятность падения",
    "сигнал на покупку",
    "сигнал на продажу",
    "точность",
)


def prompts_dir() -> Path:
    if settings.llm_prompts_dir:
        return Path(settings.llm_prompts_dir)
    here = Path(__file__).resolve()
    for base in (here.parents[2], here.parents[3]):
        cand = base / "apps" / "llm-gateway" / "prompts"
        if cand.exists():
            return cand
    return here.parents[3] / "apps" / "llm-gateway" / "prompts"


def load_prompt(version: str = PROMPT_VERSION) -> str:
    return (prompts_dir() / f"{version}.md").read_text(encoding="utf-8")


# --- факты ----------------------------------------------------------------------------------------


def _tf_label(tf: str) -> str:
    return "H4" if tf == "4h" else tf.upper()


def pattern_facts(
    db: Session, r: Any | None, inst: Instrument, tf: Timeframe, pattern: Pattern, now: datetime
) -> dict[str, Any]:
    """Структурированные факты для объяснения отметки: только серверные данные."""
    from app.chart_data import layers_cached

    d = pattern_dict(pattern)
    layers = layers_cached(db, r, inst, tf, now) if tf in LAYER_TFS else None
    snap = db.scalar(
        select(PatternStatsSnapshot).where(
            PatternStatsSnapshot.timeframe == tf.value,
            PatternStatsSnapshot.scope == "backfill",
            PatternStatsSnapshot.horizon_bars == STATS_HORIZON,
            PatternStatsSnapshot.instrument_id.is_(None),
            PatternStatsSnapshot.with_context.is_(None),
            PatternStatsSnapshot.year.is_(None),
            PatternStatsSnapshot.type == pattern.type,
        )
    )
    stats = snapshot_dict(snap, pattern.type, STATS_HORIZON)
    facts: dict[str, Any] = {
        "symbol": inst.symbol,
        "timeframe": _tf_label(tf.value),
        "pattern": {
            "title": d["title"],
            "type": d["type"],
            "direction": d["direction"],
            "status": "значимый" if d["significant"] else "найден",
            "confirmed_at": pattern.confirm_time.strftime("%d.%m.%Y %H:%M"),
            "price": d["price"],
            "atr": d["atr"],
            "candles": pattern.geometry.get("candles", []),
        },
        "context": pattern.context,
        "stats": {
            "n": stats["n"],
            "low_n": stats["low_n"],
            "success_rate_pct": None
            if stats["success_rate"] is None
            else round(float(stats["success_rate"]) * 100),
            "ci_low_pct": None if stats["ci_low"] is None else round(float(stats["ci_low"]) * 100),
            "ci_high_pct": None
            if stats["ci_high"] is None
            else round(float(stats["ci_high"]) * 100),
            "horizon_candles": STATS_HORIZON,
            "avg_move_atr": stats["avg_move_atr"],
            "scope": "историческая (бэкфилл)",
        },
    }
    if layers:
        st = layers
        bias = st.get("bias") or {}
        facts["structure"] = {
            "last_event": (st.get("events") or [None])[-1],
            "active_zones": [z for z in st.get("zones", []) if z.get("status") == "active"][-3:],
            "levels": st.get("levels"),
            "bias": bias.get("bias"),
            "d1_trend": bias.get("d1_trend"),
            "w1_trend": bias.get("w1_trend"),
            "atr": st.get("atr"),
        }
    return facts


def facts_hash(facts: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(facts, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()[:16]


# --- шаблонный текст (Free и запасной вариант) ----------------------------------------------------


def template_text(facts: dict[str, Any]) -> str:
    p = facts["pattern"]
    s = facts["stats"]
    parts = [
        f"{p['title']} на {facts['symbol']} {facts['timeframe']}: {p['status']}, "
        f"подтверждён на закрытии свечи {p['confirmed_at']} UTC."
    ]
    ctx = facts.get("context") or {}
    bits: list[str] = []
    run = int(ctx.get("prior_run") or 0)
    if run <= -3:
        bits.append(f"после {-run} свечей снижения")
    elif run >= 3:
        bits.append(f"после {run} свечей роста")
    if ctx.get("sweep"):
        bits.append("со снятием ликвидности")
    if ctx.get("pierced"):
        bits.append("с проколом уровня и закрытием обратно")
    zd = ctx.get("zone_distance_atr")
    if zd is not None and Decimal(str(zd)) <= Decimal("0.5"):
        bits.append("у активной зоны")
    vr = ctx.get("volume_ratio")
    if vr is not None and Decimal(str(vr)) >= Decimal("1.2"):
        bits.append(f"объём ×{Decimal(str(vr)):.1f} к среднему")
    if bits:
        parts.append("Контекст: " + ", ".join(bits) + ".")
    if s["low_n"] or s["success_rate_pct"] is None:
        parts.append("Историческая отработка: мало данных.")
    else:
        parts.append(
            f"Историческая отработка: {s['success_rate_pct']} % случаев с ходом ≥ 1 ATR "
            f"за {s['horizon_candles']} свечей (n={s['n']}, "
            f"интервал {s['ci_low_pct']}–{s['ci_high_pct']} %)."
        )
    return " ".join(parts)


# --- постпроверка чисел ---------------------------------------------------------------------------

_NUM = re.compile(r"(?<![\w.])[-+]?\d[\d\s]*(?:[.,]\d+)?(?![\w])")


def numbers_in(text: str) -> list[Decimal]:
    out: list[Decimal] = []
    for m in _NUM.finditer(text):
        raw = m.group(0).replace(" ", "").replace(" ", "").replace(",", ".")
        try:
            out.append(Decimal(raw))
        except InvalidOperation:
            continue
    return out


def _walk_numbers(obj: Any, acc: set[Decimal]) -> None:
    if isinstance(obj, dict):
        for v in obj.values():
            _walk_numbers(v, acc)
    elif isinstance(obj, list | tuple):
        for v in obj:
            _walk_numbers(v, acc)
    elif isinstance(obj, bool):
        return
    elif isinstance(obj, int | float | Decimal):
        acc.add(Decimal(str(obj)))
    elif isinstance(obj, str):
        for n in numbers_in(obj):
            acc.add(n)
        # даты «27.10.2026 12:00» дают свои числа — допускаем
        for part in re.findall(r"\d+", obj):
            acc.add(Decimal(part))


def allowed_numbers(facts: dict[str, Any]) -> set[Decimal]:
    acc: set[Decimal] = set()
    _walk_numbers(facts, acc)
    acc.update(Decimal(x) for x in ("0", "1", "2", "3", "4", "5", "10", "14", "20", "50"))
    return acc


def _matches(n: Decimal, allowed: set[Decimal]) -> bool:
    """Число совпадает с фактом точно, с округлением до своей точности или с допуском 1e-6."""
    if n in allowed:
        return True
    exp = n.as_tuple().exponent
    digits = -exp if isinstance(exp, int) and exp < 0 else 0
    half = Decimal(5).scaleb(-digits - 1)
    for a in allowed:
        if abs(a - n) <= half:
            return True
        if a != 0 and abs(a - n) / abs(a) <= Decimal("0.000001"):
            return True
    return False


def postcheck(text: str, facts: dict[str, Any]) -> tuple[bool, list[str]]:
    """(прошёл, список нарушений): «чужие» числа и запрещённые формулировки (2A.10.6)."""
    allowed = allowed_numbers(facts)
    bad = [str(n) for n in numbers_in(text) if not _matches(n, allowed)]
    low = text.lower()
    bad += [f"фраза «{w}»" for w in FORBIDDEN if w in low]
    return (not bad), bad


# --- вызов модели ---------------------------------------------------------------------------------


@dataclass(slots=True)
class ModelReply:
    text: str
    input_tokens: int
    output_tokens: int
    refusal: bool = False


def _call_model(system: str, user: str, model: str) -> ModelReply:
    """Единственное место обращения к Claude API (подменяется в тестах)."""
    import anthropic

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=30.0, max_retries=1)
    resp = client.messages.create(
        model=model,
        max_tokens=MAX_OUTPUT_TOKENS,
        output_config={"effort": "low"},
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user}],
    )
    if resp.stop_reason == "refusal":
        return ModelReply("", resp.usage.input_tokens, resp.usage.output_tokens, refusal=True)
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    return ModelReply(text, resp.usage.input_tokens, resp.usage.output_tokens)


def cost_usd(model: str, input_tokens: int, output_tokens: int) -> Decimal:
    i, o = PRICES_USD_PER_MTOK.get(model, (4.0, 20.0))
    return Decimal(str(round(input_tokens * i / 1e6 + output_tokens * o / 1e6, 6)))


# --- лимиты, бюджет, кэш (Redis) ------------------------------------------------------------------


def _day(now: datetime) -> str:
    return now.strftime("%Y%m%d")


def user_used(r: Any | None, user_id: int, now: datetime) -> int:
    if r is None:
        return 0
    try:
        return int(r.get(f"llm:used:{user_id}:{_day(now)}") or 0)
    except Exception:
        return 0


def _bump_user(r: Any | None, user_id: int, now: datetime) -> None:
    if r is None:
        return
    try:
        key = f"llm:used:{user_id}:{_day(now)}"
        r.incr(key)
        r.expire(key, 2 * 24 * 3600)
    except Exception:
        pass


def budget_spent(r: Any | None, now: datetime) -> Decimal:
    if r is None:
        return Decimal(0)
    try:
        return Decimal(str(r.get(f"llm:spent:{_day(now)}") or "0"))
    except Exception:
        return Decimal(0)


def _add_spent(r: Any | None, now: datetime, cost: Decimal) -> None:
    if r is None:
        return
    try:
        key = f"llm:spent:{_day(now)}"
        r.incrbyfloat(key, float(cost))
        r.expire(key, 3 * 24 * 3600)
    except Exception:
        pass


def cache_key(
    inst: Instrument, tf: Timeframe, pattern: Pattern, fh: str, locale: str = "ru"
) -> str:
    t = int(pattern.candle_close_time.timestamp())
    return f"llm:explain:{inst.id}:{tf.value}:{t}:{fh}:{locale}"


# --- основной сценарий ----------------------------------------------------------------------------


def explain_pattern(
    db: Session,
    r: Any | None,
    user: User,
    inst: Instrument,
    tf: Timeframe,
    pattern: Pattern,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Объяснение паттерна: кэш → лимит тарифа → бюджет → модель → постпроверка → шаблон."""
    now = now or datetime.now(tz=UTC)
    facts = pattern_facts(db, r, inst, tf, pattern, now)
    fh = facts_hash(facts)
    footer = FOOTER.format(at=now.strftime("%H:%M"))
    base: dict[str, Any] = {
        "facts_hash": fh,
        "generated_at": now.isoformat(),
        "footer": footer,
        "prompt_version": PROMPT_VERSION,
    }
    ent = entitlements_for(db, user)
    limit = DAILY_LIMITS.get(ent.plan, 0)
    if user.role in ("admin", "owner"):
        limit = DAILY_LIMITS["premium"]
    if not settings.llm_enabled or not settings.anthropic_api_key or limit == 0:
        return {
            **base,
            "text": template_text(facts),
            "source": "template",
            "reason": "plan" if limit == 0 else "disabled",
        }
    key = cache_key(inst, tf, pattern, fh)
    if r is not None:
        try:
            cached = r.get(key)
        except Exception:
            cached = None
        if cached:
            text = cached.decode() if isinstance(cached, bytes) else str(cached)
            return {**base, "text": text, "source": "cache"}
    used = user_used(r, user.id, now)
    if limit is not None and used >= limit:
        return {
            **base,
            "text": template_text(facts),
            "source": "template",
            "reason": "limit",
            "used": used,
            "limit": limit,
        }
    if budget_spent(r, now) >= Decimal(str(settings.llm_daily_budget_usd)):
        _log(db, user.id, settings.llm_model_explain, key, 0, 0, Decimal(0), "budget", None)
        log.warning("LLM: дневной бюджет исчерпан, шаблонный текст")
        return {**base, "text": template_text(facts), "source": "template", "reason": "budget"}
    user_block = "FACTS:\n" + json.dumps(facts, ensure_ascii=False, sort_keys=True)
    if len(user_block) > MAX_INPUT_CHARS:
        facts.pop("structure", None)
        user_block = (
            "FACTS:\n" + json.dumps(facts, ensure_ascii=False, sort_keys=True)[:MAX_INPUT_CHARS]
        )
    started = time.monotonic()
    model = settings.llm_model_explain
    try:
        reply = _call_model(load_prompt(), user_block, model)
    except Exception:
        log.exception("LLM: ошибка вызова")
        _log(
            db,
            user.id,
            model,
            key,
            0,
            0,
            Decimal(0),
            "error",
            int((time.monotonic() - started) * 1000),
        )
        return {**base, "text": template_text(facts), "source": "template", "reason": "error"}
    ms = int((time.monotonic() - started) * 1000)
    cost = cost_usd(model, reply.input_tokens, reply.output_tokens)
    _add_spent(r, now, cost)
    _bump_user(r, user.id, now)
    if reply.refusal:
        _log(db, user.id, model, key, reply.input_tokens, reply.output_tokens, cost, "refusal", ms)
        return {**base, "text": template_text(facts), "source": "template", "reason": "refusal"}
    ok, problems = postcheck(reply.text, facts)
    if not ok:
        _log(db, user.id, model, key, reply.input_tokens, reply.output_tokens, cost, "rejected", ms)
        log.info("LLM: ответ отброшен постпроверкой: %s", problems)
        return {
            **base,
            "text": template_text(facts),
            "source": "template",
            "reason": "postcheck",
            "problems": problems,
        }
    _log(db, user.id, model, key, reply.input_tokens, reply.output_tokens, cost, "ok", ms)
    if r is not None:
        with contextlib.suppress(Exception):
            r.set(key, reply.text, ex=CACHE_TTL)
    return {**base, "text": reply.text, "source": "llm", "used": used + 1, "limit": limit}


def _log(
    db: Session,
    user_id: int,
    model: str,
    key: str,
    in_tok: int,
    out_tok: int,
    cost: Decimal,
    outcome: str,
    ms: int | None,
) -> None:
    db.add(
        LlmRequest(
            user_id=user_id,
            kind="explain",
            model=model,
            prompt_version=PROMPT_VERSION,
            cache_key=key[:120],
            input_tokens=in_tok,
            output_tokens=out_tok,
            cost_usd=cost,
            outcome=outcome,
            latency_ms=ms,
        )
    )
    db.commit()


def low_n_note() -> str:
    return f"при n < {LOW_N} процент не показывается"
