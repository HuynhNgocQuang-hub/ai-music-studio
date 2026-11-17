"""Audio upload validation, decoding, AI denoise, and auto-trimming."""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from scipy import signal

from app.core.config import settings

try:
    import noisereduce as nr  # type: ignore
except ImportError:  # pragma: no cover
    nr = None  # type: ignore

try:
    from pydub import AudioSegment  # type: ignore
except ImportError:  # pragma: no cover
    AudioSegment = None  # type: ignore


class AudioValidationError(Exception):
    """Raised when uploaded audio violates format, size, or duration rules."""

    def __init__(self, detail: str, status_code: int = 400) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def _resample_mono(samples: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    if orig_sr == target_sr or len(samples) == 0:
        return samples.astype(np.float32)
    gcd = int(np.gcd(orig_sr, target_sr))
    up = target_sr // gcd
    down = orig_sr // gcd
    if up <= 512 and down <= 512:
        resampled = signal.resample_poly(samples, up, down)
    else:
        new_len = max(1, int(round(len(samples) * target_sr / orig_sr)))
        x_old = np.linspace(0.0, 1.0, len(samples), endpoint=False)
        x_new = np.linspace(0.0, 1.0, new_len, endpoint=False)
        resampled = np.interp(x_new, x_old, samples)
    return resampled.astype(np.float32)


def encode_wav_bytes(samples: np.ndarray, sample_rate: int = 44100) -> bytes:
    """Encode float32 array (-1..1) as 16-bit PCM WAV bytes."""
    clipped = np.clip(samples, -1.0, 1.0).astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, clipped, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def decode_wav_bytes(wav_bytes: bytes) -> tuple[np.ndarray, int]:
    """Decode WAV bytes into mono float32 array and sample rate."""
    data, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=True)
    mono = data.mean(axis=1).astype(np.float32)
    return mono, int(sr)


def validate_and_decode_audio(
    file_bytes: bytes,
    filename: str,
    max_bytes: int | None = None,
    min_duration_sec: float | None = None,
    max_duration_sec: float | None = None,
    target_sr: int | None = None,
) -> tuple[bytes, dict[str, Any]]:
    """Validate uploaded audio file and normalize to mono 44.1kHz PCM_16 WAV."""
    max_b = max_bytes if max_bytes is not None else settings.max_upload_bytes
    min_dur = min_duration_sec if min_duration_sec is not None else settings.MIN_DURATION_SEC
    max_dur = max_duration_sec if max_duration_sec is not None else settings.MAX_VOCAL_DURATION_SEC
    sr_out = target_sr if target_sr is not None else settings.SAMPLE_RATE

    ext = Path(filename or "").suffix.lower()
    if ext not in settings.ALLOWED_AUDIO_EXTENSIONS:
        raise AudioValidationError(
            f"Unsupported audio format '{ext}'. Allowed: {', '.join(settings.ALLOWED_AUDIO_EXTENSIONS)}",
            status_code=400,
        )

    size_bytes = len(file_bytes)
    if size_bytes == 0:
        raise AudioValidationError("Uploaded audio file is empty.", status_code=400)
    if size_bytes > max_b:
        raise AudioValidationError(
            f"File size ({size_bytes / (1024 * 1024):.1f} MB) exceeds maximum {max_b // (1024 * 1024)} MB.",
            status_code=413,
        )

    samples_2d: np.ndarray | None = None
    orig_sr = sr_out

    try:
        data, sr = sf.read(io.BytesIO(file_bytes), dtype="float32", always_2d=True)
        samples_2d = data
        orig_sr = int(sr)
    except Exception:
        if AudioSegment is not None:
            try:
                seg = AudioSegment.from_file(io.BytesIO(file_bytes), format=ext.lstrip("."))
                orig_sr = int(seg.frame_rate)
                channels = int(seg.channels)
                raw = np.array(seg.get_array_of_samples(), dtype=np.float32)
                scale = float(1 << (8 * seg.sample_width - 1))
                raw = raw / max(scale, 1.0)
                samples_2d = raw.reshape((-1, channels))
            except Exception as exc:
                raise AudioValidationError(f"Failed to decode audio file: {exc}", status_code=400) from exc
        else:
            raise AudioValidationError("Unable to decode audio format in current environment.", status_code=400)

    if samples_2d is None or samples_2d.shape[0] == 0:
        raise AudioValidationError("Audio contains no samples.", status_code=400)

    channels = int(samples_2d.shape[1])
    duration_sec = float(samples_2d.shape[0] / orig_sr)

    if duration_sec < min_dur:
        raise AudioValidationError(
            f"Audio duration ({duration_sec:.2f}s) is shorter than minimum {min_dur:.1f}s.",
            status_code=400,
        )
    if duration_sec > max_dur:
        raise AudioValidationError(
            f"Audio duration ({duration_sec:.2f}s) exceeds maximum {max_dur:.1f}s.",
            status_code=400,
        )

    mono = samples_2d.mean(axis=1).astype(np.float32)
    mono_44k = _resample_mono(mono, orig_sr, sr_out)

    warnings: list[str] = []
    peak = float(np.max(np.abs(mono_44k))) if len(mono_44k) else 0.0
    peak_db = 20.0 * float(np.log10(max(peak, 1e-9)))
    clip_ratio = float(np.mean(np.abs(mono_44k) >= 0.99))

    if peak_db < -50.0:
        warnings.append("Audio signal is very quiet (< -50 dBFS); consider recording closer to the mic.")
    if clip_ratio > 0.05:
        warnings.append("Audio contains heavy clipping; consider lowering input gain.")

    wav_bytes = encode_wav_bytes(mono_44k, sr_out)
    meta = {
        "filename": filename,
        "format": ext.lstrip("."),
        "size_bytes": size_bytes,
        "duration_sec": round(len(mono_44k) / sr_out, 3),
        "sample_rate": sr_out,
        "channels": channels,
        "peak_db": round(peak_db, 2),
        "warnings": warnings,
    }
    return wav_bytes, meta


def _spectral_denoise_fallback(samples: np.ndarray, sr: int) -> np.ndarray:
    """Lightweight high-pass + spectral noise gate when noisereduce is unavailable."""
    if len(samples) < 512:
        return samples
    sos = signal.butter(2, 75.0, btype="highpass", fs=sr, output="sos")
    filtered = signal.sosfilt(sos, samples).astype(np.float32)

    nperseg = min(1024, len(filtered))
    _, _, zxx = signal.stft(filtered, fs=sr, nperseg=nperseg, noverlap=nperseg // 2)
    mag = np.abs(zxx)
    noise_floor = np.percentile(mag, 20, axis=1, keepdims=True)
    gain = np.clip((mag - 1.2 * noise_floor) / (mag + 1e-8), 0.15, 1.0)
    _, cleaned = signal.istft(zxx * gain, fs=sr, nperseg=nperseg, noverlap=nperseg // 2)
    if len(cleaned) > len(samples):
        cleaned = cleaned[: len(samples)]
    elif len(cleaned) < len(samples):
        cleaned = np.pad(cleaned, (0, len(samples) - len(cleaned)))
    return cleaned.astype(np.float32)


def denoise_and_trim(
    wav_bytes: bytes,
    enable_denoise: bool = True,
    auto_trim: bool = True,
    min_keep_sec: float = 1.0,
) -> tuple[bytes, dict[str, Any]]:
    """Run noise reduction and optional leading/trailing silence trimming."""
    samples, sr = decode_wav_bytes(wav_bytes)
    orig_len = len(samples)
    warnings: list[str] = []

    processed = samples.copy()
    if enable_denoise and len(processed) > 512:
        if nr is not None:
            try:
                processed = nr.reduce_noise(y=processed, sr=sr, prop_decrease=0.8).astype(np.float32)
            except Exception:
                processed = _spectral_denoise_fallback(processed, sr)
        else:
            processed = _spectral_denoise_fallback(processed, sr)

    noise_est = float(np.percentile(np.abs(processed), 15)) + 1e-7
    sig_est = float(np.percentile(np.abs(processed), 95)) + 1e-7
    snr_db = 20.0 * float(np.log10(sig_est / noise_est))

    trimmed_start_sec = 0.0
    trimmed_end_sec = 0.0

    if auto_trim and len(processed) > int(sr * min_keep_sec):
        hop = max(1, int(0.02 * sr))
        frame_rms = np.array(
            [
                float(np.sqrt(np.mean(processed[i : i + hop] ** 2)))
                for i in range(0, len(processed), hop)
            ],
            dtype=np.float32,
        )
        peak_rms = float(np.max(frame_rms)) if len(frame_rms) else 0.0
        threshold = max(peak_rms * 0.03, 10 ** (-48.0 / 20.0))
        active = np.where(frame_rms >= threshold)[0]
        if len(active) > 0:
            pad_frames = 3  # ~60ms padding
            start_idx = max(0, (int(active[0]) - pad_frames) * hop)
            end_idx = min(len(processed), (int(active[-1]) + 1 + pad_frames) * hop)
            if end_idx - start_idx >= int(sr * min_keep_sec):
                trimmed_start_sec = round(start_idx / sr, 3)
                trimmed_end_sec = round((orig_len - end_idx) / sr, 3)
                processed = processed[start_idx:end_idx]

    # Gentle gain normalization for quiet inputs without clipping
    peak = float(np.max(np.abs(processed))) if len(processed) else 0.0
    if 1e-4 < peak < 0.25:
        gain = min(0.5 / peak, 8.0)
        processed = processed * gain
    elif peak < 1e-4:
        warnings.append("Denoised signal is nearly silent.")

    out_bytes = encode_wav_bytes(processed, sr)
    meta = {
        "trimmed_start_sec": trimmed_start_sec,
        "trimmed_end_sec": trimmed_end_sec,
        "duration_sec": round(len(processed) / sr, 3),
        "snr_db_estimate": round(snr_db, 2),
        "warnings": warnings,
    }
    return out_bytes, meta
