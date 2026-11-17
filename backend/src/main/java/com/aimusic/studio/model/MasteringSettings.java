package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonProperty;

public class MasteringSettings {

    @JsonProperty("auto_mix_enabled")
    private boolean autoMixEnabled = true;

    @JsonProperty("limiter_ceiling_db")
    private double limiterCeilingDb = -1.0;

    @JsonProperty("target_lufs")
    private double targetLufs = -14.0;

    public MasteringSettings() {}

    public boolean isAutoMixEnabled() { return autoMixEnabled; }
    public void setAutoMixEnabled(boolean autoMixEnabled) { this.autoMixEnabled = autoMixEnabled; }

    public double getLimiterCeilingDb() { return limiterCeilingDb; }
    public void setLimiterCeilingDb(double limiterCeilingDb) {
        this.limiterCeilingDb = Math.min(limiterCeilingDb, -1.0);
    }

    public double getTargetLufs() { return targetLufs; }
    public void setTargetLufs(double targetLufs) { this.targetLufs = targetLufs; }
}
