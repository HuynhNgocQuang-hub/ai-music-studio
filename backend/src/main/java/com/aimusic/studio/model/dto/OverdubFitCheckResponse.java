package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.List;

public class OverdubFitCheckResponse {

    @JsonProperty("timing_offset_ms")
    private double timingOffsetMs;

    @JsonProperty("pitch_issues")
    private List<PitchIssue> pitchIssues = new ArrayList<>();

    @JsonProperty("gain_suggestion")
    private String gainSuggestion;

    @JsonProperty("one_click_fixes")
    private List<OneClickFix> oneClickFixes = new ArrayList<>();

    public OverdubFitCheckResponse() {}

    public OverdubFitCheckResponse(double timingOffsetMs, List<PitchIssue> pitchIssues,
                                   String gainSuggestion, List<OneClickFix> oneClickFixes) {
        this.timingOffsetMs = timingOffsetMs;
        this.pitchIssues = pitchIssues != null ? pitchIssues : new ArrayList<>();
        this.gainSuggestion = gainSuggestion;
        this.oneClickFixes = oneClickFixes != null ? oneClickFixes : new ArrayList<>();
    }

    public double getTimingOffsetMs() { return timingOffsetMs; }
    public void setTimingOffsetMs(double timingOffsetMs) { this.timingOffsetMs = timingOffsetMs; }

    public List<PitchIssue> getPitchIssues() { return pitchIssues; }
    public void setPitchIssues(List<PitchIssue> pitchIssues) { this.pitchIssues = pitchIssues; }

    public String getGainSuggestion() { return gainSuggestion; }
    public void setGainSuggestion(String gainSuggestion) { this.gainSuggestion = gainSuggestion; }

    public List<OneClickFix> getOneClickFixes() { return oneClickFixes; }
    public void setOneClickFixes(List<OneClickFix> oneClickFixes) { this.oneClickFixes = oneClickFixes; }
}
