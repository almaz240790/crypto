FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_SYSTEM_PYTHON=1
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /usr/local/bin/uv

WORKDIR /srv
COPY pyproject.toml uv.lock ./
COPY packages/engine/pyproject.toml packages/engine/
COPY apps/api/pyproject.toml apps/api/
RUN uv sync --all-packages --no-dev --frozen --no-install-workspace

COPY packages/engine packages/engine
COPY apps/api apps/api
RUN uv sync --all-packages --no-dev --frozen

WORKDIR /srv/apps/api
CMD ["/srv/.venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
