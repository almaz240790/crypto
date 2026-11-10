import logging
import re
from datetime import UTC, date, datetime

from pydantic import field_validator
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


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://platform:platform@localhost:5432/platform"
    redis_url: str = "redis://localhost:6379/0"
    app_env: str = "local"
    debug_token: str | None = None
    """Если задан — включает /debug/* (визуальная проверка движка, план 10.4)."""
    jwt_secret: str = "dev-secret-change-me"
    frontend_url: str = "http://localhost:3000"
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
    """Email владельцев через запятую: при входе получают роль owner (до админки 2.14)."""
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
    def owner_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.owner_emails.split(",") if e.strip()}


settings = Settings()
