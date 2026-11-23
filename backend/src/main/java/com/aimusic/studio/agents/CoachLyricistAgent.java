package com.aimusic.studio.agents;

import com.aimusic.studio.audio.JavaAudioFallbackService;
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
            buildHeuristicActions(actions, mode, lowerMsg, safeRoute, analysis, cfg, extraContext, audioTelemetry);
        }

        if (toolResp.isMock()) {
            reply = buildContextAwareMockReply(
                    mode, lowerMsg, safeRoute, analysis, cfg, lyricLines.size(), chordSyms, projectState.getTracks(), playbookContext, extraContext, audioTelemetry);
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
            case "edit_structure_and_dynamics" -> "Cập nhật Cấu trúc & Dynamics";
            case "update_lyrics_lines" -> "Áp dụng chỉnh sửa lời bài hát";
            case "suggest_lyrics" -> "AI Gợi ý lời bài hát";
            case "rearrange_chords" -> "Đổi vòng hợp âm & Đồng bộ đệm";
            case "apply_autotune" -> "Áp dụng Auto-Tune (" + args.getOrDefault("preset", "balanced") + ")";
            case "auto_mix" -> "Chạy AI Auto-Mix (-1.0 dBFS)";
            case "auto_trim_vocal" -> "Chạy AI Auto-Trim Vocal";
            case "regenerate_track" -> "Tạo lại track " + args.getOrDefault("target_track", "drums");
            case "navigate_tab" -> "Mở tab " + args.getOrDefault("tab", "mixer");
            case "create_template" -> "Tạo Project mẫu " + args.getOrDefault("genre", "Pop");
            case "export_project" -> "Xuất file " + String.valueOf(args.getOrDefault("format", "mp3")).toUpperCase(Locale.ROOT);
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

    private static void buildHeuristicActions(
            List<CoachSuggestedAction> actions,
            String mode,
            String lowerMsg,
            String route,
            ProjectAnalysis analysis,
            ProjectConfig cfg,
            Map<String, Object> extraContext,
            AudioTelemetry audioTelemetry
    ) {
        boolean onHomeOrLibrary = route.equals("/") || route.startsWith("/library");
        if (onHomeOrLibrary && (lowerMsg.contains("tạo") || lowerMsg.contains("beat") || lowerMsg.contains("mẫu") || lowerMsg.contains("lo-fi") || lowerMsg.contains("trap") || lowerMsg.contains("pop") || lowerMsg.contains("ballad"))) {
            String tplGenre = lowerMsg.contains("trap") ? "Hip-hop"
                    : lowerMsg.contains("lo-fi") || lowerMsg.contains("lofi") ? "Lo-fi"
                    : lowerMsg.contains("ballad") ? "Ballad"
                    : lowerMsg.contains("edm") || lowerMsg.contains("house") ? "EDM" : "Pop";
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
                        "Giảm Gain Vocal & Auto-Mix (-1.0 dBFS)",
                        "set_track_mix",
                        Map.of("track_id", "vocal", "volume", 0.78, "high_db", -1.5)
                ));
            } else if (audioTelemetry.tooQuiet()) {
                actions.add(new CoachSuggestedAction(
                        "boost_vocal_gain",
                        "Tăng âm lượng Vocal & Chạy Auto-Trim",
                        "set_track_mix",
                        Map.of("track_id", "vocal", "volume", 1.08, "mid_db", 2.0)
                ));
            }
            actions.add(new CoachSuggestedAction(
                    "tune_after_listen",
                    "Bật Auto-Tune mức Vừa",
                    "apply_autotune",
                    Map.of("preset", "balanced")
            ));
        }

        if (lowerMsg.contains("chói") || lowerMsg.contains("gắt") || lowerMsg.contains("sibilan") || lowerMsg.contains("bright")) {
            actions.add(new CoachSuggestedAction(
                    "soften_vocal_high",
                    "Giảm High Vocal (-2.5 dB)",
                    "set_track_mix",
                    Map.of("track_id", "vocal", "high_db", -2.5)
            ));
        }
        if (lowerMsg.contains("khô") || lowerMsg.contains("reverb") || lowerMsg.contains("vang") || lowerMsg.contains("rộng")) {
            actions.add(new CoachSuggestedAction(
                    "add_vocal_space",
                    "Thêm Hall Reverb & Delay nhẹ cho Vocal",
                    "set_track_mix",
                    Map.of("track_id", "vocal", "reverb_send", 0.28, "delay_send", 0.14)
            ));
        }
        if (lowerMsg.contains("bùng") || lowerMsg.contains("ù") || lowerMsg.contains("đục") || lowerMsg.contains("muddy")) {
            actions.add(new CoachSuggestedAction(
                    "cut_harmony_low",
                    "Cắt Low Harmony (-2.5 dB) cho đỡ đục",
                    "set_track_mix",
                    Map.of("track_id", "harmony", "low_db", -2.5)
            ));
        }
        if (lowerMsg.contains("6/8")) {
            actions.add(new CoachSuggestedAction(
                    "switch_68_meter",
                    "Chuyển nhịp 6/8 & mở Step Sequencer",
                    "edit_structure_and_dynamics",
                    Map.of("time_signature", "6/8")
            ));
        }
        if (lowerMsg.contains("bridge") || lowerMsg.contains("thêm đoạn")) {
            actions.add(new CoachSuggestedAction(
                    "add_bridge_section",
                    "Thêm đoạn Bridge (4 ô nhịp)",
                    "edit_structure_and_dynamics",
                    Map.of("add_section_name", "Bridge", "section_bars", 4, "section_energy", 0.85)
            ));
        }
        if (lowerMsg.contains("cao trào") || lowerMsg.contains("năng lượng") || lowerMsg.contains("dynamics")) {
            actions.add(new CoachSuggestedAction(
                    "boost_chorus_dynamics",
                    "Đẩy năng lượng Chorus lên 95%",
                    "edit_structure_and_dynamics",
                    Map.of("target_section", "Chorus", "section_energy", 0.95)
            ));
        }
        if (lowerMsg.contains("xuất") || lowerMsg.contains("tải") || lowerMsg.contains("export") || lowerMsg.contains("mp3") || lowerMsg.contains("wav") || lowerMsg.contains("stems")) {
            String fmt = lowerMsg.contains("stems") ? "stems" : lowerMsg.contains("wav") ? "wav" : lowerMsg.contains("midi") ? "midi" : "mp3";
            actions.add(new CoachSuggestedAction(
                    "export_" + fmt,
                    "Xuất ngay file " + fmt.toUpperCase(Locale.ROOT),
                    "export_project",
                    Map.of("format", fmt, "bitrate", "320k")
            ));
        }

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
            actions.add(new CoachSuggestedAction(
                    "open_mixer_tab",
                    "Mở tab Console Mixer",
                    "navigate_tab",
                    Map.of("tab", "mixer")
            ));
        }
        if (lowerMsg.contains("piano roll") || lowerMsg.contains("sửa nốt")) {
            actions.add(new CoachSuggestedAction("open_piano_roll", "Mở tab Piano Roll", "navigate_tab", Map.of("tab", "piano_roll")));
        }
        if (lowerMsg.contains("trống") || lowerMsg.contains("drum")) {
            actions.add(new CoachSuggestedAction("regen_drums", "Tạo lại track Drums", "regenerate_track", Map.of("target_track", "drums")));
        } else if (lowerMsg.contains("bass")) {
            actions.add(new CoachSuggestedAction("regen_bass", "Tạo lại track Bass", "regenerate_track", Map.of("target_track", "bass")));
        }
        if (lowerMsg.contains("nhanh") || lowerMsg.contains("faster")) {
            actions.add(new CoachSuggestedAction("boost_bpm_8", "Tăng +8 BPM", "update_config", Map.of("bpm", Math.min(220.0, analysis.getBpm() + 8.0))));
        } else if (lowerMsg.contains("chậm") || lowerMsg.contains("slow")) {
            actions.add(new CoachSuggestedAction("slow_bpm_8", "Giảm -8 BPM", "update_config", Map.of("bpm", Math.max(40.0, analysis.getBpm() - 8.0))));
        }

        if (actions.isEmpty()) {
            if (route.startsWith("/settings")) {
                actions.add(new CoachSuggestedAction("run_llm_diag", "Kiểm tra API Key & Hệ thống", "test_health", Map.of()));
            } else if (onHomeOrLibrary) {
                actions.add(new CoachSuggestedAction("open_pop_template", "Khởi tạo nhanh Pop DAW", "create_template", Map.of("genre", "Pop")));
            } else {
                actions.add(new CoachSuggestedAction("run_auto_mix_default", "Chạy AI Auto-Mix", "auto_mix", Map.of()));
                actions.add(new CoachSuggestedAction("suggest_lyrics_default", "Gợi ý lời nhanh", "suggest_lyrics", Map.of("language", "vi", "section", "Chorus")));
            }
        }

        // Deduplicate & cap heuristic chips cleanly to max 4 buttons
        Map<String, CoachSuggestedAction> unique = new LinkedHashMap<>();
        for (CoachSuggestedAction a : actions) {
            unique.putIfAbsent(a.getId(), a);
            if (unique.size() >= 4) break;
        }
        actions.clear();
        actions.addAll(unique.values());
    }

    private static String buildContextAwareMockReply(
            String mode,
            String lowerMsg,
            String route,
            ProjectAnalysis analysis,
            ProjectConfig cfg,
            int lyricCount,
            List<String> chordSyms,
            Map<String, TrackState> tracks,
            String playbookContext,
            Map<String, Object> extraContext,
            AudioTelemetry audioTelemetry
    ) {
        String keyScale = analysis.getDetectedKey() + " " + analysis.getDetectedScale();
        String chordsStr = chordSyms.isEmpty() ? "chưa có hợp âm" : String.join(" - ", chordSyms.subList(0, Math.min(4, chordSyms.size())));

        if (audioTelemetry != null) {
            String healthDesc = audioTelemetry.clipping()
                    ? "tín hiệu đang bị quá ngưỡng (> -1.0 dBFS, dễ vỡ)"
                    : audioTelemetry.tooQuiet()
                    ? "âm lượng hơi nhỏ (RMS < -34 dBFS)"
                    : "độ động cân bằng tốt";
            return String.format(Locale.ROOT,
                    "[Audio Telemetry • %.1fs] Tôi đã kiểm tra bản audio bạn đính kèm: đỉnh %.1f dBFS, mức trung bình %.1f dBFS — %s. Bạn có thể bấm các nút bên dưới để chỉnh Volume/EQ hoặc bật Auto-Tune ngay.",
                    audioTelemetry.durationSec(), audioTelemetry.peakDbfs(), audioTelemetry.rmsDbfs(), healthDesc);
        }

        if (extraContext != null && extraContext.get("fit_check") instanceof Map<?, ?> fc
                && (lowerMsg.contains("overdub") || lowerMsg.contains("thu đè") || lowerMsg.contains("lệch") || lowerMsg.contains("fit"))) {
            return String.format(Locale.ROOT,
                    "[Overdub Fit Check] Bản thu đè gần nhất đang lệch %s ms (%s). Bạn có thể bấm 1-Click Fix ở banner trên hoặc dùng Auto-Mix & Auto-Tune bên dưới để làm khớp tức thì.",
                    fc.get("timing_offset_ms"), fc.get("gain_suggestion"));
        }

        if (lowerMsg.contains("làm sao") || lowerMsg.contains("cách") || lowerMsg.contains("hướng dẫn") || lowerMsg.contains("404") || lowerMsg.contains("503") || lowerMsg.contains("lỗi") || route.startsWith("/settings")) {
            return "Hướng dẫn nhanh theo Playbook DAW:\n" + playbookContext;
        }

        if (route.equals("/") || route.startsWith("/library")) {
            return "Bạn đang ở khu vực quản lý dự án. Hãy mô tả thể loại & BPM bạn muốn (VD: 'Tạo bài Lo-fi nhẹ' hoặc 'Tạo beat Trap'), hoặc bấm nút bên dưới để tôi mở sẵn phiên DAW cho bạn!";
        }

        TrackState vocal = tracks != null ? tracks.get("vocal") : null;
        return switch (mode) {
            case "lyricist" -> String.format(Locale.ROOT,
                    "[Lyricist • %s %.0f BPM] Bài hiện có %d câu lời (%s, %s). Bạn nên giữ câu hook 6–10 âm tiết lặp ở Chorus và dùng nút bên dưới để AI viết/cập nhật thẳng vào Lyrics & Karaoke.",
                    keyScale, analysis.getBpm(), lyricCount, cfg.getGenre(), chordsStr);
            case "arrangement" -> String.format(Locale.ROOT,
                    "[Arrangement • %s %.0f BPM] Vòng hợp âm (%s) cho %s. Bạn có thể đổi sang vòng vi - IV - I - V, chuyển nhịp 6/8 hoặc kéo chấm Dynamics Envelope để nâng cao trào Chorus.",
                    keyScale, analysis.getBpm(), chordsStr, cfg.getGenre());
            case "mix" -> String.format(Locale.ROOT,
                    "[Mix & Mastering • %.0f BPM] Vocal đang đặt Volume %d%% (EQ %.0f/%.0f/%.0f dB, Reverb %.0f%%). Đề xuất cắt bớt dải trầm ở Harmony nếu hơi đục, giữ High Vocal vừa phải và chạy Auto-Mix (<= -1.0 dBFS).",
                    analysis.getBpm(),
                    vocal != null ? Math.round(vocal.getVolume() * 100) : 95,
                    vocal != null ? vocal.getLowDb() : 0.0,
                    vocal != null ? vocal.getMidDb() : 0.0,
                    vocal != null ? vocal.getHighDb() : 0.0,
                    vocal != null ? vocal.getReverbSend() * 100 : 0.0);
            default -> String.format(Locale.ROOT,
                    "Dự án %s (%s, %.0f BPM, hợp âm %s, %d câu lời): tôi có thể hỗ trợ chỉnh EQ/Mix từng kênh, đổi hợp âm, viết lời, chỉnh Dynamics Envelope hoặc xuất file MP3/WAV/Stems giúp bạn.",
                    cfg.getGenre(), keyScale, analysis.getBpm(), chordsStr, lyricCount);
        };
    }

    private static final List<Map<String, Object>> TOOL_DECLARATIONS = List.of(
            toolDecl("set_track_mix", "Adjust track volume, pan, mute, solo, instrument, 3-band EQ, or reverb/delay send FX",
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
                            Map.entry("solo", Map.of("type", "BOOLEAN"))
                    ), List.of("track_id")),
            toolDecl("edit_structure_and_dynamics", "Adjust time signature (4/4, 3/4, 6/8), update section energy (0.1-1.0), or add a section",
                    Map.of(
                            "time_signature", Map.of("type", "STRING", "description", "4/4|3/4|6/8"),
                            "target_section", Map.of("type", "STRING", "description", "Existing section name e.g. Chorus"),
                            "section_energy", Map.of("type", "NUMBER", "description", "0.1 to 1.0"),
                            "add_section_name", Map.of("type", "STRING", "description", "New section name e.g. Bridge"),
                            "section_bars", Map.of("type", "INTEGER", "description", "Bar count e.g. 4")
                    ), List.of()),
            toolDecl("update_lyrics_lines", "Replace or append specific lyric lines cleanly",
                    Map.of(
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
                            "mix_percent", Map.of("type", "NUMBER")),
                    List.of("preset")),
            toolDecl("auto_mix", "Run AI Auto-Mix balancing gain, vocal carve 2.2kHz, and -1.0 dBFS limiter", Map.of(), List.of()),
            toolDecl("auto_trim_vocal", "Auto-trim silence and align vocal clip timing", Map.of(), List.of()),
            toolDecl("regenerate_track", "Regenerate a single unlocked MIDI track",
                    Map.of("target_track", Map.of("type", "STRING", "description", "drums|bass|harmony|lead")), List.of("target_track")),
            toolDecl("update_config", "Update BPM, Key, Scale, Genre, Mood, Output Mode, or Motif Position",
                    Map.of("bpm", Map.of("type", "NUMBER"), "key", Map.of("type", "STRING"), "scale", Map.of("type", "STRING"),
                            "genre", Map.of("type", "STRING"), "mood", Map.of("type", "STRING"),
                            "motif_position", Map.of("type", "STRING"), "output_mode", Map.of("type", "STRING")),
                    List.of()),
            toolDecl("navigate_tab", "Switch bottom dock tab in Studio",
                    Map.of("tab", Map.of("type", "STRING", "description", "sequencer|piano_roll|mixer|autotune|lyrics")), List.of("tab")),
            toolDecl("create_template", "Create a new starter DAW project and open Studio",
                    Map.of("genre", Map.of("type", "STRING", "description", "Pop|Lo-fi|Hip-hop|EDM|Ballad")), List.of("genre")),
            toolDecl("export_project", "Export audio, stems, MIDI, or .aimusic bundle",
                    Map.of("format", Map.of("type", "STRING", "description", "wav|mp3|stems|midi|aimusic"), "bitrate", Map.of("type", "STRING")),
                    List.of("format"))
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
