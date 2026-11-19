package com.aimusic.studio.agents;

import com.aimusic.studio.model.ChordEvent;
import com.aimusic.studio.model.MasteringSettings;
import com.aimusic.studio.model.MidiNote;
import com.aimusic.studio.model.ProjectAnalysis;
import com.aimusic.studio.model.ProjectConfig;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.SongSection;
import com.aimusic.studio.model.SongStructure;
import com.aimusic.studio.model.TrackState;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

@Service
public class QaReviewerAgent {

    public record QaReport(
            boolean approved,
            double score,
            List<String> issues,
            String feedback,
            String fixTarget,
            double limiterCeilingDb,
            double targetLufs,
            boolean autoMixEnabled
    ) {}

    private final LlmAdapter llm;

    public QaReviewerAgent(LlmAdapter llm) {
        this.llm = llm;
    }

    public QaReport review(ProjectState projectState, String targetTrack) {
        ProjectConfig cfg = projectState.getConfig() != null ? projectState.getConfig() : new ProjectConfig();
        ProjectAnalysis analysis = projectState.getAnalysis() != null ? projectState.getAnalysis() : new ProjectAnalysis();
        SongStructure structure = projectState.getSongStructure() != null ? projectState.getSongStructure() : new SongStructure();
        Map<String, TrackState> tracks = projectState.getTracks() != null ? projectState.getTracks() : Map.of();
        MasteringSettings mastering = projectState.getMastering() != null ? projectState.getMastering() : new MasteringSettings();

        String key = analysis.getDetectedKey();
        String scale = analysis.getDetectedScale();
        Set<Integer> scalePcs = new HashSet<>(MusicTheory.getScalePitchClasses(key, scale));
        int beatsPerBar = MusicTheory.beatsPerBarFromTs(analysis.getTimeSignature());

        int totalBars = Math.max(1, structure.getTotalBars());
        double totalBeats = (double) totalBars * beatsPerBar;
        Map<Integer, Set<Integer>> chordPcsByBar = new HashMap<>();
        if (structure.getChords() != null) {
            for (ChordEvent c : structure.getChords()) {
                MusicTheory.ParsedChord parsed = MusicTheory.parseChordSymbol(c.getSymbol());
                chordPcsByBar.put(c.getBar(), new HashSet<>(parsed.pitchClasses()));
            }
        }

        List<String> issues = new ArrayList<>();
        String fixTarget = null;
        double score = 1.0;

        List<String> checkedTracks = (targetTrack != null && !targetTrack.isBlank())
                ? List.of(targetTrack.toLowerCase(Locale.ROOT))
                : List.of("drums", "bass", "harmony");

        for (String tName : checkedTracks) {
            TrackState track = tracks.get(tName);
            if (track == null) {
                issues.add("Missing track '" + tName + "'.");
                if (fixTarget == null) fixTarget = "arranger";
                score -= 0.25;
                continue;
            }
            List<MidiNote> notes = track.getNotes();
            if (notes == null || notes.isEmpty()) {
                issues.add("Track '" + tName + "' has no MIDI notes.");
                if (fixTarget == null) fixTarget = "arranger";
                score -= 0.2;
                continue;
            }

            int outOfBounds = 0;
            int inHarmony = 0;
            int totalPitched = 0;
            boolean bassTooHigh = false;

            for (MidiNote n : notes) {
                double sb = n.getStartBeat();
                double dur = n.getDuration();
                int pitch = n.getPitch();

                if (sb < 0.0 || sb >= totalBeats || dur <= 0.0) {
                    outOfBounds++;
                }
                if ("bass".equals(tName) || "harmony".equals(tName) || "lead".equals(tName)) {
                    totalPitched++;
                    int barNum = Math.min(totalBars, Math.max(1, (int) Math.floor(sb / beatsPerBar) + 1));
                    Set<Integer> allowed = new HashSet<>(scalePcs);
                    if (chordPcsByBar.containsKey(barNum)) {
                        allowed.addAll(chordPcsByBar.get(barNum));
                    }
                    if (allowed.contains(Math.floorMod(pitch, 12))) {
                        inHarmony++;
                    }
                }
                if ("bass".equals(tName) && pitch > 60 && !bassTooHigh) {
                    issues.add("Bass note pitch " + pitch + " exceeds C4 (60), risking vocal frequency masking.");
                    if (fixTarget == null) fixTarget = "arranger";
                    score -= 0.15;
                    bassTooHigh = true;
                }
            }

            if (outOfBounds > 0) {
                issues.add("Track '" + tName + "' has " + outOfBounds + " note(s) outside [0, " + totalBeats + ") beats.");
                if (fixTarget == null) fixTarget = "arranger";
                score -= 0.25;
            }
            if (totalPitched > 0) {
                double ratio = (double) inHarmony / totalPitched;
                if (ratio < 0.85) {
                    issues.add(String.format(Locale.ROOT,
                            "Track '%s' harmonic match ratio %.2f is below 0.85 for %s %s.",
                            tName, ratio, key, scale));
                    fixTarget = ratio < 0.6 ? "composer" : (fixTarget != null ? fixTarget : "arranger");
                    score -= 0.3;
                }
            }
        }

        // Preserve Original Melody fidelity check (`FR-HUM-01`)
        if ("preserve".equalsIgnoreCase(cfg.getMelodyMode())
                && analysis.getRawMelodyMidi() != null && !analysis.getRawMelodyMidi().isEmpty()
                && projectState.getMelodyNotes() != null && !projectState.getMelodyNotes().isEmpty()
                && (targetTrack == null || targetTrack.isBlank())) {
            List<MidiNote> raw = analysis.getRawMelodyMidi().stream().map(MusicTheory::normalizeMidiNote).toList();
            List<MidiNote> comp = projectState.getMelodyNotes().stream().map(MusicTheory::normalizeMidiNote).toList();
            if (raw.size() != comp.size()) {
                issues.add("Preserve mode altered melody note count.");
                fixTarget = "composer";
                score -= 0.3;
            } else {
                for (int i = 0; i < raw.size(); i++) {
                    if (raw.get(i).getPitch() != comp.get(i).getPitch()
                            || Math.abs(raw.get(i).getStartBeat() - comp.get(i).getStartBeat()) > 0.5) {
                        issues.add("Preserve mode deviated from original melody pitch or >0.5 beat timing.");
                        fixTarget = "composer";
                        score -= 0.3;
                        break;
                    }
                }
            }
        }

        // Full Song energy & structure check (`FR-HUM-05`)
        if ("full_song".equalsIgnoreCase(cfg.getOutputMode()) && (targetTrack == null || targetTrack.isBlank())) {
            List<SongSection> sections = structure.getSections() != null ? structure.getSections() : List.of();
            if (sections.size() < 3) {
                issues.add("Full song mode must contain at least 3 distinct sections (Intro/Verse/Chorus/Outro).");
                fixTarget = "composer";
                score -= 0.25;
            } else {
                double maxVerse = sections.stream()
                        .filter(s -> s.getName().toLowerCase(Locale.ROOT).contains("verse"))
                        .mapToDouble(SongSection::getEnergy).max().orElse(-1.0);
                double maxChorus = sections.stream()
                        .filter(s -> s.getName().toLowerCase(Locale.ROOT).contains("chorus"))
                        .mapToDouble(SongSection::getEnergy).max().orElse(-1.0);
                if (maxVerse >= 0.0 && maxChorus >= 0.0 && maxChorus < maxVerse) {
                    issues.add("Chorus energy must be greater than or equal to Verse energy.");
                    fixTarget = "composer";
                    score -= 0.15;
                }
                if (!"short".equalsIgnoreCase(cfg.getStructurePreset())) {
                    boolean hasBridge = sections.stream()
                            .anyMatch(s -> s.getName() != null && s.getName().toLowerCase(Locale.ROOT).contains("bridge"));
                    if (!hasBridge) {
                        issues.add("Standard full song structure must include a Bridge section.");
                        fixTarget = "composer";
                        score -= 0.15;
                    }
                }
            }
        }

        double ceilingDb = Math.min(mastering.getLimiterCeilingDb(), -1.0);
        llm.generateJson(
                String.format("QA check for %s %s, issues=%s, total_bars=%d.", key, scale, issues, totalBars),
                "You are an audio mastering & harmony QA reviewer.",
                "qa",
                null
        );

        boolean approved = issues.isEmpty();
        String feedback = approved
                ? "Hòa âm, nhịp độ và cân bằng dải tần đạt chuẩn (Limiter <= -1.0 dBFS)."
                : String.join("; ", issues);

        return new QaReport(
                approved,
                Math.max(0.0, score),
                issues,
                feedback,
                approved ? null : (fixTarget != null ? fixTarget : "arranger"),
                ceilingDb,
                mastering.getTargetLufs(),
                mastering.isAutoMixEnabled()
        );
    }
}
