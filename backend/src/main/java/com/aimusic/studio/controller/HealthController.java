package com.aimusic.studio.controller;

import com.aimusic.studio.agents.LlmAdapter;
import com.aimusic.studio.agents.LlmContextHolder;
import com.aimusic.studio.audio.AudioWorkerClient;
import com.aimusic.studio.cloud.CloudDatabaseService;
import com.aimusic.studio.cloud.ObjectStorageService;
import com.aimusic.studio.config.AppProperties;
import com.aimusic.studio.model.dto.HealthResponse;
import com.aimusic.studio.store.ProjectStateStore;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

@RestController
public class HealthController {

    private final AppProperties properties;
    private final ProjectStateStore store;
    private final AudioWorkerClient audioWorkerClient;
    private final LlmAdapter llmAdapter;
    private final CloudDatabaseService cloudDb;
    private final ObjectStorageService objectStorage;

    public HealthController(
            AppProperties properties,
            ProjectStateStore store,
            AudioWorkerClient audioWorkerClient,
            LlmAdapter llmAdapter,
            @Autowired(required = false) CloudDatabaseService cloudDb,
            @Autowired(required = false) ObjectStorageService objectStorage
    ) {
        this.properties = properties;
        this.store = store;
        this.audioWorkerClient = audioWorkerClient;
        this.llmAdapter = llmAdapter;
        this.cloudDb = cloudDb;
        this.objectStorage = objectStorage;
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
            Optional<Map<String, Object>> workerHealth = audioWorkerClient.healthDetails();
            boolean workerHealthy = workerHealth.isPresent();
            Map<?, ?> workerEngines = workerHealth
                    .map(m -> m.get("engines"))
                    .filter(Map.class::isInstance)
                    .map(Map.class::cast)
                    .orElse(Map.of());

            boolean workerFfmpeg = Boolean.TRUE.equals(workerEngines.get("ffmpeg"));
            boolean workerFluidsynth = Boolean.TRUE.equals(workerEngines.get("fluidsynth"));
            boolean workerSoundfont = workerEngines.containsKey("soundfont")
                    ? Boolean.TRUE.equals(workerEngines.get("soundfont"))
                    : workerFluidsynth;
            boolean customSoundfontActive = Boolean.TRUE.equals(workerEngines.get("custom_soundfont_active"));

            Map<String, Object> engines = new LinkedHashMap<>();
            engines.put("audio_worker_available", workerHealthy);
            engines.put("ffmpeg_available", workerFfmpeg || isBinaryOnPath("ffmpeg"));
            engines.put("fluidsynth_available", workerFluidsynth || isBinaryOnPath("fluidsynth"));
            engines.put("soundfont_available", workerSoundfont);
            engines.put("custom_soundfont_active", customSoundfontActive);
            engines.put("java_fallback_available", true);

            Map<String, Object> llmStatus = llmAdapter.status();
            Map<String, Object> cloudStatus = new LinkedHashMap<>();
            if (cloudDb != null) {
                cloudStatus.putAll(cloudDb.status());
            }
            if (objectStorage != null) {
                cloudStatus.putAll(objectStorage.status());
            }
            cloudStatus.put("auth_mode", "hybrid_jwt");
            cloudStatus.put("https_proxy_ready", true);

            return new HealthResponse(
                    "ok",
                    properties.getName(),
                    properties.getVersion(),
                    redisStatus,
                    engines,
                    llmStatus,
                    cloudStatus
            );
        } finally {
            LlmContextHolder.clear();
        }
    }

    @PostMapping("/api/health/llm-test")
    public Map<String, Object> testLlmConnection(HttpServletRequest request) {
        LlmContextHolder.LlmOverrides overrides = LlmContextHolder.extractFromRequest(request);
        LlmContextHolder.set(overrides);
        try {
            return llmAdapter.testConnection(overrides != null ? overrides.defaultProvider() : null);
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
