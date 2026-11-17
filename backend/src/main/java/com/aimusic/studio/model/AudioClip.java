package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonProperty;

public class AudioClip {

    @JsonProperty("id")
    private String id;

    @JsonProperty("source")
    private String source;

    @JsonProperty("start_bar")
    private double startBar = 1.0;

    @JsonProperty("trim_start_sec")
    private double trimStartSec = 0.0;

    @JsonProperty("trim_end_sec")
    private Double trimEndSec;

    @JsonProperty("fade_in_ms")
    private double fadeInMs = 20.0;

    @JsonProperty("fade_out_ms")
    private double fadeOutMs = 20.0;

    @JsonProperty("offset_ms")
    private double offsetMs = 0.0;

    public AudioClip() {}

    public AudioClip(String id, String source, double startBar, double trimStartSec) {
        this.id = id;
        this.source = source;
        this.startBar = Math.max(1.0, startBar);
        this.trimStartSec = Math.max(0.0, trimStartSec);
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }

    public double getStartBar() { return startBar; }
    public void setStartBar(double startBar) { this.startBar = Math.max(1.0, startBar); }

    public double getTrimStartSec() { return trimStartSec; }
    public void setTrimStartSec(double trimStartSec) { this.trimStartSec = Math.max(0.0, trimStartSec); }

    public Double getTrimEndSec() { return trimEndSec; }
    public void setTrimEndSec(Double trimEndSec) { this.trimEndSec = trimEndSec; }

    public double getFadeInMs() { return fadeInMs; }
    public void setFadeInMs(double fadeInMs) { this.fadeInMs = Math.max(0.0, fadeInMs); }

    public double getFadeOutMs() { return fadeOutMs; }
    public void setFadeOutMs(double fadeOutMs) { this.fadeOutMs = Math.max(0.0, fadeOutMs); }

    public double getOffsetMs() { return offsetMs; }
    public void setOffsetMs(double offsetMs) { this.offsetMs = offsetMs; }
}
