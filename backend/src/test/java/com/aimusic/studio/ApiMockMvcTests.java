package com.aimusic.studio;

import com.aimusic.studio.audio.JavaAudioFallbackService;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.TrackState;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import static org.hamcrest.Matchers.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class ApiMockMvcTests {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JavaAudioFallbackService audioService;

    private byte[] makeMelodyWav(double durationSec, int sr) {
        double[] freqs = {261.63, 329.63, 392.00, 523.25};
        int nTotal = (int) (durationSec * sr);
        float[] samples = new float[nTotal];
        int segLen = Math.max(1, nTotal / freqs.length);
        for (int i = 0; i < freqs.length; i++) {
            int s = i * segLen;
            int e = (i == freqs.length - 1) ? nTotal : (i + 1) * segLen;
            for (int k = s; k < e; k++) {
                double t = (double) k / sr;
                samples[k] = (float) (0.5 * Math.sin(2.0 * Math.PI * freqs[i] * t));
            }
        }
        return audioService.encodeWavMono(samples, sr);
    }

    @Test
    void healthAndHeaderOverrides() throws Exception {
        MvcResult res = mockMvc.perform(get("/api/health")
                        .header("X-Gemini-Api-Key", "AIzaTestHeaderKey12345")
                        .header("X-LLM-Provider", "gemini"))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(header().string("X-Frame-Options", "DENY"))
                .andExpect(header().string("Referrer-Policy", "no-referrer"))
                .andExpect(jsonPath("$.status").value("ok"))
                .andExpect(jsonPath("$.redis.backend", anyOf(is("memory"), is("redis"))))
                .andExpect(jsonPath("$.llm_providers.gemini_configured").value(true))
                .andExpect(jsonPath("$.llm_providers.default").value("gemini"))
                .andReturn();
        JsonNode root = objectMapper.readTree(res.getResponse().getContentAsString());
        boolean expectedConnected = "redis".equals(root.at("/redis/backend").asText());
        assertEquals(expectedConnected, root.at("/redis/connected").asBoolean());
    }

    @Test
    void fullAudioPipelineJobsStudioAndProjectsPagination() throws Exception {
        byte[] wavBytes = makeMelodyWav(4.0, 44100);

        // Reject invalid extension
        MockMultipartFile badExt = new MockMultipartFile("file", "notes.txt", "text/plain", "not audio".getBytes());
        mockMvc.perform(multipart("/api/audio/upload").file(badExt))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.detail").isNotEmpty());

        // Reject < 3s
        MockMultipartFile shortFile = new MockMultipartFile("file", "short.wav", "audio/wav", makeMelodyWav(1.2, 44100));
        mockMvc.perform(multipart("/api/audio/upload").file(shortFile))
                .andExpect(status().isBadRequest());

        // 1. Valid upload
        MockMultipartFile goodFile = new MockMultipartFile("file", "hum.wav", "audio/wav", wavBytes);
        MvcResult upRes = mockMvc.perform(multipart("/api/audio/upload").file(goodFile).param("title", "MockMvc Song"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sample_rate").value(44100))
                .andExpect(jsonPath("$.raw_input_ref", startsWith("mem://raw/")))
                .andReturn();
        JsonNode upJson = objectMapper.readTree(upRes.getResponse().getContentAsString());
        String pid = upJson.get("project_id").asText();

        // 2. Denoise
        MvcResult dnRes = mockMvc.perform(post("/api/audio/denoise")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"enable_denoise\":true,\"auto_trim\":true}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.dry_denoised_ref", startsWith("mem://processed/")))
                .andReturn();
        String dryRef = objectMapper.readTree(dnRes.getResponse().getContentAsString()).get("dry_denoised_ref").asText();

        mockMvc.perform(get("/api/audio/asset").param("ref", dryRef))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/wav"));

        // 3. Analyze + BPM/Key lock
        mockMvc.perform(post("/api/audio/analyze")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bpm", allOf(greaterThanOrEqualTo(40.0), lessThanOrEqualTo(220.0))))
                .andExpect(jsonPath("$.raw_melody_midi").isArray());

        mockMvc.perform(post("/api/audio/analyze")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"bpm_override\":115.0,\"key_override\":\"G\",\"scale_override\":\"major\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bpm").value(115.0))
                .andExpect(jsonPath("$.key").value("G"));

        // 4. Autotune (quick preset + Auto-Tune Pro custom overrides)
        mockMvc.perform(post("/api/audio/autotune")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"preset\":\"balanced\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.tuned_vocal_ref", startsWith("mem://processed/")));

        mockMvc.perform(post("/api/audio/autotune")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {
                                  "project_id": "%s",
                                  "autotune_settings": {
                                    "enabled": true,
                                    "preset": "off",
                                    "key": "D",
                                    "scale": "pentatonic_minor",
                                    "retune_speed_ms": 12.0,
                                    "humanize": 0.2,
                                    "mix_percent": 85.0,
                                    "auto_follow_project_key": true
                                  }
                                }
                                """.formatted(pid)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.autotune_settings.enabled").value(true))
                .andExpect(jsonPath("$.autotune_settings.mix_percent").value(85.0))
                .andExpect(jsonPath("$.autotune_settings.key").value("D"))
                .andExpect(jsonPath("$.autotune_settings.scale").value("pentatonic_minor"));

        // 5. Multi-Agent Generate + SSE + Cancel
        MvcResult jobRes = mockMvc.perform(post("/api/jobs/generate")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"config\":{\"melody_mode\":\"preserve\",\"output_mode\":\"full_song\",\"genre\":\"Pop\",\"mood\":\"Warm\"}}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.job_id").isNotEmpty())
                .andReturn();
        String jobId = objectMapper.readTree(jobRes.getResponse().getContentAsString()).get("job_id").asText();

        // Wait for async job SSE stream to emit completed event
        String sseBody = awaitJobCompletedSse(jobId);
        assertTrue(sseBody.contains("event:agent_step") || sseBody.contains("event: agent_step"));
        assertTrue(sseBody.contains("event:completed") || sseBody.contains("event: completed"));

        // Invalid regenerate-track returns 400
        mockMvc.perform(post("/api/jobs/regenerate-track")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"target_track\":\"vocal\"}"))
                .andExpect(status().isBadRequest());

        // Valid regenerate + cancel
        MvcResult regenRes = mockMvc.perform(post("/api/jobs/regenerate-track")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"target_track\":\"bass\",\"instrument\":\"finger_bass\"}"))
                .andExpect(status().isOk())
                .andReturn();
        String regenJobId = objectMapper.readTree(regenRes.getResponse().getContentAsString()).get("job_id").asText();
        mockMvc.perform(post("/api/jobs/" + regenJobId + "/cancel"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("cancelled"));

        // 6. Lyrics, Coach & Overdub Fit Check
        mockMvc.perform(post("/api/lyrics/suggest")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"language\":\"vi\",\"topic\":\"kỷ niệm\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.lines", not(empty())));

        mockMvc.perform(post("/api/coach/chat")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"message\":\"Nên đặt ở Chorus hay Verse?\",\"history\":[]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.reply").isNotEmpty())
                .andExpect(jsonPath("$.suggested_actions", not(empty())));

        MockMultipartFile overdubFile = new MockMultipartFile("file", "overdub.wav", "audio/wav", wavBytes);
        mockMvc.perform(multipart("/api/studio/overdub-fit-check").file(overdubFile).param("project_id", pid))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.timing_offset_ms").isNumber())
                .andExpect(jsonPath("$.gain_suggestion").isNotEmpty());

        // 7. Preview (all modes differentiated) & Export WAV / MIDI / .aimusic
        byte[] rawPreview = mockMvc.perform(get("/api/audio/preview/" + pid).param("mode", "raw"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/wav"))
                .andReturn().getResponse().getContentAsByteArray();

        byte[] dryPreview = mockMvc.perform(get("/api/audio/preview/" + pid).param("mode", "dry"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/wav"))
                .andReturn().getResponse().getContentAsByteArray();

        byte[] dryBeatPreview = mockMvc.perform(get("/api/audio/preview/" + pid).param("mode", "dry_beat"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/wav"))
                .andReturn().getResponse().getContentAsByteArray();

        byte[] autotunePreview = mockMvc.perform(get("/api/audio/preview/" + pid).param("mode", "autotune"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/wav"))
                .andReturn().getResponse().getContentAsByteArray();

        byte[] preservePreview = mockMvc.perform(get("/api/audio/preview/" + pid).param("mode", "preserve"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/wav"))
                .andReturn().getResponse().getContentAsByteArray();

        byte[] enhancePreview = mockMvc.perform(get("/api/audio/preview/" + pid).param("mode", "enhance"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/wav"))
                .andReturn().getResponse().getContentAsByteArray();

        byte[] mixPreview = mockMvc.perform(get("/api/audio/preview/" + pid).param("mode", "ai_mix"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/wav"))
                .andReturn().getResponse().getContentAsByteArray();

        assertFalse(java.util.Arrays.equals(rawPreview, dryBeatPreview));
        assertFalse(java.util.Arrays.equals(dryPreview, dryBeatPreview));
        assertFalse(java.util.Arrays.equals(dryBeatPreview, mixPreview));
        assertFalse(java.util.Arrays.equals(autotunePreview, mixPreview));
        assertFalse(java.util.Arrays.equals(preservePreview, enhancePreview));

        mockMvc.perform(get("/api/audio/preview").param("project_id", pid).param("mode", "ai_mix"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/wav"));

        mockMvc.perform(post("/api/projects/" + pid + "/export/audio")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"format\":\"wav\",\"apply_mastering\":true}"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/wav"));

        mockMvc.perform(post("/api/projects/" + pid + "/export/midi"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/midi"));

        MvcResult bundleRes = mockMvc.perform(post("/api/projects/" + pid + "/export/aimusic"))
                .andExpect(status().isOk())
                .andReturn();
        MockMultipartFile bundleFile = new MockMultipartFile(
                "file", pid + ".aimusic", "application/octet-stream", bundleRes.getResponse().getContentAsByteArray());
        mockMvc.perform(multipart("/api/projects/import").file(bundleFile))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.project_id").value(pid));

        // 8. Pagination & Sync + Undo
        for (int i = 0; i < 14; i++) {
            String spid = String.format("page_proj_%02d", i);
            ProjectState ps = ProjectState.createDefault(spid, "Beat Idea " + i);
            ps.getConfig().setGenre(i % 2 == 0 ? "Lo-fi" : "Pop");
            mockMvc.perform(put("/api/projects/" + spid + "/sync")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(ps)))
                    .andExpect(status().isOk());
        }

        mockMvc.perform(get("/api/projects")
                        .param("page", "1")
                        .param("limit", "12")
                        .param("search", "Beat Idea"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(14))
                .andExpect(jsonPath("$.total_pages").value(2))
                .andExpect(jsonPath("$.items", hasSize(12)));

        mockMvc.perform(get("/api/projects")
                        .param("page", "2")
                        .param("limit", "12")
                        .param("search", "Beat Idea"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items", hasSize(2)));

        mockMvc.perform(get("/api/projects")
                        .param("page", "1")
                        .param("limit", "12")
                        .param("search", "Beat Idea")
                        .param("genre", "Lo-fi"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(7));
    }

    private String awaitJobCompletedSse(String jobId) throws Exception {
        String sseBody = "";
        for (int attempt = 0; attempt < 50; attempt++) {
            MvcResult sseRes = mockMvc.perform(get("/api/jobs/" + jobId + "/events"))
                    .andExpect(status().isOk())
                    .andReturn();
            sseBody = sseRes.getResponse().getContentAsString();
            if (sseBody.contains("event:completed") || sseBody.contains("event: completed")) {
                return sseBody;
            }
            Thread.sleep(100);
        }
        return sseBody;
    }

    private byte[] makeSilencePaddedVocalWav(double leadSilSec, double toneSec, double trailSilSec, int sr) {
        int nLead = (int) (leadSilSec * sr);
        int nTone = (int) (toneSec * sr);
        int nTrail = (int) (trailSilSec * sr);
        float[] samples = new float[nLead + nTone + nTrail];
        for (int i = 0; i < nTone; i++) {
            double t = (double) i / sr;
            samples[nLead + i] = (float) (0.45 * Math.sin(2.0 * Math.PI * 329.63 * t));
        }
        return audioService.encodeWavMono(samples, sr);
    }

    @Test
    void phase23StudioEndpointsAndMultiClipTextureExport() throws Exception {
        byte[] paddedVocal = makeSilencePaddedVocalWav(0.6, 2.4, 0.5, 44100);
        MockMultipartFile vocalFile = new MockMultipartFile("file", "padded_vocal.wav", "audio/wav", paddedVocal);

        MvcResult upRes = mockMvc.perform(multipart("/api/audio/upload")
                        .file(vocalFile)
                        .param("title", "Phase 23 Song"))
                .andExpect(status().isOk())
                .andReturn();
        String pid = objectMapper.readTree(upRes.getResponse().getContentAsString()).get("project_id").asText();

        // Standard Full Song generation includes Bridge
        MvcResult genRes = mockMvc.perform(post("/api/jobs/generate")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"config\":{\"melody_mode\":\"enhance\",\"output_mode\":\"full_song\",\"structure_preset\":\"standard\"}}"))
                .andExpect(status().isOk())
                .andReturn();
        String jobId = objectMapper.readTree(genRes.getResponse().getContentAsString()).get("job_id").asText();
        awaitJobCompletedSse(jobId);

        mockMvc.perform(get("/api/projects/" + pid))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.song_structure.sections[*].name", hasItem("Bridge")));

        // 1. Auto-Trim Vocal
        MvcResult trimRes = mockMvc.perform(post("/api/studio/auto-trim-vocal")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.project_id").value(pid))
                .andExpect(jsonPath("$.summary").isNotEmpty())
                .andExpect(jsonPath("$.trim_start_sec", greaterThan(0.4)))
                .andExpect(jsonPath("$.trim_end_sec", lessThan(3.2)))
                .andExpect(jsonPath("$.trimmed_clips", greaterThanOrEqualTo(1)))
                .andExpect(jsonPath("$.project_state.tracks.vocal.clips", not(empty())))
                .andReturn();
        JsonNode trimJson = objectMapper.readTree(trimRes.getResponse().getContentAsString());
        assertTrue(trimJson.at("/project_state/tracks/vocal/clips/0/trim_start_sec").asDouble() > 0.4);

        // 2. Clip Upload onto "texture" track (creates texture track & handles invalid format)
        MockMultipartFile badClip = new MockMultipartFile("file", "bad.txt", "text/plain", "nope".getBytes());
        mockMvc.perform(multipart("/api/audio/clip-upload")
                        .file(badClip)
                        .param("project_id", pid))
                .andExpect(status().isBadRequest());

        byte[] fxWav1 = makeMelodyWav(1.0, 44100);
        byte[] fxWav2 = makeMelodyWav(0.8, 44100);
        MockMultipartFile clipFile1 = new MockMultipartFile("file", "riser.wav", "audio/wav", fxWav1);
        MockMultipartFile clipFile2 = new MockMultipartFile("file", "chime.wav", "audio/wav", fxWav2);

        MvcResult clipRes1 = mockMvc.perform(multipart("/api/audio/clip-upload")
                        .file(clipFile1)
                        .param("project_id", pid)
                        .param("track_id", "texture")
                        .param("start_bar", "1.0"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.audio_ref", startsWith("mem://clips/")))
                .andExpect(jsonPath("$.clip.id").isNotEmpty())
                .andExpect(jsonPath("$.project_state.tracks.texture.type").value("audio"))
                .andExpect(jsonPath("$.project_state.tracks.texture.clips", hasSize(1)))
                .andReturn();
        String texRef1 = objectMapper.readTree(clipRes1.getResponse().getContentAsString()).get("audio_ref").asText();

        mockMvc.perform(get("/api/audio/asset").param("ref", texRef1))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/wav"));

        mockMvc.perform(multipart("/api/audio/clip-upload")
                        .file(clipFile2)
                        .param("project_id", pid)
                        .param("track_id", "texture")
                        .param("start_bar", "2.0"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.project_state.tracks.texture.clips", hasSize(2)));

        // 3. Auto-Mix
        MvcResult mixRes = mockMvc.perform(post("/api/studio/auto-mix")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.project_id").value(pid))
                .andExpect(jsonPath("$.mix_notes", not(empty())))
                .andExpect(jsonPath("$.project_state.mastering.auto_mix_enabled").value(true))
                .andExpect(jsonPath("$.project_state.mastering.limiter_ceiling_db").value(-1.0))
                .andReturn();
        JsonNode mixJson = objectMapper.readTree(mixRes.getResponse().getContentAsString());
        JsonNode tracksNode = mixJson.at("/project_state/tracks");
        tracksNode.fields().forEachRemaining(e -> {
            double vol = e.getValue().get("volume").asDouble();
            double pan = e.getValue().get("pan").asDouble();
            assertTrue(vol >= 0.0 && vol <= 1.15, "Volume out of range for " + e.getKey() + ": " + vol);
            assertTrue(pan >= -0.5 && pan <= 0.5, "Pan out of range for " + e.getKey() + ": " + pan);
        });

        // 4. Multi-clip preview & stems export include texture track
        mockMvc.perform(get("/api/audio/preview/" + pid).param("mode", "ai_mix"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/wav"));

        byte[] stemsBytes = mockMvc.perform(post("/api/projects/" + pid + "/export/audio")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"format\":\"stems\",\"apply_mastering\":true}"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("application/zip"))
                .andReturn().getResponse().getContentAsByteArray();

        java.util.Set<String> stemEntries = new java.util.HashSet<>();
        try (java.util.zip.ZipInputStream zis = new java.util.zip.ZipInputStream(new java.io.ByteArrayInputStream(stemsBytes))) {
            java.util.zip.ZipEntry ze;
            while ((ze = zis.getNextEntry()) != null) stemEntries.add(ze.getName());
        }
        assertTrue(stemEntries.contains("stems/vocal.wav"));
        assertTrue(stemEntries.contains("stems/texture.wav"));
    }

    @Test
    void auditBug02AutotuneOffClearsTunedRefAndPreviewUsesDry() throws Exception {
        byte[] wav = makeMelodyWav(4.0, 44100);
        MockMultipartFile file = new MockMultipartFile("file", "vocal.wav", "audio/wav", wav);
        MvcResult up = mockMvc.perform(multipart("/api/audio/upload").file(file).param("title", "AT Off Test"))
                .andExpect(status().isOk()).andReturn();
        String pid = objectMapper.readTree(up.getResponse().getContentAsString()).get("project_id").asText();

        MvcResult dn = mockMvc.perform(post("/api/audio/denoise")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"enable_denoise\":true,\"auto_trim\":true}"))
                .andExpect(status().isOk()).andReturn();
        String dryRef = objectMapper.readTree(dn.getResponse().getContentAsString()).get("dry_denoised_ref").asText();

        // Turn autotune ON (modern) first
        MvcResult atOn = mockMvc.perform(post("/api/audio/autotune")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"preset\":\"modern\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.autotune_settings.enabled").value(true))
                .andExpect(jsonPath("$.tuned_vocal_ref", startsWith("mem://processed/")))
                .andReturn();
        String tunedRef = objectMapper.readTree(atOn.getResponse().getContentAsString()).get("tuned_vocal_ref").asText();
        assertNotEquals(dryRef, tunedRef);

        byte[] dryPreview = mockMvc.perform(get("/api/audio/preview/" + pid).param("mode", "dry"))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray();
        byte[] mixOnPreview = mockMvc.perform(get("/api/audio/preview/" + pid).param("mode", "ai_mix"))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray();
        assertFalse(java.util.Arrays.equals(dryPreview, mixOnPreview));

        // Now turn autotune OFF via preset="off"
        mockMvc.perform(post("/api/audio/autotune")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"preset\":\"off\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.autotune_settings.enabled").value(false))
                .andExpect(jsonPath("$.tuned_vocal_ref").value(dryRef));

        mockMvc.perform(get("/api/projects/" + pid))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.autotune_settings.enabled").value(false))
                .andExpect(jsonPath("$.audio_assets.tuned_vocal_ref").doesNotExist());

        byte[] mixOffPreview = mockMvc.perform(get("/api/audio/preview/" + pid).param("mode", "ai_mix"))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray();
        assertArrayEquals(dryPreview, mixOffPreview);

        // Also verify explicit enabled=false with mix_percent=0 returns dry_denoised_ref
        mockMvc.perform(post("/api/audio/autotune")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {
                                  "project_id": "%s",
                                  "autotune_settings": {
                                    "enabled": false,
                                    "preset": "off",
                                    "mix_percent": 0.0
                                  }
                                }
                                """.formatted(pid)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.autotune_settings.enabled").value(false))
                .andExpect(jsonPath("$.tuned_vocal_ref").value(dryRef));
    }

    @Test
    void auditBug01AutoTrimVocalResolvesOwnClipBytesAndSkipsLocalOverdubs() throws Exception {
        byte[] mainVocal = makeSilencePaddedVocalWav(0.7, 2.5, 0.5, 44100);
        MockMultipartFile mainFile = new MockMultipartFile("file", "main.wav", "audio/wav", mainVocal);
        MvcResult up = mockMvc.perform(multipart("/api/audio/upload").file(mainFile).param("title", "AutoTrim Overdub"))
                .andExpect(status().isOk()).andReturn();
        String pid = objectMapper.readTree(up.getResponse().getContentAsString()).get("project_id").asText();

        // Upload a second vocal clip (overdub) with different silence padding (0.2s lead, 1.5s tone)
        byte[] overdubWav = makeSilencePaddedVocalWav(0.2, 1.5, 0.3, 44100);
        MockMultipartFile overdubFile = new MockMultipartFile("file", "ov.wav", "audio/wav", overdubWav);
        MvcResult ovUp = mockMvc.perform(multipart("/api/audio/clip-upload")
                        .file(overdubFile)
                        .param("project_id", pid)
                        .param("track_id", "vocal")
                        .param("start_bar", "2.0"))
                .andExpect(status().isOk()).andReturn();
        String serverOverdubRef = objectMapper.readTree(ovUp.getResponse().getContentAsString()).get("audio_ref").asText();

        // Sync project with a local idb:// overdub clip + the server mem://clips/... overdub clip
        ProjectState synced = objectMapper.readValue(
                mockMvc.perform(get("/api/projects/" + pid)).andReturn().getResponse().getContentAsString(),
                ProjectState.class);
        com.aimusic.studio.model.AudioClip localOverdub = new com.aimusic.studio.model.AudioClip(
                "clip_overdub_local_1", "idb://overdub/local1", 3.0, 0.12);
        localOverdub.setTrimEndSec(1.45);
        localOverdub.setOffsetMs(42.0);
        synced.getTracks().get("vocal").getClips().get(1).setId("clip_overdub_server_2");
        synced.getTracks().get("vocal").getClips().add(localOverdub);

        mockMvc.perform(put("/api/projects/" + pid + "/sync")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(synced)))
                .andExpect(status().isOk());

        MvcResult trimRes = mockMvc.perform(post("/api/studio/auto-trim-vocal")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.trimmed_clips").value(2))
                .andReturn();

        JsonNode clips = objectMapper.readTree(trimRes.getResponse().getContentAsString())
                .at("/project_state/tracks/vocal/clips");
        // Clip 0 (main vocal): ~0.7s lead silence -> trim_start_sec > 0.5
        assertTrue(clips.get(0).get("trim_start_sec").asDouble() > 0.5);
        // Clip 1 (server mem://clips/... overdub): ~0.2s lead silence -> trimmed from its OWN bytes (< 0.35)
        assertEquals(serverOverdubRef, clips.get(1).get("source").asText());
        assertTrue(clips.get(1).get("trim_start_sec").asDouble() < 0.35);
        // Clip 2 (idb:// local overdub): untouched!
        assertEquals("clip_overdub_local_1", clips.get(2).get("id").asText());
        assertEquals(0.12, clips.get(2).get("trim_start_sec").asDouble(), 0.001);
        assertEquals(1.45, clips.get(2).get("trim_end_sec").asDouble(), 0.001);
        assertEquals(42.0, clips.get(2).get("offset_ms").asDouble(), 0.001);
    }

    @Test
    void warn02AnalyzePreservesUserLockedBpmKeyAndScale() throws Exception {
        byte[] wav = makeMelodyWav(4.0, 44100);
        MockMultipartFile file = new MockMultipartFile("file", "locked.wav", "audio/wav", wav);
        MvcResult up = mockMvc.perform(multipart("/api/audio/upload").file(file).param("title", "Lock Test"))
                .andExpect(status().isOk()).andReturn();
        String pid = objectMapper.readTree(up.getResponse().getContentAsString()).get("project_id").asText();

        // Sync manually locked BPM/Key/Scale (simulating Step 2 manual edits before returning to Step 1)
        ProjectState state = objectMapper.readValue(
                mockMvc.perform(get("/api/projects/" + pid)).andReturn().getResponse().getContentAsString(),
                ProjectState.class);
        state.getAnalysis().setBpm(138.0);
        state.getAnalysis().setBpmLocked(true);
        state.getAnalysis().setDetectedKey("F#");
        state.getAnalysis().setDetectedScale("minor");
        state.getAnalysis().setKeyLocked(true);
        mockMvc.perform(put("/api/projects/" + pid + "/sync")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(state)))
                .andExpect(status().isOk());

        // Re-running /api/audio/analyze without explicit overrides must preserve locked BPM, Key & Scale
        mockMvc.perform(post("/api/audio/analyze")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bpm").value(138.0))
                .andExpect(jsonPath("$.key").value("F#"))
                .andExpect(jsonPath("$.scale").value("minor"));

        mockMvc.perform(get("/api/projects/" + pid))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.analysis.bpm_locked").value(true))
                .andExpect(jsonPath("$.analysis.key_locked").value(true))
                .andExpect(jsonPath("$.analysis.bpm").value(138.0))
                .andExpect(jsonPath("$.analysis.detected_key").value("F#"))
                .andExpect(jsonPath("$.analysis.detected_scale").value("minor"));
    }

    @Test
    void phase4ProjectCrudEqSendFxAndLlmTestEndpoint() throws Exception {
        String pid = "crud_fx_mockmvc_1";
        ProjectState state = ProjectState.createDefault(pid, "CRUD + FX Test");
        state.getAnalysis().setBpm(120.0);
        state.getSongStructure().setTotalBars(2);
        state.getSongStructure().setSections(List.of(
                new com.aimusic.studio.model.SongSection("Chorus", 1, 2, 0.88, true)
        ));
        state.getLyrics().getLines().add(
                new com.aimusic.studio.model.LyricLine("Chorus", 1, "Manual lyric line")
        );
        TrackState lead = state.getTracks().get("lead");
        lead.setLowDb(6.0);
        lead.setMidDb(-3.0);
        lead.setHighDb(4.0);
        lead.setReverbSend(0.75);
        lead.setDelaySend(0.5);
        lead.setNotes(List.of(new com.aimusic.studio.model.MidiNote(69, 0.0, 1.0, 110, 1.0)));

        // Create / Update via sync
        mockMvc.perform(put("/api/projects/" + pid + "/sync")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(state)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.tracks.lead.low_db").value(6.0))
                .andExpect(jsonPath("$.tracks.lead.reverb_send").value(0.75))
                .andExpect(jsonPath("$.lyrics.lines[0].text").value("Manual lyric line"));

        // Read & Verify Export WAV succeeds with EQ + Send FX
        mockMvc.perform(get("/api/projects/" + pid))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.tracks.lead.delay_send").value(0.5))
                .andExpect(jsonPath("$.song_structure.sections[0].energy").value(0.88));

        byte[] wav = mockMvc.perform(post("/api/projects/" + pid + "/export/audio")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"format\":\"wav\",\"mode\":\"ai_mix\",\"apply_mastering\":true}"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/wav"))
                .andReturn().getResponse().getContentAsByteArray();
        assertTrue(wav.length > 44);

        // Health LLM test probe returns structured response even in mock mode
        mockMvc.perform(post("/api/health/llm-test")
                        .header("X-LLM-Provider", "mock")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.provider").value("mock"))
                .andExpect(jsonPath("$.is_mock").value(true));

        // 6/8 time signature + expanded coach chat actions
        state.getAnalysis().setTimeSignature("6/8");
        mockMvc.perform(put("/api/projects/" + pid + "/sync")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(state)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.analysis.time_signature").value("6/8"));

        mockMvc.perform(post("/api/coach/chat")
                        .header("X-LLM-Provider", "mock")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"message\":\"Mix bị nhỏ và giọng hơi phô, chỉnh nhanh hơn chút\",\"history\":[]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.suggested_actions.length()").value(org.hamcrest.Matchers.greaterThanOrEqualTo(2)));

        byte[] midi68 = mockMvc.perform(post("/api/projects/" + pid + "/export/midi"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsByteArray();
        assertTrue(midi68.length > 16);

        // Security validations: reject non-mem asset refs and invalid overdub file extensions
        mockMvc.perform(get("/api/audio/asset").param("ref", "project:secret"))
                .andExpect(status().isBadRequest());

        MockMultipartFile badOverdub = new MockMultipartFile(
                "file", "bad.txt", "text/plain", "not audio".getBytes());
        mockMvc.perform(multipart("/api/studio/overdub-fit-check")
                        .file(badOverdub)
                        .param("project_id", pid))
                .andExpect(status().isBadRequest());

        // Delete & Confirm 404 afterwards
        mockMvc.perform(delete("/api/projects/" + pid))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("deleted"));

        mockMvc.perform(get("/api/projects/" + pid))
                .andExpect(status().isNotFound());
    }

    @Test
    void fullSpectrumCopilotSseStreamAudioUploadAndGlobalRoutes() throws Exception {
        String pid = "mock_copilot_" + System.currentTimeMillis();
        ProjectState state = ProjectState.createDefault(pid, "Copilot Test");
        state.getAnalysis().setBpm(98.0);
        state.getAnalysis().setDetectedKey("Am");
        state.getAnalysis().setDetectedScale("minor");
        mockMvc.perform(put("/api/projects/" + pid + "/sync")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(state)))
                .andExpect(status().isOk());

        // 1. Global Copilot on "/" suggests create_template
        mockMvc.perform(post("/api/coach/chat")
                        .header("X-LLM-Provider", "mock")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"__home__\",\"route\":\"/\",\"message\":\"Tạo template Ballad mới\",\"history\":[]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.suggested_actions[0].action").value("create_template"));

        // 2. SSE live token streaming returns chunk + actions + done
        MvcResult streamMvc = mockMvc.perform(post("/api/coach/chat/stream")
                        .header("X-LLM-Provider", "mock")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project_id\":\"" + pid + "\",\"route\":\"/studio/" + pid + "\",\"mode\":\"mix\",\"message\":\"Vocal hơi chói và hơi khô\",\"history\":[]}"))
                .andExpect(request().asyncStarted())
                .andReturn();

        String sseBody = mockMvc.perform(asyncDispatch(streamMvc))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Type", containsString("text/event-stream")))
                .andReturn()
                .getResponse()
                .getContentAsString();
        assertTrue(sseBody.contains("event:chunk"), sseBody);
        assertTrue(sseBody.contains("event:actions"), sseBody);
        assertTrue(sseBody.contains("event:done"), sseBody);
        assertTrue(sseBody.contains("set_track_mix"), sseBody);

        // 3. Multimodal WAV audio attachment returns DSP telemetry + actions
        byte[] wavBytes = makeMelodyWav(1.0, 22050);
        MockMultipartFile wavFile = new MockMultipartFile("file", "vocal_sample.wav", "audio/wav", wavBytes);
        mockMvc.perform(multipart("/api/coach/chat/audio")
                        .file(wavFile)
                        .header("X-LLM-Provider", "mock")
                        .param("project_id", pid)
                        .param("mode", "mix")
                        .param("route", "/studio/" + pid)
                        .param("message", "Nghe thử file vocal này giúp tôi"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.reply").value(containsString("dBFS")))
                .andExpect(jsonPath("$.suggested_actions", not(empty())));

        // 4. Oversized chat audio (> 10 MB) returns 413 Payload Too Large
        byte[] oversized = new byte[10 * 1024 * 1024 + 64];
        MockMultipartFile bigFile = new MockMultipartFile("file", "huge.wav", "audio/wav", oversized);
        mockMvc.perform(multipart("/api/coach/chat/audio")
                        .file(bigFile)
                        .param("project_id", pid)
                        .param("message", "Check size"))
                .andExpect(status().isPayloadTooLarge());

        mockMvc.perform(delete("/api/projects/" + pid)).andExpect(status().isOk());
    }
}
