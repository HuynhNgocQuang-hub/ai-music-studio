package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.ArrayList;
import java.util.List;

public class ProjectAnalysis {

    @JsonProperty("bpm")
    private double bpm = 120.0;

    @JsonProperty("time_signature")
    private String timeSignature = "4/4";

    @JsonProperty("detected_key")
    private String detectedKey = "C";

    @JsonProperty("detected_scale")
    private String detectedScale = "major";

    @JsonProperty("key_confidence")
    private double keyConfidence = 0.8;

    @JsonProperty("low_confidence_warning")
    private boolean lowConfidenceWarning = false;

    @JsonProperty("bars")
    private int bars = 4;

    @JsonProperty("duration_sec")
    private double durationSec = 0.0;

    @JsonProperty("bpm_locked")
    private boolean bpmLocked = false;

    @JsonProperty("key_locked")
    private boolean keyLocked = false;

    @JsonProperty("raw_melody_midi")
    private List<MidiNote> rawMelodyMidi = new ArrayList<>();

    public ProjectAnalysis() {}

    public double getBpm() { return bpm; }
    public void setBpm(double bpm) { this.bpm = Math.max(40.0, Math.min(220.0, bpm)); }

    public String getTimeSignature() { return timeSignature; }
    public void setTimeSignature(String timeSignature) { this.timeSignature = timeSignature != null ? timeSignature : "4/4"; }

    public String getDetectedKey() { return detectedKey; }
    public void setDetectedKey(String detectedKey) { this.detectedKey = detectedKey != null ? detectedKey : "C"; }

    public String getDetectedScale() { return detectedScale; }
    public void setDetectedScale(String detectedScale) { this.detectedScale = detectedScale != null ? detectedScale : "major"; }

    public double getKeyConfidence() { return keyConfidence; }
    public void setKeyConfidence(double keyConfidence) { this.keyConfidence = keyConfidence; }

    public boolean isLowConfidenceWarning() { return lowConfidenceWarning; }
    public void setLowConfidenceWarning(boolean lowConfidenceWarning) { this.lowConfidenceWarning = lowConfidenceWarning; }

    public int getBars() { return bars; }
    public void setBars(int bars) { this.bars = Math.max(1, bars); }

    public double getDurationSec() { return durationSec; }
    public void setDurationSec(double durationSec) { this.durationSec = Math.max(0.0, durationSec); }

    public boolean isBpmLocked() { return bpmLocked; }
    public void setBpmLocked(boolean bpmLocked) { this.bpmLocked = bpmLocked; }

    public boolean isKeyLocked() { return keyLocked; }
    public void setKeyLocked(boolean keyLocked) { this.keyLocked = keyLocked; }

    public List<MidiNote> getRawMelodyMidi() { return rawMelodyMidi; }
    public void setRawMelodyMidi(List<MidiNote> rawMelodyMidi) {
        this.rawMelodyMidi = rawMelodyMidi != null ? rawMelodyMidi : new ArrayList<>();
    }
}
