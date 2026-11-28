package com.aimusic.studio.agents;

import com.aimusic.studio.config.AppProperties;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * OpenAI Chat Completions strategy implementation of {@link LlmProviderClient}.
 */
@Component
public class OpenAiProviderClient implements LlmProviderClient {

    private static final String ENDPOINT = "https://api.openai.com/v1/chat/completions";
    private static final String DEFAULT_MODEL = "gpt-4o-mini";

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;

    @Autowired
    public OpenAiProviderClient(ObjectMapper objectMapper) {
        this(objectMapper, HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build());
    }

    OpenAiProviderClient(ObjectMapper objectMapper, HttpClient httpClient) {
        this.objectMapper = objectMapper;
        this.httpClient = httpClient;
    }

    @Override
    public LlmAdapter.Provider provider() {
        return LlmAdapter.Provider.OPENAI;
    }

    @Override
    public LlmAdapter.LlmResponse generate(
            String prompt,
            String systemPrompt,
            boolean asJson,
            String apiKey,
            AppProperties properties
    ) throws Exception {
        String model = resolveModel(properties);
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

        HttpResponse<String> resp = sendRequest(apiKey, body);
        JsonNode root = objectMapper.readTree(resp.body());
        String text = root.path("choices").path(0).path("message").path("content").asText("");
        return new LlmAdapter.LlmResponse(LlmAdapter.Provider.OPENAI, model, text, null, false);
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
        String model = resolveModel(properties);
        List<Map<String, Object>> messages = new ArrayList<>();
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            messages.add(Map.of("role", "system", "content", systemPrompt));
        }
        if (history != null) {
            for (LlmAdapter.ChatTurn turn : history) {
                if (turn == null || turn.content() == null || turn.content().isBlank()) continue;
                String role = "assistant".equalsIgnoreCase(turn.role()) || "model".equalsIgnoreCase(turn.role())
                        ? "assistant" : "user";
                messages.add(Map.of("role", role, "content", turn.content().trim()));
            }
        }
        messages.add(Map.of("role", "user", "content", prompt));

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("messages", messages);
        body.put("temperature", 0.42);
        if (toolDeclarations != null && !toolDeclarations.isEmpty()) {
            List<Map<String, Object>> wrapped = new ArrayList<>();
            for (Map<String, Object> decl : toolDeclarations) {
                Map<String, Object> openAiDecl = new LinkedHashMap<>(decl);
                if (decl.get("parameters") instanceof Map<?, ?> params) {
                    openAiDecl.put("parameters", LlmHttpUtils.lowercaseSchemaTypes(params));
                }
                wrapped.add(Map.of("type", "function", "function", openAiDecl));
            }
            body.put("tools", wrapped);
        }

        HttpResponse<String> resp = sendRequest(apiKey, body);
        JsonNode root = objectMapper.readTree(resp.body());
        JsonNode msg = root.path("choices").path(0).path("message");
        String replyText = msg.path("content").isTextual() ? msg.path("content").asText("").trim() : "";
        List<LlmAdapter.ToolCall> calls = new ArrayList<>();
        JsonNode tcs = msg.path("tool_calls");
        if (tcs.isArray()) {
            for (JsonNode tc : tcs) {
                JsonNode fn = tc.path("function");
                String fnName = fn.path("name").asText("");
                Map<String, Object> args = Map.of();
                String rawArgs = fn.path("arguments").asText("");
                if (!rawArgs.isBlank()) {
                    try {
                        args = objectMapper.readValue(rawArgs, new TypeReference<>() {});
                    } catch (Exception ignored) {
                        args = Map.of();
                    }
                }
                if (!fnName.isBlank()) {
                    calls.add(new LlmAdapter.ToolCall(fnName, args));
                }
            }
        }
        return new LlmAdapter.ToolLlmResponse(LlmAdapter.Provider.OPENAI, model, replyText, calls, false);
    }

    private static String resolveModel(AppProperties properties) {
        return properties.getOpenaiModel() != null && !properties.getOpenaiModel().isBlank()
                ? properties.getOpenaiModel() : DEFAULT_MODEL;
    }

    private HttpResponse<String> sendRequest(String apiKey, Map<String, Object> body) throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(ENDPOINT))
                .timeout(Duration.ofSeconds(25))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)))
                .build();
        HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
            throw new IllegalStateException("OpenAI HTTP " + resp.statusCode()
                    + LlmHttpUtils.extractHttpErrorDetail(objectMapper, resp.body()));
        }
        return resp;
    }
}
