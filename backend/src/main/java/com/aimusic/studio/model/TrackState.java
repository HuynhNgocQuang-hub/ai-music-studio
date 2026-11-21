package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.ArrayList;
import java.util.List;

public class TrackState {

    @JsonProperty("type")
    private String type = "midi";

    @JsonProperty("locked")
    private boolean locked = false;

    @JsonProperty("mute")
    private boolean mute = false;

    @JsonProperty("solo")
    private boolean solo = false;

    @JsonProperty("volume")
    private double volume = 0.9;

    @JsonProperty("pan")
    private double pan = 0.0;

    @JsonProperty("low_db")
    private double lowDb = 0.0;

    @JsonProperty("mid_db")
    private double midDb = 0.0;

    @JsonProperty("high_db")
    private double highDb = 0.0;

    @JsonProperty("reverb_send")
    private double reverbSend = 0.0;

    @JsonProperty("delay_send")
    private double delaySend = 0.0;

    @JsonProperty("instrument")
    private String instrument;

    @JsonProperty("clips")
    private List<AudioClip> clips = new ArrayList<>();

    @JsonProperty("notes")
    private List<MidiNote> notes = new ArrayList<>();

    public TrackState() {}

    public static TrackState audioTrack(double volume, double pan) {
        TrackState t = new TrackState();
        t.type = "audio";
        t.volume = volume;
        t.pan = pan;
        return t;
    }

    public static TrackState midiTrack(String instrument, double volume, double pan) {
        TrackState t = new TrackState();
        t.type = "midi";
        t.instrument = instrument;
        t.volume = volume;
        t.pan = pan;
        return t;
    }

    private static double clampFinite(double value, double min, double max, double fallback) {
        if (!Double.isFinite(value)) return fallback;
        return Math.max(min, Math.min(max, value));
    }

    public String getType() { return type; }
    public void setType(String type) { this.type = type != null ? type : "midi"; }

    public boolean isLocked() { return locked; }
    public void setLocked(boolean locked) { this.locked = locked; }

    public boolean isMute() { return mute; }
    public void setMute(boolean mute) { this.mute = mute; }

    public boolean isSolo() { return solo; }
    public void setSolo(boolean solo) { this.solo = solo; }

    public double getVolume() { return volume; }
    public void setVolume(double volume) { this.volume = clampFinite(volume, 0.0, 1.2, 0.9); }

    public double getPan() { return pan; }
    public void setPan(double pan) { this.pan = clampFinite(pan, -1.0, 1.0, 0.0); }

    public double getLowDb() { return lowDb; }
    public void setLowDb(double lowDb) { this.lowDb = clampFinite(lowDb, -12.0, 12.0, 0.0); }

    public double getMidDb() { return midDb; }
    public void setMidDb(double midDb) { this.midDb = clampFinite(midDb, -12.0, 12.0, 0.0); }

    public double getHighDb() { return highDb; }
    public void setHighDb(double highDb) { this.highDb = clampFinite(highDb, -12.0, 12.0, 0.0); }

    public double getReverbSend() { return reverbSend; }
    public void setReverbSend(double reverbSend) { this.reverbSend = clampFinite(reverbSend, 0.0, 1.0, 0.0); }

    public double getDelaySend() { return delaySend; }
    public void setDelaySend(double delaySend) { this.delaySend = clampFinite(delaySend, 0.0, 1.0, 0.0); }

    public String getInstrument() { return instrument; }
    public void setInstrument(String instrument) { this.instrument = instrument; }

    public List<AudioClip> getClips() { return clips; }
    public void setClips(List<AudioClip> clips) { this.clips = clips != null ? clips : new ArrayList<>(); }

    public List<MidiNote> getNotes() { return notes; }
    public void setNotes(List<MidiNote> notes) { this.notes = notes != null ? notes : new ArrayList<>(); }
}
