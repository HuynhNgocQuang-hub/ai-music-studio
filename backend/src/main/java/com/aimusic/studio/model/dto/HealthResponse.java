package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

public class HealthResponse {

    @JsonProperty("status")
    private String status = "ok";

    @JsonProperty("app")
    private String app;

    @JsonProperty("version")
    private String version;

    @JsonProperty("redis")
    private Map<String, Object> redis;

    @JsonProperty("engines")
    private Map<String, Object> engines;

    @JsonProperty("llm_providers")
    private Map<String, Object> llmProviders;

    @JsonProperty("cloud")
    private Map<String, Object> cloud;

    public HealthResponse() {}

    public HealthResponse(String status, String app, String version,
                          Map<String, Object> redis, Map<String, Object> engines,
                          Map<String, Object> llmProviders) {
        this(status, app, version, redis, engines, llmProviders, null);
    }

    public HealthResponse(String status, String app, String version,
                          Map<String, Object> redis, Map<String, Object> engines,
                          Map<String, Object> llmProviders, Map<String, Object> cloud) {
        this.status = status;
        this.app = app;
        this.version = version;
        this.redis = redis;
        this.engines = engines;
        this.llmProviders = llmProviders;
        this.cloud = cloud;
    }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getApp() { return app; }
    public void setApp(String app) { this.app = app; }

    public String getVersion() { return version; }
    public void setVersion(String version) { this.version = version; }

    public Map<String, Object> getRedis() { return redis; }
    public void setRedis(Map<String, Object> redis) { this.redis = redis; }

    public Map<String, Object> getEngines() { return engines; }
    public void setEngines(Map<String, Object> engines) { this.engines = engines; }

    public Map<String, Object> getLlmProviders() { return llmProviders; }
    public void setLlmProviders(Map<String, Object> llmProviders) { this.llmProviders = llmProviders; }

    public Map<String, Object> getCloud() { return cloud; }
    public void setCloud(Map<String, Object> cloud) { this.cloud = cloud; }
}
