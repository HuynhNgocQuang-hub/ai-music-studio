package com.aimusic.studio.agents;

import com.aimusic.studio.config.AppProperties;

import java.util.List;
import java.util.Map;

/**
 * Strategy interface decoupling {@link LlmAdapter} orchestration from concrete LLM HTTP provider implementations.
 */
public interface LlmProviderClient {

    /**
     * @return the concrete {@link LlmAdapter.Provider} handled by this strategy.
     */
    LlmAdapter.Provider provider();

    /**
     * Execute a standard text or structured-JSON completion request.
     */
    LlmAdapter.LlmResponse generate(
            String prompt,
            String systemPrompt,
            boolean asJson,
            String apiKey,
            AppProperties properties
    ) throws Exception;

    /**
     * Execute a single-turn tool-calling (and optional multimodal audio) completion request.
     */
    LlmAdapter.ToolLlmResponse generateWithTools(
            String prompt,
            String systemPrompt,
            byte[] audioBytes,
            String audioMime,
            List<Map<String, Object>> toolDeclarations,
            String apiKey,
            AppProperties properties
    ) throws Exception;

    /**
     * Execute a multi-turn conversational tool-calling request preserving user/assistant turns.
     */
    default LlmAdapter.ToolLlmResponse generateConversationWithTools(
            List<LlmAdapter.ChatTurn> history,
            String prompt,
            String systemPrompt,
            byte[] audioBytes,
            String audioMime,
            List<Map<String, Object>> toolDeclarations,
            String apiKey,
            AppProperties properties
    ) throws Exception {
        return generateWithTools(prompt, systemPrompt, audioBytes, audioMime, toolDeclarations, apiKey, properties);
    }
}
