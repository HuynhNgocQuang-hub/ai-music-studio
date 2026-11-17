package com.aimusic.studio.agents;

import com.aimusic.studio.config.AppProperties;
import com.aimusic.studio.model.ChordEvent;
import com.aimusic.studio.model.MasteringSettings;
import com.aimusic.studio.model.ProjectConfig;
import com.aimusic.studio.model.ProjectLyrics;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.QAStatus;
import com.aimusic.studio.model.TrackState;
import com.aimusic.studio.store.ProjectStateStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BiConsumer;
import java.util.function.Supplier;

@Service
public class AgentOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(AgentOrchestrator.class);
    private static final Set<String> TERMINAL_EVENTS = Set.of("completed", "error");

    public static class JobCancelledException extends RuntimeException {
        public JobCancelledException(String message) { super(message); }
    }

    public static class JobTimeoutException extends RuntimeException {
        public JobTimeoutException(String message) { super(message); }
    }

    public record SseEventRecord(String eventName, Map<String, Object> payload) {}

    public static class JobRuntime {
        private final String jobId;
        private final String projectId;
        private final String jobType;
        private volatile String status = "running";
        private volatile String error;
        private volatile ProjectState resultState;
        private final AtomicBoolean cancelled = new AtomicBoolean(false);
        private final AtomicBoolean timedOut = new AtomicBoolean(false);
        private final List<SseEventRecord> history = new ArrayList<>();
        private final List<SseEmitter> subscribers = new CopyOnWriteArrayList<>();

        public JobRuntime(String jobId, String projectId, String jobType) {
            this.jobId = jobId;
            this.projectId = projectId;
            this.jobType = jobType;
        }

        public String getJobId() { return jobId; }
        public String getProjectId() { return projectId; }
        public String getJobType() { return jobType; }
        public String getStatus() { return status; }
        public void setStatus(String status) { this.status = status; }
        public String getError() { return error; }
        public void setError(String error) { this.error = error; }
        public ProjectState getResultState() { return resultState; }
        public void setResultState(ProjectState resultState) { this.resultState = resultState; }
        public AtomicBoolean getCancelled() { return cancelled; }
        public AtomicBoolean getTimedOut() { return timedOut; }

        public synchronized void publish(String eventName, Map<String, Object> payload, ObjectMapper mapper) {
            SseEventRecord rec = new SseEventRecord(eventName, payload);
            history.add(rec);
            boolean terminal = TERMINAL_EVENTS.contains(eventName);
            for (SseEmitter emitter : subscribers) {
                try {
                    String json = mapper.writeValueAsString(payload);
                    emitter.send(SseEmitter.event().name(eventName).data(json));
                    if (terminal) {
                        emitter.complete();
                    }
                } catch (Exception ex) {
                    subscribers.remove(emitter);
                }
            }
            if (terminal) {
                subscribers.clear();
            }
        }

        public synchronized SseEmitter subscribe(ObjectMapper mapper) {
            SseEmitter emitter = new SseEmitter(120_000L);
            List<SseEventRecord> backlog = new ArrayList<>(history);
            boolean finished = backlog.stream().anyMatch(e -> TERMINAL_EVENTS.contains(e.eventName()))
                    || !"running".equals(status);

            if (!finished) {
                subscribers.add(emitter);
                emitter.onCompletion(() -> subscribers.remove(emitter));
                emitter.onTimeout(() -> subscribers.remove(emitter));
                emitter.onError(ex -> subscribers.remove(emitter));
            }

            try {
                for (SseEventRecord rec : backlog) {
                    String json = mapper.writeValueAsString(rec.payload());
                    emitter.send(SseEmitter.event().name(rec.eventName()).data(json));
                    if (TERMINAL_EVENTS.contains(rec.eventName())) {
                        emitter.complete();
                        return emitter;
                    }
                }
                if (finished) {
                    emitter.complete();
                }
            } catch (Exception ex) {
                subscribers.remove(emitter);
                emitter.completeWithError(ex);
            }
            return emitter;
        }
    }

    private final ComposerAgent composer;
    private final ArrangerAgent arranger;
    private final CoachLyricistAgent coachLyricist;
    private final QaReviewerAgent qa;
    private final ProjectStateStore store;
    private final ObjectMapper objectMapper;
    private final double defaultTimeoutSeconds;
    private final int maxQaIterations;

    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2);
    private final ConcurrentHashMap<String, JobRuntime> jobs = new ConcurrentHashMap<>();

    @Autowired
    public AgentOrchestrator(
            ComposerAgent composer,
            ArrangerAgent arranger,
            CoachLyricistAgent coachLyricist,
            QaReviewerAgent qa,
            ProjectStateStore store,
            ObjectMapper objectMapper,
            AppProperties properties
    ) {
        this.composer = composer;
        this.arranger = arranger;
        this.coachLyricist = coachLyricist;
        this.qa = qa;
        this.store = store;
        this.objectMapper = objectMapper;
        this.defaultTimeoutSeconds = properties.getJobTimeoutSeconds();
        this.maxQaIterations = Math.max(1, properties.getMaxQaIterations());
    }

    public AgentOrchestrator(
            ComposerAgent composer,
            ArrangerAgent arranger,
            CoachLyricistAgent coachLyricist,
            QaReviewerAgent qa,
            ProjectStateStore store,
            ObjectMapper objectMapper,
            double defaultTimeoutSeconds,
            int maxQaIterations
    ) {
        this.composer = composer;
        this.arranger = arranger;
        this.coachLyricist = coachLyricist;
        this.qa = qa;
        this.store = store;
        this.objectMapper = objectMapper;
        this.defaultTimeoutSeconds = defaultTimeoutSeconds;
        this.maxQaIterations = Math.max(1, maxQaIterations);
    }

    // --- Async HTTP Job Launchers ---

    public JobRuntime startGenerateJob(ProjectState initialState, ProjectConfig configOverride,
                                       LlmContextHolder.LlmOverrides llmOverrides) {
        return launchJob(initialState.getProjectId(), "generate", initialState, llmOverrides,
                (job) -> runGenerate(initialState, configOverride, job.getJobId(),
                        (ev, payload) -> job.publish(ev, payload, objectMapper),
                        job.getCancelled(), job.getTimedOut(), defaultTimeoutSeconds));
    }

    public JobRuntime startRegenerateTrackJob(ProjectState initialState, String targetTrack, String instrument,
                                              LlmContextHolder.LlmOverrides llmOverrides) {
        return launchJob(initialState.getProjectId(), "regenerate_track", initialState, llmOverrides,
                (job) -> runRegenerateTrack(initialState, targetTrack, instrument, job.getJobId(),
                        (ev, payload) -> job.publish(ev, payload, objectMapper),
                        job.getCancelled(), job.getTimedOut(), defaultTimeoutSeconds));
    }

    public JobRuntime startRearrangeJob(ProjectState initialState, List<ChordEvent> chords, List<String> lockedTracks,
                                        LlmContextHolder.LlmOverrides llmOverrides) {
        return launchJob(initialState.getProjectId(), "rearrange", initialState, llmOverrides,
                (job) -> runRearrange(initialState, chords, lockedTracks, job.getJobId(),
                        (ev, payload) -> job.publish(ev, payload, objectMapper),
                        job.getCancelled(), job.getTimedOut(), defaultTimeoutSeconds));
    }

    private JobRuntime launchJob(
            String projectId,
            String jobType,
            ProjectState initialState,
            LlmContextHolder.LlmOverrides llmOverrides,
            java.util.function.Function<JobRuntime, ProjectState> work
    ) {
        String jobId = "job_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        JobRuntime job = new JobRuntime(jobId, projectId, jobType);
        jobs.put(jobId, job);
        syncJobToStore(job);

        ProjectState prevCopy = deepCopy(initialState);
        executor.submit(() -> {
            LlmContextHolder.set(llmOverrides);
            try {
                ProjectState updated = work.apply(job);
                job.setResultState(updated);
                job.setStatus("completed");
                if (store != null) {
                    store.pushUndo(projectId, prevCopy);
                    store.saveProject(updated);
                }
            } catch (JobCancelledException ex) {
                job.setStatus("cancelled");
            } catch (JobTimeoutException ex) {
                job.setStatus("timeout");
                job.setError(ex.getMessage());
            } catch (Exception ex) {
                log.error("Job {} failed: {}", jobId, ex.getMessage(), ex);
                job.setStatus("failed");
                job.setError(ex.getMessage());
            } finally {
                LlmContextHolder.clear();
                syncJobToStore(job);
            }
        });

        return job;
    }

    public Optional<JobRuntime> getJob(String jobId) {
        return Optional.ofNullable(jobs.get(jobId));
    }

    public Optional<SseEmitter> subscribeEvents(String jobId) {
        JobRuntime job = jobs.get(jobId);
        if (job == null) return Optional.empty();
        return Optional.of(job.subscribe(objectMapper));
    }

    public boolean cancelJob(String jobId) {
        JobRuntime job = jobs.get(jobId);
        if (job == null) {
            if (store != null) {
                Optional<Map<String, Object>> stored = store.getJob(jobId);
                if (stored.isPresent()) {
                    store.setCancelFlag(jobId, 3600);
                    Map<String, Object> updated = new LinkedHashMap<>(stored.get());
                    updated.put("status", "cancelled");
                    store.setJob(jobId, updated, 3600);
                    return true;
                }
            }
            return false;
        }
        job.getCancelled().set(true);
        if ("running".equals(job.getStatus())) {
            job.setStatus("cancelled");
        }
        if (store != null) {
            store.setCancelFlag(jobId, 3600);
        }
        syncJobToStore(job);
        return true;
    }

    private void syncJobToStore(JobRuntime job) {
        if (store == null) return;
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("job_id", job.getJobId());
        data.put("project_id", job.getProjectId());
        data.put("job_type", job.getJobType());
        data.put("status", job.getStatus());
        if (job.getError() != null) data.put("error", job.getError());
        store.setJob(job.getJobId(), data, 3600);
    }

    // --- Core Multi-Agent Workflows (also directly testable) ---

    public ProjectState runGenerate(
            ProjectState projectState,
            ProjectConfig configOverride,
            String jobId,
            BiConsumer<String, Map<String, Object>> callback,
            AtomicBoolean cancelToken,
            AtomicBoolean timeoutFlag,
            double timeoutSeconds
    ) {
        String jid = jobId != null ? jobId : "job_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        ProjectState state = deepCopy(projectState);
        if (configOverride != null) {
            mergeConfig(state.getConfig(), configOverride);
            if (configOverride.getTitle() != null && !configOverride.getTitle().isBlank()) {
                state.setTitle(configOverride.getTitle());
            }
        }

        return executeWithTimeout(jid, timeoutSeconds, timeoutFlag, cancelToken, callback, () -> {
            long startedNanos = System.nanoTime();
            ProjectState bestState = null;
            QaReviewerAgent.QaReport bestReport = null;
            String qaFeedback = null;
            String nextStage = "composer";

            for (int iteration = 1; iteration <= maxQaIterations; iteration++) {
                checkGuards(jid, cancelToken, timeoutFlag);
                if ("composer".equals(nextStage)) {
                    emit(callback, "agent_step", mapOf(
                            "job_id", jid,
                            "agent", "composer",
                            "step", "compose",
                            "iteration", iteration,
                            "message", "Composer designing harmony & structure",
                            "progress", iteration == 1 ? 20 : 55
                    ));
                    ComposerAgent.ComposeResult compOut = composer.compose(state, qaFeedback);
                    checkGuards(jid, cancelToken, timeoutFlag);
                    state.setSongStructure(compOut.songStructure());
                    state.setMelodyNotes(compOut.melodyNotes());
                    state.getConfig().setUserPrompt(compOut.sanitizedPrompt());
                    if ("auto".equalsIgnoreCase(state.getConfig().getMotifPosition())) {
                        state.getConfig().setMotifPosition(compOut.motifPosition());
                    }
                }

                emit(callback, "agent_step", mapOf(
                        "job_id", jid,
                        "agent", "arranger",
                        "step", "arrange",
                        "iteration", iteration,
                        "message", "Arranger generating MIDI tracks (drums, bass, harmony)",
                        "progress", iteration == 1 ? 50 : 72
                ));
                Map<String, TrackState> tracks = arranger.arrange(
                        state, state.getMelodyNotes(), null, null, null, qaFeedback);
                checkGuards(jid, cancelToken, timeoutFlag);
                state.setTracks(tracks);

                boolean isFullSong = "full_song".equalsIgnoreCase(state.getConfig().getOutputMode());
                boolean includeLyrics = state.getConfig().getIncludeLyrics() == null || state.getConfig().getIncludeLyrics();
                if (iteration == 1 && isFullSong && includeLyrics) {
                    emit(callback, "agent_step", mapOf(
                            "job_id", jid,
                            "agent", "lyricist",
                            "step", "suggest_lyrics",
                            "iteration", iteration,
                            "message", "Lyricist aligning lyrics to sections",
                            "progress", 65
                    ));
                    String lang = state.getConfig().getLanguage() != null ? state.getConfig().getLanguage() : "vi";
                    ProjectLyrics lyrics = coachLyricist.suggestLyrics(state, lang, state.getConfig().getMood(), null);
                    checkGuards(jid, cancelToken, timeoutFlag);
                    state.setLyrics(lyrics);
                }

                emit(callback, "agent_step", mapOf(
                        "job_id", jid,
                        "agent", "qa",
                        "step", "review",
                        "iteration", iteration,
                        "message", String.format("QA reviewing harmony & mastering (iteration %d/%d)", iteration, maxQaIterations),
                        "progress", 82
                ));
                QaReviewerAgent.QaReport report = qa.review(state, null);
                checkGuards(jid, cancelToken, timeoutFlag);

                if (bestReport == null || report.score() >= bestReport.score()) {
                    bestReport = report;
                    bestState = deepCopy(state);
                }

                if (report.approved()) {
                    applyQaAndMastering(state, report, iteration, false);
                    double elapsed = Math.round(((System.nanoTime() - startedNanos) / 1_000_000_000.0) * 1000.0) / 1000.0;
                    emit(callback, "progress", mapOf(
                            "job_id", jid, "progress", 100, "stage", "done", "elapsed_sec", elapsed));
                    emit(callback, "completed", mapOf(
                            "job_id", jid,
                            "project_id", state.getProjectId(),
                            "status", "completed",
                            "fallback_used", false,
                            "qa_status", state.getQaStatus(),
                            "project_state", state
                    ));
                    return state;
                }

                qaFeedback = report.feedback();
                nextStage = report.fixTarget() != null ? report.fixTarget() : "arranger";
                if (iteration < maxQaIterations) {
                    emit(callback, "qa_retry", mapOf(
                            "job_id", jid,
                            "iteration", iteration,
                            "max_iterations", maxQaIterations,
                            "issues", report.issues(),
                            "feedback", report.feedback(),
                            "fix_target", nextStage
                    ));
                }
            }

            // Best-effort Fallback after max QA iterations
            applyQaAndMastering(bestState, bestReport, maxQaIterations, true);
            emit(callback, "fallback_warning", mapOf(
                    "job_id", jid,
                    "message", "QA reached max iterations; returning best-effort arrangement for Studio refinement.",
                    "issues", bestReport.issues(),
                    "iterations", maxQaIterations
            ));
            double elapsed = Math.round(((System.nanoTime() - startedNanos) / 1_000_000_000.0) * 1000.0) / 1000.0;
            emit(callback, "progress", mapOf(
                    "job_id", jid, "progress", 100, "stage", "done_fallback", "elapsed_sec", elapsed));
            emit(callback, "completed", mapOf(
                    "job_id", jid,
                    "project_id", bestState.getProjectId(),
                    "status", "completed",
                    "fallback_used", true,
                    "qa_status", bestState.getQaStatus(),
                    "project_state", bestState
            ));
            return bestState;
        });
    }

    public ProjectState runRegenerateTrack(
            ProjectState projectState,
            String targetTrack,
            String instrument,
            String jobId,
            BiConsumer<String, Map<String, Object>> callback,
            AtomicBoolean cancelToken,
            AtomicBoolean timeoutFlag,
            double timeoutSeconds
    ) {
        String jid = jobId != null ? jobId : "job_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        ProjectState state = deepCopy(projectState);
        String trackKey = targetTrack.toLowerCase(Locale.ROOT).trim();

        return executeWithTimeout(jid, timeoutSeconds, timeoutFlag, cancelToken, callback, () -> {
            long startedNanos = System.nanoTime();
            ProjectState bestState = null;
            QaReviewerAgent.QaReport bestReport = null;
            String qaFeedback = null;

            for (int iteration = 1; iteration <= maxQaIterations; iteration++) {
                checkGuards(jid, cancelToken, timeoutFlag);
                emit(callback, "agent_step", mapOf(
                        "job_id", jid,
                        "agent", "arranger",
                        "step", "regenerate_track",
                        "target_track", trackKey,
                        "iteration", iteration,
                        "message", "Regenerating track '" + trackKey + "'",
                        "progress", 40
                ));
                Map<String, TrackState> tracks = arranger.arrange(
                        state, state.getMelodyNotes(), trackKey, instrument, null, qaFeedback);
                checkGuards(jid, cancelToken, timeoutFlag);
                state.setTracks(tracks);

                emit(callback, "agent_step", mapOf(
                        "job_id", jid,
                        "agent", "qa",
                        "step", "review_track",
                        "target_track", trackKey,
                        "iteration", iteration,
                        "message", "QA verifying regenerated '" + trackKey + "'",
                        "progress", 80
                ));
                QaReviewerAgent.QaReport report = qa.review(state, trackKey);
                checkGuards(jid, cancelToken, timeoutFlag);

                if (bestReport == null || report.score() >= bestReport.score()) {
                    bestReport = report;
                    bestState = deepCopy(state);
                }

                if (report.approved()) {
                    applyQaAndMastering(state, report, iteration, false);
                    double elapsed = Math.round(((System.nanoTime() - startedNanos) / 1_000_000_000.0) * 1000.0) / 1000.0;
                    emit(callback, "progress", mapOf(
                            "job_id", jid, "progress", 100, "stage", "done", "elapsed_sec", elapsed));
                    emit(callback, "completed", mapOf(
                            "job_id", jid,
                            "project_id", state.getProjectId(),
                            "status", "completed",
                            "fallback_used", false,
                            "qa_status", state.getQaStatus(),
                            "project_state", state
                    ));
                    return state;
                }

                qaFeedback = report.feedback();
                if (iteration < maxQaIterations) {
                    emit(callback, "qa_retry", mapOf(
                            "job_id", jid,
                            "iteration", iteration,
                            "max_iterations", maxQaIterations,
                            "issues", report.issues(),
                            "feedback", report.feedback(),
                            "fix_target", "arranger"
                    ));
                }
            }

            applyQaAndMastering(bestState, bestReport, maxQaIterations, true);
            emit(callback, "fallback_warning", mapOf(
                    "job_id", jid,
                    "message", "Track '" + trackKey + "' QA reached max iterations; returning best-effort track.",
                    "issues", bestReport.issues(),
                    "iterations", maxQaIterations
            ));
            emit(callback, "completed", mapOf(
                    "job_id", jid,
                    "project_id", bestState.getProjectId(),
                    "status", "completed",
                    "fallback_used", true,
                    "qa_status", bestState.getQaStatus(),
                    "project_state", bestState
            ));
            return bestState;
        });
    }

    public ProjectState runRearrange(
            ProjectState projectState,
            List<ChordEvent> chords,
            List<String> lockedTracks,
            String jobId,
            BiConsumer<String, Map<String, Object>> callback,
            AtomicBoolean cancelToken,
            AtomicBoolean timeoutFlag,
            double timeoutSeconds
    ) {
        String jid = jobId != null ? jobId : "job_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        ProjectState state = deepCopy(projectState);
        state.getSongStructure().setChords(chords != null ? new ArrayList<>(chords) : new ArrayList<>());
        if (state.getSongStructure().getTotalBars() <= 0 && chords != null && !chords.isEmpty()) {
            int maxBar = chords.stream().mapToInt(ChordEvent::getBar).max().orElse(4);
            state.getSongStructure().setTotalBars(maxBar);
        }

        return executeWithTimeout(jid, timeoutSeconds, timeoutFlag, cancelToken, callback, () -> {
            long startedNanos = System.nanoTime();
            ProjectState bestState = null;
            QaReviewerAgent.QaReport bestReport = null;
            String qaFeedback = null;

            for (int iteration = 1; iteration <= maxQaIterations; iteration++) {
                checkGuards(jid, cancelToken, timeoutFlag);
                emit(callback, "agent_step", mapOf(
                        "job_id", jid,
                        "agent", "arranger",
                        "step", "rearrange",
                        "iteration", iteration,
                        "message", "Re-arranging unlocked tracks to match updated chords",
                        "progress", 45
                ));
                Map<String, TrackState> tracks = arranger.arrange(
                        state, state.getMelodyNotes(), null, null,
                        lockedTracks != null ? lockedTracks : List.of(), qaFeedback);
                checkGuards(jid, cancelToken, timeoutFlag);
                state.setTracks(tracks);

                emit(callback, "agent_step", mapOf(
                        "job_id", jid,
                        "agent", "qa",
                        "step", "review_rearrange",
                        "iteration", iteration,
                        "message", "QA checking re-arranged harmony",
                        "progress", 82
                ));
                QaReviewerAgent.QaReport report = qa.review(state, null);
                checkGuards(jid, cancelToken, timeoutFlag);

                if (bestReport == null || report.score() >= bestReport.score()) {
                    bestReport = report;
                    bestState = deepCopy(state);
                }

                if (report.approved()) {
                    applyQaAndMastering(state, report, iteration, false);
                    double elapsed = Math.round(((System.nanoTime() - startedNanos) / 1_000_000_000.0) * 1000.0) / 1000.0;
                    emit(callback, "progress", mapOf(
                            "job_id", jid, "progress", 100, "stage", "done", "elapsed_sec", elapsed));
                    emit(callback, "completed", mapOf(
                            "job_id", jid,
                            "project_id", state.getProjectId(),
                            "status", "completed",
                            "fallback_used", false,
                            "qa_status", state.getQaStatus(),
                            "project_state", state
                    ));
                    return state;
                }

                qaFeedback = report.feedback();
                if (iteration < maxQaIterations) {
                    emit(callback, "qa_retry", mapOf(
                            "job_id", jid,
                            "iteration", iteration,
                            "max_iterations", maxQaIterations,
                            "issues", report.issues(),
                            "feedback", report.feedback(),
                            "fix_target", "arranger"
                    ));
                }
            }

            applyQaAndMastering(bestState, bestReport, maxQaIterations, true);
            emit(callback, "fallback_warning", mapOf(
                    "job_id", jid,
                    "message", "Rearrange QA reached max iterations; returning best-effort arrangement.",
                    "issues", bestReport.issues(),
                    "iterations", maxQaIterations
            ));
            emit(callback, "completed", mapOf(
                    "job_id", jid,
                    "project_id", bestState.getProjectId(),
                    "status", "completed",
                    "fallback_used", true,
                    "qa_status", bestState.getQaStatus(),
                    "project_state", bestState
            ));
            return bestState;
        });
    }

    private ProjectState executeWithTimeout(
            String jobId,
            double timeoutSeconds,
            AtomicBoolean timeoutFlag,
            AtomicBoolean cancelToken,
            BiConsumer<String, Map<String, Object>> callback,
            Supplier<ProjectState> work
    ) {
        AtomicBoolean effectiveTimeout = timeoutFlag != null ? timeoutFlag : new AtomicBoolean(false);
        Thread workerThread = Thread.currentThread();
        long timeoutMs = Math.max(10L, (long) (timeoutSeconds * 1000.0));
        ScheduledFuture<?> watchdog = scheduler.schedule(() -> {
            effectiveTimeout.set(true);
            workerThread.interrupt();
        }, timeoutMs, TimeUnit.MILLISECONDS);

        try {
            ProjectState result = work.get();
            if (effectiveTimeout.get()) {
                throw new JobTimeoutException("Job " + jobId + " timed out after " + timeoutSeconds + "s");
            }
            return result;
        } catch (JobTimeoutException ex) {
            emit(callback, "error", mapOf(
                    "job_id", jobId,
                    "code", "timeout",
                    "message", "Multi-agent job timed out after " + timeoutSeconds + "s."
            ));
            throw ex;
        } catch (JobCancelledException ex) {
            if (effectiveTimeout.get()) {
                JobTimeoutException tex = new JobTimeoutException("Job " + jobId + " timed out after " + timeoutSeconds + "s");
                emit(callback, "error", mapOf(
                        "job_id", jobId,
                        "code", "timeout",
                        "message", "Multi-agent job timed out after " + timeoutSeconds + "s."
                ));
                throw tex;
            }
            emit(callback, "error", mapOf(
                    "job_id", jobId,
                    "code", "cancelled",
                    "message", "Job cancelled by user."
            ));
            throw ex;
        } catch (Exception ex) {
            if (effectiveTimeout.get()) {
                JobTimeoutException tex = new JobTimeoutException("Job " + jobId + " timed out after " + timeoutSeconds + "s");
                emit(callback, "error", mapOf(
                        "job_id", jobId,
                        "code", "timeout",
                        "message", "Multi-agent job timed out after " + timeoutSeconds + "s."
                ));
                throw tex;
            }
            if (cancelToken != null && cancelToken.get()) {
                JobCancelledException cex = new JobCancelledException("Job cancelled by user.");
                emit(callback, "error", mapOf(
                        "job_id", jobId,
                        "code", "cancelled",
                        "message", "Job cancelled by user."
                ));
                throw cex;
            }
            emit(callback, "error", mapOf(
                    "job_id", jobId,
                    "code", "internal_error",
                    "message", ex.getMessage() != null ? ex.getMessage() : "Internal error"
            ));
            throw ex;
        } finally {
            watchdog.cancel(false);
            Thread.interrupted(); // clear interrupt status if set
        }
    }

    private void checkGuards(String jobId, AtomicBoolean cancelToken, AtomicBoolean timeoutFlag) {
        if (timeoutFlag != null && timeoutFlag.get()) {
            throw new JobTimeoutException("Job " + jobId + " timed out.");
        }
        if (Thread.currentThread().isInterrupted()) {
            throw new JobCancelledException("Job interrupted.");
        }
        if (cancelToken != null && cancelToken.get()) {
            throw new JobCancelledException("Job cancelled by cancel token.");
        }
        if (store != null && store.isCancelled(jobId)) {
            if (cancelToken != null) cancelToken.set(true);
            throw new JobCancelledException("Job cancelled via store flag.");
        }
    }

    private void emit(BiConsumer<String, Map<String, Object>> callback, String eventName, Map<String, Object> payload) {
        if (callback != null) {
            callback.accept(eventName, payload);
        }
    }

    private void applyQaAndMastering(ProjectState state, QaReviewerAgent.QaReport report,
                                     int iterations, boolean fallbackUsed) {
        state.setQaStatus(new QAStatus(report.approved(), iterations, fallbackUsed, report.feedback()));
        MasteringSettings m = state.getMastering() != null ? state.getMastering() : new MasteringSettings();
        m.setAutoMixEnabled(report.autoMixEnabled());
        m.setLimiterCeilingDb(Math.min(report.limiterCeilingDb(), -1.0));
        m.setTargetLufs(report.targetLufs());
        state.setMastering(m);
        state.setVersion(state.getVersion() + 1);
    }

    private void mergeConfig(ProjectConfig target, ProjectConfig src) {
        if (src.getTitle() != null && !src.getTitle().isBlank()) target.setTitle(src.getTitle());
        if (src.getMelodyMode() != null) target.setMelodyMode(src.getMelodyMode());
        if (src.getOutputMode() != null) target.setOutputMode(src.getOutputMode());
        if (src.getMotifPosition() != null) target.setMotifPosition(src.getMotifPosition());
        if (src.getGenre() != null) target.setGenre(src.getGenre());
        if (src.getMood() != null) target.setMood(src.getMood());
        if (src.getUserPrompt() != null) target.setUserPrompt(src.getUserPrompt());
        if (src.getEnableLeadKaraoke() != null) target.setEnableLeadKaraoke(src.getEnableLeadKaraoke());
        if (src.getIncludeLead() != null) target.setIncludeLead(src.getIncludeLead());
        if (src.getIncludeLyrics() != null) target.setIncludeLyrics(src.getIncludeLyrics());
        if (src.getLanguage() != null) target.setLanguage(src.getLanguage());
    }

    private ProjectState deepCopy(ProjectState state) {
        try {
            return objectMapper.readValue(objectMapper.writeValueAsBytes(state), ProjectState.class);
        } catch (Exception e) {
            return state;
        }
    }

    private static Map<String, Object> mapOf(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            m.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return m;
    }
}
