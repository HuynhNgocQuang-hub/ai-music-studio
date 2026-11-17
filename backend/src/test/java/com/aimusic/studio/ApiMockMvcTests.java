package com.aimusic.studio;

import com.aimusic.studio.audio.JavaAudioFallbackService;
import com.aimusic.studio.model.ProjectState;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
        mockMvc.perform(get("/api/health")
                        .header("X-Gemini-Api-Key", "AIzaTestHeaderKey12345")
                        .header("X-LLM-Provider", "gemini"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ok"))
                .andExpect(jsonPath("$.redis.connected").value(true))
                .andExpect(jsonPath("$.llm_providers.gemini_configured").value(true))
                .andExpect(jsonPath("$.llm_providers.default").value("gemini"));
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

        // Wait briefly for virtual thread job completion then fetch SSE stream
        Thread.sleep(300);
        MvcResult sseRes = mockMvc.perform(get("/api/jobs/" + jobId + "/events"))
                .andExpect(status().isOk())
                .andReturn();
        String sseBody = sseRes.getResponse().getContentAsString();
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
}
