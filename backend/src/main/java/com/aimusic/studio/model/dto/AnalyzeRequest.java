package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public class AnalyzeRequest {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("source_ref")
    private String sourceRef;

    @JsonProperty("bpm_override")
    private Double bpmOverride;

    @JsonProperty("key_override")
    private String keyOverride;

    @JsonProperty("scale_override")
    private String scaleOverride;

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public String getSourceRef() { return sourceRef; }
    public void setSourceRef(String sourceRef) { this.sourceRef = sourceRef; }

    public Double getBpmOverride() { return bpmOverride; }
    public void setBpmOverride(Double bpmOverride) { this.bpmOverride = bpmOverride; }

    public String getKeyOverride() { return keyOverride; }
    public void setKeyOverride(String keyOverride) { this.keyOverride = keyOverride; }

    public String getScaleOverride() { return scaleOverride; }
    public void setScaleOverride(String scaleOverride) { this.scaleOverride = scaleOverride; }
}
