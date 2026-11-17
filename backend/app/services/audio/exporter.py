"""Audio mastering limiter (<= -1.0 dBFS) and WAV/MP3/Stems/MIDI/.aimusic exporters."""

from __future__ import annotations

import io
import json
import shutil
import zipfile
from datetime import datetime, timezone
from typing import Optional

import mido
import numpy as np
import soundfile as sf

from app.core.config import settings
from app.core.redis_store import RedisStore
from app.core.schemas import ProjectState

try:
    from pedalboard import Limiter, Pedalboard  # type: ignore
except ImportError:  # pragma: no cover
    Limiter = None  # type: ignore
    Pedalboard = None  # type: ignore

try:
    from pydub import AudioSegment  # type: ignore
except ImportError:  # pragma: no cover
    AudioSegment = None  # type: ignore


def peak_dbfs(audio: np.ndarray) -> float:
    """Compute peak sample level in dBFS."""
    if audio.size == 0:
        return -120.0
    peak = float(np.max(np.abs(audio)))
    if peak <= 1e-12:
        return -120.0
    return 20.0 * float(np.log10(peak))


def apply_master_limiter(
    audio: np.ndarray,
    sample_rate: int = 44100,
    ceiling_db: float = -1.0,
    target_lufs: float = -14.0,
) -> np.ndarray:
    """Apply gentle loudness leveling and strict Master Limiter (<= -1.0 dBFS)."""
    if audio.size == 0:
        return audio.astype(np.float32)

    safe_ceiling_db = min(float(ceiling_db), -1.0)
    ceiling_linear = float(10.0 ** (safe_ceiling_db / 20.0))

    x = audio.astype(np.float32, copy=True)

    # Gentle RMS-based gain leveling toward target_lufs (approximated by RMS dBFS)
    rms = float(np.sqrt(np.mean(x**2)))
    if rms > 1e-5:
        rms_db = 20.0 * float(np.log10(rms))
        desired_gain_db = float(np.clip(target_lufs - rms_db, -12.0, 12.0))
        x = x * float(10.0 ** (desired_gain_db / 20.0))

    # Optional Spotify Pedalboard brickwall limiter
    if Pedalboard is not None and Limiter is not None:
        try:
            board = Pedalboard([Limiter(threshold_db=safe_ceiling_db, release_ms=100.0)])
            if x.ndim == 1:
                x = board(x, sample_rate)
            else:
                # Pedalboard expects (channels, samples)
                x = board(x.T, sample_rate).T
        except Exception:
            pass

    # Soft-knee saturation + strict mathematical ceiling clamp (<= -1.0 dBFS)
    peak = float(np.max(np.abs(x)))
    if peak > ceiling_linear:
        # Smooth soft-clip above 0.75 * ceiling, then hard cap at 0.995 * ceiling_linear
        drive = x / ceiling_linear
        x = np.tanh(drive) * ceiling_linear

    hard_cap = ceiling_linear * 0.995
    x = np.clip(x, -hard_cap, hard_cap).astype(np.float32)
    return x


def export_wav(audio: np.ndarray, sample_rate: int = 44100) -> bytes:
    """Encode stereo or mono float32 audio into 16-bit PCM WAV bytes."""
    buf = io.BytesIO()
    sf.write(buf, np.clip(audio, -1.0, 1.0), sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def export_mp3(audio: np.ndarray, sample_rate: int = 44100, bitrate: str = "192k") -> bytes:
    """Encode float32 audio into MP3 bytes using pydub + ffmpeg."""
    if AudioSegment is None or shutil.which("ffmpeg") is None:
        raise RuntimeError("MP3 export requires pydub and ffmpeg to be installed.")
    wav_bytes = export_wav(audio, sample_rate=sample_rate)
    seg = AudioSegment.from_file(io.BytesIO(wav_bytes), format="wav")
    out = io.BytesIO()
    seg.export(out, format="mp3", bitrate=bitrate)
    return out.getvalue()


def export_stems_zip(stems: dict[str, np.ndarray], sample_rate: int = 44100) -> bytes:
    """Bundle equal-length track WAV stems into an in-memory ZIP archive."""
    if not stems:
        raise ValueError("No stems available for export.")
    lengths = {arr.shape[0] for arr in stems.values()}
    if len(lengths) > 1:
        raise ValueError("All exported stems must have identical sample lengths from t=0.")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, arr in stems.items():
            zf.writestr(f"stems/{name}.wav", export_wav(arr, sample_rate=sample_rate))
    return buf.getvalue()


def _format_mido_key(key: str, scale: str) -> str:
    valid_major = {"C", "G", "D", "A", "E", "B", "F#", "C#", "F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"}
    valid_minor = {"Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m", "Dm", "Gm", "Cm", "Fm", "Bbm", "Ebm", "Abm"}
    k = key.strip()
    if "minor" in scale.lower():
        cand = f"{k}m"
        return cand if cand in valid_minor else "Am"
    return k if k in valid_major else "C"


def export_midi(project: ProjectState) -> bytes:
    """Export multi-track Type 1 MIDI with Tempo, Time Signature, and Key Signature Meta Events."""
    mid = mido.MidiFile(ticks_per_beat=480)
    bpm = float(project.analysis.bpm or 120.0)
    tempo_us = mido.bpm2tempo(bpm)

    num, den = 4, 4
    try:
        parts = project.analysis.time_signature.split("/")
        num, den = int(parts[0]), int(parts[1])
    except Exception:
        pass

    meta_track = mido.MidiTrack()
    meta_track.append(mido.MetaMessage("track_name", name="Tempo & Meta", time=0))
    meta_track.append(mido.MetaMessage("set_tempo", tempo=tempo_us, time=0))
    meta_track.append(mido.MetaMessage("time_signature", numerator=num, denominator=den, time=0))
    meta_track.append(
        mido.MetaMessage(
            "key_signature",
            key=_format_mido_key(project.analysis.detected_key, project.analysis.detected_scale),
            time=0,
        )
    )
    meta_track.append(mido.MetaMessage("end_of_track", time=0))
    mid.tracks.append(meta_track)

    channel_map = {"drums": 9, "bass": 1, "harmony": 2, "lead": 3}

    for track_name, track in project.tracks.items():
        if track.type != "midi" and track_name != "vocal":
            continue
        notes = track.notes if track.type == "midi" else project.analysis.raw_melody_midi
        if not notes:
            continue

        ch = channel_map.get(track_name, 0)
        events: list[tuple[int, int, mido.Message]] = []
        for n in notes:
            start_tick = max(0, int(round(n.start_beat * mid.ticks_per_beat)))
            dur_tick = max(1, int(round(n.duration * mid.ticks_per_beat)))
            vel = int(np.clip(n.velocity, 1, 127))
            pitch = int(np.clip(n.pitch, 0, 127))
            events.append((start_tick, 1, mido.Message("note_on", channel=ch, note=pitch, velocity=vel, time=0)))
            events.append((start_tick + dur_tick, 0, mido.Message("note_off", channel=ch, note=pitch, velocity=0, time=0)))

        events.sort(key=lambda item: (item[0], item[1]))
        midi_track = mido.MidiTrack()
        midi_track.append(mido.MetaMessage("track_name", name=track_name, time=0))
        prev_tick = 0
        for abs_tick, _, msg in events:
            delta = max(0, abs_tick - prev_tick)
            midi_track.append(msg.copy(time=delta))
            prev_tick = abs_tick
        midi_track.append(mido.MetaMessage("end_of_track", time=0))
        mid.tracks.append(midi_track)

    buf = io.BytesIO()
    mid.save(file=buf)
    return buf.getvalue()


def export_aimusic_bundle(project: ProjectState, store: RedisStore) -> bytes:
    """Package ProjectState + referenced vocal audio assets into a lightweight .aimusic ZIP."""
    buf = io.BytesIO()
    manifest = {
        "schema_version": "1.0",
        "app": "ai-music-studio",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
        zf.writestr("project.json", project.model_dump_json(indent=2))

        asset_refs = {
            "raw_input.wav": project.audio_assets.raw_input_ref,
            "dry_denoised.wav": project.audio_assets.dry_denoised_ref,
            "vocal_autotuned.wav": project.audio_assets.tuned_vocal_ref,
        }
        for arc_name, ref in asset_refs.items():
            if ref:
                data = store.get_audio_bytes(ref)
                if data:
                    zf.writestr(f"audio/{arc_name}", data)
    return buf.getvalue()


def import_aimusic_bundle(bundle_bytes: bytes, store: RedisStore) -> ProjectState:
    """Unpack a .aimusic ZIP container and restore ProjectState + audio bytes into store."""
    with zipfile.ZipFile(io.BytesIO(bundle_bytes), "r") as zf:
        names = set(zf.namelist())
        if "project.json" not in names:
            raise ValueError("Invalid .aimusic archive: missing project.json")

        project = ProjectState.model_validate_json(zf.read("project.json").decode("utf-8"))
        pid = project.project_id

        audio_mapping = [
            ("audio/raw_input.wav", "raw_input_ref", f"mem://raw/{pid}.wav"),
            ("audio/dry_denoised.wav", "dry_denoised_ref", f"mem://processed/{pid}_dry.wav"),
            ("audio/vocal_autotuned.wav", "tuned_vocal_ref", f"mem://processed/{pid}_tuned.wav"),
        ]
        for arc_path, field_name, ref in audio_mapping:
            if arc_path in names:
                store.save_audio_bytes(ref, zf.read(arc_path))
                setattr(project.audio_assets, field_name, ref)

    return store.save_project(project)
