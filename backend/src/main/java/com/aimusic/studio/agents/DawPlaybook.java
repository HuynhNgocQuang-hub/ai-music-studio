package com.aimusic.studio.agents;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Lightweight static DAW Playbook (Mini-RAG) supplying operational guidance,
 * genre mixing recipes, and troubleshooting knowledge to AI Music Chatbot.
 */
public final class DawPlaybook {

    private record Entry(String id, String routeHint, List<String> keywords, String content) {}

    private static final List<Entry> ENTRIES = List.of(
            new Entry(
                    "create_wizard",
                    "/create",
                    List.of("thu am", "mic", "upload", "denoise", "wizard", "tao nhac", "hum", "preserve", "enhance", "accompaniment", "full song", "count-in"),
                    "[Create Wizard /create] Buoc 1: Chon Thu Mic (ma hoa .wav chuan) hoac Upload file (.wav/.mp3/.m4a/.ogg/.flac, 3s-300s, <=50MB) va bat AI Denoise + nghe Dry Check. Buoc 2: Kiem tra BPM (40-220), Key/Scale, loai nhip (4/4|3/4|6/8) va Auto-Tune Off/Natural/Balanced/Modern. Buoc 3: Chon Preserve (giu nguyen giai dieu) hoac Enhance (phat trien motif) & Accompaniment vs Full Song (Standard co Bridge hoac Short). Buoc 4: Nghe so sanh A/B va bam Mo trong Studio."
            ),
            new Entry(
                    "playlist_clips",
                    "/studio",
                    List.of("playlist", "khung", "clip", "cat", "split", "trim", "keo", "di chuyen", "envelope", "dynamics", "pattern", "xoa clip", "track cao", "track gon"),
                    "[FL Playlist Arrangement] Go V hoac bam Select de keo clip hoac keo 2 mep trai/phai de Trim; go C hoac bam Split de cat doi Audio Clip theo Snap (1/4, 1/8, 1/16); bam Delete de xoa clip dang chon. Lan Dynamics o tren cung ve duong cong nang luong Section (keo cham tron len/xuong de doi Energy%, bat/tat bang nut Envelope). Cac khung MIDI Pattern tu dong chia theo tung Section va danh dau bien the (#2, #3); double-click vao khung MIDI de mo Piano Roll."
            ),
            new Entry(
                    "sequencer_pianoroll",
                    "/studio",
                    List.of("step", "sequencer", "trong", "drum", "groove", "piano roll", "not", "quantize", "octave", "hop am", "chord", "6/8", "3/4"),
                    "[Step Sequencer & Piano Roll] Step Sequencer tu dong chuyen luoi 16 buoc (4/4) hoac 12 buoc (3/4 & 6/8), co Groove Presets (Pop, Trap, Lo-fi, EDM) va Lap ca bai. Piano Roll ho tro C1-C7, Scale Highlight, keo keo dai not, Velocity Lane, +/-Oct, Quantize, Copy/Paste not. Tren Chord Track, bam o bat ky de sua hop am hoac nhap rong/x de xoa, sau do bam Cap nhat dem de Arranger dong bo."
            ),
            new Entry(
                    "mixer_eq_fx",
                    "/studio",
                    List.of("mix", "mixer", "eq", "reverb", "delay", "fx", "choi", "gat", "bung", "bass", "kho", "chim", "to", "nho", "vo tieng", "clipping", "limiter", "lufs"),
                    "[Console Mixer & Recipes] Moi kenh co Volume (0-120%), Pan (-100..+100), 3-Band EQ (low_db, mid_db, high_db +/-12dB), FX Send (BUS A Hall Reverb, BUS B 1/8D Delay). Auto-Mix tu dong cat tan 2.2 kHz (-2.5dB) tren nhac dem de giong noi va dat Master Limiter <= -1.0 dBFS (-14 LUFS). Cong thuc nhanh: Giong choi -> giam high_db -2..-3dB; Giong kho -> tang reverb_send 0.25-0.35; Bass u/bung -> giam low_db -2dB hoac cat Harmony low_db -2dB."
            ),
            new Entry(
                    "autotune_overdub",
                    "/studio",
                    List.of("auto-tune", "autotune", "pho", "cao do", "retune", "humanize", "formant", "auto-follow", "overdub", "thu de", "fit check", "lech nhip"),
                    "[Auto-Tune Pro & Overdub] Tab Auto-Tune DSP giu nguyen Formant Cepstral (khong meo giong chipmunk); Retune Speed 0ms = robot manh, 40-80ms = muot tu nhien; bat Auto-Follow de khoa theo Key/Scale bai hat. Trong Studio bam Rec Mic o track Vocal de thu de Overdub co bu tre Latency ms; Overdub Fit Check tu dong do lech nhip (ms), not pho (cents) va dua nut 1-Click Fix."
            ),
            new Entry(
                    "export_storage",
                    "/library",
                    List.of("export", "xuat", "wav", "mp3", "stems", "midi", "mid", "aimusic", "luu", "mat bai", "indexeddb", "redis", "import", "ttl", "xoa", "library"),
                    "[Export & Luu tru] Ho tro WAV (44.1kHz), MP3 (320kbps Studio / 192kbps Nhe), Stems (.zip dong do dai tu 00:00), .mid da kenh va goi .aimusic (~1-3MB). Moi lan Import .aimusic tu giao dien mac dinh dung che do an toan (overwrite=false) tao ban sao tranh de bai cu. Trinh duyet tu Auto-Save IndexedDB moi 7s va tu dong Auto-Rehydrate lai audio len Redis neu het han TTL."
            ),
            new Entry(
                    "settings_diagnostics",
                    "/settings",
                    List.of("api", "key", "gemini", "openai", "mock", "404", "503", "401", "loi", "redis", "worker", "fluidsynth", "settings", "test"),
                    "[Settings & Xu ly Su co] Vao /settings de nhap Gemini API Key (ho tro ca AQ... va AIza...) hoac OpenAI Key, phan vai tung Agent va bam Test API Key. Mac dinh dung gemini-3.8-flash (tu fallback tu gemini-2.5-flash neu bi Google 404). Neu gap 503 UNAVAILABLE la qua tai tam thoi tu Google Cloud, he thong tu giu luong voi Mock Fallback thong minh ma khong lam mat du lieu."
            )
    );

    private DawPlaybook() {}

    private static String normalizeVietnamese(String input) {
        if (input == null || input.isBlank()) return "";
        String decomposed = java.text.Normalizer.normalize(input.toLowerCase(Locale.ROOT), java.text.Normalizer.Form.NFD);
        return decomposed.replaceAll("\\p{M}", "").replace('\u0111', 'd');
    }

    public static String retrieveContext(String route, String query, String mode) {
        String r = normalizeVietnamese(route);
        String q = normalizeVietnamese(query);
        String m = mode != null ? mode.toLowerCase(Locale.ROOT) : "producer";

        Map<Entry, Integer> scores = new LinkedHashMap<>();
        for (Entry entry : ENTRIES) {
            int score = 0;
            if (!r.isBlank() && r.contains(entry.routeHint())) {
                score += 2;
            }
            for (String kw : entry.keywords()) {
                if (q.contains(kw)) {
                    score += 3;
                }
            }
            if ("mix".equals(m) && ("mixer_eq_fx".equals(entry.id()) || "autotune_overdub".equals(entry.id()))) {
                score += 2;
            } else if ("arrangement".equals(m) && ("sequencer_pianoroll".equals(entry.id()) || "playlist_clips".equals(entry.id()))) {
                score += 2;
            }
            if (score > 0) {
                scores.put(entry, score);
            }
        }

        List<Entry> selected = scores.entrySet().stream()
                .sorted((a, b) -> Integer.compare(b.getValue(), a.getValue()))
                .limit(2)
                .map(Map.Entry::getKey)
                .toList();

        if (selected.isEmpty()) {
            selected = new ArrayList<>();
            selected.add(r.contains("/create") ? ENTRIES.get(0) : r.contains("/settings") ? ENTRIES.get(6) : ENTRIES.get(1));
        }

        StringBuilder sb = new StringBuilder();
        for (Entry e : selected) {
            sb.append(e.content()).append('\n');
        }
        return sb.toString().trim();
    }
}
