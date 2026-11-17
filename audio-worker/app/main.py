"""FastAPI entrypoint for AI Music Studio Audio DSP Worker (port 8001)."""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import shutil
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile

from app.schemas import (
    AnalyzeWorkerResponse,
    AutotuneSettings,
    AutotuneWorkerResponse,
    DenoiseWorkerResponse,
    ExportRequest,
    OverdubFitCheckResponse,
    RenderRequest,
)
from app.services.analyzer import analyze_audio, inspect_overdub_fit
from app.services.autotune import apply_autotune, apply_preset
from app.services.denoise import (
    AudioValidationError,
    denoise_and_trim,
    normalize_to_wav_bytes,
    validate_and_decode_audio,
)
from app.services.exporter import export_mp3, export_stems_zip, export_wav, peak_dbfs
from app.services.renderer import SOUNDFONT_PATH, render_project_mix

app = FastAPI(
    title="AI Music Studio Audio Worker",
    version="1.0.0",
    description="Slim Python Audio DSP microservice (Denoise, Analyze, Auto-Tune, Render, Master Export, Overdub Fit Check).",
)


def _has_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def _decode_assets_b64(assets_b64: dict[str, str]) -> dict[str, bytes]:
    decoded: dict[str, bytes] = {}
    for ref, b64 in assets_b64.items():
        if not b64:
            continue
        try:
            decoded[ref] = base64.b64decode(b64)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid base64 audio asset for '{ref}': {exc}") from exc
    return decoded


@app.get("/health")
def health() -> dict[str, Any]:
    """Return service health and available DSP engine capabilities."""
    return {
        "status": "ok",
        "service": "audio-worker",
        "engines": {
            "noisereduce": _has_module("noisereduce"),
            "librosa": _has_module("librosa"),
            "pedalboard": _has_module("pedalboard"),
            "pydub": _has_module("pydub"),
            "mido": _has_module("mido"),
            "scipy": _has_module("scipy"),
            "soundfile": _has_module("soundfile"),
            "ffmpeg": shutil.which("ffmpeg") is not None,
            "fluidsynth": shutil.which("fluidsynth") is not None and os.path.exists(SOUNDFONT_PATH),
        },
    }


@app.post("/internal/audio/denoise", response_model=DenoiseWorkerResponse)
async def internal_denoise(
    file: UploadFile = File(...),
    enable_denoise: bool = Form(default=True),
    auto_trim: bool = Form(default=True),
    min_keep_sec: float = Form(default=1.0),
    validate_upload: bool = Form(default=False),
) -> DenoiseWorkerResponse:
    """Decode uploaded audio, optionally validate upload constraints, denoise, and auto-trim."""
    raw_bytes = await file.read()
    filename = file.filename or "audio.wav"
    warnings: list[str] = []

    try:
        if validate_upload:
            wav_bytes, val_meta = validate_and_decode_audio(raw_bytes, filename=filename)
            warnings.extend(val_meta.get("warnings") or [])
        else:
            wav_bytes = normalize_to_wav_bytes(raw_bytes, filename=filename)
    except AudioValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    dry_bytes, meta = denoise_and_trim(
        wav_bytes,
        enable_denoise=enable_denoise,
        auto_trim=auto_trim,
        min_keep_sec=min_keep_sec,
    )
    warnings.extend(meta.get("warnings") or [])

    return DenoiseWorkerResponse(
        wav_base64=base64.b64encode(dry_bytes).decode("ascii"),
        trimmed_start_sec=meta["trimmed_start_sec"],
        trimmed_end_sec=meta["trimmed_end_sec"],
        duration_sec=meta["duration_sec"],
        snr_db_estimate=meta["snr_db_estimate"],
        sample_rate=meta["sample_rate"],
        channels=meta["channels"],
        warnings=warnings,
    )


@app.post("/internal/audio/analyze", response_model=AnalyzeWorkerResponse)
async def internal_analyze(
    file: UploadFile = File(...),
    bpm_override: Optional[float] = Form(default=None),
    key_override: Optional[str] = Form(default=None),
    scale_override: Optional[str] = Form(default=None),
) -> AnalyzeWorkerResponse:
    """Extract BPM, key/scale, bars, duration, and symbolic raw_melody_midi."""
    raw_bytes = await file.read()
    try:
        wav_bytes = normalize_to_wav_bytes(raw_bytes, filename=file.filename or "audio.wav")
    except AudioValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    result = analyze_audio(
        wav_bytes,
        bpm_override=bpm_override,
        key_override=key_override,
        scale_override=scale_override,
    )
    return AnalyzeWorkerResponse(**result)


@app.post("/internal/audio/autotune", response_model=AutotuneWorkerResponse)
async def internal_autotune(
    file: UploadFile = File(...),
    settings_json: Optional[str] = Form(default=None),
    preset: Optional[str] = Form(default=None),
    enabled: Optional[bool] = Form(default=None),
    key: str = Form(default="C"),
    scale: str = Form(default="major"),
    retune_speed_ms: Optional[float] = Form(default=None),
    humanize: Optional[float] = Form(default=None),
    mix_percent: Optional[float] = Form(default=None),
    auto_follow_project_key: bool = Form(default=True),
) -> AutotuneWorkerResponse:
    """Apply scale-aware Auto-Tune DSP preserving duration and t=0 alignment."""
    raw_bytes = await file.read()
    try:
        wav_bytes = normalize_to_wav_bytes(raw_bytes, filename=file.filename or "audio.wav")
    except AudioValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    if settings_json:
        try:
            at_settings = AutotuneSettings.model_validate(json.loads(settings_json))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid settings_json: {exc}") from exc
    elif preset is not None and retune_speed_ms is None and humanize is None and mix_percent is None and enabled is None:
        at_settings = apply_preset(preset, key=key, scale=scale)
        at_settings = at_settings.model_copy(update={"auto_follow_project_key": auto_follow_project_key})
    else:
        payload: dict[str, Any] = {
            "key": key,
            "scale": scale,
            "auto_follow_project_key": auto_follow_project_key,
        }
        if preset is not None:
            payload["preset"] = preset
        if enabled is not None:
            payload["enabled"] = enabled
        if retune_speed_ms is not None:
            payload["retune_speed_ms"] = retune_speed_ms
        if humanize is not None:
            payload["humanize"] = humanize
        if mix_percent is not None:
            payload["mix_percent"] = mix_percent
        try:
            at_settings = AutotuneSettings.model_validate(payload)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid autotune settings: {exc}") from exc

    tuned_bytes, effective, sr = apply_autotune(wav_bytes, at_settings)
    from app.services.denoise import decode_wav_bytes

    tuned_samples, _ = decode_wav_bytes(tuned_bytes)
    duration_sec = round(len(tuned_samples) / sr, 3)

    return AutotuneWorkerResponse(
        wav_base64=base64.b64encode(tuned_bytes).decode("ascii"),
        autotune_settings=effective,
        duration_sec=duration_sec,
        sample_rate=sr,
    )


@app.post("/internal/audio/render")
def internal_render(req: RenderRequest) -> Response:
    """Render full multi-track mix to WAV bytes with optional Master Limiter (<= -1.0 dBFS)."""
    assets = _decode_assets_b64(req.audio_assets_base64)
    try:
        mix, _, sr = render_project_mix(
            req.project,
            audio_assets=assets,
            mode=req.mode,
            apply_mastering=req.apply_mastering,
            sample_rate=req.sample_rate,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    wav_bytes = export_wav(mix, sample_rate=sr)
    peak = round(peak_dbfs(mix), 2)
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "X-Peak-Dbfs": str(peak),
            "X-Sample-Rate": str(sr),
            "X-Render-Mode": req.mode,
        },
    )


@app.post("/internal/audio/export")
def internal_export(req: ExportRequest) -> Response:
    """Export project audio as WAV, MP3, or equal-length Stems ZIP with Master Limiter <= -1.0 dBFS."""
    assets = _decode_assets_b64(req.audio_assets_base64)
    try:
        mix, stems, sr = render_project_mix(
            req.project,
            audio_assets=assets,
            mode=req.mode,
            apply_mastering=req.apply_mastering,
            sample_rate=req.sample_rate,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    pid = req.project.project_id or "project"
    peak = round(peak_dbfs(mix), 2)

    if req.format == "wav":
        data = export_wav(mix, sample_rate=sr)
        return Response(
            content=data,
            media_type="audio/wav",
            headers={
                "Content-Disposition": f'attachment; filename="{pid}.wav"',
                "X-Peak-Dbfs": str(peak),
            },
        )
    if req.format == "mp3":
        try:
            data = export_mp3(mix, sample_rate=sr)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return Response(
            content=data,
            media_type="audio/mpeg",
            headers={
                "Content-Disposition": f'attachment; filename="{pid}.mp3"',
                "X-Peak-Dbfs": str(peak),
            },
        )

    data = export_stems_zip(stems, sample_rate=sr)
    return Response(
        content=data,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{pid}_stems.zip"',
            "X-Peak-Dbfs": str(peak),
        },
    )


@app.post("/internal/audio/overdub-fit-check", response_model=OverdubFitCheckResponse)
async def internal_overdub_fit_check(
    file: UploadFile = File(...),
    bpm: float = Form(default=100.0),
    key: str = Form(default="C"),
    scale: str = Form(default="major"),
) -> OverdubFitCheckResponse:
    """Inspect vocal overdub timing, scale pitch issues, gain levels, and one-click fixes."""
    raw_bytes = await file.read()
    try:
        result = inspect_overdub_fit(
            raw_bytes,
            filename=file.filename or "overdub.wav",
            bpm=bpm,
            key=key,
            scale=scale,
        )
    except AudioValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    return OverdubFitCheckResponse(**result)
