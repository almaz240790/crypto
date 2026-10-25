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
    owner_emails: str = ""
    """Email владельцев через запятую: при входе получают роль owner (до админки 2.14)."""

    @property
    def owner_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.owner_emails.split(",") if e.strip()}


settings = Settings()
