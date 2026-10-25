.PHONY: setup lint format test up down migrate load-history

setup:
	uv sync --all-packages
	uv run pre-commit install

lint:
	uv run ruff check .
	uv run ruff format --check .
	uv run mypy

format:
	uv run ruff check --fix .
	uv run ruff format .

test:
	uv run pytest --cov=engine --cov-report=term-missing

up:
	docker compose -f infra/docker-compose.yml up -d --build

down:
	docker compose -f infra/docker-compose.yml down

migrate:
	cd apps/api && uv run alembic upgrade head

load-history:
	uv run python scripts/load_history.py --help
