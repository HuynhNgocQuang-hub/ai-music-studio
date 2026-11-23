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
        return chatCoach(projectState, message, history, "producer");
    }

    public CoachChatResponse chatCoach(ProjectState projectState, String message, List<Map<String, Object>> history, String rawMode) {
        String mode = normalizeCoachMode(rawMode);
        ProjectAnalysis analysis = projectState.getAnalysis() != null ? projectState.getAnalysis() : new ProjectAnalysis();
        ProjectConfig cfg = projectState.getConfig() != null ? projectState.getConfig() : new ProjectConfig();
        SongStructure structure = projectState.getSongStructure() != null ? projectState.getSongStructure() : new SongStructure();
        List<ChordEvent> chords = structure.getChords() != null ? structure.getChords() : List.of();
        List<String> chordSyms = chords.stream().limit(8).map(ChordEvent::getSymbol).toList();
        List<String> sectionNames = structure.getSections() != null
                ? structure.getSections().stream().map(SongSection::getName).toList() : List.of();
        int lyricCount = projectState.getLyrics() != null && projectState.getLyrics().getLines() != null
                ? projectState.getLyrics().getLines().size() : 0;

        String contextSummary = String.format(Locale.ROOT,
                "BPM=%.1f (%s), Key=%s %s, Mode=%s/%s, Genre=%s, Mood=%s, Sections=%s, Chords=%s, LyricLines=%d.",
                analysis.getBpm(),
                analysis.getTimeSignature() != null ? analysis.getTimeSignature() : "4/4",
                analysis.getDetectedKey(), analysis.getDetectedScale(),
                cfg.getMelodyMode(), cfg.getOutputMode(), cfg.getGenre(), cfg.getMood(),
                sectionNames, chordSyms, lyricCount);

        StringBuilder historySnippet = new StringBuilder();
        if (history != null && !history.isEmpty()) {
            int start = Math.max(0, history.size() - 6);
            for (int i = start; i < history.size(); i++) {
                Map<String, Object> turn = history.get(i);
                if (turn == null) continue;
                String role = turn.get("role") != null ? turn.get("role").toString() : "user";
                String content = turn.get("content") != null ? turn.get("content").toString().replaceAll("\\s+", " ").trim() : "";
                if (content.length() > 220) content = content.substring(0, 220) + "...";
                if (!content.isBlank()) {
                    historySnippet.append("- ").append(role).append(": ").append(content).append('\n');
                }
            }
        }

        String roleGuidance = switch (mode) {
            case "arrangement" -> "Focus on chord progressions, song structure sections, rhythm meter, and per-track instrumentation.";
            case "lyricist" -> "Focus on Vietnamese/English lyric craft, rhyme, emotional storytelling, and matching syllable rhythm.";
            case "mix" -> "Focus on 3-band EQ, reverb/delay send FX balance, vocal carve, Auto-Tune tuning, and -1.0 dBFS mastering.";
            default -> "Act as holistic Music Producer guiding composition, structure, vocal overdubs, and finishing.";
        };

        String prompt = "Assistant mode: " + mode + " (" + roleGuidance + ")\n"
                + "Project context: " + contextSummary + "\n"
                + (historySnippet.length() > 0 ? "Recent conversation:\n" + historySnippet : "")
                + "User question: " + message + "\n"
                + "Give concise actionable advice in Vietnamese. Never mutate state directly. "
                + "Return strict JSON: {\"reply\": str, \"suggested_actions\": [{\"id\": str, \"label\": str, \"action\": \"update_config|rearrange_chords|apply_autotune|auto_mix|auto_trim_vocal|suggest_lyrics|regenerate_track\", \"payload\": object}]}.";

        boolean useJsonCoach = llm.resolveProvider("coach", null) != LlmAdapter.Provider.MOCK;
        LlmAdapter.LlmResponse resp = useJsonCoach
                ? llm.generateJson(prompt, "You are an encouraging AI Music Coach (" + mode + "). Return strict JSON without mutating project state.", "coach", null)
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

        String lowerMsg = message != null ? message.toLowerCase(Locale.ROOT) : "";
        if (actions.isEmpty()) {
            buildHeuristicActions(actions, mode, lowerMsg, analysis, cfg);
        }

        if (resp.isMock()) {
            reply = buildContextAwareMockReply(mode, lowerMsg, analysis, cfg, lyricCount, chordSyms);
        }
        return new CoachChatResponse(reply, actions, resp.provider().value());
    }

    private static String normalizeCoachMode(String rawMode) {
        if (rawMode == null || rawMode.isBlank()) return "producer";
        return switch (rawMode.trim().toLowerCase(Locale.ROOT)) {
            case "arrangement", "harmony", "chords" -> "arrangement";
            case "lyricist", "lyrics" -> "lyricist";
            case "mix", "mastering", "autotune" -> "mix";
            default -> "producer";
        };
    }

    private static void buildHeuristicActions(
            List<CoachSuggestedAction> actions,
            String mode,
            String lowerMsg,
            ProjectAnalysis analysis,
            ProjectConfig cfg
    ) {
        if ("lyricist".equals(mode) || lowerMsg.contains("lời") || lowerMsg.contains("lyric") || lowerMsg.contains("viết")) {
            actions.add(new CoachSuggestedAction(
                    "suggest_lyrics_topic",
                    "AI Gợi ý lời (" + (cfg.getMood() != null ? cfg.getMood() : "Cảm xúc") + ")",
                    "suggest_lyrics",
                    Map.of("language", "vi", "section", "Chorus", "topic", cfg.getMood() != null ? cfg.getMood() : "Ký ức")
            ));
        }
        if (lowerMsg.contains("chorus") || lowerMsg.contains("verse") || lowerMsg.contains("đoạn") || lowerMsg.contains("cấu trúc")) {
            actions.add(new CoachSuggestedAction(
                    "set_motif_chorus",
                    "Đặt mô-típ làm Chorus",
                    "update_config",
                    Map.of("motif_position", "chorus", "output_mode", "full_song")
            ));
        }
        if ("arrangement".equals(mode) || lowerMsg.contains("buồn") || lowerMsg.contains("sad") || lowerMsg.contains("hợp âm") || lowerMsg.contains("chord")) {
            actions.add(new CoachSuggestedAction(
                    "try_minor_rearrange",
                    "Đổi vòng hợp âm vi - IV - I - V",
                    "rearrange_chords",
                    Map.of("suggestion", "Use vi - IV - I - V progression")
            ));
        }
        if ("mix".equals(mode) || lowerMsg.contains("auto-tune") || lowerMsg.contains("phô") || lowerMsg.contains("cao độ") || lowerMsg.contains("tune")) {
            actions.add(new CoachSuggestedAction(
                    "apply_balanced_tune",
                    "Bật Auto-Tune mức Vừa",
                    "apply_autotune",
                    Map.of("preset", "balanced")
            ));
        }
        if ("mix".equals(mode) || lowerMsg.contains("mix") || lowerMsg.contains("vỡ") || lowerMsg.contains("cân bằng") || lowerMsg.contains("nhỏ") || lowerMsg.contains("to") || lowerMsg.contains("eq")) {
            actions.add(new CoachSuggestedAction(
                    "run_auto_mix",
                    "Chạy AI Auto-Mix (-1.0 dBFS)",
                    "auto_mix",
                    Map.of()
            ));
        }
        if (lowerMsg.contains("trống") || lowerMsg.contains("drum")) {
            actions.add(new CoachSuggestedAction(
                    "regen_drums",
                    "Tạo lại track Drums",
                    "regenerate_track",
                    Map.of("target_track", "drums")
            ));
        } else if (lowerMsg.contains("bass")) {
            actions.add(new CoachSuggestedAction(
                    "regen_bass",
                    "Tạo lại track Bass",
                    "regenerate_track",
                    Map.of("target_track", "bass")
            ));
        }
        if (lowerMsg.contains("nhanh") || lowerMsg.contains("faster")) {
            actions.add(new CoachSuggestedAction(
                    "boost_bpm_8",
                    "Tăng +8 BPM",
                    "update_config",
                    Map.of("bpm", Math.min(220.0, analysis.getBpm() + 8.0))
            ));
        } else if (lowerMsg.contains("chậm") || lowerMsg.contains("slow")) {
            actions.add(new CoachSuggestedAction(
                    "slow_bpm_8",
                    "Giảm -8 BPM",
                    "update_config",
                    Map.of("bpm", Math.max(40.0, analysis.getBpm() - 8.0))
            ));
        }
        if (actions.isEmpty()) {
            actions.add(new CoachSuggestedAction(
                    "run_auto_mix_default",
                    "Chạy AI Auto-Mix",
                    "auto_mix",
                    Map.of()
            ));
            actions.add(new CoachSuggestedAction(
                    "suggest_lyrics_default",
                    "Gợi ý lời nhanh",
                    "suggest_lyrics",
                    Map.of("language", "vi", "section", "Chorus")
            ));
        }
    }

    private static String buildContextAwareMockReply(
            String mode,
            String lowerMsg,
            ProjectAnalysis analysis,
            ProjectConfig cfg,
            int lyricCount,
            List<String> chordSyms
    ) {
        String keyScale = analysis.getDetectedKey() + " " + analysis.getDetectedScale();
        String chordsStr = chordSyms.isEmpty() ? "chưa có hợp âm" : String.join(" - ", chordSyms.subList(0, Math.min(4, chordSyms.size())));
        return switch (mode) {
            case "lyricist" -> String.format(Locale.ROOT,
                    "[Lyricist • %s %.0f BPM] Bài hiện có %d câu lời (%s, %s). Bạn nên giữ câu hook ngắn 6–10 âm tiết lặp lại ở đầu Chorus để dễ nhớ; bấm nút bên dưới để AI sinh thử lời khớp tiết tấu ngay.",
                    keyScale, analysis.getBpm(), lyricCount, cfg.getGenre(), chordsStr);
            case "arrangement" -> String.format(Locale.ROOT,
                    "[Arrangement • %s %.0f BPM] Vòng hợp âm hiện tại (%s) phù hợp %s. Để tăng độ cao trào, thử vòng vi - IV - I - V ở Chorus hoặc kéo năng lượng (Energy) ở làn Dynamics trên Timeline.",
                    keyScale, analysis.getBpm(), chordsStr, cfg.getGenre());
            case "mix" -> String.format(Locale.ROOT,
                    "[Mix & Mastering • %.0f BPM] Với tông %s, nên giảm nhẹ High -1.5 dB nếu giọng bị chói, đẩy Reverb Send Vocal ~20–30%% và bật Auto-Mix để tự lách tần số 2.2 kHz + giữ Master đỉnh <= -1.0 dBFS.",
                    analysis.getBpm(), keyScale);
            default -> {
                if (lowerMsg.contains("lời") || lowerMsg.contains("lyric")) {
                    yield String.format(Locale.ROOT,
                            "Bài %s (%s %.0f BPM) đang có %d câu lời. Bạn có thể bấm 'AI Gợi ý lời' bên dưới hoặc mở tab Lyrics để đồng bộ Karaoke theo từng ô nhịp.",
                            cfg.getGenre(), keyScale, analysis.getBpm(), lyricCount);
                }
                if (lowerMsg.contains("mix") || lowerMsg.contains("auto-tune") || lowerMsg.contains("phô")) {
                    yield String.format(Locale.ROOT,
                            "Để giọng hòa vào nền (%s, %.0f BPM) mượt nhất: bật Auto-Tune mức Vừa theo đúng %s và dùng Auto-Mix để tự giữ Limiter <= -1.0 dBFS.",
                            cfg.getGenre(), analysis.getBpm(), keyScale);
                }
                yield String.format(Locale.ROOT,
                        "Dự án %s (%s, %.0f BPM, hợp âm %s): bạn nên giữ mô-típ chính ở Chorus, tinh chỉnh đường Dynamics Envelope theo từng đoạn và chạy Auto-Mix trước khi xuất WAV/MP3.",
                        cfg.getGenre(), keyScale, analysis.getBpm(), chordsStr);
            }
        };
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
