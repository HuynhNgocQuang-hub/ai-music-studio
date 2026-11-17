package com.aimusic.studio.model.dto;

import com.aimusic.studio.model.ProjectState;
import com.fasterxml.jackson.annotation.JsonProperty;

public class JobRegenerateTrackRequest {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("target_track")
    private String targetTrack;

    @JsonProperty("instrument")
    private String instrument;

    @JsonProperty("project_state")
    private ProjectState projectState;

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public String getTargetTrack() { return targetTrack; }
    public void setTargetTrack(String targetTrack) { this.targetTrack = targetTrack; }

    public String getInstrument() { return instrument; }
    public void setInstrument(String instrument) { this.instrument = instrument; }

    public ProjectState getProjectState() { return projectState; }
    public void setProjectState(ProjectState projectState) { this.projectState = projectState; }
}
