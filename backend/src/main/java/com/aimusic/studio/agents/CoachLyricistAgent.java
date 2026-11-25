package com.aimusic.studio.agents;

import com.aimusic.studio.audio.JavaAudioFallbackService;
import com.aimusic.studio.model.AutotuneSettings;
import com.aimusic.studio.model.ChordEvent;
import com.aimusic.studio.model.LyricLine;
import com.aimusic.studio.model.ProjectAnalysis;
import com.aimusic.studio.model.ProjectConfig;
import com.aimusic.studio.model.ProjectLyrics;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.SongSection;
import com.aimusic.studio.model.SongStructure;
import com.aimusic.studio.model.TrackState;
import com.aimusic.studio.model.dto.CoachChatResponse;
import com.aimusic.studio.model.dto.CoachSuggestedAction;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@Service
public class CoachLyricistAgent {

    private final LlmAdapter llm;
    private final JavaAudioFallbackService audioFallback;

    public CoachLyricistAgent(LlmAdapter llm) {
        this(llm, null);
    }

    @Autowired
    public CoachLyricistAgent(LlmAdapter llm, JavaAudioFallbackService audioFallback) {
        this.llm = llm;
        this.audioFallback = audioFallback;
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
        return chatCoach(projectState, message, history, "producer", "", null, null, null);
    }

    public CoachChatResponse chatCoach(ProjectState projectState, String message, List<Map<String, Object>> history, String rawMode) {
        return chatCoach(projectState, message, history, rawMode, "", null, null, null);
    }

    public CoachChatResponse chatCoach(
            ProjectState projectState,
            String message,
            List<Map<String, Object>> history,
            String rawMode,
            String route,
            Map<String, Object> extraContext,
            byte[] attachedAudio,
            String audioMime
    ) {
        String mode = normalizeCoachMode(rawMode);
        String safeRoute = route != null ? route : "";
        ProjectAnalysis analysis = projectState.getAnalysis() != null ? projectState.getAnalysis() : new ProjectAnalysis();
        ProjectConfig cfg = projectState.getConfig() != null ? projectState.getConfig() : new ProjectConfig();
        SongStructure structure = projectState.getSongStructure() != null ? projectState.getSongStructure() : new SongStructure();
        List<ChordEvent> chords = structure.getChords() != null ? structure.getChords() : List.of();
        List<String> chordSyms = chords.stream().limit(8).map(ChordEvent::getSymbol).toList();
        List<SongSection> sections = structure.getSections() != null ? structure.getSections() : List.of();
        List<LyricLine> lyricLines = projectState.getLyrics() != null && projectState.getLyrics().getLines() != null
                ? projectState.getLyrics().getLines() : List.of();

        String trackSnapshot = summarizeTracks(projectState.getTracks());
        String sectionSnapshot = sections.stream()
                .map(s -> s.getName() + "(" + s.getBars() + "b," + Math.round(s.getEnergy() * 100) + "%)")
                .toList().toString();
        String lyricPreview = lyricLines.stream()
                .limit(6)
                .map(l -> "[" + l.getSection() + " b" + l.getBar() + "] " + l.getText())
                .reduce((a, b) -> a + " | " + b)
                .orElse("Chưa có lời");

        String qaFeedback = projectState.getQaStatus() != null && projectState.getQaStatus().getFeedback() != null
                ? projectState.getQaStatus().getFeedback() : "";
        String playbookContext = DawPlaybook.retrieveContext(safeRoute, message, mode);
        AudioTelemetry audioTelemetry = inspectAttachedAudio(attachedAudio);

        StringBuilder extraSummary = new StringBuilder();
        if (extraContext != null && !extraContext.isEmpty()) {
            if (extraContext.get("studio_mode") != null) {
                extraSummary.append("UI=").append(extraContext.get("studio_mode")).append("; ");
            }
            if (extraContext.get("active_tab") != null) {
                extraSummary.append("Tab=").append(extraContext.get("active_tab")).append("; ");
            }
            if (extraContext.get("fit_check") instanceof Map<?, ?> fc) {
                extraSummary.append("LastFitCheck=").append(fc.get("timing_offset_ms"))
                        .append("ms (").append(fc.get("gain_suggestion")).append("); ");
            }
            if (extraContext.get("health_summary") != null) {
                extraSummary.append("Health=").append(extraContext.get("health_summary")).append("; ");
            }
        }

        String contextSummary = String.format(Locale.ROOT,
                "Route='%s' | BPM=%.1f (%s) | Key=%s %s | Mode=%s/%s | Genre=%s | Mood=%s | Sections=%s | Chords=%s | Tracks=[%s] | Lyrics(%d)=[%s] %s %s %s",
                safeRoute.isBlank() ? "/studio" : safeRoute,
                analysis.getBpm(),
                analysis.getTimeSignature() != null ? analysis.getTimeSignature() : "4/4",
                analysis.getDetectedKey(), analysis.getDetectedScale(),
                cfg.getMelodyMode(), cfg.getOutputMode(), cfg.getGenre(), cfg.getMood(),
                sectionSnapshot, chordSyms, trackSnapshot,
                lyricLines.size(), lyricPreview,
                qaFeedback.isBlank() ? "" : "| QA=" + qaFeedback,
                extraSummary.length() > 0 ? "| Extra=" + extraSummary : "",
                audioTelemetry != null ? "| AudioTelemetry=" + audioTelemetry.summary() : "");

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
            case "arrangement" -> "Focus on chord progressions, song structure, dynamics energy, BPM/time signature, and MIDI tracks.";
            case "lyricist" -> "Focus on Vietnamese/English songwriting, chorus hook, rhyme, emotional lines, and direct lyric edits.";
            case "mix" -> "Focus on 3-band EQ, Reverb/Delay FX, Auto-Tune formant tuning, Overdub fit check, and -1.0 dBFS mastering.";
            default -> "Act as holistic AI Music Studio Copilot supporting creation, DAW navigation, songwriting, mixing, export, and troubleshooting.";
        };

        String systemPrompt = "You are an expert, friendly Vietnamese AI Music Studio Copilot (" + mode + "). "
                + roleGuidance + "\n"
                + "You must NEVER mutate state silently; propose tool calls so the user clicks to apply or revert.\n"
                + "App Playbook Reference:\n" + playbookContext;

        String prompt = "Current Studio Snapshot: " + contextSummary + "\n"
                + (historySnippet.length() > 0 ? "Conversation history:\n" + historySnippet : "")
                + "User message: " + message + "\n"
                + "Reply clearly in concise Vietnamese. Call relevant tools when concrete edits or navigation will help the user.";

        LlmAdapter.ToolLlmResponse toolResp = llm.generateAudioWithTools(
                prompt, systemPrompt, attachedAudio, audioMime, TOOL_DECLARATIONS, "coach", null);

        List<CoachSuggestedAction> actions = new ArrayList<>();
        String reply = toolResp.text();
        if (!toolResp.isMock() && toolResp.toolCalls() != null) {
            for (LlmAdapter.ToolCall tc : toolResp.toolCalls()) {
                CoachSuggestedAction mapped = mapToolCallToAction(tc, actions.size() + 1);
                if (mapped != null) {
                    actions.add(mapped);
                }
            }
        }

        String lowerMsg = message != null ? message.toLowerCase(Locale.ROOT) : "";
        if (actions.isEmpty()) {
            buildHeuristicActions(actions, mode, lowerMsg, safeRoute, projectState, analysis, cfg, extraContext, audioTelemetry);
        }

        if (toolResp.isMock()) {
            reply = buildContextAwareMockReply(
                    mode, lowerMsg, safeRoute, projectState, analysis, cfg, lyricLines.size(), chordSyms, projectState.getTracks(), playbookContext, extraContext, audioTelemetry);
        } else if (reply == null || reply.isBlank()) {
            reply = String.format(Locale.ROOT,
                    "Tôi đã phân tích dự án %s (%s %s, %.0f BPM) và chuẩn bị sẵn các nút thao tác đề xuất bên dưới để bạn áp dụng ngay.",
                    cfg.getGenre(), analysis.getDetectedKey(), analysis.getDetectedScale(), analysis.getBpm());
        }
        return new CoachChatResponse(reply, actions, toolResp.provider().value());
    }

    private record AudioTelemetry(double durationSec, double peakDbfs, double rmsDbfs, boolean clipping, boolean tooQuiet) {
        String summary() {
            return String.format(Locale.ROOT, "dur=%.1fs, peak=%.1fdBFS, rms=%.1fdBFS, clip=%s, quiet=%s",
                    durationSec, peakDbfs, rmsDbfs, clipping, tooQuiet);
        }
    }

    private AudioTelemetry inspectAttachedAudio(byte[] audioBytes) {
        if (audioBytes == null || audioBytes.length < 44 || audioFallback == null) {
            return null;
        }
        try {
            JavaAudioFallbackService.DecodedWav wav = audioFallback.decodeWavBytes(audioBytes);
            float[] mono = wav.mono();
            if (mono.length == 0) return null;
            double peak = 1e-6;
            double sumSq = 0.0;
            for (float s : mono) {
                double a = Math.abs(s);
                if (a > peak) peak = a;
                sumSq += s * s;
            }
            double rms = Math.sqrt(sumSq / mono.length);
            double peakDb = 20.0 * Math.log10(Math.max(peak, 1e-6));
            double rmsDb = 20.0 * Math.log10(Math.max(rms, 1e-6));
            double dur = (double) mono.length / Math.max(8000, wav.sampleRate());
            return new AudioTelemetry(dur, peakDb, rmsDb, peakDb > -1.0, rmsDb < -34.0);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String summarizeTracks(Map<String, TrackState> tracks) {
        if (tracks == null || tracks.isEmpty()) return "none";
        List<String> parts = new ArrayList<>();
        for (Map.Entry<String, TrackState> entry : tracks.entrySet()) {
            TrackState t = entry.getValue();
            if (t == null) continue;
            String kind = "audio".equalsIgnoreCase(t.getType())
                    ? (t.getClips() != null ? t.getClips().size() + "clips" : "0clips")
                    : ((t.getInstrument() != null ? t.getInstrument() : "midi") + "/" + (t.getNotes() != null ? t.getNotes().size() + "n" : "0n"));
            parts.add(String.format(Locale.ROOT, "%s(%s,vol=%d%%,eq=%.0f/%.0f/%.0f,rev=%.2f%s)",
                    entry.getKey(), kind, Math.round(t.getVolume() * 100),
                    t.getLowDb(), t.getMidDb(), t.getHighDb(), t.getReverbSend(),
                    t.isMute() ? ",MUTE" : ""));
        }
        return String.join("; ", parts);
    }

    private static CoachSuggestedAction mapToolCallToAction(LlmAdapter.ToolCall tc, int idx) {
        if (tc == null || tc.name() == null || tc.name().isBlank()) return null;
        Map<String, Object> args = tc.arguments() != null ? tc.arguments() : Map.of();
        String label = args.get("label") != null && !args.get("label").toString().isBlank()
                ? args.get("label").toString()
                : defaultLabelForTool(tc.name(), args);
        return new CoachSuggestedAction("ai_tool_" + idx + "_" + tc.name(), label, tc.name(), args);
    }

    private static String defaultLabelForTool(String name, Map<String, Object> args) {
        return switch (name) {
            case "set_track_mix" -> "Chỉnh Mix/EQ track " + (args.getOrDefault("track_id", "vocal"));
            case "manage_track" -> "Quản lý track " + (args.getOrDefault("track_id", "texture"));
            case "apply_drum_groove" -> "Đổi điệu trống " + String.valueOf(args.getOrDefault("style", "pop")).toUpperCase(Locale.ROOT);
            case "edit_structure_and_dynamics" -> "Cập nhật Cấu trúc & Dynamics";
            case "update_lyrics_lines" -> "Áp dụng chỉnh sửa lời bài hát";
            case "suggest_lyrics" -> "AI Gợi ý lời bài hát";
            case "rearrange_chords" -> "Đổi vòng hợp âm & Đồng bộ đệm";
            case "apply_autotune" -> "Áp dụng Auto-Tune (" + args.getOrDefault("preset", "balanced") + ")";
            case "auto_mix" -> "Chạy AI Auto-Mix (-1.0 dBFS)";
            case "auto_trim_vocal" -> "Chạy AI Auto-Trim Vocal";
            case "set_mastering" -> "Chỉnh Mastering (" + args.getOrDefault("target_lufs", "-14") + " LUFS)";
            case "regenerate_track" -> "Tạo lại track " + args.getOrDefault("target_track", "drums");
            case "regenerate_song" -> "Phối lại toàn bộ bài hát";
            case "transport_control" -> "Điều khiển phát/Lịch sử (" + args.getOrDefault("command", "play") + ")";
            case "navigate_tab" -> "Mở tab " + args.getOrDefault("tab", "mixer");
            case "navigate_route" -> "Chuyển sang trang " + args.getOrDefault("route", "/studio");
            case "switch_studio_mode" -> "Chuyển chế độ " + args.getOrDefault("studio_mode", "pro");
            case "create_template" -> "Tạo Project mẫu " + args.getOrDefault("genre", "Pop");
            case "export_project" -> "Xuất file " + String.valueOf(args.getOrDefault("format", "mp3")).toUpperCase(Locale.ROOT);
            case "separate_stems" -> "Tách Stem Vocal & Beat từ audio gốc";
            case "set_automation" -> "Vẽ Automation " + args.getOrDefault("parameter", "volume") + " track " + args.getOrDefault("track_id", "vocal");
            case "test_health" -> "Kiểm tra API Key & Hệ thống";
            case "clear_cache" -> "Dọn Cache hệ thống";
            default -> "Áp dụng cấu hình (" + name + ")";
        };
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

    private static String normText(String text) {
        if (text == null || text.isBlank()) return "";
        String decomposed = java.text.Normalizer.normalize(text.toLowerCase(Locale.ROOT), java.text.Normalizer.Form.NFD);
        return decomposed.replaceAll("\\p{M}", "").replace('\u0111', 'd');
    }

    private static String detectTrackMention(String normMsg, String defaultTrack) {
        if (normMsg.contains("drum") || normMsg.contains("trong")) return "drums";
        if (normMsg.contains("bass") || normMsg.contains("tram")) return "bass";
        if (normMsg.contains("harmony") || normMsg.contains("hop am") || normMsg.contains("dem") || normMsg.contains("piano")) return "harmony";
        if (normMsg.contains("lead") || normMsg.contains("giai dieu") || normMsg.contains("flute")) return "lead";
        if (normMsg.contains("texture") || normMsg.contains("sample") || normMsg.contains("hieu ung")) return "texture";
        if (normMsg.contains("vocal") || normMsg.contains("giong") || normMsg.contains("hat")) return "vocal";
        return defaultTrack;
    }

    private static boolean isBroadAuditPrompt(String normMsg) {
        return normMsg.contains("moi thu")
                || normMsg.contains("tat ca")
                || normMsg.contains("lam gi")
                || normMsg.contains("lam duoc gi")
                || normMsg.contains("kha nang")
                || normMsg.contains("tong the")
                || normMsg.contains("danh gia")
                || normMsg.contains("thieu gi")
                || normMsg.contains("toan bo")
                || normMsg.contains("toi uu")
                || normMsg.contains("can lam gi");
    }

    private static void appendProjectAuditRecommendations(
            List<CoachSuggestedAction> actions,
            String route,
            ProjectState projectState,
            ProjectAnalysis analysis,
            ProjectConfig cfg,
            Map<String, Object> extraContext
    ) {
        Map<String, TrackState> tracks = projectState.getTracks();
        TrackState vocal = tracks != null ? tracks.get("vocal") : null;
        TrackState harmony = tracks != null ? tracks.get("harmony") : null;
        List<LyricLine> lyrics = projectState.getLyrics() != null && projectState.getLyrics().getLines() != null
                ? projectState.getLyrics().getLines() : List.of();
        List<SongSection> sections = projectState.getSongStructure() != null && projectState.getSongStructure().getSections() != null
                ? projectState.getSongStructure().getSections() : List.of();
        AutotuneSettings tune = projectState.getAutotuneSettings();

        if (route.equals("/") || route.startsWith("/library")) {
            actions.add(new CoachSuggestedAction("audit_tpl_lofi", "Tạo & mở Studio (Lo-fi)", "create_template", Map.of("genre", "Lo-fi")));
            actions.add(new CoachSuggestedAction("audit_tpl_pop", "Tạo & mở Studio (Pop)", "create_template", Map.of("genre", "Pop")));
            actions.add(new CoachSuggestedAction("audit_go_create", "Vào trang Thu Mic / Upload (/create)", "navigate_route", Map.of("route", "/create")));
            actions.add(new CoachSuggestedAction("audit_go_settings", "Mở Cài đặt API Key (/settings)", "navigate_route", Map.of("route", "/settings")));
        }

        if (vocal == null || vocal.getReverbSend() <= 0.05) {
            actions.add(new CoachSuggestedAction(
                    "audit_vocal_space",
                    "Thêm Reverb & Delay cho Vocal",
                    "set_track_mix",
                    Map.of("track_id", "vocal", "reverb_send", 0.28, "delay_send", 0.14)
            ));
        }
        if (harmony != null && harmony.getLowDb() >= 0.0) {
            actions.add(new CoachSuggestedAction(
                    "audit_carve_harmony",
                    "Cắt Low Harmony (-2.5 dB) làm thoáng Vocal",
                    "set_track_mix",
                    Map.of("track_id", "harmony", "low_db", -2.5)
            ));
        }
        if (tune == null || !tune.isEnabled() || "off".equalsIgnoreCase(tune.getPreset())) {
            actions.add(new CoachSuggestedAction(
                    "audit_autotune",
                    "Bật Auto-Tune mức Vừa (" + analysis.getDetectedKey() + " " + analysis.getDetectedScale() + ")",
                    "apply_autotune",
                    Map.of("preset", "balanced")
            ));
        }
        if (lyrics.isEmpty()) {
            actions.add(new CoachSuggestedAction(
                    "audit_lyrics",
                    "AI Sáng tác lời theo cấu trúc bài",
                    "suggest_lyrics",
                    Map.of("language", "vi", "section", "Chorus", "topic", cfg.getMood() != null ? cfg.getMood() : "Cảm xúc")
            ));
        }
        boolean hasBridge = sections.stream().anyMatch(s -> s.getName() != null && s.getName().toLowerCase(Locale.ROOT).contains("bridge"));
        if (!hasBridge) {
            actions.add(new CoachSuggestedAction(
                    "audit_add_bridge",
                    "Thêm đoạn Bridge (4 ô nhịp)",
                    "edit_structure_and_dynamics",
                    Map.of("add_section_name", "Bridge", "section_bars", 4, "section_energy", 0.85)
            ));
        }
        boolean lowChorus = sections.stream().anyMatch(s -> s.getName() != null && s.getName().toLowerCase(Locale.ROOT).contains("chorus") && s.getEnergy() < 0.90);
        if (lowChorus) {
            actions.add(new CoachSuggestedAction(
                    "audit_boost_chorus",
                    "Đẩy Dynamics Chorus lên 95%",
                    "edit_structure_and_dynamics",
                    Map.of("target_section", "Chorus", "section_energy", 0.95)
            ));
        }
        if (extraContext != null && extraContext.get("fit_check") != null) {
            actions.add(new CoachSuggestedAction("audit_auto_trim", "Chạy AI Auto-Trim Vocal", "auto_trim_vocal", Map.of()));
        }
        actions.add(new CoachSuggestedAction("audit_auto_mix", "Chạy AI Auto-Mix (-1.0 dBFS)", "auto_mix", Map.of()));
        actions.add(new CoachSuggestedAction("audit_export_mp3", "Xuất MP3 320kbps", "export_project", Map.of("format", "mp3", "bitrate", "320k")));
    }

    private static void buildHeuristicActions(
            List<CoachSuggestedAction> actions,
            String mode,
            String lowerMsg,
            String route,
            ProjectState projectState,
            ProjectAnalysis analysis,
            ProjectConfig cfg,
            Map<String, Object> extraContext,
            AudioTelemetry audioTelemetry
    ) {
        String normMsg = normText(lowerMsg);
        boolean onHomeOrLibrary = route.equals("/") || route.startsWith("/library");
        boolean broadAudit = isBroadAuditPrompt(normMsg);

        if (onHomeOrLibrary && (normMsg.contains("tao") || normMsg.contains("beat") || normMsg.contains("mau") || normMsg.contains("lo-fi") || normMsg.contains("trap") || normMsg.contains("pop") || normMsg.contains("ballad") || normMsg.contains("edm"))) {
            String tplGenre = normMsg.contains("trap") ? "Hip-hop"
                    : normMsg.contains("lo-fi") || normMsg.contains("lofi") ? "Lo-fi"
                    : normMsg.contains("ballad") ? "Ballad"
                    : normMsg.contains("edm") || normMsg.contains("house") ? "EDM" : "Pop";
            actions.add(new CoachSuggestedAction(
                    "create_starter_" + tplGenre.toLowerCase(Locale.ROOT),
                    "Tạo & mở Studio (" + tplGenre + ")",
                    "create_template",
                    Map.of("genre", tplGenre)
            ));
        }

        if (audioTelemetry != null) {
            if (audioTelemetry.clipping()) {
                actions.add(new CoachSuggestedAction(
                        "tame_vocal_clipping",
                        "Giảm Gain Vocal & Chống vỡ tiếng",
                        "set_track_mix",
                        Map.of("track_id", "vocal", "volume", 0.78, "high_db", -1.5)
                ));
            } else if (audioTelemetry.tooQuiet()) {
                actions.add(new CoachSuggestedAction(
                        "boost_vocal_gain",
                        "Tăng âm lượng Vocal & Clear hơn",
                        "set_track_mix",
                        Map.of("track_id", "vocal", "volume", 1.08, "mid_db", 2.0)
                ));
            }
            actions.add(new CoachSuggestedAction("trim_after_listen", "Chạy AI Auto-Trim Vocal", "auto_trim_vocal", Map.of()));
            actions.add(new CoachSuggestedAction("tune_after_listen", "Bật Auto-Tune mức Vừa", "apply_autotune", Map.of("preset", "balanced")));
        }

        // Route & Studio Mode Navigation
        if (normMsg.contains("settings") || normMsg.contains("cai dat") || normMsg.contains("nhap key")) {
            actions.add(new CoachSuggestedAction("nav_settings", "Mở Cài đặt API & Engine (/settings)", "navigate_route", Map.of("route", "/settings")));
        } else if (normMsg.contains("thu vien") || normMsg.contains("library") || normMsg.contains("danh sach bai")) {
            actions.add(new CoachSuggestedAction("nav_library", "Mở Kho Session (/library)", "navigate_route", Map.of("route", "/library")));
        } else if (normMsg.contains("trang tao") || normMsg.contains("thu mic") || normMsg.contains("upload file") || normMsg.contains("/create")) {
            actions.add(new CoachSuggestedAction("nav_create", "Mở AI Generator Wizard (/create)", "navigate_route", Map.of("route", "/create")));
        } else if (normMsg.contains("trang chu") || normMsg.contains("home")) {
            actions.add(new CoachSuggestedAction("nav_home", "Về Trang chủ (/)", "navigate_route", Map.of("route", "/")));
        } else if (normMsg.contains("mo studio") || normMsg.contains("vao studio") || normMsg.contains("phong thu")) {
            actions.add(new CoachSuggestedAction("nav_studio", "Mở Phòng thu DAW (/studio)", "navigate_route", Map.of("route", "/studio")));
        }

        if (normMsg.contains("quick") || normMsg.contains("che do nhanh") || normMsg.contains("che do gon")) {
            actions.add(new CoachSuggestedAction("mode_quick", "Chuyển sang Chế độ Quick", "switch_studio_mode", Map.of("studio_mode", "quick")));
        } else if (normMsg.contains("pro daw") || normMsg.contains("che do pro") || normMsg.contains("chuyen nghiep")) {
            actions.add(new CoachSuggestedAction("mode_pro", "Chuyển sang Chế độ Pro DAW", "switch_studio_mode", Map.of("studio_mode", "pro")));
        }

        // Transport, Loop, Metronome, Undo/Redo
        if (normMsg.contains("phat nhac") || normMsg.contains("nghe thu") || normMsg.equals("play") || normMsg.contains("bat nhac")) {
            actions.add(new CoachSuggestedAction("transport_play", "Phát nhạc ngay (Play)", "transport_control", Map.of("command", "play")));
        } else if (normMsg.contains("dung nhac") || normMsg.contains("tam dung") || normMsg.contains("stop")) {
            actions.add(new CoachSuggestedAction("transport_stop", "Dừng phát nhạc (Stop)", "transport_control", Map.of("command", "stop")));
        }
        if (normMsg.contains("vong lap") || normMsg.contains("loop")) {
            actions.add(new CoachSuggestedAction("transport_loop", "Bật/Tắt Lặp (Loop)", "transport_control", Map.of("command", "loop")));
        }
        if (normMsg.contains("metronome") || normMsg.contains("may dem nhip")) {
            actions.add(new CoachSuggestedAction("transport_metro", "Bật/Tắt Metronome", "transport_control", Map.of("command", "metronome")));
        }
        if (normMsg.contains("hoan tac") || normMsg.contains("undo") || normMsg.contains("quay lai buoc")) {
            actions.add(new CoachSuggestedAction("transport_undo", "Hoàn tác thao tác gần nhất (Undo)", "transport_control", Map.of("command", "undo")));
        } else if (normMsg.contains("redo") || normMsg.contains("lam lai")) {
            actions.add(new CoachSuggestedAction("transport_redo", "Làm lại (Redo)", "transport_control", Map.of("command", "redo")));
        }

        // Track Mix, EQ, Mute/Solo, Lock, Manage Track, Instruments, Grooves
        if (normMsg.contains("tat tieng") || normMsg.contains("mute")) {
            String t = detectTrackMention(normMsg, "drums");
            actions.add(new CoachSuggestedAction("mute_" + t, "Tắt tiếng track " + t.toUpperCase(Locale.ROOT), "set_track_mix", Map.of("track_id", t, "mute", true)));
        } else if (normMsg.contains("solo") || normMsg.contains("chi nghe")) {
            String t = detectTrackMention(normMsg, "vocal");
            actions.add(new CoachSuggestedAction("solo_" + t, "Solo chỉ nghe track " + t.toUpperCase(Locale.ROOT), "set_track_mix", Map.of("track_id", t, "solo", true)));
        }
        if (normMsg.contains("khoa track") || normMsg.contains("giu nguyen track") || normMsg.contains("lock")) {
            String t = detectTrackMention(normMsg, "vocal");
            actions.add(new CoachSuggestedAction("lock_" + t, "Khóa/Mở khóa track " + t.toUpperCase(Locale.ROOT), "manage_track", Map.of("operation", "toggle_lock", "track_id", t)));
        }
        if (normMsg.contains("them track") || normMsg.contains("them texture") || normMsg.contains("them kenh")) {
            actions.add(new CoachSuggestedAction("add_texture_track", "Thêm track Texture mới", "manage_track", Map.of("operation", "add", "track_id", "texture")));
        }
        if (normMsg.contains("doi tieng") || normMsg.contains("nhac cu") || normMsg.contains("flute") || normMsg.contains("warm pad") || normMsg.contains("guitar") || normMsg.contains("808") || normMsg.contains("synth bass")) {
            if (normMsg.contains("flute") || normMsg.contains("sao")) {
                actions.add(new CoachSuggestedAction("inst_flute", "Đổi Lead sang Sáo (Flute)", "manage_track", Map.of("operation", "set_instrument", "track_id", "lead", "instrument", "flute")));
            } else if (normMsg.contains("warm pad") || normMsg.contains("pad") || normMsg.contains("string")) {
                actions.add(new CoachSuggestedAction("inst_pad", "Đổi Harmony sang Warm Pad", "manage_track", Map.of("operation", "set_instrument", "track_id", "harmony", "instrument", "warm_pad")));
            } else if (normMsg.contains("synth bass") || normMsg.contains("808")) {
                actions.add(new CoachSuggestedAction("inst_808", "Đổi Bass sang Synth Bass", "manage_track", Map.of("operation", "set_instrument", "track_id", "bass", "instrument", "synth_bass")));
            } else {
                actions.add(new CoachSuggestedAction("inst_guitar", "Đổi Harmony sang Guitar Acoustic", "manage_track", Map.of("operation", "set_instrument", "track_id", "harmony", "instrument", "acoustic_guitar")));
            }
        }
        if (normMsg.contains("dieu trong") || normMsg.contains("groove") || (normMsg.contains("trong") && (normMsg.contains("trap") || normMsg.contains("lofi") || normMsg.contains("lo-fi") || normMsg.contains("edm") || normMsg.contains("pop")))) {
            String g = normMsg.contains("trap") ? "trap" : (normMsg.contains("lofi") || normMsg.contains("lo-fi")) ? "lofi" : normMsg.contains("edm") ? "edm" : "pop";
            actions.add(new CoachSuggestedAction("groove_" + g, "Nạp điệu trống " + g.toUpperCase(Locale.ROOT), "apply_drum_groove", Map.of("style", g)));
        }

        if (normMsg.contains("choi") || normMsg.contains("gat") || normMsg.contains("sibilan") || normMsg.contains("bright")) {
            actions.add(new CoachSuggestedAction(
                    "soften_vocal_high",
                    "Giảm High Vocal (-2.5 dB)",
                    "set_track_mix",
                    Map.of("track_id", "vocal", "high_db", -2.5)
            ));
        }
        if (normMsg.contains("kho") || normMsg.contains("reverb") || normMsg.contains("vang") || normMsg.contains("rong") || normMsg.contains("delay")) {
            actions.add(new CoachSuggestedAction(
                    "add_vocal_space",
                    "Thêm Hall Reverb & Delay nhẹ cho Vocal",
                    "set_track_mix",
                    Map.of("track_id", "vocal", "reverb_send", 0.28, "delay_send", 0.14)
            ));
        }
        if (normMsg.contains("bung") || normMsg.contains("u ") || normMsg.contains("duc") || normMsg.contains("muddy")) {
            actions.add(new CoachSuggestedAction(
                    "cut_harmony_low",
                    "Cắt Low Harmony (-2.5 dB) cho đỡ đục",
                    "set_track_mix",
                    Map.of("track_id", "harmony", "low_db", -2.5)
            ));
        }
        if (normMsg.contains("trim") || normMsg.contains("khoang lang") || normMsg.contains("cat dau")) {
            actions.add(new CoachSuggestedAction("run_auto_trim", "Chạy AI Auto-Trim Vocal", "auto_trim_vocal", Map.of()));
        }
        if (normMsg.contains("master") || normMsg.contains("lufs") || normMsg.contains("limiter") || normMsg.contains("lon tieng")) {
            actions.add(new CoachSuggestedAction("boost_master_lufs", "Đặt Mastering -12 LUFS & Limiter -1.0 dBFS", "set_mastering", Map.of("auto_mix_enabled", true, "target_lufs", -12.0, "limiter_ceiling_db", -1.0)));
        }

        // Rhythm, Structure, Bridge, Dynamics & Full Regen
        if (normMsg.contains("6/8")) {
            actions.add(new CoachSuggestedAction("switch_68_meter", "Chuyển nhịp 6/8 & mở Step Sequencer", "edit_structure_and_dynamics", Map.of("time_signature", "6/8")));
        } else if (normMsg.contains("3/4") || normMsg.contains("waltz")) {
            actions.add(new CoachSuggestedAction("switch_34_meter", "Chuyển nhịp 3/4 & mở Step Sequencer", "edit_structure_and_dynamics", Map.of("time_signature", "3/4")));
        } else if (normMsg.contains("4/4")) {
            actions.add(new CoachSuggestedAction("switch_44_meter", "Chuyển về nhịp chuẩn 4/4", "edit_structure_and_dynamics", Map.of("time_signature", "4/4")));
        }
        if (normMsg.contains("xoa bridge") || normMsg.contains("bo bridge")) {
            actions.add(new CoachSuggestedAction("del_bridge_section", "Xóa đoạn Bridge", "edit_structure_and_dynamics", Map.of("delete_section_name", "Bridge")));
        } else if (normMsg.contains("bridge") || normMsg.contains("them doan")) {
            actions.add(new CoachSuggestedAction(
                    "add_bridge_section",
                    "Thêm đoạn Bridge (4 ô nhịp)",
                    "edit_structure_and_dynamics",
                    Map.of("add_section_name", "Bridge", "section_bars", 4, "section_energy", 0.85)
            ));
        }
        if (normMsg.contains("cao trao") || normMsg.contains("nang luong") || normMsg.contains("dynamics")) {
            actions.add(new CoachSuggestedAction(
                    "boost_chorus_dynamics",
                    "Đẩy năng lượng Chorus lên 95%",
                    "edit_structure_and_dynamics",
                    Map.of("target_section", "Chorus", "section_energy", 0.95)
            ));
        }
        if (normMsg.contains("phoi lai toan bai") || normMsg.contains("tao lai bai") || normMsg.contains("regenerate song")) {
            actions.add(new CoachSuggestedAction("regen_full_song", "Phối lại toàn bộ bài hát bằng Multi-Agent", "regenerate_song", Map.of()));
        }

        String exportScan = normMsg.replace("de xuat", "").replace("san xuat", "");
        if (exportScan.contains("xuat") || normMsg.contains("tai file") || normMsg.contains("tai ve") || normMsg.contains("tai xuong")
                || normMsg.contains("export") || normMsg.contains("download") || normMsg.contains("mp3")
                || normMsg.contains("wav") || normMsg.contains("stems") || normMsg.contains("midi") || normMsg.contains("aimusic")) {
            String fmt = normMsg.contains("stems") ? "stems" : normMsg.contains("wav") ? "wav" : normMsg.contains("midi") ? "midi" : normMsg.contains("aimusic") ? "aimusic" : "mp3";
            actions.add(new CoachSuggestedAction(
                    "export_" + fmt,
                    "Xuất ngay file " + fmt.toUpperCase(Locale.ROOT),
                    "export_project",
                    Map.of("format", fmt, "bitrate", "320k")
            ));
        }

        if ("lyricist".equals(mode) || normMsg.contains("loi") || normMsg.contains("lyric") || normMsg.contains("viet")) {
            actions.add(new CoachSuggestedAction(
                    "suggest_lyrics_topic",
                    "AI Gợi ý lời (" + (cfg.getMood() != null ? cfg.getMood() : "Cảm xúc") + ")",
                    "suggest_lyrics",
                    Map.of("language", "vi", "section", "Chorus", "topic", cfg.getMood() != null ? cfg.getMood() : "Ký ức")
            ));
        }
        if (normMsg.contains("chorus") || normMsg.contains("verse") || normMsg.contains("doan") || normMsg.contains("cau truc")) {
            actions.add(new CoachSuggestedAction(
                    "set_motif_chorus",
                    "Đặt mô-típ làm Chorus",
                    "update_config",
                    Map.of("motif_position", "chorus", "output_mode", "full_song")
            ));
        }
        if ("arrangement".equals(mode) || normMsg.contains("buon") || normMsg.contains("sad") || normMsg.contains("hop am") || normMsg.contains("chord")) {
            actions.add(new CoachSuggestedAction(
                    "try_minor_rearrange",
                    "Đổi vòng hợp âm vi - IV - I - V",
                    "rearrange_chords",
                    Map.of("suggestion", "Use vi - IV - I - V progression")
            ));
            actions.add(new CoachSuggestedAction(
                    "try_pop_rearrange",
                    "Đổi vòng Pop C - G - Am - F",
                    "rearrange_chords",
                    Map.of("chords", List.of("C", "G", "Am", "F"))
            ));
        }
        if ("mix".equals(mode) || normMsg.contains("auto-tune") || normMsg.contains("autotune") || normMsg.contains("pho") || normMsg.contains("cao do") || normMsg.contains("tune")) {
            String tunePreset = normMsg.contains("hien dai") || normMsg.contains("robot") ? "modern"
                    : normMsg.contains("tu nhien") || normMsg.contains("nhe") ? "natural" : "balanced";
            actions.add(new CoachSuggestedAction(
                    "apply_" + tunePreset + "_tune",
                    "Bật Auto-Tune (" + tunePreset + ")",
                    "apply_autotune",
                    Map.of("preset", tunePreset)
            ));
        }
        if ("mix".equals(mode) || normMsg.contains("mix") || normMsg.contains("vo") || normMsg.contains("can bang") || normMsg.contains("nho") || normMsg.contains("eq")) {
            actions.add(new CoachSuggestedAction("run_auto_mix", "Chạy AI Auto-Mix (-1.0 dBFS)", "auto_mix", Map.of()));
            actions.add(new CoachSuggestedAction("open_mixer_tab", "Mở tab Console Mixer", "navigate_tab", Map.of("tab", "mixer")));
        }

        if (normMsg.contains("piano roll") || normMsg.contains("sua not")) {
            actions.add(new CoachSuggestedAction("open_piano_roll", "Mở tab Piano Roll", "navigate_tab", Map.of("tab", "piano_roll")));
        } else if (normMsg.contains("sequencer") || normMsg.contains("bang go trong")) {
            actions.add(new CoachSuggestedAction("open_seq_tab", "Mở tab Step Sequencer", "navigate_tab", Map.of("tab", "sequencer")));
        } else if (normMsg.contains("tab auto-tune") || normMsg.contains("tab tune")) {
            actions.add(new CoachSuggestedAction("open_tune_tab", "Mở tab Auto-Tune DSP", "navigate_tab", Map.of("tab", "autotune")));
        } else if (normMsg.contains("tab loi") || normMsg.contains("tab lyrics")) {
            actions.add(new CoachSuggestedAction("open_lyrics_tab", "Mở tab Lyrics & Karaoke", "navigate_tab", Map.of("tab", "lyrics")));
        }

        if (normMsg.contains("trong") || normMsg.contains("drum")) {
            actions.add(new CoachSuggestedAction("regen_drums", "Tạo lại track Drums", "regenerate_track", Map.of("target_track", "drums")));
        } else if (normMsg.contains("bass")) {
            actions.add(new CoachSuggestedAction("regen_bass", "Tạo lại track Bass", "regenerate_track", Map.of("target_track", "bass")));
        }
        if (normMsg.contains("nhanh") || normMsg.contains("faster")) {
            actions.add(new CoachSuggestedAction("boost_bpm_8", "Tăng +8 BPM", "update_config", Map.of("bpm", Math.min(220.0, analysis.getBpm() + 8.0))));
        } else if (normMsg.contains("cham") || normMsg.contains("slow")) {
            actions.add(new CoachSuggestedAction("slow_bpm_8", "Giảm -8 BPM", "update_config", Map.of("bpm", Math.max(40.0, analysis.getBpm() - 8.0))));
        }
        if (normMsg.contains("don cache") || normMsg.contains("xoa cache") || normMsg.contains("clear cache")) {
            actions.add(new CoachSuggestedAction("clear_be_cache", "Dọn Cache Backend Redis", "clear_cache", Map.of("scope", "backend")));
        }
        if (normMsg.contains("tach stem") || normMsg.contains("tach beat") || normMsg.contains("tach vocal") || normMsg.contains("separate stem")) {
            actions.add(new CoachSuggestedAction("sep_stems_act", "Tách Stem Vocal & Beat (HPSS)", "separate_stems", Map.of()));
        }
        if (normMsg.contains("automation") || normMsg.contains("fade out") || normMsg.contains("fade in") || normMsg.contains("quét filter") || normMsg.contains("quet filter") || normMsg.contains("loc tan") || normMsg.contains("cutoff")) {
            String autoParam = normMsg.contains("filter") || normMsg.contains("cutoff") || normMsg.contains("loc tan") ? "filter"
                    : normMsg.contains("pan") || normMsg.contains("trai phai") ? "pan"
                    : normMsg.contains("reverb") || normMsg.contains("vang") ? "reverb" : "volume";
            List<Map<String, Object>> pts = normMsg.contains("fade out")
                    ? List.of(Map.of("bar", 1, "value", 1.0), Map.of("bar", 5, "value", 0.9), Map.of("bar", 8, "value", 0.1))
                    : List.of(Map.of("bar", 1, "value", 0.45), Map.of("bar", 5, "value", 0.95), Map.of("bar", 8, "value", 0.8));
            actions.add(new CoachSuggestedAction(
                    "auto_curve_" + autoParam,
                    "Vẽ Automation Curve (" + autoParam + ")",
                    "set_automation",
                    Map.of("track_id", detectTrackMention(normMsg, "vocal"), "parameter", autoParam, "points", pts)
            ));
        }
        if (normMsg.contains("test api") || normMsg.contains("kiem tra he thong") || normMsg.contains("health") || normMsg.contains("api key")) {
            actions.add(new CoachSuggestedAction("run_llm_diag", "Kiểm tra API Key & Hệ thống", "test_health", Map.of()));
        }

        if (broadAudit || actions.isEmpty()) {
            appendProjectAuditRecommendations(actions, route, projectState, analysis, cfg, extraContext);
        }

        // Deduplicate & keep up to 8 diverse recommendations on broad audits or 6 on focused asks
        int cap = broadAudit ? 8 : 6;
        Map<String, CoachSuggestedAction> unique = new LinkedHashMap<>();
        for (CoachSuggestedAction a : actions) {
            unique.putIfAbsent(a.getId(), a);
            if (unique.size() >= cap) break;
        }
        actions.clear();
        actions.addAll(unique.values());
    }

    private static String buildContextAwareMockReply(
            String mode,
            String lowerMsg,
            String route,
            ProjectState projectState,
            ProjectAnalysis analysis,
            ProjectConfig cfg,
            int lyricCount,
            List<String> chordSyms,
            Map<String, TrackState> tracks,
            String playbookContext,
            Map<String, Object> extraContext,
            AudioTelemetry audioTelemetry
    ) {
        String normMsg = normText(lowerMsg);
        String keyScale = analysis.getDetectedKey() + " " + analysis.getDetectedScale();
        String chordsStr = chordSyms.isEmpty() ? "chưa có hợp âm" : String.join(" - ", chordSyms.subList(0, Math.min(4, chordSyms.size())));

        if (audioTelemetry != null) {
            String healthDesc = audioTelemetry.clipping()
                    ? "tín hiệu đang bị quá ngưỡng (> -1.0 dBFS, dễ vỡ)"
                    : audioTelemetry.tooQuiet()
                    ? "âm lượng hơi nhỏ (RMS < -34 dBFS)"
                    : "độ động cân bằng tốt";
            return String.format(Locale.ROOT,
                    "[Audio Telemetry • %.1fs] Tôi đã kiểm tra bản audio bạn đính kèm: đỉnh %.1f dBFS, mức trung bình %.1f dBFS — %s. Bạn có thể bấm các nút bên dưới để chỉnh Volume/EQ, Auto-Trim hoặc bật Auto-Tune ngay.",
                    audioTelemetry.durationSec(), audioTelemetry.peakDbfs(), audioTelemetry.rmsDbfs(), healthDesc);
        }

        if (extraContext != null && extraContext.get("fit_check") instanceof Map<?, ?> fc
                && (normMsg.contains("overdub") || normMsg.contains("thu de") || normMsg.contains("lech") || normMsg.contains("fit"))) {
            return String.format(Locale.ROOT,
                    "[Overdub Fit Check] Bản thu đè gần nhất đang lệch %s ms (%s). Bạn có thể bấm 1-Click Fix ở banner trên hoặc dùng Auto-Mix & Auto-Tune bên dưới để làm khớp tức thì.",
                    fc.get("timing_offset_ms"), fc.get("gain_suggestion"));
        }

        if (isBroadAuditPrompt(normMsg)) {
            TrackState vocal = tracks != null ? tracks.get("vocal") : null;
            AutotuneSettings tune = projectState.getAutotuneSettings();
            String tuneLabel = (tune != null && tune.isEnabled() && !"off".equalsIgnoreCase(tune.getPreset()))
                    ? tune.getPreset() : "chưa bật";
            int sectionCount = projectState.getSongStructure() != null && projectState.getSongStructure().getSections() != null
                    ? projectState.getSongStructure().getSections().size() : 0;
            return String.format(Locale.ROOT,
                    "[Toàn bộ Khả năng & Đề xuất cho Dự án %s • %s %.0f BPM (%s)]\n"
                            + "• Tình trạng hiện tại: %d section, hợp âm (%s), %d câu lời, Auto-Tune [%s], Vocal EQ %.0f/%.0f/%.0f dB (Reverb %.0f%%).\n"
                            + "• Tôi có thể làm mọi thao tác an toàn cho bạn (kèm Hoàn tác 1 chạm): Tạo project mẫu, Chuyển trang/Tab & Quick/Pro, Điều khiển Play/Stop/Loop/Undo/Redo, Đổi BPM/Key/Nhịp (4/4|3/4|6/8), Thêm/Xóa Section & kéo Dynamics, Đổi hợp âm & Điệu trống (Pop/Trap/Lo-fi/EDM), Thêm/Khóa Track & Đổi nhạc cụ, Chỉnh Mix/3-Band EQ/FX/Auto-Mix/Mastering LUFS, Bật Auto-Tune Pro, Sáng tác/Sửa lời, Nghe audio WAV/Mic, Xuất WAV/MP3/Stems/MIDI/.aimusic và Chẩn đoán API Key.\n"
                            + "• Bấm 'Áp dụng tất cả' hoặc chọn từng đề xuất tối ưu nhất bên dưới để thực thi ngay!",
                    cfg.getGenre(), keyScale, analysis.getBpm(),
                    analysis.getTimeSignature() != null ? analysis.getTimeSignature() : "4/4",
                    sectionCount, chordsStr, lyricCount, tuneLabel,
                    vocal != null ? vocal.getLowDb() : 0.0,
                    vocal != null ? vocal.getMidDb() : 0.0,
                    vocal != null ? vocal.getHighDb() : 0.0,
                    vocal != null ? vocal.getReverbSend() * 100 : 0.0);
        }

        if (normMsg.contains("lam sao") || normMsg.contains("cach") || normMsg.contains("huong dan") || normMsg.contains("404") || normMsg.contains("503") || normMsg.contains("loi") || route.startsWith("/settings")) {
            return "Hướng dẫn nhanh theo Playbook DAW:\n" + playbookContext;
        }

        if (route.equals("/") || route.startsWith("/library")) {
            return "Bạn đang ở khu vực quản lý dự án. Tôi có thể tạo ngay Starter Template (Pop/Lo-fi/Trap/EDM/Ballad), mở nhanh /create để thu Mic, kiểm tra hệ thống /settings, hoặc bạn bấm các nút đề xuất ngay bên dưới!";
        }

        TrackState vocal = tracks != null ? tracks.get("vocal") : null;
        return switch (mode) {
            case "lyricist" -> String.format(Locale.ROOT,
                    "[Lyricist • %s %.0f BPM] Bài hiện có %d câu lời (%s, %s). Bạn nên giữ câu hook 6–10 âm tiết lặp ở Chorus và dùng nút bên dưới để AI viết/cập nhật thẳng vào Lyrics & Karaoke.",
                    keyScale, analysis.getBpm(), lyricCount, cfg.getGenre(), chordsStr);
            case "arrangement" -> String.format(Locale.ROOT,
                    "[Arrangement • %s %.0f BPM] Vòng hợp âm (%s) cho %s. Bạn có thể đổi vòng hợp âm, chọn điệu trống (Pop/Trap/Lo-fi/EDM), đổi nhạc cụ, chuyển nhịp 3/4 hoặc 6/8, hay thêm Bridge & nâng cao trào Chorus.",
                    keyScale, analysis.getBpm(), chordsStr, cfg.getGenre());
            case "mix" -> String.format(Locale.ROOT,
                    "[Mix & Mastering • %.0f BPM] Vocal đang đặt Volume %d%% (EQ %.0f/%.0f/%.0f dB, Reverb %.0f%%). Tôi có thể cắt chói/đục, thêm Reverb/Delay, Mute/Solo từng track, chạy Auto-Trim, Auto-Tune & Auto-Mix (-1.0 dBFS).",
                    analysis.getBpm(),
                    vocal != null ? Math.round(vocal.getVolume() * 100) : 95,
                    vocal != null ? vocal.getLowDb() : 0.0,
                    vocal != null ? vocal.getMidDb() : 0.0,
                    vocal != null ? vocal.getHighDb() : 0.0,
                    vocal != null ? vocal.getReverbSend() * 100 : 0.0);
            default -> String.format(Locale.ROOT,
                    "Dự án %s (%s, %.0f BPM, hợp âm %s, %d câu lời): hãy gõ 'Đề xuất mọi thứ' để tôi kiểm tra toàn diện, hoặc ra lệnh bất kỳ (chỉnh EQ/FX, đổi nhạc cụ/điệu trống, thêm Bridge, viết lời, phát/dừng nhạc, chuyển trang, xuất MP3/WAV/Stems/MIDI).",
                    cfg.getGenre(), keyScale, analysis.getBpm(), chordsStr, lyricCount);
        };
    }

    private static final List<Map<String, Object>> TOOL_DECLARATIONS = List.of(
            toolDecl("set_track_mix", "Adjust track volume, pan, mute, solo, locked, instrument, 3-band EQ, or reverb/delay send FX",
                    Map.ofEntries(
                            Map.entry("track_id", Map.of("type", "STRING", "description", "vocal|texture|drums|bass|harmony|lead")),
                            Map.entry("volume", Map.of("type", "NUMBER", "description", "0.0 to 1.2")),
                            Map.entry("pan", Map.of("type", "NUMBER", "description", "-1.0 to 1.0")),
                            Map.entry("low_db", Map.of("type", "NUMBER", "description", "-12 to 12")),
                            Map.entry("mid_db", Map.of("type", "NUMBER", "description", "-12 to 12")),
                            Map.entry("high_db", Map.of("type", "NUMBER", "description", "-12 to 12")),
                            Map.entry("reverb_send", Map.of("type", "NUMBER", "description", "0.0 to 1.0")),
                            Map.entry("delay_send", Map.of("type", "NUMBER", "description", "0.0 to 1.0")),
                            Map.entry("instrument", Map.of("type", "STRING", "description", "Preset name if MIDI track")),
                            Map.entry("mute", Map.of("type", "BOOLEAN")),
                            Map.entry("solo", Map.of("type", "BOOLEAN")),
                            Map.entry("locked", Map.of("type", "BOOLEAN"))
                    ), List.of("track_id")),
            toolDecl("manage_track", "Add a track (e.g. texture/harmony/lead), clear notes/clips, remove optional track, toggle lock, or swap instrument",
                    Map.of(
                            "operation", Map.of("type", "STRING", "description", "add|clear|remove|toggle_lock|set_instrument"),
                            "track_id", Map.of("type", "STRING", "description", "vocal|texture|drums|bass|harmony|lead"),
                            "instrument", Map.of("type", "STRING", "description", "grand_piano|electric_piano|acoustic_guitar|warm_pad|strings|flute|synth_lead|finger_bass|upright_bass|synth_bass|acoustic_kit|lofi_kit|electronic_808"),
                            "locked", Map.of("type", "BOOLEAN")
                    ), List.of("operation", "track_id")),
            toolDecl("apply_drum_groove", "Load a drum pattern preset matching current time signature and bars",
                    Map.of("style", Map.of("type", "STRING", "description", "pop|trap|lofi|edm|clear")),
                    List.of("style")),
            toolDecl("edit_structure_and_dynamics", "Adjust time signature (4/4, 3/4, 6/8), total_bars (4-32), section energy (0.1-1.0), add or delete a section",
                    Map.of(
                            "time_signature", Map.of("type", "STRING", "description", "4/4|3/4|6/8"),
                            "total_bars", Map.of("type", "INTEGER", "description", "4 to 32"),
                            "target_section", Map.of("type", "STRING", "description", "Existing section name e.g. Chorus"),
                            "section_energy", Map.of("type", "NUMBER", "description", "0.1 to 1.0"),
                            "add_section_name", Map.of("type", "STRING", "description", "New section name e.g. Bridge"),
                            "delete_section_name", Map.of("type", "STRING", "description", "Existing section to remove e.g. Bridge"),
                            "section_bars", Map.of("type", "INTEGER", "description", "Bar count e.g. 4")
                    ), List.of()),
            toolDecl("update_lyrics_lines", "Replace or append specific lyric lines cleanly",
                    Map.of(
                            "append", Map.of("type", "BOOLEAN", "description", "true to append to existing lines, false/omit to replace"),
                            "lines", Map.of("type", "ARRAY", "items", Map.of(
                                    "type", "OBJECT",
                                    "properties", Map.of(
                                            "section", Map.of("type", "STRING"),
                                            "bar", Map.of("type", "INTEGER"),
                                            "text", Map.of("type", "STRING")
                                    )
                            ))
                    ), List.of("lines")),
            toolDecl("suggest_lyrics", "Generate new AI lyrics matching melody & rhythm",
                    Map.of("language", Map.of("type", "STRING"), "topic", Map.of("type", "STRING"), "section", Map.of("type", "STRING")),
                    List.of()),
            toolDecl("rearrange_chords", "Update chord progression and re-arrange unlocked backing tracks",
                    Map.of("suggestion", Map.of("type", "STRING"), "chords", Map.of("type", "ARRAY", "items", Map.of("type", "STRING"))),
                    List.of()),
            toolDecl("apply_autotune", "Apply vocal Auto-Tune preset and settings",
                    Map.of("preset", Map.of("type", "STRING", "description", "off|natural|balanced|modern"),
                            "retune_speed_ms", Map.of("type", "NUMBER"),
                            "humanize", Map.of("type", "NUMBER"),
                            "mix_percent", Map.of("type", "NUMBER"),
                            "auto_follow_project_key", Map.of("type", "BOOLEAN")),
                    List.of("preset")),
            toolDecl("auto_mix", "Run AI Auto-Mix balancing gain, vocal carve 2.2kHz, and -1.0 dBFS limiter", Map.of(), List.of()),
            toolDecl("auto_trim_vocal", "Auto-trim silence and align vocal clip timing", Map.of(), List.of()),
            toolDecl("set_mastering", "Update Mastering Limiter ceiling (<= -1.0 dBFS) and target LUFS (-20 to -8)",
                    Map.of("auto_mix_enabled", Map.of("type", "BOOLEAN"),
                            "target_lufs", Map.of("type", "NUMBER"),
                            "limiter_ceiling_db", Map.of("type", "NUMBER")),
                    List.of()),
            toolDecl("regenerate_track", "Regenerate a single unlocked MIDI track",
                    Map.of("target_track", Map.of("type", "STRING", "description", "drums|bass|harmony|lead")), List.of("target_track")),
            toolDecl("regenerate_song", "Re-run full Multi-Agent composition pipeline for the entire project",
                    Map.of("genre", Map.of("type", "STRING"), "mood", Map.of("type", "STRING"),
                            "output_mode", Map.of("type", "STRING"), "melody_mode", Map.of("type", "STRING"),
                            "structure_preset", Map.of("type", "STRING")),
                    List.of()),
            toolDecl("update_config", "Update BPM, Key, Scale, Genre, Mood, Output Mode, Structure Preset, or Motif Position",
                    Map.of("bpm", Map.of("type", "NUMBER"), "key", Map.of("type", "STRING"), "scale", Map.of("type", "STRING"),
                            "genre", Map.of("type", "STRING"), "mood", Map.of("type", "STRING"),
                            "motif_position", Map.of("type", "STRING"), "output_mode", Map.of("type", "STRING"),
                            "structure_preset", Map.of("type", "STRING")),
                    List.of()),
            toolDecl("transport_control", "Control DAW playback or undo/redo history",
                    Map.of("command", Map.of("type", "STRING", "description", "play|stop|pause|loop|metronome|undo|redo")),
                    List.of("command")),
            toolDecl("navigate_tab", "Switch bottom dock tab in Studio",
                    Map.of("tab", Map.of("type", "STRING", "description", "sequencer|piano_roll|mixer|autotune|lyrics")), List.of("tab")),
            toolDecl("navigate_route", "Navigate to any application screen",
                    Map.of("route", Map.of("type", "STRING", "description", "/|/create|/library|/settings|/studio")), List.of("route")),
            toolDecl("switch_studio_mode", "Toggle between Quick preview mode and Pro DAW workstation",
                    Map.of("studio_mode", Map.of("type", "STRING", "description", "quick|pro")), List.of("studio_mode")),
            toolDecl("create_template", "Create a new starter DAW project and open Studio",
                    Map.of("genre", Map.of("type", "STRING", "description", "Pop|Lo-fi|Hip-hop|EDM|Ballad")), List.of("genre")),
            toolDecl("export_project", "Export audio, stems, MIDI, or .aimusic bundle",
                    Map.of("format", Map.of("type", "STRING", "description", "wav|mp3|stems|midi|aimusic"), "bitrate", Map.of("type", "STRING")),
                    List.of("format")),
            toolDecl("test_health", "Run backend, Redis, Audio Worker, and LLM API Key diagnostic test", Map.of(), List.of()),
            toolDecl("clear_cache", "Clear temporary backend Redis cache or browser IndexedDB drafts",
                    Map.of("scope", Map.of("type", "STRING", "description", "backend|local")), List.of("scope")),
            toolDecl("separate_stems", "Separate uploaded or project audio into synchronized Vocal and Beat/Instrumental clips",
                    Map.of("source_ref", Map.of("type", "STRING", "description", "Optional mem:// ref")), List.of()),
            toolDecl("set_automation", "Set multi-parameter Web Audio automation keyframes (volume|pan|filter|reverb) on a track",
                    Map.of(
                            "track_id", Map.of("type", "STRING", "description", "vocal|texture|drums|bass|harmony|lead"),
                            "parameter", Map.of("type", "STRING", "description", "volume|pan|filter|reverb"),
                            "points", Map.of("type", "ARRAY", "items", Map.of(
                                    "type", "OBJECT",
                                    "properties", Map.of(
                                            "bar", Map.of("type", "NUMBER"),
                                            "value", Map.of("type", "NUMBER")
                                    )
                            ))
                    ), List.of("track_id", "parameter", "points"))
    );

    private static Map<String, Object> toolDecl(String name, String description, Map<String, Object> properties, List<String> required) {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "OBJECT");
        schema.put("properties", properties);
        if (required != null && !required.isEmpty()) {
            schema.put("required", required);
        }
        return Map.of("name", name, "description", description, "parameters", schema);
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
