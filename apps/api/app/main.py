import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import redis
import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.config import settings
from app.db import SessionLocal, engine
from app.debug import router as debug_router
from app.live import hub
from app.live import router as live_router
from app.routers.admin import router as admin_router
from app.routers.auth import router as auth_router
from app.routers.billing import router as billing_router
from app.routers.chart import router as chart_router
from app.routers.drawings import router as drawings_router
from app.routers.public import router as public_router
from app.routers.support import router as support_router
from app.routers.user import router as user_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)

if settings.sentry_dsn:
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.app_env,
        traces_sample_rate=0.0,
        send_default_pii=False,
    )


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    await hub.stop()


app = FastAPI(title="Platform API", version="0.1.0", lifespan=lifespan)
app.include_router(live_router)
app.include_router(debug_router)
app.include_router(auth_router)
app.include_router(billing_router)
app.include_router(chart_router)
app.include_router(drawings_router)
app.include_router(admin_router)
app.include_router(public_router)
app.include_router(support_router)
app.include_router(user_router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    """Жив ли процесс и доступна ли БД. Для docker healthcheck и статус-страницы."""
    db = "ok"
    schema = "-"
    candles = "-"
    try:
        with engine.connect() as conn:
            schema = str(conn.execute(text("select version_num from alembic_version")).scalar())
            candles = str(conn.execute(text("select count(*) from candles")).scalar())
    except Exception as exc:
        db = f"error: {type(exc).__name__}"
    return {
        "status": "ok" if db == "ok" else "degraded",
        "db": db,
        "schema": schema,
        "candles": candles,
        "env": settings.app_env,
    }


@app.get("/status")
def public_status() -> dict[str, Any]:
    """Публичная статус-страница (план 6.7): состояние компонентов и инциденты за 7 дней.

    Монитор крутится в уведомителе раз в минуту и кладёт результат в Redis; если кэша нет —
    считаем на месте (без алертов, чтобы не слать письма из API).
    """
    from app.monitor import collect, evaluate, status_payload

    r: Any | None
    try:
        r = redis.from_url(settings.redis_url, socket_timeout=2)
        cached = r.get("monitor:status")
        if cached:
            return dict(json.loads(cached))
    except Exception:
        r = None
    with SessionLocal() as db:
        snap = collect(db, r)
        return status_payload(db, evaluate(snap), snap.now)
