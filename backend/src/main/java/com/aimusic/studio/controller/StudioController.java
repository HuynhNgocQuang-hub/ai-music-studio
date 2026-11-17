package com.aimusic.studio.controller;

import com.aimusic.studio.agents.CoachLyricistAgent;
import com.aimusic.studio.agents.LlmContextHolder;
import com.aimusic.studio.audio.AudioWorkerClient;
import com.aimusic.studio.audio.JavaAudioFallbackService;
import com.aimusic.studio.model.ProjectLyrics;
import com.aimusic.studio.model.ProjectState;
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

    private ProjectState loadProjectState(String projectId, ProjectState inlineState) {
        if (inlineState != null) {
            inlineState.setProjectId(projectId);
            return inlineState;
        }
        return store.getProject(projectId).orElseGet(() -> ProjectState.createDefault(projectId, "Untitled Project"));
    }
}
