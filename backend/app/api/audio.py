"""Audio upload, denoise, analysis, auto-tune, and quick preview endpoints."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, Response, UploadFile

from app.core.config import settings
from app.core.redis_store import get_store
from app.core.schemas import (
    AnalyzeRequest,
    AnalyzeResponse,
    AudioClip,
    AudioUploadResponse,
    AutotuneRequest,
    AutotuneResponse,
    AutotuneSettings,
    DenoiseRequest,
    DenoiseResponse,
    create_default_project,
)
from app.services.audio.analyzer import analyze_audio
from app.services.audio.autotune import apply_autotune, apply_preset, resolve_autotune_settings
from app.services.audio.denoise import (
    AudioValidationError,
    denoise_and_trim,
    validate_and_decode_audio,
)
from app.services.audio.exporter import export_wav
from app.services.audio.renderer import render_project_mix

router = APIRouter(prefix="/api/audio", tags=["audio"])


@router.post("/upload", response_model=AudioUploadResponse)
async def upload_audio(
    file: UploadFile = File(...),
    project_id: Optional[str] = Form(default=None),
    title: Optional[str] = Form(default=None),
    mode: str = Form(default="hum"),
) -> AudioUploadResponse:
    """Upload and validate audio (WAV/MP3/M4A/OGG/FLAC, <=50MB, >=3s)."""
    raw_bytes = await file.read()
    max_dur = settings.MAX_VOCAL_DURATION_SEC if mode == "vocal" else settings.MAX_HUM_DURATION_SEC

    try:
        wav_bytes, meta = validate_and_decode_audio(
            raw_bytes,
            filename=file.filename or "upload.wav",
            max_bytes=settings.max_upload_bytes,
            min_duration_sec=settings.MIN_DURATION_SEC,
            max_duration_sec=max_dur,
            target_sr=settings.SAMPLE_RATE,
        )
    except AudioValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    store = get_store()
    project = store.get_project(project_id) if project_id else None
    if project is None:
        project = create_default_project(
            project_id=project_id,
            title=title or (file.filename or "Untitled Project").rsplit(".", 1)[0],
        )

    raw_ref = f"mem://raw/{project.project_id}.wav"
    store.save_audio_bytes(raw_ref, wav_bytes)
    project.audio_assets.raw_input_ref = raw_ref
    project.analysis.duration_sec = float(meta["duration_sec"])

    vocal_track = project.tracks.get("vocal")
    if vocal_track is not None and not vocal_track.clips:
        vocal_track.clips.append(
            AudioClip(
                id="clip_vocal_1",
                source="raw_input_ref",
                start_bar=1.0,
                trim_start_sec=0.0,
            )
        )

    store.save_project(project)

    return AudioUploadResponse(
        project_id=project.project_id,
        raw_input_ref=raw_ref,
        filename=meta["filename"],
        duration_sec=meta["duration_sec"],
        sample_rate=meta["sample_rate"],
        channels=meta["channels"],
        size_bytes=meta["size_bytes"],
        format=meta["format"],
        warnings=meta["warnings"],
    )


@router.post("/denoise", response_model=DenoiseResponse)
def denoise_audio(req: DenoiseRequest) -> DenoiseResponse:
    """Run AI Denoise & Auto-Trim while preserving raw_input_ref for Dry Check."""
    store = get_store()
    project = store.get_project(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{req.project_id}' not found.")

    raw_ref = project.audio_assets.raw_input_ref
    if not raw_ref:
        raise HTTPException(status_code=400, detail="Project has no uploaded raw audio.")

    raw_bytes = store.get_audio_bytes(raw_ref)
    if raw_bytes is None:
        raise HTTPException(status_code=404, detail="Raw audio asset expired or missing.")

    dry_bytes, meta = denoise_and_trim(
        raw_bytes,
        enable_denoise=req.enable_denoise,
        auto_trim=req.auto_trim,
    )
    dry_ref = f"mem://processed/{project.project_id}_dry.wav"
    store.save_audio_bytes(dry_ref, dry_bytes)

    project.audio_assets.dry_denoised_ref = dry_ref
    project.analysis.duration_sec = float(meta["duration_sec"])
    vocal_track = project.tracks.get("vocal")
    if vocal_track and vocal_track.clips:
        vocal_track.clips[0].source = "dry_denoised_ref"
    store.save_project(project)

    return DenoiseResponse(
        project_id=project.project_id,
        raw_input_ref=raw_ref,
        dry_denoised_ref=dry_ref,
        trimmed_start_sec=meta["trimmed_start_sec"],
        trimmed_end_sec=meta["trimmed_end_sec"],
        duration_sec=meta["duration_sec"],
        snr_db_estimate=meta["snr_db_estimate"],
        warnings=meta["warnings"],
    )


@router.post("/analyze", response_model=AnalyzeResponse)
def analyze_project_audio(req: AnalyzeRequest) -> AnalyzeResponse:
    """Extract BPM, Key/Scale, bars, and symbolic raw_melody_midi."""
    store = get_store()
    project = store.get_project(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{req.project_id}' not found.")

    ref = req.source_ref or project.audio_assets.dry_denoised_ref or project.audio_assets.raw_input_ref
    if not ref:
        raise HTTPException(status_code=400, detail="No audio asset available for analysis.")

    wav_bytes = store.get_audio_bytes(ref)
    if wav_bytes is None:
        raise HTTPException(status_code=404, detail="Audio asset expired or missing.")

    bpm_ov = req.bpm_override if req.bpm_override is not None else (
        project.analysis.bpm if project.analysis.bpm_locked else None
    )
    key_ov = req.key_override if req.key_override is not None else (
        project.analysis.detected_key if project.analysis.key_locked else None
    )
    scale_ov = req.scale_override if req.scale_override is not None else (
        project.analysis.detected_scale if project.analysis.key_locked else None
    )

    result = analyze_audio(
        wav_bytes,
        bpm_override=bpm_ov,
        key_override=key_ov,
        scale_override=scale_ov,
    )

    project.analysis.bpm = result["bpm"]
    project.analysis.time_signature = result["time_signature"]
    project.analysis.detected_key = result["detected_key"]
    project.analysis.detected_scale = result["detected_scale"]
    project.analysis.key_confidence = result["key_confidence"]
    project.analysis.low_confidence_warning = result["low_confidence_warning"]
    project.analysis.bars = result["bars"]
    project.analysis.duration_sec = result["duration_sec"]
    project.analysis.raw_melody_midi = result["raw_melody_midi"]
    if req.bpm_override is not None:
        project.analysis.bpm_locked = True
    if req.key_override is not None or req.scale_override is not None:
        project.analysis.key_locked = True

    project.song_structure.total_bars = max(project.song_structure.total_bars, result["bars"])

    if project.autotune_settings.auto_follow_project_key:
        project.autotune_settings.key = result["detected_key"]
        if result["detected_scale"] in ("major", "minor"):
            project.autotune_settings.scale = result["detected_scale"]

    store.save_project(project)

    return AnalyzeResponse(
        project_id=project.project_id,
        bpm=result["bpm"],
        time_signature=result["time_signature"],
        key=result["detected_key"],
        scale=result["detected_scale"],
        key_confidence=result["key_confidence"],
        low_confidence_warning=result["low_confidence_warning"],
        bars=result["bars"],
        duration_sec=result["duration_sec"],
        raw_melody_midi=result["raw_melody_midi"],
    )


@router.post("/autotune", response_model=AutotuneResponse)
def autotune_audio(req: AutotuneRequest) -> AutotuneResponse:
    """Apply Auto-Tune DSP preset or Pro settings non-destructively."""
    store = get_store()
    project = store.get_project(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{req.project_id}' not found.")

    src_ref = project.audio_assets.dry_denoised_ref or project.audio_assets.raw_input_ref
    if not src_ref:
        raise HTTPException(status_code=400, detail="Project has no vocal audio to tune.")

    src_bytes = store.get_audio_bytes(src_ref)
    if src_bytes is None:
        raise HTTPException(status_code=404, detail="Source audio asset expired or missing.")

    raw_settings = req.autotune_settings or (
        apply_preset(req.preset, key=project.analysis.detected_key, scale=project.analysis.detected_scale)
        if req.preset is not None
        else AutotuneSettings()
    )
    effective = resolve_autotune_settings(raw_settings)
    if effective.auto_follow_project_key:
        effective = effective.model_copy(
            update={
                "key": project.analysis.detected_key,
                "scale": project.analysis.detected_scale
                if project.analysis.detected_scale in ("major", "minor")
                else effective.scale,
            }
        )

    tuned_bytes = apply_autotune(src_bytes, effective)
    tuned_ref = f"mem://processed/{project.project_id}_tuned.wav"
    store.save_audio_bytes(tuned_ref, tuned_bytes)

    project.autotune_settings = effective
    project.audio_assets.tuned_vocal_ref = tuned_ref
    vocal_track = project.tracks.get("vocal")
    if vocal_track and vocal_track.clips:
        vocal_track.clips[0].source = "tuned_vocal_ref" if effective.enabled else "dry_denoised_ref"
    store.save_project(project)

    return AutotuneResponse(
        project_id=project.project_id,
        tuned_vocal_ref=tuned_ref,
        autotune_settings=effective,
        duration_sec=project.analysis.duration_sec,
    )


@router.get("/asset")
def get_audio_asset(ref: str = Query(..., description="mem:// reference returned by audio APIs")) -> Response:
    """Serve stored transient WAV audio bytes by mem:// ref."""
    store = get_store()
    data = store.get_audio_bytes(ref)
    if data is None:
        raise HTTPException(status_code=404, detail=f"Audio asset '{ref}' not found.")
    return Response(content=data, media_type="audio/wav")


@router.get("/preview/{project_id}")
def get_quick_preview(
    project_id: str,
    mode: str = Query(default="ai_mix"),
) -> Response:
    """Render quick preview mix with Master Limiter <= -1.0 dBFS."""
    store = get_store()
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")

    try:
        mix, _, sr = render_project_mix(project, store, mode=mode, apply_mastering=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    wav_bytes = export_wav(mix, sample_rate=sr)
    return Response(content=wav_bytes, media_type="audio/wav")
