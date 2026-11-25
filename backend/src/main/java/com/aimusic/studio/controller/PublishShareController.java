package com.aimusic.studio.controller;

import com.aimusic.studio.audio.AudioWorkerClient;
import com.aimusic.studio.audio.JavaAudioFallbackService;
import com.aimusic.studio.cloud.AuthContextHolder;
import com.aimusic.studio.cloud.CloudDatabaseService;
import com.aimusic.studio.cloud.ObjectStorageService;
import com.aimusic.studio.cloud.QuotaRateLimitService;
import com.aimusic.studio.cloud.UserPrincipal;
import com.aimusic.studio.config.AppProperties;
import com.aimusic.studio.model.LyricLine;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.TrackState;
import com.aimusic.studio.store.ProjectStateStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

@RestController
public class PublishShareController {

    private final ProjectStateStore store;
    private final AudioWorkerClient audioWorkerClient;
    private final JavaAudioFallbackService audioFallback;
    private final AppProperties properties;
    private final CloudDatabaseService cloudDb;
    private final ObjectStorageService objectStorage;
    private final QuotaRateLimitService quotaService;
    private final ObjectMapper objectMapper;

    public PublishShareController(
            ProjectStateStore store,
            AudioWorkerClient audioWorkerClient,
            JavaAudioFallbackService audioFallback,
            AppProperties properties,
            CloudDatabaseService cloudDb,
            ObjectStorageService objectStorage,
            QuotaRateLimitService quotaService,
            ObjectMapper objectMapper
    ) {
        this.store = store;
        this.audioWorkerClient = audioWorkerClient;
        this.audioFallback = audioFallback;
        this.properties = properties;
        this.cloudDb = cloudDb;
        this.objectStorage = objectStorage;
        this.quotaService = quotaService;
        this.objectMapper = objectMapper;
    }

    @PostMapping("/api/projects/{projectId}/publish")
    public Map<String, Object> publishProject(
            @PathVariable("projectId") String projectId,
            @RequestBody(required = false) Map<String, Object> body
    ) {
        ProjectState project = loadOrRehydrateProject(projectId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Project '" + projectId + "' not found."));

        UserPrincipal principal = AuthContextHolder.get();
        String callerOwner = AuthContextHolder.getOwnerId();
        String projectOwner = project.getOwnerId();
        if (projectOwner != null && projectOwner.startsWith("u_") && !projectOwner.equals(callerOwner)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "You do not have permission to publish another user's project.");
        }
        if ((projectOwner == null || "guest".equals(projectOwner)) && !principal.isGuest()) {
            project.setOwnerId(callerOwner);
        } else if (projectOwner == null || projectOwner.isBlank()) {
            project.setOwnerId("guest");
        }

        Map<String, TrackState> tracks = project.getTracks();
        if (tracks != null && !tracks.isEmpty() && tracks.values().stream().allMatch(TrackState::isMute)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "All tracks are muted; unmute at least one track before publishing.");
        }

        String requestedFormat = body != null && body.get("format") instanceof String s
                ? s.trim().toLowerCase(Locale.ROOT) : "mp3";
        String format = switch (requestedFormat) {
            case "flac", "wav", "mp3" -> requestedFormat;
            default -> "mp3";
        };
        String bitrate = body != null && body.get("bitrate") instanceof String b && b.trim().startsWith("192")
                ? "192k" : "320k";
        String title = body != null && body.get("title") instanceof String t && !t.isBlank()
                ? t.trim() : (project.getTitle() != null ? project.getTitle() : projectId);
        String defaultArtist = principal.isGuest() ? "AI Music Studio Creator" : principal.displayName();
        String artist = body != null && body.get("artist") instanceof String a && !a.isBlank()
                ? a.trim() : defaultArtist;
        String genre = body != null && body.get("genre") instanceof String g && !g.isBlank()
                ? g.trim() : (project.getConfig() != null ? project.getConfig().getGenre() : "Pop");
        boolean applyMastering = !(body != null && Boolean.FALSE.equals(body.get("apply_mastering")));

        int sr = properties.getSampleRate();
        Map<String, byte[]> audioAssets = store.collectAudioAssets(project);
        byte[] masterBytes;
        String resolvedFormat = format;

        Optional<byte[]> workerAudio = audioWorkerClient.exportAudio(
                project, audioAssets, format, "ai_mix", applyMastering, sr, bitrate,
                title, artist, "AI Music Studio", genre
        );
        if (workerAudio.isPresent()) {
            masterBytes = workerAudio.get();
        } else {
            JavaAudioFallbackService.RenderedMix rendered = audioFallback.renderProjectMix(
                    project, store, "ai_mix", applyMastering, sr);
            if ("mp3".equals(format)) {
                try {
                    masterBytes = audioFallback.exportMp3ViaFfmpeg(rendered.stereo(), rendered.sampleRate(), bitrate, title, artist, genre);
                } catch (Exception ex) {
                    masterBytes = audioFallback.encodeWavStereo(rendered.stereo(), rendered.sampleRate());
                    resolvedFormat = "wav";
                }
            } else if ("flac".equals(format)) {
                try {
                    masterBytes = audioFallback.exportFlacViaFfmpeg(rendered.stereo(), rendered.sampleRate(), title, artist, genre);
                } catch (Exception ex) {
                    masterBytes = audioFallback.encodeWavStereo(rendered.stereo(), rendered.sampleRate());
                    resolvedFormat = "wav";
                }
            } else {
                masterBytes = audioFallback.encodeWavStereo(rendered.stereo(), rendered.sampleRate());
                resolvedFormat = "wav";
            }
        }

        byte[] aimusicBytes = audioFallback.exportAimusicBundle(project, store);
        quotaService.consumeExportQuota(principal, AuthContextHolder.getActorQuotaKey(), masterBytes.length + aimusicBytes.length);

        String shareSlug = (project.getShareSlug() != null && !project.getShareSlug().isBlank())
                ? project.getShareSlug()
                : buildSlug(title, projectId);
        String now = Instant.now().toString();

        String masterKey = "masters/" + shareSlug + "." + resolvedFormat;
        String bundleKey = "projects/" + project.getOwnerId() + "/" + projectId + ".aimusic";
        objectStorage.putObject(masterKey, masterBytes, contentTypeForFormat(resolvedFormat));
        objectStorage.putObject(bundleKey, aimusicBytes, "application/zip");

        project.setVisibility("public");
        project.setShareSlug(shareSlug);
        project.setPublishedAt(now);
        project.setSource("saved");
        store.saveProject(project);

        persistProjectRecord(project, bundleKey);

        double lufs = project.getMastering() != null ? project.getMastering().getTargetLufs() : -14.0;
        String lyricsSummary = buildLyricsSummary(project);
        CloudDatabaseService.PublishedReleaseRecord release = new CloudDatabaseService.PublishedReleaseRecord(
                shareSlug,
                projectId,
                project.getOwnerId(),
                title,
                artist,
                genre,
                project.getAnalysis() != null ? project.getAnalysis().getBpm() : 120.0,
                project.getAnalysis() != null ? project.getAnalysis().getDetectedKey() : "C",
                project.getAnalysis() != null ? project.getAnalysis().getDetectedScale() : "major",
                project.getSongStructure() != null ? project.getSongStructure().getTotalBars() : 4,
                resolvedFormat,
                lufs,
                masterKey,
                lyricsSummary,
                0,
                now
        );
        cloudDb.upsertRelease(release);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", "published");
        out.put("project_id", projectId);
        out.put("share_slug", shareSlug);
        out.put("share_url", "/share/" + shareSlug);
        out.put("stream_url", "/api/share/" + shareSlug + "/audio");
        out.put("format", resolvedFormat);
        out.put("title", title);
        out.put("artist", artist);
        out.put("genre", genre);
        out.put("lufs_target", lufs);
        out.put("published_at", now);
        out.put("object_storage_backend", objectStorage.getBackendName());
        out.put("project_state", project);
        return out;
    }

    @DeleteMapping("/api/projects/{projectId}/publish")
    public Map<String, Object> unpublishProject(@PathVariable("projectId") String projectId) {
        ProjectState project = loadOrRehydrateProject(projectId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Project '" + projectId + "' not found."));
        String callerOwner = AuthContextHolder.getOwnerId();
        String projectOwner = project.getOwnerId();
        if (projectOwner != null && projectOwner.startsWith("u_") && !projectOwner.equals(callerOwner)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "You do not have permission to unpublish another user's project.");
        }

        cloudDb.findReleaseByProjectId(projectId).ifPresent(rel -> objectStorage.deleteObject(rel.masterStorageKey()));
        cloudDb.deleteReleaseByProjectId(projectId);

        project.setVisibility("private");
        project.setShareSlug(null);
        project.setPublishedAt(null);
        store.saveProject(project);
        persistProjectRecord(project, null);
        return Map.of("status", "unpublished", "project_id", projectId);
    }

    @GetMapping("/api/share")
    public Map<String, Object> listPublicReleases(
            @RequestParam(value = "page", defaultValue = "1") int page,
            @RequestParam(value = "limit", defaultValue = "12") int limit,
            @RequestParam(value = "search", defaultValue = "") String search,
            @RequestParam(value = "genre", defaultValue = "") String genre
    ) {
        List<CloudDatabaseService.PublishedReleaseRecord> all = cloudDb.listReleases(search, genre);
        int total = all.size();
        int safeLimit = Math.max(1, Math.min(limit, 50));
        int totalPages = total > 0 ? Math.max(1, (int) Math.ceil((double) total / safeLimit)) : 1;
        int safePage = Math.max(1, Math.min(page, totalPages));
        int start = (safePage - 1) * safeLimit;
        int end = Math.min(total, start + safeLimit);
        List<Map<String, Object>> items = new ArrayList<>();
        for (int i = start; i < end; i++) {
            items.add(toReleaseMap(all.get(i), null));
        }
        return Map.of(
                "items", items,
                "total", total,
                "page", safePage,
                "limit", safeLimit,
                "total_pages", totalPages
        );
    }

    @GetMapping("/api/share/{slug}")
    public Map<String, Object> getPublicRelease(@PathVariable("slug") String slug) {
        CloudDatabaseService.PublishedReleaseRecord rel = cloudDb.findReleaseBySlug(slug)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Published demo '" + slug + "' not found."));
        cloudDb.incrementReleasePlays(slug);
        CloudDatabaseService.PublishedReleaseRecord refreshed = cloudDb.findReleaseBySlug(slug).orElse(rel);
        ProjectState state = loadOrRehydrateProject(rel.projectId()).orElse(null);
        return toReleaseMap(refreshed, state);
    }

    @GetMapping("/api/share/{slug}/audio")
    public ResponseEntity<byte[]> streamPublicReleaseAudio(@PathVariable("slug") String slug) {
        CloudDatabaseService.PublishedReleaseRecord rel = cloudDb.findReleaseBySlug(slug)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Published demo '" + slug + "' not found."));
        byte[] bytes = objectStorage.getObject(rel.masterStorageKey())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Master audio asset not found in storage."));
        String ext = rel.masterFormat() != null ? rel.masterFormat().toLowerCase(Locale.ROOT) : "mp3";
        String safeSlug = slug.replaceAll("[^A-Za-z0-9_-]", "_");
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, contentTypeForFormat(ext))
                .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"" + safeSlug + "." + ext + "\"")
                .body(bytes);
    }

    private Optional<ProjectState> loadOrRehydrateProject(String projectId) {
        Optional<ProjectState> inStore = store.getProject(projectId);
        if (inStore.isPresent()) return inStore;
        return cloudDb.findProject(projectId).flatMap(rec -> {
            try {
                ProjectState parsed = objectMapper.readValue(rec.stateJson(), ProjectState.class);
                return Optional.of(store.saveProject(parsed));
            } catch (Exception ex) {
                return Optional.empty();
            }
        });
    }

    private void persistProjectRecord(ProjectState p, String storageKey) {
        try {
            String json = objectMapper.writeValueAsString(p);
            cloudDb.upsertProject(new CloudDatabaseService.CloudProjectRecord(
                    p.getProjectId(),
                    p.getOwnerId() != null ? p.getOwnerId() : "guest",
                    p.getTitle() != null ? p.getTitle() : "Untitled Project",
                    p.getConfig() != null && p.getConfig().getGenre() != null ? p.getConfig().getGenre() : "Pop",
                    p.getVisibility() != null ? p.getVisibility() : "private",
                    p.getShareSlug(),
                    p.getPublishedAt(),
                    storageKey,
                    p.getUpdatedAt() != null ? p.getUpdatedAt() : Instant.now().toString(),
                    json
            ));
        } catch (Exception ignored) {
        }
    }

    private Map<String, Object> toReleaseMap(CloudDatabaseService.PublishedReleaseRecord r, ProjectState state) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("share_slug", r.shareSlug());
        map.put("project_id", r.projectId());
        map.put("owner_id", r.ownerId());
        map.put("title", r.title());
        map.put("artist", r.artist());
        map.put("genre", r.genre());
        map.put("bpm", r.bpm());
        map.put("key", r.detectedKey());
        map.put("scale", r.scale());
        map.put("total_bars", r.totalBars());
        map.put("master_format", r.masterFormat());
        map.put("lufs_target", r.lufsTarget());
        map.put("plays_count", r.playsCount());
        map.put("created_at", r.createdAt());
        map.put("share_url", "/share/" + r.shareSlug());
        map.put("stream_url", "/api/share/" + r.shareSlug() + "/audio");
        map.put("lyrics_summary", r.lyricsSummary());
        if (state != null) {
            map.put("sections", state.getSongStructure() != null ? state.getSongStructure().getSections() : List.of());
            map.put("chords", state.getSongStructure() != null ? state.getSongStructure().getChords() : List.of());
            map.put("lyrics", state.getLyrics() != null ? state.getLyrics().getLines() : List.of());
        }
        return map;
    }

    private static String buildLyricsSummary(ProjectState project) {
        if (project.getLyrics() == null || project.getLyrics().getLines() == null || project.getLyrics().getLines().isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        int count = 0;
        for (LyricLine line : project.getLyrics().getLines()) {
            if (line != null && line.getText() != null && !line.getText().isBlank()) {
                if (sb.length() > 0) sb.append('\n');
                sb.append(line.getText().trim());
                if (++count >= 8) break;
            }
        }
        return sb.toString();
    }

    private static String buildSlug(String title, String projectId) {
        String base = (title != null ? title : projectId)
                .toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9]+", "-")
                .replaceAll("^-+|-+$", "");
        if (base.isBlank()) base = "track";
        if (base.length() > 36) base = base.substring(0, 36);
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 6);
        return base + "-" + suffix;
    }

    private static String contentTypeForFormat(String format) {
        return switch (format) {
            case "flac" -> "audio/flac";
            case "wav" -> "audio/wav";
            default -> "audio/mpeg";
        };
    }
}
