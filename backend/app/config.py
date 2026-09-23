from functools import lru_cache
from typing import Literal

from pydantic import AnyHttpUrl, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str
    storage_dir: str
    max_upload_mb: int = Field(default=200, gt=0)
    ai_base_url: AnyHttpUrl
    ai_mode: Literal["mock", "http", "real"]
    ai_internal_token: SecretStr | None = None
    ai_timeout_seconds: float = Field(default=3600, gt=0)
    frontend_origin: AnyHttpUrl

    model_config = SettingsConfigDict(
        env_file=(".env", "backend/.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
