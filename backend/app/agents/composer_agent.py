"""Composer Agent (Melody & Harmony) plus shared music theory utilities."""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Tuple

from .llm_adapter import LLMAdapter, get_llm_adapter

NOTE_NAME_TO_PC: Dict[str, int] = {
    "C": 0,
    "B#": 0,
    "C#": 1,
    "DB": 1,
    "D": 2,
    "D#": 3,
    "EB": 3,
    "E": 4,
    "FB": 4,
    "F": 5,
    "E#": 5,
    "F#": 6,
    "GB": 6,
    "G": 7,
    "G#": 8,
    "AB": 8,
    "A": 9,
    "A#": 10,
    "BB": 10,
    "B": 11,
    "CB": 11,
}

PC_TO_NOTE_NAME: List[str] = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

SCALE_INTERVALS: Dict[str, List[int]] = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "minor": [0, 2, 3, 5, 7, 8, 10],
    "pentatonic_major": [0, 2, 4, 7, 9],
    "pentatonic major": [0, 2, 4, 7, 9],
    "pentatonic_minor": [0, 3, 5, 7, 10],
    "pentatonic minor": [0, 3, 5, 7, 10],
    "chromatic": list(range(12)),
}

CHORD_QUALITY_INTERVALS: Dict[str, List[int]] = {
    "": [0, 4, 7],
    "maj": [0, 4, 7],
    "m": [0, 3, 7],
    "min": [0, 3, 7],
    "7": [0, 4, 7, 10],
    "maj7": [0, 4, 7, 11],
    "m7": [0, 3, 7, 10],
    "dim": [0, 3, 6],
    "sus2": [0, 2, 7],
    "sus4": [0, 5, 7],
}

_COPYRIGHT_PATTERN = re.compile(
    r"\b(like|style of|sound like|copy|imitate)\s+(taylor swift|son tung|sơn tùng|den vau|đen vâu|bts|blackpink|ed sheeran|adele|the weeknd|drake)\b",
    re.IGNORECASE,
)


def sanitize_user_prompt(prompt: Optional[str], max_length: int = 500) -> str:
    """Truncate prompt to 500 chars and replace specific copyrighted artist copy requests."""
    if not prompt:
        return ""
    cleaned = prompt.strip()
    cleaned = _COPYRIGHT_PATTERN.sub("in an original contemporary style", cleaned)
    return cleaned[:max_length]


def parse_time_signature(time_signature: str) -> Tuple[int, int]:
    try:
        num_str, den_str = str(time_signature or "4/4").split("/", 1)
        num = max(1, int(num_str))
        den = max(1, int(den_str))
        return num, den
    except Exception:
        return 4, 4


def beats_per_bar_from_ts(time_signature: str) -> int:
    num, den = parse_time_signature(time_signature)
    if num == 6 and den == 8:
        return 6
    return num


def parse_key_root(key: str) -> int:
    if not key:
        return 0
    token = key.strip().split()[0].upper()
    if token.endswith("M") and len(token) > 1 and token[:-1] in NOTE_NAME_TO_PC:
        token = token[:-1]
    return NOTE_NAME_TO_PC.get(token, 0)


def get_scale_pitch_classes(key: str, scale: str) -> List[int]:
    root = parse_key_root(key)
    intervals = SCALE_INTERVALS.get((scale or "major").strip().lower(), SCALE_INTERVALS["major"])
    return [(root + interval) % 12 for interval in intervals]


def parse_chord_symbol(symbol: str) -> Tuple[int, List[int]]:
    text = (symbol or "C").strip()
    match = re.match(r"^([A-Ga-g][#b]?)(.*)$", text)
    if not match:
        return 0, [0, 4, 7]
    root_name = match.group(1).upper()
    suffix = match.group(2).strip().lower()
    if "/" in suffix:
        suffix = suffix.split("/", 1)[0]
    root_pc = NOTE_NAME_TO_PC.get(root_name, 0)
    intervals = CHORD_QUALITY_INTERVALS.get(suffix)
    if intervals is None:
        if suffix.startswith("m") and not suffix.startswith("maj"):
            intervals = [0, 3, 7]
        else:
            intervals = [0, 4, 7]
    return root_pc, [(root_pc + iv) % 12 for iv in intervals]


def chord_name_from_root(pc: int, quality: str = "") -> str:
    return f"{PC_TO_NOTE_NAME[pc % 12]}{quality}"


def normalize_midi_note(note: Dict[str, Any]) -> Dict[str, Any]:
    pitch = int(max(0, min(127, round(float(note.get("pitch", 60))))))
    start_beat = max(0.0, float(note.get("start_beat", 0.0)))
    raw_dur = note.get("duration", note.get("duration_beats", 1.0))
    duration = max(0.125, float(raw_dur))
    velocity = int(max(1, min(127, round(float(note.get("velocity", 85))))))
    return {
        "pitch": pitch,
        "start_beat": round(start_beat, 4),
        "duration": round(duration, 4),
        "velocity": velocity,
    }


def snap_pitch_to_scale(pitch: int, scale_pcs: List[int]) -> int:
    if not scale_pcs:
        return pitch
    pc = pitch % 12
    if pc in scale_pcs:
        return pitch
    best_pitch = pitch
    best_dist = 99
    for candidate_offset in (-2, -1, 1, 2):
        cand = pitch + candidate_offset
        if 0 <= cand <= 127 and (cand % 12) in scale_pcs:
            if abs(candidate_offset) < best_dist:
                best_dist = abs(candidate_offset)
                best_pitch = cand
    return best_pitch


def diatonic_triads(key: str, scale: str) -> List[Tuple[str, List[int]]]:
    root = parse_key_root(key)
    norm_scale = (scale or "major").strip().lower()
    if "minor" in norm_scale:
        degrees = [
            (0, "m"),
            (2, "dim"),
            (3, ""),
            (5, "m"),
            (7, "m"),
            (8, ""),
            (10, ""),
        ]
    else:
        degrees = [
            (0, ""),
            (2, "m"),
            (4, "m"),
            (5, ""),
            (7, ""),
            (9, "m"),
            (11, "dim"),
        ]
    triads: List[Tuple[str, List[int]]] = []
    for iv, qual in degrees:
        chord_root = (root + iv) % 12
        symbol = chord_name_from_root(chord_root, qual)
        _, pcs = parse_chord_symbol(symbol)
        triads.append((symbol, pcs))
    return triads


def _choose_chord_for_bar(
    bar_notes: List[Dict[str, Any]],
    triads: List[Tuple[str, List[int]]],
    bar_index: int,
    genre: str,
    mood: str,
) -> str:
    if not triads:
        return "C"
    # Common progressions fallback template: I - V - vi - IV (major) or i - VI - III - VII (minor)
    default_order = [0, 4, 5, 3] if len(triads) >= 6 else [0]
    if "sad" in mood.lower() or "ballad" in genre.lower():
        default_order = [5, 3, 0, 4] if len(triads) >= 6 else [0]

    preferred_idx = default_order[bar_index % len(default_order)]
    if not bar_notes:
        return triads[preferred_idx][0]

    best_symbol = triads[preferred_idx][0]
    best_score = -1.0
    for idx, (symbol, pcs) in enumerate(triads):
        if symbol.endswith("dim"):
            continue
        score = 0.0
        for n in bar_notes:
            pc = n["pitch"] % 12
            if pc in pcs:
                weight = 1.5 if (n["start_beat"] % 1.0) < 0.25 else 1.0
                score += weight * n["duration"]
        if idx == preferred_idx:
            score += 0.35
        if idx == 0 and bar_index == 0:
            score += 0.5
        if score > best_score:
            best_score = score
            best_symbol = symbol
    return best_symbol


class ComposerAgent:
    """Melody & Harmony Agent: designs song structure, chord timeline, and melody notes."""

    def __init__(self, llm_adapter: Optional[LLMAdapter] = None) -> None:
        self.llm = llm_adapter or get_llm_adapter()

    async def compose(
        self,
        project_state: Dict[str, Any],
        qa_feedback: Optional[str] = None,
    ) -> Dict[str, Any]:
        config = dict(project_state.get("config") or {})
        analysis = dict(project_state.get("analysis") or {})

        melody_mode = str(config.get("melody_mode", "preserve")).lower()
        output_mode = str(config.get("output_mode", "accompaniment")).lower()
        motif_position = str(config.get("motif_position", "chorus")).lower()
        genre = str(config.get("genre", "Pop"))
        mood = str(config.get("mood", "Balanced"))
        user_prompt = sanitize_user_prompt(config.get("user_prompt", ""))

        bpm = float(analysis.get("bpm") or 100)
        time_sig = str(analysis.get("time_signature") or "4/4")
        beats_per_bar = beats_per_bar_from_ts(time_sig)
        key = str(analysis.get("detected_key") or "C")
        scale = str(analysis.get("detected_scale") or "major")
        scale_pcs = get_scale_pitch_classes(key, scale)

        raw_notes_raw = analysis.get("raw_melody_midi") or []
        raw_notes = [normalize_midi_note(n) for n in raw_notes_raw]
        if not raw_notes:
            # Default 4-bar tonic motif when raw melody is empty
            root_midi = 60 + parse_key_root(key)
            raw_notes = [
                {"pitch": root_midi, "start_beat": 0.0, "duration": 1.0, "velocity": 85},
                {"pitch": snap_pitch_to_scale(root_midi + 4, scale_pcs), "start_beat": 1.0, "duration": 1.0, "velocity": 85},
                {"pitch": snap_pitch_to_scale(root_midi + 7, scale_pcs), "start_beat": 2.0, "duration": 1.5, "velocity": 88},
                {"pitch": snap_pitch_to_scale(root_midi + 4, scale_pcs), "start_beat": 3.5, "duration": 0.5, "velocity": 80},
            ]

        max_end_beat = max(n["start_beat"] + n["duration"] for n in raw_notes)
        input_bars = max(1, int(math.ceil(max_end_beat / beats_per_bar)))

        # Strictly preserve raw melody in preserve mode (`FR-HUM-01`),
        # or refine contour-preserving melody in enhance mode (`FR-HUM-02`).
        if melody_mode == "preserve":
            melody_notes = [dict(n) for n in raw_notes]
        else:
            melody_notes = self._enhance_melody(raw_notes, scale_pcs, beats_per_bar)

        # Optional LLM advisory call for harmonic progression / motif placement (falls back cleanly)
        llm_suggestion = await self._consult_llm_for_harmony(
            key=key,
            scale=scale,
            bpm=bpm,
            genre=genre,
            mood=mood,
            output_mode=output_mode,
            motif_position=motif_position,
            input_bars=input_bars,
            user_prompt=user_prompt,
            qa_feedback=qa_feedback,
        )

        triads = diatonic_triads(key, scale)

        if output_mode == "full_song":
            sections, total_bars, resolved_motif_pos = self._build_full_song_sections(
                input_bars=input_bars,
                motif_position=motif_position,
                llm_motif_pos=llm_suggestion.get("motif_position"),
            )
        else:
            total_bars = input_bars
            resolved_motif_pos = "main"
            sections = [
                {
                    "name": "Main",
                    "start_bar": 1,
                    "bars": total_bars,
                    "energy": 0.7,
                    "has_user_motif": True,
                }
            ]

        chords: List[Dict[str, Any]] = []
        llm_chords = llm_suggestion.get("chords") or []
        valid_symbols = {sym for sym, _ in triads}

        for bar_idx in range(total_bars):
            bar_num = bar_idx + 1
            bar_start_beat = bar_idx * beats_per_bar
            bar_end_beat = bar_start_beat + beats_per_bar
            bar_notes = [
                n for n in melody_notes
                if bar_start_beat <= n["start_beat"] < bar_end_beat
            ]

            chosen_symbol: Optional[str] = None
            if bar_idx < len(llm_chords) and isinstance(llm_chords[bar_idx], str):
                candidate = llm_chords[bar_idx].strip()
                if candidate in valid_symbols and not qa_feedback:
                    chosen_symbol = candidate

            if not chosen_symbol:
                chosen_symbol = _choose_chord_for_bar(bar_notes, triads, bar_idx, genre, mood)

            chords.append(
                {
                    "bar": bar_num,
                    "beat": 1,
                    "symbol": chosen_symbol,
                    "duration_beats": beats_per_bar,
                }
            )

        return {
            "song_structure": {
                "total_bars": total_bars,
                "sections": sections,
                "chords": chords,
            },
            "melody_notes": melody_notes,
            "motif_position": resolved_motif_pos,
            "sanitized_prompt": user_prompt,
            "composer_notes": llm_suggestion.get("notes", "Harmony aligned to melody strong beats."),
        }

    def _enhance_melody(
        self,
        raw_notes: List[Dict[str, Any]],
        scale_pcs: List[int],
        beats_per_bar: int,
    ) -> List[Dict[str, Any]]:
        """Quantize slightly to 1/8-beat grid and snap out-of-scale pitches while preserving contour."""
        enhanced: List[Dict[str, Any]] = []
        for idx, note in enumerate(raw_notes):
            snapped_pitch = snap_pitch_to_scale(note["pitch"], scale_pcs)
            quantized_start = round(note["start_beat"] * 2.0) / 2.0
            quantized_dur = max(0.25, round(note["duration"] * 2.0) / 2.0)
            vel = min(115, max(70, note["velocity"] + (4 if idx % 2 == 0 else 0)))
            enhanced.append(
                {
                    "pitch": snapped_pitch,
                    "start_beat": round(quantized_start, 4),
                    "duration": round(quantized_dur, 4),
                    "velocity": vel,
                }
            )
        return enhanced

    def _build_full_song_sections(
        self,
        input_bars: int,
        motif_position: str,
        llm_motif_pos: Optional[str] = None,
    ) -> Tuple[List[Dict[str, Any]], int, str]:
        resolved_pos = motif_position
        if resolved_pos == "auto":
            resolved_pos = llm_motif_pos if llm_motif_pos in ("chorus", "verse") else "chorus"
        if resolved_pos not in ("chorus", "verse"):
            resolved_pos = "chorus"

        unit = max(4, min(8, input_bars))
        intro_bars = 4
        verse_bars = unit
        chorus_bars = unit
        outro_bars = 4

        sections = [
            {"name": "Intro", "start_bar": 1, "bars": intro_bars, "energy": 0.3, "has_user_motif": False},
            {
                "name": "Verse 1",
                "start_bar": 1 + intro_bars,
                "bars": verse_bars,
                "energy": 0.55,
                "has_user_motif": resolved_pos == "verse",
            },
            {
                "name": "Chorus",
                "start_bar": 1 + intro_bars + verse_bars,
                "bars": chorus_bars,
                "energy": 0.9,
                "has_user_motif": resolved_pos == "chorus",
            },
            {
                "name": "Outro",
                "start_bar": 1 + intro_bars + verse_bars + chorus_bars,
                "bars": outro_bars,
                "energy": 0.35,
                "has_user_motif": False,
            },
        ]
        total_bars = intro_bars + verse_bars + chorus_bars + outro_bars
        return sections, total_bars, resolved_pos

    async def _consult_llm_for_harmony(
        self,
        key: str,
        scale: str,
        bpm: float,
        genre: str,
        mood: str,
        output_mode: str,
        motif_position: str,
        input_bars: int,
        user_prompt: str,
        qa_feedback: Optional[str],
    ) -> Dict[str, Any]:
        prompt = (
            f"Design a diatonic chord progression in {key} {scale} at {bpm} BPM "
            f"for genre='{genre}', mood='{mood}', output_mode='{output_mode}', "
            f"motif_position='{motif_position}', input_bars={input_bars}. "
            f"User prompt: {user_prompt or 'none'}. "
            f"QA feedback to fix: {qa_feedback or 'none'}. "
            "Return JSON with keys: chords (list of chord symbols), motif_position ('chorus'|'verse'), notes."
        )
        resp = await self.llm.generate_json(
            prompt=prompt,
            system_prompt="You are a music harmony composer. Return strict JSON.",
            role="composer",
        )
        return resp.data or {}
