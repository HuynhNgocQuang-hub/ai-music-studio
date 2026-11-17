package com.aimusic.studio.model.dto;

import com.aimusic.studio.model.ProjectState;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class CoachChatRequest {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("message")
    private String message;

    @JsonProperty("history")
    private List<Map<String, Object>> history = new ArrayList<>();

    @JsonProperty("project_state")
    private ProjectState projectState;

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public String getMessage() { return message; }
    public void setMessage(String message) { this.message = message; }

    public List<Map<String, Object>> getHistory() { return history; }
    public void setHistory(List<Map<String, Object>> history) {
        this.history = history != null ? history : new ArrayList<>();
    }

    public ProjectState getProjectState() { return projectState; }
    public void setProjectState(ProjectState projectState) { this.projectState = projectState; }
}
