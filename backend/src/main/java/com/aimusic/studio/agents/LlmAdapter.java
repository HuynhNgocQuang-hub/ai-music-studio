package com.aimusic.studio.agents;

import com.aimusic.studio.config.AppProperties;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class LlmAdapter {

    private static final Logger log = LoggerFactory.getLogger(LlmAdapter.class);
    private static final List<String> PLACEHOLDER_PREFIXES = List.of("your_", "changeme", "replace_", "example_", "<");
    private static final Pattern JSON_OBJECT_PATTERN = Pattern.compile("\\{[\\s\\S]*\\}");

    public enum Provider {
        GEMINI("gemini"),
        OPENAI("openai"),
        MOCK("mock");

        private final String value;

        Provider(String value) {
            this.value = value;
        }

        public String value() {
            return value;
        }

        public static Provider fromString(String raw) {
            if (raw == null) return GEMINI;
            String norm = raw.trim().toLowerCase(Locale.ROOT);
            for (Provider p : values()) {
                if (p.value.equals(norm)) return p;
            }
            return GEMINI;
        }
    }

    public record LlmResponse(Provider provider, String model, String text, Map<String, Object> data, boolean isMock) {}

    private final AppProperties properties;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;

    private volatile String configuredGeminiKey;
    private volatile String configuredOpenaiKey;
    private volatile String configuredDefaultProvider;
    private final Map<String, Provider> roleProviders = new ConcurrentHashMap<>(Map.of(
            "composer", Provider.GEMINI,
            "lyricist", Provider.GEMINI,
            "coach", Provider.GEMINI,
            "arranger", Provider.OPENAI,
            "qa", Provider.OPENAI
    ));

    @Autowired
    public LlmAdapter(AppProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .build();
    }

    public LlmAdapter(String geminiApiKey, String openaiApiKey, String defaultProvider, ObjectMapper objectMapper) {
        this.properties = new AppProperties();
        this.properties.setGeminiApiKey(geminiApiKey != null ? geminiApiKey : "");
        this.properties.setOpenaiApiKey(openaiApiKey != null ? openaiApiKey : "");
        if (defaultProvider != null) this.properties.setDefaultLlmProvider(defaultProvider);
        this.objectMapper = objectMapper;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .build();
    }

    public void configure(String geminiApiKey, String openaiApiKey, String defaultProvider, Map<String, String> roleMap) {
        if (geminiApiKey != null) this.configuredGeminiKey = geminiApiKey;
        if (openaiApiKey != null) this.configuredOpenaiKey = openaiApiKey;
        if (defaultProvider != null) this.configuredDefaultProvider = defaultProvider;
        if (roleMap != null) {
            for (Map.Entry<String, String> e : roleMap.entrySet()) {
                roleProviders.put(e.getKey().toLowerCase(Locale.ROOT), Provider.fromString(e.getValue()));
            }
        }
    }

    public String effectiveGeminiKey() {
        LlmContextHolder.LlmOverrides ctx = LlmContextHolder.get();
        if (ctx != null && ctx.geminiApiKey() != null) return ctx.geminiApiKey();
        if (configuredGeminiKey != null) return configuredGeminiKey;
        return properties.getGeminiApiKey();
    }

    public String effectiveOpenaiKey() {
        LlmContextHolder.LlmOverrides ctx = LlmContextHolder.get();
        if (ctx != null && ctx.openaiApiKey() != null) return ctx.openaiApiKey();
        if (configuredOpenaiKey != null) return configuredOpenaiKey;
        return properties.getOpenaiApiKey();
    }

    public Provider effectiveDefaultProvider() {
        LlmContextHolder.LlmOverrides ctx = LlmContextHolder.get();
        if (ctx != null && ctx.defaultProvider() != null) {
            return Provider.fromString(ctx.defaultProvider());
        }
        if (configuredDefaultProvider != null && !configuredDefaultProvider.isBlank()) {
            return Provider.fromString(configuredDefaultProvider);
        }
        return Provider.fromString(properties.getDefaultLlmProvider());
    }

    public static boolean isValidKey(String key) {
        if (key == null) return false;
        String cleaned = key.trim();
        if (cleaned.length() < 8) return false;
        String lowered = cleaned.toLowerCase(Locale.ROOT);
        for (String prefix : PLACEHOLDER_PREFIXES) {
            if (lowered.startsWith(prefix)) return false;
        }
        return true;
    }

    public boolean hasKey(Provider provider) {
        return switch (provider) {
            case GEMINI -> isValidKey(effectiveGeminiKey());
            case OPENAI -> isValidKey(effectiveOpenaiKey());
            case MOCK -> true;
        };
    }

    public Provider resolveProvider(String role, String explicitProvider) {
        List<Provider> candidates = new ArrayList<>();
        if (explicitProvider != null && !explicitProvider.isBlank()) {
            Provider p = Provider.fromString(explicitProvider);
            if (p == Provider.MOCK) return Provider.MOCK;
            candidates.add(p);
        }

        LlmContextHolder.LlmOverrides ctx = LlmContextHolder.get();
        String normRole = role != null ? role.toLowerCase(Locale.ROOT) : null;
        if (ctx != null && normRole != null && ctx.agentProviders() != null) {
            String roleOv = ctx.agentProviders().get(normRole);
            if (roleOv != null && !roleOv.isBlank()) {
                Provider rp = Provider.fromString(roleOv);
                if (rp == Provider.MOCK) return Provider.MOCK;
                candidates.add(rp);
            }
        }
        // Explicit X-LLM-Provider request override takes precedence before hardcoded roleProviders
        if (ctx != null && ctx.defaultProvider() != null && !ctx.defaultProvider().isBlank()) {
            Provider hp = Provider.fromString(ctx.defaultProvider());
            if (hp == Provider.MOCK) return Provider.MOCK;
            candidates.add(hp);
        }

        if (normRole != null) {
            Provider rp = roleProviders.get(normRole);
            if (rp != null) candidates.add(rp);
        }
        candidates.add(effectiveDefaultProvider());
        candidates.add(Provider.GEMINI);
        candidates.add(Provider.OPENAI);

        Set<Provider> seen = new LinkedHashSet<>();
        for (Provider c : candidates) {
            if (c == null || !seen.add(c)) continue;
            if (c == Provider.MOCK) return Provider.MOCK;
            if (hasKey(c)) return c;
        }
        return Provider.MOCK;
    }

    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("gemini_configured", hasKey(Provider.GEMINI));
        out.put("openai_configured", hasKey(Provider.OPENAI));
        out.put("default", effectiveDefaultProvider().value());
        LlmContextHolder.LlmOverrides ctx = LlmContextHolder.get();
        if (ctx != null && ctx.agentProviders() != null && !ctx.agentProviders().isEmpty()) {
            out.put("agent_providers", ctx.agentProviders());
        }
        return out;
    }

    public LlmResponse generateText(String prompt, String systemPrompt, String role, String explicitProvider) {
        Provider selected = resolveProvider(role, explicitProvider);
        if (selected == Provider.MOCK) {
            return generateMock(prompt, role, false);
        }
        try {
            if (selected == Provider.GEMINI) {
                return callGemini(prompt, systemPrompt, false);
            }
            if (selected == Provider.OPENAI) {
                return callOpenai(prompt, systemPrompt, false);
            }
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            log.warn("LLM provider {} interrupted; falling back to mock.", selected.value());
        } catch (Exception ex) {
            log.warn("LLM provider {} failed ({}); falling back to mock.", selected.value(), ex.getMessage());
        }
        return generateMock(prompt, role, false);
    }

    public LlmResponse generateJson(String prompt, String systemPrompt, String role, String explicitProvider) {
        Provider selected = resolveProvider(role, explicitProvider);
        if (selected == Provider.MOCK) {
            return generateMock(prompt, role, true);
        }
        try {
            LlmResponse resp = selected == Provider.GEMINI
                    ? callGemini(prompt, systemPrompt, true)
                    : callOpenai(prompt, systemPrompt, true);
            Map<String, Object> parsed = extractJsonBlock(resp.text());
            return new LlmResponse(resp.provider(), resp.model(), resp.text(), parsed, false);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            log.warn("LLM JSON call via {} interrupted; falling back to mock.", selected.value());
        } catch (Exception ex) {
            log.warn("LLM JSON call via {} failed ({}); falling back to mock.", selected.value(), ex.getMessage());
        }
        return generateMock(prompt, role, true);
    }

    public Map<String, Object> testConnection(String explicitProvider) {
        Provider selected = resolveProvider("coach", explicitProvider);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("provider", selected.value());
        if (selected == Provider.MOCK) {
            out.put("ok", false);
            out.put("is_mock", true);
            out.put("model", "mock-music-v1");
            out.put("latency_ms", 0);
            out.put("message", "Chua co API Key hop le hoac dang chon Mock Provider.");
            return out;
        }
        long started = System.nanoTime();
        try {
            LlmResponse resp = selected == Provider.GEMINI
                    ? callGemini("Reply with OK.", "Respond briefly with OK.", false)
                    : callOpenai("Reply with OK.", "Respond briefly with OK.", false);
            long latencyMs = Math.max(1L, (System.nanoTime() - started) / 1_000_000L);
            out.put("ok", true);
            out.put("is_mock", false);
            out.put("model", resp.model());
            out.put("latency_ms", latencyMs);
            out.put("message", "Ket noi thanh cong (" + resp.provider().value() + " / " + resp.model() + ").");
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            out.put("ok", false);
            out.put("is_mock", false);
            out.put("latency_ms", Math.max(0L, (System.nanoTime() - started) / 1_000_000L));
            out.put("message", "Kiem tra API key bi gian doan.");
        } catch (Exception ex) {
            long latencyMs = Math.max(0L, (System.nanoTime() - started) / 1_000_000L);
            out.put("ok", false);
            out.put("is_mock", false);
            out.put("latency_ms", latencyMs);
            out.put("message", ex.getMessage() != null ? ex.getMessage() : "Loi ket noi LLM API.");
        }
        return out;
    }

    private LlmResponse callGemini(String prompt, String systemPrompt, boolean asJson) throws Exception {
        String apiKey = effectiveGeminiKey();
        String configuredModel = properties.getGeminiModel() != null && !properties.getGeminiModel().isBlank()
                ? properties.getGeminiModel().trim() : "gemini-3.8-flash";

        Map<String, Object> genConfig = new LinkedHashMap<>();
        genConfig.put("temperature", asJson ? 0.3 : 0.5);
        if (asJson) genConfig.put("responseMimeType", "application/json");

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("contents", List.of(Map.of("parts", List.of(Map.of("text", prompt)))));
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            body.put("systemInstruction", Map.of("parts", List.of(Map.of("text", systemPrompt))));
        }
        body.put("generationConfig", genConfig);
        String jsonBody = objectMapper.writeValueAsString(body);

        String model = configuredModel;
        HttpResponse<String> resp = sendGeminiRequest(model, apiKey, jsonBody);
        if (resp.statusCode() == 404 && !"gemini-3.8-flash".equalsIgnoreCase(model)) {
            log.warn("Gemini model '{}' returned HTTP 404; retrying with 'gemini-3.8-flash'.", model);
            model = "gemini-3.8-flash";
            resp = sendGeminiRequest(model, apiKey, jsonBody);
        }
        if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
            throw new IllegalStateException("Gemini HTTP " + resp.statusCode() + extractHttpErrorDetail(resp.body()));
        }

        JsonNode root = objectMapper.readTree(resp.body());
        String text = root.path("candidates").path(0).path("content").path("parts").path(0).path("text").asText("");
        return new LlmResponse(Provider.GEMINI, model, text, null, false);
    }

    private HttpResponse<String> sendGeminiRequest(String model, String apiKey, String jsonBody) throws Exception {
        String url = "https://generativelanguage.googleapis.com/v1beta/models/"
                + URLEncoder.encode(model, StandardCharsets.UTF_8)
                + ":generateContent";
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(25))
                .header("Content-Type", "application/json")
                .header("x-goog-api-key", apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(jsonBody))
                .build();
        return httpClient.send(req, HttpResponse.BodyHandlers.ofString());
    }

    private LlmResponse callOpenai(String prompt, String systemPrompt, boolean asJson) throws Exception {
        String apiKey = effectiveOpenaiKey();
        String model = properties.getOpenaiModel() != null && !properties.getOpenaiModel().isBlank()
                ? properties.getOpenaiModel() : "gpt-4o-mini";

        List<Map<String, String>> messages = new ArrayList<>();
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            messages.add(Map.of("role", "system", "content", systemPrompt));
        }
        messages.add(Map.of("role", "user", "content", prompt));

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("messages", messages);
        body.put("temperature", asJson ? 0.3 : 0.5);
        if (asJson) {
            body.put("response_format", Map.of("type", "json_object"));
        }

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("https://api.openai.com/v1/chat/completions"))
                .timeout(Duration.ofSeconds(25))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)))
                .build();

        HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
            throw new IllegalStateException("OpenAI HTTP " + resp.statusCode() + extractHttpErrorDetail(resp.body()));
        }

        JsonNode root = objectMapper.readTree(resp.body());
        String text = root.path("choices").path(0).path("message").path("content").asText("");
        return new LlmResponse(Provider.OPENAI, model, text, null, false);
    }

    private static final Pattern API_KEY_LEAK_PATTERN =
            Pattern.compile("(?:AIza[0-9A-Za-z_-]{12,}|AQ\\.[0-9A-Za-z_.-]{12,}|sk-[0-9A-Za-z_-]{12,})");

    private String extractHttpErrorDetail(String responseBody) {
        if (responseBody == null || responseBody.isBlank()) {
            return "";
        }
        try {
            JsonNode root = objectMapper.readTree(responseBody);
            String msg = root.path("error").path("message").asText("").trim();
            String status = root.path("error").path("status").asText("").trim();
            if (!msg.isEmpty()) {
                msg = API_KEY_LEAK_PATTERN.matcher(msg.replaceAll("\\s+", " ")).replaceAll("[REDACTED]");
                if (msg.length() > 180) {
                    msg = msg.substring(0, 180) + "...";
                }
                return status.isEmpty() ? ": " + msg : " (" + status + "): " + msg;
            }
        } catch (Exception ignored) {
            // Keep HTTP status message only when response body is not structured JSON.
        }
        return "";
    }

    private LlmResponse generateMock(String prompt, String role, boolean asJson) {
        String roleName = (role != null && !role.isBlank()) ? role.toLowerCase(Locale.ROOT) : "assistant";
        String digest = sha256Hex(roleName + ":" + prompt).substring(0, 12);
        if (asJson) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("provider", "mock");
            payload.put("role", roleName);
            payload.put("seed", digest);
            payload.put("approved", true);
            payload.put("notes", List.of());
            payload.put("chords", List.of());
            payload.put("suggestions", List.of(
                    "Keep bass in low register (C2-G3) and align chord tones with strong beats."
            ));
            try {
                return new LlmResponse(Provider.MOCK, "mock-music-v1",
                        objectMapper.writeValueAsString(payload), payload, true);
            } catch (Exception e) {
                return new LlmResponse(Provider.MOCK, "mock-music-v1", "{}", payload, true);
            }
        }
        String summary = String.format(
                "[Mock %s | seed=%s] Maintain consistent BPM grid, keep chord tones aligned with melody strong beats, and preserve headroom below -1.0 dBFS.",
                roleName, digest
        );
        return new LlmResponse(Provider.MOCK, "mock-music-v1", summary, null, true);
    }

    private Map<String, Object> extractJsonBlock(String rawText) throws Exception {
        String text = rawText == null ? "" : rawText.trim();
        if (text.startsWith("```")) {
            text = text.replaceFirst("^```(?:json)?\\s*", "");
            text = text.replaceFirst("\\s*```$", "");
        }
        try {
            return objectMapper.readValue(text, new TypeReference<>() {});
        } catch (Exception ex) {
            Matcher m = JSON_OBJECT_PATTERN.matcher(text);
            if (m.find()) {
                return objectMapper.readValue(m.group(0), new TypeReference<>() {});
            }
            throw ex;
        }
    }

    private static String sha256Hex(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] bytes = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : bytes) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            return "000000000000";
        }
    }
}
