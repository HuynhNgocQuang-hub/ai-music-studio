package com.aimusic.studio.model.dto;

import com.aimusic.studio.model.ChordEvent;
import com.aimusic.studio.model.ProjectState;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.List;

public class JobRearrangeRequest {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("chords")
    private List<ChordEvent> chords = new ArrayList<>();

    @JsonProperty("locked_tracks")
    private List<String> lockedTracks = new ArrayList<>();

    @JsonProperty("project_state")
    private ProjectState projectState;

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public List<ChordEvent> getChords() { return chords; }
    public void setChords(List<ChordEvent> chords) { this.chords = chords != null ? chords : new ArrayList<>(); }

    public List<String> getLockedTracks() { return lockedTracks; }
    public void setLockedTracks(List<String> lockedTracks) {
        this.lockedTracks = lockedTracks != null ? lockedTracks : new ArrayList<>();
    }

    public ProjectState getProjectState() { return projectState; }
    public void setProjectState(ProjectState projectState) { this.projectState = projectState; }
}
