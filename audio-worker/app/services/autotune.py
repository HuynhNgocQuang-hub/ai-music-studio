"""Auto-Tune DSP engine with quick presets and non-destructive pitch correction."""

from __future__ import annotations

import numpy as np

from app.schemas import AutotuneSettings
from app.services.analyzer import NOTE_NAMES, extract_f0_contour
from app.services.denoise import decode_wav_bytes, encode_wav_bytes

PRESET_PARAMS: dict[str, dict[str, float | bool]] = {
    "off": {"enabled": False, "retune_speed_ms": 200.0, "humanize": 1.0, "mix_percent": 0.0},
    "natural": {"enabled": True, "retune_speed_ms": 65.0, "humanize": 0.7, "mix_percent": 75.0},
    "balanced": {"enabled": True, "retune_speed_ms": 25.0, "humanize": 0.35, "mix_percent": 95.0},
    "modern": {"enabled": True, "retune_speed_ms": 0.0, "humanize": 0.05, "mix_percent": 100.0},
}

SCALE_INTERVALS: dict[str, set[int]] = {
    "major": {0, 2, 4, 5, 7, 9, 11},
    "minor": {0, 2, 3, 5, 7, 8, 10},
    "pentatonic_major": {0, 2, 4, 7, 9},
    "pentatonic_minor": {0, 3, 5, 7, 10},
    "chromatic": set(range(12)),
}


def resolve_autotune_settings(settings: AutotuneSettings) -> AutotuneSettings:
    """Return effective settings applying quick-preset defaults for unset fields."""
    preset_cfg = PRESET_PARAMS.get(settings.preset)
    if preset_cfg is None:
        return settings
    if settings.preset == "off":
        return settings.model_copy(update={"enabled": False, "mix_percent": 0.0})

    updates: dict[str, float | bool] = {}
    fields_set = settings.model_fields_set
    for field_name, default_val in preset_cfg.items():
        if field_name not in fields_set:
            updates[field_name] = default_val
    if "enabled" not in fields_set:
        updates["enabled"] = True
    return settings.model_copy(update=updates) if updates else settings


def apply_preset(preset: str, key: str = "C", scale: str = "major") -> AutotuneSettings:
    """Build AutotuneSettings from a quick preset name."""
    cfg = PRESET_PARAMS.get(preset, PRESET_PARAMS["off"])
    return AutotuneSettings(
        enabled=bool(cfg["enabled"]),
        preset=preset if preset in PRESET_PARAMS else "off",  # type: ignore[arg-type]
        key=key,
        scale=scale if scale in SCALE_INTERVALS else "major",  # type: ignore[arg-type]
        retune_speed_ms=float(cfg["retune_speed_ms"]),
        humanize=float(cfg["humanize"]),
        mix_percent=float(cfg["mix_percent"]),
    )


_FLAT_AND_ENHARMONIC_TO_PC: dict[str, int] = {
    "c": 0, "b#": 0,
    "c#": 1, "db": 1,
    "d": 2,
    "d#": 3, "eb": 3,
    "e": 4, "fb": 4,
    "f": 5, "e#": 5,
    "f#": 6, "gb": 6,
    "g": 7,
    "g#": 8, "ab": 8,
    "a": 9,
    "a#": 10, "bb": 10,
    "b": 11, "cb": 11,
}


def key_to_pitch_class(key: str) -> int:
    """Normalize sharp/flat/enharmonic key names (e.g. Eb, Bb, F#) to pitch class 0..11."""
    cleaned = (key or "C").strip().lower()
    if cleaned in _FLAT_AND_ENHARMONIC_TO_PC:
        return _FLAT_AND_ENHARMONIC_TO_PC[cleaned]
    if cleaned in [n.lower() for n in NOTE_NAMES]:
        return [n.lower() for n in NOTE_NAMES].index(cleaned)
    return 0


def nearest_scale_midi(midi_val: float, key: str, scale: str) -> float:
    """Snap a fractional MIDI note to the nearest pitch in the target key/scale."""
    root_pc = key_to_pitch_class(key)
    intervals = SCALE_INTERVALS.get(scale, SCALE_INTERVALS["major"])
    allowed_pcs = {(root_pc + iv) % 12 for iv in intervals}

    base = int(round(midi_val))
    best_note = float(base)
    best_dist = 999.0
    for offset in range(-6, 7):
        cand = base + offset
        if (cand % 12) in allowed_pcs:
            dist = abs(midi_val - cand)
            if dist < best_dist:
                best_dist = dist
                best_note = float(cand)
    return best_note


def _pitch_shift_frame_ola(
    samples: np.ndarray,
    ratios: np.ndarray,
    hop_length: int,
    win_length: int = 2048,
) -> np.ndarray:
    """Duration-preserving overlap-add pitch shifter locked to t=0."""
    n_samples = len(samples)
    if n_samples == 0:
        return samples.copy()

    out = np.zeros(n_samples, dtype=np.float32)
    norm = np.zeros(n_samples, dtype=np.float32)
    window = np.hanning(win_length).astype(np.float32)
    half = win_length // 2

    for idx, ratio in enumerate(ratios):
        center = idx * hop_length
        if center >= n_samples:
            break

        ratio_clamped = float(np.clip(ratio, 0.707, 1.414))
        if abs(ratio_clamped - 1.0) < 0.003:
            src_seg = np.zeros(win_length, dtype=np.float32)
            s_start = max(0, center - half)
            s_end = min(n_samples, center + half)
            d_start = s_start - (center - half)
            src_seg[d_start : d_start + (s_end - s_start)] = samples[s_start:s_end]
        else:
            offsets = (np.arange(win_length, dtype=np.float32) - half) * ratio_clamped + center
            valid = (offsets >= 0) & (offsets < n_samples - 1)
            src_seg = np.zeros(win_length, dtype=np.float32)
            if np.any(valid):
                pos = offsets[valid]
                i0 = np.floor(pos).astype(np.int32)
                frac = pos - i0
                src_seg[valid] = samples[i0] * (1.0 - frac) + samples[i0 + 1] * frac

        win_seg = src_seg * window
        o_start = max(0, center - half)
        o_end = min(n_samples, center + half)
        w_start = o_start - (center - half)
        w_end = w_start + (o_end - o_start)
        out[o_start:o_end] += win_seg[w_start:w_end]
        norm[o_start:o_end] += window[w_start:w_end] ** 2

    mask = norm > 1e-6
    out[mask] = out[mask] / norm[mask]
    out[~mask] = samples[~mask]
    return out


def apply_autotune(wav_bytes: bytes, settings: AutotuneSettings) -> tuple[bytes, AutotuneSettings, int]:
    """Apply scale-aware pitch correction preserving duration and t=0 alignment."""
    samples, sr = decode_wav_bytes(wav_bytes)
    effective = resolve_autotune_settings(settings)

    if not effective.enabled or effective.preset == "off" or effective.mix_percent <= 0.0:
        return encode_wav_bytes(samples, sr), effective, sr

    hop_length = 512
    f0, conf = extract_f0_contour(samples, sr, hop_length=hop_length, frame_length=2048)

    frame_ms = (hop_length / sr) * 1000.0
    if effective.retune_speed_ms <= 1.0:
        alpha = 1.0
    else:
        alpha = float(np.clip(frame_ms / (effective.retune_speed_ms + frame_ms), 0.05, 1.0))

    ratios = np.ones(len(f0), dtype=np.float32)
    prev_ratio = 1.0
    humanize = float(np.clip(effective.humanize, 0.0, 1.0))

    for i, (hz, c) in enumerate(zip(f0, conf)):
        if hz > 0.0 and c >= 0.5:
            midi_in = 69.0 + 12.0 * float(np.log2(hz / 440.0))
            midi_target = nearest_scale_midi(midi_in, effective.key, effective.scale)
            midi_blended = midi_target * (1.0 - 0.5 * humanize) + midi_in * (0.5 * humanize)
            semitone_shift = float(np.clip(midi_blended - midi_in, -5.0, 5.0))
            desired_ratio = float(2.0 ** (semitone_shift / 12.0))
        else:
            desired_ratio = 1.0

        smoothed = prev_ratio + alpha * (desired_ratio - prev_ratio)
        ratios[i] = smoothed
        prev_ratio = smoothed

    wet = _pitch_shift_frame_ola(samples, ratios, hop_length=hop_length, win_length=2048)
    mix = float(np.clip(effective.mix_percent / 100.0, 0.0, 1.0))
    blended = (1.0 - mix) * samples + mix * wet
    return encode_wav_bytes(blended, sr), effective, sr
