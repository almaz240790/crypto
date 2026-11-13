"""API-ключ (план 3.10) на открытых эндпоинтах и состояние аккаунта в ``optional_user``.

Ревью PR #162: ``optional_user`` читал только ``Authorization: Bearer`` и не смотрел на
``X-API-Key`` — клиент Premium с ключом получал ленту, карточку и график гостя (только закрытые
сигналы, минутные ТФ — 403, без слоя сигналов), хотя /api-docs обещает те же данные по ключу.
Неверный ключ тихо становился гостем, а удалённый или заблокированный по токену получал данные
своего тарифа. Теперь ``current_user`` и ``optional_user`` решают одинаково (``auth.py``), а
роутеры ``/v1`` и ``/v1/chart`` проверяют ключ и там, где пользователь не нужен.

Ключ открывает только эндпоинты со страницы /api-docs (ADR-0017): личные разделы (выгрузка
данных, ключи, сессии, платежи…) и всё остальное по ключу — 403, по токену сайта — как раньше.

Тесты на БД (нужен DATABASE_URL с миграциями до head; без БД пропускаются) идут во внешней
транзакции и откатываются в конце.
"""

from __future__ import annotations

import re
import secrets
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

from app import apikeys, auth, ratelimit
from app.config import settings
from app.db import engine
from app.models import ApiKey, Instrument, Signal, Strategy, StrategyVersion, Subscription, User
from app.routers import public


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select published from signals limit 0"))
            conn.execute(text("select 1 from api_keys limit 0"))
        return True
    except (OperationalError, DBAPIError):
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="БД с миграциями до head недоступна")


@pytest.fixture
def db() -> Iterator[Session]:
    conn = engine.connect()
    outer = conn.begin()
    s = Session(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False)
    try:
        yield s
    finally:
        s.close()
        outer.rollback()
        conn.close()


@pytest.fixture
def client(db: Session, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """Всё приложение (те же роутеры и зависимости, что в бою) на транзакции теста. Биллинг
    включён: тариф решает подписка. Лимиты — в памяти процесса (без Redis)."""
    from app.main import app

    monkeypatch.setattr(settings, "billing_enabled", True)
    monkeypatch.setattr(settings, "redis_url", "")
    ratelimit._memory.values.clear()
    app.dependency_overrides[auth.get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(auth.get_db, None)
        ratelimit._memory.values.clear()


# --- данные --------------------------------------------------------------------------------------


def _user(db: Session, plan: str | None = None, **fields: Any) -> User:
    u = User(
        email=f"apikey-pub-{secrets.token_hex(4)}@example.test",
        role="user",
        email_verified_at=datetime(2026, 10, 1, tzinfo=UTC),
        **fields,
    )
    db.add(u)
    db.flush()
    if plan is not None:
        end = datetime.now(tz=UTC) + timedelta(days=30)
        db.add(Subscription(user_id=u.id, plan=plan, status="active", current_period_end=end))
        db.flush()
    return u


def _key(db: Session, user: User, revoked: bool = False) -> str:
    raw, prefix, key_hash = apikeys.new_key()
    db.add(
        ApiKey(
            user_id=user.id,
            name="test",
            prefix=prefix,
            key_hash=key_hash,
            revoked_at=datetime.now(tz=UTC) if revoked else None,
        )
    )
    db.flush()
    return raw


def _instrument(db: Session) -> Instrument:
    tag = secrets.token_hex(3).upper()
    inst = Instrument(
        exchange="binance", symbol=f"AK{tag}USDT", base=f"AK{tag}", quote="USDT",
        market_type="futures", tick_size=Decimal("0.01"), lot_size=Decimal("0.001"),
    )  # fmt: skip
    db.add(inst)
    db.flush()
    return inst


def _signal(
    db: Session, inst: Instrument, at: datetime, grade: str = "A", status: str = "active"
) -> Signal:
    tag = secrets.token_hex(3)
    strat = Strategy(slug=f"apikey-{tag}", name="api key test")
    db.add(strat)
    db.flush()
    ver = StrategyVersion(strategy_id=strat.id, version=f"0.{tag}.0", params={}, status="live")
    db.add(ver)
    db.flush()
    s = Signal(
        public_id=f"ak{secrets.token_hex(6)}", strategy_version_id=ver.id, instrument_id=inst.id,
        direction="long", candle_close_time=at, entry_market=Decimal(100),
        stop_loss=Decimal(95), tp1=Decimal(105), tp2=Decimal(110), tp3=Decimal(120),
        rr_tp2=Decimal(2), score=80 if grade == "A" else 60, grade=grade, input_hash="x" * 64,
        status=status, scope="live",
    )  # fmt: skip
    db.add(s)
    db.flush()
    return s


def _world(db: Session) -> tuple[Instrument, Signal, Signal]:
    """Инструмент и два свежих сигнала (закрытие свечи час назад): активный A и закрытый B. Гость
    видит только закрытый; Free — ни один (градация A, задержка 12 ч); Premium — оба."""
    now = datetime.now(tz=UTC)
    inst = _instrument(db)
    active = _signal(db, inst, now - timedelta(hours=1))
    closed = _signal(db, inst, now - timedelta(hours=1), grade="B", status="closed_sl")
    return inst, active, closed


def _key_header(raw: str) -> dict[str, str]:
    return {"x-api-key": raw}


def _bearer(user: User) -> dict[str, str]:
    return {"authorization": f"Bearer {auth.make_access_token(user)}"}


def _ids(r: Any) -> set[str]:
    assert r.status_code == 200, r.text
    return {s["id"] for s in r.json()["items"]}


# --- ключ Premium получает данные Premium ------------------------------------------------------


def test_premium_key_gets_premium_feed_card_and_chart(db: Session, client: TestClient) -> None:
    inst, active, closed = _world(db)
    premium = _user(db, "premium")
    key = _key_header(_key(db, premium))

    feed = client.get(f"/v1/signals?symbol={inst.symbol}", headers=key)
    assert _ids(feed) == {active.public_id, closed.public_id}  # без задержки и градаций гостя
    assert feed.json()["restrictions"]["plan"] == "premium"
    assert _ids(client.get(f"/v1/signals?symbol={inst.symbol}&status=open", headers=key)) == {
        active.public_id
    }
    # карточка и свечи активного сигнала — гостю 403
    assert client.get(f"/v1/signals/{active.public_id}", headers=key).status_code == 200
    assert client.get(f"/v1/signals/{active.public_id}/candles", headers=key).status_code == 200
    # структура на момент сигнала — не в /api-docs: по ключу закрыта (ADR-0017), по токену — открыта
    analysis = f"/v1/signals/{active.public_id}/analysis"
    r = client.get(analysis, headers=key)
    assert r.status_code == 403 and r.json()["detail"] == apikeys.OUT_OF_SCOPE, r.text
    assert client.get(analysis, headers=_bearer(premium)).status_code == 200
    # форвард-лента — право Premium
    assert client.get("/v1/signals?scope=forward", headers=key).status_code == 200
    # график: 1m открыт, слой сигналов есть
    candles = client.get(f"/v1/chart/candles?symbol={inst.symbol}&tf=1m", headers=key)
    assert candles.status_code == 200, candles.text
    layers = client.get(f"/v1/chart/layers?symbol={inst.symbol}&tf=1m", headers=key)
    assert layers.status_code == 200, layers.text
    assert active.public_id in {s["id"] for s in layers.json()["signals"]}

    # тот же запрос без ключа — гость, как раньше
    guest = client.get(f"/v1/signals?symbol={inst.symbol}")
    assert _ids(guest) == {closed.public_id} and guest.json()["restrictions"] is None
    assert client.get(f"/v1/signals/{active.public_id}").status_code == 403
    assert client.get(f"/v1/chart/candles?symbol={inst.symbol}&tf=1m").status_code == 403
    assert client.get(f"/v1/chart/layers?symbol={inst.symbol}&tf=1m").json()["signals"] == []


def test_key_wins_over_bearer(db: Session, client: TestClient) -> None:
    """Ключ и токен вместе — решает ключ, как у ``current_user``: ключ Free с токеном Premium —
    403 (тариф без API), а не данные Premium по токену."""
    inst, _, _ = _world(db)
    free_key = _key(db, _user(db))
    headers = {**_key_header(free_key), **_bearer(_user(db, "premium"))}
    r = client.get(f"/v1/signals?symbol={inst.symbol}", headers=headers)
    assert r.status_code == 403, r.text


# --- ключ, который не подходит, — ошибка, а не гость --------------------------------------------


# все эндпоинты со страницы /api-docs (apps/web/src/lib/apiDocs.ts) — запрос с параметрами
def _docs_paths(inst: Instrument, sig: Signal) -> list[str]:
    s, sid = inst.symbol, sig.public_id
    by_endpoint = {
        "/v1/signals": f"/v1/signals?symbol={s}&status=closed&limit=50",
        "/v1/signals/{public_id}": f"/v1/signals/{sid}",
        "/v1/signals/{public_id}/candles": f"/v1/signals/{sid}/candles?tf=4h&before=20&after=0",
        "/v1/stats": "/v1/stats?scope=live",
        "/v1/stats/trades": "/v1/stats/trades?scope=live&limit=5",
        "/v1/stats/export.csv": "/v1/stats/export.csv?scope=live",
        "/v1/stats/patterns": "/v1/stats/patterns?tf=4h",
        "/v1/stats/figures": "/v1/stats/figures?tf=4h",
        "/v1/chart/candles": f"/v1/chart/candles?symbol={s}&tf=4h&limit=20",
        "/v1/chart/layers": f"/v1/chart/layers?symbol={s}&tf=1m",
        "/v1/chart/patterns": f"/v1/chart/patterns?symbol={s}&tf=4h",
        "/v1/chart/figures": f"/v1/chart/figures?symbol={s}&tf=4h",
        "/v1/chart/derivatives": f"/v1/chart/derivatives?symbol={s}&tf=4h&limit=20",
        "/v1/screener": f"/v1/screener?symbols={s}",
        "/v1/screener/export.csv": f"/v1/screener/export.csv?symbols={s}",
        "/v1/instruments": "/v1/instruments",
        "/v1/prices": f"/v1/prices?symbols={s}",
        "/v1/journal": "/v1/journal?limit=5",
        "/v1/journal/analytics": "/v1/journal/analytics",
        "/v1/alerts": "/v1/alerts",
    }
    # новый пункт списка ключа — сюда тоже: каждый открытый ключу эндпоинт проверяется запросом
    assert set(by_endpoint) == apikeys.KEY_ENDPOINTS
    return list(by_endpoint.values())


def test_every_documented_endpoint_honours_the_key(
    db: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Каждый эндпоинт /api-docs по ключу Premium — 200; ключ Free — 403 (тариф без API);
    отозванный, неизвестный или не ключ — 401. Было: открытые эндпоинты ключ не смотрели —
    200 гостю с любым ключом."""
    # скринер считается по всем инструментам базы — здесь не нужен
    monkeypatch.setattr(public, "screener_cached", lambda db: ([], datetime.now(tz=UTC)))
    inst, active, _ = _world(db)
    paths = _docs_paths(inst, active)
    premium = _user(db, "premium")
    premium_key = _key(db, premium)
    bad_keys = {
        "revoked": _key(db, premium, revoked=True),
        "unknown": "pk_" + "x" * 43,
        "garbage": "garbage",
        "deleted": _key(db, _user(db, "premium", deleted_at=datetime.now(tz=UTC))),
    }
    free_key = _key(db, _user(db))
    for path in paths:
        r = client.get(path, headers=_key_header(premium_key))
        assert r.status_code == 200, (path, r.text)
        r = client.get(path, headers=_key_header(free_key))
        assert r.status_code == 403, (path, r.text)
        assert r.json()["detail"] == "API-ключи доступны на тарифе Premium"
        for name, raw in bad_keys.items():
            r = client.get(path, headers=_key_header(raw))
            assert r.status_code == 401, (path, name, r.text)


# личные разделы: выгрузка данных, ключи, сессии, платежи и другие GET за ``current_user``
PERSONAL = (
    "/v1/me/export.json",
    "/v1/me/api-keys",
    "/v1/me/sessions",
    "/v1/billing/payments",
    "/v1/auth/me",
    "/v1/billing/me",
    "/v1/me/identities",
    "/v1/me/2fa",
    "/v1/me/notifications",
    "/v1/watchlist",
    "/v1/screener/screens",
    "/v1/support/tickets",
    "/v1/chart/layouts",
    "/v1/journal/export.csv",
    "/v1/alerts/triggers",
)


def test_key_does_not_open_personal_endpoints(db: Session, client: TestClient) -> None:
    """Ключ Premium на личных разделах — 403 «API-ключ не даёт доступа…», и с токеном рядом тоже
    (ключ важнее токена, вход по токену не подменяет отказ). Токен сайта — как раньше, 200. Было:
    ``current_user`` принимал ключ, и скрипт с ключом читал выгрузку данных аккаунта, список
    ключей, сессии и платежи."""
    owner = _user(db, "premium")
    key = _key_header(_key(db, owner))
    bearer = _bearer(owner)
    for path in PERSONAL:
        r = client.get(path, headers=key)
        assert r.status_code == 403, (path, r.text)
        assert r.json()["detail"] == apikeys.OUT_OF_SCOPE, path
        r = client.get(path, headers={**key, **bearer})
        assert r.status_code == 403 and r.json()["detail"] == apikeys.OUT_OF_SCOPE, path
        r = client.get(path, headers=bearer)
        assert r.status_code == 200, (path, r.text)
    # запись по ключу — по-прежнему «только чтение»: ключом нельзя отозвать ключ или выйти везде
    for path in ("/v1/me/api-keys/1", "/v1/me/sessions"):
        r = client.delete(path, headers=key)
        assert r.status_code == 403 and r.json()["detail"] == "API-ключ даёт только чтение", path


def test_every_other_endpoint_refuses_the_key(db: Session, client: TestClient) -> None:
    """Список закрытый: каждый GET-эндпоинт приложения не из /api-docs по ключу Premium — 403, в
    том числе открытые данные без входа, служебные и админка. Новый эндпоинт попадает сюда сам."""
    from app.main import app

    key = _key_header(_key(db, _user(db, "premium")))
    paths = app.openapi()["paths"]
    others = sorted(
        p for p, ops in paths.items() if "get" in ops and p not in apikeys.KEY_ENDPOINTS
    )
    assert {"/v1/me/export.json", "/v1/admin/users", "/health", "/v1/strategies"} <= set(others)
    for path in others:
        r = client.get(re.sub(r"\{[^}]+\}", "1", path), headers=key)
        assert r.status_code == 403, (path, r.text)
        assert r.json()["detail"] == apikeys.OUT_OF_SCOPE, path


def test_key_scope_is_not_fooled_by_the_address(db: Session, client: TestClient) -> None:
    """Список сверяется с эндпоинтом, который выбрал роутер, а не со строкой адреса: слэш в конце,
    закодированный слэш, похожий префикс, путь в параметрах запроса, HEAD/OPTIONS и регистр не
    открывают ключу личные разделы и не подменяют открытый эндпоинт закрытым."""
    _, active, _ = _world(db)
    key = _key_header(_key(db, _user(db, "premium")))
    # слэш в конце — переадресация без данных, после неё тот же отказ
    r = client.get("/v1/me/export.json/", headers=key, follow_redirects=False)
    assert r.status_code == 307 and r.content == b"", r.text
    r = client.get("/v1/me/export.json/", headers=key)
    assert r.status_code == 403 and r.json()["detail"] == apikeys.OUT_OF_SCOPE, r.text
    assert client.get("/v1/signals/", headers=key).status_code == 200  # то же для открытого
    # закодированный слэш сервер раскрывает до маршрута — эндпоинт тот же, отказ тот же
    r = client.get("/v1/me%2Fexport.json", headers=key)
    assert r.status_code == 403 and r.json()["detail"] == apikeys.OUT_OF_SCOPE, r.text
    r = client.get(f"/v1/signals/{active.public_id}%2Fanalysis", headers=key)
    assert r.status_code == 403 and r.json()["detail"] == apikeys.OUT_OF_SCOPE, r.text
    # похожий префикс и регистр — другого эндпоинта нет, данных нет
    for path in ("/v1/signalsX", "/v1/statsfoo", "/v1/journalx", "/V1/ME/EXPORT.JSON"):
        assert client.get(path, headers=key).status_code == 404, path
    # путь открытого эндпоинта в параметрах не открывает закрытый, и наоборот
    r = client.get("/v1/me/export.json?next=/v1/signals", headers=key)
    assert r.status_code == 403 and r.json()["detail"] == apikeys.OUT_OF_SCOPE, r.text
    assert client.get("/v1/signals?next=/v1/me/export.json", headers=key).status_code == 200
    # не GET — ни данных, ни входа
    for method in ("HEAD", "OPTIONS"):
        for path in ("/v1/signals", "/v1/me/export.json"):
            r = client.request(method, path, headers=key)
            assert r.status_code in (403, 405) and r.content[:1] != b"[", (method, path)


def test_key_user_checks_scope_without_app_gate(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Пользователь по ключу не появляется за пределами списка и в приложении без общей проверки
    (``auth._api_key_user`` вызывает ``apikeys.key_scope`` сам): роутер личных разделов отдельно —
    тот же 403, открытый ключу эндпоинт — 200."""
    from fastapi import FastAPI

    from app.routers import user as user_router

    monkeypatch.setattr(settings, "billing_enabled", True)  # тариф — по подписке, как в ``client``
    monkeypatch.setattr(settings, "redis_url", "")
    mini = FastAPI()
    mini.include_router(user_router.router)
    mini.dependency_overrides[auth.get_db] = lambda: db
    key = _key_header(_key(db, _user(db, "premium")))
    c = TestClient(mini)
    r = c.get("/v1/me/export.json", headers=key)
    assert r.status_code == 403 and r.json()["detail"] == apikeys.OUT_OF_SCOPE, r.text
    r = c.get("/v1/journal", headers=key)
    assert r.status_code == 200, r.text


# из одних пробелов — то же, что пустой: uvicorn обрезает пробелы вокруг значения заголовка
@pytest.mark.parametrize("value", ["", "   "], ids=["empty", "blank"])
def test_empty_key_header_is_401_not_guest(db: Session, client: TestClient, value: str) -> None:
    """Заголовок ``X-API-Key`` есть, но пустой (скрипт не нашёл ключ в окружении и отправил
    ``{"X-API-Key": ""}``), — 401, как неверный ключ. Было: пустой заголовок считался «ключа нет» —
    скрипт тихо получал ответ гостя (лента без активных сигналов, 200), а с токеном вход шёл по
    Bearer в обход правила «ключ важнее токена»."""
    inst, _, _ = _world(db)
    empty = _key_header(value)
    for path in (f"/v1/signals?symbol={inst.symbol}", "/v1/instruments"):
        r = client.get(path, headers=empty)
        assert r.status_code == 401, (path, r.text)
        assert r.json()["detail"] == "неверный или отозванный API-ключ"
    # закрытый эндпоинт: пустой ключ не уступает место токену
    r = client.get("/v1/journal", headers={**empty, **_bearer(_user(db, "premium"))})
    assert r.status_code == 401, r.text
    # запись с пустым ключом — тоже не гость
    body = {"email": "who@example.com", "subject": "вопрос", "message": "текст обращения"}
    assert client.post("/v1/support/tickets", json=body, headers=empty).status_code == 403


def test_blocked_users_key_is_403(db: Session, client: TestClient) -> None:
    """Заблокированный аккаунт не читает API и по ключу — как по токену."""
    inst, _, _ = _world(db)
    raw = _key(db, _user(db, "premium", blocked_at=datetime.now(tz=UTC)))
    for path in (f"/v1/signals?symbol={inst.symbol}", "/v1/stats", "/v1/journal"):
        r = client.get(path, headers=_key_header(raw))
        assert r.status_code == 403 and r.json()["detail"] == "аккаунт заблокирован", path


def test_key_is_read_only_on_optional_endpoint(db: Session, client: TestClient) -> None:
    """POST с ключом на эндпоинте с необязательным входом (обращение в поддержку) — 403, а не
    анонимное обращение. Без ключа форма работает, как раньше."""
    raw = _key(db, _user(db, "premium"))
    body = {"email": "who@example.com", "subject": "вопрос", "message": "текст обращения"}
    r = client.post("/v1/support/tickets", json=body, headers=_key_header(raw))
    assert r.status_code == 403 and r.json()["detail"] == "API-ключ даёт только чтение", r.text
    assert client.post("/v1/support/tickets", json=body).status_code == 201


def test_key_rate_limit_on_optional_and_open_endpoints(
    db: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Лимит на ключ — на всех эндпоинтах; запрос считается один раз, хотя ключ проверяют и
    роутер, и ``optional_user``/``current_user``."""
    monkeypatch.setattr(apikeys, "API_RATE", (4, 60))
    inst, _, _ = _world(db)
    key = _key_header(_key(db, _user(db, "premium")))
    assert client.get(f"/v1/signals?symbol={inst.symbol}", headers=key).status_code == 200
    assert client.get("/v1/stats/export.csv", headers=key).status_code == 200
    # отказ вне списка ключа — до проверки ключа: в лимите не считается
    assert client.get("/v1/me/export.json", headers=key).status_code == 403
    assert client.get("/v1/instruments", headers=key).status_code == 200
    assert client.get("/v1/journal", headers=key).status_code == 200  # ``current_user`` — один раз
    r = client.get(f"/v1/chart/layers?symbol={inst.symbol}&tf=1m", headers=key)
    assert r.status_code == 429, r.text
    assert client.get("/v1/stats", headers=key).status_code == 429
    # другой ключ и запросы без ключа лимит не трогает
    other = _key_header(_key(db, _user(db, "premium")))
    assert client.get("/v1/instruments", headers=other).status_code == 200
    assert client.get("/v1/instruments").status_code == 200


# --- Bearer: удалённый и заблокированный -------------------------------------------------------


def test_bearer_account_state_on_optional_endpoints(db: Session, client: TestClient) -> None:
    """Удалённый (или не найденный) по токену — 401, как у ``current_user``; заблокированный —
    ответ гостя (без данных тарифа и без 403); было — данные тарифа. Без входа — гость, истёкший
    токен — 401 (TSA-1)."""
    inst, active, closed = _world(db)
    feed = f"/v1/signals?symbol={inst.symbol}"
    deleted = _user(db, "premium", deleted_at=datetime.now(tz=UTC))
    blocked = _user(db, "premium", blocked_at=datetime.now(tz=UTC))
    for path in (feed, f"/v1/chart/candles?symbol={inst.symbol}&tf=1m"):
        r = client.get(path, headers=_bearer(deleted))
        assert r.status_code == 401 and r.json()["detail"] == "пользователь не найден", path
    # заблокированный — как гость: лента без активного сигнала, минутные ТФ — 403 тарифа
    assert _ids(client.get(feed, headers=_bearer(blocked))) == {closed.public_id}
    r = client.get(f"/v1/chart/candles?symbol={inst.symbol}&tf=1m", headers=_bearer(blocked))
    assert r.status_code == 403 and r.json()["detail"] != "аккаунт заблокирован"
    assert client.get("/v1/journal", headers=_bearer(blocked)).status_code == 403
    missing = User(id=2_000_000_000, email="gone@example.test", role="user")
    assert client.get(feed, headers=_bearer(missing)).status_code == 401

    # действующий токен — данные тарифа; без входа — гость; истёкший — 401
    assert _ids(client.get(feed, headers=_bearer(_user(db, "premium")))) == {
        active.public_id,
        closed.public_id,
    }
    assert _ids(client.get(feed)) == {closed.public_id}
    exp = int((datetime.now(tz=UTC) - timedelta(minutes=1)).timestamp())
    expired = jwt.encode(
        {"sub": str(_user(db, "premium").id), "role": "user", "iat": exp - 900, "exp": exp},
        settings.jwt_secret,
        algorithm="HS256",
    )
    assert client.get(feed, headers={"authorization": f"Bearer {expired}"}).status_code == 401
