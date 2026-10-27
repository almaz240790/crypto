from pydantic_settings import BaseSettings, SettingsConfigDict


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

    @property
    def owner_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.owner_emails.split(",") if e.strip()}


settings = Settings()
