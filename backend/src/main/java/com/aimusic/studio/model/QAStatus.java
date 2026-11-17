package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonProperty;

public class QAStatus {

    @JsonProperty("approved")
    private boolean approved = true;

    @JsonProperty("iterations")
    private int iterations = 0;

    @JsonProperty("fallback_used")
    private boolean fallbackUsed = false;

    @JsonProperty("feedback")
    private String feedback = "";

    public QAStatus() {}

    public QAStatus(boolean approved, int iterations, boolean fallbackUsed, String feedback) {
        this.approved = approved;
        this.iterations = iterations;
        this.fallbackUsed = fallbackUsed;
        this.feedback = feedback != null ? feedback : "";
    }

    public boolean isApproved() { return approved; }
    public void setApproved(boolean approved) { this.approved = approved; }

    public int getIterations() { return iterations; }
    public void setIterations(int iterations) { this.iterations = Math.max(0, iterations); }

    public boolean isFallbackUsed() { return fallbackUsed; }
    public void setFallbackUsed(boolean fallbackUsed) { this.fallbackUsed = fallbackUsed; }

    public String getFeedback() { return feedback; }
    public void setFeedback(String feedback) { this.feedback = feedback != null ? feedback : ""; }
}
