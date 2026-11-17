package com.aimusic.studio;

import com.aimusic.studio.config.AppProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties(AppProperties.class)
public class AiMusicStudioApplication {

    public static void main(String[] args) {
        SpringApplication.run(AiMusicStudioApplication.class, args);
    }
}
