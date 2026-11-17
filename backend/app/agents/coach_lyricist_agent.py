"""Lyricist & AI Music Coach Agent."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .llm_adapter import LLMAdapter, get_llm_adapter


class CoachLyricistAgent:
    """Generates section-aligned lyrics and provides non-destructive AI Music Coach advice."""

    def __init__(self, llm_adapter: Optional[LLMAdapter] = None) -> None:
        self.llm = llm_adapter or get_llm_adapter()

    async def suggest_lyrics(
        self,
        project_state: Dict[str, Any],
        language: str = "vi",
        topic: str = "",
        section: Optional[str] = None,
    ) -> Dict[str, Any]:
        song_structure = dict(project_state.get("song_structure") or {})
        analysis = dict(project_state.get("analysis") or {})
        config = dict(project_state.get("config") or {})

        sections = list(
            song_structure.get("sections")
            or [{"name": "Main", "start_bar": 1, "bars": int(song_structure.get("total_bars") or 4)}]
        )
        if section:
            filtered = [s for s in sections if str(s.get("name", "")).lower() == section.lower()]
            if filtered:
                sections = filtered

        bpm = analysis.get("bpm", 100)
        key = analysis.get("detected_key", "C")
        scale = analysis.get("detected_scale", "major")
        mood = config.get("mood", "Emotional")
        genre = config.get("genre", "Pop")

        prompt = (
            f"Write song lyrics in language='{language}' about topic='{topic or mood}' "
            f"for {genre} ({bpm} BPM, {key} {scale}) matching sections: "
            f"{[s.get('name') for s in sections]}. "
            "Return JSON: {\"lines\": [{\"section\": str, \"bar\": int, \"text\": str}]}."
        )
        resp = await self.llm.generate_json(
            prompt=prompt,
            system_prompt="You are a bilingual Vietnamese/English songwriter. Match section rhythm.",
            role="lyricist",
        )

        llm_lines = (resp.data or {}).get("lines") if not resp.is_mock else None
        if isinstance(llm_lines, list) and llm_lines:
            lines = [
                {
                    "section": str(item.get("section", sections[0].get("name", "Main"))),
                    "bar": int(item.get("bar", 1)),
                    "text": str(item.get("text", "")),
                }
                for item in llm_lines
                if isinstance(item, dict) and item.get("text")
            ]
            if lines:
                return {"language": language, "lines": lines}

        # Deterministic rhythm-aware fallback templates
        lines = self._fallback_lyrics(sections=sections, language=language, topic=topic or mood)
        return {"language": language, "lines": lines}

    def _fallback_lyrics(
        self,
        sections: List[Dict[str, Any]],
        language: str,
        topic: str,
    ) -> List[Dict[str, Any]]:
        lang = (language or "vi").lower()
        topic_phrase = topic.strip() or ("ký ức" if lang.startswith("vi") else "memories")
        lines: List[Dict[str, Any]] = []

        for sec in sections:
            sec_name = str(sec.get("name", "Main"))
            start_bar = int(sec.get("start_bar", 1))
            bars = max(1, int(sec.get("bars", 4)))
            if "intro" in sec_name.lower() or "outro" in sec_name.lower():
                continue

            if lang.startswith("en"):
                text = (
                    f"Holding onto {topic_phrase} as the chorus rises high"
                    if "chorus" in sec_name.lower()
                    else f"Walking through the quiet night with {topic_phrase} on my mind"
                )
            elif lang == "bilingual":
                text = (
                    f"Giữ mãi {topic_phrase} in the light tonight"
                    if "chorus" in sec_name.lower()
                    else f"Từng nhịp bước nhẹ qua đêm, {topic_phrase} stays alive"
                )
            else:
                text = (
                    f"Vang mãi trong tim giai điệu {topic_phrase} chẳng phai"
                    if "chorus" in sec_name.lower()
                    else f"Lặng nghe nhịp thở đêm nay gợi nhớ về {topic_phrase}"
                )

            lines.append({"section": sec_name, "bar": start_bar, "text": text})
            if bars >= 8:
                lines.append(
                    {
                        "section": sec_name,
                        "bar": start_bar + 4,
                        "text": text + (" (hòa âm cao trào)" if lang.startswith("vi") else " (lift)"),
                    }
                )
        if not lines:
            lines.append({"section": sections[0].get("name", "Main"), "bar": 1, "text": f"Giai điệu {topic_phrase}"})
        return lines

    async def chat_coach(
        self,
        project_state: Dict[str, Any],
        message: str,
        history: Optional[List[Dict[str, str]]] = None,
    ) -> Dict[str, Any]:
        """Provide context-aware coaching without mutating project_state directly."""
        analysis = dict(project_state.get("analysis") or {})
        config = dict(project_state.get("config") or {})
        song_structure = dict(project_state.get("song_structure") or {})
        chords = song_structure.get("chords") or []

        context_summary = (
            f"BPM={analysis.get('bpm', 100)}, Key={analysis.get('detected_key', 'C')} "
            f"{analysis.get('detected_scale', 'major')}, Mode={config.get('melody_mode', 'preserve')}/"
            f"{config.get('output_mode', 'accompaniment')}, Genre={config.get('genre', 'Pop')}, "
            f"Chords={[c.get('symbol') for c in chords[:8]]}."
        )
        prompt = (
            f"Project context: {context_summary}\n"
            f"Recent history count: {len(history or [])}\n"
            f"User question: {message}\n"
            "Give concise actionable advice. Never mutate state directly."
        )
        resp = await self.llm.generate_text(
            prompt=prompt,
            system_prompt="You are an encouraging AI Music Coach guiding songwriting and arrangement.",
            role="coach",
        )

        suggested_actions: List[Dict[str, Any]] = []
        lower_msg = message.lower()
        if "chorus" in lower_msg or "verse" in lower_msg or "đoạn" in lower_msg:
            suggested_actions.append(
                {
                    "id": "set_motif_chorus",
                    "label": "Đặt mô-típ làm Chorus",
                    "action": "update_config",
                    "action_type": "update_config",
                    "payload": {"motif_position": "chorus", "output_mode": "full_song"},
                }
            )
        if "buồn" in lower_msg or "sad" in lower_msg or "hợp âm" in lower_msg or "chord" in lower_msg:
            suggested_actions.append(
                {
                    "id": "try_minor_rearrange",
                    "label": "Thử hợp âm thứ (Minor feel)",
                    "action": "rearrange_chords",
                    "action_type": "rearrange_chords",
                    "payload": {"suggestion": "Use vi - IV - I - V progression"},
                }
            )

        reply = resp.text
        if resp.is_mock:
            reply = (
                f"Dựa trên dự án hiện tại ({analysis.get('detected_key', 'C')} "
                f"{analysis.get('detected_scale', 'major')}, {analysis.get('bpm', 100)} BPM): "
                "bạn nên giữ mô-típ chính ở Chorus để tạo cao trào rõ rệt, và dùng hợp âm mở rộng nhẹ ở Verse."
            )

        return {
            "reply": reply,
            "suggested_actions": suggested_actions,
            "provider": resp.provider.value,
        }
