package com.aimusic.studio.model.dto;

import com.aimusic.studio.model.AutotuneSettings;
import com.fasterxml.jackson.annotation.JsonProperty;

public class AutotuneResponse {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("tuned_vocal_ref")
    private String tunedVocalRef;

    @JsonProperty("autotune_settings")
    private AutotuneSettings autotuneSettings;

    @JsonProperty("duration_sec")
    private double durationSec;

    public AutotuneResponse() {}

    public AutotuneResponse(String projectId, String tunedVocalRef, AutotuneSettings autotuneSettings, double durationSec) {
        this.projectId = projectId;
        this.tunedVocalRef = tunedVocalRef;
        this.autotuneSettings = autotuneSettings;
        this.durationSec = durationSec;
    }

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public String getTunedVocalRef() { return tunedVocalRef; }
    public void setTunedVocalRef(String tunedVocalRef) { this.tunedVocalRef = tunedVocalRef; }

    public AutotuneSettings getAutotuneSettings() { return autotuneSettings; }
    public void setAutotuneSettings(AutotuneSettings autotuneSettings) { this.autotuneSettings = autotuneSettings; }

    public double getDurationSec() { return durationSec; }
    public void setDurationSec(double durationSec) { this.durationSec = durationSec; }
}
