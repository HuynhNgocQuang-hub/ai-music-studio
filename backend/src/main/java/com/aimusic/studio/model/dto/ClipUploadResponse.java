package com.aimusic.studio.model.dto;

import com.aimusic.studio.model.AudioClip;
import com.aimusic.studio.model.ProjectState;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.ArrayList;
import java.util.List;

public class ClipUploadResponse {

    @JsonProperty("project_state")
    private ProjectState projectState;

    @JsonProperty("clip")
    private AudioClip clip;

    @JsonProperty("audio_ref")
    private String audioRef;

    @JsonProperty("track_id")
    private String trackId;

    @JsonProperty("duration_sec")
    private double durationSec;

    @JsonProperty("warnings")
    private List<String> warnings = new ArrayList<>();

    public ClipUploadResponse() {}

    public ClipUploadResponse(
            ProjectState projectState,
            AudioClip clip,
            String audioRef,
            String trackId,
            double durationSec,
            List<String> warnings
    ) {
        this.projectState = projectState;
        this.clip = clip;
        this.audioRef = audioRef;
        this.trackId = trackId;
        this.durationSec = durationSec;
        this.warnings = warnings != null ? warnings : new ArrayList<>();
    }

    public ProjectState getProjectState() { return projectState; }
    public void setProjectState(ProjectState projectState) { this.projectState = projectState; }

    public AudioClip getClip() { return clip; }
    public void setClip(AudioClip clip) { this.clip = clip; }

    public String getAudioRef() { return audioRef; }
    public void setAudioRef(String audioRef) { this.audioRef = audioRef; }

    public String getTrackId() { return trackId; }
    public void setTrackId(String trackId) { this.trackId = trackId; }

    public double getDurationSec() { return durationSec; }
    public void setDurationSec(double durationSec) { this.durationSec = durationSec; }

    public List<String> getWarnings() { return warnings; }
    public void setWarnings(List<String> warnings) { this.warnings = warnings != null ? warnings : new ArrayList<>(); }
}
