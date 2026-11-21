package com.aimusic.studio.agents;

import com.aimusic.studio.model.MidiNote;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class MusicTheory {

    private MusicTheory() {}

    public static final Map<String, Integer> NOTE_NAME_TO_PC = Map.ofEntries(
            Map.entry("C", 0), Map.entry("B#", 0),
            Map.entry("C#", 1), Map.entry("DB", 1),
            Map.entry("D", 2),
            Map.entry("D#", 3), Map.entry("EB", 3),
            Map.entry("E", 4), Map.entry("FB", 4),
            Map.entry("F", 5), Map.entry("E#", 5),
            Map.entry("F#", 6), Map.entry("GB", 6),
            Map.entry("G", 7),
            Map.entry("G#", 8), Map.entry("AB", 8),
            Map.entry("A", 9),
            Map.entry("A#", 10), Map.entry("BB", 10),
            Map.entry("B", 11), Map.entry("CB", 11)
    );

    public static final List<String> PC_TO_NOTE_NAME = List.of(
            "C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"
    );

    public static final Map<String, List<Integer>> SCALE_INTERVALS = Map.of(
            "major", List.of(0, 2, 4, 5, 7, 9, 11),
            "minor", List.of(0, 2, 3, 5, 7, 8, 10),
            "pentatonic_major", List.of(0, 2, 4, 7, 9),
            "pentatonic major", List.of(0, 2, 4, 7, 9),
            "pentatonic_minor", List.of(0, 3, 5, 7, 10),
            "pentatonic minor", List.of(0, 3, 5, 7, 10),
            "chromatic", List.of(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)
    );

    public static final Map<String, List<Integer>> CHORD_QUALITY_INTERVALS = Map.of(
            "", List.of(0, 4, 7),
            "maj", List.of(0, 4, 7),
            "m", List.of(0, 3, 7),
            "min", List.of(0, 3, 7),
            "7", List.of(0, 4, 7, 10),
            "maj7", List.of(0, 4, 7, 11),
            "m7", List.of(0, 3, 7, 10),
            "dim", List.of(0, 3, 6),
            "sus2", List.of(0, 2, 7),
            "sus4", List.of(0, 5, 7)
    );

    private static final Pattern COPYRIGHT_PATTERN = Pattern.compile(
            "(?iu)(?:"
                    + "\\b(?:sound\\s+like|sounds\\s+like|style\\s+of|copy|imitate|cover\\s+of|type\\s+beat\\s+(?:of|for))\\s+(?!pop\\b|ballad\\b|lo-?fi\\b|r&b\\b|hip-?hop\\b|edm\\b|acoustic\\b|rock\\b|jazz\\b)[\\p{L}\\p{N}._-]+(?:\\s+(?!track\\b|song\\b|beat\\b|vibe\\b)[\\p{L}\\p{N}._-]+){0,2}"
                    + "|\\b(?:giống|nhái|bắt chước|theo phong cách(?:\\s+của)?|như bài(?:\\s+hát)?|type\\s+beat)\\s+[\\p{L}\\p{N}._-]+(?:\\s+[\\p{L}\\p{N}._-]+){0,2}"
                    + "|\\b(?:like\\s+)?(?:taylor swift|son tung|sơn tùng|den vau|đen vâu|my tam|mỹ tâm|hoang thuy linh|hoàng thùy linh|bts|blackpink|ed sheeran|adele|the weeknd|drake|billie eilish|justin bieber)\\b"
                    + ")"
    );

    private static final Pattern CHORD_PATTERN = Pattern.compile("^([A-Ga-g][#b]?)(.*)$");

    public static String sanitizeUserPrompt(String prompt) {
        return sanitizeUserPrompt(prompt, 500);
    }

    public static String sanitizeUserPrompt(String prompt, int maxLength) {
        if (prompt == null || prompt.isBlank()) {
            return "";
        }
        String cleaned = COPYRIGHT_PATTERN.matcher(prompt.trim()).replaceAll("in an original contemporary style");
        if (cleaned.length() > maxLength) {
            return cleaned.substring(0, maxLength);
        }
        return cleaned;
    }

    public static int[] parseTimeSignature(String ts) {
        try {
            String[] parts = (ts == null || ts.isBlank() ? "4/4" : ts).split("/", 2);
            int num = Math.max(1, Integer.parseInt(parts[0].trim()));
            int den = Math.max(1, Integer.parseInt(parts[1].trim()));
            return new int[]{num, den};
        } catch (Exception e) {
            return new int[]{4, 4};
        }
    }

    public static int beatsPerBarFromTs(String ts) {
        int[] parsed = parseTimeSignature(ts);
        if (parsed[0] == 6 && parsed[1] == 8) {
            return 6;
        }
        return parsed[0];
    }

    public static int parseKeyRoot(String key) {
        if (key == null || key.isBlank()) {
            return 0;
        }
        String token = key.trim().split("\\s+")[0].toUpperCase(Locale.ROOT);
        if (token.endsWith("M") && token.length() > 1 && NOTE_NAME_TO_PC.containsKey(token.substring(0, token.length() - 1))) {
            token = token.substring(0, token.length() - 1);
        }
        return NOTE_NAME_TO_PC.getOrDefault(token, 0);
    }

    public static List<Integer> getScalePitchClasses(String key, String scale) {
        int root = parseKeyRoot(key);
        String normScale = (scale == null || scale.isBlank()) ? "major" : scale.trim().toLowerCase(Locale.ROOT);
        List<Integer> intervals = SCALE_INTERVALS.getOrDefault(normScale, SCALE_INTERVALS.get("major"));
        List<Integer> result = new ArrayList<>(intervals.size());
        for (int iv : intervals) {
            result.add((root + iv) % 12);
        }
        return result;
    }

    public record ParsedChord(int rootPc, List<Integer> pitchClasses) {}

    public static ParsedChord parseChordSymbol(String symbol) {
        String text = (symbol == null || symbol.isBlank()) ? "C" : symbol.trim();
        Matcher m = CHORD_PATTERN.matcher(text);
        if (!m.matches()) {
            return new ParsedChord(0, List.of(0, 4, 7));
        }
        String rootName = m.group(1).toUpperCase(Locale.ROOT);
        String suffix = m.group(2).trim().toLowerCase(Locale.ROOT);
        int slashIdx = suffix.indexOf('/');
        if (slashIdx >= 0) {
            suffix = suffix.substring(0, slashIdx);
        }
        int rootPc = NOTE_NAME_TO_PC.getOrDefault(rootName, 0);
        List<Integer> intervals = CHORD_QUALITY_INTERVALS.get(suffix);
        if (intervals == null) {
            if (suffix.startsWith("m") && !suffix.startsWith("maj")) {
                intervals = List.of(0, 3, 7);
            } else {
                intervals = List.of(0, 4, 7);
            }
        }
        List<Integer> pcs = new ArrayList<>(intervals.size());
        for (int iv : intervals) {
            pcs.add((rootPc + iv) % 12);
        }
        return new ParsedChord(rootPc, pcs);
    }

    public static String chordNameFromRoot(int pc, String quality) {
        return PC_TO_NOTE_NAME.get(Math.floorMod(pc, 12)) + (quality != null ? quality : "");
    }

    public static MidiNote normalizeMidiNote(MidiNote note) {
        int pitch = Math.max(0, Math.min(127, note.getPitch()));
        double startBeat = Math.round(Math.max(0.0, note.getStartBeat()) * 10000.0) / 10000.0;
        double dur = Math.round(Math.max(0.125, note.getDuration()) * 10000.0) / 10000.0;
        int vel = Math.max(1, Math.min(127, note.getVelocity()));
        return new MidiNote(pitch, startBeat, dur, vel, note.getConfidence());
    }

    public static int snapPitchToScale(int pitch, List<Integer> scalePcs) {
        if (scalePcs == null || scalePcs.isEmpty()) {
            return pitch;
        }
        int pc = Math.floorMod(pitch, 12);
        if (scalePcs.contains(pc)) {
            return pitch;
        }
        int bestPitch = pitch;
        int bestDist = 99;
        for (int offset : new int[]{-2, -1, 1, 2}) {
            int cand = pitch + offset;
            if (cand >= 0 && cand <= 127 && scalePcs.contains(Math.floorMod(cand, 12))) {
                if (Math.abs(offset) < bestDist) {
                    bestDist = Math.abs(offset);
                    bestPitch = cand;
                }
            }
        }
        return bestPitch;
    }

    public record DiatonicTriad(String symbol, List<Integer> pitchClasses) {}

    public static List<DiatonicTriad> diatonicTriads(String key, String scale) {
        int root = parseKeyRoot(key);
        String normScale = (scale == null || scale.isBlank()) ? "major" : scale.trim().toLowerCase(Locale.ROOT);
        int[][] degrees = normScale.contains("minor")
                ? new int[][]{{0, 1}, {2, 2}, {3, 0}, {5, 1}, {7, 1}, {8, 0}, {10, 0}}
                : new int[][]{{0, 0}, {2, 1}, {4, 1}, {5, 0}, {7, 0}, {9, 1}, {11, 2}};

        List<DiatonicTriad> triads = new ArrayList<>();
        for (int[] deg : degrees) {
            int chordRoot = (root + deg[0]) % 12;
            String qual = deg[1] == 1 ? "m" : (deg[1] == 2 ? "dim" : "");
            String sym = chordNameFromRoot(chordRoot, qual);
            ParsedChord parsed = parseChordSymbol(sym);
            triads.add(new DiatonicTriad(sym, parsed.pitchClasses()));
        }
        return triads;
    }

    public static double nearestScaleMidi(double midiVal, String key, String scale) {
        List<Integer> allowedPcs = getScalePitchClasses(key, scale);
        int base = (int) Math.round(midiVal);
        double bestNote = base;
        double bestDist = 999.0;
        for (int offset = -6; offset <= 6; offset++) {
            int cand = base + offset;
            if (allowedPcs.contains(Math.floorMod(cand, 12))) {
                double dist = Math.abs(midiVal - cand);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestNote = cand;
                }
            }
        }
        return bestNote;
    }

    public static String midiToNoteName(int pitch) {
        int pc = Math.floorMod(pitch, 12);
        int octave = (pitch / 12) - 1;
        return PC_TO_NOTE_NAME.get(pc) + octave;
    }
}
