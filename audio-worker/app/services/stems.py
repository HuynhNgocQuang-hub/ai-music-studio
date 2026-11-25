"""Lightweight DSP Stem Separation (Vocal + Beat/Accompaniment) without heavy DL weights."""

from __future__ import annotations

import io
import wave
from typing import Any

import librosa
import numpy as np
from scipy.signal import butter, sosfiltfilt

from app.services.denoise import decode_wav_bytes
from app.services.exporter import apply_master_limiter, export_wav


def _decode_preserve_stereo(wav_bytes: bytes) -> tuple[np.ndarray, int]:
    """Decode WAV bytes returning mono or stereo float32 array and sample rate."""
    buf = io.BytesIO(wav_bytes)
    with wave.open(buf, "rb") as wf:
        sr = wf.getframerate()
        ch = wf.getnchannels()
        sw = wf.getsampwidth()
        frames = wf.readframes(wf.getnframes())
    if sw == 2:
        raw = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    else:
        mono, mono_sr = decode_wav_bytes(wav_bytes)
        return mono, mono_sr
    if ch == 2 and len(raw) >= 2:
        return raw.reshape(-1, 2), sr
    if ch > 2:
        reshaped = raw.reshape(-1, ch)
        return reshaped.mean(axis=1), sr
    return raw, sr


def separate_vocal_and_beat(wav_bytes: bytes) -> tuple[bytes, bytes, dict[str, Any]]:
    """
    Separate mixed audio into isolated Vocal and Accompaniment/Beat stems.

    Uses Mid/Side spatial separation (when stereo) combined with librosa HPSS
    and vocal-band filtering (180 Hz .. 6.2 kHz) so both stems keep identical duration.
    """
    raw, sr = _decode_preserve_stereo(wav_bytes)
    if raw.size == 0:
        raise ValueError("Cannot separate stems from empty audio.")

    if raw.ndim == 2 and raw.shape[1] == 2:
        mid = 0.5 * (raw[:, 0] + raw[:, 1])
        side = 0.5 * (raw[:, 0] - raw[:, 1])
        center_mask = mid
        method = "mid_side_hpss_bandpass"
    else:
        mid = raw.astype(np.float32)
        side = np.zeros_like(mid)
        center_mask = mid
        method = "mono_hpss_bandpass"

    n_samples = len(mid)
    duration_sec = round(n_samples / max(1, sr), 3)

    if n_samples < 512:
        vocal_mono = mid.copy()
        beat_mono = np.zeros_like(mid)
    else:
        # Harmonic / Percussive source separation gives crisp transient drums separation
        harmonic, percussive = librosa.effects.hpss(center_mask, margin=(1.4, 2.0))

        # Vocal fundamental + presence band (180 Hz .. 6200 Hz, clamped to Nyquist)
        nyq = 0.5 * sr
        low_hz = min(180.0, nyq * 0.25) / nyq
        high_hz = min(6200.0, nyq * 0.92) / nyq
        if low_hz < high_hz and high_hz < 1.0:
            sos = butter(4, [low_hz, high_hz], btype="bandpass", output="sos")
            vocal_band = sosfiltfilt(sos, harmonic).astype(np.float32)
        else:
            vocal_band = harmonic.astype(np.float32)

        vocal_mono = np.clip(vocal_band * 0.92, -1.0, 1.0).astype(np.float32)
        # Reconstruct instrumental/beat = percussive + residual low/air + stereo side
        residual = (mid - vocal_mono) * 0.85
        beat_mono = np.clip(percussive * 0.45 + residual + np.abs(side) * 0.25, -1.0, 1.0).astype(np.float32)

    vocal_safe = apply_master_limiter(np.column_stack([vocal_mono, vocal_mono]), sample_rate=sr, ceiling_db=-1.0)
    beat_safe = apply_master_limiter(np.column_stack([beat_mono, beat_mono]), sample_rate=sr, ceiling_db=-1.0)

    vocal_rms_db = round(float(20.0 * np.log10(max(1e-6, float(np.sqrt(np.mean(vocal_mono ** 2)))))), 2)
    beat_rms_db = round(float(20.0 * np.log10(max(1e-6, float(np.sqrt(np.mean(beat_mono ** 2)))))), 2)

    return (
        export_wav(vocal_safe, sample_rate=sr),
        export_wav(beat_safe, sample_rate=sr),
        {
            "duration_sec": duration_sec,
            "sample_rate": sr,
            "vocal_rms_db": vocal_rms_db,
            "beat_rms_db": beat_rms_db,
            "method": method,
        },
    )
