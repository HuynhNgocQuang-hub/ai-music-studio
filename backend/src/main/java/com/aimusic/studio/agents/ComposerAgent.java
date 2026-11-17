package com.aimusic.studio.agents;

import com.aimusic.studio.model.ChordEvent;
import com.aimusic.studio.model.MidiNote;
import com.aimusic.studio.model.ProjectAnalysis;
import com.aimusic.studio.model.ProjectConfig;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.SongSection;
import com.aimusic.studio.model.SongStructure;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

@Service
public class ComposerAgent {

    public record ComposeResult(
            SongStructure songStructure,
            List<MidiNote> melodyNotes,
            String motifPosition,
            String sanitizedPrompt,
            String composerNotes
    ) {}

    private final LlmAdapter llm;

    public ComposerAgent(LlmAdapter llm) {
        this.llm = llm;
    }

    public ComposeResult compose(ProjectState projectState, String qaFeedback) {
        ProjectConfig cfg = projectState.getConfig() != null ? projectState.getConfig() : new ProjectConfig();
        ProjectAnalysis analysis = projectState.getAnalysis() != null ? projectState.getAnalysis() : new ProjectAnalysis();

        String melodyMode = cfg.getMelodyMode().toLowerCase(Locale.ROOT);
        String outputMode = cfg.getOutputMode().toLowerCase(Locale.ROOT);
        String motifPosition = cfg.getMotifPosition().toLowerCase(Locale.ROOT);
        String genre = cfg.getGenre();
        String mood = cfg.getMood();
        String userPrompt = MusicTheory.sanitizeUserPrompt(cfg.getUserPrompt());

        double bpm = analysis.getBpm() > 0 ? analysis.getBpm() : 100.0;
        String timeSig = analysis.getTimeSignature();
        int beatsPerBar = MusicTheory.beatsPerBarFromTs(timeSig);
        String key = analysis.getDetectedKey();
        String scale = analysis.getDetectedScale();
        List<Integer> scalePcs = MusicTheory.getScalePitchClasses(key, scale);

        List<MidiNote> rawNotes = new ArrayList<>();
        if (analysis.getRawMelodyMidi() != null) {
            for (MidiNote n : analysis.getRawMelodyMidi()) {
                rawNotes.add(MusicTheory.normalizeMidiNote(n));
            }
        }
        if (rawNotes.isEmpty()) {
            int rootMidi = 60 + MusicTheory.parseKeyRoot(key);
            rawNotes.add(new MidiNote(rootMidi, 0.0, 1.0, 85, 1.0));
            rawNotes.add(new MidiNote(MusicTheory.snapPitchToScale(rootMidi + 4, scalePcs), 1.0, 1.0, 85, 1.0));
            rawNotes.add(new MidiNote(MusicTheory.snapPitchToScale(rootMidi + 7, scalePcs), 2.0, 1.5, 88, 1.0));
            rawNotes.add(new MidiNote(MusicTheory.snapPitchToScale(rootMidi + 4, scalePcs), 3.5, 0.5, 80, 1.0));
        }

        double maxEndBeat = 0.0;
        for (MidiNote n : rawNotes) {
            maxEndBeat = Math.max(maxEndBeat, n.getStartBeat() + n.getDuration());
        }
        int inputBars = Math.max(1, (int) Math.ceil(maxEndBeat / beatsPerBar));

        List<MidiNote> melodyNotes;
        if ("preserve".equals(melodyMode)) {
            melodyNotes = new ArrayList<>(rawNotes.size());
            for (MidiNote n : rawNotes) melodyNotes.add(n.copy());
        } else {
            melodyNotes = enhanceMelody(rawNotes, scalePcs);
        }

        Map<String, Object> llmSuggestion = consultLlmForHarmony(
                key, scale, bpm, genre, mood, outputMode, motifPosition, inputBars, userPrompt, qaFeedback);

        List<MusicTheory.DiatonicTriad> triads = MusicTheory.diatonicTriads(key, scale);

        List<SongSection> sections = new ArrayList<>();
        int totalBars;
        String resolvedMotifPos;
        if ("full_song".equals(outputMode)) {
            String llmMotif = llmSuggestion.get("motif_position") instanceof String s ? s : null;
            resolvedMotifPos = resolveMotifPos(motifPosition, llmMotif);
            int unit = Math.max(4, Math.min(8, inputBars));
            int introBars = 4;
            int verseBars = unit;
            int chorusBars = unit;
            int outroBars = 4;
            sections.add(new SongSection("Intro", 1, introBars, 0.3, false));
            sections.add(new SongSection("Verse 1", 1 + introBars, verseBars, 0.55, "verse".equals(resolvedMotifPos)));
            sections.add(new SongSection("Chorus", 1 + introBars + verseBars, chorusBars, 0.9, "chorus".equals(resolvedMotifPos)));
            sections.add(new SongSection("Outro", 1 + introBars + verseBars + chorusBars, outroBars, 0.35, false));
            totalBars = introBars + verseBars + chorusBars + outroBars;
        } else {
            totalBars = inputBars;
            resolvedMotifPos = "main";
            sections.add(new SongSection("Main", 1, totalBars, 0.7, true));
        }

        List<String> llmChords = new ArrayList<>();
        Object rawLlmChords = llmSuggestion.get("chords");
        if (rawLlmChords instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof String s) llmChords.add(s.trim());
            }
        }
        Set<String> validSymbols = new HashSet<>();
        for (MusicTheory.DiatonicTriad t : triads) validSymbols.add(t.symbol());

        List<ChordEvent> chords = new ArrayList<>();
        for (int barIdx = 0; barIdx < totalBars; barIdx++) {
            int barNum = barIdx + 1;
            double barStart = (double) barIdx * beatsPerBar;
            double barEnd = barStart + beatsPerBar;
            List<MidiNote> barNotes = new ArrayList<>();
            for (MidiNote n : melodyNotes) {
                if (n.getStartBeat() >= barStart && n.getStartBeat() < barEnd) {
                    barNotes.add(n);
                }
            }

            String chosen = null;
            if (barIdx < llmChords.size() && (qaFeedback == null || qaFeedback.isBlank())) {
                String cand = llmChords.get(barIdx);
                if (validSymbols.contains(cand)) chosen = cand;
            }
            if (chosen == null) {
                chosen = chooseChordForBar(barNotes, triads, barIdx, genre, mood);
            }
            chords.add(new ChordEvent(barNum, 1.0, chosen, beatsPerBar));
        }

        SongStructure structure = new SongStructure();
        structure.setTotalBars(totalBars);
        structure.setSections(sections);
        structure.setChords(chords);

        String notesText = llmSuggestion.get("notes") instanceof String s
                ? s : "Harmony aligned to melody strong beats.";
        return new ComposeResult(structure, melodyNotes, resolvedMotifPos, userPrompt, notesText);
    }

    private String resolveMotifPos(String motifPosition, String llmMotifPos) {
        String pos = motifPosition;
        if ("auto".equals(pos)) {
            pos = ("chorus".equals(llmMotifPos) || "verse".equals(llmMotifPos)) ? llmMotifPos : "chorus";
        }
        if (!"chorus".equals(pos) && !"verse".equals(pos)) {
            pos = "chorus";
        }
        return pos;
    }

    private List<MidiNote> enhanceMelody(List<MidiNote> rawNotes, List<Integer> scalePcs) {
        List<MidiNote> enhanced = new ArrayList<>(rawNotes.size());
        for (int i = 0; i < rawNotes.size(); i++) {
            MidiNote n = rawNotes.get(i);
            int snapped = MusicTheory.snapPitchToScale(n.getPitch(), scalePcs);
            double qStart = Math.round(n.getStartBeat() * 2.0) / 2.0;
            double qDur = Math.max(0.25, Math.round(n.getDuration() * 2.0) / 2.0);
            int vel = Math.min(115, Math.max(70, n.getVelocity() + (i % 2 == 0 ? 4 : 0)));
            enhanced.add(new MidiNote(snapped, qStart, qDur, vel, n.getConfidence()));
        }
        return enhanced;
    }

    private String chooseChordForBar(List<MidiNote> barNotes, List<MusicTheory.DiatonicTriad> triads,
                                     int barIndex, String genre, String mood) {
        if (triads.isEmpty()) return "C";
        int[] defaultOrder = triads.size() >= 6 ? new int[]{0, 4, 5, 3} : new int[]{0};
        if (mood.toLowerCase(Locale.ROOT).contains("sad") || genre.toLowerCase(Locale.ROOT).contains("ballad")) {
            defaultOrder = triads.size() >= 6 ? new int[]{5, 3, 0, 4} : new int[]{0};
        }
        int preferredIdx = defaultOrder[barIndex % defaultOrder.length];
        if (barNotes.isEmpty()) {
            return triads.get(preferredIdx).symbol();
        }

        String bestSymbol = triads.get(preferredIdx).symbol();
        double bestScore = -1.0;
        for (int idx = 0; idx < triads.size(); idx++) {
            MusicTheory.DiatonicTriad triad = triads.get(idx);
            if (triad.symbol().endsWith("dim")) continue;
            double score = 0.0;
            for (MidiNote n : barNotes) {
                int pc = Math.floorMod(n.getPitch(), 12);
                if (triad.pitchClasses().contains(pc)) {
                    double weight = (n.getStartBeat() % 1.0) < 0.25 ? 1.5 : 1.0;
                    score += weight * n.getDuration();
                }
            }
            if (idx == preferredIdx) score += 0.35;
            if (idx == 0 && barIndex == 0) score += 0.5;
            if (score > bestScore) {
                bestScore = score;
                bestSymbol = triad.symbol();
            }
        }
        return bestSymbol;
    }

    private Map<String, Object> consultLlmForHarmony(
            String key, String scale, double bpm, String genre, String mood,
            String outputMode, String motifPosition, int inputBars, String userPrompt, String qaFeedback
    ) {
        String prompt = String.format(Locale.ROOT,
                "Design a diatonic chord progression in %s %s at %.1f BPM for genre='%s', mood='%s', output_mode='%s', motif_position='%s', input_bars=%d. User prompt: %s. QA feedback to fix: %s. Return JSON with keys: chords (list of chord symbols), motif_position ('chorus'|'verse'), notes.",
                key, scale, bpm, genre, mood, outputMode, motifPosition, inputBars,
                userPrompt.isEmpty() ? "none" : userPrompt,
                (qaFeedback == null || qaFeedback.isBlank()) ? "none" : qaFeedback);
        LlmAdapter.LlmResponse resp = llm.generateJson(
                prompt, "You are a music harmony composer. Return strict JSON.", "composer", null);
        return resp.data() != null ? resp.data() : Map.of();
    }
}
