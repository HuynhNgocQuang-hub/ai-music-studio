package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public class PitchIssue {

    @JsonProperty("bar")
    private int bar;

    @JsonProperty("note")
    private String note;

    @JsonProperty("cents_off")
    private double centsOff;

    @JsonProperty("description")
    private String description;

    public PitchIssue() {}

    public PitchIssue(int bar, String note, double centsOff, String description) {
        this.bar = bar;
        this.note = note;
        this.centsOff = centsOff;
        this.description = description;
    }

    public int getBar() { return bar; }
    public void setBar(int bar) { this.bar = bar; }

    public String getNote() { return note; }
    public void setNote(String note) { this.note = note; }

    public double getCentsOff() { return centsOff; }
    public void setCentsOff(double centsOff) { this.centsOff = centsOff; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }
}
