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

    public String getType() { return type; }
    public void setType(String type) { this.type = type != null ? type : "midi"; }

    public boolean isLocked() { return locked; }
    public void setLocked(boolean locked) { this.locked = locked; }

    public boolean isMute() { return mute; }
    public void setMute(boolean mute) { this.mute = mute; }

    public boolean isSolo() { return solo; }
    public void setSolo(boolean solo) { this.solo = solo; }

    public double getVolume() { return volume; }
    public void setVolume(double volume) { this.volume = Math.max(0.0, Math.min(1.2, volume)); }

    public double getPan() { return pan; }
    public void setPan(double pan) { this.pan = Math.max(-1.0, Math.min(1.0, pan)); }

    public String getInstrument() { return instrument; }
    public void setInstrument(String instrument) { this.instrument = instrument; }

    public List<AudioClip> getClips() { return clips; }
    public void setClips(List<AudioClip> clips) { this.clips = clips != null ? clips : new ArrayList<>(); }

    public List<MidiNote> getNotes() { return notes; }
    public void setNotes(List<MidiNote> notes) { this.notes = notes != null ? notes : new ArrayList<>(); }
}
