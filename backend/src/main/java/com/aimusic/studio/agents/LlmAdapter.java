package com.aimusic.studio.agents;

import com.aimusic.studio.config.AppProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Orchestrates multi-agent LLM calls across pluggable {@link LlmProviderClient} strategies,
 * resolving BYOK/request/role overrides with automatic deterministic mock fallback.
 */
@Service
public class LlmAdapter {

    private static final Logger log = LoggerFactory.getLogger(LlmAdapter.class);
    private static final List<String> PLACEHOLDER_PREFIXES = List.of("your_", "changeme", "replace_", "example_", "<");

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
    public record ToolCall(String name, Map<String, Object> arguments) {}
    public record ToolLlmResponse(Provider provider, String model, String text, List<ToolCall> toolCalls, boolean isMock) {}

    private final AppProperties properties;
    private final ObjectMapper objectMapper;
    private final Map<Provider, LlmProviderClient> clients = new EnumMap<>(Provider.class);

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
    public LlmAdapter(
            AppProperties properties,
            ObjectMapper objectMapper,
            List<LlmProviderClient> providerClients
    ) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        registerClients(providerClients);
    }

    public LlmAdapter(String geminiApiKey, String openaiApiKey, String defaultProvider, ObjectMapper objectMapper) {
        this.properties = new AppProperties();
        this.properties.setGeminiApiKey(geminiApiKey != null ? geminiApiKey : "");
        this.properties.setOpenaiApiKey(openaiApiKey != null ? openaiApiKey : "");
        if (defaultProvider != null) this.properties.setDefaultLlmProvider(defaultProvider);
        this.objectMapper = objectMapper;
        registerClients(List.of(
                new GeminiProviderClient(objectMapper),
                new OpenAiProviderClient(objectMapper)
        ));
    }

    private void registerClients(List<LlmProviderClient> providerClients) {
        if (providerClients == null) return;
        for (LlmProviderClient client : providerClients) {
            if (client != null && client.provider() != null) {
                clients.put(client.provider(), client);
            }
        }
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

    private String apiKeyFor(Provider provider) {
        return switch (provider) {
            case GEMINI -> effectiveGeminiKey();
            case OPENAI -> effectiveOpenaiKey();
            case MOCK -> "";
        };
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
        if (provider == Provider.MOCK) return true;
        return clients.containsKey(provider) && isValidKey(apiKeyFor(provider));
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
        return executeCompletion(prompt, systemPrompt, role, explicitProvider, false);
    }

    public LlmResponse generateJson(String prompt, String systemPrompt, String role, String explicitProvider) {
        return executeCompletion(prompt, systemPrompt, role, explicitProvider, true);
    }

    private LlmResponse executeCompletion(
            String prompt,
            String systemPrompt,
            String role,
            String explicitProvider,
            boolean asJson
    ) {
        Provider selected = resolveProvider(role, explicitProvider);
        LlmProviderClient client = clients.get(selected);
        if (selected == Provider.MOCK || client == null) {
            return generateMock(prompt, role, asJson);
        }
        try {
            LlmResponse resp = client.generate(prompt, systemPrompt, asJson, apiKeyFor(selected), properties);
            if (!asJson) {
                return resp;
            }
            Map<String, Object> parsed = LlmHttpUtils.extractJsonBlock(objectMapper, resp.text());
            return new LlmResponse(resp.provider(), resp.model(), resp.text(), parsed, false);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            log.warn("LLM {} call via {} interrupted; falling back to mock.", asJson ? "JSON" : "text", selected.value());
        } catch (Exception ex) {
            log.warn("LLM {} call via {} failed ({}); falling back to mock.", asJson ? "JSON" : "text", selected.value(), ex.getMessage());
        }
        return generateMock(prompt, role, asJson);
    }

    public ToolLlmResponse generateWithTools(
            String prompt,
            String systemPrompt,
            List<Map<String, Object>> toolDeclarations,
            String role,
            String explicitProvider
    ) {
        return generateAudioWithTools(prompt, systemPrompt, null, null, toolDeclarations, role, explicitProvider);
    }

    public ToolLlmResponse generateAudioWithTools(
            String prompt,
            String systemPrompt,
            byte[] audioBytes,
            String audioMime,
            List<Map<String, Object>> toolDeclarations,
            String role,
            String explicitProvider
    ) {
        Provider selected = resolveProvider(role, explicitProvider);
        boolean hasAudio = audioBytes != null && audioBytes.length > 0 && audioBytes.length <= 6_000_000;
        if (hasAudio && selected != Provider.GEMINI) {
            if (hasKey(Provider.GEMINI) && selected != Provider.MOCK) {
                selected = Provider.GEMINI;
            } else {
                return new ToolLlmResponse(selected, "mock-audio-fallback", "", List.of(), true);
            }
        }
        LlmProviderClient client = clients.get(selected);
        if (selected == Provider.MOCK || client == null) {
            return new ToolLlmResponse(Provider.MOCK, "mock-music-v1", "", List.of(), true);
        }
        try {
            return client.generateWithTools(
                    prompt, systemPrompt, audioBytes, audioMime, toolDeclarations, apiKeyFor(selected), properties);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            log.warn("LLM tool call via {} interrupted; falling back to mock.", selected.value());
        } catch (Exception ex) {
            log.warn("LLM tool call via {} failed ({}); falling back to mock.", selected.value(), ex.getMessage());
        }
        return new ToolLlmResponse(Provider.MOCK, "mock-music-v1", "", List.of(), true);
    }

    public Map<String, Object> testConnection(String explicitProvider) {
        Provider selected = resolveProvider("coach", explicitProvider);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("provider", selected.value());
        LlmProviderClient client = clients.get(selected);
        if (selected == Provider.MOCK || client == null) {
            out.put("ok", false);
            out.put("is_mock", true);
            out.put("model", "mock-music-v1");
            out.put("latency_ms", 0);
            out.put("message", "Chua co API Key hop le hoac dang chon Mock Provider.");
            return out;
        }
        long started = System.nanoTime();
        try {
            LlmResponse resp = client.generate(
                    "Reply with OK.", "Respond briefly with OK.", false, apiKeyFor(selected), properties);
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

    private LlmResponse generateMock(String prompt, String role, boolean asJson) {
        String roleName = (role != null && !role.isBlank()) ? role.toLowerCase(Locale.ROOT) : "assistant";
        String digest = LlmHttpUtils.sha256Hex(roleName + ":" + prompt).substring(0, 12);
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
}
