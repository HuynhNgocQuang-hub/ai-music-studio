package com.aimusic.studio.model.dto;

import com.aimusic.studio.model.ChordEvent;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.SongSection;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.List;

public class JobRearrangeRequest {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("chords")
    private List<ChordEvent> chords = new ArrayList<>();

    @JsonProperty("sections")
    private List<SongSection> sections = new ArrayList<>();

    @JsonProperty("total_bars")
    private Integer totalBars;

    @JsonProperty("locked_tracks")
    private List<String> lockedTracks = new ArrayList<>();

    @JsonProperty("project_state")
    private ProjectState projectState;

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public List<ChordEvent> getChords() { return chords; }
    public void setChords(List<ChordEvent> chords) { this.chords = chords != null ? chords : new ArrayList<>(); }

    public List<SongSection> getSections() { return sections; }
    public void setSections(List<SongSection> sections) { this.sections = sections != null ? sections : new ArrayList<>(); }

    public Integer getTotalBars() { return totalBars; }
    public void setTotalBars(Integer totalBars) { this.totalBars = totalBars; }

    public List<String> getLockedTracks() { return lockedTracks; }
    public void setLockedTracks(List<String> lockedTracks) {
        this.lockedTracks = lockedTracks != null ? lockedTracks : new ArrayList<>();
    }

    public ProjectState getProjectState() { return projectState; }
    public void setProjectState(ProjectState projectState) { this.projectState = projectState; }
}
