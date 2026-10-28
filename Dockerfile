FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_SYSTEM_PYTHON=1
COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /usr/local/bin/uv

WORKDIR /srv
COPY pyproject.toml uv.lock ./
COPY packages/engine/pyproject.toml packages/engine/
COPY apps/api/pyproject.toml apps/api/
RUN uv sync --all-packages --no-dev --frozen --no-install-workspace

COPY packages/engine packages/engine
COPY apps/api apps/api
COPY scripts scripts
# промпты LLM (план 2A.10.3): без них «Объяснить» и «Спросить» падают с FileNotFoundError
COPY apps/llm-gateway/prompts apps/llm-gateway/prompts
RUN uv sync --all-packages --no-dev --frozen

WORKDIR /srv/apps/api
CMD ["sh", "-c", "exec /srv/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
