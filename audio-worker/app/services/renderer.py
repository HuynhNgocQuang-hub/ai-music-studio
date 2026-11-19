"""Lightweight MIDI-to-Audio renderer (FluidSynth + built-in synth fallback) and multi-track mixer."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from typing import Optional

import mido
import numpy as np

from app.schemas import MidiNote, ProjectState, TrackState
from app.services.denoise import decode_wav_bytes
from app.services.exporter import apply_master_limiter

SOUNDFONT_PATH = os.getenv("SOUNDFONT_PATH", "/usr/share/sounds/sf2/FluidR3_GM.sf2")

INSTRUMENT_PROGRAMS: dict[str, int] = {
    "grand_piano": 0,
    "electric_piano": 4,
    "acoustic_guitar": 24,
    "finger_bass": 33,
    "synth_bass": 38,
    "strings": 48,
    "synth_pad": 88,
    "lead_synth": 80,
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
    sf_path = SOUNDFONT_PATH
    if not track.notes or shutil.which("fluidsynth") is None or not os.path.exists(sf_path):
        return None

    mid = mido.MidiFile(ticks_per_beat=480)
    mt = mido.MidiTrack()
    mt.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(bpm), time=0))
    ch = 9 if track_name == "drums" else 0
    if ch != 9:
        prog = INSTRUMENT_PROGRAMS.get(track.instrument or "grand_piano", 0)
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
        "raw_input_ref",
        "dry_denoised_ref",
        "tuned_vocal_ref",
        project.audio_assets.raw_input_ref,
        project.audio_assets.dry_denoised_ref,
        project.audio_assets.tuned_vocal_ref,
    }

    def _resolve_ref(src: str) -> Optional[bytes]:
        if src and src not in canonical_refs:
            custom = _get_bytes(src)
            if custom:
                return custom
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
                samples, _ = decode_wav_bytes(wav_bytes)
                n = min(total_samples, len(samples))
                buf[:n] += samples[:n]
        return buf

    for clip in clips:
        wav_bytes = _resolve_ref(clip.source)
        if not wav_bytes:
            continue
        samples, _ = decode_wav_bytes(wav_bytes)
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


def render_project_mix(
    project: ProjectState,
    audio_assets: dict[str, bytes] | None = None,
    mode: str = "ai_mix",
    apply_mastering: bool = True,
    sample_rate: int = 44100,
) -> tuple[np.ndarray, dict[str, np.ndarray], int]:
    """Render full multi-track stereo mix and equal-length stems with Master Limiter."""
    if project.tracks and all(t.mute for t in project.tracks.values()):
        raise ValueError("All tracks are muted; unmute at least one track before exporting.")

    assets = audio_assets or {}
    bpm = float(project.analysis.bpm or 120.0)
    total_bars = max(project.song_structure.total_bars, project.analysis.bars, 1)
    beats_per_bar = 4
    try:
        beats_per_bar = int(project.analysis.time_signature.split("/")[0])
    except Exception:
        pass
    total_samples = max(1, int(round(total_bars * beats_per_bar * (60.0 / bpm) * sample_rate)))

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

    stems: dict[str, np.ndarray] = {}
    mix = np.zeros((total_samples, 2), dtype=np.float32)

    for name, track in project.tracks.items():
        if track.type == "audio":
            mono = _render_audio_track(
                track, project, assets, total_samples, sample_rate, mode_norm, track_name=name
            )
            mode_gain = 1.05 if mode_norm == "preserve" else 1.0
        else:
            mono = midi_monos.get(name, np.zeros(total_samples, dtype=np.float32))
            if mode_norm == "preserve":
                mode_gain = 0.40 if name == "lead" else 0.80
            elif mode_norm == "enhance":
                mode_gain = 1.08
            else:
                mode_gain = 1.0

        active = (not track.mute) and (not any_solo or track.solo)
        stereo = _pan_stereo(mono, track.pan, track.volume * mode_gain if active else 0.0)
        stems[name] = stereo
        if active:
            mix += stereo

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
