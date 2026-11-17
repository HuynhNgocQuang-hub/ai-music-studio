package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class ProjectState {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("title")
    private String title;

    @JsonProperty("version")
    private int version = 1;

    @JsonProperty("created_at")
    private String createdAt = Instant.now().toString();

    @JsonProperty("updated_at")
    private String updatedAt = Instant.now().toString();

    @JsonProperty("source")
    private String source = "draft";

    @JsonProperty("config")
    private ProjectConfig config = new ProjectConfig();

    @JsonProperty("audio_assets")
    private AudioAssets audioAssets = new AudioAssets();

    @JsonProperty("analysis")
    private ProjectAnalysis analysis = new ProjectAnalysis();

    @JsonProperty("autotune_settings")
    private AutotuneSettings autotuneSettings = new AutotuneSettings();

    @JsonProperty("song_structure")
    private SongStructure songStructure = new SongStructure();

    @JsonProperty("lyrics")
    private ProjectLyrics lyrics = new ProjectLyrics();

    @JsonProperty("tracks")
    private Map<String, TrackState> tracks = defaultTracks();

    @JsonProperty("mastering")
    private MasteringSettings mastering = new MasteringSettings();

    @JsonProperty("qa_status")
    private QAStatus qaStatus = new QAStatus();

    @JsonProperty("melody_notes")
    private List<MidiNote> melodyNotes;

    public ProjectState() {}

    public static Map<String, TrackState> defaultTracks() {
        Map<String, TrackState> map = new LinkedHashMap<>();
        map.put("vocal", TrackState.audioTrack(0.95, 0.0));
        map.put("drums", TrackState.midiTrack("acoustic_kit", 0.85, 0.0));
        map.put("bass", TrackState.midiTrack("finger_bass", 0.85, 0.0));
        map.put("harmony", TrackState.midiTrack("grand_piano", 0.80, -0.1));
        map.put("lead", TrackState.midiTrack("electric_piano", 0.80, 0.1));
        return map;
    }

    public static ProjectState createDefault(String projectId, String title) {
        String datePart = DateTimeFormatter.ofPattern("yyyyMMdd")
                .withZone(ZoneOffset.UTC)
                .format(Instant.now());
        String pid = (projectId != null && !projectId.isBlank())
                ? projectId
                : "proj_" + datePart + "_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        String effectiveTitle = (title != null && !title.isBlank()) ? title : "Untitled Project";

        ProjectState state = new ProjectState();
        state.setProjectId(pid);
        state.setTitle(effectiveTitle);
        state.getConfig().setTitle(effectiveTitle);
        return state;
    }

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public String getTitle() {
        if (title != null && !title.isBlank()) return title;
        return config != null ? config.getTitle() : "Untitled Project";
    }
    public void setTitle(String title) { this.title = title; }

    public int getVersion() { return version; }
    public void setVersion(int version) { this.version = Math.max(1, version); }

    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }

    public String getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(String updatedAt) { this.updatedAt = updatedAt; }

    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }

    public ProjectConfig getConfig() { return config; }
    public void setConfig(ProjectConfig config) { this.config = config != null ? config : new ProjectConfig(); }

    public AudioAssets getAudioAssets() { return audioAssets; }
    public void setAudioAssets(AudioAssets audioAssets) { this.audioAssets = audioAssets != null ? audioAssets : new AudioAssets(); }

    public ProjectAnalysis getAnalysis() { return analysis; }
    public void setAnalysis(ProjectAnalysis analysis) { this.analysis = analysis != null ? analysis : new ProjectAnalysis(); }

    public AutotuneSettings getAutotuneSettings() { return autotuneSettings; }
    public void setAutotuneSettings(AutotuneSettings autotuneSettings) {
        this.autotuneSettings = autotuneSettings != null ? autotuneSettings : new AutotuneSettings();
    }

    public SongStructure getSongStructure() { return songStructure; }
    public void setSongStructure(SongStructure songStructure) {
        this.songStructure = songStructure != null ? songStructure : new SongStructure();
    }

    public ProjectLyrics getLyrics() { return lyrics; }
    public void setLyrics(ProjectLyrics lyrics) { this.lyrics = lyrics != null ? lyrics : new ProjectLyrics(); }

    public Map<String, TrackState> getTracks() { return tracks; }
    public void setTracks(Map<String, TrackState> tracks) {
        this.tracks = tracks != null ? tracks : defaultTracks();
    }

    public MasteringSettings getMastering() { return mastering; }
    public void setMastering(MasteringSettings mastering) {
        this.mastering = mastering != null ? mastering : new MasteringSettings();
    }

    public QAStatus getQaStatus() { return qaStatus; }
    public void setQaStatus(QAStatus qaStatus) { this.qaStatus = qaStatus != null ? qaStatus : new QAStatus(); }

    public List<MidiNote> getMelodyNotes() { return melodyNotes; }
    public void setMelodyNotes(List<MidiNote> melodyNotes) { this.melodyNotes = melodyNotes; }
}
