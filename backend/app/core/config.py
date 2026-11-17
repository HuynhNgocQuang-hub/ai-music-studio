"""Application settings loaded from environment variables."""

from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration for AI Music Studio backend."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    APP_NAME: str = "AI Music Studio API"
    APP_VERSION: str = "1.0.0"

    # Redis & TTL
    REDIS_URL: str = "redis://localhost:6379/0"
    PROJECT_TTL_SECONDS: int = 86400
    AUDIO_TTL_SECONDS: int = 43200

    # Audio constraints (SRS FR-INP & FR-STUDIO)
    MAX_UPLOAD_MB: int = 50
    MIN_DURATION_SEC: float = 3.0
    MAX_HUM_DURATION_SEC: float = 60.0
    MAX_VOCAL_DURATION_SEC: float = 300.0
    SAMPLE_RATE: int = 44100
    ALLOWED_AUDIO_EXTENSIONS: tuple[str, ...] = (".wav", ".mp3", ".m4a", ".ogg", ".flac")

    # Rendering & Mastering
    SOUNDFONT_PATH: str = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
    TEMP_STORAGE_DIR: str = "/tmp/ai_music_studio"
    MASTER_LIMITER_CEILING_DB: float = -1.0
    TARGET_LUFS: float = -14.0

    # Dual LLM Cloud APIs
    GEMINI_API_KEY: str = ""
    OPENAI_API_KEY: str = ""
    DEFAULT_LLM_PROVIDER: str = "gemini"
    GEMINI_MODEL: str = "gemini-2.5-flash"
    OPENAI_MODEL: str = "gpt-4o-mini"

    # CORS
    CORS_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000"

    @property
    def max_upload_bytes(self) -> int:
        return self.MAX_UPLOAD_MB * 1024 * 1024

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    """Return cached Settings instance."""
    return Settings()


settings = get_settings()
