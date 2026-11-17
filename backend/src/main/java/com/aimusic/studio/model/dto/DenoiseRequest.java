package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public class DenoiseRequest {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("enable_denoise")
    private boolean enableDenoise = true;

    @JsonProperty("auto_trim")
    private boolean autoTrim = true;

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public boolean isEnableDenoise() { return enableDenoise; }
    public void setEnableDenoise(boolean enableDenoise) { this.enableDenoise = enableDenoise; }

    public boolean isAutoTrim() { return autoTrim; }
    public void setAutoTrim(boolean autoTrim) { this.autoTrim = autoTrim; }
}
