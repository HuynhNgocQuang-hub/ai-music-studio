"""Arranger Agent: converts song structure, chords, and melody into MIDI tracks."""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional, Set

from .composer_agent import (
    beats_per_bar_from_ts,
    get_scale_pitch_classes,
    normalize_midi_note,
    parse_chord_symbol,
)
from .llm_adapter import LLMAdapter, get_llm_adapter

GENRE_INSTRUMENTS: Dict[str, Dict[str, str]] = {
    "pop": {"drums": "acoustic_kit", "bass": "finger_bass", "harmony": "grand_piano", "lead": "electric_piano"},
    "ballad": {"drums": "brush_kit", "bass": "fretless_bass", "harmony": "grand_piano", "lead": "string_ensemble"},
    "lo-fi": {"drums": "lofi_kit", "bass": "warm_sub_bass", "harmony": "rhodes_ep", "lead": "muted_guitar"},
    "lofi": {"drums": "lofi_kit", "bass": "warm_sub_bass", "harmony": "rhodes_ep", "lead": "muted_guitar"},
    "r&b": {"drums": "rnb_kit", "bass": "synth_bass", "harmony": "electric_piano", "lead": "synth_lead"},
    "hip-hop": {"drums": "808_kit", "bass": "808_bass", "harmony": "dark_pad", "lead": "pluck_synth"},
    "edm": {"drums": "electronic_kit", "bass": "saw_bass", "harmony": "supersaw_pad", "lead": "bright_lead"},
    "acoustic": {"drums": "cajon_kit", "bass": "upright_bass", "harmony": "acoustic_guitar", "lead": "flute"},
    "rock": {"drums": "rock_kit", "bass": "pick_bass", "harmony": "overdrive_guitar", "lead": "lead_guitar"},
}


def _select_instruments(genre: str) -> Dict[str, str]:
    lowered = (genre or "pop").strip().lower()
    for key, mapping in GENRE_INSTRUMENTS.items():
        if key in lowered:
            return dict(mapping)
    return dict(GENRE_INSTRUMENTS["pop"])


def _section_energy_for_bar(sections: List[Dict[str, Any]], bar_num: int) -> float:
    for sec in sections:
        start = int(sec.get("start_bar", 1))
        bars = int(sec.get("bars", 1))
        if start <= bar_num < start + bars:
            return float(sec.get("energy", 0.7))
    return 0.7


def _bass_midi_pitch(root_pc: int) -> int:
    # Keep Bass in C2 (36) .. B2 (47) or C3 (48) for solid sub/mid separation from vocal
    pitch = 36 + (root_pc % 12)
    if pitch < 36:
        pitch += 12
    return pitch


def _chord_voicing_pitches(chord_pcs: List[int]) -> List[int]:
    # Place chord tones in C4..G5 (60..79) without muddy low overlap with bass
    base = 60
    voicing: List[int] = []
    for idx, pc in enumerate(chord_pcs[:4]):
        p = base + pc
        if idx > 0 and p <= voicing[-1]:
            p += 12
        voicing.append(min(79, p))
    return voicing


class ArrangerAgent:
    """Arrangement Agent generating drums, bass, harmony, and optional lead MIDI tracks."""

    MIDI_TRACK_NAMES = ("drums", "bass", "harmony", "lead")

    def __init__(self, llm_adapter: Optional[LLMAdapter] = None) -> None:
        self.llm = llm_adapter or get_llm_adapter()

    async def arrange(
        self,
        project_state: Dict[str, Any],
        melody_notes: Optional[List[Dict[str, Any]]] = None,
        target_track: Optional[str] = None,
        instrument_override: Optional[str] = None,
        locked_tracks: Optional[List[str]] = None,
        qa_feedback: Optional[str] = None,
    ) -> Dict[str, Any]:
        config = dict(project_state.get("config") or {})
        analysis = dict(project_state.get("analysis") or {})
        song_structure = dict(project_state.get("song_structure") or {})
        existing_tracks = copy.deepcopy(project_state.get("tracks") or {})

        genre = str(config.get("genre") or "Pop")
        output_mode = str(config.get("output_mode") or "accompaniment").lower()
        time_sig = str(analysis.get("time_signature") or "4/4")
        beats_per_bar = beats_per_bar_from_ts(time_sig)
        key = str(analysis.get("detected_key") or "C")
        scale = str(analysis.get("detected_scale") or "major")
        scale_pcs = get_scale_pitch_classes(key, scale)

        total_bars = max(1, int(song_structure.get("total_bars") or 4))
        sections = list(song_structure.get("sections") or [{"name": "Main", "start_bar": 1, "bars": total_bars, "energy": 0.7}])
        chords = list(song_structure.get("chords") or [])
        if not chords:
            chords = [{"bar": b + 1, "beat": 1, "symbol": key, "duration_beats": beats_per_bar} for b in range(total_bars)]

        chord_by_bar: Dict[int, str] = {int(c["bar"]): str(c["symbol"]) for c in chords if "bar" in c and "symbol" in c}
        instruments = _select_instruments(genre)

        locked_set: Set[str] = {t.lower() for t in (locked_tracks or [])}
        for name, track_data in existing_tracks.items():
            if isinstance(track_data, dict) and track_data.get("locked"):
                locked_set.add(name.lower())

        # Determine which MIDI tracks to generate
        if target_track:
            target = target_track.lower()
            tracks_to_build = {target}
        elif locked_tracks is not None:
            tracks_to_build = {"bass", "harmony", "drums"} - locked_set
            if output_mode == "full_song" and "lead" not in locked_set:
                tracks_to_build.add("lead")
        else:
            tracks_to_build = {"drums", "bass", "harmony"} - locked_set
            if (output_mode == "full_song" or config.get("include_lead")) and "lead" not in locked_set:
                tracks_to_build.add("lead")

        # Consult LLM for stylistic density hint (resilient to mock)
        await self.llm.generate_json(
            prompt=(
                f"Arrange MIDI tracks {sorted(tracks_to_build)} for genre='{genre}', "
                f"bars={total_bars}, key={key} {scale}, qa_feedback='{qa_feedback or ''}'."
            ),
            system_prompt="You are a MIDI arranger. Return concise JSON arrangement guidance.",
            role="arranger",
        )

        # Ensure vocal track is preserved intact
        result_tracks: Dict[str, Any] = copy.deepcopy(existing_tracks)
        if "vocal" not in result_tracks:
            tuned_ref = (project_state.get("audio_assets") or {}).get("tuned_vocal_ref") or (
                project_state.get("audio_assets") or {}
            ).get("dry_denoised_ref")
            result_tracks["vocal"] = {
                "type": "audio",
                "locked": False,
                "mute": False,
                "solo": False,
                "volume": 0.9,
                "pan": 0.0,
                "clips": (
                    [{"id": "clip_vocal_1", "source": tuned_ref, "start_bar": 1, "trim_start_sec": 0.0, "fade_in_ms": 15}]
                    if tuned_ref
                    else []
                ),
            }

        src_melody = melody_notes if melody_notes is not None else (analysis.get("raw_melody_midi") or [])
        normalized_melody = [normalize_midi_note(n) for n in src_melody]

        for track_name in self.MIDI_TRACK_NAMES:
            if track_name not in tracks_to_build:
                if track_name not in result_tracks:
                    result_tracks[track_name] = {
                        "type": "midi",
                        "locked": track_name in locked_set,
                        "mute": False,
                        "solo": False,
                        "volume": 0.75,
                        "pan": 0.0,
                        "instrument": instruments[track_name],
                        "notes": [],
                    }
                continue

            existing_meta = dict(result_tracks.get(track_name) or {})
            is_target = target_track is not None and target_track.lower() == track_name
            inst_name = (
                instrument_override
                if (is_target and instrument_override)
                else existing_meta.get("instrument") or instruments[track_name]
            )

            if track_name == "drums":
                notes = self._generate_drums(total_bars, beats_per_bar, sections, genre)
                default_vol = 0.72
            elif track_name == "bass":
                notes = self._generate_bass(total_bars, beats_per_bar, chord_by_bar, sections, genre)
                default_vol = 0.76
            elif track_name == "harmony":
                notes = self._generate_harmony(total_bars, beats_per_bar, chord_by_bar, sections, genre)
                default_vol = 0.65
            else:
                notes = self._generate_lead(total_bars, beats_per_bar, chord_by_bar, sections, normalized_melody, scale_pcs)
                default_vol = 0.62

            result_tracks[track_name] = {
                "type": "midi",
                "locked": bool(existing_meta.get("locked", False)),
                "mute": bool(existing_meta.get("mute", False)),
                "solo": bool(existing_meta.get("solo", False)),
                "volume": float(existing_meta.get("volume", default_vol)),
                "pan": float(existing_meta.get("pan", 0.0)),
                "instrument": inst_name,
                "notes": notes,
            }

        return result_tracks

    def _generate_drums(
        self,
        total_bars: int,
        beats_per_bar: int,
        sections: List[Dict[str, Any]],
        genre: str,
    ) -> List[Dict[str, Any]]:
        notes: List[Dict[str, Any]] = []
        lowered = genre.lower()
        is_ballad = "ballad" in lowered or "acoustic" in lowered
        is_hiphop = "hip-hop" in lowered or "r&b" in lowered

        for bar_idx in range(total_bars):
            bar_num = bar_idx + 1
            energy = _section_energy_for_bar(sections, bar_num)
            bar_start = float(bar_idx * beats_per_bar)

            # Skip heavy drums on soft intro
            if energy < 0.32 and bar_idx == 0:
                continue

            vel_scale = max(0.55, min(1.0, energy + 0.15))

            for beat in range(beats_per_bar):
                t = bar_start + beat
                # Kick on beat 0 and syncopated beat 2 (or 2.5 for hip-hop)
                if beat == 0:
                    notes.append({"pitch": 36, "start_beat": t, "duration": 0.25, "velocity": int(105 * vel_scale)})
                elif beat == 2 and not is_hiphop:
                    notes.append({"pitch": 36, "start_beat": t, "duration": 0.25, "velocity": int(95 * vel_scale)})
                elif beat == 2 and is_hiphop:
                    notes.append({"pitch": 36, "start_beat": t + 0.5, "duration": 0.25, "velocity": int(98 * vel_scale)})

                # Snare / clap on beats 1 and 3
                if beat in (1, 3) or (beats_per_bar == 3 and beat == 2):
                    snare_vel = int((78 if is_ballad else 96) * vel_scale)
                    notes.append({"pitch": 38, "start_beat": t, "duration": 0.25, "velocity": snare_vel})

                # Closed hi-hat on 8th notes when energy >= 0.45
                if energy >= 0.45:
                    notes.append({"pitch": 42, "start_beat": t, "duration": 0.2, "velocity": int(72 * vel_scale)})
                    if not is_ballad:
                        notes.append({"pitch": 42, "start_beat": t + 0.5, "duration": 0.2, "velocity": int(62 * vel_scale)})

        return notes

    def _generate_bass(
        self,
        total_bars: int,
        beats_per_bar: int,
        chord_by_bar: Dict[int, str],
        sections: List[Dict[str, Any]],
        genre: str,
    ) -> List[Dict[str, Any]]:
        notes: List[Dict[str, Any]] = []
        is_edm = "edm" in genre.lower()

        for bar_idx in range(total_bars):
            bar_num = bar_idx + 1
            energy = _section_energy_for_bar(sections, bar_num)
            symbol = chord_by_bar.get(bar_num, "C")
            root_pc, chord_pcs = parse_chord_symbol(symbol)
            root_pitch = _bass_midi_pitch(root_pc)
            fifth_pc = chord_pcs[2] if len(chord_pcs) >= 3 else (root_pc + 7) % 12
            fifth_pitch = _bass_midi_pitch(fifth_pc)
            bar_start = float(bar_idx * beats_per_bar)
            vel = int(max(65, min(110, 75 + energy * 30)))

            if is_edm and energy >= 0.6:
                for step in range(beats_per_bar * 2):
                    notes.append(
                        {
                            "pitch": root_pitch,
                            "start_beat": bar_start + step * 0.5,
                            "duration": 0.4,
                            "velocity": vel,
                        }
                    )
            elif beats_per_bar >= 4 and energy >= 0.5:
                notes.append({"pitch": root_pitch, "start_beat": bar_start, "duration": 1.5, "velocity": vel})
                notes.append({"pitch": root_pitch, "start_beat": bar_start + 1.5, "duration": 0.5, "velocity": vel - 8})
                notes.append({"pitch": fifth_pitch, "start_beat": bar_start + 2.0, "duration": 1.5, "velocity": vel - 4})
                notes.append({"pitch": root_pitch, "start_beat": bar_start + 3.5, "duration": 0.5, "velocity": vel - 10})
            else:
                notes.append(
                    {
                        "pitch": root_pitch,
                        "start_beat": bar_start,
                        "duration": float(beats_per_bar),
                        "velocity": vel,
                    }
                )
        return notes

    def _generate_harmony(
        self,
        total_bars: int,
        beats_per_bar: int,
        chord_by_bar: Dict[int, str],
        sections: List[Dict[str, Any]],
        genre: str,
    ) -> List[Dict[str, Any]]:
        notes: List[Dict[str, Any]] = []
        is_ballad = "ballad" in genre.lower() or "acoustic" in genre.lower()

        for bar_idx in range(total_bars):
            bar_num = bar_idx + 1
            energy = _section_energy_for_bar(sections, bar_num)
            symbol = chord_by_bar.get(bar_num, "C")
            _, chord_pcs = parse_chord_symbol(symbol)
            voicing = _chord_voicing_pitches(chord_pcs)
            bar_start = float(bar_idx * beats_per_bar)
            vel = int(max(55, min(95, 58 + energy * 32)))

            if is_ballad or energy < 0.5:
                # Sustained pad/piano block chord + gentle arpeggio
                for pitch in voicing:
                    notes.append(
                        {
                            "pitch": pitch,
                            "start_beat": bar_start,
                            "duration": float(beats_per_bar),
                            "velocity": vel,
                        }
                    )
            else:
                # Rhythmic chord hits on beats 0 and 2 (or every beat if high energy)
                hit_beats = [0, 2] if beats_per_bar >= 4 else [0]
                if energy >= 0.8 and beats_per_bar >= 4:
                    hit_beats = [0, 1, 2, 3]
                dur = 1.75 if len(hit_beats) <= 2 else 0.85
                for beat in hit_beats:
                    for pitch in voicing:
                        notes.append(
                            {
                                "pitch": pitch,
                                "start_beat": bar_start + beat,
                                "duration": min(dur, float(beats_per_bar - beat)),
                                "velocity": vel,
                            }
                        )
        return notes

    def _generate_lead(
        self,
        total_bars: int,
        beats_per_bar: int,
        chord_by_bar: Dict[int, str],
        sections: List[Dict[str, Any]],
        melody_notes: List[Dict[str, Any]],
        scale_pcs: List[int],
    ) -> List[Dict[str, Any]]:
        notes: List[Dict[str, Any]] = []
        total_beats = float(total_bars * beats_per_bar)

        # Find motif section (e.g. Chorus) and mirror motif there; gently outline chord tones elsewhere
        motif_sections = [s for s in sections if s.get("has_user_motif")]
        if motif_sections and melody_notes:
            motif_start_beat = (int(motif_sections[0].get("start_bar", 1)) - 1) * beats_per_bar
            motif_len_beats = int(motif_sections[0].get("bars", 4)) * beats_per_bar
            for n in melody_notes:
                shifted_start = motif_start_beat + (n["start_beat"] % max(1.0, float(motif_len_beats)))
                if shifted_start < total_beats:
                    max_dur = min(n["duration"], total_beats - shifted_start)
                    if max_dur >= 0.125:
                        notes.append(
                            {
                                "pitch": n["pitch"],
                                "start_beat": round(shifted_start, 4),
                                "duration": round(max_dur, 4),
                                "velocity": n["velocity"],
                            }
                        )
        else:
            for bar_idx in range(total_bars):
                bar_num = bar_idx + 1
                energy = _section_energy_for_bar(sections, bar_num)
                if energy < 0.45:
                    continue
                symbol = chord_by_bar.get(bar_num, "C")
                _, chord_pcs = parse_chord_symbol(symbol)
                lead_pc = chord_pcs[1] if len(chord_pcs) > 1 else (scale_pcs[0] if scale_pcs else 0)
                notes.append(
                    {
                        "pitch": 72 + lead_pc,
                        "start_beat": float(bar_idx * beats_per_bar),
                        "duration": 2.0,
                        "velocity": 78,
                    }
                )
        return notes
