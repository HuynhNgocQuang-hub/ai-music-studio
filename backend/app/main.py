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

    # Gracefully mount Multi-Agent jobs & studio/lyrics/coach routers if present
    for module_name in ("app.api.jobs", "app.api.studio"):
        try:
            mod = __import__(module_name, fromlist=["router"])
            if hasattr(mod, "router"):
                application.include_router(mod.router)
            for attr in ("studio_router", "lyrics_router", "coach_router"):
                extra_r = getattr(mod, attr, None)
                if extra_r is not None:
                    application.include_router(extra_r)
            for extra_r in getattr(mod, "extra_routers", ()):
                application.include_router(extra_r)
        except ImportError:
            pass

    @application.get("/")
    def root() -> dict[str, str]:
        return {"name": settings.APP_NAME, "version": settings.APP_VERSION, "status": "ok"}

    return application


app = create_app()
