from fastapi import FastAPI
from sqlalchemy import text

from app.config import settings
from app.db import engine

app = FastAPI(title="Platform API", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    """Жив ли процесс и доступна ли БД. Для docker healthcheck и статус-страницы."""
    db = "ok"
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1"))
    except Exception as exc:
        db = f"error: {type(exc).__name__}"
    return {"status": "ok" if db == "ok" else "degraded", "db": db, "env": settings.app_env}
