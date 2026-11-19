package com.aimusic.studio;

import com.aimusic.studio.agents.AgentOrchestrator;
import com.aimusic.studio.agents.ArrangerAgent;
import com.aimusic.studio.agents.CoachLyricistAgent;
import com.aimusic.studio.agents.ComposerAgent;
import com.aimusic.studio.agents.LlmAdapter;
import com.aimusic.studio.agents.LlmContextHolder;
import com.aimusic.studio.agents.MusicTheory;
import com.aimusic.studio.agents.QaReviewerAgent;
import com.aimusic.studio.model.ChordEvent;
import com.aimusic.studio.model.MidiNote;
import com.aimusic.studio.model.ProjectConfig;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.SongSection;
import com.aimusic.studio.model.TrackState;
import com.aimusic.studio.model.dto.CoachChatResponse;
import com.aimusic.studio.store.ProjectStateStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class AgentPipelineTests {

    private final ObjectMapper objectMapper = new ObjectMapper();

    private ProjectState sampleProjectState(String melodyMode, String outputMode) {
        ProjectState state = ProjectState.createDefault("proj_test_001", "Test Song");
        state.getConfig().setMelodyMode(melodyMode);
        state.getConfig().setOutputMode(outputMode);
        state.getConfig().setMotifPosition("chorus");
        state.getConfig().setGenre("Pop");
        state.getConfig().setMood("Emotional");
        state.getConfig().setUserPrompt("Warm piano and clean groove");

        state.getAudioAssets().setRawInputRef("mem://raw/input.wav");
        state.getAudioAssets().setDryDenoisedRef("mem://processed/dry_denoised.wav");
        state.getAudioAssets().setTunedVocalRef("mem://processed/vocal_autotuned.wav");

        state.getAnalysis().setBpm(100.0);
        state.getAnalysis().setTimeSignature("4/4");
        state.getAnalysis().setDetectedKey("C");
        state.getAnalysis().setDetectedScale("major");
        state.getAnalysis().setRawMelodyMidi(List.of(
                new MidiNote(60, 0.0, 1.0, 85, 1.0),
                new MidiNote(64, 1.0, 1.0, 88, 1.0),
                new MidiNote(67, 2.0, 2.0, 90, 1.0),
                new MidiNote(65, 4.0, 1.0, 84, 1.0),
                new MidiNote(64, 5.0, 1.0, 82, 1.0),
                new MidiNote(62, 6.0, 2.0, 80, 1.0)
        ));
        return state;
    }

    @Test
    void llmAdapterMockFallbackAndRoutingAndHeaderOverrides() {
        LlmAdapter adapter = new LlmAdapter("your_gemini_api_key_here", "", "gemini", objectMapper);
        assertEquals(LlmAdapter.Provider.MOCK, adapter.resolveProvider("composer", null));
        assertEquals(LlmAdapter.Provider.MOCK, adapter.resolveProvider("qa", null));

        var r1 = adapter.generateJson("Create chords in C major", "", "composer", null);
        var r2 = adapter.generateJson("Create chords in C major", "", "composer", null);
        assertTrue(r1.isMock());
        assertEquals(LlmAdapter.Provider.MOCK, r1.provider());
        assertEquals(r1.data(), r2.data());

        adapter.configure("AIzaDummyValidLookingKey12345", "sk-dummy-valid-looking-key-12345", null,
                Map.of("composer", "gemini", "qa", "openai"));
        assertEquals(LlmAdapter.Provider.GEMINI, adapter.resolveProvider("composer", null));
        assertEquals(LlmAdapter.Provider.OPENAI, adapter.resolveProvider("qa", null));

        var mockForced = adapter.generateText("hello", "", null, "mock");
        assertTrue(mockForced.isMock());
        assertEquals(LlmAdapter.Provider.MOCK, mockForced.provider());

        MockHttpServletRequest req = new MockHttpServletRequest();
        req.addHeader("X-Gemini-Api-Key", "AIzaHeaderOverrideKey12345");
        req.addHeader("X-OpenAI-Api-Key", "sk-HeaderOverrideKey12345");
        req.addHeader("X-LLM-Provider", "openai");
        LlmContextHolder.set(LlmContextHolder.extractFromRequest(req));
        try {
            assertEquals("AIzaHeaderOverrideKey12345", adapter.effectiveGeminiKey());
            assertEquals("sk-HeaderOverrideKey12345", adapter.effectiveOpenaiKey());
            assertEquals(LlmAdapter.Provider.OPENAI, adapter.effectiveDefaultProvider());
            // X-LLM-Provider: openai overrides hardcoded composer -> GEMINI roleProviders
            assertEquals(LlmAdapter.Provider.OPENAI, adapter.resolveProvider("composer", null));
        } finally {
            LlmContextHolder.clear();
        }

        // X-LLM-Provider: mock must override even when valid Gemini/OpenAI keys and roleProviders exist
        MockHttpServletRequest mockHeaderReq = new MockHttpServletRequest();
        mockHeaderReq.addHeader("X-LLM-Provider", "mock");
        LlmContextHolder.set(LlmContextHolder.extractFromRequest(mockHeaderReq));
        try {
            assertEquals(LlmAdapter.Provider.MOCK, adapter.resolveProvider("composer", null));
            assertEquals(LlmAdapter.Provider.MOCK, adapter.resolveProvider("arranger", null));
            assertEquals(LlmAdapter.Provider.MOCK, adapter.resolveProvider("qa", null));
            var resp = adapter.generateJson("Create chords", "", "composer", null);
            assertTrue(resp.isMock());
            assertEquals(LlmAdapter.Provider.MOCK, resp.provider());
        } finally {
            LlmContextHolder.clear();
        }

        // X-Agent-Providers JSON header routes per role
        MockHttpServletRequest agentHeaderReq = new MockHttpServletRequest();
        agentHeaderReq.addHeader("X-LLM-Provider", "gemini");
        agentHeaderReq.addHeader("X-Agent-Providers", "{\"composer\":\"openai\",\"qa\":\"mock\"}");
        LlmContextHolder.set(LlmContextHolder.extractFromRequest(agentHeaderReq));
        try {
            assertEquals(LlmAdapter.Provider.OPENAI, adapter.resolveProvider("composer", null));
            assertEquals(LlmAdapter.Provider.MOCK, adapter.resolveProvider("qa", null));
            assertEquals(LlmAdapter.Provider.GEMINI, adapter.resolveProvider("lyricist", null));
        } finally {
            LlmContextHolder.clear();
        }
    }

    @Test
    void promptSanitization() {
        String longPrompt = "Make it sound like Taylor Swift! " + "a".repeat(600);
        String cleaned = MusicTheory.sanitizeUserPrompt(longPrompt);
        assertTrue(cleaned.length() <= 500);
        assertFalse(cleaned.contains("Taylor Swift"));
    }

    @Test
    void preserveAccompanimentOrchestration() {
        LlmAdapter adapter = new LlmAdapter("", "", "mock", objectMapper);
        ProjectStateStore store = new ProjectStateStore(objectMapper, 3600, 3600, true);
        AgentOrchestrator orch = new AgentOrchestrator(
                new ComposerAgent(adapter),
                new ArrangerAgent(adapter),
                new CoachLyricistAgent(adapter),
                new QaReviewerAgent(adapter),
                store,
                objectMapper,
                60.0,
                2
        );

        ProjectState input = sampleProjectState("preserve", "accompaniment");
        List<String> events = new ArrayList<>();
        ProjectState result = orch.runGenerate(input, null, "job_test_1",
                (ev, payload) -> events.add(ev), null, null, 60.0);

        assertEquals(6, result.getMelodyNotes().size());
        for (int i = 0; i < 6; i++) {
            assertEquals(input.getAnalysis().getRawMelodyMidi().get(i).getPitch(),
                    result.getMelodyNotes().get(i).getPitch());
            assertEquals(input.getAnalysis().getRawMelodyMidi().get(i).getStartBeat(),
                    result.getMelodyNotes().get(i).getStartBeat());
        }

        assertEquals(2, result.getSongStructure().getTotalBars());
        assertEquals(2, result.getSongStructure().getChords().size());

        for (String name : List.of("drums", "bass", "harmony")) {
            TrackState t = result.getTracks().get(name);
            assertNotNull(t);
            assertFalse(t.getNotes().isEmpty());
        }
        for (MidiNote n : result.getTracks().get("bass").getNotes()) {
            assertTrue(n.getPitch() <= 60);
        }

        assertTrue(result.getQaStatus().isApproved());
        assertEquals(1, result.getQaStatus().getIterations());
        assertFalse(result.getQaStatus().isFallbackUsed());
        assertTrue(result.getMastering().getLimiterCeilingDb() <= -1.0);
        assertTrue(events.contains("agent_step"));
        assertTrue(events.contains("completed"));
    }

    @Test
    void enhanceFullSongWithLyricsAndNonMutatingCoach() throws Exception {
        LlmAdapter adapter = new LlmAdapter("", "", "mock", objectMapper);
        ProjectStateStore store = new ProjectStateStore(objectMapper, 3600, 3600, true);
        CoachLyricistAgent coach = new CoachLyricistAgent(adapter);
        AgentOrchestrator orch = new AgentOrchestrator(
                new ComposerAgent(adapter),
                new ArrangerAgent(adapter),
                coach,
                new QaReviewerAgent(adapter),
                store,
                objectMapper,
                60.0,
                2
        );

        ProjectState result = orch.runGenerate(sampleProjectState("enhance", "full_song"), null, "job_full_1",
                null, null, null, 60.0);

        List<SongSection> sections = result.getSongStructure().getSections();
        assertTrue(sections.size() >= 3);
        assertTrue(sections.stream().anyMatch(s -> s.getName().toLowerCase().contains("chorus") && s.isHasUserMotif()));
        assertFalse(result.getTracks().get("lead").getNotes().isEmpty());
        assertFalse(result.getLyrics().getLines().isEmpty());

        String beforeJson = objectMapper.writeValueAsString(result);
        CoachChatResponse advice = coach.chatCoach(result, "Nên đặt câu ngân nga ở Chorus hay Verse?", List.of());
        assertNotNull(advice.getReply());
        assertFalse(advice.getReply().isBlank());
        assertEquals(beforeJson, objectMapper.writeValueAsString(result));
    }

    @Test
    void qaLoopMax2IterationsAndBestEffortFallback() {
        LlmAdapter adapter = new LlmAdapter("", "", "mock", objectMapper);
        ProjectStateStore store = new ProjectStateStore(objectMapper, 3600, 3600, true);
        AtomicInteger qaCalls = new AtomicInteger(0);

        QaReviewerAgent alwaysFailQa = new QaReviewerAgent(adapter) {
            @Override
            public QaReport review(ProjectState projectState, String targetTrack) {
                int c = qaCalls.incrementAndGet();
                return new QaReport(false, 0.4 + 0.1 * c, List.of("Simulated harmony clash"),
                        "Adjust harmony chord voicing.", "arranger", -1.0, -14.0, true);
            }
        };

        AgentOrchestrator orch = new AgentOrchestrator(
                new ComposerAgent(adapter),
                new ArrangerAgent(adapter),
                new CoachLyricistAgent(adapter),
                alwaysFailQa,
                store,
                objectMapper,
                60.0,
                2
        );

        List<String> events = new ArrayList<>();
        ProjectState result = orch.runGenerate(sampleProjectState("preserve", "accompaniment"),
                null, "job_qa_fail", (ev, p) -> events.add(ev), null, null, 60.0);

        assertEquals(2, qaCalls.get());
        assertFalse(result.getQaStatus().isApproved());
        assertEquals(2, result.getQaStatus().getIterations());
        assertTrue(result.getQaStatus().isFallbackUsed());
        assertEquals(1, events.stream().filter("qa_retry"::equals).count());
        assertTrue(events.contains("fallback_warning"));
        assertTrue(events.contains("completed"));
    }

    @Test
    void timeoutAndCancelToken() {
        LlmAdapter adapter = new LlmAdapter("", "", "mock", objectMapper);
        ProjectStateStore store = new ProjectStateStore(objectMapper, 3600, 3600, true);
        ComposerAgent slowComposer = new ComposerAgent(adapter) {
            @Override
            public ComposeResult compose(ProjectState projectState, String qaFeedback) {
                try {
                    Thread.sleep(500);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return super.compose(projectState, qaFeedback);
            }
        };

        AgentOrchestrator orch = new AgentOrchestrator(
                slowComposer,
                new ArrangerAgent(adapter),
                new CoachLyricistAgent(adapter),
                new QaReviewerAgent(adapter),
                store,
                objectMapper,
                60.0,
                2
        );

        List<String> timeoutEvents = new ArrayList<>();
        assertThrows(AgentOrchestrator.JobTimeoutException.class, () ->
                orch.runGenerate(sampleProjectState("preserve", "accompaniment"),
                        null, "job_to", (ev, p) -> timeoutEvents.add(ev), null, null, 0.05));
        assertEquals("error", timeoutEvents.get(timeoutEvents.size() - 1));

        AtomicBoolean cancelToken = new AtomicBoolean(true);
        List<String> cancelEvents = new ArrayList<>();
        assertThrows(AgentOrchestrator.JobCancelledException.class, () ->
                orch.runGenerate(sampleProjectState("preserve", "accompaniment"),
                        null, "job_cancel", (ev, p) -> cancelEvents.add(ev), cancelToken, null, 10.0));
        assertEquals("error", cancelEvents.get(cancelEvents.size() - 1));
    }

    @Test
    void regenerateSingleTrackAndRearrangeRespectsLocked() {
        LlmAdapter adapter = new LlmAdapter("", "", "mock", objectMapper);
        ProjectStateStore store = new ProjectStateStore(objectMapper, 3600, 3600, true);
        AgentOrchestrator orch = new AgentOrchestrator(
                new ComposerAgent(adapter),
                new ArrangerAgent(adapter),
                new CoachLyricistAgent(adapter),
                new QaReviewerAgent(adapter),
                store,
                objectMapper,
                60.0,
                2
        );

        ProjectState base = orch.runGenerate(sampleProjectState("preserve", "accompaniment"),
                null, "job_base", null, null, null, 60.0);
        int origDrumsCount = base.getTracks().get("drums").getNotes().size();
        int origHarmonyCount = base.getTracks().get("harmony").getNotes().size();

        ProjectState regen = orch.runRegenerateTrack(base, "bass", "synth_bass",
                "job_regen", null, null, null, 60.0);
        assertEquals("synth_bass", regen.getTracks().get("bass").getInstrument());
        assertEquals(origDrumsCount, regen.getTracks().get("drums").getNotes().size());
        assertEquals(origHarmonyCount, regen.getTracks().get("harmony").getNotes().size());

        regen.getTracks().get("drums").setLocked(true);
        List<ChordEvent> newChords = List.of(
                new ChordEvent(1, 1.0, "Am", 4.0),
                new ChordEvent(2, 1.0, "F", 4.0)
        );
        ProjectState rearranged = orch.runRearrange(regen, newChords, List.of("drums"),
                "job_rearr", null, null, null, 60.0);
        assertEquals(origDrumsCount, rearranged.getTracks().get("drums").getNotes().size());
        assertEquals("Am", rearranged.getSongStructure().getChords().get(0).getSymbol());
        assertEquals("F", rearranged.getSongStructure().getChords().get(1).getSymbol());
    }

    @Test
    void regenerateAndRearrangeFallbackEmitProgress100AndCancelInterruptsJob() throws Exception {
        LlmAdapter adapter = new LlmAdapter("", "", "mock", objectMapper);
        ProjectStateStore store = new ProjectStateStore(objectMapper, 3600, 3600, true);
        QaReviewerAgent alwaysFailQa = new QaReviewerAgent(adapter) {
            @Override
            public QaReport review(ProjectState projectState, String targetTrack) {
                return new QaReport(false, 0.5, List.of("Test QA fail"),
                        "Retry", "arranger", -1.0, -14.0, true);
            }
        };
        AgentOrchestrator orch = new AgentOrchestrator(
                new ComposerAgent(adapter),
                new ArrangerAgent(adapter),
                new CoachLyricistAgent(adapter),
                alwaysFailQa,
                store,
                objectMapper,
                60.0,
                1
        );

        List<Map<String, Object>> regenProgress = new ArrayList<>();
        orch.runRegenerateTrack(sampleProjectState("preserve", "accompaniment"), "bass", "finger_bass",
                "job_rf", (ev, p) -> { if ("progress".equals(ev)) regenProgress.add(p); }, null, null, 60.0);
        assertTrue(regenProgress.stream().anyMatch(p -> Integer.valueOf(100).equals(p.get("progress"))));

        List<Map<String, Object>> rearrProgress = new ArrayList<>();
        orch.runRearrange(sampleProjectState("preserve", "accompaniment"),
                List.of(new ChordEvent(1, 1.0, "C", 4.0)), List.of(),
                "job_raf", (ev, p) -> { if ("progress".equals(ev)) rearrProgress.add(p); }, null, null, 60.0);
        assertTrue(rearrProgress.stream().anyMatch(p -> Integer.valueOf(100).equals(p.get("progress"))));

        // Cancel interrupts active job thread and records SSE error
        AtomicBoolean interruptedSeen = new AtomicBoolean(false);
        ComposerAgent blockingComposer = new ComposerAgent(adapter) {
            @Override
            public ComposeResult compose(ProjectState projectState, String qaFeedback) {
                try {
                    Thread.sleep(5000);
                } catch (InterruptedException e) {
                    interruptedSeen.set(true);
                    Thread.currentThread().interrupt();
                }
                return super.compose(projectState, qaFeedback);
            }
        };
        AgentOrchestrator cancelOrch = new AgentOrchestrator(
                blockingComposer,
                new ArrangerAgent(adapter),
                new CoachLyricistAgent(adapter),
                new QaReviewerAgent(adapter),
                store,
                objectMapper,
                60.0,
                1
        );
        var job = cancelOrch.startGenerateJob(sampleProjectState("preserve", "accompaniment"), null, null);
        Thread.sleep(100);
        assertTrue(cancelOrch.cancelJob(job.getJobId()));
        Thread.sleep(150);
        assertTrue(interruptedSeen.get());
        assertEquals("cancelled", job.getStatus());
    }

    @Test
    void standardFullSongIncludesBridgeAndShortPresetExcludesBridge() {
        LlmAdapter adapter = new LlmAdapter("", "", "mock", objectMapper);
        ProjectStateStore store = new ProjectStateStore(objectMapper, 3600, 3600, true);
        AgentOrchestrator orch = new AgentOrchestrator(
                new ComposerAgent(adapter),
                new ArrangerAgent(adapter),
                new CoachLyricistAgent(adapter),
                new QaReviewerAgent(adapter),
                store,
                objectMapper,
                60.0,
                2
        );

        // Default ("standard") structure preset
        ProjectState stdInput = sampleProjectState("enhance", "full_song");
        assertEquals("standard", stdInput.getConfig().getStructurePreset());
        ProjectState stdResult = orch.runGenerate(stdInput, null, "job_std_bridge",
                null, null, null, 60.0);

        List<String> stdNames = stdResult.getSongStructure().getSections().stream()
                .map(SongSection::getName).toList();
        assertEquals(List.of("Intro", "Verse 1", "Chorus", "Verse 2", "Bridge", "Chorus", "Outro"), stdNames);
        assertTrue(stdResult.getQaStatus().isApproved());

        SongSection bridge = stdResult.getSongStructure().getSections().get(4);
        assertEquals("Bridge", bridge.getName());
        assertEquals(0.72, bridge.getEnergy(), 0.01);

        // Bridge drums include ride (51) or crash (49) for textural contrast
        double bridgeStartBeat = (bridge.getStartBar() - 1) * 4.0;
        double bridgeEndBeat = bridgeStartBeat + bridge.getBars() * 4.0;
        boolean hasBridgeRideOrCrash = stdResult.getTracks().get("drums").getNotes().stream()
                .anyMatch(n -> n.getStartBeat() >= bridgeStartBeat && n.getStartBeat() < bridgeEndBeat
                        && (n.getPitch() == 51 || n.getPitch() == 49));
        assertTrue(hasBridgeRideOrCrash, "Expected Bridge drums to have distinct ride/crash instrumentation");

        // Enhance melody adds scale-aware passing notes without breaking scale or contour
        List<MidiNote> enhanced = stdResult.getMelodyNotes();
        assertTrue(enhanced.size() > stdInput.getAnalysis().getRawMelodyMidi().size(),
                "Expected enhanceMelody to add scale-aware passing notes across melodic leaps");
        List<Integer> cMajorPcs = MusicTheory.getScalePitchClasses("C", "major");
        for (int i = 0; i < enhanced.size(); i++) {
            assertTrue(cMajorPcs.contains(Math.floorMod(enhanced.get(i).getPitch(), 12)));
            if (i > 0) {
                assertTrue(enhanced.get(i).getStartBeat() >= enhanced.get(i - 1).getStartBeat());
            }
        }

        // "short" structure preset
        ProjectState shortInput = sampleProjectState("preserve", "full_song");
        shortInput.getConfig().setStructurePreset("short");
        ProjectState shortResult = orch.runGenerate(shortInput, null, "job_short_fs",
                null, null, null, 60.0);
        List<String> shortNames = shortResult.getSongStructure().getSections().stream()
                .map(SongSection::getName).toList();
        assertEquals(List.of("Intro", "Verse 1", "Chorus", "Outro"), shortNames);
    }

    @Test
    void rearrangeRespectsCustomSectionsAndChords() {
        LlmAdapter adapter = new LlmAdapter("", "", "mock", objectMapper);
        ProjectStateStore store = new ProjectStateStore(objectMapper, 3600, 3600, true);
        AgentOrchestrator orch = new AgentOrchestrator(
                new ComposerAgent(adapter),
                new ArrangerAgent(adapter),
                new CoachLyricistAgent(adapter),
                new QaReviewerAgent(adapter),
                store,
                objectMapper,
                60.0,
                2
        );

        ProjectState base = orch.runGenerate(sampleProjectState("preserve", "full_song"),
                null, "job_rearr_base", null, null, null, 60.0);
        base.getTracks().get("drums").setLocked(true);
        List<MidiNote> lockedDrumsNotes = List.copyOf(base.getTracks().get("drums").getNotes());

        List<SongSection> customSections = List.of(
                new SongSection("Intro", 1, 2, 0.35, false),
                new SongSection("Verse 1", 3, 2, 0.55, false),
                new SongSection("Bridge", 5, 2, 0.72, false),
                new SongSection("Chorus", 7, 2, 0.90, true)
        );
        List<ChordEvent> customChords = List.of(
                new ChordEvent(1, 1.0, "C", 4.0),
                new ChordEvent(2, 1.0, "G", 4.0),
                new ChordEvent(3, 1.0, "Am", 4.0),
                new ChordEvent(4, 1.0, "F", 4.0),
                new ChordEvent(5, 1.0, "Dm", 4.0),
                new ChordEvent(6, 1.0, "G", 4.0),
                new ChordEvent(7, 1.0, "C", 4.0),
                new ChordEvent(8, 1.0, "G", 4.0)
        );

        ProjectState updated = orch.runRearrange(base, customChords, customSections, 8, List.of("drums"),
                "job_rearr_custom", null, null, null, 60.0);

        assertEquals(8, updated.getSongStructure().getTotalBars());
        assertEquals(4, updated.getSongStructure().getSections().size());
        assertEquals("Bridge", updated.getSongStructure().getSections().get(2).getName());
        assertEquals("Dm", updated.getSongStructure().getChords().get(4).getSymbol());
        assertEquals(lockedDrumsNotes.size(), updated.getTracks().get("drums").getNotes().size());
        // Bass at bar 5 (beat 16) should follow Dm root (D = pitch class 2 -> MIDI 38)
        boolean hasDmBassAtBar5 = updated.getTracks().get("bass").getNotes().stream()
                .anyMatch(n -> Math.abs(n.getStartBeat() - 16.0) < 0.01 && Math.floorMod(n.getPitch(), 12) == 2);
        assertTrue(hasDmBassAtBar5, "Expected Bass at bar 5 to follow custom Dm chord root");
    }

    @Test
    void launchJobPersistsStateBeforeEmittingCompletedSse() throws Exception {
        LlmAdapter adapter = new LlmAdapter("", "", "mock", objectMapper);
        java.util.concurrent.atomic.AtomicBoolean storeSaved = new java.util.concurrent.atomic.AtomicBoolean(false);
        ProjectStateStore slowStore = new ProjectStateStore(objectMapper, 3600, 3600, true) {
            @Override
            public ProjectState saveProject(ProjectState project) {
                if (project.getSongStructure() != null && !project.getSongStructure().getSections().isEmpty()) {
                    try {
                        Thread.sleep(150);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    storeSaved.set(true);
                }
                return super.saveProject(project);
            }
        };
        ProjectState initial = sampleProjectState("enhance", "full_song");
        slowStore.saveProject(initial);

        AgentOrchestrator orch = new AgentOrchestrator(
                new ComposerAgent(adapter),
                new ArrangerAgent(adapter),
                new CoachLyricistAgent(adapter),
                new QaReviewerAgent(adapter),
                slowStore,
                objectMapper,
                60.0,
                2
        );

        var job = orch.startGenerateJob(initial, null, null);
        long deadline = System.currentTimeMillis() + 10_000L;
        while (!"completed".equals(job.getStatus()) && System.currentTimeMillis() < deadline) {
            Thread.sleep(10);
        }
        assertEquals("completed", job.getStatus());
        assertTrue(storeSaved.get(), "ProjectStateStore must finish saving BEFORE job status becomes completed");

        ProjectState storedAfter = slowStore.getProject(initial.getProjectId()).orElseThrow();
        assertTrue(storedAfter.getSongStructure().getSections().stream()
                .anyMatch(s -> "Bridge".equals(s.getName())));
    }
}
