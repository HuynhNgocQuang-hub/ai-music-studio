package com.aimusic.studio.model.dto;

import com.aimusic.studio.model.ProjectState;
import com.fasterxml.jackson.annotation.JsonProperty;

public class AutoTrimVocalResponse {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("project_state")
    private ProjectState projectState;

    @JsonProperty("summary")
    private String summary;

    @JsonProperty("trim_start_sec")
    private double trimStartSec;

    @JsonProperty("trim_end_sec")
    private double trimEndSec;

    @JsonProperty("offset_ms")
    private double offsetMs;

    @JsonProperty("trimmed_clips")
    private int trimmedClips;

    public AutoTrimVocalResponse() {}

    public AutoTrimVocalResponse(
            String projectId,
            ProjectState projectState,
            String summary,
            double trimStartSec,
            double trimEndSec,
            double offsetMs,
            int trimmedClips
    ) {
        this.projectId = projectId;
        this.projectState = projectState;
        this.summary = summary;
        this.trimStartSec = trimStartSec;
        this.trimEndSec = trimEndSec;
        this.offsetMs = offsetMs;
        this.trimmedClips = trimmedClips;
    }

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public ProjectState getProjectState() { return projectState; }
    public void setProjectState(ProjectState projectState) { this.projectState = projectState; }

    public String getSummary() { return summary; }
    public void setSummary(String summary) { this.summary = summary; }

    public double getTrimStartSec() { return trimStartSec; }
    public void setTrimStartSec(double trimStartSec) { this.trimStartSec = trimStartSec; }

    public double getTrimEndSec() { return trimEndSec; }
    public void setTrimEndSec(double trimEndSec) { this.trimEndSec = trimEndSec; }

    public double getOffsetMs() { return offsetMs; }
    public void setOffsetMs(double offsetMs) { this.offsetMs = offsetMs; }

    public int getTrimmedClips() { return trimmedClips; }
    public void setTrimmedClips(int trimmedClips) { this.trimmedClips = trimmedClips; }
}
