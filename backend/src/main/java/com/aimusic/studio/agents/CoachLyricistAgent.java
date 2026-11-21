package com.aimusic.studio.agents;

import com.aimusic.studio.model.ChordEvent;
import com.aimusic.studio.model.LyricLine;
import com.aimusic.studio.model.ProjectAnalysis;
import com.aimusic.studio.model.ProjectConfig;
import com.aimusic.studio.model.ProjectLyrics;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.SongSection;
import com.aimusic.studio.model.SongStructure;
import com.aimusic.studio.model.dto.CoachChatResponse;
import com.aimusic.studio.model.dto.CoachSuggestedAction;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@Service
public class CoachLyricistAgent {

    private final LlmAdapter llm;

    public CoachLyricistAgent(LlmAdapter llm) {
        this.llm = llm;
    }

    public ProjectLyrics suggestLyrics(ProjectState projectState, String language, String topic, String section) {
        SongStructure structure = projectState.getSongStructure() != null ? projectState.getSongStructure() : new SongStructure();
        ProjectAnalysis analysis = projectState.getAnalysis() != null ? projectState.getAnalysis() : new ProjectAnalysis();
        ProjectConfig cfg = projectState.getConfig() != null ? projectState.getConfig() : new ProjectConfig();

        List<SongSection> sections = structure.getSections() != null && !structure.getSections().isEmpty()
                ? new ArrayList<>(structure.getSections())
                : List.of(new SongSection("Main", 1, Math.max(1, structure.getTotalBars()), 0.7, true));

        if (section != null && !section.isBlank()) {
            List<SongSection> filtered = sections.stream()
                    .filter(s -> s.getName().equalsIgnoreCase(section.trim()))
                    .toList();
            if (!filtered.isEmpty()) {
                sections = filtered;
            }
        }

        String lang = (language != null && !language.isBlank()) ? language : "vi";
        String effectiveTopic = (topic != null && !topic.isBlank()) ? topic : cfg.getMood();

        int rawNoteCount = analysis.getRawMelodyMidi() != null ? analysis.getRawMelodyMidi().size() : 0;
        int totalStructBars = Math.max(1, structure.getTotalBars());
        double notesPerBar = rawNoteCount > 0
                ? (double) rawNoteCount / Math.max(1, analysis.getBars() > 0 ? analysis.getBars() : totalStructBars)
                : 3.5;
        int targetSyllablesPerLine = Math.max(6, Math.min(16, (int) Math.round(notesPerBar * 2.2)));

        String prompt = String.format(Locale.ROOT,
                "Write song lyrics in language='%s' about topic='%s' for %s (%.1f BPM, %s %s, ~%d syllables per line to match melody density) matching sections: %s. Return JSON: {\"lines\": [{\"section\": str, \"bar\": int, \"text\": str}]}.",
                lang, effectiveTopic, cfg.getGenre(), analysis.getBpm(),
                analysis.getDetectedKey(), analysis.getDetectedScale(),
                targetSyllablesPerLine,
                sections.stream().map(SongSection::getName).toList());

        LlmAdapter.LlmResponse resp = llm.generateJson(
                prompt,
                "You are a bilingual Vietnamese/English songwriter. Match section rhythm.",
                "lyricist",
                null
        );

        if (!resp.isMock() && resp.data() != null && resp.data().get("lines") instanceof List<?> rawLines) {
            List<LyricLine> parsed = new ArrayList<>();
            for (Object item : rawLines) {
                if (item instanceof Map<?, ?> map) {
                    Object txtObj = map.get("text");
                    if (txtObj != null && !txtObj.toString().isBlank()) {
                        String sec = map.get("section") != null ? map.get("section").toString() : sections.get(0).getName();
                        int bar = 1;
                        if (map.get("bar") instanceof Number num) bar = num.intValue();
                        parsed.add(new LyricLine(sec, bar, txtObj.toString()));
                    }
                }
            }
            if (!parsed.isEmpty()) {
                return new ProjectLyrics(lang, parsed);
            }
        }

        return new ProjectLyrics(lang, fallbackLyrics(sections, lang, effectiveTopic));
    }

    private List<LyricLine> fallbackLyrics(List<SongSection> sections, String language, String topic) {
        String lang = language.toLowerCase(Locale.ROOT);
        String topicPhrase = (topic != null && !topic.isBlank()) ? topic.trim() : (lang.startsWith("vi") ? "ký ức" : "memories");
        List<LyricLine> lines = new ArrayList<>();

        for (SongSection sec : sections) {
            String secName = sec.getName();
            String lower = secName.toLowerCase(Locale.ROOT);
            if (lower.contains("intro") || lower.contains("outro")) continue;

            boolean isChorus = lower.contains("chorus");
            String text;
            if (lang.startsWith("en")) {
                text = isChorus
                        ? "Holding onto " + topicPhrase + " as the chorus rises high"
                        : "Walking through the quiet night with " + topicPhrase + " on my mind";
            } else if ("bilingual".equals(lang)) {
                text = isChorus
                        ? "Giữ mãi " + topicPhrase + " in the light tonight"
                        : "Từng nhịp bước nhẹ qua đêm, " + topicPhrase + " stays alive";
            } else {
                text = isChorus
                        ? "Vang mãi trong tim giai điệu " + topicPhrase + " chẳng phai"
                        : "Lặng nghe nhịp thở đêm nay gợi nhớ về " + topicPhrase;
            }

            lines.add(new LyricLine(secName, sec.getStartBar(), text));
            if (sec.getBars() >= 8) {
                lines.add(new LyricLine(secName, sec.getStartBar() + 4,
                        text + (lang.startsWith("vi") ? " (hòa âm cao trào)" : " (lift)")));
            }
        }

        if (lines.isEmpty()) {
            lines.add(new LyricLine(sections.get(0).getName(), 1, "Giai điệu " + topicPhrase));
        }
        return lines;
    }

    public CoachChatResponse chatCoach(ProjectState projectState, String message, List<Map<String, Object>> history) {
        ProjectAnalysis analysis = projectState.getAnalysis() != null ? projectState.getAnalysis() : new ProjectAnalysis();
        ProjectConfig cfg = projectState.getConfig() != null ? projectState.getConfig() : new ProjectConfig();
        List<ChordEvent> chords = projectState.getSongStructure() != null && projectState.getSongStructure().getChords() != null
                ? projectState.getSongStructure().getChords() : List.of();
        List<String> chordSyms = chords.stream().limit(8).map(ChordEvent::getSymbol).toList();

        String contextSummary = String.format(Locale.ROOT,
                "BPM=%.1f, Key=%s %s, Mode=%s/%s, Genre=%s, Chords=%s.",
                analysis.getBpm(), analysis.getDetectedKey(), analysis.getDetectedScale(),
                cfg.getMelodyMode(), cfg.getOutputMode(), cfg.getGenre(), chordSyms);

        String prompt = "Project context: " + contextSummary + "\n"
                + "Recent history count: " + (history != null ? history.size() : 0) + "\n"
                + "User question: " + message + "\n"
                + "Give concise actionable advice in Vietnamese. Never mutate state directly. "
                + "Return strict JSON: {\"reply\": str, \"suggested_actions\": [{\"id\": str, \"label\": str, \"action\": \"update_config|rearrange_chords|apply_autotune|auto_mix|auto_trim_vocal\", \"payload\": object}]}.";

        boolean useJsonCoach = llm.resolveProvider("coach", null) != LlmAdapter.Provider.MOCK;
        LlmAdapter.LlmResponse resp = useJsonCoach
                ? llm.generateJson(prompt, "You are an encouraging AI Music Coach. Return strict JSON without mutating project state.", "coach", null)
                : llm.generateText(prompt, "You are an encouraging AI Music Coach guiding songwriting and arrangement.", "coach", null);

        List<CoachSuggestedAction> actions = new ArrayList<>();
        String reply = resp.text();
        if (!resp.isMock() && resp.data() != null) {
            if (resp.data().get("reply") instanceof String r && !r.isBlank()) {
                reply = r.trim();
            }
            if (resp.data().get("suggested_actions") instanceof List<?> rawActs) {
                for (Object item : rawActs) {
                    if (item instanceof Map<?, ?> m) {
                        String id = m.get("id") != null ? m.get("id").toString() : "ai_act_" + (actions.size() + 1);
                        String label = m.get("label") != null ? m.get("label").toString() : "";
                        String action = m.get("action") != null ? m.get("action").toString() : "update_config";
                        Map<String, Object> actPayload = m.get("payload") instanceof Map<?, ?> pm
                                ? convertPayload(pm) : Map.of();
                        if (!label.isBlank()) {
                            actions.add(new CoachSuggestedAction(id, label, action, actPayload));
                        }
                    }
                }
            }
        }

        if (actions.isEmpty()) {
            String lowerMsg = message != null ? message.toLowerCase(Locale.ROOT) : "";
            if (lowerMsg.contains("chorus") || lowerMsg.contains("verse") || lowerMsg.contains("đoạn")) {
                actions.add(new CoachSuggestedAction(
                        "set_motif_chorus",
                        "Đặt mô-típ làm Chorus",
                        "update_config",
                        Map.of("motif_position", "chorus", "output_mode", "full_song")
                ));
            }
            if (lowerMsg.contains("buồn") || lowerMsg.contains("sad") || lowerMsg.contains("hợp âm") || lowerMsg.contains("chord")) {
                actions.add(new CoachSuggestedAction(
                        "try_minor_rearrange",
                        "Thử hợp âm thứ (Minor feel)",
                        "rearrange_chords",
                        Map.of("suggestion", "Use vi - IV - I - V progression")
                ));
            }
            if (lowerMsg.contains("auto-tune") || lowerMsg.contains("phô") || lowerMsg.contains("cao độ") || lowerMsg.contains("tune")) {
                actions.add(new CoachSuggestedAction(
                        "apply_balanced_tune",
                        "Bật Auto-Tune mức Vừa",
                        "apply_autotune",
                        Map.of("preset", "balanced")
                ));
            }
            if (lowerMsg.contains("mix") || lowerMsg.contains("vỡ") || lowerMsg.contains("cân bằng") || lowerMsg.contains("nhỏ") || lowerMsg.contains("to")) {
                actions.add(new CoachSuggestedAction(
                        "run_auto_mix",
                        "Chạy AI Auto-Mix (-1.0 dBFS)",
                        "auto_mix",
                        Map.of()
                ));
            }
            if (lowerMsg.contains("nhanh") || lowerMsg.contains("faster")) {
                actions.add(new CoachSuggestedAction(
                        "boost_bpm_8",
                        "Tăng +8 BPM",
                        "update_config",
                        Map.of("bpm", Math.min(220.0, analysis.getBpm() + 8.0))
                ));
            }
        }

        if (resp.isMock()) {
            reply = String.format(Locale.ROOT,
                    "Dựa trên dự án hiện tại (%s %s, %.0f BPM): bạn nên giữ mô-típ chính ở Chorus để tạo cao trào rõ rệt, và dùng hợp âm mở rộng nhẹ ở Verse.",
                    analysis.getDetectedKey(), analysis.getDetectedScale(), analysis.getBpm());
        }
        return new CoachChatResponse(reply, actions, resp.provider().value());
    }

    private Map<String, Object> convertPayload(Map<?, ?> raw) {
        Map<String, Object> out = new java.util.LinkedHashMap<>();
        for (Map.Entry<?, ?> e : raw.entrySet()) {
            if (e.getKey() != null) {
                out.put(String.valueOf(e.getKey()), e.getValue());
            }
        }
        return out;
    }
}
