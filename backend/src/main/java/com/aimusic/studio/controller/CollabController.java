package com.aimusic.studio.controller;

import com.aimusic.studio.cloud.AuthContextHolder;
import com.aimusic.studio.cloud.CloudDatabaseService;
import com.aimusic.studio.cloud.CloudProjectAccessService;
import com.aimusic.studio.cloud.UserPrincipal;
import com.aimusic.studio.collab.CollabRoomService;
import com.aimusic.studio.model.ProjectState;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
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
import java.util.Optional;

@RestController
@RequestMapping("/api/studio/{projectId}")
public class CollabController {

    private final CollabRoomService roomService;
    private final CloudDatabaseService cloudDb;
    private final CloudProjectAccessService projectAccess;

    public CollabController(
            CollabRoomService roomService,
            CloudDatabaseService cloudDb,
            CloudProjectAccessService projectAccess
    ) {
        this.roomService = roomService;
        this.cloudDb = cloudDb;
        this.projectAccess = projectAccess;
    }

    @GetMapping("/collab/session")
    public Map<String, Object> getCollabSession(
            @PathVariable("projectId") String projectId,
            @RequestParam(value = "collab", required = false) String collabCode
    ) {
        Optional<ProjectState> existing = projectAccess.findOrRehydrate(projectId);
        boolean isInvited = roomService.isValidInvite(projectId, collabCode);
        boolean isOwner = existing.map(this::callerIsOwner).orElse(true);
        if (!isInvited) {
            existing.ifPresent(p -> projectAccess.requireReadAccess(p,
                    "You do not have permission to view this collaboration room."));
        }
        return roomService.roomSummary(projectId, isOwner || isInvited);
    }

    @PostMapping("/collab/session")
    public Map<String, Object> createOrEnableCollabSession(@PathVariable("projectId") String projectId) {
        Optional<ProjectState> existing = projectAccess.findOrRehydrate(projectId);
        existing.ifPresent(p -> projectAccess.requireWriteAccess(p,
                "Only the project owner can generate a collaboration invite link."));
        String ownerId = existing.map(ProjectState::getOwnerId).orElse(AuthContextHolder.getOwnerId());
        roomService.openOrGetRoom(projectId, ownerId);
        return roomService.roomSummary(projectId, true);
    }

    @DeleteMapping("/collab/session")
    public Map<String, Object> closeCollabSession(@PathVariable("projectId") String projectId) {
        Optional<ProjectState> existing = projectAccess.findOrRehydrate(projectId);
        existing.ifPresent(p -> projectAccess.requireWriteAccess(p,
                "Only the project owner can close the collaboration session."));
        boolean closed = roomService.closeRoom(projectId);
        return Map.of("project_id", projectId, "active", false, "closed", closed);
    }

    @GetMapping("/comments")
    public Map<String, Object> listStudioComments(
            @PathVariable("projectId") String projectId,
            @RequestParam(value = "collab", required = false) String collabCode
    ) {
        Optional<ProjectState> existing = projectAccess.findOrRehydrate(projectId);
        if (!roomService.isValidInvite(projectId, collabCode)) {
            existing.ifPresent(p -> projectAccess.requireReadAccess(p,
                    "You do not have permission to view bar notes on this private project."));
        }
        List<Map<String, Object>> items = cloudDb.listStudioBarComments(projectId).stream()
                .map(CollabController::toBarCommentMap)
                .toList();
        return Map.of("project_id", projectId, "items", items);
    }

    @PostMapping("/comments")
    public Map<String, Object> addStudioComment(
            @PathVariable("projectId") String projectId,
            @RequestParam(value = "collab", required = false) String collabCode,
            @RequestBody Map<String, Object> body
    ) {
        Optional<ProjectState> existing = projectAccess.findOrRehydrate(projectId);
        boolean isInvited = roomService.isValidInvite(projectId, collabCode);
        if (!isInvited) {
            existing.ifPresent(p -> projectAccess.requireWriteAccess(p,
                    "You need ownership or an active collab invite to add bar notes."));
        }
        String text = body != null && body.get("text") instanceof String s ? s.trim() : "";
        if (text.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Comment text is required.");
        }
        if (text.length() > 500) {
            text = text.substring(0, 500);
        }
        int barNumber = body.get("bar_number") instanceof Number n ? Math.max(1, Math.min(256, n.intValue())) : 1;
        String trackId = body.get("track_id") instanceof String t && !t.isBlank() ? t.trim() : null;

        UserPrincipal caller = AuthContextHolder.get();
        String authorId = caller.isGuest() ? "guest" : caller.userId();
        String customName = body.get("author_name") instanceof String an && !an.isBlank() ? an.trim() : null;
        String authorName = caller.isGuest() ? (customName != null ? customName : "Guest Studio") : caller.displayName();

        CloudDatabaseService.StudioBarCommentRecord rec = cloudDb.addStudioBarComment(
                projectId, barNumber, trackId, authorId, authorName, text
        );
        Map<String, Object> dto = toBarCommentMap(rec);
        roomService.broadcast(projectId, Map.of(
                "type", "bar_comment_event",
                "action", "added",
                "project_id", projectId,
                "comment", dto
        ), null);
        return dto;
    }

    @PatchMapping("/comments/{commentId}")
    public Map<String, Object> resolveStudioComment(
            @PathVariable("projectId") String projectId,
            @PathVariable("commentId") String commentId,
            @RequestParam(value = "collab", required = false) String collabCode,
            @RequestBody(required = false) Map<String, Object> body
    ) {
        Optional<ProjectState> existing = projectAccess.findOrRehydrate(projectId);
        if (!roomService.isValidInvite(projectId, collabCode)) {
            existing.ifPresent(p -> projectAccess.requireWriteAccess(p,
                    "You do not have permission to update bar notes on this project."));
        }
        CloudDatabaseService.StudioBarCommentRecord rec = cloudDb.findStudioBarComment(commentId)
                .filter(c -> projectId.equals(c.projectId()))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Comment not found."));
        boolean nextResolved = body != null && body.containsKey("resolved")
                ? Boolean.TRUE.equals(body.get("resolved"))
                : !rec.resolved();
        CloudDatabaseService.StudioBarCommentRecord updated = cloudDb.setStudioBarCommentResolved(commentId, nextResolved)
                .orElse(rec);
        Map<String, Object> dto = toBarCommentMap(updated);
        roomService.broadcast(projectId, Map.of(
                "type", "bar_comment_event",
                "action", "updated",
                "project_id", projectId,
                "comment", dto
        ), null);
        return dto;
    }

    @DeleteMapping("/comments/{commentId}")
    public Map<String, Object> deleteStudioComment(
            @PathVariable("projectId") String projectId,
            @PathVariable("commentId") String commentId,
            @RequestParam(value = "collab", required = false) String collabCode
    ) {
        Optional<ProjectState> existing = projectAccess.findOrRehydrate(projectId);
        CloudDatabaseService.StudioBarCommentRecord rec = cloudDb.findStudioBarComment(commentId)
                .filter(c -> projectId.equals(c.projectId()))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Comment not found."));
        String callerId = AuthContextHolder.getOwnerId();
        boolean isCommentAuthor = !callerId.equals("guest") && callerId.equals(rec.authorId());
        boolean isOwner = existing.map(this::callerIsOwner).orElse(true);
        boolean isInvitedGuestComment = roomService.isValidInvite(projectId, collabCode) && "guest".equals(rec.authorId());
        if (!isCommentAuthor && !isOwner && !isInvitedGuestComment) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Cannot delete another creator's comment.");
        }
        cloudDb.deleteStudioBarComment(commentId);
        roomService.broadcast(projectId, Map.of(
                "type", "bar_comment_event",
                "action", "deleted",
                "project_id", projectId,
                "comment_id", commentId
        ), null);
        return Map.of("status", "deleted", "comment_id", commentId);
    }

    private boolean callerIsOwner(ProjectState p) {
        String owner = p.getOwnerId();
        String caller = AuthContextHolder.getOwnerId();
        return owner == null || owner.isBlank() || "guest".equals(owner) || owner.equals(caller);
    }

    public static Map<String, Object> toBarCommentMap(CloudDatabaseService.StudioBarCommentRecord r) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", r.id());
        out.put("project_id", r.projectId());
        out.put("bar_number", r.barNumber());
        out.put("track_id", r.trackId());
        out.put("author_id", r.authorId());
        out.put("author_name", r.authorName());
        out.put("text", r.text());
        out.put("resolved", r.resolved());
        out.put("created_at", r.createdAt());
        return out;
    }
}
