package com.aimusic.studio.cloud;

import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.store.ProjectStateStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.Optional;

/**
 * Shared ownership enforcement (HTTP 403), CloudDB auto-rehydration, and project mirroring helper
 * reused consistently across REST controllers.
 */
@Service
public class CloudProjectAccessService {

    private final ProjectStateStore store;
    private final CloudDatabaseService cloudDb;
    private final ObjectMapper objectMapper;

    @Autowired
    public CloudProjectAccessService(
            ProjectStateStore store,
            @Autowired(required = false) CloudDatabaseService cloudDb,
            @Autowired(required = false) ObjectMapper objectMapper
    ) {
        this.store = store;
        this.cloudDb = cloudDb;
        this.objectMapper = objectMapper != null ? objectMapper : new ObjectMapper();
    }

    public Optional<ProjectState> findOrRehydrate(String projectId) {
        if (projectId == null || projectId.isBlank()) {
            return Optional.empty();
        }
        Optional<ProjectState> inStore = store.getProject(projectId);
        if (inStore.isPresent() || cloudDb == null) {
            return inStore;
        }
        return cloudDb.findProject(projectId).flatMap(rec -> {
            try {
                ProjectState parsed = objectMapper.readValue(rec.stateJson(), ProjectState.class);
                return Optional.of(store.saveProject(parsed));
            } catch (Exception ex) {
                return Optional.empty();
            }
        });
    }

    public void requireReadAccess(ProjectState project, String deniedMessage) {
        if (project == null) return;
        if ("public".equalsIgnoreCase(project.getVisibility())) {
            return;
        }
        requireWriteAccess(project, deniedMessage);
    }

    public void requireWriteAccess(ProjectState project, String deniedMessage) {
        if (project == null) return;
        String callerOwner = AuthContextHolder.getOwnerId();
        String owner = project.getOwnerId();
        if (owner != null && owner.startsWith("u_") && !owner.equals(callerOwner)) {
            throw new ResponseStatusException(
                    HttpStatus.FORBIDDEN,
                    deniedMessage != null ? deniedMessage : "You do not have permission to access this private cloud project."
            );
        }
    }

    public void bindOwnerOnSave(ProjectState payload, Optional<ProjectState> existing) {
        String callerOwner = AuthContextHolder.getOwnerId();
        if (existing.isPresent()) {
            ProjectState prev = existing.get();
            String prevOwner = prev.getOwnerId();
            if (prevOwner != null && prevOwner.startsWith("u_")) {
                payload.setOwnerId(prevOwner);
            } else if (callerOwner.startsWith("u_")) {
                payload.setOwnerId(callerOwner);
            } else if (payload.getOwnerId() == null || payload.getOwnerId().isBlank()) {
                payload.setOwnerId("guest");
            }
            if (payload.getVisibility() == null || payload.getVisibility().isBlank()) {
                payload.setVisibility(prev.getVisibility());
                payload.setShareSlug(prev.getShareSlug());
                payload.setPublishedAt(prev.getPublishedAt());
            }
        } else {
            // Never accept spoofed cross-user owner_id when creating/forking a brand new project.
            payload.setOwnerId(callerOwner);
        }
    }

    public Optional<CloudDatabaseService.CloudProjectRecord> findCloudRecord(String projectId) {
        return cloudDb != null ? cloudDb.findProject(projectId) : Optional.empty();
    }

    public void mirrorToCloud(ProjectState p, String storageKeyOverride) {
        if (cloudDb == null || p == null || p.getProjectId() == null) return;
        try {
            String resolvedStorageKey = storageKeyOverride;
            if (resolvedStorageKey == null) {
                resolvedStorageKey = cloudDb.findProject(p.getProjectId())
                        .map(CloudDatabaseService.CloudProjectRecord::storageKey)
                        .orElse(null);
            }
            String json = objectMapper.writeValueAsString(p);
            cloudDb.upsertProject(new CloudDatabaseService.CloudProjectRecord(
                    p.getProjectId(),
                    p.getOwnerId() != null ? p.getOwnerId() : "guest",
                    p.getTitle() != null ? p.getTitle() : "Untitled Project",
                    p.getConfig() != null && p.getConfig().getGenre() != null ? p.getConfig().getGenre() : "Pop",
                    p.getVisibility() != null ? p.getVisibility() : "private",
                    p.getShareSlug(),
                    p.getPublishedAt(),
                    resolvedStorageKey,
                    p.getUpdatedAt() != null ? p.getUpdatedAt() : Instant.now().toString(),
                    json
            ));
        } catch (Exception ignored) {
        }
    }
}
