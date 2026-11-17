package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonProperty;

public class SongSection {

    @JsonProperty("name")
    private String name = "Main";

    @JsonProperty("start_bar")
    private int startBar = 1;

    @JsonProperty("bars")
    private int bars = 4;

    @JsonProperty("energy")
    private double energy = 0.7;

    @JsonProperty("has_user_motif")
    private boolean hasUserMotif = false;

    public SongSection() {}

    public SongSection(String name, int startBar, int bars, double energy, boolean hasUserMotif) {
        this.name = name;
        this.startBar = Math.max(1, startBar);
        this.bars = Math.max(1, bars);
        this.energy = Math.max(0.0, Math.min(1.0, energy));
        this.hasUserMotif = hasUserMotif;
    }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public int getStartBar() { return startBar; }
    public void setStartBar(int startBar) { this.startBar = Math.max(1, startBar); }

    public int getBars() { return bars; }
    public void setBars(int bars) { this.bars = Math.max(1, bars); }

    public double getEnergy() { return energy; }
    public void setEnergy(double energy) { this.energy = Math.max(0.0, Math.min(1.0, energy)); }

    public boolean isHasUserMotif() { return hasUserMotif; }
    public void setHasUserMotif(boolean hasUserMotif) { this.hasUserMotif = hasUserMotif; }
}
