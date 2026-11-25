package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public class ProjectSummary {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("title")
    private String title;

    @JsonProperty("genre")
    private String genre;

    @JsonProperty("mood")
    private String mood;

    @JsonProperty("bpm")
    private double bpm;

    @JsonProperty("key")
    private String key;

    @JsonProperty("scale")
    private String scale;

    @JsonProperty("total_bars")
    private int totalBars;

    @JsonProperty("version")
    private int version;

    @JsonProperty("updated_at")
    private String updatedAt;

    @JsonProperty("has_audio")
    private boolean hasAudio;

    @JsonProperty("source")
    private String source = "draft";

    @JsonProperty("owner_id")
    private String ownerId;

    @JsonProperty("visibility")
    private String visibility;

    @JsonProperty("share_slug")
    private String shareSlug;

    @JsonProperty("published_at")
    private String publishedAt;

    public ProjectSummary() {}

    public ProjectSummary(String projectId, String title, String genre, String mood,
                          double bpm, String key, String scale, int totalBars,
                          int version, String updatedAt, boolean hasAudio, String source) {
        this.projectId = projectId;
        this.title = title;
        this.genre = genre;
        this.mood = mood;
        this.bpm = bpm;
        this.key = key;
        this.scale = scale;
        this.totalBars = totalBars;
        this.version = version;
        this.updatedAt = updatedAt;
        this.hasAudio = hasAudio;
        this.source = source != null ? source : "draft";
    }

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }

    public String getGenre() { return genre; }
    public void setGenre(String genre) { this.genre = genre; }

    public String getMood() { return mood; }
    public void setMood(String mood) { this.mood = mood; }

    public double getBpm() { return bpm; }
    public void setBpm(double bpm) { this.bpm = bpm; }

    public String getKey() { return key; }
    public void setKey(String key) { this.key = key; }

    public String getScale() { return scale; }
    public void setScale(String scale) { this.scale = scale; }

    public int getTotalBars() { return totalBars; }
    public void setTotalBars(int totalBars) { this.totalBars = totalBars; }

    public int getVersion() { return version; }
    public void setVersion(int version) { this.version = version; }

    public String getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(String updatedAt) { this.updatedAt = updatedAt; }

    public boolean isHasAudio() { return hasAudio; }
    public void setHasAudio(boolean hasAudio) { this.hasAudio = hasAudio; }

    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }

    public String getOwnerId() { return ownerId; }
    public void setOwnerId(String ownerId) { this.ownerId = ownerId; }

    public String getVisibility() { return visibility; }
    public void setVisibility(String visibility) { this.visibility = visibility; }

    public String getShareSlug() { return shareSlug; }
    public void setShareSlug(String shareSlug) { this.shareSlug = shareSlug; }

    public String getPublishedAt() { return publishedAt; }
    public void setPublishedAt(String publishedAt) { this.publishedAt = publishedAt; }
}
