package com.aimusic.studio.agents;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Shared HTTP error sanitization, JSON extraction, and schema normalization helpers for LLM provider clients.
 */
final class LlmHttpUtils {

    private static final Pattern JSON_OBJECT_PATTERN = Pattern.compile("\\{[\\s\\S]*\\}");
    private static final Pattern API_KEY_LEAK_PATTERN =
            Pattern.compile("(?:AIza[0-9A-Za-z_-]{12,}|AQ\\.[0-9A-Za-z_.-]{12,}|sk-[0-9A-Za-z_-]{12,})");

    private LlmHttpUtils() {}

    static String extractHttpErrorDetail(ObjectMapper objectMapper, String responseBody) {
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

    static Object lowercaseSchemaTypes(Object node) {
        if (node instanceof Map<?, ?> map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (entry.getKey() == null) continue;
                String k = String.valueOf(entry.getKey());
                Object v = entry.getValue();
                if ("type".equals(k) && v instanceof String s) {
                    out.put(k, s.toLowerCase(Locale.ROOT));
                } else {
                    out.put(k, lowercaseSchemaTypes(v));
                }
            }
            return out;
        }
        if (node instanceof List<?> list) {
            List<Object> out = new ArrayList<>(list.size());
            for (Object item : list) {
                out.add(lowercaseSchemaTypes(item));
            }
            return out;
        }
        return node;
    }

    static Map<String, Object> extractJsonBlock(ObjectMapper objectMapper, String rawText) throws Exception {
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

    static String sha256Hex(String input) {
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
