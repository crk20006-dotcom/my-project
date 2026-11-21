from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import agents, chat, health, memory, models, workspace
from app.core.config import get_settings
from app.db.database import init_database


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_database()
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Project Genesis — Core Platform API",
        description="Provider-independent AI Operating System backend scaffold (Step 01).",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    app.include_router(health.router, prefix="/api")
    app.include_router(chat.router, prefix="/api")
    app.include_router(models.router, prefix="/api")
    app.include_router(memory.router, prefix="/api")
    app.include_router(agents.router, prefix="/api")
    app.include_router(workspace.router, prefix="/api")
    return app


app = create_app()
