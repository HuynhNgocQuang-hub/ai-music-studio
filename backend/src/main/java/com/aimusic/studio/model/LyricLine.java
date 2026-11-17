package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonProperty;

public class LyricLine {

    @JsonProperty("section")
    private String section = "Main";

    @JsonProperty("bar")
    private int bar = 1;

    @JsonProperty("text")
    private String text = "";

    public LyricLine() {}

    public LyricLine(String section, int bar, String text) {
        this.section = section;
        this.bar = Math.max(1, bar);
        this.text = text != null ? text : "";
    }

    public String getSection() { return section; }
    public void setSection(String section) { this.section = section; }

    public int getBar() { return bar; }
    public void setBar(int bar) { this.bar = Math.max(1, bar); }

    public String getText() { return text; }
    public void setText(String text) { this.text = text != null ? text : ""; }
}
