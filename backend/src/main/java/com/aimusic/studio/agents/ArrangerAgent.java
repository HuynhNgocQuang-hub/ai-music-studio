package com.aimusic.studio.agents;

import com.aimusic.studio.model.AudioClip;
import com.aimusic.studio.model.ChordEvent;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

@Service
public class ArrangerAgent {

    private static final List<String> MIDI_TRACK_NAMES = List.of("drums", "bass", "harmony", "lead");

    private static final Map<String, Map<String, String>> GENRE_INSTRUMENTS = Map.of(
            "pop", Map.of("drums", "acoustic_kit", "bass", "finger_bass", "harmony", "grand_piano", "lead", "electric_piano"),
            "ballad", Map.of("drums", "brush_kit", "bass", "fretless_bass", "harmony", "grand_piano", "lead", "string_ensemble"),
            "lo-fi", Map.of("drums", "lofi_kit", "bass", "warm_sub_bass", "harmony", "rhodes_ep", "lead", "muted_guitar"),
            "lofi", Map.of("drums", "lofi_kit", "bass", "warm_sub_bass", "harmony", "rhodes_ep", "lead", "muted_guitar"),
            "r&b", Map.of("drums", "rnb_kit", "bass", "synth_bass", "harmony", "electric_piano", "lead", "synth_lead"),
            "hip-hop", Map.of("drums", "808_kit", "bass", "808_bass", "harmony", "dark_pad", "lead", "pluck_synth"),
            "edm", Map.of("drums", "electronic_kit", "bass", "saw_bass", "harmony", "supersaw_pad", "lead", "bright_lead"),
            "acoustic", Map.of("drums", "cajon_kit", "bass", "upright_bass", "harmony", "acoustic_guitar", "lead", "flute"),
            "rock", Map.of("drums", "rock_kit", "bass", "pick_bass", "harmony", "overdrive_guitar", "lead", "lead_guitar")
    );

    private final LlmAdapter llm;

    public ArrangerAgent(LlmAdapter llm) {
        this.llm = llm;
    }

    public Map<String, TrackState> arrange(
            ProjectState projectState,
            List<MidiNote> melodyNotes,
            String targetTrack,
            String instrumentOverride,
            List<String> lockedTracks,
            String qaFeedback
    ) {
        ProjectConfig cfg = projectState.getConfig() != null ? projectState.getConfig() : new ProjectConfig();
        ProjectAnalysis analysis = projectState.getAnalysis() != null ? projectState.getAnalysis() : new ProjectAnalysis();
        SongStructure structure = projectState.getSongStructure() != null ? projectState.getSongStructure() : new SongStructure();
        Map<String, TrackState> existingTracks = projectState.getTracks() != null ? projectState.getTracks() : new LinkedHashMap<>();

        String genre = cfg.getGenre();
        String outputMode = cfg.getOutputMode().toLowerCase(Locale.ROOT);
        int beatsPerBar = MusicTheory.beatsPerBarFromTs(analysis.getTimeSignature());
        String key = analysis.getDetectedKey();
        String scale = analysis.getDetectedScale();
        List<Integer> scalePcs = MusicTheory.getScalePitchClasses(key, scale);

        int totalBars = Math.max(1, structure.getTotalBars());
        List<SongSection> sections = structure.getSections() != null && !structure.getSections().isEmpty()
                ? structure.getSections()
                : List.of(new SongSection("Main", 1, totalBars, 0.7, true));

        List<ChordEvent> chords = structure.getChords() != null ? structure.getChords() : List.of();
        Map<Integer, String> chordByBar = new HashMap<>();
        for (ChordEvent c : chords) {
            chordByBar.put(c.getBar(), c.getSymbol());
        }

        Map<String, String> instruments = selectInstruments(genre);

        Set<String> lockedSet = new HashSet<>();
        if (lockedTracks != null) {
            for (String lt : lockedTracks) {
                if (lt != null) lockedSet.add(lt.toLowerCase(Locale.ROOT));
            }
        }
        for (Map.Entry<String, TrackState> entry : existingTracks.entrySet()) {
            if (entry.getValue() != null && entry.getValue().isLocked()) {
                lockedSet.add(entry.getKey().toLowerCase(Locale.ROOT));
            }
        }

        boolean includeLead = shouldIncludeLead(cfg, outputMode);
        Set<String> tracksToBuild = new HashSet<>();
        if (targetTrack != null && !targetTrack.isBlank()) {
            tracksToBuild.add(targetTrack.toLowerCase(Locale.ROOT));
        } else {
            tracksToBuild.addAll(List.of("drums", "bass", "harmony"));
            if (includeLead) {
                tracksToBuild.add("lead");
            }
            tracksToBuild.removeAll(lockedSet);
        }

        llm.generateJson(
                String.format("Arrange MIDI tracks %s for genre='%s', bars=%d, key=%s %s, qa_feedback='%s'.",
                        tracksToBuild, genre, totalBars, key, scale, qaFeedback != null ? qaFeedback : ""),
                "You are a MIDI arranger. Return concise JSON arrangement guidance.",
                "arranger",
                null
        );

        Map<String, TrackState> resultTracks = new LinkedHashMap<>();
        for (Map.Entry<String, TrackState> entry : existingTracks.entrySet()) {
            resultTracks.put(entry.getKey(), copyTrack(entry.getValue()));
        }

        if (!resultTracks.containsKey("vocal")) {
            TrackState vocal = TrackState.audioTrack(0.9, 0.0);
            String ref = null;
            if (projectState.getAudioAssets() != null) {
                boolean autotuneEnabled = projectState.getAutotuneSettings() == null
                        || projectState.getAutotuneSettings().isEnabled();
                ref = (autotuneEnabled && projectState.getAudioAssets().getTunedVocalRef() != null)
                        ? projectState.getAudioAssets().getTunedVocalRef()
                        : projectState.getAudioAssets().getDryDenoisedRef();
            }
            if (ref != null) {
                AudioClip clip = new AudioClip("clip_vocal_1", ref, 1.0, 0.0);
                clip.setFadeInMs(15.0);
                vocal.getClips().add(clip);
            }
            resultTracks.put("vocal", vocal);
        }

        List<MidiNote> srcMelody = melodyNotes != null ? melodyNotes : analysis.getRawMelodyMidi();
        List<MidiNote> normalizedMelody = new ArrayList<>();
        if (srcMelody != null) {
            for (MidiNote n : srcMelody) normalizedMelody.add(MusicTheory.normalizeMidiNote(n));
        }

        for (String trackName : MIDI_TRACK_NAMES) {
            if (!tracksToBuild.contains(trackName)) {
                if (!resultTracks.containsKey(trackName)) {
                    TrackState empty = TrackState.midiTrack(instruments.get(trackName), 0.75, 0.0);
                    empty.setLocked(lockedSet.contains(trackName));
                    resultTracks.put(trackName, empty);
                } else if ("lead".equals(trackName) && (targetTrack == null || targetTrack.isBlank())
                        && !includeLead && !lockedSet.contains("lead")) {
                    resultTracks.get(trackName).setNotes(new ArrayList<>());
                }
                continue;
            }

            TrackState existingMeta = resultTracks.get(trackName);
            boolean isTarget = targetTrack != null && targetTrack.equalsIgnoreCase(trackName);
            String instName = (isTarget && instrumentOverride != null && !instrumentOverride.isBlank())
                    ? instrumentOverride
                    : (existingMeta != null && existingMeta.getInstrument() != null
                    ? existingMeta.getInstrument() : instruments.get(trackName));

            List<MidiNote> notes;
            double defaultVol;
            switch (trackName) {
                case "drums" -> {
                    notes = generateDrums(totalBars, beatsPerBar, sections, genre);
                    defaultVol = 0.72;
                }
                case "bass" -> {
                    notes = generateBass(totalBars, beatsPerBar, chordByBar, sections, genre);
                    defaultVol = 0.76;
                }
                case "harmony" -> {
                    notes = generateHarmony(totalBars, beatsPerBar, chordByBar, sections, genre);
                    defaultVol = 0.65;
                }
                default -> {
                    notes = generateLead(totalBars, beatsPerBar, chordByBar, sections, normalizedMelody, scalePcs);
                    defaultVol = 0.62;
                }
            }

            TrackState built = new TrackState();
            built.setType("midi");
            built.setLocked(existingMeta != null && existingMeta.isLocked());
            built.setMute(existingMeta != null && existingMeta.isMute());
            built.setSolo(existingMeta != null && existingMeta.isSolo());
            built.setVolume(existingMeta != null ? existingMeta.getVolume() : defaultVol);
            built.setPan(existingMeta != null ? existingMeta.getPan() : 0.0);
            built.setInstrument(instName);
            built.setNotes(notes);
            resultTracks.put(trackName, built);
        }

        return resultTracks;
    }

    private boolean shouldIncludeLead(ProjectConfig cfg, String outputMode) {
        if (Boolean.TRUE.equals(cfg.getIncludeLead()) || Boolean.TRUE.equals(cfg.getEnableLeadKaraoke())) {
            return true;
        }
        if (Boolean.FALSE.equals(cfg.getEnableLeadKaraoke()) || Boolean.FALSE.equals(cfg.getIncludeLead())) {
            return false;
        }
        return "full_song".equals(outputMode);
    }

    private TrackState copyTrack(TrackState src) {
        TrackState t = new TrackState();
        t.setType(src.getType());
        t.setLocked(src.isLocked());
        t.setMute(src.isMute());
        t.setSolo(src.isSolo());
        t.setVolume(src.getVolume());
        t.setPan(src.getPan());
        t.setInstrument(src.getInstrument());
        if (src.getClips() != null) t.setClips(new ArrayList<>(src.getClips()));
        if (src.getNotes() != null) {
            List<MidiNote> notesCopy = new ArrayList<>(src.getNotes().size());
            for (MidiNote n : src.getNotes()) notesCopy.add(n.copy());
            t.setNotes(notesCopy);
        }
        return t;
    }

    private Map<String, String> selectInstruments(String genre) {
        String lowered = (genre != null ? genre : "pop").trim().toLowerCase(Locale.ROOT);
        for (Map.Entry<String, Map<String, String>> entry : GENRE_INSTRUMENTS.entrySet()) {
            if (lowered.contains(entry.getKey())) {
                return entry.getValue();
            }
        }
        return GENRE_INSTRUMENTS.get("pop");
    }

    private SongSection sectionForBar(List<SongSection> sections, int barNum) {
        for (SongSection sec : sections) {
            int start = sec.getStartBar();
            int bars = sec.getBars();
            if (barNum >= start && barNum < start + bars) {
                return sec;
            }
        }
        return null;
    }

    private boolean isBridgeSection(SongSection sec) {
        return sec != null && sec.getName() != null
                && sec.getName().toLowerCase(Locale.ROOT).contains("bridge");
    }

    private double sectionEnergyForBar(List<SongSection> sections, int barNum) {
        SongSection sec = sectionForBar(sections, barNum);
        return sec != null ? sec.getEnergy() : 0.7;
    }

    private int bassMidiPitch(int rootPc) {
        int pitch = 36 + Math.floorMod(rootPc, 12);
        if (pitch < 36) pitch += 12;
        return pitch;
    }

    private List<Integer> chordVoicingPitches(List<Integer> chordPcs) {
        int base = 60;
        List<Integer> voicing = new ArrayList<>();
        int limit = Math.min(4, chordPcs.size());
        for (int idx = 0; idx < limit; idx++) {
            int p = base + chordPcs.get(idx);
            if (idx > 0 && p <= voicing.get(voicing.size() - 1)) {
                p += 12;
            }
            voicing.add(Math.min(79, p));
        }
        return voicing;
    }

    private List<MidiNote> generateDrums(int totalBars, int beatsPerBar, List<SongSection> sections, String genre) {
        List<MidiNote> notes = new ArrayList<>();
        String lowered = genre.toLowerCase(Locale.ROOT);
        boolean isBallad = lowered.contains("ballad") || lowered.contains("acoustic");
        boolean isHiphop = lowered.contains("hip-hop") || lowered.contains("r&b");

        for (int barIdx = 0; barIdx < totalBars; barIdx++) {
            int barNum = barIdx + 1;
            SongSection sec = sectionForBar(sections, barNum);
            boolean isBridge = isBridgeSection(sec);
            double energy = sec != null ? sec.getEnergy() : 0.7;
            double barStart = (double) barIdx * beatsPerBar;
            if (energy < 0.32 && barIdx == 0) continue;
            double velScale = Math.max(0.55, Math.min(1.0, energy + 0.15));

            if (isBridge) {
                boolean isFirstBridgeBar = barNum == sec.getStartBar();
                boolean isLastBridgeBar = barNum == sec.getStartBar() + sec.getBars() - 1;
                if (isFirstBridgeBar) {
                    notes.add(new MidiNote(49, barStart, 0.5, (int) (96 * velScale), 1.0));
                }
                // Half-time atmospheric bridge groove with ride cymbal & turnaround fill
                notes.add(new MidiNote(36, barStart, 0.25, (int) (96 * velScale), 1.0));
                if (beatsPerBar >= 4) {
                    notes.add(new MidiNote(36, barStart + 2.5, 0.25, (int) (88 * velScale), 1.0));
                    notes.add(new MidiNote(38, barStart + 2.0, 0.25, (int) (92 * velScale), 1.0));
                } else if (beatsPerBar >= 2) {
                    notes.add(new MidiNote(38, barStart + 1.0, 0.25, (int) (86 * velScale), 1.0));
                }
                for (int beat = 0; beat < beatsPerBar; beat++) {
                    notes.add(new MidiNote(51, barStart + beat, 0.3, (int) (74 * velScale), 1.0));
                }
                if (isLastBridgeBar && beatsPerBar >= 4) {
                    notes.add(new MidiNote(38, barStart + 3.0, 0.25, (int) (95 * velScale), 1.0));
                    notes.add(new MidiNote(38, barStart + 3.5, 0.25, (int) (104 * velScale), 1.0));
                }
                continue;
            }

            for (int beat = 0; beat < beatsPerBar; beat++) {
                double t = barStart + beat;
                if (beat == 0) {
                    notes.add(new MidiNote(36, t, 0.25, (int) (105 * velScale), 1.0));
                } else if (beat == 2 && !isHiphop) {
                    notes.add(new MidiNote(36, t, 0.25, (int) (95 * velScale), 1.0));
                } else if (beat == 2) {
                    notes.add(new MidiNote(36, t + 0.5, 0.25, (int) (98 * velScale), 1.0));
                }

                if (beat == 1 || beat == 3 || (beatsPerBar == 3 && beat == 2)) {
                    int snareVel = (int) ((isBallad ? 78 : 96) * velScale);
                    notes.add(new MidiNote(38, t, 0.25, snareVel, 1.0));
                }

                if (energy >= 0.45) {
                    notes.add(new MidiNote(42, t, 0.2, (int) (72 * velScale), 1.0));
                    if (!isBallad) {
                        notes.add(new MidiNote(42, t + 0.5, 0.2, (int) (62 * velScale), 1.0));
                    }
                }
            }
        }
        return notes;
    }

    private List<MidiNote> generateBass(int totalBars, int beatsPerBar, Map<Integer, String> chordByBar,
                                        List<SongSection> sections, String genre) {
        List<MidiNote> notes = new ArrayList<>();
        boolean isEdm = genre.toLowerCase(Locale.ROOT).contains("edm");

        for (int barIdx = 0; barIdx < totalBars; barIdx++) {
            int barNum = barIdx + 1;
            SongSection sec = sectionForBar(sections, barNum);
            boolean isBridge = isBridgeSection(sec);
            double energy = sec != null ? sec.getEnergy() : 0.7;
            String symbol = chordByBar.getOrDefault(barNum, "C");
            MusicTheory.ParsedChord parsed = MusicTheory.parseChordSymbol(symbol);
            int rootPitch = bassMidiPitch(parsed.rootPc());
            int thirdPc = parsed.pitchClasses().size() >= 2
                    ? parsed.pitchClasses().get(1) : (parsed.rootPc() + 4) % 12;
            int thirdPitch = bassMidiPitch(thirdPc);
            int fifthPc = parsed.pitchClasses().size() >= 3
                    ? parsed.pitchClasses().get(2) : (parsed.rootPc() + 7) % 12;
            int fifthPitch = bassMidiPitch(fifthPc);
            double barStart = (double) barIdx * beatsPerBar;
            int vel = (int) Math.max(65, Math.min(110, 75 + energy * 30));

            if (isBridge && beatsPerBar >= 4) {
                // Sustained melodic pedal + chord-tone walk in Bridge
                notes.add(new MidiNote(rootPitch, barStart, 2.0, vel - 4, 1.0));
                notes.add(new MidiNote(thirdPitch, barStart + 2.0, 1.0, vel - 2, 1.0));
                notes.add(new MidiNote(fifthPitch, barStart + 3.0, 1.0, Math.min(112, vel + 4), 1.0));
            } else if (isEdm && energy >= 0.6) {
                for (int step = 0; step < beatsPerBar * 2; step++) {
                    notes.add(new MidiNote(rootPitch, barStart + step * 0.5, 0.4, vel, 1.0));
                }
            } else if (beatsPerBar >= 4 && energy >= 0.5) {
                notes.add(new MidiNote(rootPitch, barStart, 1.5, vel, 1.0));
                notes.add(new MidiNote(rootPitch, barStart + 1.5, 0.5, vel - 8, 1.0));
                notes.add(new MidiNote(fifthPitch, barStart + 2.0, 1.5, vel - 4, 1.0));
                notes.add(new MidiNote(rootPitch, barStart + 3.5, 0.5, vel - 10, 1.0));
            } else {
                notes.add(new MidiNote(rootPitch, barStart, beatsPerBar, vel, 1.0));
            }
        }
        return notes;
    }

    private List<MidiNote> generateHarmony(int totalBars, int beatsPerBar, Map<Integer, String> chordByBar,
                                           List<SongSection> sections, String genre) {
        List<MidiNote> notes = new ArrayList<>();
        boolean isBallad = genre.toLowerCase(Locale.ROOT).contains("ballad")
                || genre.toLowerCase(Locale.ROOT).contains("acoustic");

        for (int barIdx = 0; barIdx < totalBars; barIdx++) {
            int barNum = barIdx + 1;
            SongSection sec = sectionForBar(sections, barNum);
            boolean isBridge = isBridgeSection(sec);
            double energy = sec != null ? sec.getEnergy() : 0.7;
            String symbol = chordByBar.getOrDefault(barNum, "C");
            MusicTheory.ParsedChord parsed = MusicTheory.parseChordSymbol(symbol);
            List<Integer> voicing = chordVoicingPitches(parsed.pitchClasses());
            double barStart = (double) barIdx * beatsPerBar;
            int vel = (int) Math.max(55, Math.min(95, 58 + energy * 32));

            if (isBridge) {
                // Contrasting arpeggiated texture + low pad root in Bridge
                if (!voicing.isEmpty()) {
                    notes.add(new MidiNote(voicing.get(0), barStart, beatsPerBar, Math.max(52, vel - 8), 1.0));
                    for (int beat = 0; beat < beatsPerBar; beat++) {
                        int arpPitch = voicing.get(beat % voicing.size()) + (beat == beatsPerBar - 1 ? 12 : 0);
                        notes.add(new MidiNote(Math.min(84, arpPitch), barStart + beat, 0.85, vel, 1.0));
                    }
                }
            } else if (isBallad || energy < 0.5) {
                for (int pitch : voicing) {
                    notes.add(new MidiNote(pitch, barStart, beatsPerBar, vel, 1.0));
                }
            } else {
                int[] hitBeats = (energy >= 0.8 && beatsPerBar >= 4)
                        ? new int[]{0, 1, 2, 3}
                        : (beatsPerBar >= 4 ? new int[]{0, 2} : new int[]{0});
                double dur = hitBeats.length <= 2 ? 1.75 : 0.85;
                for (int beat : hitBeats) {
                    for (int pitch : voicing) {
                        notes.add(new MidiNote(pitch, barStart + beat, Math.min(dur, beatsPerBar - beat), vel, 1.0));
                    }
                }
            }
        }
        return notes;
    }

    private List<MidiNote> generateLead(int totalBars, int beatsPerBar, Map<Integer, String> chordByBar,
                                        List<SongSection> sections, List<MidiNote> melodyNotes, List<Integer> scalePcs) {
        List<MidiNote> notes = new ArrayList<>();
        double totalBeats = (double) totalBars * beatsPerBar;
        List<SongSection> motifSections = sections.stream().filter(SongSection::isHasUserMotif).toList();

        if (!motifSections.isEmpty() && melodyNotes != null && !melodyNotes.isEmpty()) {
            for (SongSection motifSec : motifSections) {
                double motifStartBeat = (motifSec.getStartBar() - 1) * (double) beatsPerBar;
                double motifLenBeats = Math.max(1.0, motifSec.getBars() * (double) beatsPerBar);
                for (MidiNote n : melodyNotes) {
                    double shiftedStart = motifStartBeat + (n.getStartBeat() % motifLenBeats);
                    if (shiftedStart < totalBeats) {
                        double maxDur = Math.min(n.getDuration(), totalBeats - shiftedStart);
                        if (maxDur >= 0.125) {
                            notes.add(new MidiNote(n.getPitch(),
                                    Math.round(shiftedStart * 10000.0) / 10000.0,
                                    Math.round(maxDur * 10000.0) / 10000.0,
                                    n.getVelocity(), 1.0));
                        }
                    }
                }
            }
            // Add contrasting counter-melody in Bridge sections
            for (SongSection sec : sections) {
                if (isBridgeSection(sec) && !sec.isHasUserMotif()) {
                    for (int offset = 0; offset < sec.getBars(); offset++) {
                        int barNum = sec.getStartBar() + offset;
                        if (barNum < 1 || barNum > totalBars) continue;
                        String symbol = chordByBar.getOrDefault(barNum, "C");
                        MusicTheory.ParsedChord parsed = MusicTheory.parseChordSymbol(symbol);
                        int pc1 = parsed.pitchClasses().size() > 1 ? parsed.pitchClasses().get(1) : parsed.rootPc();
                        int pc2 = parsed.pitchClasses().size() > 2 ? parsed.pitchClasses().get(2) : pc1;
                        double barStart = (barNum - 1) * (double) beatsPerBar;
                        notes.add(new MidiNote(72 + pc1, barStart, Math.min(2.0, beatsPerBar), 80, 1.0));
                        if (beatsPerBar >= 4) {
                            notes.add(new MidiNote(72 + pc2, barStart + 2.0, 1.75, 84, 1.0));
                        }
                    }
                }
            }
        } else {
            for (int barIdx = 0; barIdx < totalBars; barIdx++) {
                int barNum = barIdx + 1;
                SongSection sec = sectionForBar(sections, barNum);
                double energy = sec != null ? sec.getEnergy() : 0.7;
                if (energy < 0.45) continue;
                String symbol = chordByBar.getOrDefault(barNum, "C");
                MusicTheory.ParsedChord parsed = MusicTheory.parseChordSymbol(symbol);
                int leadPc = parsed.pitchClasses().size() > 1
                        ? parsed.pitchClasses().get(1)
                        : (!scalePcs.isEmpty() ? scalePcs.get(0) : 0);
                notes.add(new MidiNote(72 + leadPc, (double) barIdx * beatsPerBar, 2.0, 78, 1.0));
            }
        }
        return notes;
    }
}
