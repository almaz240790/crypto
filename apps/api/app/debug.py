"""Служебные страницы для визуальной проверки движка (план 10.4: 20 примеров на правило).

Включаются только при заданном ``DEBUG_TOKEN``; доступ по ``?token=``. Рисуют PNG по данным
из БД: свечи, swing-точки, BOS/CHoCH, зоны OB / S/D / FVG со статусом. Не для пользователей.
"""

from __future__ import annotations

import io
import random
from collections.abc import Iterator, Sequence
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import matplotlib
from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import HTMLResponse, StreamingResponse
from sqlalchemy import text

from app.config import settings
from app.db import engine as db_engine
from engine.candles import Candle, Timeframe
from engine.structure import EventType, MarketStructure, SwingKind, analyze_structure
from engine.zones import Zone, ZoneKind, ZoneStatus, analyze_zones

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

router = APIRouter(prefix="/debug", tags=["debug"])

CONTEXT = 300
"""Сколько свечей перед окном рисования брать для расчёта структуры."""

# Палитра из плана 5.3 (светлая тема)
BG, SURFACE, BORDER = "#F4F3EF", "#FFFFFF", "#D9D6CE"
TEXT, MUTED = "#1A1A1A", "#8A877F"
UP, DOWN, ACCENT, WARN = "#1F7A4D", "#B3261E", "#0F4C81", "#9A6700"


def _check(token: str | None) -> None:
    if not settings.debug_token:
        raise HTTPException(404)
    if token != settings.debug_token:
        raise HTTPException(403, "неверный token")


def load_candles(symbol: str, tf: Timeframe, end: datetime, limit: int) -> list[Candle]:
    """Последние ``limit`` закрытых свечей до ``end`` (исключительно) из БД."""
    with db_engine.connect() as conn:
        rows = conn.execute(
            text(
                "select c.open_time, c.open, c.high, c.low, c.close, c.volume, c.quote_volume, "
                "c.trades from candles c join instruments i on i.id = c.instrument_id "
                "where i.symbol = :s and c.timeframe = :tf and c.open_time < :end "
                "order by c.open_time desc limit :n"
            ),
            {"s": symbol, "tf": tf.value, "end": end - tf.delta, "n": limit},
        ).all()
    return [
        Candle(r[0].astimezone(UTC), r[1], r[2], r[3], r[4], r[5], r[6], r[7])
        for r in reversed(rows)
    ]


def render_png(
    candles: Sequence[Candle],
    structure: MarketStructure,
    zones: Sequence[Zone],
    window: int,
    title: str,
) -> bytes:
    n = len(candles)
    start = max(0, n - window)
    list(range(n))
    fig, ax = plt.subplots(figsize=(16, 8), dpi=110)
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(SURFACE)
    for sp in ax.spines.values():
        sp.set_color(BORDER)
    ax.tick_params(colors=MUTED, labelsize=8)
    ax.grid(True, color=BORDER, linewidth=0.5)

    # свечи
    for i in range(start, n):
        c = candles[i]
        color = UP if c.close >= c.open else DOWN
        ax.plot([i, i], [float(c.low), float(c.high)], color=color, linewidth=0.8)
        body_bottom = float(min(c.open, c.close))
        body_h = float(abs(c.close - c.open)) or float(c.high - c.low) * 0.01
        ax.add_patch(Rectangle((i - 0.35, body_bottom), 0.7, body_h, color=color, linewidth=0))

    # swing-точки
    for s in structure.swings:
        if s.index < start:
            continue
        marker, _dy = ("v", 1) if s.kind is SwingKind.HIGH else ("^", -1)
        ax.plot(s.index, float(s.price), marker=marker, color=TEXT, markersize=5)

    # BOS / CHoCH: линия от пробитого swing до свечи пробоя
    for e in structure.events:
        if e.index < start:
            continue
        color = ACCENT if e.type is EventType.BOS else WARN
        ax.plot(
            [e.broken_swing.index, e.index], [float(e.level)] * 2, color=color, linewidth=1, ls="--"
        )
        ax.annotate(
            f"{e.type.upper()} {e.direction}",
            (e.index, float(e.level)),
            xytext=(2, 4),
            textcoords="offset points",
            fontsize=7,
            color=color,
            family="monospace",
        )

    # зоны: от создания до инвалидации или до правого края
    styles = {
        ZoneKind.OB: (ACCENT, 0.18, ""),
        ZoneKind.SD: (MUTED, 0.18, ""),
        ZoneKind.FVG: (WARN, 0.10, "//"),
    }
    for z in zones:
        right = z.invalidated_index if z.invalidated_index is not None else n - 1
        if right < start:
            continue
        left = max(z.created_index, start)
        color, alpha, hatch = styles[z.kind]
        if z.status is ZoneStatus.INVALIDATED:
            alpha *= 0.4
        ax.add_patch(
            Rectangle(
                (left, float(z.bottom)),
                right - left + 0.5,
                float(z.height),
                facecolor=color,
                alpha=alpha,
                edgecolor=color,
                linewidth=0.6,
                hatch=hatch,
            )
        )
        ax.annotate(
            f"{z.kind.upper()} {z.status}",
            (left, float(z.top)),
            xytext=(2, -8),
            textcoords="offset points",
            fontsize=6,
            color=color,
            family="monospace",
        )

    ticks = list(range(start, n, max(1, window // 12)))
    ax.set_xticks(ticks)
    ax.set_xticklabels([candles[i].open_time.strftime("%d.%m %H:%M") for i in ticks], rotation=0)
    ax.set_xlim(start - 1, n + 1)
    lo = min(float(c.low) for c in candles[start:])
    hi = max(float(c.high) for c in candles[start:])
    pad = (hi - lo) * 0.05
    ax.set_ylim(lo - pad, hi + pad)
    ax.set_title(title, loc="left", fontsize=10, color=TEXT, family="monospace")
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=BG)
    plt.close(fig)
    return buf.getvalue()


def _parse_end(end: str | None) -> datetime:
    if not end:
        return datetime.now(tz=UTC)
    return datetime.fromisoformat(end).replace(tzinfo=UTC)


@router.get("/structure/{symbol}.png")
def structure_png(
    symbol: str,
    token: str | None = None,
    tf: str = "4h",
    end: str | None = Query(None, description="ISO-дата, окно заканчивается до неё"),
    n: int = Query(160, ge=20, le=600),
) -> Response:
    _check(token)
    timeframe = Timeframe(tf)
    candles = load_candles(symbol.upper(), timeframe, _parse_end(end), n + CONTEXT)
    if len(candles) < 20:
        raise HTTPException(404, "нет данных")
    structure = analyze_structure(candles)
    zones = analyze_zones(candles, structure)
    title = (
        f"{symbol.upper()} {tf}  {candles[-n].open_time:%d.%m.%Y} – "
        f"{candles[-1].open_time:%d.%m.%Y}  trend={structure.trend} "
        f"direction={structure.direction}"
    )
    png = render_png(candles, structure, zones, n, title)
    return Response(png, media_type="image/png")


@router.get("/structure/{symbol}.json")
def structure_json(
    symbol: str, token: str | None = None, tf: str = "4h", end: str | None = None, n: int = 160
) -> dict[str, object]:
    _check(token)
    timeframe = Timeframe(tf)
    candles = load_candles(symbol.upper(), timeframe, _parse_end(end), n + CONTEXT)
    structure = analyze_structure(candles)
    zones = analyze_zones(candles, structure)
    start = max(0, len(candles) - n)

    def dec(x: Decimal) -> str:
        return format(x.normalize(), "f")

    return {
        "symbol": symbol.upper(),
        "tf": tf,
        "trend": structure.trend,
        "direction": structure.direction,
        "events": [
            {
                "time": e.time.isoformat(),
                "type": e.type,
                "direction": e.direction,
                "level": dec(e.level),
                "broken_swing_time": e.broken_swing.time.isoformat(),
            }
            for e in structure.events
            if e.index >= start
        ],
        "zones": [
            {
                "kind": z.kind,
                "direction": z.direction,
                "top": dec(z.top),
                "bottom": dec(z.bottom),
                "created": candles[z.created_index].open_time.isoformat(),
                "status": z.status,
            }
            for z in zones
            if (z.invalidated_index or len(candles) - 1) >= start
        ],
    }


@router.get("/examples", response_class=HTMLResponse)
def examples(token: str | None = None, seed: int = 1, count: int = 20) -> str:
    """Страница с набором случайных окон по разным парам и датам для ручной проверки."""
    _check(token)
    with db_engine.connect() as conn:
        symbols = [
            r[0]
            for r in conn.execute(
                text("select symbol from instruments where is_active order by symbol")
            ).all()
        ]
    rng = random.Random(seed)
    items = []
    for _ in range(count):
        symbol = rng.choice(symbols)
        end = datetime(2022, 8, 1, tzinfo=UTC) + timedelta(days=rng.randint(0, 1450))
        url = f"/debug/structure/{symbol}.png?token={token}&tf=4h&end={end:%Y-%m-%d}&n=160"
        items.append(
            f"<figure><figcaption><code>{symbol} 4h до {end:%d.%m.%Y}</code> "
            f'<a href="{url.replace(".png", ".json")}">json</a></figcaption>'
            f'<img src="{url}" loading="lazy" style="width:100%"></figure>'
        )
    style = (
        "body{background:#F4F3EF;color:#1A1A1A;font:14px/1.4 sans-serif;max-width:1440px;"
        "margin:0 auto;padding:16px} figure{margin:0 0 24px} figcaption{margin-bottom:4px}"
    )
    return (
        "<!doctype html><meta charset=utf-8><title>Проверка структуры</title>"
        f"<style>{style}</style>"
        f"<p>Seed {seed}, {count} примеров. Другой набор: <code>?seed=2</code>.</p>"
        + "".join(items)
    )


@router.get("/backtests")
def backtests(token: str | None = None, limit: int = 20) -> list[dict[str, object]]:
    """Список прогонов бэктеста с ключевыми метриками."""
    _check(token)
    with db_engine.connect() as conn:
        rows = conn.execute(
            text(
                "select id, created_at, strategy_version, period_start, period_end, note, "
                "result_summary from backtest_runs order by id desc limit :n"
            ),
            {"n": limit},
        ).all()
    out = []
    for r in rows:
        m = (r[6] or {}).get("metrics", {})
        out.append(
            {
                "id": r[0],
                "created_at": r[1].isoformat(),
                "strategy_version": r[2],
                "period": [r[3].date().isoformat(), r[4].date().isoformat()],
                "note": r[5],
                "closed": m.get("closed"),
                "winrate": m.get("winrate"),
                "avg_r": m.get("avg_r"),
                "profit_factor": m.get("profit_factor"),
                "max_drawdown_r": m.get("max_drawdown_r"),
                "sum_r": m.get("sum_r"),
            }
        )
    return out


@router.get("/backtests/{run_id}")
def backtest_detail(
    run_id: int, token: str | None = None, trades: bool = False
) -> dict[str, object]:
    _check(token)
    with db_engine.connect() as conn:
        r = conn.execute(
            text(
                "select id, created_at, strategy_version, params, execution, note, result_summary, "
                "trades from backtest_runs where id = :i"
            ),
            {"i": run_id},
        ).first()
    if r is None:
        raise HTTPException(404)
    out: dict[str, object] = {
        "id": r[0],
        "created_at": r[1].isoformat(),
        "strategy_version": r[2],
        "params": r[3],
        "execution": r[4],
        "note": r[5],
        "summary": r[6],
    }
    if trades:
        out["trades"] = r[7]
    return out


@router.get("/export/candles.csv")
def export_candles(symbol: str, token: str | None = None, tf: str = "4h") -> StreamingResponse:
    """Выгрузка свечей инструмента CSV (для локальных прогонов бэктеста)."""
    _check(token)
    timeframe = Timeframe(tf)

    def rows() -> Iterator[str]:
        yield "open_time,open,high,low,close,volume,quote_volume,trades\n"
        with db_engine.connect() as conn:
            result = conn.execution_options(stream_results=True).execute(
                text(
                    "select c.open_time, c.open, c.high, c.low, c.close, c.volume, "
                    "c.quote_volume, c.trades from candles c "
                    "join instruments i on i.id = c.instrument_id "
                    "where i.symbol = :s and i.market_type = 'futures' and c.timeframe = :tf "
                    "order by c.open_time"
                ),
                {"s": symbol.upper(), "tf": timeframe.value},
            )
            for r in result:
                yield f"{int(r[0].timestamp())},{r[1]},{r[2]},{r[3]},{r[4]},{r[5]},{r[6]},{r[7]}\n"

    name = f"{symbol.upper()}-{timeframe.value}.csv"
    return StreamingResponse(
        rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={name}"},
    )


@router.get("/export/derivatives.csv")
def export_derivatives(
    symbol: str, token: str | None = None, what: str = "funding"
) -> StreamingResponse:
    """funding: time,rate; oi: time,oi_quote; ls: time,top_traders_ratio,global_ratio."""
    _check(token)
    queries = {
        "funding": "select f.funding_time, f.rate from funding_rates f",
        "oi": "select o.time, o.oi_quote from open_interest o",
        "ls": "select l.time, l.top_traders_ratio, l.global_ratio from long_short_ratios l",
    }
    if what not in queries:
        raise HTTPException(400, "what: funding | oi | ls")
    alias = queries[what].split()[-1]
    time_col = "funding_time" if what == "funding" else "time"

    def rows() -> Iterator[str]:
        with db_engine.connect() as conn:
            result = conn.execution_options(stream_results=True).execute(
                text(
                    f"{queries[what]} join instruments i on i.id = {alias}.instrument_id "
                    f"where i.symbol = :s and i.market_type = 'futures' order by {alias}.{time_col}"
                ),
                {"s": symbol.upper()},
            )
            for r in result:
                yield ",".join([str(int(r[0].timestamp())), *(str(x) for x in r[1:])]) + "\n"

    return StreamingResponse(rows(), media_type="text/csv")


@router.get("/live")
def live_status(token: str | None = None) -> dict[str, Any]:
    """Состояние WebSocket-хаба: слушатель Redis, клиенты, счётчики (план 2.16)."""
    _check(token)
    from app.live import hub

    return hub.status()
