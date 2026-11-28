package com.aimusic.studio.agents;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Lightweight static DAW Playbook (Mini-RAG) supplying operational guidance,
 * genre mixing recipes, cloud/collab workflows, and troubleshooting knowledge to AI Music Copilot.
 */
public final class DawPlaybook {

    private record Entry(String id, String routeHint, List<String> keywords, String content) {}

    private static final List<Entry> ENTRIES = List.of(
            new Entry(
                    "create_wizard",
                    "/create",
                    List.of("thu am", "mic", "upload", "denoise", "wizard", "tao nhac", "hum", "preserve", "enhance", "accompaniment", "full song", "count-in"),
                    "[Create Wizard /create] Buoc 1: Chon Thu Mic (.wav chuan) hoac Upload file (.wav/.mp3/.m4a/.ogg/.flac, 3s-300s, <=50MB) va bat AI Denoise + nghe Dry Check. Buoc 2: Kiem tra BPM (40-220), Key/Scale, loai nhip (4/4|3/4|6/8) va Auto-Tune Off/Natural/Balanced/Modern. Buoc 3: Chon Preserve (giu nguyen giai dieu) hoac Enhance (phat trien motif) & Accompaniment vs Full Song (Standard co Bridge hoac Short). Buoc 4: Nghe so sanh A/B va bam Mo trong Studio."
            ),
            new Entry(
                    "playlist_clips",
                    "/studio",
                    List.of("playlist", "khung", "clip", "cat", "split", "trim", "keo", "di chuyen", "envelope", "dynamics", "pattern", "xoa clip", "track cao", "track gon", "automation", "filter", "pan"),
                    "[FL Playlist & Automation] Go V hoac bam Select de keo clip hoac keo 2 mep trai/phai de Trim; go C hoac bam Split de cat doi Audio Clip theo Snap (1/4, 1/8, 1/16); bam Delete de xoa clip dang chon. Lan Automation o tren cung ho tro 5 kenh (DYN | VOL | PAN | FILT | REVERB) co linearRamp theo o nhap. Khung MIDI Pattern tu chia theo tung Section va danh dau bien the (#2, #3); double-click mo Piano Roll."
            ),
            new Entry(
                    "sequencer_pianoroll",
                    "/studio",
                    List.of("step", "sequencer", "trong", "drum", "groove", "piano roll", "not", "quantize", "octave", "hop am", "chord", "6/8", "3/4", "webmidi", "tone", "scale"),
                    "[Step Sequencer & Piano Roll] Step Sequencer tu chuyen luoi 16 buoc (4/4) hoac 12 buoc (3/4 & 6/8), ho tro Groove Presets (Pop, Trap, Lo-fi, EDM). Piano Roll ho tro C1-C7, Scale Highlight, WebMIDI Keyboard ghi not truc tiep, Velocity Lane, +/-Oct, Quantize, Copy/Paste. Tren Chord Track bam o bat ky de sua hop am, hoac yeu cau AI doi hop am va bam Nghe thu A/B."
            ),
            new Entry(
                    "mixer_eq_fx",
                    "/studio",
                    List.of("mix", "mixer", "eq", "reverb", "delay", "fx", "choi", "gat", "bung", "bass", "kho", "chim", "to", "nho", "vo tieng", "clipping", "limiter", "lufs", "master", "mastering"),
                    "[Console Mixer & Mastering Recipes] Moi kenh co Volume (0-120%), Pan (-100..+100), 3-Band EQ (low_db, mid_db, high_db +/-12dB), FX Send (BUS A Hall Reverb, BUS B 1/8D Delay). Auto-Mix cat tan 2.2 kHz (-2.5dB) tren nhac dem va dat Master Limiter <= -1.0 dBFS. Target LUFS chuan: EDM/Club -9 LUFS, Pop/Spotify/YouTube -14 LUFS, Apple Music/Acoustic -16 LUFS. Cong thuc nhanh: Vocal choi -> high_db -2..-3dB; Vocal kho -> reverb_send 0.25-0.35; Bass u -> cat Harmony low_db -2.5dB."
            ),
            new Entry(
                    "autotune_overdub",
                    "/studio",
                    List.of("auto-tune", "autotune", "pho", "cao do", "retune", "humanize", "formant", "auto-follow", "overdub", "thu de", "fit check", "lech nhip", "pitch curve", "tach stem", "stem"),
                    "[Auto-Tune Pro, Pitch Curve & Stems] Tab Auto-Tune DSP giu nguyen Formant Cepstral & Visual Pitch Curve Editor chinh từng not; Retune Speed 0ms = robot manh, 40-80ms = muot tu nhien; bat Auto-Follow de khoa theo Key/Scale. Tab Arrangement ho tro Tach Stem Vocal & Beat (HPSS) va Overdub Fit Check tu do lech nhip (ms), lech cao do (cents) kem nut 1-Click Fix."
            ),
            new Entry(
                    "collab_versions",
                    "/studio",
                    List.of("collab", "cong tac", "phong", "moi", "link", "websocket", "ws", "lock", "khoa track", "chat", "checkpoint", "version", "phien ban", "khoi phuc", "restore", "ghi chu", "bar comment"),
                    "[Realtime Collab, Locks & Version Checkpoints] Bam nut Collab hoac Versions tren thanh Studio de: (1) Tao link moi cong tac Live qua WebSocket /ws/collab, xem con tro Bar real-time va Cue Bar; (2) Gui Ghi chu ghim theo tung o nhap (Notes); (3) Khoa Track mem (Lock) tranh sua de & Chat truc tiep trong phong (Lock & Chat); (4) Luu Named Checkpoint (Versions) len CloudDB va Khoi phuc 1 cham dong bo ca phong."
            ),
            new Entry(
                    "cloud_publish_share",
                    "/share",
                    List.of("share", "chia se", "publish", "xuat ban", "cong dong", "trending", "like", "tim", "comment", "binh luan", "creator", "creators", "producer", "follow", "theo doi", "remix", "flac", "login", "dang nhap", "logout", "dang xuat", "quota"),
                    "[Cloud Auth, Publishing & Community Showcase] Bam Publish tren Studio de master MP3/FLAC (kem ID3 tags & LUFS -9/-14/-16) va phat hanh link /share/:slug. Cong dong /share ho tro Tim kiem, Loc the loai, Sap xep Trending/Likes/Plays, Feed Dang theo doi, Thich, Binh luan theo Timestamp/Bar va Remix Lineage (ke thua nguon bai goc). Trang /creators hien thi Bang xep hang & Ho so Producer; /login quan ly phien JWT + Cloud Quota."
            ),
            new Entry(
                    "export_storage",
                    "/library",
                    List.of("export", "xuat", "wav", "mp3", "flac", "stems", "midi", "mid", "aimusic", "luu", "mat bai", "indexeddb", "redis", "import", "ttl", "xoa", "library"),
                    "[Export & Luu tru] Ho tro WAV (44.1kHz), MP3 (320kbps/192kbps), FLAC Lossless, Stems (.zip dong do dai tu 00:00), .mid da kenh va goi .aimusic (~1-3MB). Mac dinh Import .aimusic an toan (overwrite=false) tao ban sao tranh de bai cu. Trinh duyet tu Auto-Save IndexedDB moi 7s, tu Rehydrate len Redis/S3 neu het TTL, va giu Undo stack 50 buoc."
            ),
            new Entry(
                    "settings_diagnostics",
                    "/settings",
                    List.of("api", "key", "gemini", "openai", "mock", "404", "503", "401", "429", "loi", "redis", "worker", "fluidsynth", "settings", "test", "cache", "soundfont", "sf2"),
                    "[Settings & Xu ly Su co] Vao /settings de nhap Gemini API Key (ho tro ca AQ... va AIza...) hoac OpenAI Key, phan vai tung Agent, tai Custom .sf2 SoundFont (<=50MB) va bam Test API Key. Mac dinh dung gemini-3.8-flash. Neu gap HTTP 429 la vuot quota ngay (co the dang nhap Cloud de tang han muc); gap 503 he thong giu luong qua Local Engine thong minh."
            ),
            new Entry(
                    "shortcuts_and_copilot",
                    "/studio",
                    List.of("lam gi", "kha nang", "chuc nang", "moi thu", "tat ca", "de xuat", "phim tat", "shortcut", "space", "undo", "redo", "quick", "pro daw", "nhac cu", "dieu huong", "giup gi"),
                    "[AI Music Copilot Full Spectrum] Copilot doc real-time Mix/EQ, Hop am, Loi, Overdub Fit Check, Telemetry Audio va dieu khien toan app (kem Hoan tac 1 cham): Tao Template, Dieu huong 6 man hinh (/, /create, /library, /share, /creators, /settings, /studio), Transport (Play/Stop/Loop/Undo/Redo), Chinh chinh xac BPM/Key/Scale/Ten bai/LUFS, Phan tich Mix & Cau truc, Doi hop am theo giong & Nghe thu A/B, Sang tac/Ap dung loi, Tach Stem, Ve Automation, Luu Checkpoint, Mo Publish & Collab."
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
        boolean broadRequest = q.contains("moi thu") || q.contains("tat ca") || q.contains("lam gi")
                || q.contains("tong the") || q.contains("help") || q.contains("toan bo") || q.contains("phan tich");

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
            if (broadRequest && "shortcuts_and_copilot".equals(entry.id())) {
                score += 6;
            }
            if (score > 0) {
                scores.put(entry, score);
            }
        }

        List<Entry> selected = scores.entrySet().stream()
                .sorted((a, b) -> Integer.compare(b.getValue(), a.getValue()))
                .limit(broadRequest ? 4 : 3)
                .map(Map.Entry::getKey)
                .toList();

        if (selected.isEmpty()) {
            selected = new ArrayList<>();
            selected.add(ENTRIES.get(ENTRIES.size() - 1));
            selected.add(r.contains("/create") ? ENTRIES.get(0)
                    : r.contains("/settings") ? ENTRIES.get(8)
                    : r.contains("/share") || r.contains("/creators") ? ENTRIES.get(6)
                    : ENTRIES.get(3));
        }

        StringBuilder sb = new StringBuilder();
        for (Entry e : selected) {
            sb.append(e.content()).append('\n');
        }
        return sb.toString().trim();
    }
}
