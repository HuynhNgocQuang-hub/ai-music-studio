package com.aimusic.studio.agents;

import com.aimusic.studio.config.AppProperties;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Google Gemini REST strategy implementation of {@link LlmProviderClient}.
 */
@Component
public class GeminiProviderClient implements LlmProviderClient {

    private static final Logger log = LoggerFactory.getLogger(GeminiProviderClient.class);
    private static final String DEFAULT_MODEL = "gemini-3.8-flash";

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;

    @Autowired
    public GeminiProviderClient(ObjectMapper objectMapper) {
        this(objectMapper, HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build());
    }

    GeminiProviderClient(ObjectMapper objectMapper, HttpClient httpClient) {
        this.objectMapper = objectMapper;
        this.httpClient = httpClient;
    }

    @Override
    public LlmAdapter.Provider provider() {
        return LlmAdapter.Provider.GEMINI;
    }

    @Override
    public LlmAdapter.LlmResponse generate(
            String prompt,
            String systemPrompt,
            boolean asJson,
            String apiKey,
            AppProperties properties
    ) throws Exception {
        Map<String, Object> genConfig = new LinkedHashMap<>();
        genConfig.put("temperature", asJson ? 0.3 : 0.5);
        if (asJson) {
            genConfig.put("responseMimeType", "application/json");
        }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("contents", List.of(Map.of("parts", List.of(Map.of("text", prompt)))));
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            body.put("systemInstruction", Map.of("parts", List.of(Map.of("text", systemPrompt))));
        }
        body.put("generationConfig", genConfig);

        ModelResponse mr = executeWithFallbackModel(resolveModel(properties), apiKey, body);
        JsonNode root = objectMapper.readTree(mr.body());
        String text = root.path("candidates").path(0).path("content").path("parts").path(0).path("text").asText("");
        return new LlmAdapter.LlmResponse(LlmAdapter.Provider.GEMINI, mr.model(), text, null, false);
    }

    @Override
    public LlmAdapter.ToolLlmResponse generateWithTools(
            String prompt,
            String systemPrompt,
            byte[] audioBytes,
            String audioMime,
            List<Map<String, Object>> toolDeclarations,
            String apiKey,
            AppProperties properties
    ) throws Exception {
        return generateConversationWithTools(
                List.of(), prompt, systemPrompt, audioBytes, audioMime, toolDeclarations, apiKey, properties);
    }

    @Override
    public LlmAdapter.ToolLlmResponse generateConversationWithTools(
            List<LlmAdapter.ChatTurn> history,
            String prompt,
            String systemPrompt,
            byte[] audioBytes,
            String audioMime,
            List<Map<String, Object>> toolDeclarations,
            String apiKey,
            AppProperties properties
    ) throws Exception {
        List<Map<String, Object>> contents = buildAlternatingContents(history, prompt, audioBytes, audioMime);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("contents", contents);
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            body.put("systemInstruction", Map.of("parts", List.of(Map.of("text", systemPrompt))));
        }
        if (toolDeclarations != null && !toolDeclarations.isEmpty()) {
            body.put("tools", List.of(Map.of("functionDeclarations", toolDeclarations)));
        }
        body.put("generationConfig", Map.of("temperature", 0.42));

        ModelResponse mr = executeWithFallbackModel(resolveModel(properties), apiKey, body);
        JsonNode root = objectMapper.readTree(mr.body());
        JsonNode respParts = root.path("candidates").path(0).path("content").path("parts");
        StringBuilder replyText = new StringBuilder();
        List<LlmAdapter.ToolCall> calls = new ArrayList<>();
        if (respParts.isArray()) {
            for (JsonNode p : respParts) {
                if (p.hasNonNull("text")) {
                    replyText.append(p.path("text").asText(""));
                }
                if (p.has("functionCall")) {
                    JsonNode fc = p.path("functionCall");
                    String fnName = fc.path("name").asText("");
                    Map<String, Object> args = fc.has("args") && fc.path("args").isObject()
                            ? objectMapper.convertValue(fc.path("args"), new TypeReference<>() {})
                            : Map.of();
                    if (!fnName.isBlank()) {
                        calls.add(new LlmAdapter.ToolCall(fnName, args));
                    }
                }
            }
        }
        return new LlmAdapter.ToolLlmResponse(LlmAdapter.Provider.GEMINI, mr.model(), replyText.toString().trim(), calls, false);
    }

    private static List<Map<String, Object>> buildAlternatingContents(
            List<LlmAdapter.ChatTurn> history,
            String currentPrompt,
            byte[] audioBytes,
            String audioMime
    ) {
        List<Map<String, Object>> contents = new ArrayList<>();
        String lastRole = null;
        if (history != null) {
            for (LlmAdapter.ChatTurn turn : history) {
                if (turn == null || turn.content() == null || turn.content().isBlank()) continue;
                String geminiRole = "assistant".equalsIgnoreCase(turn.role()) || "model".equalsIgnoreCase(turn.role())
                        ? "model" : "user";
                if (contents.isEmpty() && !"user".equals(geminiRole)) {
                    continue;
                }
                String text = turn.content().trim();
                if (geminiRole.equals(lastRole) && !contents.isEmpty()) {
                    @SuppressWarnings("unchecked")
                    List<Map<String, Object>> prevParts = (List<Map<String, Object>>) contents.get(contents.size() - 1).get("parts");
                    prevParts.add(Map.of("text", text));
                } else {
                    List<Map<String, Object>> turnParts = new ArrayList<>();
                    turnParts.add(Map.of("text", text));
                    contents.add(Map.of("role", geminiRole, "parts", turnParts));
                    lastRole = geminiRole;
                }
            }
        }

        List<Map<String, Object>> currentParts = new ArrayList<>();
        if (audioBytes != null && audioBytes.length > 0 && audioBytes.length <= 6_000_000) {
            String safeMime = (audioMime != null && !audioMime.isBlank()) ? audioMime : "audio/wav";
            currentParts.add(Map.of("inlineData", Map.of(
                    "mimeType", safeMime,
                    "data", Base64.getEncoder().encodeToString(audioBytes)
            )));
        }
        currentParts.add(Map.of("text", currentPrompt));

        if ("user".equals(lastRole) && !contents.isEmpty()) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> prevParts = (List<Map<String, Object>>) contents.get(contents.size() - 1).get("parts");
            prevParts.addAll(currentParts);
        } else {
            contents.add(Map.of("role", "user", "parts", currentParts));
        }
        return contents;
    }

    private record ModelResponse(String model, String body) {}

    private static String resolveModel(AppProperties properties) {
        return properties.getGeminiModel() != null && !properties.getGeminiModel().isBlank()
                ? properties.getGeminiModel().trim() : DEFAULT_MODEL;
    }

    private ModelResponse executeWithFallbackModel(String model, String apiKey, Map<String, Object> body) throws Exception {
        String jsonBody = objectMapper.writeValueAsString(body);
        HttpResponse<String> resp = sendGeminiRequest(model, apiKey, jsonBody);
        String resolvedModel = model;
        if (resp.statusCode() == 404 && !"gemini-3.8-flash".equalsIgnoreCase(model)) {
            log.warn("Gemini model '{}' returned HTTP 404; retrying with '{}'.", model, DEFAULT_MODEL);
            resolvedModel = DEFAULT_MODEL;
            resp = sendGeminiRequest(DEFAULT_MODEL, apiKey, jsonBody);
        }
        if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
            throw new IllegalStateException("Gemini HTTP " + resp.statusCode()
                    + LlmHttpUtils.extractHttpErrorDetail(objectMapper, resp.body()));
        }
        return new ModelResponse(resolvedModel, resp.body());
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
}
