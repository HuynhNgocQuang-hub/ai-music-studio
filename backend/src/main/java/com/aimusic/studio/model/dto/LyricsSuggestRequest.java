package com.aimusic.studio.model.dto;

import com.aimusic.studio.model.ProjectState;
import com.fasterxml.jackson.annotation.JsonProperty;

public class LyricsSuggestRequest {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("language")
    private String language = "vi";

    @JsonProperty("topic")
    private String topic = "";

    @JsonProperty("section")
    private String section;

    @JsonProperty("project_state")
    private ProjectState projectState;

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public String getLanguage() { return language; }
    public void setLanguage(String language) { this.language = language != null ? language : "vi"; }

    public String getTopic() { return topic; }
    public void setTopic(String topic) { this.topic = topic != null ? topic : ""; }

    public String getSection() { return section; }
    public void setSection(String section) { this.section = section; }

    public ProjectState getProjectState() { return projectState; }
    public void setProjectState(ProjectState projectState) { this.projectState = projectState; }
}
