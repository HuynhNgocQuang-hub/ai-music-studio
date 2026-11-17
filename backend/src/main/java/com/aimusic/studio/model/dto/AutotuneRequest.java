package com.aimusic.studio.model.dto;

import com.aimusic.studio.model.AutotuneSettings;
import com.fasterxml.jackson.annotation.JsonProperty;

public class AutotuneRequest {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("autotune_settings")
    private AutotuneSettings autotuneSettings;

    @JsonProperty("preset")
    private String preset;

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public AutotuneSettings getAutotuneSettings() { return autotuneSettings; }
    public void setAutotuneSettings(AutotuneSettings autotuneSettings) { this.autotuneSettings = autotuneSettings; }

    public String getPreset() { return preset; }
    public void setPreset(String preset) { this.preset = preset; }
}
