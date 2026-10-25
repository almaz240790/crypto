from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://platform:platform@localhost:5432/platform"
    redis_url: str = "redis://localhost:6379/0"
    app_env: str = "local"
    debug_token: str | None = None
    """Если задан — включает /debug/* (визуальная проверка движка, план 10.4)."""


settings = Settings()
