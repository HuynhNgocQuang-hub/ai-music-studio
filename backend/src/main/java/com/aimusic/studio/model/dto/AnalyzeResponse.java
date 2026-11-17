package com.aimusic.studio.model.dto;

import com.aimusic.studio.model.MidiNote;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.List;

public class AnalyzeResponse {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("bpm")
    private double bpm;

    @JsonProperty("time_signature")
    private String timeSignature;

    @JsonProperty("key")
    private String key;

    @JsonProperty("scale")
    private String scale;

    @JsonProperty("key_confidence")
    private double keyConfidence;

    @JsonProperty("low_confidence_warning")
    private boolean lowConfidenceWarning;

    @JsonProperty("bars")
    private int bars;

    @JsonProperty("duration_sec")
    private double durationSec;

    @JsonProperty("raw_melody_midi")
    private List<MidiNote> rawMelodyMidi = new ArrayList<>();

    public AnalyzeResponse() {}

    public AnalyzeResponse(String projectId, double bpm, String timeSignature, String key, String scale,
                           double keyConfidence, boolean lowConfidenceWarning, int bars,
                           double durationSec, List<MidiNote> rawMelodyMidi) {
        this.projectId = projectId;
        this.bpm = bpm;
        this.timeSignature = timeSignature;
        this.key = key;
        this.scale = scale;
        this.keyConfidence = keyConfidence;
        this.lowConfidenceWarning = lowConfidenceWarning;
        this.bars = bars;
        this.durationSec = durationSec;
        this.rawMelodyMidi = rawMelodyMidi != null ? rawMelodyMidi : new ArrayList<>();
    }

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public double getBpm() { return bpm; }
    public void setBpm(double bpm) { this.bpm = bpm; }

    public String getTimeSignature() { return timeSignature; }
    public void setTimeSignature(String timeSignature) { this.timeSignature = timeSignature; }

    public String getKey() { return key; }
    public void setKey(String key) { this.key = key; }

    public String getScale() { return scale; }
    public void setScale(String scale) { this.scale = scale; }

    public double getKeyConfidence() { return keyConfidence; }
    public void setKeyConfidence(double keyConfidence) { this.keyConfidence = keyConfidence; }

    public boolean isLowConfidenceWarning() { return lowConfidenceWarning; }
    public void setLowConfidenceWarning(boolean lowConfidenceWarning) { this.lowConfidenceWarning = lowConfidenceWarning; }

    public int getBars() { return bars; }
    public void setBars(int bars) { this.bars = bars; }

    public double getDurationSec() { return durationSec; }
    public void setDurationSec(double durationSec) { this.durationSec = durationSec; }

    public List<MidiNote> getRawMelodyMidi() { return rawMelodyMidi; }
    public void setRawMelodyMidi(List<MidiNote> rawMelodyMidi) { this.rawMelodyMidi = rawMelodyMidi; }
}
