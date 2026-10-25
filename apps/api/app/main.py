from fastapi import FastAPI
from sqlalchemy import text

from app.config import settings
from app.db import engine

app = FastAPI(title="Platform API", version="0.1.0")


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
