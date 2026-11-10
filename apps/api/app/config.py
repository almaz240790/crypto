"""Настройки из окружения и ``.env``. Публичные адреса в production — ``_production_urls``."""

from __future__ import annotations

import logging
import re
from datetime import UTC, date, datetime
from urllib.parse import urlsplit

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger("app.config")

_ON = frozenset({"1", "true", "t", "yes", "y", "on", "да"})
_OFF = frozenset({"0", "false", "f", "no", "n", "off", "нет"})
_ISO_DAY = re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})")
_RU_DAY = re.compile(r"(\d{1,2})\.(\d{1,2})\.(\d{4})")


def _plain(v: str) -> str:
    """Значение из окружения без пробелов и кавычек по краям (их легко занести при вставке)."""
    return v.strip().strip("\"'").strip()


def parse_notice_flag(v: object) -> object:
    """``FORWARD_NOTICE`` из окружения. Опечатка не должна ронять сервис: нераспознанное значение
    оставляет плашку включённой (безопасная сторона: лишнее предупреждение лучше недействительных
    чисел без него) и пишется в журнал. Пустое значение — как незаданное, то есть «включена»."""
    if not isinstance(v, str):
        return v
    s = _plain(v).lower()
    if s in _OFF:
        return False
    if s and s not in _ON:
        log.warning(
            "FORWARD_NOTICE=%r не распознано (ожидается true или false): плашка над "
            "форвард-статистикой остаётся включённой",
            v[:40],
        )
    return True


def parse_notice_date(v: object) -> object:
    """``FORWARD_NOTICE_UNTIL`` из окружения: ГГГГ-ММ-ДД, ДД.ММ.ГГГГ (как на плашке) или метка
    времени ISO (берётся дата в UTC). Пусто — без даты. Опечатка не должна ронять сервис:
    нераспознанное значение даёт плашку без даты (она говорит «результаты недействительны» без
    срока — это не преуменьшает) и пишется в журнал."""
    if isinstance(v, datetime):
        return (v.astimezone(UTC) if v.tzinfo else v).date()
    if not isinstance(v, str):
        return v
    s = _plain(v)
    if not s:
        return None
    try:
        if m := _ISO_DAY.fullmatch(s):
            return date(int(m[1]), int(m[2]), int(m[3]))
        if m := _RU_DAY.fullmatch(s):
            return date(int(m[3]), int(m[2]), int(m[1]))
        return parse_notice_date(datetime.fromisoformat(s))
    except ValueError:
        log.warning(
            "FORWARD_NOTICE_UNTIL=%r не распознано (ожидается ГГГГ-ММ-ДД или ДД.ММ.ГГГГ): "
            "плашка над форвард-статистикой выводится без даты",
            v[:40],
        )
        return None


PRODUCTION_FRONTEND_URL = "https://platformsol.com"
"""Адрес сайта: подставляется в production, когда FRONTEND_URL не задан (или пуст). На Railway у
сервисов alerts и digest переменной FRONTEND_URL нет — письма уходили со ссылками на
http://localhost:3000. Для API_PUBLIC_URL адрес не придумывается: он нужен только API (вебхуки
оплаты), а там переменная задана."""
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "0.0.0.0", "::1"})


def is_local_url(url: str) -> bool:
    """Ведёт ли адрес на localhost (или вовсе не разбирается как URL)."""
    try:
        host = urlsplit(url.strip()).hostname
    except ValueError:
        return True
    return not host or host in LOCAL_HOSTS


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://platform:platform@localhost:5432/platform"
    redis_url: str = "redis://localhost:6379/0"
    app_env: str = "local"
    """local / staging / production. Не задан — смотрим на окружение Railway (``is_production``)."""
    railway_environment_name: str | None = None
    """Имя окружения Railway: переменную RAILWAY_ENVIRONMENT_NAME Railway задаёт каждому сервису
    сама. Нужна, только если у сервиса не задан APP_ENV."""
    debug_token: str | None = None
    """Если задан — включает /debug/* (визуальная проверка движка, план 10.4)."""
    jwt_secret: str = "dev-secret-change-me"
    frontend_url: str = "http://localhost:3000"
    """Адрес веб-приложения: ссылки в письмах и push, CORS. В production без значения —
    ``PRODUCTION_FRONTEND_URL``."""
    google_client_id: str | None = None
    google_client_secret: str | None = None
    telegram_bot_token: str | None = None
    mail_from: str = "Platform <noreply@platform.local>"
    resend_api_key: str | None = None
    """Если не задан — письма пишутся в лог (local/staging)."""
    vapid_private_key: str | None = None
    vapid_public_key: str | None = None
    """Ключи Web Push (base64url, P-256). Без них push не отправляется."""
    vapid_subject: str = "mailto:support@platform.local"
    owner_emails: str = ""
    """Email владельцев через запятую: при входе получают роль owner (до админки 2.14)."""
    proxy_secret: str | None = None
    """Общий секрет прокси сайта (/v1 в Next, тот же PROXY_SECRET у сервиса web, ADR-0011): с ним
    API берёт IP клиента из подписанного заголовка прокси, а /v1/admin/* открывается только через
    сайт. Без него IP — из первого значения X-Forwarded-For (клиент может его подставить)."""
    sentry_dsn: str | None = None
    api_public_url: str = "http://localhost:8000"
    """Публичный адрес API — для вебхуков провайдера оплаты."""
    billing_enabled: bool = False
    """Пока False — все пользователи на уровне Pro (лендинг), оформление оплаты закрыто."""
    nowpayments_api_key: str | None = None
    nowpayments_ipn_secret: str | None = None
    nowpayments_sandbox: bool = False
    # LLM-шлюз (план 2A.10.3): выключен, пока владелец не утвердит промпт и не задаст ключ
    llm_enabled: bool = False
    anthropic_api_key: str | None = None
    llm_model_explain: str = "claude-haiku-5-5"
    llm_model_question: str = "claude-sonnet-5-5"
    llm_daily_budget_usd: float = 15.0
    llm_prompts_dir: str | None = None
    forward_notice: bool = True
    """Плашка над форвард-статистикой на /stats: старые результаты форварда недействительны
    (трекер закрывал сделки через 15 минут вместо 60 часов). Снимает человек после пересчёта или
    пометки старых результатов (задание «сигналы», задачи 2 и 10). Значения: true/false (также
    1/0, yes/no, on/off); нераспознанное — плашка включена, в журнале предупреждение."""
    forward_notice_until: date | None = None
    """До какой даты результаты форварда недействительны: ГГГГ-ММ-ДД или ДД.ММ.ГГГГ. Пусто —
    плашка без даты; нераспознанное значение — тоже без даты, в журнале предупреждение."""

    # Обе настройки человек правит руками на Railway (дата после задачи 1, выключение после
    # задачи 10): опечатка в них не должна останавливать ни API, ни воркеры.
    _notice_flag = field_validator("forward_notice", mode="before")(parse_notice_flag)
    _notice_date = field_validator("forward_notice_until", mode="before")(parse_notice_date)

    @property
    def is_production(self) -> bool:
        """``APP_ENV=production``; если APP_ENV не задан вовсе — окружение Railway ``production``
        (сервисы на Railway заводились копированием переменных, и APP_ENV мог не попасть)."""
        if "app_env" in self.model_fields_set:
            return self.app_env.strip().lower() == "production"
        return (self.railway_environment_name or "").strip().lower() == "production"

    @property
    def owner_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.owner_emails.split(",") if e.strip()}

    @model_validator(mode="after")
    def _production_urls(self) -> Settings:
        """В production ссылки в письмах и push не могут молча вести на localhost.

        FRONTEND_URL не задан или пуст — подставляется ``PRODUCTION_FRONTEND_URL`` (с
        предупреждением в лог); задан и ведёт на localhost — остаётся, но с предупреждением.
        API_PUBLIC_URL не подменяется (своего адреса у API в репозитории нет): если оплата
        включена, а адрес локальный — предупреждение. Один раз на процесс: ``settings``
        создаётся при импорте модуля.
        """
        if not self.is_production:
            return self
        if "frontend_url" not in self.model_fields_set or not self.frontend_url.strip():
            self.frontend_url = PRODUCTION_FRONTEND_URL
            log.warning(
                "FRONTEND_URL не задан: в production ссылки ведут на %s", PRODUCTION_FRONTEND_URL
            )
        elif is_local_url(self.frontend_url):
            log.warning(
                "FRONTEND_URL=%s в production: ссылки в письмах ведут на localhost",
                self.frontend_url,
            )
        if self.billing_enabled and is_local_url(self.api_public_url):
            log.warning(
                "API_PUBLIC_URL=%s в production при включённой оплате: вебхук провайдера не дойдёт",
                self.api_public_url,
            )
        return self


settings = Settings()
