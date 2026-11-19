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
from app.schemas import AnalysisResult, AudioAssets, ProjectState, SongStructure, TrackState
from app.services.autotune import apply_preset, key_to_pitch_class, nearest_scale_midi
from app.services.denoise import decode_wav_bytes, encode_wav_bytes
from app.services.exporter import apply_master_limiter, peak_dbfs
from app.services.renderer import render_project_mix


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


def test_overdub_fit_check_real_cents_off(client: TestClient) -> None:
    """Out-of-scale notes report real 100 * |midi_float - nearest_scale_midi| instead of hardcoded 50.0."""
    sr = 44100
    dur_sec = 2.0
    n_total = int(dur_sec * sr)
    t = np.arange(n_total, dtype=np.float32) / sr
    y = np.zeros(n_total, dtype=np.float32)
    half = n_total // 2
    # First half: C4 (261.63 Hz, MIDI 60.0, in C major)
    y[:half] = 0.45 * np.sin(2.0 * np.pi * 261.63 * t[:half])
    # Second half: 282.0 Hz (~MIDI 61.30, rounds to C#4=61, ~70 cents below D4=62 in C major)
    y[half:] = 0.45 * np.sin(2.0 * np.pi * 282.0 * t[half:])
    wav_bytes = encode_wav_bytes(y, sr)

    resp = client.post(
        "/internal/audio/overdub-fit-check",
        files={"file": ("offkey.wav", wav_bytes, "audio/wav")},
        data={"bpm": "120.0", "key": "C", "scale": "major"},
    )
    assert resp.status_code == 200
    issues = resp.json()["pitch_issues"]
    assert len(issues) >= 1
    cents = issues[0]["cents_off"]
    assert cents != 50.0
    assert 60.0 <= cents <= 80.0


def test_render_mode_differentiation(client: TestClient) -> None:
    """POST /internal/audio/render produces distinct WAV previews across all supported modes."""
    sr = 44100
    dur_sec = 2.0
    n_total = int(dur_sec * sr)
    t = np.arange(n_total, dtype=np.float32) / sr
    rng = np.random.default_rng(7)

    raw_samples = 0.35 * np.sin(2.0 * np.pi * 261.63 * t) + 0.05 * rng.standard_normal(n_total).astype(np.float32)
    dry_samples = 0.35 * np.sin(2.0 * np.pi * 261.63 * t)
    tuned_samples = 0.35 * np.sin(2.0 * np.pi * 329.63 * t)

    raw_b64 = base64.b64encode(encode_wav_bytes(raw_samples, sr)).decode("ascii")
    dry_b64 = base64.b64encode(encode_wav_bytes(dry_samples, sr)).decode("ascii")
    tuned_b64 = base64.b64encode(encode_wav_bytes(tuned_samples, sr)).decode("ascii")

    project_payload = {
        "project_id": "proj_mode_test",
        "audio_assets": {
            "raw_input_ref": "mem://raw/test.wav",
            "dry_denoised_ref": "mem://dry/test.wav",
            "tuned_vocal_ref": "mem://tuned/test.wav",
        },
        "analysis": {"bpm": 120.0, "time_signature": "4/4", "detected_key": "C", "detected_scale": "major", "bars": 2},
        "song_structure": {"total_bars": 2},
        "mastering": {"auto_mix_enabled": True, "limiter_ceiling_db": -1.0, "target_lufs": -14.0},
        "tracks": {
            "vocal": {"type": "audio", "volume": 0.9, "pan": 0.0, "clips": [{"id": "c1", "source": "dry_denoised_ref", "start_bar": 1.0}]},
            "drums": {
                "type": "midi",
                "instrument": "acoustic_kit",
                "volume": 0.9,
                "pan": 0.0,
                "notes": [{"pitch": 36, "start_beat": 0.0, "duration": 0.5, "velocity": 115}],
            },
            "lead": {
                "type": "midi",
                "instrument": "lead_synth",
                "volume": 0.8,
                "pan": 0.0,
                "notes": [{"pitch": 64, "start_beat": 0.0, "duration": 1.0, "velocity": 100}],
            },
        },
    }
    assets_map = {
        "mem://raw/test.wav": raw_b64,
        "mem://dry/test.wav": dry_b64,
        "mem://tuned/test.wav": tuned_b64,
    }

    modes = ["raw", "dry", "dry_beat", "autotune", "preserve", "enhance", "ai_mix", "mix"]
    rendered: dict[str, np.ndarray] = {}
    for mode in modes:
        resp = client.post(
            "/internal/audio/render",
            json={"project": project_payload, "audio_assets_base64": assets_map, "mode": mode, "apply_mastering": True},
        )
        assert resp.status_code == 200, f"mode={mode} failed: {resp.text}"
        assert resp.content[:4] == b"RIFF"
        arr, out_sr = sf.read(io.BytesIO(resp.content), dtype="float32")
        assert out_sr == sr
        assert peak_dbfs(arr) <= -1.0
        rendered[mode] = arr

    assert np.allclose(rendered["ai_mix"], rendered["mix"], atol=1e-6)

    distinct_modes = ["raw", "dry", "dry_beat", "autotune", "preserve", "enhance", "ai_mix"]
    for i, m1 in enumerate(distinct_modes):
        for m2 in distinct_modes[i + 1 :]:
            diff = float(np.max(np.abs(rendered[m1] - rendered[m2])))
            assert diff > 1e-3, f"Expected distinct previews for {m1} vs {m2}, got max diff {diff}"


def test_empty_non_vocal_audio_track_is_silent() -> None:
    """Empty non-vocal audio tracks (e.g. texture) produce silence while empty vocal falls back cleanly."""
    vocal_wav = _make_melody_wav(duration_sec=1.0, add_noise=False)
    project = ProjectState(
        project_id="proj_empty_texture_test",
        audio_assets=AudioAssets(
            raw_input_ref="mem://raw/test.wav",
            dry_denoised_ref="mem://dry/test.wav",
        ),
        analysis=AnalysisResult(bpm=120.0, time_signature="4/4", bars=1),
        song_structure=SongStructure(total_bars=1),
        tracks={
            "vocal": TrackState(type="audio", volume=1.0, pan=0.0, clips=[]),
            "texture": TrackState(type="audio", volume=1.0, pan=0.0, clips=[]),
        },
    )
    assets = {
        "mem://raw/test.wav": vocal_wav,
        "mem://dry/test.wav": vocal_wav,
    }

    mix, stems, sr = render_project_mix(project, audio_assets=assets, mode="ai_mix", apply_mastering=False)
    assert sr == 44100
    assert np.max(np.abs(stems["texture"])) == 0.0
    assert np.max(np.abs(stems["vocal"])) > 0.01
    assert np.allclose(mix, stems["vocal"])
