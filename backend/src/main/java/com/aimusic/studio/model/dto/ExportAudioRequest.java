package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public class ExportAudioRequest {

    @JsonProperty("format")
    private String format = "wav";

    @JsonProperty("apply_mastering")
    private boolean applyMastering = true;

    @JsonProperty("mode")
    private String mode = "ai_mix";

    @JsonProperty("bitrate")
    private String bitrate = "320k";

    public String getFormat() { return format; }
    public void setFormat(String format) { this.format = format != null ? format : "wav"; }

    public boolean isApplyMastering() { return applyMastering; }
    public void setApplyMastering(boolean applyMastering) { this.applyMastering = applyMastering; }

    public String getMode() { return mode; }
    public void setMode(String mode) { this.mode = mode != null ? mode : "ai_mix"; }

    public String getBitrate() { return bitrate; }
    public void setBitrate(String bitrate) {
        if (bitrate != null && bitrate.trim().startsWith("192")) {
            this.bitrate = "192k";
        } else {
            this.bitrate = "320k";
        }
    }
}
