package com.aimusic.studio.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.Arrays;
import java.util.List;
import java.util.Set;

@ConfigurationProperties(prefix = "app")
public class AppProperties {

    private String name = "AI Music Studio API";
    private String version = "1.0.0";
    private String redisUrl = "redis://localhost:6379/0";
    private String audioWorkerUrl = "http://localhost:8001";
    private long projectTtlSeconds = 86400L;
    private long audioTtlSeconds = 43200L;
    private int maxUploadMb = 50;
    private double minDurationSec = 3.0;
    private double maxHumDurationSec = 60.0;
    private double maxVocalDurationSec = 300.0;
    private int sampleRate = 44100;
    private double masterLimiterCeilingDb = -1.0;
    private double targetLufs = -14.0;
    private String geminiApiKey = "";
    private String openaiApiKey = "";
    private String defaultLlmProvider = "gemini";
    private String geminiModel = "gemini-3.8-flash";
    private String openaiModel = "gpt-4o-mini";
    private String corsOrigins = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173";
    private double jobTimeoutSeconds = 60.0;
    private int maxQaIterations = 2;

    public static final Set<String> ALLOWED_AUDIO_EXTENSIONS = Set.of("wav", "mp3", "m4a", "ogg", "flac");

    public long getMaxUploadBytes() {
        return (long) maxUploadMb * 1024L * 1024L;
    }

    public List<String> getCorsOriginsList() {
        if (corsOrigins == null || corsOrigins.isBlank()) {
            return List.of("http://localhost:3000", "http://localhost:5173");
        }
        return Arrays.stream(corsOrigins.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toList();
    }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getVersion() { return version; }
    public void setVersion(String version) { this.version = version; }

    public String getRedisUrl() { return redisUrl; }
    public void setRedisUrl(String redisUrl) { this.redisUrl = redisUrl; }

    public String getAudioWorkerUrl() { return audioWorkerUrl; }
    public void setAudioWorkerUrl(String audioWorkerUrl) { this.audioWorkerUrl = audioWorkerUrl; }

    public long getProjectTtlSeconds() { return projectTtlSeconds; }
    public void setProjectTtlSeconds(long projectTtlSeconds) { this.projectTtlSeconds = projectTtlSeconds; }

    public long getAudioTtlSeconds() { return audioTtlSeconds; }
    public void setAudioTtlSeconds(long audioTtlSeconds) { this.audioTtlSeconds = audioTtlSeconds; }

    public int getMaxUploadMb() { return maxUploadMb; }
    public void setMaxUploadMb(int maxUploadMb) { this.maxUploadMb = maxUploadMb; }

    public double getMinDurationSec() { return minDurationSec; }
    public void setMinDurationSec(double minDurationSec) { this.minDurationSec = minDurationSec; }

    public double getMaxHumDurationSec() { return maxHumDurationSec; }
    public void setMaxHumDurationSec(double maxHumDurationSec) { this.maxHumDurationSec = maxHumDurationSec; }

    public double getMaxVocalDurationSec() { return maxVocalDurationSec; }
    public void setMaxVocalDurationSec(double maxVocalDurationSec) { this.maxVocalDurationSec = maxVocalDurationSec; }

    public int getSampleRate() { return sampleRate; }
    public void setSampleRate(int sampleRate) { this.sampleRate = sampleRate; }

    public double getMasterLimiterCeilingDb() { return masterLimiterCeilingDb; }
    public void setMasterLimiterCeilingDb(double masterLimiterCeilingDb) { this.masterLimiterCeilingDb = masterLimiterCeilingDb; }

    public double getTargetLufs() { return targetLufs; }
    public void setTargetLufs(double targetLufs) { this.targetLufs = targetLufs; }

    public String getGeminiApiKey() { return geminiApiKey; }
    public void setGeminiApiKey(String geminiApiKey) { this.geminiApiKey = geminiApiKey; }

    public String getOpenaiApiKey() { return openaiApiKey; }
    public void setOpenaiApiKey(String openaiApiKey) { this.openaiApiKey = openaiApiKey; }

    public String getDefaultLlmProvider() { return defaultLlmProvider; }
    public void setDefaultLlmProvider(String defaultLlmProvider) { this.defaultLlmProvider = defaultLlmProvider; }

    public String getGeminiModel() { return geminiModel; }
    public void setGeminiModel(String geminiModel) { this.geminiModel = geminiModel; }

    public String getOpenaiModel() { return openaiModel; }
    public void setOpenaiModel(String openaiModel) { this.openaiModel = openaiModel; }

    public String getCorsOrigins() { return corsOrigins; }
    public void setCorsOrigins(String corsOrigins) { this.corsOrigins = corsOrigins; }

    public double getJobTimeoutSeconds() { return jobTimeoutSeconds; }
    public void setJobTimeoutSeconds(double jobTimeoutSeconds) { this.jobTimeoutSeconds = jobTimeoutSeconds; }

    public int getMaxQaIterations() { return maxQaIterations; }
    public void setMaxQaIterations(int maxQaIterations) { this.maxQaIterations = maxQaIterations; }
}
