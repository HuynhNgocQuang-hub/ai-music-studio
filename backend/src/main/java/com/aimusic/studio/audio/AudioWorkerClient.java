package com.aimusic.studio.audio;

import com.aimusic.studio.config.AppProperties;
import com.aimusic.studio.model.AutotuneSettings;
import com.aimusic.studio.model.ProjectState;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

@Service
public class AudioWorkerClient {

    private static final Logger log = LoggerFactory.getLogger(AudioWorkerClient.class);

    private final AppProperties properties;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;

    public AudioWorkerClient(AppProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofMillis(1200))
                .build();
    }

    private String baseUrl() {
        String url = properties.getAudioWorkerUrl();
        if (url == null || url.isBlank()) return "";
        return url.replaceAll("/+$", "");
    }

    public boolean isHealthy() {
        String base = baseUrl();
        if (base.isEmpty()) return false;
        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(base + "/health"))
                    .timeout(Duration.ofMillis(1000))
                    .GET()
                    .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            return resp.statusCode() >= 200 && resp.statusCode() < 300;
        } catch (Exception ex) {
            return false;
        }
    }

    public Optional<Map<String, Object>> healthDetails() {
        String base = baseUrl();
        if (base.isEmpty()) return Optional.empty();
        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(base + "/health"))
                    .timeout(Duration.ofMillis(1000))
                    .GET()
                    .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() >= 200 && resp.statusCode() < 300) {
                return Optional.of(objectMapper.readValue(resp.body(), new TypeReference<>() {}));
            }
        } catch (Exception ignored) {
        }
        return Optional.empty();
    }

    public Optional<Map<String, Object>> denoise(byte[] audioBytes, String filename, boolean enableDenoise, boolean autoTrim) {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("enable_denoise", String.valueOf(enableDenoise));
        fields.put("auto_trim", String.valueOf(autoTrim));
        return postMultipartJson("/internal/audio/denoise", "file", filename, audioBytes, fields);
    }

    public Optional<Map<String, Object>> analyze(byte[] wavBytes, Double bpmOverride, String keyOverride, String scaleOverride) {
        Map<String, String> fields = new LinkedHashMap<>();
        if (bpmOverride != null) fields.put("bpm_override", String.valueOf(bpmOverride));
        if (keyOverride != null && !keyOverride.isBlank()) fields.put("key_override", keyOverride);
        if (scaleOverride != null && !scaleOverride.isBlank()) fields.put("scale_override", scaleOverride);
        return postMultipartJson("/internal/audio/analyze", "file", "audio.wav", wavBytes, fields);
    }

    public Optional<Map<String, Object>> autotune(byte[] wavBytes, AutotuneSettings settings) {
        Map<String, String> fields = new LinkedHashMap<>();
        try {
            fields.put("settings_json", objectMapper.writeValueAsString(settings));
        } catch (Exception e) {
            return Optional.empty();
        }
        fields.put("preset", settings.getPreset());
        fields.put("key", settings.getKey());
        fields.put("scale", settings.getScale());
        fields.put("retune_speed_ms", String.valueOf(settings.getRetuneSpeedMs()));
        fields.put("humanize", String.valueOf(settings.getHumanize()));
        fields.put("mix_percent", String.valueOf(settings.getMixPercent()));
        fields.put("enabled", String.valueOf(settings.isEnabled()));
        return postMultipartJson("/internal/audio/autotune", "file", "audio.wav", wavBytes, fields);
    }

    public Optional<byte[]> exportAudio(ProjectState project, Map<String, byte[]> audioAssets, String format, String mode, boolean applyMastering, int sampleRate) {
        String base = baseUrl();
        if (base.isEmpty()) return Optional.empty();
        try {
            Map<String, String> b64Assets = new LinkedHashMap<>();
            for (Map.Entry<String, byte[]> e : audioAssets.entrySet()) {
                if (e.getValue() != null) {
                    b64Assets.put(e.getKey(), Base64.getEncoder().encodeToString(e.getValue()));
                }
            }
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("project", project);
            body.put("audio_assets_base64", b64Assets);
            body.put("format", format);
            body.put("mode", mode);
            body.put("apply_mastering", applyMastering);
            body.put("sample_rate", sampleRate);

            String json = objectMapper.writeValueAsString(body);
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(base + "/internal/audio/export"))
                    .timeout(Duration.ofSeconds(30))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json))
                    .build();
            HttpResponse<byte[]> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofByteArray());
            if (resp.statusCode() >= 200 && resp.statusCode() < 300) {
                return Optional.of(resp.body());
            }
        } catch (Exception ex) {
            log.debug("audio-worker export unavailable ({}); using Java fallback.", ex.getMessage());
        }
        return Optional.empty();
    }

    public Optional<Map<String, Object>> overdubFitCheck(byte[] audioBytes, String filename, double bpm, String key, String scale) {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("bpm", String.valueOf(bpm));
        fields.put("key", key);
        fields.put("scale", scale);
        return postMultipartJson("/internal/audio/overdub-fit-check", "file", filename, audioBytes, fields);
    }

    private Optional<Map<String, Object>> postMultipartJson(
            String path,
            String fileField,
            String filename,
            byte[] fileBytes,
            Map<String, String> formFields
    ) {
        String base = baseUrl();
        if (base.isEmpty()) return Optional.empty();
        try {
            String boundary = "----AiMusicBoundary" + UUID.randomUUID().toString().replace("-", "");
            byte[] payload = buildMultipartBody(boundary, fileField, filename, fileBytes, formFields);
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(base + path))
                    .timeout(Duration.ofSeconds(20))
                    .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                    .POST(HttpRequest.BodyPublishers.ofByteArray(payload))
                    .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() >= 200 && resp.statusCode() < 300) {
                return Optional.of(objectMapper.readValue(resp.body(), new TypeReference<>() {}));
            }
        } catch (Exception ex) {
            log.debug("audio-worker {} unavailable ({}); using Java fallback.", path, ex.getMessage());
        }
        return Optional.empty();
    }

    private byte[] buildMultipartBody(
            String boundary,
            String fileField,
            String filename,
            byte[] fileBytes,
            Map<String, String> formFields
    ) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        String safeName = (filename != null && !filename.isBlank()) ? filename : "audio.wav";
        for (Map.Entry<String, String> entry : formFields.entrySet()) {
            out.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
            out.write(("Content-Disposition: form-data; name=\"" + entry.getKey() + "\"\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            out.write((entry.getValue() + "\r\n").getBytes(StandardCharsets.UTF_8));
        }
        out.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(("Content-Disposition: form-data; name=\"" + fileField + "\"; filename=\"" + safeName + "\"\r\n").getBytes(StandardCharsets.UTF_8));
        out.write("Content-Type: application/octet-stream\r\n\r\n".getBytes(StandardCharsets.UTF_8));
        out.write(fileBytes);
        out.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        return out.toByteArray();
    }
}
