package com.aimusic.studio.controller;

import com.aimusic.studio.agents.AgentOrchestrator;
import com.aimusic.studio.agents.LlmContextHolder;
import com.aimusic.studio.cloud.AuthContextHolder;
import com.aimusic.studio.cloud.CloudProjectAccessService;
import com.aimusic.studio.cloud.QuotaRateLimitService;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.dto.JobGenerateRequest;
import com.aimusic.studio.model.dto.JobRearrangeRequest;
import com.aimusic.studio.model.dto.JobRegenerateTrackRequest;
import com.aimusic.studio.model.dto.JobStartResponse;
import com.aimusic.studio.store.ProjectStateStore;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

@RestController
@RequestMapping("/api/jobs")
public class JobsController {

    private static final Set<String> VALID_MIDI_TRACKS = Set.of("drums", "bass", "harmony", "lead");

    private final AgentOrchestrator orchestrator;
    private final ProjectStateStore store;
    private final QuotaRateLimitService quotaService;
    private final CloudProjectAccessService projectAccess;

    public JobsController(
            AgentOrchestrator orchestrator,
            ProjectStateStore store,
            @Autowired(required = false) QuotaRateLimitService quotaService
    ) {
        this(orchestrator, store, quotaService, null);
    }

    @Autowired
    public JobsController(
            AgentOrchestrator orchestrator,
            ProjectStateStore store,
            @Autowired(required = false) QuotaRateLimitService quotaService,
            @Autowired(required = false) CloudProjectAccessService projectAccess
    ) {
        this.orchestrator = orchestrator;
        this.store = store;
        this.quotaService = quotaService;
        this.projectAccess = projectAccess != null ? projectAccess
                : new CloudProjectAccessService(store, null, null);
    }

    @PostMapping("/generate")
    public JobStartResponse startGenerateJob(@RequestBody JobGenerateRequest req, HttpServletRequest request) {
        if (req.getProjectId() == null || req.getProjectId().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "project_id is required");
        }
        ProjectState state = loadProjectState(req.getProjectId(), req.getProjectState());
        consumeGenerateQuotaIfEnabled();
        LlmContextHolder.LlmOverrides overrides = LlmContextHolder.extractFromRequest(request);
        AgentOrchestrator.JobRuntime job = orchestrator.startGenerateJob(state, req.getConfig(), overrides);
        return new JobStartResponse(job.getJobId(), job.getProjectId(), job.getStatus());
    }

    @PostMapping("/regenerate-track")
    public JobStartResponse startRegenerateTrackJob(@RequestBody JobRegenerateTrackRequest req, HttpServletRequest request) {
        if (req.getProjectId() == null || req.getProjectId().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "project_id is required");
        }
        String target = req.getTargetTrack() != null ? req.getTargetTrack().trim().toLowerCase(Locale.ROOT) : "";
        if (!VALID_MIDI_TRACKS.contains(target)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "target_track must be one of [bass, drums, harmony, lead]");
        }
        ProjectState state = loadProjectState(req.getProjectId(), req.getProjectState());
        consumeGenerateQuotaIfEnabled();
        LlmContextHolder.LlmOverrides overrides = LlmContextHolder.extractFromRequest(request);
        AgentOrchestrator.JobRuntime job = orchestrator.startRegenerateTrackJob(state, target, req.getInstrument(), overrides);
        return new JobStartResponse(job.getJobId(), job.getProjectId(), job.getStatus(), target);
    }

    @PostMapping("/rearrange")
    public JobStartResponse startRearrangeJob(@RequestBody JobRearrangeRequest req, HttpServletRequest request) {
        if (req.getProjectId() == null || req.getProjectId().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "project_id is required");
        }
        ProjectState state = loadProjectState(req.getProjectId(), req.getProjectState());
        consumeGenerateQuotaIfEnabled();
        LlmContextHolder.LlmOverrides overrides = LlmContextHolder.extractFromRequest(request);
        AgentOrchestrator.JobRuntime job = orchestrator.startRearrangeJob(
                state, req.getChords(), req.getSections(), req.getTotalBars(), req.getLockedTracks(), overrides);
        return new JobStartResponse(job.getJobId(), job.getProjectId(), job.getStatus());
    }

    private void consumeGenerateQuotaIfEnabled() {
        if (quotaService != null) {
            quotaService.consumeGenerateQuota(AuthContextHolder.get(), AuthContextHolder.getActorQuotaKey());
        }
    }

    @GetMapping(value = "/{jobId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamJobEvents(@PathVariable("jobId") String jobId, HttpServletResponse response) {
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("X-Accel-Buffering", "no");
        return orchestrator.subscribeEvents(jobId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Job '" + jobId + "' not found"));
    }

    @PostMapping("/{jobId}/cancel")
    public Map<String, String> cancelJob(@PathVariable("jobId") String jobId) {
        boolean found = orchestrator.cancelJob(jobId);
        if (!found) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Job '" + jobId + "' not found");
        }
        return Map.of("job_id", jobId, "status", "cancelled");
    }

    private ProjectState loadProjectState(String projectId, ProjectState inlineState) {
        Optional<ProjectState> existing = projectAccess.findOrRehydrate(projectId);
        existing.ifPresent(prev -> projectAccess.requireWriteAccess(prev,
                "You do not have permission to generate or modify another creator's project."));
        if (inlineState != null) {
            inlineState.setProjectId(projectId);
            projectAccess.bindOwnerOnSave(inlineState, existing);
            return inlineState;
        }
        return existing.orElseGet(() -> {
            ProjectState created = ProjectState.createDefault(projectId, "Untitled Project");
            projectAccess.bindOwnerOnSave(created, Optional.empty());
            return created;
        });
    }
}
