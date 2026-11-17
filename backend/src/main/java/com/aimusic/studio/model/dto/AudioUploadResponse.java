package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.List;

public class AudioUploadResponse {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("raw_input_ref")
    private String rawInputRef;

    @JsonProperty("filename")
    private String filename;

    @JsonProperty("duration_sec")
    private double durationSec;

    @JsonProperty("sample_rate")
    private int sampleRate;

    @JsonProperty("channels")
    private int channels;

    @JsonProperty("size_bytes")
    private long sizeBytes;

    @JsonProperty("format")
    private String format;

    @JsonProperty("warnings")
    private List<String> warnings = new ArrayList<>();

    public AudioUploadResponse() {}

    public AudioUploadResponse(String projectId, String rawInputRef, String filename,
                               double durationSec, int sampleRate, int channels,
                               long sizeBytes, String format, List<String> warnings) {
        this.projectId = projectId;
        this.rawInputRef = rawInputRef;
        this.filename = filename;
        this.durationSec = durationSec;
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.sizeBytes = sizeBytes;
        this.format = format;
        this.warnings = warnings != null ? warnings : new ArrayList<>();
    }

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public String getRawInputRef() { return rawInputRef; }
    public void setRawInputRef(String rawInputRef) { this.rawInputRef = rawInputRef; }

    public String getFilename() { return filename; }
    public void setFilename(String filename) { this.filename = filename; }

    public double getDurationSec() { return durationSec; }
    public void setDurationSec(double durationSec) { this.durationSec = durationSec; }

    public int getSampleRate() { return sampleRate; }
    public void setSampleRate(int sampleRate) { this.sampleRate = sampleRate; }

    public int getChannels() { return channels; }
    public void setChannels(int channels) { this.channels = channels; }

    public long getSizeBytes() { return sizeBytes; }
    public void setSizeBytes(long sizeBytes) { this.sizeBytes = sizeBytes; }

    public String getFormat() { return format; }
    public void setFormat(String format) { this.format = format; }

    public List<String> getWarnings() { return warnings; }
    public void setWarnings(List<String> warnings) { this.warnings = warnings; }
}
