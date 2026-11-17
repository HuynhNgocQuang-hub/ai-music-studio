package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonProperty;

public class ChordEvent {

    @JsonProperty("bar")
    private int bar = 1;

    @JsonProperty("beat")
    private double beat = 1.0;

    @JsonProperty("symbol")
    private String symbol = "C";

    @JsonProperty("duration_beats")
    private double durationBeats = 4.0;

    public ChordEvent() {}

    public ChordEvent(int bar, double beat, String symbol, double durationBeats) {
        this.bar = Math.max(1, bar);
        this.beat = Math.max(1.0, beat);
        this.symbol = symbol != null ? symbol : "C";
        this.durationBeats = Math.max(0.25, durationBeats);
    }

    public int getBar() { return bar; }
    public void setBar(int bar) { this.bar = Math.max(1, bar); }

    public double getBeat() { return beat; }
    public void setBeat(double beat) { this.beat = Math.max(1.0, beat); }

    public String getSymbol() { return symbol; }
    public void setSymbol(String symbol) { this.symbol = symbol; }

    public double getDurationBeats() { return durationBeats; }
    public void setDurationBeats(double durationBeats) { this.durationBeats = Math.max(0.25, durationBeats); }
}
