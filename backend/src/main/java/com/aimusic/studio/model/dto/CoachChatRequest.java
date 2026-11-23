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

    @JsonProperty("mode")
    private String mode = "producer";

    @JsonProperty("route")
    private String route = "";

    @JsonProperty("context")
    private Map<String, Object> context;

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

    public String getMode() { return mode; }
    public void setMode(String mode) { this.mode = (mode != null && !mode.isBlank()) ? mode : "producer"; }

    public String getRoute() { return route; }
    public void setRoute(String route) { this.route = route != null ? route : ""; }

    public Map<String, Object> getContext() { return context; }
    public void setContext(Map<String, Object> context) { this.context = context; }

    public ProjectState getProjectState() { return projectState; }
    public void setProjectState(ProjectState projectState) { this.projectState = projectState; }
}
