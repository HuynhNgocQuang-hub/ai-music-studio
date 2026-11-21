package com.aimusic.studio.controller;

import com.aimusic.studio.audio.AudioWorkerClient;
import com.aimusic.studio.audio.JavaAudioFallbackService;
import com.aimusic.studio.config.AppProperties;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.TrackState;
import com.aimusic.studio.model.dto.ExportAudioRequest;
import com.aimusic.studio.model.dto.PaginatedProjectsResponse;
import com.aimusic.studio.model.dto.ProjectSummary;
import com.aimusic.studio.store.ProjectStateStore;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

@RestController
@RequestMapping("/api/projects")
public class ProjectsController {

    private final ProjectStateStore store;
    private final AudioWorkerClient audioWorkerClient;
    private final JavaAudioFallbackService audioFallback;
    private final AppProperties properties;

    public ProjectsController(
            ProjectStateStore store,
            AudioWorkerClient audioWorkerClient,
            JavaAudioFallbackService audioFallback,
            AppProperties properties
    ) {
        this.store = store;
        this.audioWorkerClient = audioWorkerClient;
        this.audioFallback = audioFallback;
        this.properties = properties;
    }

    @GetMapping
    public PaginatedProjectsResponse listProjects(
            @RequestParam(value = "page", defaultValue = "1") int page,
            @RequestParam(value = "limit", defaultValue = "12") int limit,
            @RequestParam(value = "search", defaultValue = "") String search,
            @RequestParam(value = "genre", defaultValue = "") String genre,
            @RequestParam(value = "key", defaultValue = "") String key
    ) {
        int safePage = Math.max(1, page);
        int safeLimit = Math.max(1, Math.min(limit, 100));
        ProjectStateStore.PagedProjects paged = store.listProjects(safePage, safeLimit, search, genre, key);
        int total = paged.total();
        int totalPages = total > 0 ? Math.max(1, (int) Math.ceil((double) total / safeLimit)) : 1;
        List<ProjectSummary> items = paged.items().stream().map(this::toSummary).toList();
        return new PaginatedProjectsResponse(items, total, Math.min(safePage, totalPages), safeLimit, totalPages);
    }

    @GetMapping("/{projectId}")
    public ProjectState getProject(@PathVariable("projectId") String projectId) {
        return store.getProject(projectId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Project '" + projectId + "' not found."));
    }

    @PutMapping("/{projectId}/sync")
    public ProjectState syncProject(@PathVariable("projectId") String projectId, @RequestBody ProjectState payload) {
        Optional<ProjectState> existing = store.getProject(projectId);
        existing.ifPresent(prev -> store.pushUndo(projectId, prev));

        payload.setProjectId(projectId);
        if (payload.getConfig() != null && (payload.getConfig().getTitle() == null || payload.getConfig().getTitle().isBlank())
                && payload.getTitle() != null && !payload.getTitle().isBlank()) {
            payload.getConfig().setTitle(payload.getTitle());
        }
        int nextVersion = existing.map(p -> p.getVersion() + 1).orElse(Math.max(1, payload.getVersion()));
        payload.setVersion(nextVersion);
        return store.saveProject(payload);
    }

    @PostMapping("/{projectId}/undo")
    public ProjectState undoProject(@PathVariable("projectId") String projectId) {
        return store.popUndo(projectId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "No undo history available for this project."));
    }

    @DeleteMapping("/{projectId}")
    public Map<String, String> deleteProject(@PathVariable("projectId") String projectId) {
        boolean deleted = store.deleteProject(projectId);
        if (!deleted) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Project '" + projectId + "' not found.");
        }
        return Map.of("status", "deleted", "project_id", projectId);
    }

    @PostMapping("/{projectId}/export/audio")
    public ResponseEntity<byte[]> exportProjectAudio(
            @PathVariable("projectId") String projectId,
            @RequestBody(required = false) ExportAudioRequest reqBody
    ) {
        ExportAudioRequest req = reqBody != null ? reqBody : new ExportAudioRequest();
        ProjectState project = store.getProject(projectId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Project '" + projectId + "' not found."));

        Map<String, TrackState> tracks = project.getTracks();
        if (tracks != null && !tracks.isEmpty() && tracks.values().stream().allMatch(TrackState::isMute)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "All tracks are muted; unmute at least one track before exporting.");
        }

        String format = req.getFormat().toLowerCase(Locale.ROOT);
        int sr = properties.getSampleRate();

        // Try Docker audio-worker first when running (handles MP3/FluidSynth seamlessly)
        Map<String, byte[]> audioAssets = collectAudioAssets(project);
        String bitrate = req.getBitrate();
        Optional<byte[]> workerExport = audioWorkerClient.exportAudio(
                project, audioAssets, format, req.getMode(), req.isApplyMastering(), sr, bitrate);
        if (workerExport.isPresent()) {
            return buildExportResponse(projectId, format, workerExport.get());
        }

        JavaAudioFallbackService.RenderedMix rendered = audioFallback.renderProjectMix(
                project, store, req.getMode(), req.isApplyMastering(), sr);

        byte[] data = switch (format) {
            case "mp3" -> audioFallback.exportMp3ViaFfmpeg(rendered.stereo(), rendered.sampleRate(), bitrate);
            case "stems" -> audioFallback.exportStemsZip(rendered.stems(), rendered.sampleRate());
            default -> audioFallback.encodeWavStereo(rendered.stereo(), rendered.sampleRate());
        };
        return buildExportResponse(projectId, format, data);
    }

    @PostMapping("/{projectId}/export/midi")
    public ResponseEntity<byte[]> exportProjectMidi(@PathVariable("projectId") String projectId) {
        ProjectState project = store.getProject(projectId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Project '" + projectId + "' not found."));
        byte[] midi = audioFallback.exportMidi(project);
        String safeName = sanitizeFilename(projectId);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, "audio/midi")
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + safeName + ".mid\"")
                .body(midi);
    }

    @PostMapping("/{projectId}/export/aimusic")
    public ResponseEntity<byte[]> exportAimusic(@PathVariable("projectId") String projectId) {
        ProjectState project = store.getProject(projectId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Project '" + projectId + "' not found."));
        byte[] bundle = audioFallback.exportAimusicBundle(project, store);
        String safeName = sanitizeFilename(projectId);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_OCTET_STREAM_VALUE)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + safeName + ".aimusic\"")
                .body(bundle);
    }

    @PostMapping(value = "/import", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ProjectState importAimusic(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "overwrite", defaultValue = "true") boolean overwrite
    ) throws IOException {
        if (file == null || file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Uploaded .aimusic file is empty.");
        }
        long maxBundleBytes = Math.max(properties.getMaxUploadBytes(), 50L * 1024 * 1024);
        if (file.getSize() > maxBundleBytes) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                    "Uploaded .aimusic archive exceeds maximum allowed size.");
        }
        return audioFallback.importAimusicBundle(file.getBytes(), store, overwrite);
    }

    private ResponseEntity<byte[]> buildExportResponse(String projectId, String format, byte[] data) {
        String safeName = sanitizeFilename(projectId);
        return switch (format) {
            case "mp3" -> ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, "audio/mpeg")
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + safeName + ".mp3\"")
                    .body(data);
            case "stems" -> ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, "application/zip")
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + safeName + "_stems.zip\"")
                    .body(data);
            default -> ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, "audio/wav")
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + safeName + ".wav\"")
                    .body(data);
        };
    }

    private static String sanitizeFilename(String rawId) {
        if (rawId == null || rawId.isBlank()) return "project";
        String cleaned = rawId.replaceAll("[^A-Za-z0-9_-]", "_");
        return cleaned.isBlank() ? "project" : cleaned;
    }

    public Map<String, byte[]> collectAudioAssets(ProjectState project) {
        return store.collectAudioAssets(project);
    }

    private ProjectSummary toSummary(ProjectState p) {
        boolean hasAudio = p.getAudioAssets() != null
                && ((p.getAudioAssets().getRawInputRef() != null && !p.getAudioAssets().getRawInputRef().isBlank())
                || (p.getAudioAssets().getDryDenoisedRef() != null && !p.getAudioAssets().getDryDenoisedRef().isBlank()));
        return new ProjectSummary(
                p.getProjectId(),
                p.getConfig() != null ? p.getConfig().getTitle() : p.getTitle(),
                p.getConfig() != null ? p.getConfig().getGenre() : "Pop",
                p.getConfig() != null ? p.getConfig().getMood() : "Warm",
                p.getAnalysis() != null ? p.getAnalysis().getBpm() : 120.0,
                p.getAnalysis() != null ? p.getAnalysis().getDetectedKey() : "C",
                p.getAnalysis() != null ? p.getAnalysis().getDetectedScale() : "major",
                p.getSongStructure() != null ? p.getSongStructure().getTotalBars() : 4,
                p.getVersion(),
                p.getUpdatedAt(),
                hasAudio,
                p.getSource() != null ? p.getSource() : "draft"
        );
    }
}
