from functools import lru_cache
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    genesis_host: str = "127.0.0.1"
    genesis_port: int = 8000
    genesis_db_path: str = "./data/genesis.db"
    genesis_cors_origins: str = (
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173"
    )
    genesis_inference_url: str = "http://127.0.0.1:8080"
    genesis_max_upload_mb: int = 5
    genesis_allowed_extensions: str = ".txt,.md,.json,.csv,.py,.ts,.tsx,.js,.yaml,.yml,.log,.wav,.mp3,.ogg"
    genesis_core_checkpoint_path: str = "./data/checkpoints/genesis_core/latest.pt"
    genesis_core_tokenizer_path: str = "./data/checkpoints/genesis_core/tokenizer.json"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.genesis_cors_origins.split(",") if o.strip()]

    @property
    def allowed_extension_list(self) -> list[str]:
        return [e.strip().lower() for e in self.genesis_allowed_extensions.split(",") if e.strip()]

    @property
    def resolved_db_path(self) -> Path:
        raw = Path(self.genesis_db_path)
        if raw.is_absolute():
            return raw.resolve()
        return (PROJECT_ROOT / raw).resolve()

    @property
    def resolved_genesis_core_checkpoint(self) -> Path:
        raw = Path(self.genesis_core_checkpoint_path)
        if raw.is_absolute():
            return raw.resolve()
        return (PROJECT_ROOT / raw).resolve()

    @property
    def resolved_genesis_core_tokenizer(self) -> Path:
        raw = Path(self.genesis_core_tokenizer_path)
        if raw.is_absolute():
            return raw.resolve()
        return (PROJECT_ROOT / raw).resolve()


@lru_cache
def get_settings() -> Settings:
    return Settings()
