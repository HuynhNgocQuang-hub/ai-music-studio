package com.aimusic.studio.model.dto;

import com.aimusic.studio.model.ProjectState;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.ArrayList;
import java.util.List;

public class AutoMixResponse {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("project_state")
    private ProjectState projectState;

    @JsonProperty("mix_notes")
    private List<String> mixNotes = new ArrayList<>();

    @JsonProperty("summary")
    private String summary;

    public AutoMixResponse() {}

    public AutoMixResponse(String projectId, ProjectState projectState, List<String> mixNotes, String summary) {
        this.projectId = projectId;
        this.projectState = projectState;
        this.mixNotes = mixNotes != null ? mixNotes : new ArrayList<>();
        this.summary = summary;
    }

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public ProjectState getProjectState() { return projectState; }
    public void setProjectState(ProjectState projectState) { this.projectState = projectState; }

    public List<String> getMixNotes() { return mixNotes; }
    public void setMixNotes(List<String> mixNotes) { this.mixNotes = mixNotes != null ? mixNotes : new ArrayList<>(); }

    public String getSummary() { return summary; }
    public void setSummary(String summary) { this.summary = summary; }
}
