package com.aimusic.studio.agents;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

public final class LlmContextHolder {

    private static final Logger log = LoggerFactory.getLogger(LlmContextHolder.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    public record LlmOverrides(
            String geminiApiKey,
            String openaiApiKey,
            String defaultProvider,
            Map<String, String> agentProviders
    ) {
        public LlmOverrides(String geminiApiKey, String openaiApiKey, String defaultProvider) {
            this(geminiApiKey, openaiApiKey, defaultProvider, null);
        }
    }

    private static final ThreadLocal<LlmOverrides> CONTEXT = new ThreadLocal<>();

    private LlmContextHolder() {}

    public static void set(LlmOverrides overrides) {
        if (overrides == null) {
            CONTEXT.remove();
        } else {
            CONTEXT.set(overrides);
        }
    }

    public static LlmOverrides get() {
        return CONTEXT.get();
    }

    public static void clear() {
        CONTEXT.remove();
    }

    public static LlmOverrides extractFromRequest(HttpServletRequest request) {
        if (request == null) return null;
        String g = trimToNull(request.getHeader("X-Gemini-Api-Key"));
        String o = trimToNull(request.getHeader("X-OpenAI-Api-Key"));
        String p = trimToNull(request.getHeader("X-LLM-Provider"));
        Map<String, String> agentMap = parseAgentProviders(trimToNull(request.getHeader("X-Agent-Providers")));
        if (g == null && o == null && p == null && agentMap == null) {
            return null;
        }
        return new LlmOverrides(g, o, p != null ? p.toLowerCase(Locale.ROOT) : null, agentMap);
    }

    private static Map<String, String> parseAgentProviders(String rawJson) {
        if (rawJson == null) return null;
        try {
            Map<String, Object> parsed = MAPPER.readValue(rawJson, new TypeReference<>() {});
            if (parsed == null || parsed.isEmpty()) return null;
            Map<String, String> normalized = new LinkedHashMap<>();
            for (Map.Entry<String, Object> e : parsed.entrySet()) {
                if (e.getKey() == null || e.getValue() == null) continue;
                String role = e.getKey().trim().toLowerCase(Locale.ROOT);
                String provider = e.getValue().toString().trim().toLowerCase(Locale.ROOT);
                if (!role.isEmpty() && !provider.isEmpty()) {
                    normalized.put(role, provider);
                }
            }
            return normalized.isEmpty() ? null : Collections.unmodifiableMap(normalized);
        } catch (Exception ex) {
            log.warn("Ignoring invalid X-Agent-Providers header: {}", ex.getMessage());
            return null;
        }
    }

    private static String trimToNull(String val) {
        if (val == null) return null;
        String trimmed = val.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
