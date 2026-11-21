import os
import platform
import sys
from fastapi import APIRouter
from app.core.config import get_settings
from app.db.database import get_connection, utc_now

router = APIRouter(tags=["Health"])


@router.get("/health")
def health_check() -> dict[str, object]:
    settings = get_settings()
    conn = get_connection()
    db_ok = False
    try:
        conn.execute("SELECT 1").fetchone()
        db_ok = True
    finally:
        conn.close()

    return {
        "status": "ok" if db_ok else "degraded",
        "service": "Project Genesis Core Platform",
        "stage": "Step 01 — Core Software Platform",
        "runtime": f"Python {sys.version.split()[0]} / FastAPI",
        "database": {
            "connected": db_ok,
            "engine": "SQLite (sqlite3)",
            "path": str(settings.resolved_db_path),
        },
        "hardware": {
            "platform": f"{platform.system()} {platform.release()}",
            "arch": platform.machine(),
            "cpu_model": platform.processor() or "Host Processor",
            "cpu_cores": os.cpu_count() or 1,
            "total_memory_gb": 0.0,
            "free_memory_gb": 0.0,
        },
        "model_inference": {
            "mode": "demo",
            "active_model": None,
            "external_ai_apis_disabled": True,
        },
        "timestamp": utc_now(),
    }
