package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonProperty;

public class ProjectConfig {

    @JsonProperty("title")
    private String title = "Untitled Project";

    @JsonProperty("melody_mode")
    private String melodyMode = "preserve";

    @JsonProperty("output_mode")
    private String outputMode = "accompaniment";

    @JsonProperty("structure_preset")
    private String structurePreset = "standard";

    @JsonProperty("motif_position")
    private String motifPosition = "chorus";

    @JsonProperty("genre")
    private String genre = "Pop";

    @JsonProperty("mood")
    private String mood = "Warm";

    @JsonProperty("user_prompt")
    private String userPrompt = "";

    @JsonProperty("enable_lead_karaoke")
    private Boolean enableLeadKaraoke;

    @JsonProperty("include_lead")
    private Boolean includeLead;

    @JsonProperty("include_lyrics")
    private Boolean includeLyrics;

    @JsonProperty("language")
    private String language;

    public ProjectConfig() {}

    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title != null ? title : "Untitled Project"; }

    public String getMelodyMode() { return melodyMode; }
    public void setMelodyMode(String melodyMode) { this.melodyMode = melodyMode != null ? melodyMode : "preserve"; }

    public String getOutputMode() { return outputMode; }
    public void setOutputMode(String outputMode) { this.outputMode = outputMode != null ? outputMode : "accompaniment"; }

    public String getStructurePreset() { return structurePreset; }
    public void setStructurePreset(String structurePreset) {
        if (structurePreset == null || structurePreset.isBlank()) {
            this.structurePreset = "standard";
        } else {
            this.structurePreset = "short".equalsIgnoreCase(structurePreset.trim()) ? "short" : "standard";
        }
    }

    public String getMotifPosition() { return motifPosition; }
    public void setMotifPosition(String motifPosition) { this.motifPosition = motifPosition != null ? motifPosition : "chorus"; }

    public String getGenre() { return genre; }
    public void setGenre(String genre) { this.genre = genre != null ? genre : "Pop"; }

    public String getMood() { return mood; }
    public void setMood(String mood) { this.mood = mood != null ? mood : "Warm"; }

    public String getUserPrompt() { return userPrompt; }
    public void setUserPrompt(String userPrompt) { this.userPrompt = userPrompt != null ? userPrompt : ""; }

    public Boolean getEnableLeadKaraoke() { return enableLeadKaraoke; }
    public void setEnableLeadKaraoke(Boolean enableLeadKaraoke) { this.enableLeadKaraoke = enableLeadKaraoke; }

    public Boolean getIncludeLead() { return includeLead; }
    public void setIncludeLead(Boolean includeLead) { this.includeLead = includeLead; }

    public Boolean getIncludeLyrics() { return includeLyrics; }
    public void setIncludeLyrics(Boolean includeLyrics) { this.includeLyrics = includeLyrics; }

    public String getLanguage() { return language; }
    public void setLanguage(String language) { this.language = language; }
}
