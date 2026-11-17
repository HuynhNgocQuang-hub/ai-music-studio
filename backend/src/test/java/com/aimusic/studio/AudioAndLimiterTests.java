package com.aimusic.studio;

import com.aimusic.studio.agents.MusicTheory;
import com.aimusic.studio.audio.AudioValidationException;
import com.aimusic.studio.audio.JavaAudioFallbackService;
import com.aimusic.studio.model.AutotuneSettings;
import com.aimusic.studio.model.MidiNote;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.TrackState;
import com.aimusic.studio.store.ProjectStateStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import javax.sound.midi.MetaMessage;
import javax.sound.midi.MidiEvent;
import javax.sound.midi.MidiMessage;
import javax.sound.midi.MidiSystem;
import javax.sound.midi.Sequence;
import javax.sound.midi.Track;
import java.io.ByteArrayInputStream;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.*;

class AudioAndLimiterTests {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final JavaAudioFallbackService audioService = new JavaAudioFallbackService(objectMapper);

    private byte[] makeMelodyWav(double durationSec, int sr, boolean addNoise) {
        double[] freqs = {261.63, 329.63, 392.00, 523.25};
        int nTotal = (int) (durationSec * sr);
        float[] samples = new float[nTotal];
        int segLen = Math.max(1, nTotal / freqs.length);
        for (int i = 0; i < freqs.length; i++) {
            int s = i * segLen;
            int e = (i == freqs.length - 1) ? nTotal : (i + 1) * segLen;
            for (int k = s; k < e; k++) {
                double t = (double) k / sr;
                samples[k] = (float) (0.45 * Math.sin(2.0 * Math.PI * freqs[i] * t));
                if (addNoise) {
                    samples[k] += (float) (0.015 * Math.sin(2.0 * Math.PI * 50.0 * t));
                }
            }
        }
        return audioService.encodeWavMono(samples, sr);
    }

    @Test
    void uploadValidationRules() {
        AudioValidationException badExt = assertThrows(AudioValidationException.class, () ->
                audioService.validateAndDecodeAudio("hello".getBytes(), "notes.txt", 50_000_000L, 3.0, 60.0, 44100));
        assertEquals(HttpStatus.BAD_REQUEST, badExt.getStatus());

        byte[] shortWav = makeMelodyWav(1.5, 44100, false);
        AudioValidationException tooShort = assertThrows(AudioValidationException.class, () ->
                audioService.validateAndDecodeAudio(shortWav, "short.wav", 50_000_000L, 3.0, 60.0, 44100));
        assertEquals(HttpStatus.BAD_REQUEST, tooShort.getStatus());

        AudioValidationException tooBig = assertThrows(AudioValidationException.class, () ->
                audioService.validateAndDecodeAudio(new byte[1024], "big.wav", 512L, 3.0, 60.0, 44100));
        assertEquals(HttpStatus.PAYLOAD_TOO_LARGE, tooBig.getStatus());
    }

    @Test
    void autotunePreservesLengthAndEnharmonicKeys() {
        byte[] wav = makeMelodyWav(3.2, 44100, false);
        var orig = audioService.decodeWavBytes(wav);
        AutotuneSettings settings = audioService.applyPreset("modern", "C", "major");
        byte[] tunedWav = audioService.applyAutotune(wav, settings);
        var tuned = audioService.decodeWavBytes(tunedWav);
        assertEquals(orig.sampleRate(), tuned.sampleRate());
        assertEquals(orig.mono().length, tuned.mono().length);

        assertEquals(3, MusicTheory.parseKeyRoot("Eb"));
        assertEquals(8, MusicTheory.parseKeyRoot("Ab"));
        assertEquals(10, MusicTheory.parseKeyRoot("Bb"));
        assertEquals(63.0, MusicTheory.nearestScaleMidi(63.1, "Eb", "major"));
        assertEquals(70.0, MusicTheory.nearestScaleMidi(70.2, "Bb", "major"));
    }

    @Test
    void masterLimiterEnforcesMinus1Dbfs() {
        int sr = 44100;
        float[][] hot = new float[sr][2];
        for (int i = 0; i < sr; i++) {
            double t = (double) i / sr;
            hot[i][0] = (float) (2.2 * Math.sin(2 * Math.PI * 220 * t));
            hot[i][1] = (float) (2.2 * Math.sin(2 * Math.PI * 440 * t));
        }
        float[][] limited = audioService.applyMasterLimiter(hot, -1.0, -14.0);
        assertTrue(audioService.peakDbfs(limited) <= -1.0);
    }

    @Test
    void midiRenderStemsMidiMetaAndAimusicExportImport() throws Exception {
        ProjectStateStore store = new ProjectStateStore(objectMapper, 3600, 3600, true);
        ProjectState proj = ProjectState.createDefault("proj_export_1", "Rendered Song");
        proj.getAnalysis().setBpm(120.0);
        proj.getAnalysis().setDetectedKey("C");
        proj.getAnalysis().setDetectedScale("major");
        proj.getAnalysis().setBars(4);
        proj.getSongStructure().setTotalBars(4);

        proj.getTracks().get("drums").setNotes(List.of(
                new MidiNote(36, 0.0, 0.5, 120, 1.0),
                new MidiNote(38, 1.0, 0.5, 115, 1.0)
        ));
        proj.getTracks().get("bass").setNotes(List.of(
                new MidiNote(36, 0.0, 2.0, 120, 1.0),
                new MidiNote(43, 2.0, 2.0, 120, 1.0)
        ));
        proj.getTracks().get("harmony").setNotes(List.of(
                new MidiNote(60, 0.0, 4.0, 110, 1.0),
                new MidiNote(64, 0.0, 4.0, 110, 1.0),
                new MidiNote(67, 0.0, 4.0, 110, 1.0)
        ));
        for (TrackState t : proj.getTracks().values()) {
            t.setVolume(1.2);
        }
        byte[] vocalWav = makeMelodyWav(3.5, 44100, false);
        String rawRef = "mem://raw/" + proj.getProjectId() + ".wav";
        store.saveAudioBytes(rawRef, vocalWav);
        proj.getAudioAssets().setRawInputRef(rawRef);
        store.saveProject(proj);

        // Render mix & equal-length stems
        var rendered = audioService.renderProjectMix(proj, store, "ai_mix", true, 44100);
        assertTrue(audioService.peakDbfs(rendered.stereo()) <= -1.0);
        Set<Integer> stemLengths = new HashSet<>();
        rendered.stems().values().forEach(arr -> stemLengths.add(arr.length));
        assertEquals(1, stemLengths.size());

        // Stems ZIP
        byte[] stemsZip = audioService.exportStemsZip(rendered.stems(), 44100);
        Set<String> zipNames = new HashSet<>();
        try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(stemsZip))) {
            ZipEntry e;
            while ((e = zis.getNextEntry()) != null) zipNames.add(e.getName());
        }
        assertTrue(zipNames.contains("stems/drums.wav"));
        assertTrue(zipNames.contains("stems/bass.wav"));

        // MIDI with Meta Events
        byte[] midiBytes = audioService.exportMidi(proj);
        Sequence seq = MidiSystem.getSequence(new ByteArrayInputStream(midiBytes));
        Set<Integer> metaTypes = new HashSet<>();
        for (Track tr : seq.getTracks()) {
            for (int i = 0; i < tr.size(); i++) {
                MidiEvent ev = tr.get(i);
                MidiMessage msg = ev.getMessage();
                if (msg instanceof MetaMessage mm) {
                    metaTypes.add(mm.getType());
                }
            }
        }
        assertTrue(metaTypes.contains(0x51)); // Set Tempo
        assertTrue(metaTypes.contains(0x58)); // Time Signature
        assertTrue(metaTypes.contains(0x59)); // Key Signature

        // .aimusic export + re-import
        byte[] bundle = audioService.exportAimusicBundle(proj, store);
        Set<String> bundleNames = new HashSet<>();
        try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(bundle))) {
            ZipEntry e;
            while ((e = zis.getNextEntry()) != null) bundleNames.add(e.getName());
        }
        assertTrue(bundleNames.contains("manifest.json"));
        assertTrue(bundleNames.contains("project.json"));
        assertTrue(bundleNames.contains("audio/raw_input.wav"));

        store.deleteProject(proj.getProjectId());
        ProjectState reimported = audioService.importAimusicBundle(bundle, store);
        assertEquals(proj.getProjectId(), reimported.getProjectId());
        assertTrue(store.getAudioBytes(reimported.getAudioAssets().getRawInputRef()).isPresent());

        // Guard when all tracks muted
        for (TrackState t : proj.getTracks().values()) t.setMute(true);
        assertThrows(IllegalArgumentException.class, () ->
                audioService.renderProjectMix(proj, store, "ai_mix", true, 44100));
    }

    @Test
    void memoryTtlExpirationAndUndoStack() throws Exception {
        ProjectStateStore memStore = new ProjectStateStore(objectMapper, 1, 1, true);
        ProjectState p = ProjectState.createDefault("ttl_test", "TTL Check");
        memStore.saveProject(p, 1L);
        assertTrue(memStore.getProject("ttl_test").isPresent());
        Thread.sleep(1150);
        assertTrue(memStore.getProject("ttl_test").isEmpty());

        // Undo stack capped at 20
        ProjectState u = ProjectState.createDefault("undo_test", "V0");
        for (int i = 1; i <= 25; i++) {
            u.getConfig().setTitle("V" + i);
            memStore.pushUndo("undo_test", u, 20);
        }
        int popped = 0;
        while (memStore.popUndo("undo_test").isPresent()) {
            popped++;
        }
        assertEquals(20, popped);
    }
}
