"""Phase 2 & 3 End-to-End & Contract Verification Suite for AI Music Studio.

Validates Phase 2 & 3 DAW-lite & Full Song upgrades:
- Full Song `structure_preset` ("standard" with Bridge vs "short" 4-section)
- POST /api/studio/auto-trim-vocal
- POST /api/studio/auto-mix
- POST /api/audio/clip-upload (including `texture` track creation & validation)
- Multi-clip trim/fade/offset WAV & Stems (.zip) export respecting Master Limiter (<= -1.0 dBFS)
- MIDI Piano Roll note update via sync + `.mid` binary export with Meta Events
- Frontend <-> Backend contract parity for Phase 2 & 3 endpoints, DTOs, and UI editors

Execution modes:
1. Live server mode: set E2E_BASE_URL=http://localhost:8000
2. Static contract parity test runs standalone without a live server.
"""

from __future__ import annotations

import io
import json
import math
import os
import re
import struct
import uuid
import wave
import zipfile
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
BACKEND_CONTROLLERS_DIR = BACKEND_DIR / "src" / "main" / "java" / "com" / "aimusic" / "studio" / "controller"
BACKEND_MODEL_DIR = BACKEND_DIR / "src" / "main" / "java" / "com" / "aimusic" / "studio" / "model"
FRONTEND_DIR = REPO_ROOT / "frontend" / "src"
FRONTEND_CLIENT_PATH = FRONTEND_DIR / "lib" / "api" / "client.ts"
FRONTEND_TYPES_PATH = FRONTEND_DIR / "types" / "project.ts"
FRONTEND_TIMELINE_PATH = FRONTEND_DIR / "components" / "studio" / "TimelineEditor.tsx"
FRONTEND_PIANOROLL_PATH = FRONTEND_DIR / "components" / "studio" / "PianoRollEditor.tsx"

BASE_URL = os.environ.get("E2E_BASE_URL", "").strip().rstrip("/")


# ---------------------------------------------------------------------------
# Audio & MIDI Helpers (stdlib only)
# ---------------------------------------------------------------------------


def make_sine_wav(
    duration_sec: float = 4.0,
    sample_rate: int = 44100,
    freq_hz: float = 261.63,
    amplitude: float = 0.6,
    leading_silence_sec: float = 0.0,
    trailing_silence_sec: float = 0.0,
) -> bytes:
    """Generate a mono 16-bit PCM WAV buffer with optional leading/trailing silence."""
    lead_frames = int(leading_silence_sec * sample_rate)
    tone_frames = int(duration_sec * sample_rate)
    trail_frames = int(trailing_silence_sec * sample_rate)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)

        frames = bytearray(lead_frames * 2)
        for i in range(tone_frames):
            sample = amplitude * math.sin(2.0 * math.pi * freq_hz * i / sample_rate)
            int_val = max(-32768, min(32767, int(round(sample * 32767.0))))
            frames.extend(struct.pack("<h", int_val))
        frames.extend(bytearray(trail_frames * 2))
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def measure_wav_peak_dbfs(wav_bytes: bytes) -> float:
    """Parse RIFF/WAVE bytes (PCM 16/24/32-bit or float32) and return peak dBFS."""
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
    if audio_format == 1:
        if bits_per_sample == 16:
            count = len(data_bytes) // 2
            samples = struct.unpack(f"<{count}h", data_bytes[: count * 2])
            if samples:
                max_abs = max(abs(s) for s in samples) / 32768.0
        elif bits_per_sample == 24:
            for idx in range(0, len(data_bytes) - 2, 3):
                val = int.from_bytes(data_bytes[idx : idx + 3], byteorder="little", signed=True)
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
    elif audio_format == 3 and bits_per_sample == 32:
        count = len(data_bytes) // 4
        samples = struct.unpack(f"<{count}f", data_bytes[: count * 4])
        if samples:
            max_abs = max(abs(s) for s in samples)
    else:
        raise AssertionError(f"Unsupported WAV format={audio_format}, bits={bits_per_sample}")

    if max_abs <= 0.0:
        return -120.0
    return 20.0 * math.log10(max_abs)


def get_wav_duration_sec(wav_bytes: bytes) -> float:
    """Return duration in seconds of a WAV buffer."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        frames = wf.getnframes()
        rate = wf.getframerate()
        return frames / float(rate) if rate > 0 else 0.0


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


def parse_midi_notes_and_meta(midi_bytes: bytes) -> dict[str, Any]:
    """Minimal Standard MIDI File (SMF) parser verifying header, meta events, and Note On pitches."""
    if len(midi_bytes) < 14 or midi_bytes[:4] != b"MThd":
        raise AssertionError("Not a valid Standard MIDI File (missing MThd)")
    hdr_len = struct.unpack(">I", midi_bytes[4:8])[0]
    fmt, num_tracks, division = struct.unpack(">HHH", midi_bytes[8:14])
    pos = 8 + hdr_len

    track_count = 0
    has_tempo = False
    has_time_sig = False
    has_key_sig = False
    note_on_pitches: list[int] = []

    while pos + 8 <= len(midi_bytes):
        chunk_id = midi_bytes[pos : pos + 4]
        chunk_len = struct.unpack(">I", midi_bytes[pos + 4 : pos + 8])[0]
        chunk_end = pos + 8 + chunk_len
        if chunk_id == b"MTrk":
            track_count += 1
            if b"\xff\x51\x03" in midi_bytes[pos + 8 : chunk_end]:
                has_tempo = True
            if b"\xff\x58\x04" in midi_bytes[pos + 8 : chunk_end]:
                has_time_sig = True
            if b"\xff\x59\x02" in midi_bytes[pos + 8 : chunk_end]:
                has_key_sig = True

            # Scan Note On (0x90..0x9F) with velocity > 0
            idx = pos + 8
            running_status = 0
            while idx < chunk_end:
                # Read VLQ delta time
                while idx < chunk_end and (midi_bytes[idx] & 0x80):
                    idx += 1
                idx += 1
                if idx >= chunk_end:
                    break
                status = midi_bytes[idx]
                if status == 0xFF:
                    idx += 1
                    if idx >= chunk_end:
                        break
                    idx += 1  # meta type
                    # VLQ length
                    length = 0
                    while idx < chunk_end:
                        b = midi_bytes[idx]
                        idx += 1
                        length = (length << 7) | (b & 0x7F)
                        if not (b & 0x80):
                            break
                    idx += length
                elif status in (0xF0, 0xF7):
                    idx += 1
                    length = 0
                    while idx < chunk_end:
                        b = midi_bytes[idx]
                        idx += 1
                        length = (length << 7) | (b & 0x7F)
                        if not (b & 0x80):
                            break
                    idx += length
                else:
                    if status & 0x80:
                        running_status = status
                        idx += 1
                    else:
                        status = running_status
                    msg_type = status & 0xF0
                    if msg_type in (0xC0, 0xD0):
                        idx += 1
                    else:
                        if idx + 1 < chunk_end:
                            d1 = midi_bytes[idx]
                            d2 = midi_bytes[idx + 1]
                            if msg_type == 0x90 and d2 > 0:
                                note_on_pitches.append(d1)
                        idx += 2
        pos = chunk_end

    return {
        "format": fmt,
        "num_tracks": num_tracks,
        "parsed_tracks": track_count,
        "division": division,
        "has_tempo": has_tempo,
        "has_time_sig": has_time_sig,
        "has_key_sig": has_key_sig,
        "note_on_pitches": note_on_pitches,
    }


# ---------------------------------------------------------------------------
# Client Fixture
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def api_client():
    """Return an httpx client for the live Spring Boot backend when E2E_BASE_URL is set."""
    if not BASE_URL:
        pytest.skip("E2E_BASE_URL is unset; live Phase 2 & 3 E2E tests skipped.")

    import httpx

    with httpx.Client(base_url=BASE_URL, timeout=90.0) as client:
        yield client


def _create_analyzed_project(
    api_client,
    leading_silence_sec: float = 0.0,
    trailing_silence_sec: float = 0.0,
    duration_sec: float = 4.0,
) -> tuple[str, dict[str, Any]]:
    wav_bytes = make_sine_wav(
        duration_sec=duration_sec,
        freq_hz=261.63,
        amplitude=0.7,
        leading_silence_sec=leading_silence_sec,
        trailing_silence_sec=trailing_silence_sec,
    )
    up = api_client.post(
        "/api/audio/upload",
        files={"file": ("phase23_hum.wav", wav_bytes, "audio/wav")},
    )
    assert up.status_code in (200, 201), up.text
    up_data = up.json()
    project_id = up_data["project_id"]

    denoise = api_client.post(
        "/api/audio/denoise",
        json={"project_id": project_id, "enable_denoise": True, "auto_trim": False},
    )
    assert denoise.status_code == 200, denoise.text

    analyze = api_client.post(
        "/api/audio/analyze",
        json={"project_id": project_id, "source_ref": up_data["raw_input_ref"]},
    )
    assert analyze.status_code == 200, analyze.text
    return project_id, up_data


def _run_generate_job(api_client, project_id: str, config: dict[str, Any]) -> dict[str, Any]:
    gen = api_client.post(
        "/api/jobs/generate",
        json={"project_id": project_id, "config": config},
        headers={"X-LLM-Provider": "mock"},
    )
    assert gen.status_code in (200, 201, 202), gen.text
    job_id = gen.json()["job_id"]

    sse = api_client.get(f"/api/jobs/{job_id}/events")
    assert sse.status_code == 200, sse.text
    events = parse_sse_events(sse.text)
    completed = [e for e in events if e["event"] in ("completed", "fallback_warning")]
    assert completed, f"Job {job_id} did not emit completed/fallback_warning: {events}"

    proj = api_client.get(f"/api/projects/{project_id}")
    assert proj.status_code == 200, proj.text
    return proj.json()


# ---------------------------------------------------------------------------
# 1. Full Song Structure Presets (`standard` with Bridge vs `short`) (FR-HUM-05)
# ---------------------------------------------------------------------------


def test_full_song_standard_structure_includes_bridge_and_short_preset(api_client):
    pid_std, _ = _create_analyzed_project(api_client)
    state_std = _run_generate_job(
        api_client,
        pid_std,
        {
            "melody_mode": "enhance",
            "output_mode": "full_song",
            "structure_preset": "standard",
            "motif_position": "chorus",
            "genre": "Pop",
            "mood": "Uplifting",
            "user_prompt": "Dynamic chorus with contrasting bridge",
            "enable_lead_karaoke": True,
        },
    )
    sections_std = state_std.get("song_structure", {}).get("sections", [])
    names_std = [s.get("name", "") for s in sections_std]
    assert any("bridge" in n.lower() for n in names_std), (
        f"Expected Bridge section in standard Full Song structure, got: {names_std}"
    )
    assert any("intro" in n.lower() for n in names_std)
    assert any("verse" in n.lower() for n in names_std)
    assert any("chorus" in n.lower() for n in names_std)
    assert any("outro" in n.lower() for n in names_std)
    assert len(sections_std) >= 5, f"Expected full standard structure (>=5 sections), got: {names_std}"

    # Verify short preset produces compact 4-section structure without Bridge
    pid_short, _ = _create_analyzed_project(api_client)
    state_short = _run_generate_job(
        api_client,
        pid_short,
        {
            "melody_mode": "preserve",
            "output_mode": "full_song",
            "structure_preset": "short",
            "motif_position": "chorus",
            "genre": "Acoustic",
            "mood": "Warm",
            "user_prompt": "Short acoustic song",
        },
    )
    sections_short = state_short.get("song_structure", {}).get("sections", [])
    names_short = [s.get("name", "") for s in sections_short]
    assert len(sections_short) == 4, f"Expected 4 sections for short preset, got: {names_short}"
    assert not any("bridge" in n.lower() for n in names_short), (
        f"Short preset should omit Bridge, got: {names_short}"
    )


# ---------------------------------------------------------------------------
# 2. AI Auto-Trim Vocal (POST /api/studio/auto-trim-vocal) (FR-STU-06)
# ---------------------------------------------------------------------------


def test_studio_auto_trim_vocal_trims_silence_and_updates_clips(api_client):
    project_id, _ = _create_analyzed_project(
        api_client,
        duration_sec=3.2,
        leading_silence_sec=0.8,
        trailing_silence_sec=0.8,
    )

    resp = api_client.post(
        "/api/studio/auto-trim-vocal",
        json={"project_id": project_id},
    )
    assert resp.status_code == 200, f"auto-trim-vocal failed: {resp.status_code} {resp.text}"
    body = resp.json()

    proj_state = body.get("project_state") or body
    vocal_track = proj_state.get("tracks", {}).get("vocal", {})
    clips = vocal_track.get("clips", [])
    assert len(clips) >= 1, f"Expected at least 1 vocal clip after auto-trim: {body}"

    first_clip = clips[0]
    assert first_clip.get("trim_start_sec", 0.0) > 0.1, (
        f"Expected trim_start_sec > 0.1s for 0.8s leading silence, got: {first_clip}"
    )
    assert first_clip.get("trim_end_sec") is not None, (
        f"Expected trim_end_sec to be populated, got: {first_clip}"
    )
    assert first_clip["trim_end_sec"] > first_clip["trim_start_sec"], (
        f"Invalid trim bounds: {first_clip}"
    )


# ---------------------------------------------------------------------------
# 3. AI Auto-Mix & Mastering (POST /api/studio/auto-mix) (FR-STU-12)
# ---------------------------------------------------------------------------


def test_studio_auto_mix_balances_tracks_and_enables_limiter(api_client):
    project_id, _ = _create_analyzed_project(api_client)
    state = _run_generate_job(
        api_client,
        project_id,
        {
            "melody_mode": "preserve",
            "output_mode": "accompaniment",
            "motif_position": "chorus",
            "genre": "Pop",
            "mood": "Energetic",
            "user_prompt": "Auto-mix balance check",
        },
    )
    # Push volumes/pans to extreme values first to verify auto-mix resets/balances them
    for track in state.get("tracks", {}).values():
        if isinstance(track, dict):
            track["volume"] = 1.2
            track["pan"] = 0.9
    sync_resp = api_client.put(f"/api/projects/{project_id}/sync", json=state)
    assert sync_resp.status_code in (200, 201), sync_resp.text

    mix_resp = api_client.post(
        "/api/studio/auto-mix",
        json={"project_id": project_id},
    )
    assert mix_resp.status_code == 200, f"auto-mix failed: {mix_resp.status_code} {mix_resp.text}"
    body = mix_resp.json()

    updated = body.get("project_state") or body
    mastering = updated.get("mastering", {})
    assert mastering.get("auto_mix_enabled") is True, f"auto_mix_enabled not set: {mastering}"
    assert abs(float(mastering.get("limiter_ceiling_db", 0.0)) - (-1.0)) < 1e-3, (
        f"Expected limiter_ceiling_db == -1.0, got: {mastering}"
    )

    for track_name, track in updated.get("tracks", {}).items():
        if not isinstance(track, dict):
            continue
        vol = float(track.get("volume", -1.0))
        pan = float(track.get("pan", 99.0))
        assert 0.0 <= vol <= 1.15, f"Track {track_name} volume out of auto-mix bounds [0, 1.15]: {vol}"
        assert -0.5 <= pan <= 0.5, f"Track {track_name} pan out of auto-mix bounds [-0.5, 0.5]: {pan}"


# ---------------------------------------------------------------------------
# 4. Audio Clip Upload on Texture Track (POST /api/audio/clip-upload) (FR-STU-04)
# ---------------------------------------------------------------------------


def test_clip_upload_creates_texture_track_and_validates_format(api_client):
    project_id, _ = _create_analyzed_project(api_client)

    # Invalid file extension should be rejected
    bad_resp = api_client.post(
        "/api/audio/clip-upload",
        data={"project_id": project_id, "track_id": "texture"},
        files={"file": ("bad_clip.txt", b"not audio", "text/plain")},
    )
    assert bad_resp.status_code in (400, 415, 422), (
        f"Expected 400/415/422 for invalid clip format, got {bad_resp.status_code}: {bad_resp.text}"
    )

    # Valid WAV clip uploaded to texture track
    texture_wav = make_sine_wav(duration_sec=2.0, freq_hz=440.0, amplitude=0.5)
    resp = api_client.post(
        "/api/audio/clip-upload",
        data={"project_id": project_id, "track_id": "texture"},
        files={"file": ("pad_riser.wav", texture_wav, "audio/wav")},
    )
    assert resp.status_code in (200, 201), f"clip-upload failed: {resp.status_code} {resp.text}"
    body = resp.json()

    assert body.get("audio_ref"), f"Missing audio_ref in clip-upload response: {body}"
    clip = body.get("clip")
    assert isinstance(clip, dict) and clip.get("source"), f"Missing clip payload: {body}"

    proj_state = body.get("project_state", {})
    texture_track = proj_state.get("tracks", {}).get("texture")
    assert texture_track and texture_track.get("type") == "audio", (
        f"Expected audio track 'texture' in project_state: {proj_state.get('tracks', {}).keys()}"
    )
    assert any(c.get("id") == clip.get("id") for c in texture_track.get("clips", [])), (
        f"Uploaded clip not found in tracks.texture.clips: {texture_track}"
    )

    # Uploaded audio_ref must be streamable via /api/audio/asset
    asset_resp = api_client.get("/api/audio/asset", params={"ref": body["audio_ref"]})
    assert asset_resp.status_code == 200, f"Asset fetch failed: {asset_resp.status_code}"
    assert len(asset_resp.content) > 44


# ---------------------------------------------------------------------------
# 5. Multi-Clip Trim / Fade / Offset Export & Stems Parity (FR-STU-06, FR-STU-09)
# ---------------------------------------------------------------------------


def test_multiclip_trim_fade_export_and_stems(api_client):
    project_id, up_data = _create_analyzed_project(api_client, duration_sec=4.0)
    state = _run_generate_job(
        api_client,
        project_id,
        {
            "melody_mode": "preserve",
            "output_mode": "accompaniment",
            "motif_position": "chorus",
            "genre": "Lo-fi",
            "mood": "Chill",
            "user_prompt": "Multi-clip trim fade test",
        },
    )

    # Upload a second audio clip onto texture track
    texture_wav = make_sine_wav(duration_sec=2.0, freq_hz=523.25, amplitude=0.8)
    clip_up = api_client.post(
        "/api/audio/clip-upload",
        data={"project_id": project_id, "track_id": "texture"},
        files={"file": ("fx_chime.wav", texture_wav, "audio/wav")},
    )
    assert clip_up.status_code in (200, 201), clip_up.text
    clip_data = clip_up.json()
    state = clip_data["project_state"]

    # Split vocal into 2 clips with trim_start_sec, trim_end_sec, fade_in_ms, fade_out_ms, offset_ms
    vocal_ref = state["audio_assets"].get("dry_denoised_ref") or up_data["raw_input_ref"]
    state["tracks"]["vocal"]["clips"] = [
        {
            "id": "vocal_split_a",
            "source": vocal_ref,
            "start_bar": 1.0,
            "trim_start_sec": 0.25,
            "trim_end_sec": 1.75,
            "fade_in_ms": 50.0,
            "fade_out_ms": 50.0,
            "offset_ms": 0.0,
        },
        {
            "id": "vocal_split_b",
            "source": vocal_ref,
            "start_bar": 2.0,
            "trim_start_sec": 1.75,
            "trim_end_sec": 3.5,
            "fade_in_ms": 40.0,
            "fade_out_ms": 80.0,
            "offset_ms": 25.0,
        },
    ]
    # Ensure texture clip also has trim & fade
    state["tracks"]["texture"]["clips"][0].update(
        {
            "start_bar": 2.0,
            "trim_start_sec": 0.1,
            "trim_end_sec": 1.6,
            "fade_in_ms": 30.0,
            "fade_out_ms": 60.0,
            "offset_ms": 10.0,
        }
    )

    sync_resp = api_client.put(f"/api/projects/{project_id}/sync", json=state)
    assert sync_resp.status_code in (200, 201), sync_resp.text

    # Export mastered WAV mix
    wav_resp = api_client.post(
        f"/api/projects/{project_id}/export/audio",
        json={"format": "wav", "apply_mastering": True},
    )
    assert wav_resp.status_code == 200, f"Multi-clip WAV export failed: {wav_resp.text}"
    peak_dbfs = measure_wav_peak_dbfs(wav_resp.content)
    assert peak_dbfs <= -1.0 + 1e-4, f"Master Limiter violated on multi-clip export: {peak_dbfs:.3f} dBFS"

    # Export stems ZIP and verify equal duration across all stems (FR-STU-09)
    stems_resp = api_client.post(
        f"/api/projects/{project_id}/export/audio",
        json={"format": "stems", "apply_mastering": True},
    )
    assert stems_resp.status_code == 200, f"Stems export failed: {stems_resp.text}"
    with zipfile.ZipFile(io.BytesIO(stems_resp.content)) as zf:
        wav_names = [n for n in zf.namelist() if n.lower().endswith(".wav")]
        assert len(wav_names) >= 2, f"Expected multiple stem WAVs in zip, got: {wav_names}"
        durations = [get_wav_duration_sec(zf.read(name)) for name in wav_names]
        assert max(durations) - min(durations) < 0.05, (
            f"Stem durations misaligned: {dict(zip(wav_names, durations))}"
        )


# ---------------------------------------------------------------------------
# 6. Piano Roll Note Update + MIDI Export (FR-STU-10, FR-STU-14)
# ---------------------------------------------------------------------------


def test_piano_roll_note_update_and_midi_export(api_client):
    project_id, _ = _create_analyzed_project(api_client)
    state = _run_generate_job(
        api_client,
        project_id,
        {
            "melody_mode": "preserve",
            "output_mode": "accompaniment",
            "motif_position": "chorus",
            "genre": "Pop",
            "mood": "Bright",
            "user_prompt": "Piano roll MIDI export test",
        },
    )

    # Simulate Piano Roll edit: replace lead track notes with distinctive pitches (e.g., 73, 78, 81)
    edited_notes = [
        {"pitch": 73, "start_beat": 0.0, "duration": 1.0, "velocity": 100},
        {"pitch": 78, "start_beat": 1.0, "duration": 0.5, "velocity": 95},
        {"pitch": 81, "start_beat": 2.0, "duration": 1.5, "velocity": 110},
    ]
    state["tracks"]["lead"]["notes"] = edited_notes

    sync_resp = api_client.put(f"/api/projects/{project_id}/sync", json=state)
    assert sync_resp.status_code in (200, 201), sync_resp.text

    midi_resp = api_client.post(f"/api/projects/{project_id}/export/midi")
    assert midi_resp.status_code == 200, f"MIDI export failed: {midi_resp.status_code} {midi_resp.text}"

    parsed = parse_midi_notes_and_meta(midi_resp.content)
    assert parsed["parsed_tracks"] >= 2, f"Expected multi-track SMF, got: {parsed}"
    assert parsed["has_tempo"], "Exported .mid missing Set Tempo meta event (FF 51 03)"
    assert parsed["has_time_sig"], "Exported .mid missing Time Signature meta event (FF 58 04)"
    assert parsed["has_key_sig"], "Exported .mid missing Key Signature meta event (FF 59 02)"
    for expected_pitch in (73, 78, 81):
        assert expected_pitch in parsed["note_on_pitches"], (
            f"Updated Piano Roll pitch {expected_pitch} not found in exported .mid: {parsed['note_on_pitches']}"
        )


# ---------------------------------------------------------------------------
# 7. Frontend <-> Backend Phase 2 & 3 Contract Parity (Static)
# ---------------------------------------------------------------------------


def test_phase2_3_frontend_backend_contract_parity():
    """Verify Phase 2 & 3 endpoints, DTO fields, and UI studio components exist and match."""
    if not BACKEND_CONTROLLERS_DIR.exists() or not FRONTEND_CLIENT_PATH.exists():
        pytest.skip("Backend controllers or frontend client not present")

    backend_source = "\n".join(
        p.read_text(encoding="utf-8") for p in sorted(BACKEND_CONTROLLERS_DIR.glob("*.java"))
    )
    frontend_client = FRONTEND_CLIENT_PATH.read_text(encoding="utf-8")
    frontend_types = FRONTEND_TYPES_PATH.read_text(encoding="utf-8")

    # 1. New Phase 2 & 3 public endpoints in both frontend client & Spring Boot controllers
    new_endpoints = [
        "/api/studio/auto-trim-vocal",
        "/api/studio/auto-mix",
        "/api/audio/clip-upload",
    ]
    for ep in new_endpoints:
        assert ep in frontend_client, f"Missing endpoint {ep} in frontend/src/lib/api/client.ts"
        prefix, _, tail = ep.rpartition("/")
        has_full = ep in backend_source
        has_split = (prefix in backend_source) and (f"/{tail}" in backend_source)
        assert has_full or has_split, f"Missing endpoint {ep} in Spring Boot controllers"

    # 2. structure_preset on ProjectConfig & AutoTrimVocalResponse / JobRearrangeRequest DTO parity
    project_config_java = (BACKEND_MODEL_DIR / "ProjectConfig.java").read_text(encoding="utf-8")
    assert "structure_preset" in project_config_java, "Missing structure_preset in ProjectConfig.java"
    assert "structure_preset" in frontend_types, "Missing structure_preset in frontend/src/types/project.ts"

    auto_trim_java = (BACKEND_MODEL_DIR / "dto" / "AutoTrimVocalResponse.java").read_text(encoding="utf-8")
    for field in ("trim_start_sec", "trim_end_sec", "trimmed_clips"):
        assert field in auto_trim_java, f"Missing {field} in AutoTrimVocalResponse.java"
        assert field in frontend_types, f"Missing {field} in frontend/src/types/project.ts"

    rearrange_java = (BACKEND_MODEL_DIR / "dto" / "JobRearrangeRequest.java").read_text(encoding="utf-8")
    for field in ("sections", "total_bars"):
        assert field in rearrange_java, f"Missing {field} in JobRearrangeRequest.java"
        assert field in frontend_types, f"Missing {field} in frontend/src/types/project.ts"

    # 3. Studio components TimelineEditor.tsx & PianoRollEditor.tsx exist and wire key symbols
    assert FRONTEND_TIMELINE_PATH.exists(), "Missing frontend/src/components/studio/TimelineEditor.tsx"
    assert FRONTEND_PIANOROLL_PATH.exists(), "Missing frontend/src/components/studio/PianoRollEditor.tsx"

    timeline_src = FRONTEND_TIMELINE_PATH.read_text(encoding="utf-8")
    for token in ("offset_ms", "trim_start_sec", "trim_end_sec", "fade_in_ms", "fade_out_ms", "texture"):
        assert token in timeline_src, f"TimelineEditor.tsx missing Phase 2/3 clip/track field '{token}'"

    pianoroll_src = FRONTEND_PIANOROLL_PATH.read_text(encoding="utf-8")
    assert "snapGrid" in pianoroll_src or "snap" in pianoroll_src.lower(), (
        "PianoRollEditor.tsx missing snap grid support"
    )
    assert re.search(r"quantize", pianoroll_src, re.IGNORECASE), (
        "PianoRollEditor.tsx missing Quantize Track action"
    )


def test_phase4_crud_eq_send_fx_and_delete(api_client):
    """Verify full Project CRUD (Sync/Read/List/Delete->404), Lyrics CRUD, 3-Band EQ & Send FX WAV Export."""
    pid = f"e2e_p4_crud_{uuid.uuid4().hex[:8]}"
    payload = {
        "project_id": pid,
        "version": 1,
        "title": "Phase 4 CRUD & FX E2E",
        "config": {
            "title": "Phase 4 CRUD & FX E2E",
            "melody_mode": "preserve",
            "output_mode": "accompaniment",
            "motif_position": "chorus",
            "structure_preset": "standard",
            "genre": "Pop",
            "mood": "Uplifting",
            "user_prompt": "Phase 4 EQ and Send FX E2E",
        },
        "analysis": {
            "bpm": 120.0,
            "time_signature": "4/4",
            "detected_key": "C",
            "detected_scale": "major",
            "bars": 2,
            "raw_melody_midi": [],
        },
        "autotune_settings": {
            "enabled": False,
            "preset": "off",
            "key": "C",
            "scale": "major",
            "retune_speed_ms": 50.0,
            "humanize": 0.6,
            "mix_percent": 100.0,
            "auto_follow_project_key": True,
        },
        "song_structure": {
            "total_bars": 2,
            "sections": [{"name": "Chorus", "start_bar": 1, "bars": 2, "energy": 0.85}],
            "chords": [{"bar": 1, "beat": 1.0, "symbol": "C", "duration_beats": 4.0}],
        },
        "lyrics": {
            "language": "vi",
            "lines": [{"section": "Chorus", "bar": 1, "text": "Phase 4 FX"}],
        },
        "tracks": {
            "vocal": {
                "type": "audio",
                "locked": False,
                "mute": False,
                "solo": False,
                "volume": 0.9,
                "pan": 0.0,
                "low_db": -2.0,
                "mid_db": 3.0,
                "high_db": 4.0,
                "reverb_send": 0.65,
                "delay_send": 0.4,
                "clips": [],
            },
            "lead": {
                "type": "midi",
                "locked": False,
                "mute": False,
                "solo": False,
                "volume": 0.85,
                "pan": 0.1,
                "low_db": 6.0,
                "mid_db": -3.0,
                "high_db": 5.0,
                "reverb_send": 0.75,
                "delay_send": 0.55,
                "instrument": "synth_lead",
                "notes": [
                    {"pitch": 69, "start_beat": 0.0, "duration": 1.0, "velocity": 115, "confidence": 1.0}
                ],
            },
        },
        "mastering": {"auto_mix_enabled": True, "limiter_ceiling_db": -1.0, "target_lufs": -14.0},
    }

    sync_res = api_client.put(f"/api/projects/{pid}/sync", json=payload)
    assert sync_res.status_code == 200, sync_res.text

    get_res = api_client.get(f"/api/projects/{pid}")
    assert get_res.status_code == 200, get_res.text
    got = get_res.json()
    assert got["tracks"]["vocal"]["low_db"] == -2.0
    assert got["tracks"]["vocal"]["reverb_send"] == 0.65
    assert got["tracks"]["lead"]["high_db"] == 5.0
    assert got["tracks"]["lead"]["delay_send"] == 0.55
    assert got["lyrics"]["lines"][0]["text"] == "Phase 4 FX"
    assert got["song_structure"]["sections"][0]["energy"] == 0.85

    export_res = api_client.post(
        f"/api/projects/{pid}/export/audio",
        json={"format": "wav", "mode": "ai_mix", "apply_mastering": True},
    )
    assert export_res.status_code == 200, export_res.text
    assert export_res.content[:4] == b"RIFF"
    peak_dbfs = measure_wav_peak_dbfs(export_res.content)
    assert peak_dbfs <= -1.0 + 1e-4, f"Limiter exceeded on EQ/FX export: {peak_dbfs:.3f}"

    # Verify selectable 320k / 192k MP3 export via running backend + audio-worker
    mp3_320 = api_client.post(
        f"/api/projects/{pid}/export/audio",
        json={"format": "mp3", "mode": "ai_mix", "bitrate": "320k", "apply_mastering": True},
    )
    assert mp3_320.status_code == 200, mp3_320.text
    assert len(mp3_320.content) > 512

    mp3_192 = api_client.post(
        f"/api/projects/{pid}/export/audio",
        json={"format": "mp3", "mode": "ai_mix", "bitrate": "192k", "apply_mastering": True},
    )
    assert mp3_192.status_code == 200, mp3_192.text
    assert len(mp3_192.content) > 512

    llm_test = api_client.post("/api/health/llm-test", json={})
    assert llm_test.status_code == 200, llm_test.text
    assert "provider" in llm_test.json()

    del_res = api_client.delete(f"/api/projects/{pid}")
    assert del_res.status_code == 200, del_res.text
    assert api_client.get(f"/api/projects/{pid}").status_code == 404


def test_security_headers_validation_and_dos_guards(api_client):
    """Verify defensive HTTP headers, traversal/Zip-Bomb/ref blocks, collision-safe import, and render OOM clamps."""
    # 1. Security response headers
    health_res = api_client.get("/api/health")
    assert health_res.status_code == 200
    assert health_res.headers.get("X-Content-Type-Options") == "nosniff"
    assert health_res.headers.get("X-Frame-Options") == "DENY"
    assert health_res.headers.get("Referrer-Policy") == "no-referrer"

    # 2. Asset ref traversal / Redis namespace probe blocked
    for bad_ref in ("project:secret", "mem://../etc/passwd", "mem://raw/bad ref"):
        r = api_client.get("/api/audio/asset", params={"ref": bad_ref})
        assert r.status_code == 400, f"Expected 400 for bad asset ref '{bad_ref}', got {r.status_code}"

    # 3. Overdub fit check rejects non-audio uploads
    bad_overdub = api_client.post(
        "/api/studio/overdub-fit-check",
        data={"project_id": "sec_probe_1"},
        files={"file": ("payload.txt", b"not audio", "text/plain")},
    )
    assert bad_overdub.status_code == 400

    # 4. Zip path traversal in .aimusic import rejected
    evil_zip = io.BytesIO()
    with zipfile.ZipFile(evil_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("../evil.txt", b"malicious")
    evil_res = api_client.post(
        "/api/projects/import",
        files={"file": ("evil.aimusic", evil_zip.getvalue(), "application/octet-stream")},
    )
    assert evil_res.status_code == 400

    # 5. Collision-safe import with overwrite=false isolates ID & clip refs + Content-Disposition sanitize
    pid = f"e2e_sec_col_{uuid.uuid4().hex[:8]}"
    state = {
        "project_id": pid,
        "version": 1,
        "title": "Security Baseline",
        "config": {"title": "Security Baseline", "genre": "Pop", "mood": "Warm"},
        "analysis": {"bpm": 120.0, "time_signature": "4/4", "detected_key": "C", "detected_scale": "major", "bars": 2},
        "song_structure": {
            "total_bars": 2,
            "sections": [{"name": "Main", "start_bar": 1, "bars": 2, "energy": 0.8}],
            "chords": [{"bar": 1, "beat": 1.0, "symbol": "C", "duration_beats": 4.0}],
        },
        "tracks": {
            "lead": {
                "type": "midi",
                "instrument": "electric_piano",
                "volume": 0.8,
                "notes": [{"pitch": 60, "start_beat": 0.0, "duration": 1.0, "velocity": 90, "confidence": 1.0}],
            }
        },
    }
    assert api_client.put(f"/api/projects/{pid}/sync", json=state).status_code == 200
    bundle_res = api_client.post(f"/api/projects/{pid}/export/aimusic")
    assert bundle_res.status_code == 200

    col_import = api_client.post(
        "/api/projects/import",
        data={"overwrite": "false"},
        files={"file": (f"{pid}.aimusic", bundle_res.content, "application/octet-stream")},
    )
    assert col_import.status_code == 200, col_import.text
    imp_pid = col_import.json()["project_id"]
    assert imp_pid != pid and imp_pid.startswith(f"{pid}_imp_")

    # 6. Export Content-Disposition check + extreme total_bars OOM DoS rejection (400)
    ok_exp = api_client.post(
        f"/api/projects/{pid}/export/audio",
        json={"format": "wav", "mode": "ai_mix", "apply_mastering": True},
    )
    assert ok_exp.status_code == 200, ok_exp.text
    assert ok_exp.content[:4] == b"RIFF"
    assert f'"{pid}.wav"' in ok_exp.headers.get("content-disposition", "")

    state["song_structure"]["total_bars"] = 99999
    state["tracks"]["lead"]["mute"] = False
    dos_pid = f"e2e_dos_{uuid.uuid4().hex[:8]}"
    state["project_id"] = dos_pid
    assert api_client.put(f"/api/projects/{dos_pid}/sync", json=state).status_code == 200
    exp_res = api_client.post(
        f"/api/projects/{dos_pid}/export/audio",
        json={"format": "wav", "mode": "ai_mix", "apply_mastering": True},
    )
    assert exp_res.status_code == 400, exp_res.text

    for cleanup_id in (pid, imp_pid, dos_pid):
        api_client.delete(f"/api/projects/{cleanup_id}")


def test_end_to_end_full_lifecycle_workflow(api_client):
    """Run complete user workflow: Upload -> Denoise -> Analyze -> AutoTune -> Generate SSE -> Overdub -> Export/Import."""
    wav_bytes = make_sine_wav(duration_sec=3.6, freq_hz=293.66, amplitude=0.5, leading_silence_sec=0.35)
    up = api_client.post(
        "/api/audio/upload",
        data={"title": "Lifecycle Flow Song", "mode": "hum"},
        files={"file": ("lifecycle.wav", wav_bytes, "audio/wav")},
    )
    assert up.status_code == 200, up.text
    pid = up.json()["project_id"]

    dn = api_client.post(
        "/api/audio/denoise",
        json={"project_id": pid, "enable_denoise": True, "auto_trim": True},
    )
    assert dn.status_code == 200, dn.text

    an = api_client.post(
        "/api/audio/analyze",
        json={"project_id": pid, "key_override": "D", "scale_override": "minor"},
    )
    assert an.status_code == 200, an.text

    at = api_client.post(
        "/api/audio/autotune",
        json={"project_id": pid, "preset": "balanced"},
    )
    assert at.status_code == 200, at.text

    gen = api_client.post(
        "/api/jobs/generate",
        json={
            "project_id": pid,
            "config": {
                "melody_mode": "enhance",
                "output_mode": "full_song",
                "motif_position": "chorus",
                "structure_preset": "standard",
                "genre": "Ballad",
                "mood": "Warm",
                "user_prompt": "Warm piano and strings",
                "enable_lead_karaoke": True,
            },
        },
    )
    assert gen.status_code == 200, gen.text
    job_id = gen.json()["job_id"]
    sse = api_client.get(f"/api/jobs/{job_id}/events", timeout=60.0)
    assert sse.status_code == 200
    assert "completed" in sse.text

    # Add overdub + fit check + auto-mix
    ov_clip = api_client.post(
        "/api/audio/clip-upload",
        data={"project_id": pid, "track_id": "vocal", "start_bar": "5.0"},
        files={"file": ("overdub.wav", make_sine_wav(duration_sec=2.0, freq_hz=440.0), "audio/wav")},
    )
    assert ov_clip.status_code == 200, ov_clip.text

    fit = api_client.post(
        "/api/studio/overdub-fit-check",
        data={"project_id": pid},
        files={"file": ("overdub.wav", make_sine_wav(duration_sec=2.0, freq_hz=440.0), "audio/wav")},
    )
    assert fit.status_code == 200, fit.text
    assert "timing_offset_ms" in fit.json()

    mix_res = api_client.post("/api/studio/auto-mix", json={"project_id": pid})
    assert mix_res.status_code == 200, mix_res.text

    # Export .aimusic, MIDI, MP3 (320k), and Stems ZIP
    aimusic = api_client.post(f"/api/projects/{pid}/export/aimusic")
    assert aimusic.status_code == 200 and len(aimusic.content) > 512

    midi = api_client.post(f"/api/projects/{pid}/export/midi")
    assert midi.status_code == 200 and midi.content[:4] == b"MThd"

    mp3 = api_client.post(
        f"/api/projects/{pid}/export/audio",
        json={"format": "mp3", "mode": "ai_mix", "bitrate": "320k", "apply_mastering": True},
    )
    assert mp3.status_code == 200 and len(mp3.content) > 512

    stems = api_client.post(
        f"/api/projects/{pid}/export/audio",
        json={"format": "stems", "mode": "ai_mix", "apply_mastering": True},
    )
    assert stems.status_code == 200
    with zipfile.ZipFile(io.BytesIO(stems.content)) as zf:
        assert len([n for n in zf.namelist() if n.endswith(".wav")]) >= 4

    # Delete from backend and restore via .aimusic import -> re-export WAV <= -1.0 dBFS
    assert api_client.delete(f"/api/projects/{pid}").status_code == 200
    assert api_client.get(f"/api/projects/{pid}").status_code == 404

    restored = api_client.post(
        "/api/projects/import",
        files={"file": (f"{pid}.aimusic", aimusic.content, "application/octet-stream")},
    )
    assert restored.status_code == 200, restored.text
    restored_wav = api_client.post(
        f"/api/projects/{pid}/export/audio",
        json={"format": "wav", "mode": "ai_mix", "apply_mastering": True},
    )
    assert restored_wav.status_code == 200
    assert measure_wav_peak_dbfs(restored_wav.content) <= -1.0 + 1e-4

    api_client.delete(f"/api/projects/{pid}")


def test_full_spectrum_copilot_stream_and_audio(api_client):
    """Verify Global + Studio AI Copilot: /api/coach/chat, SSE /stream, /audio DSP upload & 10MB guard."""
    up = api_client.post(
        "/api/audio/upload",
        data={"title": "Copilot E2E Song", "mode": "hum"},
        files={"file": ("hum.wav", make_sine_wav(duration_sec=3.5, freq_hz=330.0), "audio/wav")},
    )
    assert up.status_code == 200, up.text
    pid = up.json()["project_id"]

    # 1. Global Copilot on "/" recommends create_template
    home_chat = api_client.post(
        "/api/coach/chat",
        headers={"X-LLM-Provider": "mock"},
        json={"project_id": "__home__", "route": "/", "mode": "producer", "message": "Tạo beat Lo-fi mới", "history": []},
    )
    assert home_chat.status_code == 200, home_chat.text
    assert any(a["action"] == "create_template" for a in home_chat.json().get("suggested_actions", []))

    # 2. Live SSE streaming returns chunk + actions + done with set_track_mix
    sse_resp = api_client.post(
        "/api/coach/chat/stream",
        headers={"X-LLM-Provider": "mock"},
        json={
            "project_id": pid,
            "route": f"/studio/{pid}",
            "mode": "mix",
            "message": "Vocal hơi chói và hơi khô",
            "history": [],
        },
        timeout=30.0,
    )
    assert sse_resp.status_code == 200, sse_resp.text
    assert "text/event-stream" in sse_resp.headers.get("content-type", "")
    assert "event:chunk" in sse_resp.text and "event:actions" in sse_resp.text and "event:done" in sse_resp.text
    assert "set_track_mix" in sse_resp.text

    # 3. Multimodal WAV upload returns DSP telemetry (dBFS)
    audio_resp = api_client.post(
        "/api/coach/chat/audio",
        headers={"X-LLM-Provider": "mock"},
        data={"project_id": pid, "mode": "mix", "route": f"/studio/{pid}", "message": "Nghe giúp vocal này"},
        files={"file": ("vocal.wav", make_sine_wav(duration_sec=1.5, freq_hz=440.0), "audio/wav")},
    )
    assert audio_resp.status_code == 200, audio_resp.text
    assert "dBFS" in audio_resp.json().get("reply", "")
    assert len(audio_resp.json().get("suggested_actions", [])) >= 1

    # 4. Holistic audit prompt ("AI làm được gì & Đề xuất mọi thứ") proposes >= 6 multi-domain actions
    audit_chat = api_client.post(
        "/api/coach/chat",
        headers={"X-LLM-Provider": "mock"},
        json={
            "project_id": pid,
            "route": f"/studio/{pid}",
            "mode": "producer",
            "message": "AI làm được gì và đề xuất mọi thứ cho bài này",
            "history": [],
        },
    )
    assert audit_chat.status_code == 200, audit_chat.text
    assert len(audit_chat.json().get("suggested_actions", [])) >= 6

    # 5. Oversized audio (> 10 MB) returns 413
    too_big = api_client.post(
        "/api/coach/chat/audio",
        data={"project_id": pid, "message": "Too big"},
        files={"file": ("big.wav", b"RIFF" + b"\x00" * (10 * 1024 * 1024 + 128), "audio/wav")},
    )
    assert too_big.status_code == 413, too_big.text

    # 6. Phase 6B & 7: Separate Stems + Track Automation Sync + Invalid SoundFont guard
    sep_res = api_client.post("/api/studio/separate-stems", json={"project_id": pid})
    assert sep_res.status_code == 200, sep_res.text
    sep_json = sep_res.json()
    assert sep_json["vocal_ref"].startswith("mem://stems/")
    assert sep_json["beat_ref"].startswith("mem://stems/")
    synced_state = sep_json["project_state"]
    synced_state["tracks"]["vocal"]["automation"] = {
        "filter": [{"bar": 1.0, "value": 0.4}, {"bar": 4.0, "value": 1.0}]
    }
    sync_auto = api_client.put(f"/api/projects/{pid}/sync", json=synced_state)
    assert sync_auto.status_code == 200, sync_auto.text
    assert sync_auto.json()["tracks"]["vocal"]["automation"]["filter"][1]["value"] == 1.0

    bad_sf2 = api_client.post(
        "/api/audio/soundfont",
        files={"file": ("invalid.sf2", b"BAD_SF2_HEADER", "application/octet-stream")},
    )
    assert bad_sf2.status_code == 400, bad_sf2.text

    api_client.delete(f"/api/projects/{pid}")
