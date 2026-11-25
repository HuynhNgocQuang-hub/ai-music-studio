package com.aimusic.studio.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class CorsConfig implements WebMvcConfigurer {

    private static final String[] DEFAULT_LOCAL_ORIGINS = {
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:5173",
            "http://127.0.0.1:5173"
    };

    private final AppProperties properties;

    public CorsConfig(AppProperties properties) {
        this.properties = properties;
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        String[] origins = properties.getCorsOriginsList().toArray(new String[0]);
        registry.addMapping("/api/**")
                .allowedOriginPatterns(origins.length > 0 ? origins : DEFAULT_LOCAL_ORIGINS)
                .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .exposedHeaders("Content-Disposition", "X-Quota-Remaining", "X-Peak-Dbfs")
                .allowCredentials(true)
                .maxAge(3600);
    }
}
