"""Auto-Tune DSP engine with quick presets and non-destructive pitch correction."""

from __future__ import annotations

import numpy as np

from app.schemas import AutotuneSettings
from app.services.analyzer import (
    SCALE_INTERVALS,
    extract_f0_contour,
    key_to_pitch_class,
    nearest_scale_midi,
)
from app.services.denoise import decode_wav_bytes, encode_wav_bytes

PRESET_PARAMS: dict[str, dict[str, float | bool]] = {
    "off": {"enabled": False, "retune_speed_ms": 200.0, "humanize": 1.0, "mix_percent": 0.0},
    "natural": {"enabled": True, "retune_speed_ms": 65.0, "humanize": 0.7, "mix_percent": 75.0},
    "balanced": {"enabled": True, "retune_speed_ms": 25.0, "humanize": 0.35, "mix_percent": 95.0},
    "modern": {"enabled": True, "retune_speed_ms": 0.0, "humanize": 0.05, "mix_percent": 100.0},
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


def _build_cepstral_lifter(n: int, sr: int, cutoff_sec: float = 0.0018) -> np.ndarray:
    """Precompute smooth low-time real-cepstrum lifter array."""
    cutoff_bin = max(8, min(n // 4, int(round(cutoff_sec * sr))))
    lifter = np.zeros(n, dtype=np.float32)
    lifter[0] = 1.0
    lifter[1:cutoff_bin] = 2.0
    taper = min(4, cutoff_bin // 2)
    if taper > 0:
        lifter[cutoff_bin - taper : cutoff_bin] *= np.linspace(1.0, 0.0, taper, dtype=np.float32)
    return lifter


def _cepstral_spectral_envelope(
    spec: np.ndarray,
    n: int,
    lifter: np.ndarray,
) -> np.ndarray:
    """Estimate smooth vocal-tract spectral envelope via real-cepstrum low-time liftering."""
    log_mag = np.log(np.maximum(np.abs(spec), 1e-6))
    cep = np.fft.irfft(log_mag, n=n)
    smooth_log_mag = np.real(np.fft.rfft(cep * lifter))
    return np.exp(np.clip(smooth_log_mag, -14.0, 14.0)).astype(np.float32)


def _pitch_shift_frame_ola(
    samples: np.ndarray,
    ratios: np.ndarray,
    hop_length: int,
    win_length: int = 2048,
    sr: int = 44100,
    preserve_formant: bool = True,
) -> np.ndarray:
    """Duration-preserving OLA pitch shifter locked to t=0 with cepstral formant preservation."""
    n_samples = len(samples)
    if n_samples == 0:
        return samples.copy()

    out = np.zeros(n_samples, dtype=np.float32)
    norm = np.zeros(n_samples, dtype=np.float32)
    window = np.hanning(win_length).astype(np.float32)
    win_sq = window * window
    half = win_length // 2
    rel_offsets = np.arange(win_length, dtype=np.float32) - half
    lifter = _build_cepstral_lifter(win_length, sr) if preserve_formant else np.empty(0, dtype=np.float32)

    for idx, ratio in enumerate(ratios):
        center = idx * hop_length
        if center >= n_samples:
            break

        orig_seg = np.zeros(win_length, dtype=np.float32)
        s_start = max(0, center - half)
        s_end = min(n_samples, center + half)
        d_start = s_start - (center - half)
        orig_seg[d_start : d_start + (s_end - s_start)] = samples[s_start:s_end]

        ratio_clamped = float(np.clip(ratio, 0.707, 1.414))
        if abs(ratio_clamped - 1.0) < 0.003:
            win_seg = orig_seg * window
        else:
            offsets = rel_offsets * ratio_clamped + center
            valid = (offsets >= 0) & (offsets < n_samples - 1)
            src_seg = np.zeros(win_length, dtype=np.float32)
            if np.any(valid):
                pos = offsets[valid]
                i0 = np.floor(pos).astype(np.int32)
                frac = pos - i0
                src_seg[valid] = samples[i0] * (1.0 - frac) + samples[i0 + 1] * frac

            win_seg = src_seg * window
            if preserve_formant and float(np.max(np.abs(orig_seg))) > 1e-4:
                orig_win = orig_seg * window
                wet_spec = np.fft.rfft(win_seg)
                orig_env = _cepstral_spectral_envelope(np.fft.rfft(orig_win), win_length, lifter)
                wet_env = _cepstral_spectral_envelope(wet_spec, win_length, lifter)
                gain_curve = np.clip(orig_env / np.maximum(wet_env, 1e-5), 0.35, 2.85)
                shaped = np.fft.irfft(wet_spec * gain_curve, n=win_length).astype(np.float32)
                orig_rms = float(np.sqrt(np.mean(orig_win * orig_win)))
                shaped_rms = float(np.sqrt(np.mean(shaped * shaped)))
                if shaped_rms > 1e-6:
                    shaped *= min(1.8, orig_rms / shaped_rms)
                win_seg = shaped * window

        o_start = max(0, center - half)
        o_end = min(n_samples, center + half)
        w_start = o_start - (center - half)
        w_end = w_start + (o_end - o_start)
        out[o_start:o_end] += win_seg[w_start:w_end]
        norm[o_start:o_end] += win_sq[w_start:w_end]

    mask = norm > 1e-6
    out[mask] = out[mask] / norm[mask]
    out[~mask] = samples[~mask]
    return out


def apply_autotune(
    wav_bytes: bytes,
    settings: AutotuneSettings,
    preserve_formant: bool = True,
) -> tuple[bytes, AutotuneSettings, int]:
    """Apply scale-aware formant-preserving pitch correction with t=0 alignment."""
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

    wet = _pitch_shift_frame_ola(
        samples,
        ratios,
        hop_length=hop_length,
        win_length=2048,
        sr=sr,
        preserve_formant=preserve_formant,
    )
    mix = float(np.clip(effective.mix_percent / 100.0, 0.0, 1.0))
    blended = (1.0 - mix) * samples + mix * wet
    return encode_wav_bytes(blended, sr), effective, sr
