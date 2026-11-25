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
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofMillis(1200))
                .build();
    }

    public HttpClient.Version getHttpVersion() {
        return httpClient.version();
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
            log.warn("audio-worker /health returned HTTP {}: {}", resp.statusCode(), bodySnippet(resp.body()));
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
        AutotuneSettings effective = settings != null ? settings.copy() : new AutotuneSettings();
        // audio-worker disables pitch correction whenever preset == "off"; map custom Pro settings to "balanced"
        if (effective.isEnabled() && effective.getMixPercent() > 0.0 && "off".equalsIgnoreCase(effective.getPreset())) {
            effective.setPreset("balanced");
        }
        Map<String, String> fields = new LinkedHashMap<>();
        try {
            fields.put("settings_json", objectMapper.writeValueAsString(effective));
        } catch (Exception e) {
            return Optional.empty();
        }
        fields.put("preset", effective.getPreset());
        fields.put("key", effective.getKey());
        fields.put("scale", effective.getScale());
        fields.put("retune_speed_ms", String.valueOf(effective.getRetuneSpeedMs()));
        fields.put("humanize", String.valueOf(effective.getHumanize()));
        fields.put("mix_percent", String.valueOf(effective.getMixPercent()));
        fields.put("enabled", String.valueOf(effective.isEnabled()));
        return postMultipartJson("/internal/audio/autotune", "file", "audio.wav", wavBytes, fields);
    }

    public Optional<byte[]> renderProjectMix(
            ProjectState project,
            Map<String, byte[]> audioAssets,
            String mode,
            boolean applyMastering,
            int sampleRate
    ) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("project", project);
        body.put("audio_assets_base64", encodeAssetsBase64(audioAssets));
        body.put("mode", (mode != null && !mode.isBlank()) ? mode : "ai_mix");
        body.put("apply_mastering", applyMastering);
        body.put("sample_rate", sampleRate);
        return postJsonForBytes("/internal/audio/render", body, Duration.ofSeconds(60));
    }

    public Optional<byte[]> exportAudio(ProjectState project, Map<String, byte[]> audioAssets, String format, String mode, boolean applyMastering, int sampleRate) {
        return exportAudio(project, audioAssets, format, mode, applyMastering, sampleRate, "320k");
    }

    public Optional<byte[]> exportAudio(
            ProjectState project,
            Map<String, byte[]> audioAssets,
            String format,
            String mode,
            boolean applyMastering,
            int sampleRate,
            String bitrate
    ) {
        return exportAudio(project, audioAssets, format, mode, applyMastering, sampleRate, bitrate, null, null, null, null);
    }

    public Optional<byte[]> exportAudio(
            ProjectState project,
            Map<String, byte[]> audioAssets,
            String format,
            String mode,
            boolean applyMastering,
            int sampleRate,
            String bitrate,
            String title,
            String artist,
            String album,
            String genre
    ) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("project", project);
        body.put("audio_assets_base64", encodeAssetsBase64(audioAssets));
        body.put("format", format);
        body.put("mode", mode);
        body.put("apply_mastering", applyMastering);
        body.put("sample_rate", sampleRate);
        body.put("bitrate", (bitrate != null && bitrate.trim().startsWith("192")) ? "192k" : "320k");
        if (title != null && !title.isBlank()) body.put("title", title.trim());
        if (artist != null && !artist.isBlank()) body.put("artist", artist.trim());
        if (album != null && !album.isBlank()) body.put("album", album.trim());
        if (genre != null && !genre.isBlank()) body.put("genre", genre.trim());
        return postJsonForBytes("/internal/audio/export", body, Duration.ofSeconds(60));
    }

    private Map<String, String> encodeAssetsBase64(Map<String, byte[]> audioAssets) {
        Map<String, String> b64Assets = new LinkedHashMap<>();
        if (audioAssets == null) return b64Assets;
        for (Map.Entry<String, byte[]> e : audioAssets.entrySet()) {
            if (e.getValue() != null) {
                b64Assets.put(e.getKey(), Base64.getEncoder().encodeToString(e.getValue()));
            }
        }
        return b64Assets;
    }

    private Optional<byte[]> postJsonForBytes(String path, Map<String, Object> body, Duration timeout) {
        String base = baseUrl();
        if (base.isEmpty()) return Optional.empty();
        try {
            String json = objectMapper.writeValueAsString(body);
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(base + path))
                    .timeout(timeout)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json))
                    .build();
            HttpResponse<byte[]> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofByteArray());
            if (resp.statusCode() >= 200 && resp.statusCode() < 300) {
                return Optional.of(resp.body());
            }
            log.warn("audio-worker {} returned HTTP {}: {}",
                    path, resp.statusCode(), bodySnippet(new String(resp.body(), StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            log.debug("audio-worker {} unavailable ({}); using Java fallback.", path, ex.getMessage());
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

    public Optional<Map<String, Object>> separateStems(byte[] audioBytes, String filename) {
        return postMultipartJson("/internal/audio/separate-stems", "file", filename != null ? filename : "mix.wav", audioBytes, Map.of());
    }

    public Optional<Map<String, Object>> uploadSoundFont(byte[] sf2Bytes, String filename) {
        return postMultipartJson("/internal/audio/soundfont", "file", filename != null ? filename : "custom.sf2", sf2Bytes, Map.of());
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
                    .timeout(Duration.ofSeconds(45))
                    .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                    .POST(HttpRequest.BodyPublishers.ofByteArray(payload))
                    .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() >= 200 && resp.statusCode() < 300) {
                return Optional.of(objectMapper.readValue(resp.body(), new TypeReference<>() {}));
            }
            log.warn("audio-worker {} returned HTTP {}: {}", path, resp.statusCode(), bodySnippet(resp.body()));
        } catch (Exception ex) {
            log.debug("audio-worker {} unavailable ({}); using Java fallback.", path, ex.getMessage());
        }
        return Optional.empty();
    }

    private static String bodySnippet(String body) {
        if (body == null || body.isBlank()) return "<empty>";
        String cleaned = body.replaceAll("[\\r\\n]+", " ").trim();
        return cleaned.length() > 300 ? cleaned.substring(0, 300) + "..." : cleaned;
    }

    private byte[] buildMultipartBody(
            String boundary,
            String fileField,
            String filename,
            byte[] fileBytes,
            Map<String, String> formFields
    ) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        String safeName = (filename != null && !filename.isBlank())
                ? filename.replaceAll("[\"\\\\\\r\\n]", "_") : "audio.wav";
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
