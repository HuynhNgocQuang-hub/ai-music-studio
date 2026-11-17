package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class JobStartResponse {

    @JsonProperty("job_id")
    private String jobId;

    @JsonProperty("project_id")
    private String projectId;

    @JsonProperty("status")
    private String status;

    @JsonProperty("target_track")
    private String targetTrack;

    public JobStartResponse() {}

    public JobStartResponse(String jobId, String projectId, String status) {
        this(jobId, projectId, status, null);
    }

    public JobStartResponse(String jobId, String projectId, String status, String targetTrack) {
        this.jobId = jobId;
        this.projectId = projectId;
        this.status = status;
        this.targetTrack = targetTrack;
    }

    public String getJobId() { return jobId; }
    public void setJobId(String jobId) { this.jobId = jobId; }

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getTargetTrack() { return targetTrack; }
    public void setTargetTrack(String targetTrack) { this.targetTrack = targetTrack; }
}
