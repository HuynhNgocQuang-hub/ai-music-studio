"""FastAPI application entrypoint."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.audio import router as audio_router
from app.api.health import router as health_router
from app.api.projects import router as projects_router
from app.core.config import settings


def create_app() -> FastAPI:
    """Build FastAPI app with CORS, DSP/Project routers, and optional Agent routers."""
    application = FastAPI(
        title=settings.APP_NAME,
        version=settings.APP_VERSION,
    )

    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    application.include_router(health_router)
    application.include_router(audio_router)
    application.include_router(projects_router)

    # Gracefully mount Multi-Agent jobs router if present
    try:
        from app.api.jobs import router as jobs_router  # type: ignore

        application.include_router(jobs_router)
    except ImportError:
        pass

    @application.get("/")
    def root() -> dict[str, str]:
        return {"name": settings.APP_NAME, "version": settings.APP_VERSION, "status": "ok"}

    return application


app = create_app()
