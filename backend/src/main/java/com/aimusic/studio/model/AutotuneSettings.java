package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonSetter;

public class AutotuneSettings {

    @JsonProperty("enabled")
    private boolean enabled = false;

    @JsonProperty("preset")
    private String preset = "off";

    @JsonProperty("key")
    private String key = "C";

    @JsonProperty("scale")
    private String scale = "major";

    @JsonProperty("retune_speed_ms")
    private double retuneSpeedMs = 35.0;

    @JsonProperty("humanize")
    private double humanize = 0.6;

    @JsonProperty("mix_percent")
    private double mixPercent = 100.0;

    @JsonProperty("auto_follow_project_key")
    private boolean autoFollowProjectKey = true;

    private transient boolean keyProvided = false;
    private transient boolean scaleProvided = false;

    public AutotuneSettings() {}

    public AutotuneSettings copy() {
        AutotuneSettings s = new AutotuneSettings();
        s.enabled = this.enabled;
        s.preset = this.preset;
        s.key = this.key;
        s.scale = this.scale;
        s.retuneSpeedMs = this.retuneSpeedMs;
        s.humanize = this.humanize;
        s.mixPercent = this.mixPercent;
        s.autoFollowProjectKey = this.autoFollowProjectKey;
        s.keyProvided = this.keyProvided;
        s.scaleProvided = this.scaleProvided;
        return s;
    }

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }

    public String getPreset() { return preset; }
    public void setPreset(String preset) { this.preset = preset != null ? preset : "off"; }

    public String getKey() { return key; }
    @JsonSetter("key")
    public void setKey(String key) {
        if (key != null && !key.isBlank()) {
            this.key = key;
            this.keyProvided = true;
        } else {
            this.key = "C";
            this.keyProvided = false;
        }
    }

    public String getScale() { return scale; }
    @JsonSetter("scale")
    public void setScale(String scale) {
        if (scale != null && !scale.isBlank()) {
            this.scale = scale;
            this.scaleProvided = true;
        } else {
            this.scale = "major";
            this.scaleProvided = false;
        }
    }

    @JsonIgnore
    public boolean isKeyProvided() { return keyProvided; }

    @JsonIgnore
    public boolean isScaleProvided() { return scaleProvided; }

    public double getRetuneSpeedMs() { return retuneSpeedMs; }
    public void setRetuneSpeedMs(double retuneSpeedMs) {
        this.retuneSpeedMs = Math.max(0.0, Math.min(200.0, retuneSpeedMs));
    }

    public double getHumanize() { return humanize; }
    public void setHumanize(double humanize) {
        this.humanize = Math.max(0.0, Math.min(1.0, humanize));
    }

    public double getMixPercent() { return mixPercent; }
    public void setMixPercent(double mixPercent) {
        this.mixPercent = Math.max(0.0, Math.min(100.0, mixPercent));
    }

    public boolean isAutoFollowProjectKey() { return autoFollowProjectKey; }
    public void setAutoFollowProjectKey(boolean autoFollowProjectKey) { this.autoFollowProjectKey = autoFollowProjectKey; }
}
