package com.aimusic.studio.controller;

import com.aimusic.studio.audio.AudioWorkerClient;
import com.aimusic.studio.audio.JavaAudioFallbackService;
import com.aimusic.studio.cloud.AuthContextHolder;
import com.aimusic.studio.cloud.CloudDatabaseService;
import com.aimusic.studio.cloud.CloudProjectAccessService;
import com.aimusic.studio.cloud.ObjectStorageService;
import com.aimusic.studio.cloud.QuotaRateLimitService;
import com.aimusic.studio.config.AppProperties;
import com.aimusic.studio.model.AudioClip;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.TrackState;
import com.aimusic.studio.model.dto.ExportAudioRequest;
import com.aimusic.studio.model.dto.PaginatedProjectsResponse;
import com.aimusic.studio.model.dto.ProjectSummary;
import com.aimusic.studio.store.ProjectStateStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
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
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

@RestController
@RequestMapping("/api/projects")
public class ProjectsController {

    private final ProjectStateStore store;
    private final AudioWorkerClient audioWorkerClient;
    private final JavaAudioFallbackService audioFallback;
    private final AppProperties properties;
    private final CloudDatabaseService cloudDb;
    private final ObjectStorageService objectStorage;
    private final QuotaRateLimitService quotaService;
    private final ObjectMapper objectMapper;
    private final CloudProjectAccessService projectAccess;

    public ProjectsController(
            ProjectStateStore store,
            AudioWorkerClient audioWorkerClient,
            JavaAudioFallbackService audioFallback,
            AppProperties properties
    ) {
        this(store, audioWorkerClient, audioFallback, properties, null, null, null, new ObjectMapper(), null);
    }

    @Autowired
    public ProjectsController(
            ProjectStateStore store,
            AudioWorkerClient audioWorkerClient,
            JavaAudioFallbackService audioFallback,
            AppProperties properties,
            @Autowired(required = false) CloudDatabaseService cloudDb,
            @Autowired(required = false) ObjectStorageService objectStorage,
            @Autowired(required = false) QuotaRateLimitService quotaService,
            @Autowired(required = false) ObjectMapper objectMapper,
            @Autowired(required = false) CloudProjectAccessService projectAccess
    ) {
        this.store = store;
        this.audioWorkerClient = audioWorkerClient;
        this.audioFallback = audioFallback;
        this.properties = properties;
        this.cloudDb = cloudDb;
        this.objectStorage = objectStorage;
        this.quotaService = quotaService;
        this.objectMapper = objectMapper != null ? objectMapper : new ObjectMapper();
        this.projectAccess = projectAccess != null ? projectAccess
                : new CloudProjectAccessService(store, cloudDb, this.objectMapper);
    }

    @GetMapping
    public PaginatedProjectsResponse listProjects(
            @RequestParam(value = "page", defaultValue = "1") int page,
            @RequestParam(value = "limit", defaultValue = "12") int limit,
            @RequestParam(value = "search", defaultValue = "") String search,
            @RequestParam(value = "genre", defaultValue = "") String genre,
            @RequestParam(value = "key", defaultValue = "") String key,
            @RequestParam(value = "scope", defaultValue = "all") String scope
    ) {
        int safePage = Math.max(1, page);
        int safeLimit = Math.max(1, Math.min(limit, 100));
        String callerOwner = AuthContextHolder.getOwnerId();
        String normScope = scope != null ? scope.trim().toLowerCase(Locale.ROOT) : "all";

        // Merge live store projects with durable CloudDatabaseService records
        Map<String, ProjectState> merged = new LinkedHashMap<>();
        for (ProjectState p : store.listProjects(1, 500, search, genre, key).items()) {
            merged.put(p.getProjectId(), p);
        }
        if (cloudDb != null) {
            for (CloudDatabaseService.CloudProjectRecord rec : cloudDb.listAllProjects()) {
                if (!merged.containsKey(rec.projectId())) {
                    try {
                        ProjectState parsed = objectMapper.readValue(rec.stateJson(), ProjectState.class);
                        if (matchesFilter(parsed, search, genre, key)) {
                            merged.put(parsed.getProjectId(), parsed);
                        }
                    } catch (Exception ignored) {
                    }
                }
            }
        }

        List<ProjectState> visible = new ArrayList<>();
        for (ProjectState p : merged.values()) {
            String owner = p.getOwnerId();
            boolean isPublic = "public".equalsIgnoreCase(p.getVisibility());
            boolean isMine = owner != null && !owner.isBlank() && owner.equals(callerOwner);
            boolean isGuestOwned = owner == null || owner.isBlank() || "guest".equals(owner);

            if ("mine".equals(normScope)) {
                if (!isMine && !("guest".equals(callerOwner) && isGuestOwned)) continue;
            } else if ("public".equals(normScope)) {
                if (!isPublic) continue;
            } else {
                if (!isMine && !isGuestOwned && !isPublic) continue;
            }
            visible.add(p);
        }

        visible.sort(Comparator.comparing(
                (ProjectState p) -> p.getUpdatedAt() != null ? p.getUpdatedAt() : "",
                Comparator.reverseOrder()
        ));

        int total = visible.size();
        int totalPages = total > 0 ? Math.max(1, (int) Math.ceil((double) total / safeLimit)) : 1;
        int actualPage = Math.min(safePage, totalPages);
        int start = (actualPage - 1) * safeLimit;
        int end = Math.min(total, start + safeLimit);
        List<ProjectSummary> items = (start < end ? visible.subList(start, end) : List.<ProjectState>of())
                .stream().map(this::toSummary).toList();
        return new PaginatedProjectsResponse(items, total, actualPage, safeLimit, totalPages);
    }

    @GetMapping("/{projectId}")
    public ProjectState getProject(@PathVariable("projectId") String projectId) {
        ProjectState state = projectAccess.findOrRehydrate(projectId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Project '" + projectId + "' not found."));
        projectAccess.requireReadAccess(state, "This private cloud project belongs to another creator.");
        return state;
    }

    @PutMapping("/{projectId}/sync")
    public ProjectState syncProject(@PathVariable("projectId") String projectId, @RequestBody ProjectState payload) {
        Optional<ProjectState> existing = projectAccess.findOrRehydrate(projectId);
        if (existing.isPresent()) {
            projectAccess.requireWriteAccess(existing.get(), "Cannot overwrite another creator's project.");
            store.pushUndo(projectId, existing.get());
        }

        payload.setProjectId(projectId);
        projectAccess.bindOwnerOnSave(payload, existing);
        if (payload.getConfig() != null && (payload.getConfig().getTitle() == null || payload.getConfig().getTitle().isBlank())
                && payload.getTitle() != null && !payload.getTitle().isBlank()) {
            payload.getConfig().setTitle(payload.getTitle());
        }
        int nextVersion = existing.map(p -> p.getVersion() + 1).orElse(Math.max(1, payload.getVersion()));
        payload.setVersion(nextVersion);
        ProjectState saved = store.saveProject(payload);
        projectAccess.mirrorToCloud(saved, null);
        return saved;
    }

    @PostMapping("/{projectId}/undo")
    public ProjectState undoProject(@PathVariable("projectId") String projectId) {
        projectAccess.findOrRehydrate(projectId).ifPresent(p ->
                projectAccess.requireWriteAccess(p, "Cannot undo changes on another creator's project."));
        ProjectState restored = store.popUndo(projectId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "No undo history available for this project."));
        projectAccess.mirrorToCloud(restored, null);
        return restored;
    }

    @DeleteMapping("/{projectId}")
    public Map<String, String> deleteProject(@PathVariable("projectId") String projectId) {
        Optional<ProjectState> existing = projectAccess.findOrRehydrate(projectId);
        Optional<CloudDatabaseService.CloudProjectRecord> cloudRec = projectAccess.findCloudRecord(projectId);
        if (existing.isPresent()) {
            projectAccess.requireWriteAccess(existing.get(), "Cannot delete another creator's project.");
        } else if (cloudRec.isPresent()) {
            String recOwner = cloudRec.get().ownerId();
            String callerOwner = AuthContextHolder.getOwnerId();
            if (recOwner != null && recOwner.startsWith("u_") && !recOwner.equals(callerOwner)) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Cannot delete another creator's project.");
            }
        }

        boolean deleted = store.deleteProject(projectId);
        Set<String> audioRefsToDelete = new LinkedHashSet<>();
        existing.ifPresent(p -> audioRefsToDelete.addAll(store.collectAudioRefs(p)));
        for (String ref : audioRefsToDelete) {
            store.deleteAudioBytes(ref);
        }

        if (cloudDb != null) {
            cloudDb.findReleaseByProjectId(projectId).ifPresent(rel -> {
                if (objectStorage != null) {
                    objectStorage.deleteObject(rel.masterStorageKey());
                }
                cloudDb.deleteReleaseByProjectId(projectId);
            });
            if (cloudRec.isPresent()) {
                cloudDb.deleteProject(projectId);
                deleted = true;
            }
        }
        if (objectStorage != null) {
            String ownerPrefix = existing.map(ProjectState::getOwnerId)
                    .or(() -> cloudRec.map(CloudDatabaseService.CloudProjectRecord::ownerId))
                    .orElse(AuthContextHolder.getOwnerId());
            objectStorage.deleteObject("projects/" + ownerPrefix + "/" + projectId + ".aimusic");
            cloudRec.map(CloudDatabaseService.CloudProjectRecord::storageKey)
                    .filter(k -> k != null && !k.isBlank())
                    .ifPresent(objectStorage::deleteObject);
        }
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
        ProjectState project = getProject(projectId);

        Map<String, TrackState> tracks = project.getTracks();
        if (tracks != null && !tracks.isEmpty() && tracks.values().stream().allMatch(TrackState::isMute)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "All tracks are muted; unmute at least one track before exporting.");
        }

        if (quotaService != null) {
            quotaService.consumeExportQuota(AuthContextHolder.get(), AuthContextHolder.getActorQuotaKey(), 0L);
        }

        String format = req.getFormat().toLowerCase(Locale.ROOT);
        int sr = properties.getSampleRate();
        String title = (req.getTitle() != null && !req.getTitle().isBlank())
                ? req.getTitle().trim() : project.getTitle();
        String artist = (req.getArtist() != null && !req.getArtist().isBlank())
                ? req.getArtist().trim()
                : (AuthContextHolder.get().isGuest() ? "AI Music Studio" : AuthContextHolder.get().displayName());
        String genre = (req.getGenre() != null && !req.getGenre().isBlank())
                ? req.getGenre().trim()
                : (project.getConfig() != null ? project.getConfig().getGenre() : "Pop");

        Map<String, byte[]> audioAssets = collectAudioAssets(project);
        String bitrate = req.getBitrate();
        Optional<byte[]> workerExport = audioWorkerClient.exportAudio(
                project, audioAssets, format, req.getMode(), req.isApplyMastering(), sr, bitrate,
                title, artist, req.getAlbum(), genre);
        if (workerExport.isPresent()) {
            return buildExportResponse(projectId, format, workerExport.get());
        }

        JavaAudioFallbackService.RenderedMix rendered = audioFallback.renderProjectMix(
                project, store, req.getMode(), req.isApplyMastering(), sr);

        byte[] data = switch (format) {
            case "mp3" -> audioFallback.exportMp3ViaFfmpeg(rendered.stereo(), rendered.sampleRate(), bitrate, title, artist, genre);
            case "flac" -> audioFallback.exportFlacViaFfmpeg(rendered.stereo(), rendered.sampleRate(), title, artist, genre);
            case "stems" -> audioFallback.exportStemsZip(rendered.stems(), rendered.sampleRate());
            default -> audioFallback.encodeWavStereo(rendered.stereo(), rendered.sampleRate());
        };
        return buildExportResponse(projectId, format, data);
    }

    @PostMapping("/{projectId}/export/midi")
    public ResponseEntity<byte[]> exportProjectMidi(@PathVariable("projectId") String projectId) {
        ProjectState project = getProject(projectId);
        byte[] midi = audioFallback.exportMidi(project);
        String safeName = sanitizeFilename(projectId);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, "audio/midi")
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + safeName + ".mid\"")
                .body(midi);
    }

    @PostMapping("/{projectId}/export/aimusic")
    public ResponseEntity<byte[]> exportAimusic(@PathVariable("projectId") String projectId) {
        ProjectState project = getProject(projectId);
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
        ProjectState imported = audioFallback.importAimusicBundle(file.getBytes(), store, overwrite);
        Optional<ProjectState> existing = projectAccess.findOrRehydrate(imported.getProjectId());
        if (existing.isPresent()) {
            projectAccess.requireWriteAccess(existing.get(),
                    "Cannot overwrite another creator's existing project during .aimusic import.");
        }
        projectAccess.bindOwnerOnSave(imported, existing);
        store.saveProject(imported);
        projectAccess.mirrorToCloud(imported, null);
        return imported;
    }

    private static boolean matchesFilter(ProjectState p, String search, String genre, String keyFilter) {
        String q = search != null ? search.trim().toLowerCase(Locale.ROOT) : "";
        String g = genre != null ? genre.trim().toLowerCase(Locale.ROOT) : "";
        String kf = keyFilter != null ? keyFilter.trim().toLowerCase(Locale.ROOT) : "";
        String pTitle = p.getConfig() != null && p.getConfig().getTitle() != null
                ? p.getConfig().getTitle().toLowerCase(Locale.ROOT) : "";
        String pGenre = p.getConfig() != null && p.getConfig().getGenre() != null
                ? p.getConfig().getGenre().toLowerCase(Locale.ROOT) : "";
        String pId = p.getProjectId() != null ? p.getProjectId().toLowerCase(Locale.ROOT) : "";
        String pKey = p.getAnalysis() != null && p.getAnalysis().getDetectedKey() != null
                ? p.getAnalysis().getDetectedKey().toLowerCase(Locale.ROOT) : "";
        if (!q.isEmpty() && !pTitle.contains(q) && !pId.contains(q) && !pGenre.contains(q)) return false;
        if (!g.isEmpty() && !pGenre.equals(g)) return false;
        if (!kf.isEmpty() && !pKey.equals(kf)) return false;
        return true;
    }

    private ResponseEntity<byte[]> buildExportResponse(String projectId, String format, byte[] data) {
        String safeName = sanitizeFilename(projectId);
        return switch (format) {
            case "mp3" -> ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, "audio/mpeg")
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + safeName + ".mp3\"")
                    .body(data);
            case "flac" -> ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, "audio/flac")
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + safeName + ".flac\"")
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
        ProjectSummary sum = new ProjectSummary(
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
        sum.setOwnerId(p.getOwnerId());
        sum.setVisibility(p.getVisibility());
        sum.setShareSlug(p.getShareSlug());
        sum.setPublishedAt(p.getPublishedAt());
        return sum;
    }
}
