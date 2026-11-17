"""Phase 1 MVP End-to-End & Contract Verification Suite for AI Music Studio (Option B).

Validates Spring Boot backend API contracts, DSP constraints, Multi-Agent SSE job
lifecycle, Master Limiter ceiling (<= -1.0 dBFS), Redis/In-Memory project pagination,
and Frontend <-> Spring Boot <-> Audio Worker contract parity against
docs/API_AND_UI_SPEC.md and docs/SRS.md.

Execution modes:
1. Live server mode: set E2E_BASE_URL=http://localhost:8000 (Spring Boot + audio-worker)
2. Static contract parity test runs standalone without a live server.
"""

from __future__ import annotations

import io
import json
import math
import os
import re
import struct
import sys
import wave
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
BACKEND_CONTROLLERS_DIR = BACKEND_DIR / "src" / "main" / "java" / "com" / "aimusic" / "studio" / "controller"
AUDIO_WORKER_CLIENT_PATH = BACKEND_DIR / "src" / "main" / "java" / "com" / "aimusic" / "studio" / "audio" / "AudioWorkerClient.java"
AUDIO_WORKER_MAIN_PATH = REPO_ROOT / "audio-worker" / "app" / "main.py"
FRONTEND_CLIENT_PATH = REPO_ROOT / "frontend" / "src" / "lib" / "api" / "client.ts"

BASE_URL = os.environ.get("E2E_BASE_URL", "").strip().rstrip("/")


# ---------------------------------------------------------------------------
# Audio Helpers (stdlib only)
# ---------------------------------------------------------------------------


def make_sine_wav(
    duration_sec: float = 4.0,
    sample_rate: int = 44100,
    freq_hz: float = 261.63,
    amplitude: float = 0.6,
) -> bytes:
    """Generate a mono 16-bit PCM WAV buffer with a pure sine wave."""
    num_frames = int(duration_sec * sample_rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(num_frames):
            sample = amplitude * math.sin(2.0 * math.pi * freq_hz * i / sample_rate)
            int_val = max(-32768, min(32767, int(round(sample * 32767.0))))
            frames.extend(struct.pack("<h", int_val))
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def measure_wav_peak_dbfs(wav_bytes: bytes) -> float:
    """Parse a RIFF/WAV byte buffer (PCM 16/24/32-bit or IEEE float32) and return peak dBFS."""
    if len(wav_bytes) < 44 or wav_bytes[:4] != b"RIFF" or wav_bytes[8:12] != b"WAVE":
        raise AssertionError("Response payload is not a valid RIFF/WAVE file")

    pos = 12
    audio_format = None
    bits_per_sample = None
    data_bytes = b""

    while pos + 8 <= len(wav_bytes):
        chunk_id = wav_bytes[pos : pos + 4]
        chunk_size = struct.unpack("<I", wav_bytes[pos + 4 : pos + 8])[0]
        chunk_data = wav_bytes[pos + 8 : pos + 8 + chunk_size]
        if chunk_id == b"fmt " and len(chunk_data) >= 16:
            audio_format = struct.unpack("<H", chunk_data[0:2])[0]
            bits_per_sample = struct.unpack("<H", chunk_data[14:16])[0]
        elif chunk_id == b"data":
            data_bytes = chunk_data
            break
        pos += 8 + chunk_size + (chunk_size % 2)

    if not data_bytes or audio_format is None or bits_per_sample is None:
        raise AssertionError("WAV missing fmt or data chunk")

    max_abs = 0.0
    if audio_format == 1:  # PCM
        if bits_per_sample == 16:
            count = len(data_bytes) // 2
            samples = struct.unpack(f"<{count}h", data_bytes[: count * 2])
            if samples:
                max_abs = max(abs(s) for s in samples) / 32768.0
        elif bits_per_sample == 24:
            for idx in range(0, len(data_bytes) - 2, 3):
                raw = data_bytes[idx : idx + 3]
                val = int.from_bytes(raw, byteorder="little", signed=True)
                norm = abs(val) / 8388608.0
                if norm > max_abs:
                    max_abs = norm
        elif bits_per_sample == 32:
            count = len(data_bytes) // 4
            samples = struct.unpack(f"<{count}i", data_bytes[: count * 4])
            if samples:
                max_abs = max(abs(s) for s in samples) / 2147483648.0
        else:
            raise AssertionError(f"Unsupported PCM bit depth: {bits_per_sample}")
    elif audio_format == 3 and bits_per_sample == 32:  # IEEE float32
        count = len(data_bytes) // 4
        samples = struct.unpack(f"<{count}f", data_bytes[: count * 4])
        if samples:
            max_abs = max(abs(s) for s in samples)
    else:
        raise AssertionError(
            f"Unsupported WAV format={audio_format}, bits={bits_per_sample}"
        )

    if max_abs <= 0.0:
        return -120.0
    return 20.0 * math.log10(max_abs)


def parse_sse_events(raw_text: str) -> list[dict[str, Any]]:
    """Parse SSE text stream into a list of {event, data} dicts."""
    events: list[dict[str, Any]] = []
    current_event = "message"
    data_lines: list[str] = []

    for line in raw_text.splitlines():
        if line == "":
            if data_lines:
                raw_data = "\n".join(data_lines)
                try:
                    parsed: Any = json.loads(raw_data)
                except json.JSONDecodeError:
                    parsed = raw_data
                events.append({"event": current_event, "data": parsed})
                current_event = "message"
                data_lines = []
        elif line.startswith("event:"):
            current_event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:") :].strip())

    if data_lines:
        raw_data = "\n".join(data_lines)
        try:
            parsed = json.loads(raw_data)
        except json.JSONDecodeError:
            parsed = raw_data
        events.append({"event": current_event, "data": parsed})

    return events


# ---------------------------------------------------------------------------
# Client Fixture (HTTP Live or FastAPI TestClient)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def api_client():
    """Return an httpx client for the live Spring Boot backend (when E2E_BASE_URL is set)."""
    if not BASE_URL:
        pytest.skip(
            "E2E_BASE_URL is unset; Spring Boot API/MockMvc tests run via 'mvn test' in backend/ "
            "and audio-worker DSP tests run via 'pytest tests/test_worker.py' in audio-worker/."
        )

    import httpx

    with httpx.Client(base_url=BASE_URL, timeout=90.0) as client:
        yield client


def _upload_sample_wav(
    api_client,
    filename: str = "hum_sample.wav",
    duration_sec: float = 4.0,
) -> dict[str, Any]:
    wav_bytes = make_sine_wav(duration_sec=duration_sec, freq_hz=261.63)
    resp = api_client.post(
        "/api/audio/upload",
        files={"file": (filename, wav_bytes, "audio/wav")},
    )
    assert resp.status_code in (200, 201), f"Upload failed: {resp.status_code} {resp.text}"
    return resp.json()


# ---------------------------------------------------------------------------
# 1. Health & Infrastructure
# ---------------------------------------------------------------------------


def test_health_endpoint(api_client):
    resp = api_client.get("/api/health")
    assert resp.status_code == 200, f"Unexpected health status: {resp.status_code} {resp.text}"
    body = resp.json()
    assert isinstance(body, dict)
    assert body.get("status") in ("ok", "healthy", "degraded")


# ---------------------------------------------------------------------------
# 2. Audio Upload Validation (FR-INP-02)
# ---------------------------------------------------------------------------


def test_upload_rejects_unsupported_extension(api_client):
    resp = api_client.post(
        "/api/audio/upload",
        files={"file": ("not_audio.txt", b"hello world", "text/plain")},
    )
    assert resp.status_code in (400, 415, 422), (
        f"Expected 400/415/422 for invalid file extension, got {resp.status_code}: {resp.text}"
    )


def test_upload_rejects_short_audio_under_3s(api_client):
    short_wav = make_sine_wav(duration_sec=1.2)
    resp = api_client.post(
        "/api/audio/upload",
        files={"file": ("too_short.wav", short_wav, "audio/wav")},
    )
    assert resp.status_code in (400, 422), (
        f"Expected 400/422 for audio < 3s, got {resp.status_code}: {resp.text}"
    )


def test_upload_rejects_oversized_file_over_50mb(api_client):
    oversized = b"RIFF" + (b"\x00" * (51 * 1024 * 1024))
    resp = api_client.post(
        "/api/audio/upload",
        files={"file": ("huge.wav", oversized, "audio/wav")},
    )
    assert resp.status_code in (400, 413, 422), (
        f"Expected 400/413/422 for >50MB file, got {resp.status_code}: {resp.text}"
    )


# ---------------------------------------------------------------------------
# 3. Denoise, Analyze & Auto-Tune Presets (FR-INP-03, FR-ANA, FR-AUTOTUNE)
# ---------------------------------------------------------------------------


def test_audio_pipeline_denoise_analyze_autotune_presets(api_client):
    up = _upload_sample_wav(api_client, duration_sec=4.0)
    project_id = up["project_id"]
    raw_ref = up.get("raw_input_ref")
    assert project_id
    assert raw_ref

    # Denoise
    denoise_resp = api_client.post(
        "/api/audio/denoise",
        json={"project_id": project_id, "enable_denoise": True, "auto_trim": True},
    )
    assert denoise_resp.status_code == 200, denoise_resp.text
    denoise_data = denoise_resp.json()
    dry_denoised_ref = denoise_data.get("dry_denoised_ref")
    assert dry_denoised_ref, f"Missing dry_denoised_ref in {denoise_data}"

    # Analyze
    analyze_resp = api_client.post(
        "/api/audio/analyze",
        json={"project_id": project_id, "source_ref": dry_denoised_ref},
    )
    assert analyze_resp.status_code == 200, analyze_resp.text
    analysis = analyze_resp.json()
    bpm = analysis.get("bpm")
    assert isinstance(bpm, (int, float)) and 40 <= bpm <= 220, f"Invalid BPM: {analysis}"
    key_val = analysis.get("key") or analysis.get("detected_key")
    scale_val = analysis.get("scale") or analysis.get("detected_scale")
    assert key_val, f"Missing key/detected_key in {analysis}"
    assert scale_val, f"Missing scale/detected_scale in {analysis}"
    assert isinstance(analysis.get("raw_melody_midi"), list), (
        f"raw_melody_midi must be a list: {analysis}"
    )

    # Auto-Tune quick presets: off, natural, balanced, modern
    for preset in ("off", "natural", "balanced", "modern"):
        at_resp = api_client.post(
            "/api/audio/autotune",
            json={
                "project_id": project_id,
                "autotune_settings": {
                    "enabled": preset != "off",
                    "preset": preset,
                    "key": key_val,
                    "scale": scale_val,
                    "retune_speed_ms": 10 if preset == "modern" else 35,
                    "humanize": 0.2 if preset == "modern" else 0.6,
                    "mix_percent": 100,
                    "auto_follow_project_key": True,
                },
            },
        )
        assert at_resp.status_code == 200, f"Preset {preset} failed: {at_resp.text}"
        at_data = at_resp.json()
        assert at_data.get("tuned_vocal_ref"), f"Missing tuned_vocal_ref for {preset}: {at_data}"


# ---------------------------------------------------------------------------
# 4. Multi-Agent Job Generation, SSE Events & Cancellation
# ---------------------------------------------------------------------------


def test_job_generate_and_sse_events(api_client):
    up = _upload_sample_wav(api_client, duration_sec=4.0)
    project_id = up["project_id"]

    api_client.post(
        "/api/audio/denoise",
        json={"project_id": project_id, "enable_denoise": True, "auto_trim": False},
    )
    api_client.post(
        "/api/audio/analyze",
        json={"project_id": project_id, "source_ref": up["raw_input_ref"]},
    )

    gen_resp = api_client.post(
        "/api/jobs/generate",
        json={
            "project_id": project_id,
            "config": {
                "melody_mode": "preserve",
                "output_mode": "accompaniment",
                "motif_position": "chorus",
                "genre": "Pop",
                "mood": "Warm",
                "user_prompt": "Simple piano and light drums",
            },
        },
    )
    assert gen_resp.status_code in (200, 201, 202), gen_resp.text
    job_id = gen_resp.json().get("job_id")
    assert job_id, f"Missing job_id in {gen_resp.json()}"

    sse_resp = api_client.get(f"/api/jobs/{job_id}/events")
    assert sse_resp.status_code == 200, sse_resp.text
    content_type = sse_resp.headers.get("content-type", "")
    assert "text/event-stream" in content_type, f"Expected SSE stream, got {content_type}"

    events = parse_sse_events(sse_resp.text)
    assert len(events) >= 1, "SSE stream yielded zero events"
    event_names = {ev["event"] for ev in events}
    allowed_names = {
        "agent_step",
        "qa_retry",
        "progress",
        "completed",
        "fallback_warning",
        "error",
        "message",
    }
    assert event_names.issubset(allowed_names) or "completed" in event_names, (
        f"Unexpected SSE events: {event_names}"
    )
    assert "completed" in event_names or "fallback_warning" in event_names, (
        f"Job did not emit completion event: {events}"
    )


def test_job_cancel_endpoint(api_client):
    up = _upload_sample_wav(api_client, duration_sec=4.0)
    project_id = up["project_id"]

    gen_resp = api_client.post(
        "/api/jobs/generate",
        json={
            "project_id": project_id,
            "config": {
                "melody_mode": "preserve",
                "output_mode": "accompaniment",
                "motif_position": "chorus",
                "genre": "Lo-fi",
                "mood": "Chill",
                "user_prompt": "Chill beat",
            },
        },
    )
    assert gen_resp.status_code in (200, 201, 202), gen_resp.text
    job_id = gen_resp.json()["job_id"]

    cancel_resp = api_client.post(f"/api/jobs/{job_id}/cancel")
    assert cancel_resp.status_code == 200, cancel_resp.text
    cancel_data = cancel_resp.json()
    assert cancel_data.get("status") == "cancelled", f"Unexpected cancel payload: {cancel_data}"


# ---------------------------------------------------------------------------
# 5. Master Limiter (<= -1.0 dBFS) & Audio Export (FR-STU-12, FR-STU-03)
# ---------------------------------------------------------------------------


def test_export_wav_respects_master_limiter_minus_1_dbfs(api_client):
    # Create high-amplitude vocal + full job so mixer could clip without limiter
    loud_wav = make_sine_wav(duration_sec=4.0, amplitude=0.99)
    up_resp = api_client.post(
        "/api/audio/upload",
        files={"file": ("loud_hum.wav", loud_wav, "audio/wav")},
    )
    assert up_resp.status_code in (200, 201), up_resp.text
    project_id = up_resp.json()["project_id"]

    api_client.post(
        "/api/audio/denoise",
        json={"project_id": project_id, "enable_denoise": True, "auto_trim": False},
    )
    api_client.post(
        "/api/audio/analyze",
        json={"project_id": project_id, "source_ref": up_resp.json()["raw_input_ref"]},
    )

    gen_resp = api_client.post(
        "/api/jobs/generate",
        json={
            "project_id": project_id,
            "config": {
                "melody_mode": "preserve",
                "output_mode": "accompaniment",
                "motif_position": "chorus",
                "genre": "Pop",
                "mood": "Energetic",
                "user_prompt": "Boosted pop test",
            },
        },
    )
    assert gen_resp.status_code in (200, 201, 202), gen_resp.text
    job_id = gen_resp.json()["job_id"]
    api_client.get(f"/api/jobs/{job_id}/events")

    export_wav_resp = api_client.post(
        f"/api/projects/{project_id}/export/audio",
        json={"format": "wav", "apply_mastering": True},
    )
    assert export_wav_resp.status_code == 200, (
        f"WAV export failed: {export_wav_resp.status_code} {export_wav_resp.text}"
    )
    peak_dbfs = measure_wav_peak_dbfs(export_wav_resp.content)
    assert peak_dbfs <= -1.0 + 1e-4, (
        f"Master Limiter violation: peak={peak_dbfs:.3f} dBFS exceeds -1.0 dBFS"
    )

    export_mp3_resp = api_client.post(
        f"/api/projects/{project_id}/export/audio",
        json={"format": "mp3", "apply_mastering": True},
    )
    assert export_mp3_resp.status_code == 200, (
        f"MP3 export failed: {export_mp3_resp.status_code} {export_mp3_resp.text}"
    )
    assert len(export_mp3_resp.content) > 256, "Exported MP3 payload is unexpectedly tiny"


# ---------------------------------------------------------------------------
# 6. Project Sync & Pagination (GET /api/projects, PUT /api/projects/{id}/sync)
# ---------------------------------------------------------------------------


def test_projects_sync_and_pagination(api_client):
    # Sync 14 lightweight projects to exercise 12/24/48 page sizes and filtering
    for idx in range(14):
        pid = f"e2e_pag_proj_{idx:02d}"
        genre = "Lo-fi" if idx % 2 == 0 else "Pop Ballad"
        payload = {
            "project_id": pid,
            "version": 1,
            "name": f"E2E Song {idx:02d}",
            "config": {
                "melody_mode": "preserve",
                "output_mode": "accompaniment",
                "motif_position": "chorus",
                "genre": genre,
                "mood": "Calm",
                "user_prompt": f"Pagination test {idx}",
            },
            "analysis": {"bpm": 90 + idx, "time_signature": "4/4", "detected_key": "C", "detected_scale": "major", "raw_melody_midi": []},
        }
        sync_resp = api_client.put(f"/api/projects/{pid}/sync", json=payload)
        assert sync_resp.status_code in (200, 201), (
            f"Sync failed for {pid}: {sync_resp.status_code} {sync_resp.text}"
        )

    # Page 1 with limit=12
    p1 = api_client.get("/api/projects", params={"page": 1, "limit": 12, "search": "e2e_pag_proj", "genre": ""})
    assert p1.status_code == 200, p1.text
    d1 = p1.json()
    for field in ("items", "total", "page", "total_pages"):
        assert field in d1, f"Pagination response missing '{field}': {d1}"
    assert d1["page"] == 1
    assert len(d1["items"]) <= 12
    assert d1["total"] >= 14
    assert d1["total_pages"] >= 2

    # Page 2 with limit=12
    p2 = api_client.get("/api/projects", params={"page": 2, "limit": 12, "search": "e2e_pag_proj", "genre": ""})
    assert p2.status_code == 200, p2.text
    d2 = p2.json()
    assert d2["page"] == 2
    assert len(d2["items"]) >= 2

    # Genre filter + limit=24
    pg = api_client.get("/api/projects", params={"page": 1, "limit": 24, "search": "e2e_pag_proj", "genre": "Lo-fi"})
    assert pg.status_code == 200, pg.text
    dg = pg.json()
    assert dg["total"] >= 7
    assert len(dg["items"]) <= 24


# ---------------------------------------------------------------------------
# 7. Frontend <-> Backend API Schema Parity (docs/API_AND_UI_SPEC.md)
# ---------------------------------------------------------------------------


def test_frontend_backend_api_contract_parity():
    """Verify required Phase 1 API routes exist across frontend client, Spring Boot controllers, and audio-worker."""
    if not BACKEND_CONTROLLERS_DIR.exists() or not FRONTEND_CLIENT_PATH.exists():
        pytest.skip("Spring Boot controllers dir or frontend client.ts not present yet")

    backend_source = "\n".join(
        p.read_text(encoding="utf-8") for p in sorted(BACKEND_CONTROLLERS_DIR.glob("*.java"))
    )
    frontend_source = FRONTEND_CLIENT_PATH.read_text(encoding="utf-8")

    # Normalize {jobId} / ${jobId} / {id} path params for parity comparison
    required_endpoints = [
        "/api/health",
        "/api/audio/upload",
        "/api/audio/denoise",
        "/api/audio/analyze",
        "/api/audio/autotune",
        "/api/audio/asset",
        "/api/audio/preview",
        "/api/jobs/generate",
        "/api/jobs/regenerate-track",
        "/api/jobs/rearrange",
        "/api/jobs/{id}/events",
        "/api/jobs/{id}/cancel",
        "/api/studio/overdub-fit-check",
        "/api/lyrics/suggest",
        "/api/coach/chat",
        "/api/projects",
        "/api/projects/{id}",
        "/api/projects/{id}/sync",
        "/api/projects/{id}/export/aimusic",
        "/api/projects/import",
        "/api/projects/{id}/export/audio",
        "/api/projects/{id}/export/midi",
    ]

    def normalize_paths(text: str) -> str:
        text = re.sub(r"\$\{[a-zA-Z0-9_.()]+\}", "{id}", text)
        text = re.sub(r"\{[a-zA-Z0-9_]+\}", "{id}", text)
        return text

    norm_backend = normalize_paths(backend_source)
    norm_frontend = normalize_paths(frontend_source)

    missing_frontend: list[str] = []
    missing_backend: list[str] = []

    for ep in required_endpoints:
        if ep not in norm_frontend:
            missing_frontend.append(ep)
        prefix, _, tail = ep.rpartition("/")
        has_full = ep in norm_backend
        has_split = (prefix in norm_backend) and (f"/{tail}" in norm_backend or ep.endswith("/projects"))
        if ep == "/api/jobs/{id}/events":
            has_split = "/api/jobs" in norm_backend and "/{id}/events" in norm_backend
        elif ep == "/api/jobs/{id}/cancel":
            has_split = "/api/jobs" in norm_backend and "/{id}/cancel" in norm_backend
        elif ep == "/api/projects/{id}":
            has_split = "/api/projects" in norm_backend and "/{id}" in norm_backend
        elif ep == "/api/projects/{id}/sync":
            has_split = "/api/projects" in norm_backend and "/{id}/sync" in norm_backend
        elif ep == "/api/projects/{id}/export/aimusic":
            has_split = "/api/projects" in norm_backend and "/{id}/export/aimusic" in norm_backend
        elif ep == "/api/projects/{id}/export/audio":
            has_split = "/api/projects" in norm_backend and "/{id}/export/audio" in norm_backend
        elif ep == "/api/projects/{id}/export/midi":
            has_split = "/api/projects" in norm_backend and "/{id}/export/midi" in norm_backend

        if not (has_full or has_split):
            missing_backend.append(ep)

    assert not missing_frontend, (
        f"Endpoints missing from frontend/src/lib/api/client.ts: {missing_frontend}"
    )
    assert not missing_backend, (
        f"Endpoints missing from Spring Boot controllers: {missing_backend}"
    )

    assert "/api/audio/asset" in frontend_source, (
        "frontend/src/lib/api/client.ts resolveAudioUrl must target /api/audio/asset"
    )
    assert "/api/audio/stream" not in frontend_source, (
        "frontend/src/lib/api/client.ts still references non-existent /api/audio/stream"
    )

    if AUDIO_WORKER_CLIENT_PATH.exists() and AUDIO_WORKER_MAIN_PATH.exists():
        aw_client = AUDIO_WORKER_CLIENT_PATH.read_text(encoding="utf-8")
        aw_main = AUDIO_WORKER_MAIN_PATH.read_text(encoding="utf-8")
        internal_routes = [
            "/health",
            "/internal/audio/denoise",
            "/internal/audio/analyze",
            "/internal/audio/autotune",
            "/internal/audio/export",
            "/internal/audio/overdub-fit-check",
        ]
        for route in internal_routes:
            assert route in aw_client, f"Missing worker call {route} in AudioWorkerClient.java"
            assert route in aw_main, f"Missing worker endpoint {route} in audio-worker/app/main.py"
