package com.aimusic.studio.controller;

import com.aimusic.studio.agents.LlmAdapter;
import com.aimusic.studio.agents.LlmContextHolder;
import com.aimusic.studio.audio.AudioWorkerClient;
import com.aimusic.studio.config.AppProperties;
import com.aimusic.studio.model.dto.HealthResponse;
import com.aimusic.studio.store.ProjectStateStore;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
public class HealthController {

    private final AppProperties properties;
    private final ProjectStateStore store;
    private final AudioWorkerClient audioWorkerClient;
    private final LlmAdapter llmAdapter;

    public HealthController(
            AppProperties properties,
            ProjectStateStore store,
            AudioWorkerClient audioWorkerClient,
            LlmAdapter llmAdapter
    ) {
        this.properties = properties;
        this.store = store;
        this.audioWorkerClient = audioWorkerClient;
        this.llmAdapter = llmAdapter;
    }

    @GetMapping("/")
    public Map<String, String> root() {
        return Map.of(
                "name", properties.getName(),
                "version", properties.getVersion(),
                "status", "ok"
        );
    }

    @GetMapping("/api/health")
    public HealthResponse healthCheck(HttpServletRequest request) {
        LlmContextHolder.LlmOverrides overrides = LlmContextHolder.extractFromRequest(request);
        LlmContextHolder.set(overrides);
        try {
            Map<String, Object> redisStatus = store.ping();
            boolean workerHealthy = audioWorkerClient.isHealthy();

            Map<String, Object> engines = new LinkedHashMap<>();
            engines.put("audio_worker_available", workerHealthy);
            engines.put("ffmpeg_available", workerHealthy || isBinaryOnPath("ffmpeg"));
            engines.put("fluidsynth_available", workerHealthy || isBinaryOnPath("fluidsynth"));
            engines.put("soundfont_available", workerHealthy);
            engines.put("java_fallback_available", true);

            Map<String, Object> llmStatus = llmAdapter.status();
            return new HealthResponse(
                    "ok",
                    properties.getName(),
                    properties.getVersion(),
                    redisStatus,
                    engines,
                    llmStatus
            );
        } finally {
            LlmContextHolder.clear();
        }
    }

    @PostMapping("/api/settings/cache/clear")
    public Map<String, Object> clearTempCache() {
        Map<String, Object> res = new LinkedHashMap<>(store.clearCache());
        res.put("status", "cleared");
        return res;
    }

    private boolean isBinaryOnPath(String binary) {
        try {
            String cmd = System.getProperty("os.name").toLowerCase().contains("win") ? "where" : "which";
            Process p = new ProcessBuilder(cmd, binary)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .start();
            return p.waitFor() == 0;
        } catch (Exception e) {
            return false;
        }
    }
}
