"""Project persistence, pagination, sync, undo, and export endpoints."""

from __future__ import annotations

import math

from fastapi import APIRouter, File, HTTPException, Query, Response, UploadFile

from app.core.redis_store import get_store
from app.core.schemas import (
    ExportAudioRequest,
    PaginatedProjectsResponse,
    ProjectState,
    ProjectSummary,
)
from app.services.audio.exporter import (
    export_aimusic_bundle,
    export_midi,
    export_mp3,
    export_stems_zip,
    export_wav,
    import_aimusic_bundle,
)
from app.services.audio.renderer import render_project_mix

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _to_summary(p: ProjectState) -> ProjectSummary:
    return ProjectSummary(
        project_id=p.project_id,
        title=p.config.title,
        genre=p.config.genre,
        mood=p.config.mood,
        bpm=p.analysis.bpm,
        key=p.analysis.detected_key,
        scale=p.analysis.detected_scale,
        total_bars=p.song_structure.total_bars,
        version=p.version,
        updated_at=p.updated_at,
        has_audio=bool(p.audio_assets.raw_input_ref or p.audio_assets.dry_denoised_ref),
    )


@router.get("", response_model=PaginatedProjectsResponse)
def list_projects(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=12, ge=1, le=100),
    search: str = Query(default=""),
    genre: str = Query(default=""),
    key: str = Query(default=""),
) -> PaginatedProjectsResponse:
    """List projects from Redis/memory with search, filtering, and pagination."""
    store = get_store()
    items, total = store.list_projects(page=page, limit=limit, search=search, genre=genre, key=key)
    total_pages = max(1, math.ceil(total / limit)) if total > 0 else 1
    return PaginatedProjectsResponse(
        items=[_to_summary(p) for p in items],
        total=total,
        page=min(page, total_pages),
        limit=limit,
        total_pages=total_pages,
    )


@router.get("/{project_id}", response_model=ProjectState)
def get_project(project_id: str) -> ProjectState:
    """Fetch full Shared Project State."""
    store = get_store()
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")
    return project


@router.put("/{project_id}/sync", response_model=ProjectState)
def sync_project(project_id: str, payload: ProjectState) -> ProjectState:
    """Sync ProjectState from Browser IndexedDB into Redis and record undo snapshot."""
    store = get_store()
    existing = store.get_project(project_id)
    if existing is not None:
        store.push_undo(project_id, existing)

    updated = payload.model_copy(
        update={
            "project_id": project_id,
            "version": (existing.version + 1) if existing else max(1, payload.version),
        }
    )
    return store.save_project(updated)


@router.post("/{project_id}/undo", response_model=ProjectState)
def undo_project(project_id: str) -> ProjectState:
    """Restore previous ProjectState snapshot from undo stack."""
    store = get_store()
    restored = store.pop_undo(project_id)
    if restored is None:
        raise HTTPException(status_code=404, detail="No undo history available for this project.")
    return restored


@router.delete("/{project_id}")
def delete_project(project_id: str) -> dict:
    """Delete a project from Redis/memory."""
    store = get_store()
    deleted = store.delete_project(project_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")
    return {"status": "deleted", "project_id": project_id}


@router.post("/{project_id}/export/audio")
def export_project_audio(project_id: str, req: ExportAudioRequest) -> Response:
    """Render and export WAV, MP3, or Stems ZIP with Master Limiter (<= -1.0 dBFS)."""
    store = get_store()
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")

    try:
        mix, stems, sr = render_project_mix(
            project,
            store,
            mode=req.mode,
            apply_mastering=req.apply_mastering,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if req.format == "wav":
        data = export_wav(mix, sample_rate=sr)
        return Response(
            content=data,
            media_type="audio/wav",
            headers={"Content-Disposition": f'attachment; filename="{project_id}.wav"'},
        )
    if req.format == "mp3":
        try:
            data = export_mp3(mix, sample_rate=sr)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return Response(
            content=data,
            media_type="audio/mpeg",
            headers={"Content-Disposition": f'attachment; filename="{project_id}.mp3"'},
        )
    # stems
    data = export_stems_zip(stems, sample_rate=sr)
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{project_id}_stems.zip"'},
    )


@router.post("/{project_id}/export/midi")
def export_project_midi(project_id: str) -> Response:
    """Export multi-track .mid file with Tempo, Time Signature, and Key Signature."""
    store = get_store()
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")

    midi_bytes = export_midi(project)
    return Response(
        content=midi_bytes,
        media_type="audio/midi",
        headers={"Content-Disposition": f'attachment; filename="{project_id}.mid"'},
    )


@router.post("/{project_id}/export/aimusic")
def export_aimusic(project_id: str) -> Response:
    """Package lightweight portable .aimusic ZIP bundle."""
    store = get_store()
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")

    bundle = export_aimusic_bundle(project, store)
    return Response(
        content=bundle,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{project_id}.aimusic"'},
    )


@router.post("/import", response_model=ProjectState)
async def import_aimusic(file: UploadFile = File(...)) -> ProjectState:
    """Import a .aimusic ZIP bundle into Redis and return its ProjectState."""
    raw = await file.read()
    store = get_store()
    try:
        return import_aimusic_bundle(raw, store)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid .aimusic file: {exc}") from exc
