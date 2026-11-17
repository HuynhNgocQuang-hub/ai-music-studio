"""Audio pitch, BPM, and key/scale analysis (FR-ANA)."""

from __future__ import annotations

from typing import Any, Optional

import numpy as np

from app.core.schemas import MidiNote
from app.services.audio.denoise import decode_wav_bytes

try:
    import librosa  # type: ignore
except ImportError:  # pragma: no cover
    librosa = None  # type: ignore

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler tonal profiles
_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _hz_to_midi(hz: float) -> float:
    return 69.0 + 12.0 * float(np.log2(max(hz, 1e-6) / 440.0))


def _estimate_f0_autocorr(
    samples: np.ndarray,
    sr: int,
    frame_length: int = 2048,
    hop_length: int = 512,
    fmin: float = 65.0,
    fmax: float = 1046.5,
) -> tuple[np.ndarray, np.ndarray]:
    """Pure-numpy YIN-lite autocorrelation F0 and confidence estimator."""
    min_lag = max(1, int(sr / fmax))
    max_lag = min(frame_length // 2, int(sr / fmin))
    num_frames = max(1, 1 + (max(0, len(samples) - frame_length)) // hop_length)
    f0 = np.zeros(num_frames, dtype=np.float32)
    conf = np.zeros(num_frames, dtype=np.float32)

    rms_all = float(np.sqrt(np.mean(samples**2))) if len(samples) else 0.0
    sil_thresh = max(rms_all * 0.08, 1e-4)

    for idx in range(num_frames):
        start = idx * hop_length
        frame = samples[start : start + frame_length]
        if len(frame) < frame_length:
            frame = np.pad(frame, (0, frame_length - len(frame)))
        rms = float(np.sqrt(np.mean(frame**2)))
        if rms < sil_thresh:
            continue

        frame = frame - np.mean(frame)
        # Autocorrelation via FFT
        n_fft = 1 << (frame_length * 2 - 1).bit_length()
        spec = np.fft.rfft(frame, n=n_fft)
        acf = np.fft.irfft(spec * np.conj(spec), n=n_fft)[:frame_length]
        if acf[0] <= 1e-10:
            continue
        acf_norm = acf / acf[0]

        segment = acf_norm[min_lag : max_lag + 1]
        if len(segment) == 0:
            continue
        best_rel = int(np.argmax(segment))
        best_lag = min_lag + best_rel
        best_val = float(segment[best_rel])

        # Parabolic interpolation around peak lag
        if 0 < best_rel < len(segment) - 1:
            y0, y1, y2 = segment[best_rel - 1], segment[best_rel], segment[best_rel + 1]
            denom = y0 - 2.0 * y1 + y2
            if abs(denom) > 1e-9:
                shift = 0.5 * (y0 - y2) / denom
                best_lag_f = best_lag + float(np.clip(shift, -0.5, 0.5))
            else:
                best_lag_f = float(best_lag)
        else:
            best_lag_f = float(best_lag)

        if best_val >= 0.45 and best_lag_f > 0:
            f0[idx] = float(sr / best_lag_f)
            conf[idx] = float(np.clip(best_val, 0.0, 1.0))

    return f0, conf


def extract_f0_contour(
    samples: np.ndarray,
    sr: int,
    hop_length: int = 512,
    frame_length: int = 2048,
) -> tuple[np.ndarray, np.ndarray]:
    """Extract frame-wise F0 (Hz) and confidence using librosa or numpy fallback."""
    if librosa is not None and len(samples) >= frame_length:
        try:
            f0 = librosa.yin(
                samples,
                fmin=65.0,
                fmax=1046.5,
                sr=sr,
                frame_length=frame_length,
                hop_length=hop_length,
            )
            rms = librosa.feature.rms(y=samples, frame_length=frame_length, hop_length=hop_length)[0]
            rms_max = float(np.max(rms)) if len(rms) else 0.0
            n = min(len(f0), len(rms))
            f0 = f0[:n].astype(np.float32)
            conf = np.where(rms[:n] >= max(rms_max * 0.06, 1e-4), 0.85, 0.0).astype(np.float32)
            # Zero unvoiced extreme bounds
            invalid = (f0 <= 66.0) | (f0 >= 1040.0) | ~np.isfinite(f0)
            f0[invalid] = 0.0
            conf[invalid] = 0.0
            return f0, conf
        except Exception:
            pass
    return _estimate_f0_autocorr(samples, sr, frame_length=frame_length, hop_length=hop_length)


def _clamp_bpm(raw_bpm: float) -> float:
    """Fold BPM into SRS valid range 40..220."""
    if not np.isfinite(raw_bpm) or raw_bpm <= 0:
        return 120.0
    bpm = float(raw_bpm)
    while bpm < 40.0:
        bpm *= 2.0
    while bpm > 220.0:
        bpm /= 2.0
    return round(bpm, 1)


def estimate_bpm(samples: np.ndarray, sr: int) -> float:
    """Estimate tempo in BPM within [40, 220]."""
    if librosa is not None and len(samples) >= sr:
        try:
            tempo, _ = librosa.beat.beat_track(y=samples, sr=sr)
            tempo_val = float(np.atleast_1d(tempo)[0])
            if tempo_val > 0:
                return _clamp_bpm(tempo_val)
        except Exception:
            pass

    # Fallback onset-envelope autocorrelation
    hop = max(1, int(0.01 * sr))  # 10ms frames -> 100 Hz
    env = np.array(
        [float(np.sqrt(np.mean(samples[i : i + hop] ** 2))) for i in range(0, len(samples), hop)],
        dtype=np.float32,
    )
    if len(env) < 50:
        return 120.0
    onset = np.maximum(0.0, np.diff(env, prepend=env[0]))
    onset = onset - np.mean(onset)
    acf = np.correlate(onset, onset, mode="full")[len(onset) - 1 :]
    fps = sr / hop
    min_lag = max(1, int(round(fps * 60.0 / 200.0)))
    max_lag = min(len(acf) - 1, int(round(fps * 60.0 / 50.0)))
    if max_lag <= min_lag:
        return 120.0
    best_lag = min_lag + int(np.argmax(acf[min_lag : max_lag + 1]))
    if acf[best_lag] <= 0:
        return 120.0
    return _clamp_bpm(60.0 * fps / best_lag)


def _segment_notes(
    f0: np.ndarray,
    conf: np.ndarray,
    sr: int,
    hop_length: int,
    bpm: float,
) -> list[MidiNote]:
    """Convert F0 curve into discrete MidiNote events filtering < 60ms or conf < 0.5."""
    frame_dur = hop_length / sr
    beats_per_sec = bpm / 60.0

    # Median smooth voiced pitches
    midi_raw = np.zeros_like(f0)
    for i, (hz, c) in enumerate(zip(f0, conf)):
        if hz > 0 and c >= 0.5:
            midi_raw[i] = _hz_to_midi(float(hz))

    notes: list[MidiNote] = []
    cur_pitches: list[float] = []
    cur_confs: list[float] = []
    start_idx = 0

    def flush(end_idx: int) -> None:
        if not cur_pitches:
            return
        dur_sec = (end_idx - start_idx) * frame_dur
        avg_conf = float(np.mean(cur_confs))
        # SRS FR-ANA-01: filter notes shorter than 60ms or confidence < 0.5
        if dur_sec < 0.06 or avg_conf < 0.5:
            return
        pitch_midi = int(np.clip(round(float(np.median(cur_pitches))), 21, 108))
        start_beat = round(start_idx * frame_dur * beats_per_sec, 3)
        dur_beats = max(0.05, round(dur_sec * beats_per_sec, 3))
        notes.append(
            MidiNote(
                pitch=pitch_midi,
                start_beat=start_beat,
                duration=dur_beats,
                velocity=85,
                confidence=round(avg_conf, 3),
            )
        )

    for i, m in enumerate(midi_raw):
        if m <= 0:
            flush(i)
            cur_pitches.clear()
            cur_confs.clear()
            continue
        if not cur_pitches:
            start_idx = i
            cur_pitches.append(float(m))
            cur_confs.append(float(conf[i]))
        else:
            ref_pitch = float(np.median(cur_pitches))
            if abs(float(m) - ref_pitch) <= 0.75:
                cur_pitches.append(float(m))
                cur_confs.append(float(conf[i]))
            else:
                flush(i)
                start_idx = i
                cur_pitches = [float(m)]
                cur_confs = [float(conf[i])]
    flush(len(midi_raw))
    return notes


def estimate_key_scale(
    samples: np.ndarray,
    sr: int,
    notes: list[MidiNote],
) -> tuple[str, str, float]:
    """Estimate musical key, scale (major/minor), and confidence in [0, 1]."""
    chroma = np.zeros(12, dtype=np.float64)
    for n in notes:
        chroma[n.pitch % 12] += n.duration * n.confidence

    if float(np.sum(chroma)) <= 0 and librosa is not None and len(samples) >= 2048:
        try:
            c = librosa.feature.chroma_stft(y=samples, sr=sr)
            chroma = np.sum(c, axis=1)
        except Exception:
            pass

    if float(np.sum(chroma)) <= 0:
        return "C", "major", 0.35

    chroma_norm = chroma - np.mean(chroma)
    denom_c = float(np.linalg.norm(chroma_norm)) + 1e-9

    scores: list[tuple[float, str, str]] = []
    for root_idx, root_name in enumerate(NOTE_NAMES):
        for scale_name, profile in (("major", _MAJOR_PROFILE), ("minor", _MINOR_PROFILE)):
            rotated = np.roll(profile, root_idx)
            prof_norm = rotated - np.mean(rotated)
            corr = float(np.dot(chroma_norm, prof_norm) / (denom_c * (np.linalg.norm(prof_norm) + 1e-9)))
            scores.append((corr, root_name, scale_name))

    scores.sort(key=lambda item: item[0], reverse=True)
    best_corr, best_key, best_scale = scores[0]
    second_corr = scores[1][0] if len(scores) > 1 else 0.0
    margin = max(0.0, best_corr - second_corr)
    confidence = float(np.clip(0.45 + 0.45 * max(0.0, best_corr) + 0.6 * margin, 0.0, 0.99))
    return best_key, best_scale, round(confidence, 3)


def analyze_audio(
    wav_bytes: bytes,
    bpm_override: Optional[float] = None,
    key_override: Optional[str] = None,
    scale_override: Optional[str] = None,
) -> dict[str, Any]:
    """Extract BPM, Key/Scale, duration, bars, and symbolic raw_melody_midi."""
    samples, sr = decode_wav_bytes(wav_bytes)
    duration_sec = round(len(samples) / sr, 3)

    bpm = _clamp_bpm(bpm_override) if bpm_override is not None else estimate_bpm(samples, sr)

    hop_length = 512
    f0, conf = extract_f0_contour(samples, sr, hop_length=hop_length)
    notes = _segment_notes(f0, conf, sr, hop_length=hop_length, bpm=bpm)

    detected_key, detected_scale, key_conf = estimate_key_scale(samples, sr, notes)
    if key_override:
        detected_key = key_override
        key_conf = 1.0
    if scale_override:
        detected_scale = scale_override

    low_conf_warning = key_conf < 0.6
    bar_duration_sec = 4.0 * (60.0 / bpm)
    bars = max(1, int(round(duration_sec / max(bar_duration_sec, 0.1))))

    return {
        "bpm": bpm,
        "time_signature": "4/4",
        "detected_key": detected_key,
        "detected_scale": detected_scale,
        "key_confidence": key_conf,
        "low_confidence_warning": low_conf_warning,
        "bars": bars,
        "duration_sec": duration_sec,
        "raw_melody_midi": notes,
    }
