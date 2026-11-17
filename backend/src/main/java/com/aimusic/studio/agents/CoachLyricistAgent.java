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

        String prompt = String.format(Locale.ROOT,
                "Write song lyrics in language='%s' about topic='%s' for %s (%.1f BPM, %s %s) matching sections: %s. Return JSON: {\"lines\": [{\"section\": str, \"bar\": int, \"text\": str}]}.",
                lang, effectiveTopic, cfg.getGenre(), analysis.getBpm(),
                analysis.getDetectedKey(), analysis.getDetectedScale(),
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
                + "Give concise actionable advice. Never mutate state directly.";

        LlmAdapter.LlmResponse resp = llm.generateText(
                prompt,
                "You are an encouraging AI Music Coach guiding songwriting and arrangement.",
                "coach",
                null
        );

        List<CoachSuggestedAction> actions = new ArrayList<>();
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

        String reply = resp.text();
        if (resp.isMock()) {
            reply = String.format(Locale.ROOT,
                    "Dựa trên dự án hiện tại (%s %s, %.0f BPM): bạn nên giữ mô-típ chính ở Chorus để tạo cao trào rõ rệt, và dùng hợp âm mở rộng nhẹ ở Verse.",
                    analysis.getDetectedKey(), analysis.getDetectedScale(), analysis.getBpm());
        }
        return new CoachChatResponse(reply, actions, resp.provider().value());
    }
}
