# Platform

Сервис торговых сигналов на таймфрейме H4 для криптовалют: формализованная система, публичная статистика
каждой сделки, терминал-график с анализом паттернов. Только информация, не автоторговля.

- Продуктовый план и ТЗ: [`docs/product-plan.md`](docs/product-plan.md)
- Правила для разработки: [`CLAUDE.md`](CLAUDE.md)
- Архитектурные решения: [`docs/adr/`](docs/adr/)

## Быстрый старт

```bash
make setup                 # uv sync + pre-commit
cp .env.example .env
make up                    # Postgres+TimescaleDB, Redis, API (docker compose)
make migrate               # схема БД
make lint test             # проверки
uv run python scripts/load_history.py --symbols BTCUSDT ETHUSDT --tf 4h 1d 1w --from 2022-01-01
```

## Состояние

Этап 0 (подготовка): каркас репозитория, базовые типы движка, индикаторы EMA/SMA/ATR, схема БД с инвариантами,
загрузчик истории Binance. Дальше — этап 1: сигнальный движок и бэктест (план, раздел 10.3).
