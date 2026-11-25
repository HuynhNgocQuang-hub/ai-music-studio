"""Lightweight MIDI-to-Audio renderer (FluidSynth + built-in synth fallback) and multi-track mixer."""

from __future__ import annotations

import math
import os
import shutil
import subprocess
import tempfile
from typing import Optional

import mido
import numpy as np
from scipy.signal import fftconvolve, lfilter

from app.schemas import MidiNote, ProjectState, TrackState
from app.services.denoise import _resample_mono, decode_wav_bytes
from app.services.exporter import apply_master_limiter

SOUNDFONT_PATH = os.getenv("SOUNDFONT_PATH", "/usr/share/sounds/sf2/FluidR3_GM.sf2")
CUSTOM_SOUNDFONT_PATH = os.getenv("CUSTOM_SOUNDFONT_PATH", "/tmp/aimusic_custom.sf2")


def get_effective_soundfont_path() -> str:
    """Return uploaded custom .sf2 SoundFont path when valid, otherwise default GM SoundFont."""
    if CUSTOM_SOUNDFONT_PATH and os.path.exists(CUSTOM_SOUNDFONT_PATH) and os.path.getsize(CUSTOM_SOUNDFONT_PATH) > 1024:
        return CUSTOM_SOUNDFONT_PATH
    return SOUNDFONT_PATH


def has_custom_soundfont() -> bool:
    return bool(CUSTOM_SOUNDFONT_PATH and os.path.exists(CUSTOM_SOUNDFONT_PATH) and os.path.getsize(CUSTOM_SOUNDFONT_PATH) > 1024)


def save_custom_soundfont(sf2_bytes: bytes) -> str:
    """Validate RIFF/sfbk SoundFont bytes and persist atomically to CUSTOM_SOUNDFONT_PATH."""
    if len(sf2_bytes) < 64 or sf2_bytes[:4] != b"RIFF" or sf2_bytes[8:12] != b"sfbk":
        raise ValueError("Invalid SoundFont file (expected RIFF/sfbk .sf2 container).")
    parent = os.path.dirname(CUSTOM_SOUNDFONT_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp_path = f"{CUSTOM_SOUNDFONT_PATH}.tmp"
    with open(tmp_path, "wb") as fh:
        fh.write(sf2_bytes)
    os.replace(tmp_path, CUSTOM_SOUNDFONT_PATH)
    return CUSTOM_SOUNDFONT_PATH

INSTRUMENT_PROGRAMS: dict[str, int] = {
    # Keys & Piano
    "grand_piano": 0,
    "electric_piano": 4,
    "rhodes_ep": 4,
    # Guitars
    "acoustic_guitar": 24,
    "muted_guitar": 28,
    "overdrive_guitar": 29,
    "lead_guitar": 30,
    # Basses
    "upright_bass": 32,
    "finger_bass": 33,
    "pick_bass": 34,
    "fretless_bass": 35,
    "synth_bass": 38,
    "808_bass": 38,
    "warm_sub_bass": 39,
    "saw_bass": 39,
    # Strings & Winds
    "strings": 48,
    "string_ensemble": 48,
    "flute": 73,
    # Synth Leads
    "lead_synth": 80,
    "synth_lead": 80,
    "bright_lead": 81,
    "pluck_synth": 82,
    # Synth Pads
    "synth_pad": 88,
    "warm_pad": 89,
    "supersaw_pad": 90,
    "dark_pad": 95,
    # Drum Kits
    "acoustic_kit": 0,
    "rnb_kit": 0,
    "rock_kit": 16,
    "electronic_kit": 24,
    "lofi_kit": 24,
    "electronic_808": 25,
    "808_kit": 25,
    "cajon_kit": 32,
    "brush_kit": 40,
}


def _midi_to_hz(pitch: int) -> float:
    return 440.0 * (2.0 ** ((pitch - 69) / 12.0))


def _synthesize_drum_hit(pitch: int, dur_samples: int, sr: int, velocity: float) -> np.ndarray:
    """Synthesize lightweight drum percussion hit by GM MIDI drum pitch."""
    n = max(1, min(dur_samples, int(0.45 * sr)))
    t = np.arange(n, dtype=np.float32) / sr
    rng = np.random.default_rng(seed=pitch)

    if pitch in (35, 36):  # Kick
        freq = 135.0 * np.exp(-26.0 * t) + 45.0
        phase = 2.0 * np.pi * np.cumsum(freq) / sr
        env = np.exp(-12.0 * t)
        hit = np.sin(phase) * env * 0.9
    elif pitch in (38, 40, 39):  # Snare / Clap
        body = np.sin(2.0 * np.pi * 185.0 * t) * np.exp(-22.0 * t) * 0.4
        noise = rng.standard_normal(n).astype(np.float32) * np.exp(-16.0 * t) * 0.5
        hit = body + noise
    elif pitch in (42, 44, 46, 49, 51):  # Hi-hats / Cymbals
        decay = 28.0 if pitch in (42, 44) else 8.0
        noise = rng.standard_normal(n).astype(np.float32)
        hp = np.diff(noise, prepend=noise[0])
        hit = hp * np.exp(-decay * t) * 0.35
    else:  # Toms / generic perc
        freq = 160.0 * np.exp(-12.0 * t) + 70.0
        hit = np.sin(2.0 * np.pi * np.cumsum(freq) / sr) * np.exp(-10.0 * t) * 0.55

    return (hit * velocity).astype(np.float32)


def _synthesize_tonal_note(
    pitch: int,
    dur_samples: int,
    sr: int,
    velocity: float,
    track_name: str,
) -> np.ndarray:
    """Synthesize warm polyphonic tonal voice with ADSR envelope."""
    n = max(64, dur_samples)
    t = np.arange(n, dtype=np.float32) / sr
    freq = _midi_to_hz(pitch)

    if track_name == "bass":
        wave = 0.75 * np.sin(2.0 * np.pi * freq * t) + 0.25 * np.sin(2.0 * np.pi * 2.0 * freq * t)
        attack_s = 0.008
        release_s = min(0.08, n / sr * 0.3)
    elif track_name == "lead":
        wave = (
            0.6 * np.sin(2.0 * np.pi * freq * t)
            + 0.25 * np.sin(2.0 * np.pi * 2.0 * freq * t)
            + 0.15 * np.sin(2.0 * np.pi * 3.0 * freq * t)
        )
        attack_s = 0.015
        release_s = min(0.12, n / sr * 0.3)
    else:
        wave = (
            0.65 * np.sin(2.0 * np.pi * freq * t)
            + 0.22 * np.sin(2.0 * np.pi * 2.0 * freq * t)
            + 0.13 * np.sin(2.0 * np.pi * 4.0 * freq * t)
        ) * np.exp(-1.5 * t)
        attack_s = 0.01
        release_s = min(0.15, n / sr * 0.35)

    env = np.ones(n, dtype=np.float32)
    a_len = min(n, max(1, int(attack_s * sr)))
    r_len = min(n, max(1, int(release_s * sr)))
    env[:a_len] = np.linspace(0.0, 1.0, a_len, dtype=np.float32)
    env[-r_len:] *= np.linspace(1.0, 0.0, r_len, dtype=np.float32)

    return (wave * env * velocity * 0.35).astype(np.float32)


def _synthesize_midi_track(
    track_name: str,
    notes: list[MidiNote],
    bpm: float,
    total_samples: int,
    sr: int,
) -> np.ndarray:
    """Render MIDI notes into mono float32 audio anchored at t=0.000s."""
    buf = np.zeros(total_samples, dtype=np.float32)
    if not notes:
        return buf

    sec_per_beat = 60.0 / max(bpm, 1.0)
    is_drums = track_name == "drums"

    for note in notes:
        start_idx = int(round(note.start_beat * sec_per_beat * sr))
        if start_idx >= total_samples or start_idx < 0:
            continue
        dur_samples = max(64, int(round(note.duration * sec_per_beat * sr)))
        vel = float(np.clip(note.velocity / 127.0, 0.05, 1.0))

        if is_drums:
            voice = _synthesize_drum_hit(note.pitch, max(dur_samples, int(0.25 * sr)), sr, vel)
        else:
            voice = _synthesize_tonal_note(note.pitch, dur_samples, sr, vel, track_name)

        end_idx = min(total_samples, start_idx + len(voice))
        buf[start_idx:end_idx] += voice[: end_idx - start_idx]

    return buf


def _try_fluidsynth_render(
    track_name: str,
    track: TrackState,
    bpm: float,
    total_samples: int,
    sr: int,
) -> Optional[np.ndarray]:
    """Attempt FluidSynth rendering if binary and SoundFont exist; return None on fallback."""
    sf_path = get_effective_soundfont_path()
    if not track.notes or shutil.which("fluidsynth") is None or not os.path.exists(sf_path):
        return None

    mid = mido.MidiFile(ticks_per_beat=480)
    mt = mido.MidiTrack()
    mt.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(bpm), time=0))
    ch = 9 if track_name == "drums" else 0
    if ch != 9:
        inst_key = (track.instrument or "grand_piano").strip().lower()
        prog = INSTRUMENT_PROGRAMS.get(inst_key, 0)
        mt.append(mido.Message("program_change", channel=ch, program=prog, time=0))

    events: list[tuple[int, int, mido.Message]] = []
    for n in track.notes:
        s_tick = max(0, int(round(n.start_beat * 480)))
        d_tick = max(1, int(round(n.duration * 480)))
        events.append((s_tick, 1, mido.Message("note_on", channel=ch, note=int(n.pitch), velocity=int(n.velocity), time=0)))
        events.append((s_tick + d_tick, 0, mido.Message("note_off", channel=ch, note=int(n.pitch), velocity=0, time=0)))
    events.sort(key=lambda item: (item[0], item[1]))

    prev = 0
    for tick, _, msg in events:
        mt.append(msg.copy(time=max(0, tick - prev)))
        prev = tick
    mt.append(mido.MetaMessage("end_of_track", time=0))
    mid.tracks.append(mt)

    with tempfile.TemporaryDirectory() as tmpdir:
        mid_path = os.path.join(tmpdir, "track.mid")
        wav_path = os.path.join(tmpdir, "out.wav")
        mid.save(mid_path)
        cmd = ["fluidsynth", "-ni", "-q", "-F", wav_path, "-r", str(sr), sf_path, mid_path]
        try:
            res = subprocess.run(cmd, capture_output=True, timeout=15, check=False)
            if res.returncode != 0 or not os.path.exists(wav_path):
                return None
            with open(wav_path, "rb") as fh:
                audio, out_sr = decode_wav_bytes(fh.read())
            if out_sr != sr or len(audio) == 0:
                return None
            if len(audio) >= total_samples:
                return audio[:total_samples]
            return np.pad(audio, (0, total_samples - len(audio))).astype(np.float32)
        except Exception:
            return None


def _pan_stereo(mono: np.ndarray, pan: float, volume: float) -> np.ndarray:
    """Apply volume and constant-power stereo panning (-1.0 L .. +1.0 R)."""
    p = float(np.clip(pan, -1.0, 1.0))
    angle = (p + 1.0) * (np.pi / 4.0)
    left_gain = float(np.cos(angle) * volume)
    right_gain = float(np.sin(angle) * volume)
    stereo = np.empty((len(mono), 2), dtype=np.float32)
    stereo[:, 0] = mono * left_gain
    stereo[:, 1] = mono * right_gain
    return stereo


VOCAL_ONLY_MODES = {"raw", "dry", "autotune"}


def _normalize_render_mode(mode: Optional[str]) -> str:
    cleaned = (mode or "ai_mix").strip().lower()
    if cleaned == "mix":
        return "ai_mix"
    return cleaned or "ai_mix"


def _vocal_ref_candidates(project: ProjectState, mode: str) -> tuple[tuple[Optional[str], str], ...]:
    """Return ordered (project_ref, slot_key) candidates for the requested render mode."""
    raw_pair = (project.audio_assets.raw_input_ref, "raw_input_ref")
    dry_pair = (project.audio_assets.dry_denoised_ref, "dry_denoised_ref")
    tuned_pair = (project.audio_assets.tuned_vocal_ref, "tuned_vocal_ref")

    if mode == "raw":
        return (raw_pair, dry_pair, tuned_pair)
    if mode in ("dry", "dry_beat"):
        return (dry_pair, raw_pair, tuned_pair)
    if not project.autotune_settings.enabled:
        return (dry_pair, raw_pair)
    return (tuned_pair, dry_pair, raw_pair)


def _render_audio_track(
    track: TrackState,
    project: ProjectState,
    audio_assets: dict[str, bytes],
    total_samples: int,
    sr: int,
    mode: str,
    track_name: str = "vocal",
) -> np.ndarray:
    """Assemble audio clips (or default vocal asset) onto timeline from provided asset map."""
    buf = np.zeros(total_samples, dtype=np.float32)
    bpm = float(project.analysis.bpm or 120.0)
    beats_per_bar = 4.0
    try:
        beats_per_bar = float(int(project.analysis.time_signature.split("/")[0]))
    except Exception:
        pass
    sec_per_bar = beats_per_bar * (60.0 / bpm)
    mode_norm = _normalize_render_mode(mode)

    def _get_bytes(key: Optional[str]) -> Optional[bytes]:
        if not key:
            return None
        return audio_assets.get(key)

    canonical_refs = {
        ref
        for ref in (
            "raw_input_ref",
            "dry_denoised_ref",
            "tuned_vocal_ref",
            project.audio_assets.raw_input_ref,
            project.audio_assets.dry_denoised_ref,
            project.audio_assets.tuned_vocal_ref,
        )
        if ref
    }

    def _resolve_ref(src: str) -> Optional[bytes]:
        if src and src not in canonical_refs:
            return _get_bytes(src)
        for proj_ref, slot_name in _vocal_ref_candidates(project, mode_norm):
            b = _get_bytes(proj_ref) or _get_bytes(slot_name)
            if b:
                return b
        return _get_bytes(src)

    clips = list(track.clips)
    if not clips:
        if track_name.lower() == "vocal":
            wav_bytes = _resolve_ref("raw_input_ref" if mode_norm == "raw" else "dry_denoised_ref")
            if wav_bytes:
                samples, clip_sr = decode_wav_bytes(wav_bytes)
                if clip_sr != sr:
                    samples = _resample_mono(samples, clip_sr, sr)
                n = min(total_samples, len(samples))
                buf[:n] += samples[:n]
        return buf

    for clip in clips:
        wav_bytes = _resolve_ref(clip.source)
        if not wav_bytes:
            continue
        samples, clip_sr = decode_wav_bytes(wav_bytes)
        if clip_sr != sr:
            samples = _resample_mono(samples, clip_sr, sr)
        t_start = max(0, int(round(clip.trim_start_sec * sr)))
        t_end = int(round(clip.trim_end_sec * sr)) if clip.trim_end_sec is not None else len(samples)
        t_end = min(len(samples), max(t_start, t_end))
        seg = samples[t_start:t_end].copy()
        if len(seg) == 0:
            continue

        fi = min(len(seg), int(round((clip.fade_in_ms / 1000.0) * sr)))
        fo = min(len(seg), int(round((clip.fade_out_ms / 1000.0) * sr)))
        if fi > 0:
            seg[:fi] *= np.linspace(0.0, 1.0, fi, dtype=np.float32)
        if fo > 0:
            seg[-fo:] *= np.linspace(1.0, 0.0, fo, dtype=np.float32)

        start_sec = (clip.start_bar - 1.0) * sec_per_bar + (clip.offset_ms / 1000.0)
        start_idx = int(round(start_sec * sr))
        if start_idx < 0:
            seg = seg[-start_idx:]
            start_idx = 0
        if start_idx >= total_samples or len(seg) == 0:
            continue
        end_idx = min(total_samples, start_idx + len(seg))
        buf[start_idx:end_idx] += seg[: end_idx - start_idx]

    return buf


def render_midi_tracks_to_audio(
    tracks: dict[str, TrackState],
    bpm: float,
    total_bars: int,
    sample_rate: int = 44100,
    time_signature: str = "4/4",
) -> dict[str, np.ndarray]:
    """Render all MIDI tracks to equal-length mono float32 buffers."""
    beats_per_bar = 4
    try:
        beats_per_bar = int(time_signature.split("/")[0])
    except Exception:
        pass
    total_samples = max(1, int(round(total_bars * beats_per_bar * (60.0 / max(bpm, 1.0)) * sample_rate)))
    rendered: dict[str, np.ndarray] = {}

    for name, track in tracks.items():
        if track.type != "midi":
            continue
        mono = _try_fluidsynth_render(name, track, bpm, total_samples, sample_rate)
        if mono is None:
            mono = _synthesize_midi_track(name, track.notes, bpm, total_samples, sample_rate)
        rendered[name] = mono
    return rendered


_HALL_IR_CACHE: dict[int, np.ndarray] = {}


def _rbj_biquad(
    kind: str,
    f0: float,
    sr: int,
    db_gain: float,
    q: float = 0.7071067811865476,
) -> tuple[np.ndarray, np.ndarray]:
    """Compute normalized RBJ Audio EQ Cookbook biquad filter coefficients."""
    if abs(db_gain) < 0.05 or f0 <= 0.0 or f0 >= 0.49 * sr:
        return np.array([1.0], dtype=np.float64), np.array([1.0], dtype=np.float64)

    a_lin = 10.0 ** (db_gain / 40.0)
    w0 = 2.0 * math.pi * f0 / sr
    cos_w = math.cos(w0)
    sin_w = math.sin(w0)

    if kind == "peaking":
        alpha = sin_w / (2.0 * max(q, 0.1))
        b0 = 1.0 + alpha * a_lin
        b1 = -2.0 * cos_w
        b2 = 1.0 - alpha * a_lin
        a0 = 1.0 + alpha / a_lin
        a1 = -2.0 * cos_w
        a2 = 1.0 - alpha / a_lin
    elif kind == "lowshelf":
        alpha = sin_w / math.sqrt(2.0)
        two_sqrt_a_alpha = 2.0 * math.sqrt(a_lin) * alpha
        b0 = a_lin * ((a_lin + 1.0) - (a_lin - 1.0) * cos_w + two_sqrt_a_alpha)
        b1 = 2.0 * a_lin * ((a_lin - 1.0) - (a_lin + 1.0) * cos_w)
        b2 = a_lin * ((a_lin + 1.0) - (a_lin - 1.0) * cos_w - two_sqrt_a_alpha)
        a0 = (a_lin + 1.0) + (a_lin - 1.0) * cos_w + two_sqrt_a_alpha
        a1 = -2.0 * ((a_lin - 1.0) + (a_lin + 1.0) * cos_w)
        a2 = (a_lin + 1.0) + (a_lin - 1.0) * cos_w - two_sqrt_a_alpha
    else:
        alpha = sin_w / math.sqrt(2.0)
        two_sqrt_a_alpha = 2.0 * math.sqrt(a_lin) * alpha
        b0 = a_lin * ((a_lin + 1.0) + (a_lin - 1.0) * cos_w + two_sqrt_a_alpha)
        b1 = -2.0 * a_lin * ((a_lin - 1.0) + (a_lin + 1.0) * cos_w)
        b2 = a_lin * ((a_lin + 1.0) + (a_lin - 1.0) * cos_w - two_sqrt_a_alpha)
        a0 = (a_lin + 1.0) - (a_lin - 1.0) * cos_w + two_sqrt_a_alpha
        a1 = 2.0 * ((a_lin - 1.0) - (a_lin + 1.0) * cos_w)
        a2 = (a_lin + 1.0) - (a_lin - 1.0) * cos_w - two_sqrt_a_alpha

    inv_a0 = 1.0 / max(abs(a0), 1e-12) * (1.0 if a0 >= 0.0 else -1.0)
    return (
        np.array([b0 * inv_a0, b1 * inv_a0, b2 * inv_a0], dtype=np.float64),
        np.array([1.0, a1 * inv_a0, a2 * inv_a0], dtype=np.float64),
    )


def _apply_track_eq(mono: np.ndarray, track: TrackState, sr: int) -> np.ndarray:
    """Apply channel 3-band EQ (Low 110Hz, Mid 1kHz Q=0.9, High 6.5kHz) matching Web Audio nodes."""
    low_db = float(np.clip(getattr(track, "low_db", 0.0) or 0.0, -12.0, 12.0))
    mid_db = float(np.clip(getattr(track, "mid_db", 0.0) or 0.0, -12.0, 12.0))
    high_db = float(np.clip(getattr(track, "high_db", 0.0) or 0.0, -12.0, 12.0))
    if abs(low_db) < 0.05 and abs(mid_db) < 0.05 and abs(high_db) < 0.05:
        return mono

    out = mono.astype(np.float64)
    for kind, freq, gain_db, q in (
        ("lowshelf", 110.0, low_db, 0.7071067811865476),
        ("peaking", 1000.0, mid_db, 0.9),
        ("highshelf", 6500.0, high_db, 0.7071067811865476),
    ):
        if abs(gain_db) >= 0.05:
            b, a = _rbj_biquad(kind, freq, sr, gain_db, q=q)
            out = lfilter(b, a, out)
    return out.astype(np.float32)


def _get_hall_ir(sr: int) -> np.ndarray:
    if sr in _HALL_IR_CACHE:
        return _HALL_IR_CACHE[sr]
    dur_s = 1.45
    n = max(64, int(round(dur_s * sr)))
    pre = min(n - 1, int(round(0.018 * sr)))
    rng = np.random.default_rng(seed=2026)
    t = np.arange(n - pre, dtype=np.float64) / sr
    decay = np.exp(-4.6 * t)
    fade_len = min(len(t), max(1, int(0.015 * sr)))
    decay[:fade_len] *= np.linspace(0.0, 1.0, fade_len)
    ir = np.zeros((n, 2), dtype=np.float32)
    for ch in range(2):
        tail = rng.standard_normal(len(t)) * decay
        tail = lfilter([0.45], [1.0, -0.55], tail)
        l2 = float(np.sqrt(np.sum(tail * tail))) or 1.0
        ir[pre:, ch] = (tail / l2 * 0.55).astype(np.float32)
    _HALL_IR_CACHE[sr] = ir
    return ir


def _render_reverb_bus(send_stereo: np.ndarray, sr: int) -> np.ndarray:
    n = len(send_stereo)
    if n == 0:
        return send_stereo
    ir = _get_hall_ir(sr)
    out = np.zeros_like(send_stereo)
    for ch in range(2):
        out[:, ch] = fftconvolve(send_stereo[:, ch], ir[:, ch], mode="full")[:n].astype(np.float32)
    return out


def _render_delay_bus(send_stereo: np.ndarray, bpm: float, sr: int) -> np.ndarray:
    n = len(send_stereo)
    if n == 0:
        return send_stereo
    delay_sec = float(np.clip(0.75 * (60.0 / max(bpm, 40.0)), 0.12, 0.75))
    step = max(1, int(round(delay_sec * sr)))
    filtered = lfilter([0.38], [1.0, -0.62], send_stereo, axis=0).astype(np.float32)
    out = np.zeros_like(send_stereo)
    gain = 0.44
    for tap in range(1, 6):
        offset = tap * step
        if offset >= n:
            break
        src = filtered[: n - offset]
        if tap % 2 == 1:
            out[offset:, 0] += src[:, 1] * (gain * 0.85)
            out[offset:, 1] += src[:, 0] * gain
        else:
            out[offset:, 0] += src[:, 0] * gain
            out[offset:, 1] += src[:, 1] * (gain * 0.85)
        gain *= 0.48
    return out


def render_project_mix(
    project: ProjectState,
    audio_assets: dict[str, bytes] | None = None,
    mode: str = "ai_mix",
    apply_mastering: bool = True,
    sample_rate: int = 44100,
) -> tuple[np.ndarray, dict[str, np.ndarray], int]:
    """Render full multi-track stereo mix and equal-length stems with EQ, Send FX & Master Limiter."""
    if project.tracks and all(t.mute for t in project.tracks.values()):
        raise ValueError("All tracks are muted; unmute at least one track before exporting.")

    assets = audio_assets or {}
    bpm = max(40.0, min(220.0, float(project.analysis.bpm or 120.0)))
    raw_struct_bars = int(project.song_structure.total_bars or 0)
    raw_analysis_bars = int(project.analysis.bars or 0)
    if raw_struct_bars > 256 or raw_analysis_bars > 256:
        raise ValueError("Project duration exceeds maximum supported 256 bars.")
    total_bars = max(1, max(raw_struct_bars, raw_analysis_bars, 1))
    beats_per_bar = 4
    try:
        beats_per_bar = max(1, min(12, int(project.analysis.time_signature.split("/")[0])))
    except Exception:
        pass
    max_samples = max(sample_rate, sample_rate * 360)
    total_samples = max(1, min(max_samples, int(round(total_bars * beats_per_bar * (60.0 / bpm) * sample_rate))))

    mode_norm = _normalize_render_mode(mode)
    include_midi = mode_norm not in VOCAL_ONLY_MODES

    any_solo = any(t.solo for t in project.tracks.values())
    midi_monos = (
        render_midi_tracks_to_audio(
            project.tracks,
            bpm=bpm,
            total_bars=total_bars,
            sample_rate=sample_rate,
            time_signature=project.analysis.time_signature,
        )
        if include_midi
        else {}
    )

    raw_monos: dict[str, np.ndarray] = {}
    for name, track in project.tracks.items():
        if track.type == "audio":
            mono = _render_audio_track(
                track, project, assets, total_samples, sample_rate, mode_norm, track_name=name
            )
        else:
            mono = midi_monos.get(name, np.zeros(total_samples, dtype=np.float32))
        raw_monos[name] = mono

    vocal_track = project.tracks.get("vocal")
    vocal_active = (
        vocal_track is not None
        and (not vocal_track.mute)
        and (not any_solo or vocal_track.solo)
        and "vocal" in raw_monos
        and float(np.max(np.abs(raw_monos["vocal"]))) > 1e-4
    )
    apply_vocal_carve = (
        vocal_active
        and project.mastering.auto_mix_enabled
        and mode_norm not in VOCAL_ONLY_MODES
    )
    if apply_vocal_carve:
        carve_b, carve_a = _rbj_biquad("peaking", 2200.0, sample_rate, -2.5, q=1.1)

    stems: dict[str, np.ndarray] = {}
    mix = np.zeros((total_samples, 2), dtype=np.float32)
    reverb_send_bus = np.zeros((total_samples, 2), dtype=np.float32)
    delay_send_bus = np.zeros((total_samples, 2), dtype=np.float32)
    has_reverb_send = False
    has_delay_send = False

    for name, track in project.tracks.items():
        mono = raw_monos[name]
        if track.type == "audio":
            mode_gain = 1.05 if mode_norm == "preserve" else 1.0
        else:
            if mode_norm == "preserve":
                mode_gain = 0.0 if name.lower() == "lead" else 0.80
            elif mode_norm == "enhance":
                mode_gain = 1.08
            else:
                mode_gain = 1.0

        eq_mono = _apply_track_eq(mono, track, sample_rate)
        if apply_vocal_carve and name.lower() in ("harmony", "lead") and float(np.max(np.abs(eq_mono))) > 1e-5:
            eq_mono = lfilter(carve_b, carve_a, eq_mono.astype(np.float64)).astype(np.float32)

        active = (not track.mute) and (not any_solo or track.solo)
        stereo = _pan_stereo(eq_mono, track.pan, track.volume * mode_gain if active else 0.0)
        stems[name] = stereo
        if active:
            mix += stereo
            rev = float(np.clip(getattr(track, "reverb_send", 0.0) or 0.0, 0.0, 1.0))
            dly = float(np.clip(getattr(track, "delay_send", 0.0) or 0.0, 0.0, 1.0))
            if rev > 0.001:
                reverb_send_bus += stereo * (rev * 0.55)
                has_reverb_send = True
            if dly > 0.001:
                delay_send_bus += stereo * (dly * 0.50)
                has_delay_send = True

    if has_reverb_send:
        mix += _render_reverb_bus(reverb_send_bus, sample_rate)
    if has_delay_send:
        mix += _render_delay_bus(delay_send_bus, bpm, sample_rate)

    if mode_norm == "enhance" and len(mix):
        air = np.diff(mix, axis=0, prepend=mix[:1])
        mix = (0.92 * mix + 0.08 * np.tanh(1.5 * mix) + 0.06 * air).astype(np.float32)

    if apply_mastering:
        mix = apply_master_limiter(
            mix,
            sample_rate=sample_rate,
            ceiling_db=project.mastering.limiter_ceiling_db,
            target_lufs=project.mastering.target_lufs,
        )

    return mix, stems, sample_rate
