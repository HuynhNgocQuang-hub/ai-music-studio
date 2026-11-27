package com.aimusic.studio.controller;

import com.aimusic.studio.agents.CoachLyricistAgent;
import com.aimusic.studio.agents.LlmContextHolder;
import com.aimusic.studio.audio.AudioValidationException;
import com.aimusic.studio.audio.AudioWorkerClient;
import com.aimusic.studio.audio.JavaAudioFallbackService;
import com.aimusic.studio.cloud.AuthContextHolder;
import com.aimusic.studio.cloud.CloudProjectAccessService;
import com.aimusic.studio.cloud.QuotaRateLimitService;
import com.aimusic.studio.config.AppProperties;
import com.aimusic.studio.model.AudioAssets;
import com.aimusic.studio.model.AudioClip;
import com.aimusic.studio.model.ProjectLyrics;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.TrackState;
import com.aimusic.studio.model.dto.AutoMixRequest;
import com.aimusic.studio.model.dto.AutoMixResponse;
import com.aimusic.studio.model.dto.AutoTrimVocalRequest;
import com.aimusic.studio.model.dto.AutoTrimVocalResponse;
import com.aimusic.studio.model.dto.CoachChatRequest;
import com.aimusic.studio.model.dto.CoachChatResponse;
import com.aimusic.studio.model.dto.LyricsSuggestRequest;
import com.aimusic.studio.model.dto.LyricsSuggestResponse;
import com.aimusic.studio.model.dto.OverdubFitCheckResponse;
import com.aimusic.studio.store.ProjectStateStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@RestController
public class StudioController {

    private static final long MAX_CHAT_AUDIO_BYTES = 10L * 1024L * 1024L;
    private final CoachLyricistAgent coachLyricistAgent;
    private final ProjectStateStore store;
    private final AudioWorkerClient audioWorkerClient;
    private final JavaAudioFallbackService audioFallback;
    private final ObjectMapper objectMapper;
    private final CloudProjectAccessService projectAccess;
    private final QuotaRateLimitService quotaService;
    private final ExecutorService chatStreamExecutor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "coach-sse-worker");
        t.setDaemon(true);
        return t;
    });

    public StudioController(
            CoachLyricistAgent coachLyricistAgent,
            ProjectStateStore store,
            AudioWorkerClient audioWorkerClient,
            JavaAudioFallbackService audioFallback,
            ObjectMapper objectMapper
    ) {
        this(coachLyricistAgent, store, audioWorkerClient, audioFallback, objectMapper, null, null);
    }

    @Autowired
    public StudioController(
            CoachLyricistAgent coachLyricistAgent,
            ProjectStateStore store,
            AudioWorkerClient audioWorkerClient,
            JavaAudioFallbackService audioFallback,
            ObjectMapper objectMapper,
            @Autowired(required = false) CloudProjectAccessService projectAccess,
            @Autowired(required = false) QuotaRateLimitService quotaService
    ) {
        this.coachLyricistAgent = coachLyricistAgent;
        this.store = store;
        this.audioWorkerClient = audioWorkerClient;
        this.audioFallback = audioFallback;
        this.objectMapper = objectMapper;
        this.projectAccess = projectAccess != null ? projectAccess
                : new CloudProjectAccessService(store, null, objectMapper);
        this.quotaService = quotaService;
    }

    @PostMapping("/api/lyrics/suggest")
    public LyricsSuggestResponse suggestLyrics(@RequestBody LyricsSuggestRequest req, HttpServletRequest request) {
        if (req.getProjectId() == null || req.getProjectId().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "project_id is required");
        }
        ProjectState state = loadProjectState(req.getProjectId(), req.getProjectState());
        LlmContextHolder.set(LlmContextHolder.extractFromRequest(request));
        try {
            ProjectLyrics lyrics = coachLyricistAgent.suggestLyrics(
                    state, req.getLanguage(), req.getTopic(), req.getSection());
            return new LyricsSuggestResponse(lyrics.getLanguage(), lyrics.getLines());
        } finally {
            LlmContextHolder.clear();
        }
    }

    @PostMapping("/api/coach/chat")
    public CoachChatResponse chatWithCoach(@RequestBody CoachChatRequest req, HttpServletRequest request) {
        if (req.getProjectId() == null || req.getProjectId().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "project_id is required");
        }
        if (req.getMessage() == null || req.getMessage().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "message is required");
        }
        ProjectState state = loadProjectState(req.getProjectId(), req.getProjectState());
        byte[] attachedAudio = resolveProjectAudioIfRequested(state, req.getContext());
        LlmContextHolder.set(LlmContextHolder.extractFromRequest(request));
        try {
            return coachLyricistAgent.chatCoach(
                    state, req.getMessage(), req.getHistory(), req.getMode(),
                    req.getRoute(), req.getContext(), attachedAudio, "audio/wav");
        } finally {
            LlmContextHolder.clear();
        }
    }

    @PostMapping(value = "/api/coach/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter chatWithCoachStream(@RequestBody CoachChatRequest req, HttpServletRequest request) {
        if (req.getProjectId() == null || req.getProjectId().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "project_id is required");
        }
        if (req.getMessage() == null || req.getMessage().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "message is required");
        }
        ProjectState state = loadProjectState(req.getProjectId(), req.getProjectState());
        byte[] attachedAudio = resolveProjectAudioIfRequested(state, req.getContext());
        LlmContextHolder.LlmOverrides llmOverrides = LlmContextHolder.extractFromRequest(request);

        SseEmitter emitter = new SseEmitter(60_000L);
        chatStreamExecutor.execute(() -> {
            LlmContextHolder.set(llmOverrides);
            try {
                CoachChatResponse full = coachLyricistAgent.chatCoach(
                        state, req.getMessage(), req.getHistory(), req.getMode(),
                        req.getRoute(), req.getContext(), attachedAudio, "audio/wav");

                String reply = full.getReply() != null ? full.getReply() : "";
                String[] tokens = reply.split("(?<=\\s)");
                StringBuilder batch = new StringBuilder();
                for (int i = 0; i < tokens.length; i++) {
                    batch.append(tokens[i]);
                    if ((i + 1) % 3 == 0 || i == tokens.length - 1) {
                        emitter.send(SseEmitter.event().name("chunk")
                                .data(Map.of("text", batch.toString())));
                        batch.setLength(0);
                    }
                }
                emitter.send(SseEmitter.event().name("actions")
                        .data(Map.of(
                                "provider", full.getProvider() != null ? full.getProvider() : "mock",
                                "suggested_actions", full.getSuggestedActions())));
                emitter.send(SseEmitter.event().name("done").data(full));
                emitter.complete();
            } catch (Exception ex) {
                try {
                    emitter.send(SseEmitter.event().name("error")
                            .data(Map.of("message", ex.getMessage() != null ? ex.getMessage() : "Chatbot stream error.")));
                } catch (IOException ignored) {}
                emitter.complete();
            } finally {
                LlmContextHolder.clear();
            }
        });
        return emitter;
    }

    @PostMapping(value = "/api/coach/chat/audio", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public CoachChatResponse chatWithCoachAudio(
            @RequestParam("project_id") String projectId,
            @RequestParam("message") String message,
            @RequestParam(value = "mode", defaultValue = "producer") String mode,
            @RequestParam(value = "route", defaultValue = "") String route,
            @RequestParam(value = "file", required = false) MultipartFile file,
            HttpServletRequest request
    ) throws IOException {
        if (projectId == null || projectId.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "project_id is required");
        }
        if (message == null || message.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "message is required");
        }
        byte[] audioBytes = null;
        String audioMime = "audio/wav";
        if (file != null && !file.isEmpty()) {
            if (file.getSize() > MAX_CHAT_AUDIO_BYTES) {
                throw new AudioValidationException("Chat audio exceeds maximum 10 MB.", HttpStatus.PAYLOAD_TOO_LARGE);
            }
            audioBytes = file.getBytes();
            if (file.getContentType() != null && !file.getContentType().isBlank()) {
                audioMime = file.getContentType();
            }
        }
        ProjectState state = loadProjectState(projectId, null);
        if (audioBytes == null) {
            audioBytes = resolveVocalBytes(state, null);
        }
        LlmContextHolder.set(LlmContextHolder.extractFromRequest(request));
        try {
            return coachLyricistAgent.chatCoach(
                    state, message, java.util.List.of(), mode, route, null, audioBytes, audioMime);
        } finally {
            LlmContextHolder.clear();
        }
    }

    private byte[] resolveProjectAudioIfRequested(ProjectState state, Map<String, Object> context) {
        if (context == null || context.isEmpty()) return null;
        Object attach = context.get("attach_project_audio");
        if (Boolean.TRUE.equals(attach) || "true".equalsIgnoreCase(String.valueOf(attach))) {
            return resolveVocalBytes(state, null);
        }
        return null;
    }

    private static final long MAX_OVERDUB_UPLOAD_BYTES = 50L * 1024L * 1024L;

    @PostMapping(value = "/api/studio/overdub-fit-check", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public OverdubFitCheckResponse overdubFitCheck(
            @RequestParam("project_id") String projectId,
            @RequestParam("file") MultipartFile file
    ) throws IOException {
        if (projectId == null || projectId.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "project_id is required");
        }
        String filename = (file.getOriginalFilename() != null && !file.getOriginalFilename().isBlank())
                ? file.getOriginalFilename() : "overdub.wav";
        int dot = filename.lastIndexOf('.');
        String ext = (dot >= 0 && dot < filename.length() - 1)
                ? filename.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        if (!AppProperties.ALLOWED_AUDIO_EXTENSIONS.contains(ext)) {
            throw new AudioValidationException(
                    "Unsupported audio format '." + ext + "'. Allowed: .wav, .mp3, .m4a, .ogg, .flac",
                    HttpStatus.BAD_REQUEST);
        }
        if (file.getSize() <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Empty overdub audio file.");
        }
        if (file.getSize() > MAX_OVERDUB_UPLOAD_BYTES) {
            throw new AudioValidationException("Overdub audio exceeds maximum 50 MB.", HttpStatus.PAYLOAD_TOO_LARGE);
        }
        byte[] audioBytes = file.getBytes();
        if (audioBytes.length == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Empty overdub audio file.");
        }

        ProjectState state = loadProjectState(projectId, null);
        projectAccess.requireWriteAccess(state, "Cannot upload overdub audio to another creator's project.");
        if (quotaService != null) {
            quotaService.addStorageBytes(AuthContextHolder.getActorQuotaKey(), audioBytes.length);
        }
        double bpm = state.getAnalysis() != null && state.getAnalysis().getBpm() > 0
                ? state.getAnalysis().getBpm() : 100.0;
        String key = state.getAnalysis() != null ? state.getAnalysis().getDetectedKey() : "C";
        String scale = state.getAnalysis() != null ? state.getAnalysis().getDetectedScale() : "major";

        Optional<Map<String, Object>> workerResp = audioWorkerClient.overdubFitCheck(
                audioBytes, filename, bpm, key, scale);
        if (workerResp.isPresent() && workerResp.get().containsKey("timing_offset_ms")) {
            return objectMapper.convertValue(workerResp.get(), OverdubFitCheckResponse.class);
        }
        return audioFallback.overdubFitCheck(audioBytes, bpm, key, scale);
    }

    @PostMapping("/api/studio/auto-trim-vocal")
    public AutoTrimVocalResponse autoTrimVocal(@RequestBody AutoTrimVocalRequest req) {
        if (req.getProjectId() == null || req.getProjectId().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "project_id is required");
        }
        String projectId = req.getProjectId();
        Optional<ProjectState> existingOpt = projectAccess.findOrRehydrate(projectId);
        existingOpt.ifPresent(prev -> projectAccess.requireWriteAccess(prev,
                "Cannot modify another creator's project."));
        ProjectState state;
        if (req.getProjectState() != null) {
            state = req.getProjectState();
            state.setProjectId(projectId);
            projectAccess.bindOwnerOnSave(state, existingOpt);
        } else {
            state = existingOpt.orElseThrow(() -> new ResponseStatusException(
                    HttpStatus.NOT_FOUND, "Project '" + projectId + "' not found."));
        }
        existingOpt.ifPresent(prev -> store.pushUndo(projectId, prev));

        double bpm = state.getAnalysis() != null && state.getAnalysis().getBpm() > 0
                ? state.getAnalysis().getBpm() : 120.0;

        byte[] defaultVocalBytes = resolveVocalBytes(state, null);
        if (defaultVocalBytes == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Project has no vocal audio to auto-trim.");
        }

        TrackState vocalTrack = state.getTracks().computeIfAbsent("vocal", k -> TrackState.audioTrack(0.95, 0.0));
        if (vocalTrack.getClips() == null || vocalTrack.getClips().isEmpty()) {
            String prefSource = preferredVocalSourceSlot(state);
            AudioClip defaultClip = new AudioClip("clip_vocal_1", prefSource, 1.0, 0.0);
            vocalTrack.getClips().add(defaultClip);
        }

        JavaAudioFallbackService.AutoTrimAnalysis primaryAnalysis = null;
        int trimmedCount = 0;
        for (AudioClip clip : vocalTrack.getClips()) {
            if (clip == null) continue;
            byte[] clipBytes = resolveClipOwnBytes(state, clip, defaultVocalBytes);
            if (clipBytes == null) continue;
            JavaAudioFallbackService.AutoTrimAnalysis analysis = audioFallback.analyzeVocalTrimAndBeatOffset(clipBytes, bpm);
            clip.setTrimStartSec(analysis.trimStartSec());
            clip.setTrimEndSec(analysis.trimEndSec());
            clip.setOffsetMs(analysis.offsetMs());
            if (clip.getFadeInMs() <= 0.0) clip.setFadeInMs(15.0);
            if (clip.getFadeOutMs() <= 0.0) clip.setFadeOutMs(15.0);
            if (primaryAnalysis == null) primaryAnalysis = analysis;
            trimmedCount++;
        }

        state.setVersion(state.getVersion() + 1);
        ProjectState saved = store.saveProject(state);
        projectAccess.mirrorToCloud(saved, null);

        double trimStart = primaryAnalysis != null ? primaryAnalysis.trimStartSec() : 0.0;
        double trimEnd = primaryAnalysis != null ? primaryAnalysis.trimEndSec() : 0.0;
        double offsetMs = primaryAnalysis != null ? primaryAnalysis.offsetMs() : 0.0;
        String summary = (primaryAnalysis != null ? primaryAnalysis.summary() : "Auto-trimmed vocal clips.")
                + " Updated " + trimmedCount + " vocal clip(s).";

        return new AutoTrimVocalResponse(projectId, saved, summary, trimStart, trimEnd, offsetMs, trimmedCount);
    }

    @PostMapping("/api/studio/auto-mix")
    public AutoMixResponse autoMix(@RequestBody AutoMixRequest req) {
        if (req.getProjectId() == null || req.getProjectId().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "project_id is required");
        }
        String projectId = req.getProjectId();
        Optional<ProjectState> existingOpt = projectAccess.findOrRehydrate(projectId);
        existingOpt.ifPresent(prev -> projectAccess.requireWriteAccess(prev,
                "Cannot modify another creator's project."));
        ProjectState state;
        if (req.getProjectState() != null) {
            state = req.getProjectState();
            state.setProjectId(projectId);
            projectAccess.bindOwnerOnSave(state, existingOpt);
        } else {
            state = existingOpt.orElseThrow(() -> new ResponseStatusException(
                    HttpStatus.NOT_FOUND, "Project '" + projectId + "' not found."));
        }
        existingOpt.ifPresent(prev -> store.pushUndo(projectId, prev));

        JavaAudioFallbackService.AutoMixResult mixResult = audioFallback.autoMixProject(state, store);
        state.setVersion(state.getVersion() + 1);
        ProjectState saved = store.saveProject(state);
        projectAccess.mirrorToCloud(saved, null);

        return new AutoMixResponse(projectId, saved, mixResult.mixNotes(), mixResult.summary());
    }

    @PostMapping("/api/studio/separate-stems")
    public Map<String, Object> separateStems(@RequestBody Map<String, Object> req) {
        Object pidObj = req != null ? req.get("project_id") : null;
        if (pidObj == null || pidObj.toString().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "project_id is required");
        }
        String projectId = pidObj.toString().trim();
        Optional<ProjectState> existingOpt = projectAccess.findOrRehydrate(projectId);
        ProjectState state = existingOpt.orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "Project '" + projectId + "' not found."));
        projectAccess.requireWriteAccess(state, "Cannot modify another creator's project.");
        existingOpt.ifPresent(prev -> store.pushUndo(projectId, prev));

        String explicitRef = req.get("source_ref") != null ? req.get("source_ref").toString().trim() : null;
        byte[] sourceBytes = resolveVocalBytes(state, explicitRef);
        if (sourceBytes == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Project has no audio asset to separate stems.");
        }

        byte[] vocalWav;
        byte[] beatWav;
        String method;
        double durationSec = 0.0;
        Optional<Map<String, Object>> workerResp = audioWorkerClient.separateStems(sourceBytes, projectId + "_input.wav");
        if (workerResp.isPresent()
                && workerResp.get().get("vocal_wav_base64") instanceof String vB64
                && workerResp.get().get("instrumental_wav_base64") instanceof String bB64) {
            vocalWav = java.util.Base64.getDecoder().decode(vB64);
            beatWav = java.util.Base64.getDecoder().decode(bB64);
            method = String.valueOf(workerResp.get().getOrDefault("method", "worker_hpss"));
            if (workerResp.get().get("duration_sec") instanceof Number num) {
                durationSec = num.doubleValue();
            }
        } else {
            JavaAudioFallbackService.StemSeparationResult fb = audioFallback.separateStemsFallback(sourceBytes);
            vocalWav = fb.vocalWav();
            beatWav = fb.beatWav();
            method = fb.method();
            durationSec = fb.durationSec();
        }

        String vocalRef = "mem://stems/" + projectId + "_vocal.wav";
        String beatRef = "mem://stems/" + projectId + "_beat.wav";
        store.saveAudioBytes(vocalRef, vocalWav);
        store.saveAudioBytes(beatRef, beatWav);
        if (quotaService != null) {
            quotaService.addStorageBytes(AuthContextHolder.getActorQuotaKey(),
                    (long) vocalWav.length + beatWav.length);
        }

        TrackState vocalTrack = state.getTracks().computeIfAbsent("vocal", k -> TrackState.audioTrack(0.95, 0.0));
        vocalTrack.setClips(new java.util.ArrayList<>(java.util.List.of(
                new AudioClip("clip_stem_vocal", vocalRef, 1.0, 0.0)
        )));
        TrackState textureTrack = state.getTracks().computeIfAbsent("texture", k -> TrackState.audioTrack(0.85, 0.0));
        textureTrack.setClips(new java.util.ArrayList<>(java.util.List.of(
                new AudioClip("clip_stem_beat", beatRef, 1.0, 0.0)
        )));

        state.setVersion(state.getVersion() + 1);
        ProjectState saved = store.saveProject(state);
        projectAccess.mirrorToCloud(saved, null);

        Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("project_id", projectId);
        out.put("vocal_ref", vocalRef);
        out.put("beat_ref", beatRef);
        out.put("method", method);
        out.put("duration_sec", durationSec);
        out.put("summary", "Đã tách 2 Stems (Vocal + Beat/Texture) bằng " + method + ".");
        out.put("project_state", saved);
        return out;
    }

    private String preferredVocalSourceSlot(ProjectState state) {
        AudioAssets assets = state.getAudioAssets();
        boolean autotuneEnabled = state.getAutotuneSettings() == null || state.getAutotuneSettings().isEnabled();
        if (assets != null) {
            if (autotuneEnabled && assets.getTunedVocalRef() != null && !assets.getTunedVocalRef().isBlank()) {
                return "tuned_vocal_ref";
            }
            if (assets.getDryDenoisedRef() != null && !assets.getDryDenoisedRef().isBlank()) return "dry_denoised_ref";
        }
        return "raw_input_ref";
    }

    private byte[] resolveClipOwnBytes(ProjectState state, AudioClip clip, byte[] defaultVocalBytes) {
        String src = clip.getSource() != null ? clip.getSource().trim() : "";
        boolean isStandardVocalSlot = src.isEmpty()
                || "raw_input_ref".equals(src)
                || "dry_denoised_ref".equals(src)
                || "tuned_vocal_ref".equals(src);
        boolean isOverdubClip = clip.getId() != null && clip.getId().startsWith("clip_overdub_");
        if (isStandardVocalSlot) {
            if (isOverdubClip) {
                return null;
            }
            byte[] resolved = resolveVocalBytes(state, src);
            return resolved != null ? resolved : defaultVocalBytes;
        }
        // Custom clip refs (e.g. mem://clips/... or idb://overdub/...) must resolve only their own stored bytes.
        return store.getAudioBytes(src).orElse(null);
    }

    private byte[] resolveVocalBytes(ProjectState state, String clipSource) {
        AudioAssets assets = state.getAudioAssets();
        boolean autotuneEnabled = state.getAutotuneSettings() == null || state.getAutotuneSettings().isEnabled();
        if (clipSource != null && !clipSource.isBlank()) {
            String src = clipSource.trim();
            if ("tuned_vocal_ref".equals(src) && assets != null && autotuneEnabled && assets.getTunedVocalRef() != null) {
                Optional<byte[]> b = store.getAudioBytes(assets.getTunedVocalRef());
                if (b.isPresent()) return b.get();
            } else if ("dry_denoised_ref".equals(src) && assets != null && assets.getDryDenoisedRef() != null) {
                Optional<byte[]> b = store.getAudioBytes(assets.getDryDenoisedRef());
                if (b.isPresent()) return b.get();
            } else if ("raw_input_ref".equals(src) && assets != null && assets.getRawInputRef() != null) {
                Optional<byte[]> b = store.getAudioBytes(assets.getRawInputRef());
                if (b.isPresent()) return b.get();
            } else if (!"tuned_vocal_ref".equals(src)) {
                Optional<byte[]> b = store.getAudioBytes(src);
                if (b.isPresent()) return b.get();
            }
        }
        if (assets != null) {
            String tuned = autotuneEnabled ? assets.getTunedVocalRef() : null;
            for (String ref : new String[]{tuned, assets.getDryDenoisedRef(), assets.getRawInputRef()}) {
                if (ref != null && !ref.isBlank()) {
                    Optional<byte[]> b = store.getAudioBytes(ref);
                    if (b.isPresent()) return b.get();
                }
            }
        }
        return null;
    }

    private ProjectState loadProjectState(String projectId, ProjectState inlineState) {
        Optional<ProjectState> existing = projectAccess.findOrRehydrate(projectId);
        existing.ifPresent(prev -> projectAccess.requireReadAccess(prev,
                "Cannot inspect or process another creator's private cloud project."));
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
