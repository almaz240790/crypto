from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.config import settings
from app.db import engine
from app.debug import router as debug_router
from app.live import hub
from app.live import router as live_router
from app.routers.auth import router as auth_router
from app.routers.public import router as public_router
from app.routers.user import router as user_router


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    await hub.stop()


app = FastAPI(title="Platform API", version="0.1.0", lifespan=lifespan)
app.include_router(live_router)
app.include_router(debug_router)
app.include_router(auth_router)
app.include_router(public_router)
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
