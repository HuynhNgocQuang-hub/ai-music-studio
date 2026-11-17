package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.ArrayList;
import java.util.List;

public class SongStructure {

    @JsonProperty("total_bars")
    private int totalBars = 4;

    @JsonProperty("sections")
    private List<SongSection> sections = new ArrayList<>();

    @JsonProperty("chords")
    private List<ChordEvent> chords = new ArrayList<>();

    public SongStructure() {}

    public int getTotalBars() { return totalBars; }
    public void setTotalBars(int totalBars) { this.totalBars = Math.max(1, totalBars); }

    public List<SongSection> getSections() { return sections; }
    public void setSections(List<SongSection> sections) {
        this.sections = sections != null ? sections : new ArrayList<>();
    }

    public List<ChordEvent> getChords() { return chords; }
    public void setChords(List<ChordEvent> chords) {
        this.chords = chords != null ? chords : new ArrayList<>();
    }
}
