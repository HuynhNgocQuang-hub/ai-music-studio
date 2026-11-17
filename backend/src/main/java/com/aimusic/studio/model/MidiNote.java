package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonProperty;

public class MidiNote {

    @JsonProperty("pitch")
    private int pitch = 60;

    @JsonProperty("start_beat")
    private double startBeat = 0.0;

    @JsonProperty("duration")
    @JsonAlias({"duration_beats"})
    private double duration = 1.0;

    @JsonProperty("velocity")
    private int velocity = 85;

    @JsonProperty("confidence")
    private double confidence = 1.0;

    public MidiNote() {}

    public MidiNote(int pitch, double startBeat, double duration, int velocity, double confidence) {
        this.pitch = Math.max(0, Math.min(127, pitch));
        this.startBeat = Math.max(0.0, startBeat);
        this.duration = Math.max(0.01, duration);
        this.velocity = Math.max(1, Math.min(127, velocity));
        this.confidence = Math.max(0.0, Math.min(1.0, confidence));
    }

    public MidiNote copy() {
        return new MidiNote(pitch, startBeat, duration, velocity, confidence);
    }

    public int getPitch() { return pitch; }
    public void setPitch(int pitch) { this.pitch = Math.max(0, Math.min(127, pitch)); }

    public double getStartBeat() { return startBeat; }
    public void setStartBeat(double startBeat) { this.startBeat = Math.max(0.0, startBeat); }

    public double getDuration() { return duration; }
    public void setDuration(double duration) { this.duration = Math.max(0.01, duration); }

    public int getVelocity() { return velocity; }
    public void setVelocity(int velocity) { this.velocity = Math.max(1, Math.min(127, velocity)); }

    public double getConfidence() { return confidence; }
    public void setConfidence(double confidence) { this.confidence = Math.max(0.0, Math.min(1.0, confidence)); }
}
