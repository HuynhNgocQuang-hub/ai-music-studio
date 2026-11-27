package com.aimusic.studio.config;

import com.aimusic.studio.collab.CollabWebSocketHandler;
import jakarta.websocket.server.ServerContainer;
import org.springframework.boot.web.servlet.ServletContextInitializer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private static final int MAX_WS_BUFFER_BYTES = 2 * 1024 * 1024;

    private final CollabWebSocketHandler collabHandler;
    private final AppProperties properties;

    public WebSocketConfig(CollabWebSocketHandler collabHandler, AppProperties properties) {
        this.collabHandler = collabHandler;
        this.properties = properties;
    }

    @Bean
    public ServletContextInitializer webSocketContainerCustomizer() {
        return servletContext -> {
            Object attr = servletContext.getAttribute("jakarta.websocket.server.ServerContainer");
            if (attr instanceof ServerContainer container) {
                container.setDefaultMaxTextMessageBufferSize(MAX_WS_BUFFER_BYTES);
                container.setDefaultMaxBinaryMessageBufferSize(MAX_WS_BUFFER_BYTES);
                container.setDefaultMaxSessionIdleTimeout(10L * 60 * 1000);
            }
        };
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        String[] origins = properties.getCorsOriginsList().toArray(new String[0]);
        registry.addHandler(collabHandler, "/ws/collab")
                .setAllowedOriginPatterns(origins.length > 0 ? origins : new String[]{"http://localhost:3000", "http://127.0.0.1:3000"});
    }
}
