package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public class ExportAudioRequest {

    @JsonProperty("format")
    private String format = "wav";

    @JsonProperty("apply_mastering")
    private boolean applyMastering = true;

    @JsonProperty("mode")
    private String mode = "ai_mix";

    @JsonProperty("bitrate")
    private String bitrate = "320k";

    @JsonProperty("title")
    private String title;

    @JsonProperty("artist")
    private String artist;

    @JsonProperty("album")
    private String album;

    @JsonProperty("genre")
    private String genre;

    @JsonProperty("target_lufs")
    private Double targetLufs;

    public String getFormat() { return format; }
    public void setFormat(String format) { this.format = format != null ? format : "wav"; }

    public boolean isApplyMastering() { return applyMastering; }
    public void setApplyMastering(boolean applyMastering) { this.applyMastering = applyMastering; }

    public String getMode() { return mode; }
    public void setMode(String mode) { this.mode = mode != null ? mode : "ai_mix"; }

    public String getBitrate() { return bitrate; }
    public void setBitrate(String bitrate) {
        if (bitrate != null && bitrate.trim().startsWith("192")) {
            this.bitrate = "192k";
        } else {
            this.bitrate = "320k";
        }
    }

    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }

    public String getArtist() { return artist; }
    public void setArtist(String artist) { this.artist = artist; }

    public String getAlbum() { return album; }
    public void setAlbum(String album) { this.album = album; }

    public String getGenre() { return genre; }
    public void setGenre(String genre) { this.genre = genre; }

    public Double getTargetLufs() { return targetLufs; }
    public void setTargetLufs(Double targetLufs) { this.targetLufs = targetLufs; }
}
