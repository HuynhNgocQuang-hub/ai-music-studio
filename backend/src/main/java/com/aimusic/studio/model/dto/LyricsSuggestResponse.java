package com.aimusic.studio.model.dto;

import com.aimusic.studio.model.LyricLine;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.List;

public class LyricsSuggestResponse {

    @JsonProperty("language")
    private String language = "vi";

    @JsonProperty("lines")
    private List<LyricLine> lines = new ArrayList<>();

    public LyricsSuggestResponse() {}

    public LyricsSuggestResponse(String language, List<LyricLine> lines) {
        this.language = language;
        this.lines = lines != null ? lines : new ArrayList<>();
    }

    public String getLanguage() { return language; }
    public void setLanguage(String language) { this.language = language; }

    public List<LyricLine> getLines() { return lines; }
    public void setLines(List<LyricLine> lines) { this.lines = lines; }
}
