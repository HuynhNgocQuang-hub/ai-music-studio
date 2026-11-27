package com.aimusic.studio.controller;

import com.aimusic.studio.cloud.AuthContextHolder;
import com.aimusic.studio.cloud.CloudDatabaseService;
import com.aimusic.studio.cloud.CloudProjectAccessService;
import com.aimusic.studio.cloud.UserPrincipal;
import com.aimusic.studio.collab.CollabRoomService;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.store.ProjectStateStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Named Project Version Checkpoints API (/api/projects/{projectId}/versions).
 */
@RestController
@RequestMapping("/api/projects/{projectId}/versions")
public class ProjectVersionController {

    private final CloudDatabaseService cloudDb;
    private final CloudProjectAccessService projectAccess;
    private final ProjectStateStore store;
    private final CollabRoomService roomService;
    private final ObjectMapper objectMapper;

    public ProjectVersionController(
            CloudDatabaseService cloudDb,
            CloudProjectAccessService projectAccess,
            ProjectStateStore store,
            CollabRoomService roomService,
            ObjectMapper objectMapper
    ) {
        this.cloudDb = cloudDb;
        this.projectAccess = projectAccess;
        this.store = store;
        this.roomService = roomService;
        this.objectMapper = objectMapper;
    }

    @GetMapping
    public Map<String, Object> listVersions(
            @PathVariable("projectId") String projectId,
            @RequestParam(value = "collab", required = false) String collabCode
    ) {
        if (!roomService.isValidInvite(projectId, collabCode)) {
            projectAccess.findOrRehydrate(projectId).ifPresent(p ->
                    projectAccess.requireReadAccess(p, "You do not have permission to view checkpoints for this project."));
        }
        List<Map<String, Object>> items = cloudDb.listProjectVersions(projectId).stream()
                .map(ProjectVersionController::toSummaryMap)
                .toList();
        return Map.of("project_id", projectId, "items", items);
    }

    @PostMapping
    public Map<String, Object> createVersion(
            @PathVariable("projectId") String projectId,
            @RequestParam(value = "collab", required = false) String collabCode,
            @RequestBody(required = false) Map<String, Object> body
    ) {
        ProjectState target = projectAccess.findOrRehydrate(projectId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Project '" + projectId + "' not found."));
        if (!roomService.isValidInvite(projectId, collabCode)) {
            projectAccess.requireWriteAccess(target, "You do not have permission to create checkpoints for this project.");
        }

        if (body != null && body.get("state") != null) {
            try {
                ProjectState bodyState = objectMapper.convertValue(body.get("state"), ProjectState.class);
                bodyState.setProjectId(projectId);
                bodyState.setOwnerId(target.getOwnerId());
                bodyState.setVisibility(target.getVisibility());
                bodyState.setShareSlug(target.getShareSlug());
                bodyState.setPublishedAt(target.getPublishedAt());
                target = bodyState;
            } catch (Exception ignored) {
            }
        }

        int existingCount = cloudDb.listProjectVersions(projectId).size();
        String rawLabel = body != null && body.get("label") instanceof String s ? s.trim() : "";
        String label = !rawLabel.isBlank()
                ? rawLabel.substring(0, Math.min(rawLabel.length(), 120))
                : "Checkpoint #" + (existingCount + 1);

        UserPrincipal caller = AuthContextHolder.get();
        String authorId = caller.isGuest() ? "guest" : caller.userId();
        String authorName = caller.isGuest() ? "Guest Producer" : caller.displayName();
        double bpm = target.getAnalysis() != null ? target.getAnalysis().getBpm() : 120.0;
        int totalBars = target.getSongStructure() != null ? target.getSongStructure().getTotalBars() : 4;

        String stateJson;
        try {
            stateJson = objectMapper.writeValueAsString(target);
        } catch (Exception ex) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to serialize checkpoint state.");
        }

        CloudDatabaseService.ProjectVersionRecord created = cloudDb.createProjectVersion(
                projectId, label, authorId, authorName, bpm, totalBars, stateJson
        );
        return toSummaryMap(created);
    }

    @PostMapping("/{versionId}/restore")
    public Map<String, Object> restoreVersion(
            @PathVariable("projectId") String projectId,
            @PathVariable("versionId") String versionId,
            @RequestParam(value = "collab", required = false) String collabCode
    ) {
        ProjectState current = projectAccess.findOrRehydrate(projectId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Project '" + projectId + "' not found."));
        if (!roomService.isValidInvite(projectId, collabCode)) {
            projectAccess.requireWriteAccess(current, "You do not have permission to restore checkpoints for this project.");
        }

        CloudDatabaseService.ProjectVersionRecord rec = cloudDb.findProjectVersion(versionId)
                .filter(v -> projectId.equals(v.projectId()))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Checkpoint not found."));

        ProjectState restored;
        try {
            restored = objectMapper.readValue(rec.stateJson(), ProjectState.class);
        } catch (Exception ex) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Stored checkpoint state is corrupted.");
        }

        restored.setProjectId(projectId);
        restored.setOwnerId(current.getOwnerId());
        restored.setVisibility(current.getVisibility());
        restored.setShareSlug(current.getShareSlug());
        restored.setPublishedAt(current.getPublishedAt());

        ProjectState saved = store.saveProject(restored);
        projectAccess.mirrorToCloud(saved, null);

        UserPrincipal caller = AuthContextHolder.get();
        roomService.broadcast(projectId, Map.of(
                "type", "state_sync",
                "project_id", projectId,
                "client_id", "server_restore",
                "display_name", caller.isGuest() ? "Checkpoint Restore" : caller.displayName(),
                "revision", roomService.bumpRevision(projectId),
                "state", saved
        ), null);

        return Map.of(
                "status", "restored",
                "version_id", versionId,
                "label", rec.label(),
                "project_state", saved
        );
    }

    @DeleteMapping("/{versionId}")
    public Map<String, Object> deleteVersion(
            @PathVariable("projectId") String projectId,
            @PathVariable("versionId") String versionId
    ) {
        ProjectState current = projectAccess.findOrRehydrate(projectId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Project '" + projectId + "' not found."));
        projectAccess.requireWriteAccess(current, "Only the project owner can delete checkpoints.");
        CloudDatabaseService.ProjectVersionRecord rec = cloudDb.findProjectVersion(versionId)
                .filter(v -> projectId.equals(v.projectId()))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Checkpoint not found."));
        cloudDb.deleteProjectVersion(rec.id());
        return Map.of("status", "deleted", "version_id", versionId);
    }

    private static Map<String, Object> toSummaryMap(CloudDatabaseService.ProjectVersionRecord v) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("id", v.id());
        map.put("project_id", v.projectId());
        map.put("label", v.label());
        map.put("author_id", v.authorId());
        map.put("author_name", v.authorName());
        map.put("bpm", v.bpm());
        map.put("total_bars", v.totalBars());
        map.put("created_at", v.createdAt());
        return map;
    }
}
