"""Unit and API tests for Audio DSP, Master Limiter, Redis TTL fallback, and Project pagination."""

from __future__ import annotations

import io
import sys
import time
import zipfile
from pathlib import Path

import mido
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

# Ensure backend/ is importable when pytest runs from repo root or backend/
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.redis_store import RedisStore, get_store
from app.core.schemas import (
    AutotuneSettings,
    MidiNote,
    ProjectConfig,
    ProjectState,
    create_default_project,
)
from app.main import app
from app.services.audio.autotune import apply_autotune, apply_preset, key_to_pitch_class, nearest_scale_midi
from app.services.audio.denoise import (
    AudioValidationError,
    decode_wav_bytes,
    encode_wav_bytes,
    validate_and_decode_audio,
)
from app.services.audio.exporter import apply_master_limiter, peak_dbfs
from app.services.audio.renderer import render_midi_tracks_to_audio, render_project_mix


def _make_melody_wav(duration_sec: float = 4.0, sr: int = 44100, add_noise: bool = True) -> bytes:
    """Generate a clean C-major melody WAV (C4-E4-G4-C5) at 120 BPM."""
    freqs = [261.63, 329.63, 392.00, 523.25]
    n_total = int(duration_sec * sr)
    t = np.arange(n_total, dtype=np.float32) / sr
    y = np.zeros(n_total, dtype=np.float32)
    seg_len = max(1, n_total // len(freqs))
    for i, f in enumerate(freqs):
        s = i * seg_len
        e = n_total if i == len(freqs) - 1 else (i + 1) * seg_len
        y[s:e] = 0.45 * np.sin(2.0 * np.pi * f * t[s:e])
    if add_noise:
        rng = np.random.default_rng(42)
        y += 0.015 * rng.standard_normal(n_total).astype(np.float32)
    return encode_wav_bytes(y, sr)


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


def test_health_endpoint(client: TestClient) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["redis"]["connected"] is True
    assert body["redis"]["backend"] in ("redis", "memory")
    assert "engines" in body
    assert "llm_providers" in body


def test_upload_validations(client: TestClient) -> None:
    # 1. Invalid extension
    bad_ext = client.post(
        "/api/audio/upload",
        files={"file": ("notes.txt", b"not audio", "text/plain")},
    )
    assert bad_ext.status_code == 400

    # 2. Too short (< 3s)
    short_wav = _make_melody_wav(duration_sec=1.5)
    too_short = client.post(
        "/api/audio/upload",
        files={"file": ("short.wav", short_wav, "audio/wav")},
    )
    assert too_short.status_code == 400
    assert "shorter than minimum" in too_short.json()["detail"].lower()

    # 3. Exceeds max size (> 50MB guard)
    with pytest.raises(AudioValidationError) as exc_info:
        validate_and_decode_audio(b"0" * 1024, "big.wav", max_bytes=512)
    assert exc_info.value.status_code == 413


def test_full_dsp_pipeline_upload_denoise_analyze_autotune(client: TestClient) -> None:
    wav_bytes = _make_melody_wav(duration_sec=4.0, add_noise=True)

    # 1. Upload
    up = client.post(
        "/api/audio/upload",
        files={"file": ("hum.wav", wav_bytes, "audio/wav")},
        data={"title": "Test Hum Song"},
    )
    assert up.status_code == 200
    up_data = up.json()
    pid = up_data["project_id"]
    assert up_data["duration_sec"] >= 3.0
    assert up_data["sample_rate"] == 44100
    assert up_data["raw_input_ref"].startswith("mem://raw/")

    # 2. Denoise (Dry Check preserves raw_input_ref)
    dn = client.post(
        "/api/audio/denoise",
        json={"project_id": pid, "enable_denoise": True, "auto_trim": True},
    )
    assert dn.status_code == 200
    dn_data = dn.json()
    assert dn_data["raw_input_ref"] == up_data["raw_input_ref"]
    assert dn_data["dry_denoised_ref"] != dn_data["raw_input_ref"]

    # Verify both Raw and Denoised assets can be fetched
    assert client.get("/api/audio/asset", params={"ref": dn_data["raw_input_ref"]}).status_code == 200
    dry_asset = client.get("/api/audio/asset", params={"ref": dn_data["dry_denoised_ref"]})
    assert dry_asset.status_code == 200
    dry_samples, dry_sr = decode_wav_bytes(dry_asset.content)
    assert dry_sr == 44100

    # 3. Analyze (BPM 40..220, Key/Scale, MIDI notes)
    an = client.post("/api/audio/analyze", json={"project_id": pid})
    assert an.status_code == 200
    an_data = an.json()
    assert 40.0 <= an_data["bpm"] <= 220.0
    assert an_data["bars"] >= 1
    assert len(an_data["raw_melody_midi"]) >= 1

    # Manual BPM/Key lock should stick on re-analyze without overrides
    an_lock = client.post(
        "/api/audio/analyze",
        json={"project_id": pid, "bpm_override": 115.0, "key_override": "G", "scale_override": "major"},
    )
    assert an_lock.status_code == 200
    assert an_lock.json()["bpm"] == 115.0
    assert an_lock.json()["key"] == "G"

    an_again = client.post("/api/audio/analyze", json={"project_id": pid})
    assert an_again.status_code == 200
    assert an_again.json()["bpm"] == 115.0
    assert an_again.json()["key"] == "G"

    # 4. Auto-Tune Quick Presets (off / natural / balanced / modern)
    for preset in ("off", "natural", "balanced", "modern"):
        preset_settings = apply_preset(preset, key="C", scale="major")
        at = client.post(
            "/api/audio/autotune",
            json={"project_id": pid, "autotune_settings": preset_settings.model_dump()},
        )
        assert at.status_code == 200
        tuned_ref = at.json()["tuned_vocal_ref"]
        tuned_asset = client.get("/api/audio/asset", params={"ref": tuned_ref})
        assert tuned_asset.status_code == 200
        tuned_samples, _ = decode_wav_bytes(tuned_asset.content)
        # Duration and t=0 alignment preserved
        assert len(tuned_samples) == len(dry_samples)


def test_autotune_preserves_length_unit() -> None:
    wav = _make_melody_wav(duration_sec=3.2, add_noise=False)
    orig, sr = decode_wav_bytes(wav)
    tuned_wav = apply_autotune(wav, AutotuneSettings(enabled=True, preset="modern", key="C", scale="major"))
    tuned, tuned_sr = decode_wav_bytes(tuned_wav)
    assert tuned_sr == sr
    assert len(tuned) == len(orig)


def test_autotune_flat_and_enharmonic_keys() -> None:
    assert key_to_pitch_class("Eb") == 3
    assert key_to_pitch_class("Ab") == 8
    assert key_to_pitch_class("Bb") == 10
    assert key_to_pitch_class("Db") == 1
    assert key_to_pitch_class("Gb") == 6
    # In Eb major (Eb=63, F=65, G=67, Ab=68, Bb=70, C=72, D=74), 63.1 snaps to 63 (Eb4), not 64 (E4)
    assert nearest_scale_midi(63.1, "Eb", "major") == 63.0
    assert nearest_scale_midi(70.2, "Bb", "major") == 70.0


def test_master_limiter_enforces_minus_1_dbfs() -> None:
    # Create heavily clipped / overdriven stereo signal (+6 dBFS)
    sr = 44100
    t = np.linspace(0, 1.0, sr, endpoint=False, dtype=np.float32)
    hot = np.stack([2.2 * np.sin(2 * np.pi * 220 * t), 2.2 * np.sin(2 * np.pi * 440 * t)], axis=1)
    limited = apply_master_limiter(hot, sample_rate=sr, ceiling_db=-1.0, target_lufs=-14.0)
    assert peak_dbfs(limited) <= -1.0


def test_midi_render_stems_and_exports(client: TestClient) -> None:
    store = get_store()
    proj = create_default_project(title="Rendered Song")
    proj.analysis.bpm = 120.0
    proj.analysis.detected_key = "C"
    proj.analysis.detected_scale = "major"
    proj.analysis.bars = 4
    proj.song_structure.total_bars = 4

    # Add MIDI notes and push track volumes to 1.2 (120%) to stress Master Limiter
    proj.tracks["drums"].notes = [
        MidiNote(pitch=36, start_beat=0.0, duration=0.5, velocity=120),
        MidiNote(pitch=38, start_beat=1.0, duration=0.5, velocity=115),
        MidiNote(pitch=42, start_beat=0.5, duration=0.25, velocity=100),
    ]
    proj.tracks["bass"].notes = [
        MidiNote(pitch=36, start_beat=0.0, duration=2.0, velocity=120),
        MidiNote(pitch=43, start_beat=2.0, duration=2.0, velocity=120),
    ]
    proj.tracks["harmony"].notes = [
        MidiNote(pitch=60, start_beat=0.0, duration=4.0, velocity=110),
        MidiNote(pitch=64, start_beat=0.0, duration=4.0, velocity=110),
        MidiNote(pitch=67, start_beat=0.0, duration=4.0, velocity=110),
    ]
    for t in proj.tracks.values():
        t.volume = 1.2
    store.save_project(proj)

    # Render directly and verify equal stem lengths and <= -1.0 dBFS limiter
    mix, stems, sr = render_project_mix(proj, store, mode="ai_mix", apply_mastering=True)
    assert sr == 44100
    assert peak_dbfs(mix) <= -1.0
    stem_lengths = {arr.shape[0] for arr in stems.values()}
    assert len(stem_lengths) == 1

    # Export WAV via API
    wav_resp = client.post(
        f"/api/projects/{proj.project_id}/export/audio",
        json={"format": "wav", "apply_mastering": True, "mode": "ai_mix"},
    )
    assert wav_resp.status_code == 200
    assert wav_resp.content[:4] == b"RIFF"
    arr, out_sr = sf.read(io.BytesIO(wav_resp.content), dtype="float32")
    assert out_sr == 44100
    assert peak_dbfs(arr) <= -1.0

    # Export Stems ZIP
    stems_resp = client.post(
        f"/api/projects/{proj.project_id}/export/audio",
        json={"format": "stems", "apply_mastering": True},
    )
    assert stems_resp.status_code == 200
    with zipfile.ZipFile(io.BytesIO(stems_resp.content), "r") as zf:
        names = zf.namelist()
        assert "stems/drums.wav" in names
        assert "stems/bass.wav" in names

    # Export MIDI with Meta Events
    midi_resp = client.post(f"/api/projects/{proj.project_id}/export/midi")
    assert midi_resp.status_code == 200
    mid = mido.MidiFile(file=io.BytesIO(midi_resp.content))
    meta_types = {msg.type for track in mid.tracks for msg in track if msg.is_meta}
    assert {"set_tempo", "time_signature", "key_signature"}.issubset(meta_types)

    # Export & re-import .aimusic bundle
    bundle_resp = client.post(f"/api/projects/{proj.project_id}/export/aimusic")
    assert bundle_resp.status_code == 200
    reimport_resp = client.post(
        "/api/projects/import",
        files={"file": (f"{proj.project_id}.aimusic", bundle_resp.content, "application/octet-stream")},
    )
    assert reimport_resp.status_code == 200
    assert reimport_resp.json()["project_id"] == proj.project_id

    # Guard: disallow export when all tracks are muted
    for t in proj.tracks.values():
        t.mute = True
    store.save_project(proj)
    muted_resp = client.post(
        f"/api/projects/{proj.project_id}/export/audio",
        json={"format": "wav", "apply_mastering": True},
    )
    assert muted_resp.status_code == 400


def test_memory_ttl_fallback_and_pagination(client: TestClient) -> None:
    # 1. Verify In-Memory TTL expiration
    mem_store = RedisStore(force_memory=True, project_ttl=1, audio_ttl=1)
    p = create_default_project(project_id="ttl_test", title="TTL Check")
    mem_store.save_project(p, ttl=1)
    assert mem_store.get_project("ttl_test") is not None
    time.sleep(1.1)
    assert mem_store.get_project("ttl_test") is None

    # 2. Verify API pagination, search, sync, and undo
    store = get_store()
    for i in range(15):
        proj = create_default_project(project_id=f"page_proj_{i:02d}", title=f"Beat Idea {i:02d}")
        proj.config.genre = "Lo-fi" if i % 2 == 0 else "Pop"
        store.save_project(proj)

    p1 = client.get("/api/projects", params={"page": 1, "limit": 12, "search": "Beat Idea"})
    assert p1.status_code == 200
    d1 = p1.json()
    assert d1["total"] == 15
    assert d1["total_pages"] == 2
    assert len(d1["items"]) == 12

    p2 = client.get("/api/projects", params={"page": 2, "limit": 12, "search": "Beat Idea"})
    assert p2.status_code == 200
    assert len(p2.json()["items"]) == 3

    lofi = client.get("/api/projects", params={"page": 1, "limit": 12, "search": "Beat Idea", "genre": "Lo-fi"})
    assert lofi.status_code == 200
    assert lofi.json()["total"] == 8

    # Sync + Undo check
    target = store.get_project("page_proj_00")
    assert target is not None
    target.config = ProjectConfig(title="Updated Title", genre="Pop")
    sync_resp = client.put("/api/projects/page_proj_00/sync", json=target.model_dump())
    assert sync_resp.status_code == 200
    assert sync_resp.json()["config"]["title"] == "Updated Title"

    undo_resp = client.post("/api/projects/page_proj_00/undo")
    assert undo_resp.status_code == 200
    assert undo_resp.json()["config"]["title"] == "Beat Idea 00"
