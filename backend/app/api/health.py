"""Health check and system cache management endpoints."""

from __future__ import annotations

import os
import shutil

from fastapi import APIRouter, Request

from app.core.config import settings
from app.core.redis_store import get_store

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
def health_check(request: Request) -> dict:
    """Report backend, Redis/memory store, audio binaries, and LLM config status."""
    store = get_store()
    store_status = store.ping()
    hdr_gemini = request.headers.get("X-Gemini-Api-Key", "").strip()
    hdr_openai = request.headers.get("X-OpenAI-Api-Key", "").strip()
    hdr_provider = request.headers.get("X-LLM-Provider", "").strip()
    return {
        "status": "ok",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "redis": store_status,
        "engines": {
            "ffmpeg_available": shutil.which("ffmpeg") is not None,
            "fluidsynth_available": shutil.which("fluidsynth") is not None,
            "soundfont_available": os.path.exists(settings.SOUNDFONT_PATH),
        },
        "llm_providers": {
            "gemini_configured": bool(settings.GEMINI_API_KEY or hdr_gemini),
            "openai_configured": bool(settings.OPENAI_API_KEY or hdr_openai),
            "default": hdr_provider or settings.DEFAULT_LLM_PROVIDER,
        },
    }


@router.post("/settings/cache/clear")
def clear_temp_cache() -> dict:
    """Clear transient audio and job caches in Redis/memory."""
    store = get_store()
    result = store.clear_cache()
    return {"status": "cleared", **result}
