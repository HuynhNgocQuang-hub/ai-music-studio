"""FastAPI router for Studio Lyrics, AI Music Coach, and Vocal Overdub Fit Check."""

from __future__ import annotations

import io
import math
import struct
import wave
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from app.agents.coach_lyricist_agent import CoachLyricistAgent
from app.agents.composer_agent import PC_TO_NOTE_NAME, get_scale_pitch_classes
from app.agents.llm_adapter import (
    extract_llm_overrides_from_headers,
    get_llm_adapter,
    reset_request_llm_overrides,
    set_request_llm_overrides,
)
from app.api.jobs import _load_project_state

router = APIRouter(tags=["studio-coach"])

_coach_agent = CoachLyricistAgent(get_llm_adapter())


class LyricsSuggestRequest(BaseModel):
    project_id: str = Field(..., min_length=1)
    language: str = "vi"
    topic: str = ""
    section: Optional[str] = None
    project_state: Optional[Dict[str, Any]] = None


class CoachChatRequest(BaseModel):
    project_id: str = Field(..., min_length=1)
    message: str = Field(..., min_length=1)
    history: List[Dict[str, Any]] = Field(default_factory=list)
    project_state: Optional[Dict[str, Any]] = None


def _analyze_wav_fallback(audio_bytes: bytes) -> Dict[str, Any]:
    """Pure-stdlib WAV signal inspector when DSP/numpy analyzer is unavailable."""
    peak_norm = 0.0
    rms_norm = 0.0
    onset_sec = 0.0
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as wf:
            sr = wf.getframerate() or 44100
            n_channels = wf.getnchannels() or 1
            sampwidth = wf.getsampwidth() or 2
            raw = wf.readframes(wf.getnframes())
        if sampwidth == 2 and raw:
            samples = struct.unpack(f"<{len(raw) // 2}h", raw)
            if n_channels > 1:
                samples = samples[::n_channels]
            max_abs = max((abs(s) for s in samples), default=0)
            peak_norm = max_abs / 32768.0
            sum_sq = sum(float(s) * float(s) for s in samples)
            rms_norm = math.sqrt(sum_sq / max(1, len(samples))) / 32768.0
            thresh = max(120.0, max_abs * 0.15)
            for idx, val in enumerate(samples):
                if abs(val) >= thresh:
                    onset_sec = idx / sr
                    break
    except Exception:
        peak_norm = 0.25
        rms_norm = 0.08
        onset_sec = 0.02

    peak_db = 20.0 * math.log10(max(peak_norm, 1e-6))
    rms_db = 20.0 * math.log10(max(rms_norm, 1e-6))
    return {
        "peak_db": round(peak_db, 2),
        "rms_db": round(rms_db, 2),
        "onset_sec": round(onset_sec, 4),
        "notes": [],
    }


def _inspect_overdub_audio(audio_bytes: bytes, filename: str, bpm: float) -> Dict[str, Any]:
    try:
        import numpy as np  # type: ignore
        from app.services.audio.analyzer import analyze_audio  # type: ignore
        from app.services.audio.denoise import decode_wav_bytes, normalize_to_wav_bytes  # type: ignore

        wav_bytes = normalize_to_wav_bytes(audio_bytes, filename or "overdub.wav")
        samples, sr = decode_wav_bytes(wav_bytes)
        peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
        rms = float(np.sqrt(np.mean(samples**2))) if len(samples) else 0.0
        peak_db = round(20.0 * math.log10(max(peak, 1e-6)), 2)
        rms_db = round(20.0 * math.log10(max(rms, 1e-6)), 2)

        # Find first vocal onset above 15% of peak
        onset_sec = 0.0
        if len(samples) and peak > 1e-4:
            above = np.where(np.abs(samples) >= peak * 0.15)[0]
            if len(above):
                onset_sec = float(above[0]) / sr

        analysis = analyze_audio(wav_bytes, bpm_override=bpm)
        raw_notes = analysis.get("raw_melody_midi") or []
        notes = [
            n.model_dump() if hasattr(n, "model_dump") else (n.dict() if hasattr(n, "dict") else dict(n))
            for n in raw_notes
        ]
        return {
            "peak_db": peak_db,
            "rms_db": rms_db,
            "onset_sec": round(onset_sec, 4),
            "notes": notes,
        }
    except Exception:
        return _analyze_wav_fallback(audio_bytes)


@router.post("/api/lyrics/suggest")
async def suggest_lyrics(req: LyricsSuggestRequest, request: Request) -> Dict[str, Any]:
    state = _load_project_state(req.project_id, req.project_state)
    overrides = extract_llm_overrides_from_headers(request.headers)
    token = set_request_llm_overrides(**overrides) if overrides else None
    try:
        return await _coach_agent.suggest_lyrics(
            project_state=state,
            language=req.language,
            topic=req.topic,
            section=req.section,
        )
    finally:
        if token is not None:
            reset_request_llm_overrides(token)


@router.post("/api/coach/chat")
async def chat_with_coach(req: CoachChatRequest, request: Request) -> Dict[str, Any]:
    state = _load_project_state(req.project_id, req.project_state)
    overrides = extract_llm_overrides_from_headers(request.headers)
    token = set_request_llm_overrides(**overrides) if overrides else None
    try:
        return await _coach_agent.chat_coach(
            project_state=state,
            message=req.message,
            history=req.history,
        )
    finally:
        if token is not None:
            reset_request_llm_overrides(token)


@router.post("/api/studio/overdub-fit-check")
async def overdub_fit_check(
    project_id: str = Form(...),
    file: UploadFile = File(...),
) -> Dict[str, Any]:
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty overdub audio file.")

    state = _load_project_state(project_id)
    analysis = dict(state.get("analysis") or {})
    bpm = float(analysis.get("bpm") or 100.0)
    key = str(analysis.get("detected_key") or "C")
    scale = str(analysis.get("detected_scale") or "major")
    scale_pcs = set(get_scale_pitch_classes(key, scale))

    metrics = _inspect_overdub_audio(audio_bytes, file.filename or "overdub.wav", bpm)
    beat_sec = 60.0 / max(40.0, bpm)

    # Estimate timing offset relative to nearest beat grid (in ms)
    onset_sec = float(metrics["onset_sec"])
    nearest_beat_sec = round(onset_sec / beat_sec) * beat_sec
    timing_offset_ms = round((onset_sec - nearest_beat_sec) * 1000.0, 1)

    # Check notes against project scale
    pitch_issues: List[Dict[str, Any]] = []
    for note in metrics["notes"]:
        pitch = int(note.get("pitch", 60))
        pc = pitch % 12
        if pc not in scale_pcs:
            start_beat = float(note.get("start_beat", 0.0))
            bar = int(start_beat // 4.0) + 1
            note_name = f"{PC_TO_NOTE_NAME[pc]}{(pitch // 12) - 1}"
            pitch_issues.append(
                {
                    "bar": bar,
                    "note": note_name,
                    "cents_off": 50.0,
                    "description": f"Note {note_name} at bar {bar} is outside {key} {scale}.",
                }
            )
            if len(pitch_issues) >= 6:
                break

    peak_db = float(metrics["peak_db"])
    rms_db = float(metrics["rms_db"])
    one_click_fixes: List[Dict[str, Any]] = []

    if abs(timing_offset_ms) >= 15.0:
        one_click_fixes.append(
            {
                "id": "fix_shift_timing",
                "label": f"Dịch nhịp {-timing_offset_ms:+.0f} ms cho khớp beat",
                "action_type": "shift_timing",
                "value": round(-timing_offset_ms, 1),
            }
        )

    if pitch_issues:
        one_click_fixes.append(
            {
                "id": "fix_apply_autotune",
                "label": f"Bật Auto-Tune về {key} {scale}",
                "action_type": "apply_autotune",
                "value": "natural",
            }
        )

    if peak_db > -1.0:
        gain_suggestion = f"Vocal hơi lớn (peak {peak_db:.1f} dBFS), nên giảm -3 dB tránh clipping."
        one_click_fixes.append(
            {
                "id": "fix_adjust_gain_down",
                "label": "Giảm Gain vocal -3 dB",
                "action_type": "adjust_gain",
                "value": -3.0,
            }
        )
    elif rms_db < -28.0:
        gain_suggestion = f"Vocal hơi nhỏ (RMS {rms_db:.1f} dBFS), nên tăng +4 dB để nổi trên beat."
        one_click_fixes.append(
            {
                "id": "fix_adjust_gain_up",
                "label": "Tăng Gain vocal +4 dB",
                "action_type": "adjust_gain",
                "value": 4.0,
            }
        )
    else:
        gain_suggestion = f"Mức âm lượng cân bằng tốt (RMS {rms_db:.1f} dBFS, Peak {peak_db:.1f} dBFS)."

    return {
        "timing_offset_ms": timing_offset_ms,
        "pitch_issues": pitch_issues,
        "gain_suggestion": gain_suggestion,
        "one_click_fixes": one_click_fixes,
    }
