package com.aimusic.studio.agents;

import com.aimusic.studio.model.AutotuneSettings;
import com.aimusic.studio.model.LyricLine;
import com.aimusic.studio.model.ProjectAnalysis;
import com.aimusic.studio.model.ProjectConfig;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.SongSection;
import com.aimusic.studio.model.TrackState;
import com.aimusic.studio.model.dto.CoachSuggestedAction;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Domain advisor encapsulating music-theory chord adaptation, natural-language DAW entity extraction,
 * topic-aware songwriting synthesis, deep mix/structure diagnostics, and rich Markdown formatting
 * for {@link CoachLyricistAgent}.
 */
final class CoachMusicAdvisor {

    private static final Pattern BPM_PATTERN = Pattern.compile(
            "(?:\\bbpm\\s*[:=]?\\s*|toc\\s*do\\s*(?:len|xuong|thanh|la)?\\s*|(?:bpm|nhip|toc\\s*do)\\s+(?:len|xuong|sang|dat|ve)\\s+)(\\d{2,3})(?!\\s*(?:%|db|lufs|ms|kbps|k\\b|hz))\\b"
                    + "|\\b(\\d{2,3})\\s*bpm\\b",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern LUFS_PATTERN = Pattern.compile(
            "(?<!\\d)(-?(?:8|9|1[0-9]|20)(?:\\.\\d+)?)\\s*lufs\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern PERCENT_PATTERN = Pattern.compile(
            "(\\d{1,3})\\s*%");
    private static final Pattern DB_PATTERN = Pattern.compile(
            "([+-]?\\s*\\d+(?:\\.\\d+)?)\\s*db\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern KEY_NORM_PATTERN = Pattern.compile(
            "\\b(?:chuyen\\s+(?:tone|key|giong)\\s+(?:sang|ve|qua)|sang\\s+(?:tone|key|giong)|doi\\s+(?:tone|key|giong)\\s+(?:sang|thanh)|chuyen\\s+(?:sang|ve|qua)|key|tone|giong)\\s+([a-g](?:#|b)?)(m|min|minor|maj|major)?\\b",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern CHORD_SEQUENCE_PATTERN = Pattern.compile(
            "(?:^|[\\s:,])([A-G](?:#|b)?(?:maj7|m7|dim|sus[24]|m|7)?(?:\\s*[-–,]\\s*[A-G](?:#|b)?(?:maj7|m7|dim|sus[24]|m|7)?){2,7})");

    private static final Map<String, String[]> VIET_KEY_NAMES = Map.ofEntries(
            Map.entry("do truong", new String[]{"C", "major"}),
            Map.entry("do thu", new String[]{"C", "minor"}),
            Map.entry("re truong", new String[]{"D", "major"}),
            Map.entry("re thu", new String[]{"D", "minor"}),
            Map.entry("mi truong", new String[]{"E", "major"}),
            Map.entry("mi thu", new String[]{"E", "minor"}),
            Map.entry("fa truong", new String[]{"F", "major"}),
            Map.entry("fa thu", new String[]{"F", "minor"}),
            Map.entry("sol truong", new String[]{"G", "major"}),
            Map.entry("sol thu", new String[]{"G", "minor"}),
            Map.entry("son truong", new String[]{"G", "major"}),
            Map.entry("son thu", new String[]{"G", "minor"}),
            Map.entry("la truong", new String[]{"A", "major"}),
            Map.entry("la thu", new String[]{"A", "minor"}),
            Map.entry("si truong", new String[]{"B", "major"}),
            Map.entry("si thu", new String[]{"B", "minor"})
    );

    private CoachMusicAdvisor() {}

    static String normText(String text) {
        if (text == null || text.isBlank()) return "";
        String decomposed = java.text.Normalizer.normalize(text.toLowerCase(Locale.ROOT), java.text.Normalizer.Form.NFD);
        return decomposed.replaceAll("\\p{M}", "").replace('\u0111', 'd');
    }

    static boolean isBroadAuditPrompt(String normMsg) {
        return normMsg.contains("moi thu")
                || normMsg.contains("tat ca")
                || normMsg.contains("lam gi")
                || normMsg.contains("lam duoc gi")
                || normMsg.contains("kha nang")
                || normMsg.contains("tong the")
                || normMsg.contains("danh gia")
                || normMsg.contains("phan tich")
                || normMsg.contains("chan doan")
                || normMsg.contains("thieu gi")
                || normMsg.contains("gop y")
                || normMsg.contains("toan bo")
                || normMsg.contains("toi uu")
                || normMsg.contains("can lam gi");
    }

    /**
     * Produces structured diagnostic bullet points used both in LLM prompts and offline reasoning.
     */
    static String buildDiagnosticBrief(
            ProjectState projectState,
            ProjectAnalysis analysis,
            ProjectConfig cfg,
            Map<String, Object> extraContext,
            CoachAudioInspector.AudioTelemetry audioTelemetry
    ) {
        List<String> findings = new ArrayList<>();
        Map<String, TrackState> tracks = projectState.getTracks();
        TrackState vocal = tracks != null ? tracks.get("vocal") : null;
        TrackState harmony = tracks != null ? tracks.get("harmony") : null;
        TrackState bass = tracks != null ? tracks.get("bass") : null;
        TrackState drums = tracks != null ? tracks.get("drums") : null;

        if (tracks != null && !tracks.isEmpty()) {
            List<String> muted = tracks.entrySet().stream()
                    .filter(e -> e.getValue() != null && e.getValue().isMute())
                    .map(Map.Entry::getKey)
                    .toList();
            if (!muted.isEmpty()) {
                findings.add("Track đang bị Mute: " + String.join(", ", muted));
            }
        }
        if (vocal != null) {
            if (vocal.getReverbSend() <= 0.05) {
                findings.add("Vocal chưa có Reverb Send (dễ nghe khô so với nhạc đệm)");
            }
            if (vocal.getHighDb() > 2.5) {
                findings.add(String.format(Locale.ROOT, "Vocal High EQ đang khá cao (+%.1fdB, dễ bị chói/gắt)", vocal.getHighDb()));
            }
        }
        if (harmony != null && harmony.getLowDb() >= 0.0 && vocal != null) {
            findings.add("Harmony chưa cắt Low (< 200Hz), dễ lấn dải trung-trầm với Vocal & Bass");
        }
        if (bass != null && bass.getVolume() > 1.05 && drums != null && drums.getVolume() < 0.75) {
            findings.add("Bass đang lớn hơn nhiều so với Drums, dễ đè tiếng Kick trống");
        }

        AutotuneSettings tune = projectState.getAutotuneSettings();
        if (tune == null || !tune.isEnabled() || "off".equalsIgnoreCase(tune.getPreset())) {
            findings.add("Auto-Tune Pro đang tắt (có thể bật Balanced/Natural theo " + analysis.getDetectedKey() + " " + analysis.getDetectedScale() + ")");
        }

        List<SongSection> sections = projectState.getSongStructure() != null && projectState.getSongStructure().getSections() != null
                ? projectState.getSongStructure().getSections() : List.of();
        boolean hasBridge = sections.stream().anyMatch(s -> s.getName() != null && s.getName().toLowerCase(Locale.ROOT).contains("bridge"));
        if (!hasBridge) {
            findings.add("Cấu trúc chưa có đoạn Bridge tạo điểm cao trào/tương phản");
        }
        sections.stream()
                .filter(s -> s.getName() != null && s.getName().toLowerCase(Locale.ROOT).contains("chorus") && s.getEnergy() < 0.85)
                .findFirst()
                .ifPresent(s -> findings.add(String.format(Locale.ROOT, "Chorus Energy đang %.0f%% (<85%%), có thể đẩy Dynamics lên", s.getEnergy() * 100)));

        int lyricCount = projectState.getLyrics() != null && projectState.getLyrics().getLines() != null
                ? projectState.getLyrics().getLines().size() : 0;
        if (lyricCount == 0) {
            findings.add("Chưa có câu lời nào trong tab Lyrics & Karaoke");
        }

        double lufs = projectState.getMastering() != null ? projectState.getMastering().getTargetLufs() : -14.0;
        String genre = cfg.getGenre() != null ? cfg.getGenre() : "Pop";
        if (("EDM".equalsIgnoreCase(genre) || "Hip-hop".equalsIgnoreCase(genre)) && lufs <= -14.0) {
            findings.add(String.format(Locale.ROOT, "Thể loại %s thường hợp -9..-11 LUFS (hiện tại %.0f LUFS)", genre, lufs));
        }

        if (extraContext != null && extraContext.get("fit_check") instanceof Map<?, ?> fc) {
            findings.add("Overdub Fit Check gần nhất lệch " + fc.get("timing_offset_ms") + "ms (" + fc.get("gain_suggestion") + ")");
        }
        if (audioTelemetry != null) {
            findings.add("Audio Telemetry: " + audioTelemetry.summary());
        }
        return findings.isEmpty() ? "Cân bằng Mix và Cấu trúc hiện tại ổn định." : String.join(" | ", findings);
    }

    static List<String> buildDiatonicProgression(String key, String scale, String moodHint) {
        List<MusicTheory.DiatonicTriad> triads = MusicTheory.diatonicTriads(key, scale);
        if (triads.size() < 7) {
            return List.of("Am", "F", "C", "G");
        }
        boolean minor = scale != null && scale.toLowerCase(Locale.ROOT).contains("minor");
        String normMood = normText(moodHint);
        if (normMood.contains("jazz") || normMood.contains("lofi") || normMood.contains("lo-fi")) {
            // ii - V - I - vi (or ii° - V - i - VI in minor)
            return List.of(
                    triads.get(1).symbol(),
                    triads.get(4).symbol(),
                    triads.get(0).symbol(),
                    triads.get(5).symbol()
            );
        }
        if (normMood.contains("buon") || normMood.contains("sad") || normMood.contains("ballad") || normMood.contains("sau")) {
            return minor
                    ? List.of(triads.get(0).symbol(), triads.get(5).symbol(), triads.get(2).symbol(), triads.get(6).symbol()) // i - VI - III - VII
                    : List.of(triads.get(5).symbol(), triads.get(3).symbol(), triads.get(0).symbol(), triads.get(4).symbol()); // vi - IV - I - V
        }
        return minor
                ? List.of(triads.get(0).symbol(), triads.get(3).symbol(), triads.get(5).symbol(), triads.get(4).symbol()) // i - iv - VI - v
                : List.of(triads.get(0).symbol(), triads.get(4).symbol(), triads.get(5).symbol(), triads.get(3).symbol()); // I - V - vi - IV
    }

    static List<Map<String, Object>> generateCustomLyricLines(
            String rawMessage,
            ProjectState projectState,
            ProjectAnalysis analysis,
            ProjectConfig cfg
    ) {
        String topic = extractLyricTopic(rawMessage, cfg.getMood());
        String norm = normText(rawMessage);
        String lang = norm.contains("tieng anh") || norm.contains("english") ? "en"
                : norm.contains("song ngu") || norm.contains("bilingual") ? "bilingual" : "vi";
        String targetSection = norm.contains("verse") ? "Verse 1"
                : norm.contains("bridge") ? "Bridge" : "Chorus";

        int startBar = 1;
        if (projectState.getSongStructure() != null && projectState.getSongStructure().getSections() != null) {
            for (SongSection sec : projectState.getSongStructure().getSections()) {
                if (sec.getName() != null && sec.getName().toLowerCase(Locale.ROOT).contains(targetSection.split("\\s+")[0].toLowerCase(Locale.ROOT))) {
                    startBar = Math.max(1, sec.getStartBar());
                    break;
                }
            }
        }

        List<String> verseLines;
        if ("en".equals(lang)) {
            verseLines = List.of(
                    "Soft lights shimmer on " + topic + " tonight",
                    "Every heartbeat echoes in the fading light",
                    "Hold onto " + topic + " till the morning breaks",
                    "Sing this chorus loud for every step we take"
            );
        } else if ("bilingual".equals(lang)) {
            verseLines = List.of(
                    "Giữ chặt " + topic + " in the glow tonight",
                    "Nhịp tim vang lên giữa ánh đèn chẳng phai",
                    "Hold on to " + topic + ", đừng vội buông đôi tay",
                    "Giai điệu ngân nga mang ta qua tháng ngày"
            );
        } else {
            verseLines = List.of(
                    "Chạm nhẹ ký ức về " + topic + " giữa màn đêm trôi",
                    "Từng nhịp đập khẽ ngân vang theo ánh đèn xa xôi",
                    "Giữ lại hơi ấm " + topic + " cho trái tim thôi chơi vơi",
                    "Cùng hòa ca vang khúc hát đưa ta về chân trời"
            );
        }

        List<Map<String, Object>> lines = new ArrayList<>();
        for (int i = 0; i < verseLines.size(); i++) {
            lines.add(Map.of(
                    "section", targetSection,
                    "bar", startBar + i,
                    "text", verseLines.get(i)
            ));
        }
        return lines;
    }

    static String extractLyricTopic(String rawMessage, String fallbackMood) {
        String cand = extractOriginalClauseAfter(rawMessage, List.of(
                "chu de", "ve chu de", "topic", "about", "ve"
        ));
        if (cand != null && cand.length() >= 3 && !normText(cand).startsWith("de xuat") && !normText(cand).startsWith("cho bai")) {
            return cand;
        }
        return (fallbackMood != null && !fallbackMood.isBlank()) ? fallbackMood.toLowerCase(Locale.ROOT) : "thanh xuân";
    }

    private static String extractOriginalClauseAfter(String rawMessage, List<String> normTriggers) {
        if (rawMessage == null || rawMessage.isBlank()) return null;
        String[] origWords = rawMessage.trim().split("\\s+");
        String[] normWords = new String[origWords.length];
        for (int i = 0; i < origWords.length; i++) {
            normWords[i] = normText(origWords[i]).replaceAll("^[,.:;!?\"“]+|[,.:;!?\"”]+$", "");
        }
        for (String trigger : normTriggers) {
            String[] trigWords = trigger.split("\\s+");
            for (int i = 0; i <= normWords.length - trigWords.length; i++) {
                boolean matched = true;
                for (int j = 0; j < trigWords.length; j++) {
                    if (!trigWords[j].equals(normWords[i + j])) {
                        matched = false;
                        break;
                    }
                }
                if (matched && i + trigWords.length < origWords.length) {
                    StringBuilder sb = new StringBuilder();
                    for (int k = i + trigWords.length; k < origWords.length; k++) {
                        String clean = origWords[k].replaceAll("^[\"“]+", "").replaceAll("[\"”.,;!?]+$", "");
                        if (clean.isBlank()) continue;
                        if (sb.length() > 0) sb.append(' ');
                        sb.append(clean);
                        if (origWords[k].endsWith(",") || origWords[k].endsWith(".") || origWords[k].endsWith(";") || sb.length() > 55) {
                            break;
                        }
                    }
                    String out = sb.toString().trim();
                    if (!out.isBlank()) return out;
                }
            }
        }
        return null;
    }

    static void appendSmartEntityActions(
            List<CoachSuggestedAction> actions,
            String rawMessage,
            String normMsg,
            String mode,
            ProjectState projectState,
            ProjectAnalysis analysis,
            ProjectConfig cfg
    ) {
        // 1. Exact BPM extraction (40..220)
        Matcher bpmMatcher = BPM_PATTERN.matcher(normMsg);
        if (bpmMatcher.find()) {
            String rawNum = bpmMatcher.group(1) != null ? bpmMatcher.group(1) : bpmMatcher.group(2);
            if (rawNum != null) {
                int bpmVal = Math.max(40, Math.min(220, Integer.parseInt(rawNum)));
                actions.add(new CoachSuggestedAction(
                        "set_exact_bpm_" + bpmVal,
                        "Đặt tốc độ " + bpmVal + " BPM",
                        "update_config",
                        Map.of("bpm", bpmVal)
                ));
            }
        }

        // 2. Exact Key & Scale extraction (Vietnamese + English notation, matched on normalized diacritic-free text)
        String parsedKey = null;
        String parsedScale = null;
        for (Map.Entry<String, String[]> vk : VIET_KEY_NAMES.entrySet()) {
            if (normMsg.contains(vk.getKey())) {
                parsedKey = vk.getValue()[0];
                parsedScale = vk.getValue()[1];
                break;
            }
        }
        if (parsedKey == null) {
            Matcher km = KEY_NORM_PATTERN.matcher(normMsg);
            if (km.find()) {
                String root = km.group(1);
                String normRoot = root.substring(0, 1).toUpperCase(Locale.ROOT) + (root.length() > 1 ? root.substring(1) : "");
                if (MusicTheory.NOTE_NAME_TO_PC.containsKey(normRoot.toUpperCase(Locale.ROOT))) {
                    parsedKey = normRoot;
                    String qual = km.group(2) != null ? km.group(2).toLowerCase(Locale.ROOT) : "";
                    parsedScale = (qual.startsWith("m") && !qual.startsWith("maj")) ? "minor" : "major";
                }
            }
        }
        if (parsedKey != null) {
            actions.add(new CoachSuggestedAction(
                    "set_key_" + parsedKey + "_" + parsedScale,
                    "Đổi giọng sang " + parsedKey + " " + parsedScale,
                    "update_config",
                    Map.of("key", parsedKey, "scale", parsedScale)
            ));
        }

        // 3. Exact LUFS target extraction (-20..-8)
        Matcher lufsMatcher = LUFS_PATTERN.matcher(normMsg);
        if (lufsMatcher.find()) {
            double lufsVal = Double.parseDouble(lufsMatcher.group(1));
            if (lufsVal > 0) lufsVal = -lufsVal;
            lufsVal = Math.max(-20.0, Math.min(-8.0, lufsVal));
            actions.add(new CoachSuggestedAction(
                    "set_exact_lufs",
                    String.format(Locale.ROOT, "Đặt Mastering %.0f LUFS", lufsVal),
                    "set_mastering",
                    Map.of("auto_mix_enabled", true, "target_lufs", lufsVal, "limiter_ceiling_db", -1.0)
            ));
        }

        // 4. Explicit Song Title rename (preserves full Vietnamese accents)
        String nextTitle = extractOriginalClauseAfter(rawMessage, List.of(
                "doi ten bai hat thanh", "doi ten bai thanh", "doi ten thanh", "dat ten bai thanh", "dat ten thanh"
        ));
        if (nextTitle != null && nextTitle.length() >= 2) {
            actions.add(new CoachSuggestedAction(
                    "rename_project",
                    "Đổi tên bài thành \"" + nextTitle + "\"",
                    "update_config",
                    Map.of("title", nextTitle)
            ));
        }

        // 5. Explicit inline chord progression (e.g. "Am - F - C - G")
        if (rawMessage != null) {
            Matcher cm = CHORD_SEQUENCE_PATTERN.matcher(rawMessage);
            if (cm.find()) {
                String[] tokens = cm.group(1).split("\\s*[-–,]\\s*");
                List<String> chords = new ArrayList<>();
                for (String t : tokens) {
                    String trimmed = t.trim();
                    if (!trimmed.isBlank()) chords.add(trimmed);
                }
                if (chords.size() >= 3) {
                    actions.add(new CoachSuggestedAction(
                            "apply_custom_chords",
                            "Áp dụng vòng " + String.join(" - ", chords),
                            "rearrange_chords",
                            Map.of("chords", chords)
                    ));
                }
            }
        }

        // 6. Track unmute / unsolo / numeric dB or percentage Mix control
        String mentionedTrack = detectTrackMention(normMsg, null);
        if (mentionedTrack != null) {
            if (normMsg.contains("bo mute") || normMsg.contains("bat lai") || normMsg.contains("mo tieng") || normMsg.contains("unmute")) {
                actions.add(new CoachSuggestedAction(
                        "unmute_" + mentionedTrack,
                        "Mở lại tiếng track " + mentionedTrack.toUpperCase(Locale.ROOT),
                        "set_track_mix",
                        Map.of("track_id", mentionedTrack, "mute", false)
                ));
            }
            if (normMsg.contains("bo solo") || normMsg.contains("tat solo") || normMsg.contains("unsolo")) {
                actions.add(new CoachSuggestedAction(
                        "unsolo_" + mentionedTrack,
                        "Tắt Solo track " + mentionedTrack.toUpperCase(Locale.ROOT),
                        "set_track_mix",
                        Map.of("track_id", mentionedTrack, "solo", false)
                ));
            }
            Matcher pm = PERCENT_PATTERN.matcher(normMsg);
            if (pm.find() && (normMsg.contains("volume") || normMsg.contains("am luong") || normMsg.contains("giam") || normMsg.contains("tang"))) {
                int pct = Math.max(0, Math.min(120, Integer.parseInt(pm.group(1))));
                if (!normMsg.contains("nang luong") && !normMsg.contains("chorus") && !normMsg.contains("reverb") && !normMsg.contains("delay")) {
                    actions.add(new CoachSuggestedAction(
                            "set_vol_" + mentionedTrack + "_" + pct,
                            "Đặt Volume " + mentionedTrack.toUpperCase(Locale.ROOT) + " " + pct + "%",
                            "set_track_mix",
                            Map.of("track_id", mentionedTrack, "volume", Math.round((pct / 100.0) * 100.0) / 100.0)
                    ));
                } else if (normMsg.contains("reverb") || normMsg.contains("vang")) {
                    double rev = Math.max(0.0, Math.min(1.0, pct / 100.0));
                    actions.add(new CoachSuggestedAction(
                            "set_rev_" + mentionedTrack + "_" + pct,
                            "Đặt Reverb " + mentionedTrack.toUpperCase(Locale.ROOT) + " " + pct + "%",
                            "set_track_mix",
                            Map.of("track_id", mentionedTrack, "reverb_send", rev)
                    ));
                }
            }
            Matcher dbm = DB_PATTERN.matcher(normMsg);
            if (dbm.find() && !normMsg.contains("dbfs") && (normMsg.contains("eq") || normMsg.contains("low") || normMsg.contains("mid") || normMsg.contains("high") || normMsg.contains("sang") || normMsg.contains("tram"))) {
                double dbVal = Math.max(-12.0, Math.min(12.0, Double.parseDouble(dbm.group(1).replaceAll("\\s+", ""))));
                String field = (normMsg.contains("low") || normMsg.contains("tram") || normMsg.contains("bass")) ? "low_db"
                        : (normMsg.contains("mid") || normMsg.contains("trung")) ? "mid_db" : "high_db";
                actions.add(new CoachSuggestedAction(
                        "set_eq_" + mentionedTrack + "_" + field,
                        String.format(Locale.ROOT, "Chỉnh %s %s %+.1f dB", mentionedTrack.toUpperCase(Locale.ROOT), field.replace("_db", "").toUpperCase(Locale.ROOT), dbVal),
                        "set_track_mix",
                        Map.of("track_id", mentionedTrack, field, dbVal)
                ));
            }
        }

        // 7. Topic-aware immediate Lyrics Writer (only when user explicitly writes/requests lyrics)
        if ("lyricist".equals(mode) || normMsg.contains("viet loi") || normMsg.contains("viet lai") || normMsg.contains("sang tac") || normMsg.contains("loi bai hat") || normMsg.contains("diep khuc") || normMsg.contains("chorus")) {
            if (rawMessage != null && (normMsg.contains("viet") || normMsg.contains("sang tac") || normMsg.contains("them loi") || normMsg.contains("ve "))) {
                List<Map<String, Object>> customLines = generateCustomLyricLines(rawMessage, projectState, analysis, cfg);
                String topic = extractLyricTopic(rawMessage, cfg.getMood());
                actions.add(new CoachSuggestedAction(
                        "apply_custom_lyrics_draft",
                        "Áp dụng 4 câu lời về \"" + topic + "\"",
                        "update_lyrics_lines",
                        Map.of("append", false, "lines", customLines)
                ));
            }
        }

        // 8. Phase 9/10 Showcase, Creators, Checkpoints, Publish, Collab navigation/actions
        if (normMsg.contains("checkpoint") || normMsg.contains("luu phien ban") || normMsg.contains("snapshot")) {
            actions.add(new CoachSuggestedAction(
                    "save_checkpoint_now",
                    "Lưu Version Checkpoint hiện tại",
                    "save_checkpoint",
                    Map.of("label", "Copilot Checkpoint (" + Math.round(analysis.getBpm()) + " BPM)")
            ));
        }
        if (normMsg.contains("publish") || normMsg.contains("xuat ban") || normMsg.contains("phat hanh")) {
            actions.add(new CoachSuggestedAction(
                    "open_publish_dialog",
                    "Mở bảng Publish & Chia sẻ Demo",
                    "open_publish_modal",
                    Map.of()
            ));
        }
        if (normMsg.contains("collab") || normMsg.contains("cong tac") || normMsg.contains("moi ban") || normMsg.contains("phong chat")) {
            String tab = normMsg.contains("lock") || normMsg.contains("chat") ? "chat_lock" : "collab";
            actions.add(new CoachSuggestedAction(
                    "open_collab_" + tab,
                    "Mở Phòng Cộng Tác Live",
                    "open_collab_drawer",
                    Map.of("tab", tab)
            ));
        }
        if (normMsg.contains("cong dong") || normMsg.contains("showcase") || normMsg.contains("trending") || normMsg.contains("/share")) {
            actions.add(new CoachSuggestedAction("nav_share_feed", "Mở Cộng đồng Demo (/share)", "navigate_route", Map.of("route", "/share")));
        }
        if (normMsg.contains("creator") || normMsg.contains("xep hang") || normMsg.contains("producer profile") || normMsg.contains("theo doi")) {
            actions.add(new CoachSuggestedAction("nav_creators_board", "Mở Bảng Xếp Hạng Producer (/creators)", "navigate_route", Map.of("route", "/creators")));
        }
    }

    static String buildRichReply(
            String mode,
            String rawMessage,
            String route,
            ProjectState projectState,
            ProjectAnalysis analysis,
            ProjectConfig cfg,
            int lyricCount,
            List<String> chordSyms,
            Map<String, TrackState> tracks,
            String playbookContext,
            Map<String, Object> extraContext,
            CoachAudioInspector.AudioTelemetry audioTelemetry,
            List<CoachSuggestedAction> generatedActions
    ) {
        String normMsg = normText(rawMessage);
        String keyScale = analysis.getDetectedKey() + " " + analysis.getDetectedScale();
        String chordsStr = chordSyms.isEmpty() ? "chưa thiết lập" : String.join(" - ", chordSyms.subList(0, Math.min(4, chordSyms.size())));
        String diagnostics = buildDiagnosticBrief(projectState, analysis, cfg, extraContext, audioTelemetry);

        if (audioTelemetry != null) {
            String healthDesc = audioTelemetry.clipping()
                    ? "**Cảnh báo Clipping**: Đỉnh tín hiệu chạm `" + String.format(Locale.ROOT, "%.1f", audioTelemetry.peakDbfs()) + " dBFS` (vượt `-1.0 dBFS`), rất dễ vỡ tiếng khi lên Master."
                    : audioTelemetry.tooQuiet()
                    ? "**Âm lượng đầu vào hơi nhỏ**: RMS `" + String.format(Locale.ROOT, "%.1f", audioTelemetry.rmsDbfs()) + " dBFS`, nên đẩy Gain/Auto-Trim để rõ nét hơn."
                    : "Dải động đạt mức cân bằng tốt (`Crest " + String.format(Locale.ROOT, "%.1f", audioTelemetry.crestDb()) + " dB`).";
            String estKeyLine = (audioTelemetry.detectedKey() != null && audioTelemetry.detectedBpm() > 0)
                    ? String.format(Locale.ROOT, "\n- **Nhận diện âm nhạc ước lượng:** `%s %s` • `%.0f BPM` (chỉ số tham chiếu từ file đính kèm).",
                            audioTelemetry.detectedKey(), audioTelemetry.detectedScale(), audioTelemetry.detectedBpm())
                    : "";
            String brightHint = audioTelemetry.brightRatio() > 0.35
                    ? "\n- **Màu âm:** Dải cao khá gắt (`bright ratio " + String.format(Locale.ROOT, "%.2f", audioTelemetry.brightRatio()) + "`), gợi ý giảm nhẹ `high_db -1.5..-2.5 dB`."
                    : "";
            return String.format(Locale.ROOT,
                    "### Phân tích Audio Telemetry (`%.1fs`)\n"
                            + "- **Mức đỉnh / Trung bình:** `%.1f dBFS` / `%.1f dBFS` (%s)\n"
                            + "- **Khoảng lặng ước tính:** `%.0f%%`%s%s\n\n"
                            + "Bạn có thể bấm các nút thao tác 1 chạm bên dưới để xử lý Gain/EQ, cắt khoảng lặng (Auto-Trim) hoặc khóa cao độ Auto-Tune ngay.",
                    audioTelemetry.durationSec(), audioTelemetry.peakDbfs(), audioTelemetry.rmsDbfs(),
                    healthDesc, audioTelemetry.silenceRatio() * 100.0, estKeyLine, brightHint);
        }

        if (extraContext != null && extraContext.get("fit_check") instanceof Map<?, ?> fc
                && (normMsg.contains("overdub") || normMsg.contains("thu de") || normMsg.contains("lech") || normMsg.contains("fit"))) {
            return String.format(Locale.ROOT,
                    "### Chẩn đoán Overdub Fit Check\n"
                            + "- Độ lệch nhịp so với beat gốc: **`%s ms`**\n"
                            + "- Gợi ý cân chỉnh: `%s`\n\n"
                            + "Bấm nút **1-Click Fix** hoặc dùng **Auto-Mix / Auto-Tune** bên dưới để khớp vocal vào lưới nhịp tức thì.",
                    fc.get("timing_offset_ms"), fc.get("gain_suggestion"));
        }

        if (isBroadAuditPrompt(normMsg)) {
            TrackState vocal = tracks != null ? tracks.get("vocal") : null;
            AutotuneSettings tune = projectState.getAutotuneSettings();
            String tuneLabel = (tune != null && tune.isEnabled() && !"off".equalsIgnoreCase(tune.getPreset()))
                    ? tune.getPreset() : "chưa bật";
            int sectionCount = projectState.getSongStructure() != null && projectState.getSongStructure().getSections() != null
                    ? projectState.getSongStructure().getSections().size() : 0;
            String diatonicHint = String.join(" - ", buildDiatonicProgression(analysis.getDetectedKey(), analysis.getDetectedScale(), cfg.getMood()));
            return String.format(Locale.ROOT,
                    "### Đánh giá Toàn diện Dự án (`%s` • `%s` • `%.0f BPM`)\n"
                            + "- **Thông số hiện tại:** `%d` section (`%s`), vòng hợp âm `%s`, `%d` câu lời, Auto-Tune `%s`, Vocal EQ `%.0f/%.0f/%.0f dB` (Reverb `%.0f%%`).\n"
                            + "- **Điểm cần tối ưu ngay:** %s\n"
                            + "- **Gợi ý vòng hợp âm hợp giọng `%s`:** `%s` *(có nút **Nghe thử A/B**)*.\n\n"
                            + "Chọn **Áp dụng tất cả** hoặc nhấn từng nút bên dưới (mọi thay đổi đều hỗ trợ **Hoàn tác 1 chạm**).",
                    cfg.getGenre(), keyScale, analysis.getBpm(),
                    sectionCount, analysis.getTimeSignature() != null ? analysis.getTimeSignature() : "4/4",
                    chordsStr, lyricCount, tuneLabel,
                    vocal != null ? vocal.getLowDb() : 0.0,
                    vocal != null ? vocal.getMidDb() : 0.0,
                    vocal != null ? vocal.getHighDb() : 0.0,
                    vocal != null ? vocal.getReverbSend() * 100 : 0.0,
                    diagnostics, keyScale, diatonicHint);
        }

        // Custom lyrics draft formatted right inside Markdown response
        for (CoachSuggestedAction act : generatedActions) {
            if ("update_lyrics_lines".equals(act.getAction()) && act.getPayload() != null
                    && act.getPayload().get("lines") instanceof List<?> lines && !lines.isEmpty()) {
                String topic = extractLyricTopic(rawMessage, cfg.getMood());
                StringBuilder lyricBlock = new StringBuilder();
                lyricBlock.append("### Bản nháp Lời bài hát về \"").append(topic).append("\" (`").append(keyScale).append("`, `")
                        .append(Math.round(analysis.getBpm())).append(" BPM`)\n");
                for (Object item : lines) {
                    if (item instanceof Map<?, ?> m) {
                        lyricBlock.append("- `[Bar ").append(m.get("bar")).append("]` ").append(m.get("text")).append('\n');
                    }
                }
                lyricBlock.append("\nBấm **Áp dụng** để ghi thẳng vào tab **Lyrics & Karaoke** (hoặc yêu cầu sửa vần/chủ đề khác!).");
                return lyricBlock.toString();
            }
        }

        if (normMsg.contains("lam sao") || normMsg.contains("cach") || normMsg.contains("huong dan")
                || normMsg.contains("404") || normMsg.contains("503") || normMsg.contains("429")
                || route.startsWith("/settings")) {
            return "### Hướng dẫn nhanh từ Playbook DAW\n" + formatPlaybookBullets(playbookContext);
        }

        if (route.equals("/") || route.startsWith("/library")) {
            return "### Copilot Workspace (" + (route.equals("/") ? "Project Hub" : "Session Vault") + ")\n"
                    + "Tôi có thể khởi tạo ngay **Starter Template** (`Pop`, `Lo-fi`, `Trap`, `EDM`, `Ballad`), chuyển tới trang **Thu Mic/Upload** (`/create`), xem **Cộng đồng** (`/share`, `/creators`) hoặc mở **Cài đặt Engine** (`/settings`). Hãy chọn nút bên dưới hoặc nhập yêu cầu!";
        }

        TrackState vocal = tracks != null ? tracks.get("vocal") : null;
        String suggestedProg = String.join(" - ", buildDiatonicProgression(analysis.getDetectedKey(), analysis.getDetectedScale(), cfg.getMood()));
        return switch (mode) {
            case "lyricist" -> String.format(Locale.ROOT,
                    "### Trợ lý Sáng tác Lời (`%s` • `%.0f BPM`)\n"
                            + "- Hiện có **`%d` câu lời** cho %s (hợp âm `%s`).\n"
                            + "- **Mẹo viết hay:** Giữ câu Hook 6–10 âm tiết lặp nhịp nhàng ở `Chorus` và đối chiếu độ dài nốt ở Karaoke.\n"
                            + "- Gợi ý prompt: *\"Viết lời Chorus về mưa đêm\"* hoặc bấm nút bên dưới!",
                    keyScale, analysis.getBpm(), lyricCount, cfg.getGenre(), chordsStr);
            case "arrangement" -> String.format(Locale.ROOT,
                    "### Trợ lý Hòa âm & Nhạc cụ (`%s` • `%.0f BPM`)\n"
                            + "- Vòng hợp âm hiện tại: `%s` | Gợi ý chuẩn điệu `%s`: **`%s`**.\n"
                            + "- **Chẩn đoán:** %s\n"
                            + "- Bạn có thể ra lệnh cụ thể như: *\"Chuyển BPM 124\"*, *\"Sang tone Dm\"*, *\"Áp dụng vòng Am - F - C - G\"*, hoặc *\"Đổi điệu trống Trap\"*.",
                    keyScale, analysis.getBpm(), chordsStr, keyScale, suggestedProg, diagnostics);
            case "mix" -> String.format(Locale.ROOT,
                    "### Kỹ sư Mix & Mastering (`%.0f BPM` • Master `%.0f LUFS`)\n"
                            + "- **Vocal hiện tại:** Volume `%d%%`, EQ `%.0f / %.0f / %.0f dB`, Reverb `%.0f%%`.\n"
                            + "- **Gợi ý kỹ thuật:** %s\n"
                            + "- Bạn có thể yêu cầu cụ thể như: *\"Giảm High Vocal -2 dB\"*, *\"Reverb vocal 30%%\"*, *\"Mở lại track drums\"*, hoặc *\"Đặt -9 LUFS\"*.",
                    analysis.getBpm(),
                    projectState.getMastering() != null ? projectState.getMastering().getTargetLufs() : -14.0,
                    vocal != null ? Math.round(vocal.getVolume() * 100) : 95,
                    vocal != null ? vocal.getLowDb() : 0.0,
                    vocal != null ? vocal.getMidDb() : 0.0,
                    vocal != null ? vocal.getHighDb() : 0.0,
                    vocal != null ? vocal.getReverbSend() * 100 : 0.0,
                    diagnostics);
            default -> String.format(Locale.ROOT,
                    "### AI Music Copilot (`%s` • `%s` • `%.0f BPM`)\n"
                            + "- **Tóm tắt phiên:** Hợp âm `%s`, `%d` câu lời.\n"
                            + "- **Điểm đáng chú ý:** %s\n"
                            + "- Bạn có thể gõ tự nhiên: *\"Phân tích toàn bộ bài này\"*, *\"Đẩy BPM lên 126\"*, *\"Viết Chorus về hoài niệm\"*, *\"Lưu Checkpoint\"* hoặc *\"Mở Publish\"*.",
                    cfg.getGenre(), keyScale, analysis.getBpm(), chordsStr, lyricCount, diagnostics);
        };
    }

    static String synthesizeReplyForToolCalls(
            ProjectAnalysis analysis,
            ProjectConfig cfg,
            List<CoachSuggestedAction> actions
    ) {
        StringBuilder sb = new StringBuilder();
        sb.append(String.format(Locale.ROOT,
                "Tôi đã phân tích dự án **%s** (`%s %s`, `%.0f BPM`) và đề xuất các thao tác sau:\n",
                cfg.getGenre(), analysis.getDetectedKey(), analysis.getDetectedScale(), analysis.getBpm()));
        for (CoachSuggestedAction a : actions) {
            sb.append("- **").append(a.getLabel()).append("** (`").append(a.getAction()).append("`)\n");
        }
        sb.append("\nNhấn **Áp dụng** bên dưới để thực thi an toàn (hỗ trợ **Hoàn tác 1 chạm**).");
        return sb.toString();
    }

    private static String formatPlaybookBullets(String rawPlaybook) {
        if (rawPlaybook == null || rawPlaybook.isBlank()) return "";
        StringBuilder sb = new StringBuilder();
        for (String line : rawPlaybook.split("\\r?\\n")) {
            String trimmed = line.trim();
            if (!trimmed.isBlank()) {
                sb.append("- ").append(trimmed).append('\n');
            }
        }
        return sb.toString().trim();
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
}
