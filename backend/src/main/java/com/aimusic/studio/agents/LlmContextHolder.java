package com.aimusic.studio.agents;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Locale;

public final class LlmContextHolder {

    public record LlmOverrides(String geminiApiKey, String openaiApiKey, String defaultProvider) {}

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
        if (g == null && o == null && p == null) {
            return null;
        }
        return new LlmOverrides(g, o, p != null ? p.toLowerCase(Locale.ROOT) : null);
    }

    private static String trimToNull(String val) {
        if (val == null) return null;
        String trimmed = val.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
