package com.aimusic.studio.controller;

import com.aimusic.studio.agents.CoachLyricistAgent;
import com.aimusic.studio.agents.LlmContextHolder;
import com.aimusic.studio.audio.AudioWorkerClient;
import com.aimusic.studio.audio.JavaAudioFallbackService;
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
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

@RestController
public class StudioController {

    private final CoachLyricistAgent coachLyricistAgent;
    private final ProjectStateStore store;
    private final AudioWorkerClient audioWorkerClient;
    private final JavaAudioFallbackService audioFallback;
    private final ObjectMapper objectMapper;

    public StudioController(
            CoachLyricistAgent coachLyricistAgent,
            ProjectStateStore store,
            AudioWorkerClient audioWorkerClient,
            JavaAudioFallbackService audioFallback,
            ObjectMapper objectMapper
    ) {
        this.coachLyricistAgent = coachLyricistAgent;
        this.store = store;
        this.audioWorkerClient = audioWorkerClient;
        this.audioFallback = audioFallback;
        this.objectMapper = objectMapper;
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
        LlmContextHolder.set(LlmContextHolder.extractFromRequest(request));
        try {
            return coachLyricistAgent.chatCoach(state, req.getMessage(), req.getHistory());
        } finally {
            LlmContextHolder.clear();
        }
    }

    @PostMapping(value = "/api/studio/overdub-fit-check", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public OverdubFitCheckResponse overdubFitCheck(
            @RequestParam("project_id") String projectId,
            @RequestParam("file") MultipartFile file
    ) throws IOException {
        byte[] audioBytes = file.getBytes();
        if (audioBytes.length == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Empty overdub audio file.");
        }

        ProjectState state = loadProjectState(projectId, null);
        double bpm = state.getAnalysis() != null && state.getAnalysis().getBpm() > 0
                ? state.getAnalysis().getBpm() : 100.0;
        String key = state.getAnalysis() != null ? state.getAnalysis().getDetectedKey() : "C";
        String scale = state.getAnalysis() != null ? state.getAnalysis().getDetectedScale() : "major";
        String filename = file.getOriginalFilename() != null ? file.getOriginalFilename() : "overdub.wav";

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
        Optional<ProjectState> existingOpt = store.getProject(projectId);
        ProjectState state;
        if (req.getProjectState() != null) {
            state = req.getProjectState();
            state.setProjectId(projectId);
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
            byte[] clipBytes = resolveVocalBytes(state, clip.getSource());
            if (clipBytes == null) clipBytes = defaultVocalBytes;
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
        Optional<ProjectState> existingOpt = store.getProject(projectId);
        ProjectState state;
        if (req.getProjectState() != null) {
            state = req.getProjectState();
            state.setProjectId(projectId);
        } else {
            state = existingOpt.orElseThrow(() -> new ResponseStatusException(
                    HttpStatus.NOT_FOUND, "Project '" + projectId + "' not found."));
        }
        existingOpt.ifPresent(prev -> store.pushUndo(projectId, prev));

        JavaAudioFallbackService.AutoMixResult mixResult = audioFallback.autoMixProject(state, store);
        state.setVersion(state.getVersion() + 1);
        ProjectState saved = store.saveProject(state);

        return new AutoMixResponse(projectId, saved, mixResult.mixNotes(), mixResult.summary());
    }

    private String preferredVocalSourceSlot(ProjectState state) {
        AudioAssets assets = state.getAudioAssets();
        if (assets != null) {
            if (assets.getTunedVocalRef() != null && !assets.getTunedVocalRef().isBlank()) return "tuned_vocal_ref";
            if (assets.getDryDenoisedRef() != null && !assets.getDryDenoisedRef().isBlank()) return "dry_denoised_ref";
        }
        return "raw_input_ref";
    }

    private byte[] resolveVocalBytes(ProjectState state, String clipSource) {
        AudioAssets assets = state.getAudioAssets();
        if (clipSource != null && !clipSource.isBlank()) {
            String src = clipSource.trim();
            if ("tuned_vocal_ref".equals(src) && assets != null && assets.getTunedVocalRef() != null) {
                Optional<byte[]> b = store.getAudioBytes(assets.getTunedVocalRef());
                if (b.isPresent()) return b.get();
            } else if ("dry_denoised_ref".equals(src) && assets != null && assets.getDryDenoisedRef() != null) {
                Optional<byte[]> b = store.getAudioBytes(assets.getDryDenoisedRef());
                if (b.isPresent()) return b.get();
            } else if ("raw_input_ref".equals(src) && assets != null && assets.getRawInputRef() != null) {
                Optional<byte[]> b = store.getAudioBytes(assets.getRawInputRef());
                if (b.isPresent()) return b.get();
            } else {
                Optional<byte[]> b = store.getAudioBytes(src);
                if (b.isPresent()) return b.get();
            }
        }
        if (assets != null) {
            for (String ref : new String[]{assets.getTunedVocalRef(), assets.getDryDenoisedRef(), assets.getRawInputRef()}) {
                if (ref != null && !ref.isBlank()) {
                    Optional<byte[]> b = store.getAudioBytes(ref);
                    if (b.isPresent()) return b.get();
                }
            }
        }
        return null;
    }

    private ProjectState loadProjectState(String projectId, ProjectState inlineState) {
        if (inlineState != null) {
            inlineState.setProjectId(projectId);
            return inlineState;
        }
        return store.getProject(projectId).orElseGet(() -> ProjectState.createDefault(projectId, "Untitled Project"));
    }
}
