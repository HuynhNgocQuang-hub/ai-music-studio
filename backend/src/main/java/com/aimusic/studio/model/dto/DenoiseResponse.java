package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.List;

public class DenoiseResponse {

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("raw_input_ref")
    private String rawInputRef;

    @JsonProperty("dry_denoised_ref")
    private String dryDenoisedRef;

    @JsonProperty("trimmed_start_sec")
    private double trimmedStartSec;

    @JsonProperty("trimmed_end_sec")
    private double trimmedEndSec;

    @JsonProperty("duration_sec")
    private double durationSec;

    @JsonProperty("snr_db_estimate")
    private double snrDbEstimate;

    @JsonProperty("warnings")
    private List<String> warnings = new ArrayList<>();

    public DenoiseResponse() {}

    public DenoiseResponse(String projectId, String rawInputRef, String dryDenoisedRef,
                           double trimmedStartSec, double trimmedEndSec, double durationSec,
                           double snrDbEstimate, List<String> warnings) {
        this.projectId = projectId;
        this.rawInputRef = rawInputRef;
        this.dryDenoisedRef = dryDenoisedRef;
        this.trimmedStartSec = trimmedStartSec;
        this.trimmedEndSec = trimmedEndSec;
        this.durationSec = durationSec;
        this.snrDbEstimate = snrDbEstimate;
        this.warnings = warnings != null ? warnings : new ArrayList<>();
    }

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public String getRawInputRef() { return rawInputRef; }
    public void setRawInputRef(String rawInputRef) { this.rawInputRef = rawInputRef; }

    public String getDryDenoisedRef() { return dryDenoisedRef; }
    public void setDryDenoisedRef(String dryDenoisedRef) { this.dryDenoisedRef = dryDenoisedRef; }

    public double getTrimmedStartSec() { return trimmedStartSec; }
    public void setTrimmedStartSec(double trimmedStartSec) { this.trimmedStartSec = trimmedStartSec; }

    public double getTrimmedEndSec() { return trimmedEndSec; }
    public void setTrimmedEndSec(double trimmedEndSec) { this.trimmedEndSec = trimmedEndSec; }

    public double getDurationSec() { return durationSec; }
    public void setDurationSec(double durationSec) { this.durationSec = durationSec; }

    public double getSnrDbEstimate() { return snrDbEstimate; }
    public void setSnrDbEstimate(double snrDbEstimate) { this.snrDbEstimate = snrDbEstimate; }

    public List<String> getWarnings() { return warnings; }
    public void setWarnings(List<String> warnings) { this.warnings = warnings; }
}
