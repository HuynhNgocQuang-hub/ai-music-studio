"""Unit and FastAPI endpoint tests for the slim Audio DSP Worker."""

from __future__ import annotations

import base64
import io
import json
import sys
import zipfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

WORKER_DIR = Path(__file__).resolve().parents[1]
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

from app.main import app
from app.services.autotune import apply_preset, key_to_pitch_class, nearest_scale_midi
from app.services.denoise import decode_wav_bytes, encode_wav_bytes
from app.services.exporter import apply_master_limiter, peak_dbfs


def _make_melody_wav(duration_sec: float = 4.0, sr: int = 44100, add_noise: bool = True) -> bytes:
    """Generate a C-major melody WAV (C4-E4-G4-C5)."""
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


def test_health(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "audio-worker"
    assert "engines" in body


def test_denoise_analyze_autotune_pipeline(client: TestClient) -> None:
    wav_bytes = _make_melody_wav(duration_sec=4.0, add_noise=True)

    # 1. Denoise
    dn = client.post(
        "/internal/audio/denoise",
        files={"file": ("hum.wav", wav_bytes, "audio/wav")},
        data={"enable_denoise": "true", "auto_trim": "true", "validate_upload": "true"},
    )
    assert dn.status_code == 200
    dn_data = dn.json()
    dry_bytes = base64.b64decode(dn_data["wav_base64"])
    dry_samples, dry_sr = decode_wav_bytes(dry_bytes)
    assert dry_sr == 44100
    assert dn_data["duration_sec"] >= 1.0

    # 2. Analyze
    an = client.post(
        "/internal/audio/analyze",
        files={"file": ("dry.wav", dry_bytes, "audio/wav")},
        data={"bpm_override": "120.0"},
    )
    assert an.status_code == 200
    an_data = an.json()
    assert an_data["bpm"] == 120.0
    assert an_data["bars"] >= 1
    assert len(an_data["raw_melody_midi"]) >= 1

    # 3. Auto-Tune Presets
    for preset in ("off", "natural", "balanced", "modern"):
        settings = apply_preset(preset, key="C", scale="major")
        at = client.post(
            "/internal/audio/autotune",
            files={"file": ("dry.wav", dry_bytes, "audio/wav")},
            data={"settings_json": json.dumps(settings.model_dump())},
        )
        assert at.status_code == 200
        tuned_bytes = base64.b64decode(at.json()["wav_base64"])
        tuned_samples, _ = decode_wav_bytes(tuned_bytes)
        assert len(tuned_samples) == len(dry_samples)


def test_autotune_enharmonic_keys() -> None:
    assert key_to_pitch_class("Eb") == 3
    assert key_to_pitch_class("Bb") == 10
    assert nearest_scale_midi(63.1, "Eb", "major") == 63.0
    assert nearest_scale_midi(70.2, "Bb", "major") == 70.0


def test_master_limiter_ceiling() -> None:
    sr = 44100
    t = np.linspace(0, 1.0, sr, endpoint=False, dtype=np.float32)
    hot = np.stack([2.5 * np.sin(2 * np.pi * 220 * t), 2.5 * np.sin(2 * np.pi * 440 * t)], axis=1)
    limited = apply_master_limiter(hot, sample_rate=sr, ceiling_db=-1.0, target_lufs=-14.0)
    assert peak_dbfs(limited) <= -1.0


def test_render_and_export_endpoints(client: TestClient) -> None:
    vocal_wav = _make_melody_wav(duration_sec=2.0, add_noise=False)
    vocal_b64 = base64.b64encode(vocal_wav).decode("ascii")

    project_payload = {
        "project_id": "proj_worker_test",
        "audio_assets": {"dry_denoised_ref": "mem://processed/proj_worker_test_dry.wav"},
        "analysis": {"bpm": 120.0, "time_signature": "4/4", "detected_key": "C", "detected_scale": "major", "bars": 2},
        "song_structure": {"total_bars": 2},
        "mastering": {"auto_mix_enabled": True, "limiter_ceiling_db": -1.0, "target_lufs": -14.0},
        "tracks": {
            "vocal": {"type": "audio", "volume": 1.1, "pan": 0.0, "clips": [{"id": "c1", "source": "dry_denoised_ref", "start_bar": 1.0}]},
            "drums": {
                "type": "midi",
                "instrument": "acoustic_kit",
                "volume": 1.2,
                "pan": 0.0,
                "notes": [
                    {"pitch": 36, "start_beat": 0.0, "duration": 0.5, "velocity": 120},
                    {"pitch": 38, "start_beat": 1.0, "duration": 0.5, "velocity": 115},
                ],
            },
            "bass": {
                "type": "midi",
                "instrument": "finger_bass",
                "volume": 1.2,
                "pan": 0.0,
                "notes": [{"pitch": 36, "start_beat": 0.0, "duration": 2.0, "velocity": 120}],
            },
        },
    }
    assets_map = {"mem://processed/proj_worker_test_dry.wav": vocal_b64}

    render_resp = client.post(
        "/internal/audio/render",
        json={"project": project_payload, "audio_assets_base64": assets_map, "mode": "ai_mix", "apply_mastering": True},
    )
    assert render_resp.status_code == 200
    assert render_resp.content[:4] == b"RIFF"
    arr, sr = sf.read(io.BytesIO(render_resp.content), dtype="float32")
    assert sr == 44100
    assert peak_dbfs(arr) <= -1.0

    wav_export = client.post(
        "/internal/audio/export",
        json={"project": project_payload, "audio_assets_base64": assets_map, "format": "wav", "apply_mastering": True},
    )
    assert wav_export.status_code == 200
    assert wav_export.content[:4] == b"RIFF"

    stems_export = client.post(
        "/internal/audio/export",
        json={"project": project_payload, "audio_assets_base64": assets_map, "format": "stems", "apply_mastering": True},
    )
    assert stems_export.status_code == 200
    with zipfile.ZipFile(io.BytesIO(stems_export.content), "r") as zf:
        names = zf.namelist()
        assert "stems/vocal.wav" in names
        assert "stems/drums.wav" in names
        assert "stems/bass.wav" in names


def test_overdub_fit_check(client: TestClient) -> None:
    wav_bytes = _make_melody_wav(duration_sec=3.0, add_noise=False)
    resp = client.post(
        "/internal/audio/overdub-fit-check",
        files={"file": ("overdub.wav", wav_bytes, "audio/wav")},
        data={"bpm": "120.0", "key": "C", "scale": "major"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "timing_offset_ms" in body
    assert "pitch_issues" in body
    assert "gain_suggestion" in body
    assert "one_click_fixes" in body
