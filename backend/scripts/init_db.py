"""Standalone database initialization utility for Project Genesis backend."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import get_settings
from app.db.database import init_database


def main() -> None:
    settings = get_settings()
    init_database()
    print(f"[Project Genesis] Database initialized at: {settings.resolved_db_path}")


if __name__ == "__main__":
    main()
