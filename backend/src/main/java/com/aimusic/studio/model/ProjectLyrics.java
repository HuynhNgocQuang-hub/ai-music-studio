package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.ArrayList;
import java.util.List;

public class ProjectLyrics {

    @JsonProperty("language")
    private String language = "vi";

    @JsonProperty("lines")
    private List<LyricLine> lines = new ArrayList<>();

    public ProjectLyrics() {}

    public ProjectLyrics(String language, List<LyricLine> lines) {
        this.language = language != null ? language : "vi";
        this.lines = lines != null ? lines : new ArrayList<>();
    }

    public String getLanguage() { return language; }
    public void setLanguage(String language) { this.language = language != null ? language : "vi"; }

    public List<LyricLine> getLines() { return lines; }
    public void setLines(List<LyricLine> lines) { this.lines = lines != null ? lines : new ArrayList<>(); }
}
