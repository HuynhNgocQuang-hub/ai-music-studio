"""Unit and FastAPI endpoint tests for the slim Audio DSP Worker."""

from __future__ import annotations

import base64
import io
import json
import sys
import zipfile
from pathlib import Path

import mido
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

WORKER_DIR = Path(__file__).resolve().parents[1]
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

from app.main import app
from app.schemas import (
    AnalysisResult,
    AudioAssets,
    AudioClip,
    AutotuneSettings,
    MidiNote,
    ProjectState,
    SongStructure,
    TrackState,
)
from app.services.autotune import apply_preset, key_to_pitch_class, nearest_scale_midi
from app.services.denoise import decode_wav_bytes, encode_wav_bytes
from app.services.exporter import _format_mido_key, apply_master_limiter, export_midi, peak_dbfs
from app.services.renderer import INSTRUMENT_PROGRAMS, _vocal_ref_candidates, render_project_mix


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
        "autotune_settings": {"enabled": True, "preset": "balanced"},
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


def test_autotune_disabled_ignores_tuned_vocal_ref() -> None:
    """When autotune_settings.enabled is False, ai_mix/preserve/enhance/autotune prefer dry -> raw over tuned."""
    sr = 44100
    t = np.arange(sr, dtype=np.float32) / sr
    raw_wav = encode_wav_bytes(0.20 * np.sin(2.0 * np.pi * 220.0 * t), sr)
    dry_wav = encode_wav_bytes(0.35 * np.sin(2.0 * np.pi * 261.63 * t), sr)
    tuned_wav = encode_wav_bytes(0.40 * np.sin(2.0 * np.pi * 523.25 * t), sr)

    project = ProjectState(
        project_id="proj_autotune_disabled",
        audio_assets=AudioAssets(
            raw_input_ref="mem://raw/test.wav",
            dry_denoised_ref="mem://dry/test.wav",
            tuned_vocal_ref="mem://tuned/test.wav",
        ),
        analysis=AnalysisResult(bpm=120.0, time_signature="4/4", bars=1),
        autotune_settings=AutotuneSettings(enabled=False, preset="off"),
        song_structure=SongStructure(total_bars=1),
        tracks={
            "vocal": TrackState(
                type="audio",
                volume=1.0,
                pan=0.0,
                clips=[AudioClip(id="v1", source="tuned_vocal_ref", start_bar=1.0, fade_in_ms=0.0, fade_out_ms=0.0)],
            ),
        },
    )

    for mode in ("ai_mix", "preserve", "enhance", "autotune"):
        candidates = _vocal_ref_candidates(project, mode)
        assert [slot for _, slot in candidates] == ["dry_denoised_ref", "raw_input_ref"]

    assets_all = {
        "mem://raw/test.wav": raw_wav,
        "mem://dry/test.wav": dry_wav,
        "mem://tuned/test.wav": tuned_wav,
    }
    _, dry_stems, _ = render_project_mix(project, audio_assets=assets_all, mode="dry", apply_mastering=False)
    for mode in ("ai_mix", "enhance", "autotune"):
        _, mode_stems, _ = render_project_mix(project, audio_assets=assets_all, mode=mode, apply_mastering=False)
        assert np.allclose(mode_stems["vocal"], dry_stems["vocal"], atol=1e-5), f"mode={mode} used tuned_vocal_ref"

    # Preserve applies 1.05 audio mode_gain, still sourcing dry_denoised_ref instead of tuned_vocal_ref
    _, preserve_stems, _ = render_project_mix(project, audio_assets=assets_all, mode="preserve", apply_mastering=False)
    assert np.allclose(preserve_stems["vocal"], dry_stems["vocal"] * 1.05, atol=1e-5)

    # Without dry_denoised_ref, falls back to raw_input_ref rather than tuned_vocal_ref
    assets_no_dry = {"mem://raw/test.wav": raw_wav, "mem://tuned/test.wav": tuned_wav}
    _, raw_only_stems, _ = render_project_mix(project, audio_assets=assets_no_dry, mode="raw", apply_mastering=False)
    _, fallback_stems, _ = render_project_mix(project, audio_assets=assets_no_dry, mode="ai_mix", apply_mastering=False)
    assert np.allclose(fallback_stems["vocal"], raw_only_stems["vocal"], atol=1e-5)


def test_sharp_key_midi_export() -> None:
    """Sharp keys (C#, D#, F#, G#, A# major/minor) map to valid mido key_signature spellings."""
    expected_major = {"C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb"}
    for key, expected in expected_major.items():
        formatted = _format_mido_key(key, "major")
        assert formatted == expected
        msg = mido.MetaMessage("key_signature", key=formatted, time=0)
        assert msg.key == expected

    for key, expected in (("C#", "C#m"), ("D#", "D#m"), ("F#", "F#m"), ("G#", "G#m"), ("A#", "A#m"), ("Db", "C#m"), ("Gb", "F#m")):
        formatted = _format_mido_key(key, "minor")
        assert formatted == expected
        msg = mido.MetaMessage("key_signature", key=formatted, time=0)
        assert msg.key == expected

    project = ProjectState(
        project_id="proj_sharp_midi",
        analysis=AnalysisResult(bpm=120.0, time_signature="4/4", detected_key="D#", detected_scale="major", bars=1),
        song_structure=SongStructure(total_bars=1),
        tracks={
            "harmony": TrackState(
                type="midi",
                instrument="grand_piano",
                notes=[MidiNote(pitch=63, start_beat=0.0, duration=1.0, velocity=100)],
            ),
        },
    )
    midi_bytes = export_midi(project)
    mid = mido.MidiFile(file=io.BytesIO(midi_bytes))
    ks_msgs = [msg for tr in mid.tracks for msg in tr if msg.type == "key_signature"]
    assert len(ks_msgs) == 1
    assert ks_msgs[0].key == "Eb"


def test_missing_custom_clip_is_silent_and_resamples_and_mutes_preserve_lead() -> None:
    """Missing mem://clips or idb:// clips are skipped (silent), clips resample to target sr, and preserve mutes lead."""
    sr = 44100
    vocal_wav = _make_melody_wav(duration_sec=1.0, sr=sr, add_noise=False)
    clip_16k_wav = _make_melody_wav(duration_sec=1.0, sr=16000, add_noise=False)

    project = ProjectState(
        project_id="proj_missing_custom_clip",
        audio_assets=AudioAssets(
            raw_input_ref="mem://raw/test.wav",
            dry_denoised_ref="mem://dry/test.wav",
        ),
        analysis=AnalysisResult(bpm=120.0, time_signature="4/4", bars=1),
        song_structure=SongStructure(total_bars=1),
        tracks={
            "vocal": TrackState(
                type="audio",
                volume=1.0,
                pan=0.0,
                clips=[AudioClip(id="ov1", source="idb://overdub/missing", start_bar=1.0)],
            ),
            "texture": TrackState(
                type="audio",
                volume=1.0,
                pan=0.0,
                clips=[AudioClip(id="tx1", source="mem://clips/missing_clip.wav", start_bar=1.0)],
            ),
            "lead": TrackState(
                type="midi",
                instrument="synth_lead",
                volume=0.9,
                pan=0.0,
                notes=[MidiNote(pitch=64, start_beat=0.0, duration=1.0, velocity=110)],
            ),
        },
    )
    assets = {"mem://raw/test.wav": vocal_wav, "mem://dry/test.wav": vocal_wav}

    mix, stems, out_sr = render_project_mix(project, audio_assets=assets, mode="preserve", apply_mastering=False)
    assert out_sr == sr
    assert np.max(np.abs(stems["vocal"])) == 0.0
    assert np.max(np.abs(stems["texture"])) == 0.0
    assert np.max(np.abs(stems["lead"])) == 0.0
    assert np.max(np.abs(mix)) == 0.0

    # Verify clip WAV at 16kHz is resampled cleanly to target 44.1kHz
    project.tracks["texture"].clips = [
        AudioClip(id="tx16k", source="mem://clips/clip_16k.wav", start_bar=1.0, fade_in_ms=0.0, fade_out_ms=0.0)
    ]
    assets["mem://clips/clip_16k.wav"] = clip_16k_wav
    _, resamp_stems, _ = render_project_mix(project, audio_assets=assets, mode="ai_mix", apply_mastering=False)
    assert resamp_stems["texture"].shape == (2 * sr, 2)
    assert np.max(np.abs(resamp_stems["texture"])) > 0.05


def test_expanded_instrument_programs() -> None:
    """All Studio and Arranger instrument IDs map to valid GM program numbers (0..127)."""
    expected_ids = {
        "grand_piano",
        "electric_piano",
        "acoustic_guitar",
        "finger_bass",
        "synth_bass",
        "strings",
        "synth_pad",
        "lead_synth",
        "synth_lead",
        "warm_pad",
        "upright_bass",
        "electronic_808",
        "lofi_kit",
        "brush_kit",
        "fretless_bass",
        "rhodes_ep",
        "muted_guitar",
        "rnb_kit",
        "808_kit",
        "808_bass",
        "dark_pad",
        "pluck_synth",
        "electronic_kit",
        "saw_bass",
        "supersaw_pad",
        "bright_lead",
        "cajon_kit",
        "rock_kit",
        "pick_bass",
        "overdrive_guitar",
        "lead_guitar",
        "string_ensemble",
        "flute",
        "warm_sub_bass",
        "acoustic_kit",
    }
    missing = expected_ids - set(INSTRUMENT_PROGRAMS.keys())
    assert not missing, f"Missing instrument mappings: {missing}"
    for inst_id, prog in INSTRUMENT_PROGRAMS.items():
        assert isinstance(prog, int) and 0 <= prog <= 127, f"Invalid GM program for {inst_id}: {prog}"


def test_track_eq_and_send_fx_render() -> None:
    """3-Band EQ persists in TrackState and Reverb/Delay Send FX render cleanly under -1.0 dBFS ceiling."""
    sr = 44100
    notes = [MidiNote(pitch=69, start_beat=0.0, duration=1.0, velocity=115)]

    base_project = ProjectState(
        project_id="test_eq_fx",
        analysis={"bpm": 120.0, "time_signature": "4/4", "bars": 2},
        song_structure={"total_bars": 2},
        tracks={
            "lead": TrackState(
                type="midi",
                instrument="synth_lead",
                volume=0.9,
                pan=0.0,
                notes=notes,
            )
        },
    )
    dry_mix, dry_stems, _ = render_project_mix(base_project, mode="ai_mix", apply_mastering=False, sample_rate=sr)

    fx_project = ProjectState(
        project_id="test_eq_fx",
        analysis={"bpm": 120.0, "time_signature": "4/4", "bars": 2},
        song_structure={"total_bars": 2},
        tracks={
            "lead": TrackState(
                type="midi",
                instrument="synth_lead",
                volume=0.9,
                pan=0.0,
                low_db=8.0,
                mid_db=-3.0,
                high_db=7.0,
                reverb_send=0.8,
                delay_send=0.6,
                notes=notes,
            )
        },
    )
    fx_mix, fx_stems, out_sr = render_project_mix(fx_project, mode="ai_mix", apply_mastering=True, sample_rate=sr)
    assert out_sr == sr
    assert fx_mix.shape == dry_mix.shape
    assert np.isfinite(fx_mix).all()
    assert not np.allclose(fx_stems["lead"], dry_stems["lead"]), "EQ should alter rendered stem spectrum"
    # Second bar (t >= 1.0s) has dry note silent -> FX send bus must contribute tail energy
    assert float(np.sum(np.abs(fx_mix[int(1.2 * sr) :]))) > 1.0
    assert peak_dbfs(fx_mix) <= -1.0 + 1e-4


def test_formant_preserving_autotune_and_6_8_vocal_carve(client: TestClient) -> None:
    """Formant preservation keeps spectral envelope closer to original when shifting +4 semitones; 6/8 & 320k work."""
    from app.services.autotune import _pitch_shift_frame_ola, apply_autotune

    sr = 44100
    dur = 1.6
    n = int(dur * sr)
    t = np.arange(n, dtype=np.float32) / sr
    # Synthetic vocal-like glottal pulse train with formant peak around 650 Hz (F1) and 1700 Hz (F2)
    f0 = 200.0
    voice = np.zeros(n, dtype=np.float32)
    for k in range(1, 14):
        fk = k * f0
        gain = 0.6 * np.exp(-((fk - 650.0) / 180.0) ** 2) + 0.45 * np.exp(-((fk - 1700.0) / 260.0) ** 2) + 0.06
        voice += float(gain) * np.sin(2.0 * np.pi * fk * t)
    voice = (voice / max(1e-5, float(np.max(np.abs(voice)))) * 0.4).astype(np.float32)

    ratio_up = float(2.0 ** (-4.0 / 12.0))  # upward pitch shift +4 semitones (ratio < 1 in source step)
    ratios = np.full(1 + n // 512, ratio_up, dtype=np.float32)
    naive = _pitch_shift_frame_ola(voice, ratios, hop_length=512, win_length=2048, sr=sr, preserve_formant=False)
    preserved = _pitch_shift_frame_ola(voice, ratios, hop_length=512, win_length=2048, sr=sr, preserve_formant=True)

    assert len(preserved) == n
    assert np.isfinite(preserved).all()

    def high_low_ratio(sig: np.ndarray) -> float:
        spec = np.abs(np.fft.rfft(sig * np.hanning(len(sig))))
        freqs = np.fft.rfftfreq(len(sig), 1.0 / sr)
        low_e = float(np.sum(spec[(freqs >= 450) & (freqs <= 900)] ** 2))
        high_e = float(np.sum(spec[(freqs >= 1400) & (freqs <= 2600)] ** 2))
        return high_e / max(low_e, 1e-9)

    orig_ratio = high_low_ratio(voice)
    err_preserved = abs(high_low_ratio(preserved) - orig_ratio)
    err_naive = abs(high_low_ratio(naive) - orig_ratio)
    assert err_preserved < err_naive, f"Expected formant preservation to track original envelope ({err_preserved:.3f} vs {err_naive:.3f})"

    tuned_bytes, _, out_sr = apply_autotune(encode_wav_bytes(voice, sr), apply_preset("modern", "C", "major"))
    assert out_sr == sr
    tuned_samples, _ = decode_wav_bytes(tuned_bytes)
    assert len(tuned_samples) == n

    # 6/8 render length & MP3 320k/192k export test
    vocal_b64 = base64.b64encode(encode_wav_bytes(voice, sr)).decode("ascii")
    proj_68 = {
        "project_id": "proj_68_worker",
        "audio_assets": {"dry_denoised_ref": "mem://dry/68.wav"},
        "analysis": {"bpm": 120.0, "time_signature": "6/8", "bars": 1},
        "song_structure": {"total_bars": 1},
        "mastering": {"auto_mix_enabled": True, "limiter_ceiling_db": -1.0, "target_lufs": -14.0},
        "tracks": {
            "vocal": {"type": "audio", "volume": 0.9, "pan": 0.0, "clips": [{"id": "v1", "source": "dry_denoised_ref", "start_bar": 1.0}]},
            "harmony": {"type": "midi", "instrument": "grand_piano", "volume": 0.8, "pan": 0.0, "notes": [{"pitch": 60, "start_beat": 0.0, "duration": 3.0, "velocity": 100}]},
        },
    }
    assets_68 = {"mem://dry/68.wav": vocal_b64}
    r_68 = client.post("/internal/audio/render", json={"project": proj_68, "audio_assets_base64": assets_68, "mode": "ai_mix", "apply_mastering": True})
    assert r_68.status_code == 200
    arr_68, sr_68 = sf.read(io.BytesIO(r_68.content), dtype="float32")
    assert len(arr_68) == int(round(6.0 * (60.0 / 120.0) * sr_68))
    assert peak_dbfs(arr_68) <= -1.0

    for br in ("320k", "192k"):
        mp3_resp = client.post(
            "/internal/audio/export",
            json={"project": proj_68, "audio_assets_base64": assets_68, "format": "mp3", "bitrate": br, "apply_mastering": True},
        )
        assert mp3_resp.status_code in (200, 503)
        if mp3_resp.status_code == 200:
            assert len(mp3_resp.content) > 512


def test_worker_dos_clamps_and_render_bounds(client: TestClient) -> None:
    """Verify render_project_mix rejects extreme total_bars with 400, clamps bpm >= 40, and rejects zero-byte uploads."""
    bad_up = client.post(
        "/internal/audio/denoise",
        files={"file": ("empty.wav", b"", "audio/wav")},
    )
    assert bad_up.status_code == 400

    excessive_proj = {
        "project_id": "proj_dos_excessive",
        "analysis": {"bpm": 120.0, "time_signature": "4/4", "bars": 2},
        "song_structure": {"total_bars": 99999},
        "mastering": {"auto_mix_enabled": True, "limiter_ceiling_db": -1.0},
        "tracks": {
            "lead": {
                "type": "midi",
                "instrument": "grand_piano",
                "volume": 0.8,
                "notes": [{"pitch": 60, "start_beat": 0.0, "duration": 1.0, "velocity": 80}],
            }
        },
    }
    with pytest.raises(ValueError, match="256 bars"):
        render_project_mix(ProjectState.model_validate(excessive_proj))

    bad_render = client.post("/internal/audio/render", json={"project": excessive_proj, "mode": "ai_mix"})
    assert bad_render.status_code == 400

    bad_bpm_render = client.post(
        "/internal/audio/render",
        json={
            "project": {
                **excessive_proj,
                "analysis": {"bpm": 5.0, "time_signature": "4/4", "bars": 2},
                "song_structure": {"total_bars": 2},
            },
            "mode": "ai_mix",
        },
    )
    assert bad_bpm_render.status_code == 422

    base_valid = ProjectState.model_validate({
        **excessive_proj,
        "project_id": "proj_dos_bpm_clamp",
        "analysis": {"bpm": 120.0, "time_signature": "4/4", "bars": 2},
        "song_structure": {"total_bars": 2},
    })
    unvalidated_low_bpm = base_valid.model_copy(
        update={"analysis": base_valid.analysis.model_copy(update={"bpm": 5.0})}
    )
    mix, stems, sr = render_project_mix(
        unvalidated_low_bpm,
        mode="ai_mix",
        apply_mastering=True,
        sample_rate=44100,
    )
    assert sr == 44100
    assert len(mix) == int(round(2 * 4 * (60.0 / 40.0) * 44100))
    assert "lead" in stems and len(stems["lead"]) == len(mix)
    assert peak_dbfs(mix) <= -1.0 + 1e-4


def test_stem_separation_and_custom_soundfont_validation(client: TestClient) -> None:
    """Verify /internal/audio/separate-stems returns 2 balanced stems and /soundfont validates .sf2 containers."""
    sr = 44100
    t = np.arange(int(1.6 * sr), dtype=np.float32) / sr
    mix_sig = 0.45 * np.sin(2.0 * np.pi * 440.0 * t) + 0.25 * np.sin(2.0 * np.pi * 90.0 * t)
    mix_wav = encode_wav_bytes(mix_sig, sr)

    sep = client.post(
        "/internal/audio/separate-stems",
        files={"file": ("song.wav", mix_wav, "audio/wav")},
    )
    assert sep.status_code == 200, sep.text
    data = sep.json()
    assert "vocal_wav_base64" in data and "instrumental_wav_base64" in data
    v_bytes = base64.b64decode(data["vocal_wav_base64"])
    b_bytes = base64.b64decode(data["instrumental_wav_base64"])
    assert v_bytes[:4] == b"RIFF" and b_bytes[:4] == b"RIFF"
    v_samples, _ = decode_wav_bytes(v_bytes)
    b_samples, _ = decode_wav_bytes(b_bytes)
    assert len(v_samples) == len(b_samples)
    assert peak_dbfs(v_samples) <= -1.0 + 1e-3
    assert peak_dbfs(b_samples) <= -1.0 + 1e-3

    # Custom SoundFont validation rejects non-.sf2 & invalid RIFF/sfbk headers
    bad_ext = client.post(
        "/internal/audio/soundfont",
        files={"file": ("not_sf2.txt", b"RIFF" + b"\x00" * 100, "application/octet-stream")},
    )
    assert bad_ext.status_code == 400
    bad_hdr = client.post(
        "/internal/audio/soundfont",
        files={"file": ("fake.sf2", b"NOPE" + b"\x00" * 100, "application/octet-stream")},
    )
    assert bad_hdr.status_code == 400
