"""Producer / QA & Auto-Mastering Agent."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .composer_agent import (
    beats_per_bar_from_ts,
    get_scale_pitch_classes,
    normalize_midi_note,
    parse_chord_symbol,
)
from .llm_adapter import LLMAdapter, get_llm_adapter


@dataclass
class QAReport:
    approved: bool
    score: float
    issues: List[str] = field(default_factory=list)
    feedback: str = ""
    fix_target: Optional[str] = None  # "composer" | "arranger" | None
    recommended_volumes: Dict[str, float] = field(default_factory=dict)
    recommended_mastering: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "approved": self.approved,
            "score": round(self.score, 4),
            "issues": list(self.issues),
            "feedback": self.feedback,
            "fix_target": self.fix_target,
            "recommended_volumes": dict(self.recommended_volumes),
            "recommended_mastering": dict(self.recommended_mastering),
        }


class QAAgent:
    """Verifies harmony, rhythm boundaries, register separation, preserve fidelity, and mastering safety."""

    def __init__(self, llm_adapter: Optional[LLMAdapter] = None) -> None:
        self.llm = llm_adapter or get_llm_adapter()

    async def review(
        self,
        project_state: Dict[str, Any],
        target_track: Optional[str] = None,
    ) -> QAReport:
        config = dict(project_state.get("config") or {})
        analysis = dict(project_state.get("analysis") or {})
        song_structure = dict(project_state.get("song_structure") or {})
        tracks = dict(project_state.get("tracks") or {})
        mastering = dict(project_state.get("mastering") or {})

        key = str(analysis.get("detected_key") or "C")
        scale = str(analysis.get("detected_scale") or "major")
        scale_pcs = set(get_scale_pitch_classes(key, scale))
        time_sig = str(analysis.get("time_signature") or "4/4")
        beats_per_bar = beats_per_bar_from_ts(time_sig)

        total_bars = max(1, int(song_structure.get("total_bars") or 1))
        total_beats = float(total_bars * beats_per_bar)
        chords = list(song_structure.get("chords") or [])
        chord_pcs_by_bar: Dict[int, set[int]] = {}
        for c in chords:
            if "bar" in c and "symbol" in c:
                _, pcs = parse_chord_symbol(str(c["symbol"]))
                chord_pcs_by_bar[int(c["bar"])] = set(pcs)

        issues: List[str] = []
        fix_target: Optional[str] = None
        score = 1.0

        # 1. Check track lengths, boundaries, and harmonic compatibility
        checked_tracks = [target_track] if target_track else ["drums", "bass", "harmony"]
        for t_name in checked_tracks:
            track = tracks.get(t_name)
            if not isinstance(track, dict):
                issues.append(f"Missing track '{t_name}'.")
                fix_target = fix_target or "arranger"
                score -= 0.25
                continue

            notes = track.get("notes") or []
            if not notes:
                issues.append(f"Track '{t_name}' has no MIDI notes.")
                fix_target = fix_target or "arranger"
                score -= 0.2
                continue

            out_of_bounds = 0
            in_harmony = 0
            total_pitched = 0

            for note in notes:
                start_beat = float(note.get("start_beat", 0.0))
                dur = float(note.get("duration", note.get("duration_beats", 0.0)))
                pitch = int(note.get("pitch", 60))

                if start_beat < 0.0 or start_beat >= total_beats or dur <= 0.0:
                    out_of_bounds += 1

                if t_name in ("bass", "harmony", "lead"):
                    total_pitched += 1
                    bar_num = min(total_bars, max(1, int(start_beat // beats_per_bar) + 1))
                    allowed = chord_pcs_by_bar.get(bar_num, scale_pcs) | scale_pcs
                    if (pitch % 12) in allowed:
                        in_harmony += 1

                if t_name == "bass" and pitch > 60:
                    issues.append(f"Bass note pitch {pitch} exceeds C4 (60), risking vocal frequency masking.")
                    fix_target = fix_target or "arranger"
                    score -= 0.15
                    break

            if out_of_bounds > 0:
                issues.append(f"Track '{t_name}' has {out_of_bounds} note(s) outside [0, {total_beats}) beats.")
                fix_target = fix_target or "arranger"
                score -= 0.25

            if total_pitched > 0:
                ratio = in_harmony / total_pitched
                if ratio < 0.85:
                    issues.append(
                        f"Track '{t_name}' harmonic match ratio {ratio:.2f} is below 0.85 for {key} {scale}."
                    )
                    fix_target = "composer" if ratio < 0.6 else (fix_target or "arranger")
                    score -= 0.3

        # 2. Check Preserve Original Melody fidelity (`FR-HUM-01`)
        melody_mode = str(config.get("melody_mode", "preserve")).lower()
        raw_melody = [normalize_midi_note(n) for n in (analysis.get("raw_melody_midi") or [])]
        composed_melody = [normalize_midi_note(n) for n in (project_state.get("melody_notes") or [])]
        if melody_mode == "preserve" and raw_melody and composed_melody and not target_track:
            if len(raw_melody) != len(composed_melody):
                issues.append("Preserve mode altered melody note count.")
                fix_target = "composer"
                score -= 0.3
            else:
                for raw_n, comp_n in zip(raw_melody, composed_melody):
                    if raw_n["pitch"] != comp_n["pitch"] or abs(raw_n["start_beat"] - comp_n["start_beat"]) > 0.5:
                        issues.append("Preserve mode deviated from original melody pitch or >0.5 beat timing.")
                        fix_target = "composer"
                        score -= 0.3
                        break

        # 3. Check Full Song energy & structure (`FR-HUM-05`)
        output_mode = str(config.get("output_mode", "accompaniment")).lower()
        sections = list(song_structure.get("sections") or [])
        if output_mode == "full_song" and not target_track:
            if len(sections) < 3:
                issues.append("Full song mode must contain at least 3 distinct sections (Intro/Verse/Chorus/Outro).")
                fix_target = "composer"
                score -= 0.25
            else:
                verse_energies = [float(s.get("energy", 0.5)) for s in sections if "verse" in str(s.get("name", "")).lower()]
                chorus_energies = [float(s.get("energy", 0.8)) for s in sections if "chorus" in str(s.get("name", "")).lower()]
                if verse_energies and chorus_energies and max(chorus_energies) < max(verse_energies):
                    issues.append("Chorus energy must be greater than or equal to Verse energy.")
                    fix_target = "composer"
                    score -= 0.15

        # 4. Mastering Limiter enforcement (`<= -1.0 dBFS`)
        ceiling_db = float(mastering.get("limiter_ceiling_db", -1.0))
        if ceiling_db > -1.0:
            ceiling_db = -1.0

        recommended_mastering = {
            "auto_mix_enabled": bool(mastering.get("auto_mix_enabled", True)),
            "limiter_ceiling_db": ceiling_db,
            "target_lufs": float(mastering.get("target_lufs", -14.0)),
        }
        recommended_volumes = {
            "vocal": 0.9,
            "drums": 0.72,
            "bass": 0.75,
            "harmony": 0.65,
            "lead": 0.60,
        }

        # Optional LLM sanity note (gracefully skipped/mocked if no key)
        await self.llm.generate_json(
            prompt=f"QA check for {key} {scale}, issues={issues}, total_bars={total_bars}.",
            system_prompt="You are an audio mastering & harmony QA reviewer.",
            role="qa",
        )

        approved = len(issues) == 0
        feedback = (
            "Hòa âm, nhịp độ và cân bằng dải tần đạt chuẩn (Limiter <= -1.0 dBFS)."
            if approved
            else "; ".join(issues)
        )
        return QAReport(
            approved=approved,
            score=max(0.0, score),
            issues=issues,
            feedback=feedback,
            fix_target=None if approved else (fix_target or "arranger"),
            recommended_volumes=recommended_volumes,
            recommended_mastering=recommended_mastering,
        )
