package com.aimusic.studio.collab;

import com.aimusic.studio.cloud.CloudProjectAccessService;
import com.aimusic.studio.cloud.JwtService;
import com.aimusic.studio.cloud.UserPrincipal;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.store.ProjectStateStore;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import org.springframework.web.util.UriComponentsBuilder;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * WebSocket handler for /ws/collab enabling realtime multi-user presence, cursor/bar tracking,
 * transport cues, and ProjectState synchronization inside Studio.
 */
@Component
public class CollabWebSocketHandler extends TextWebSocketHandler {

    private record SessionContext(String projectId, String clientId, String userId, String displayName, String role) {}

    private final CollabRoomService roomService;
    private final JwtService jwtService;
    private final CloudProjectAccessService projectAccess;
    private final ProjectStateStore store;
    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<String, SessionContext> sessionContexts = new ConcurrentHashMap<>();

    public CollabWebSocketHandler(
            CollabRoomService roomService,
            JwtService jwtService,
            CloudProjectAccessService projectAccess,
            ProjectStateStore store,
            ObjectMapper objectMapper
    ) {
        this.roomService = roomService;
        this.jwtService = jwtService;
        this.projectAccess = projectAccess;
        this.store = store;
        this.objectMapper = objectMapper;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        session.setTextMessageSizeLimit(2 * 1024 * 1024);
        session.setBinaryMessageSizeLimit(2 * 1024 * 1024);
        if (session.getUri() == null) {
            session.close(CloseStatus.BAD_DATA);
            return;
        }
        Map<String, String> params = UriComponentsBuilder.fromUri(session.getUri()).build().getQueryParams().toSingleValueMap();
        String projectId = trimOrNull(params.get("projectId"));
        String roomCode = trimOrNull(params.get("room"));
        String token = trimOrNull(params.get("token"));
        String reqClientId = trimOrNull(params.get("clientId"));
        String reqDisplayName = trimOrNull(params.get("displayName"));

        if (projectId == null) {
            roomService.sendDirect(session, Map.of("type", "error", "detail", "Missing projectId parameter."));
            session.close(CloseStatus.BAD_DATA);
            return;
        }

        UserPrincipal principal = UserPrincipal.GUEST;
        if (token != null) {
            Optional<UserPrincipal> verified = jwtService.verifyToken(token);
            if (verified.isEmpty()) {
                roomService.sendDirect(session, Map.of("type", "error", "detail", "Invalid or revoked JWT token."));
                session.close(CloseStatus.POLICY_VIOLATION);
                return;
            }
            principal = verified.get();
        }

        Optional<ProjectState> existing = projectAccess.findOrRehydrate(projectId);
        String ownerId = existing.map(ProjectState::getOwnerId).orElse(principal.isGuest() ? "guest" : principal.userId());
        boolean isOwner = !principal.isGuest() && ownerId != null && ownerId.equals(principal.userId());
        boolean isGuestOwned = ownerId == null || ownerId.isBlank() || "guest".equals(ownerId);
        boolean isPublic = existing.map(p -> "public".equalsIgnoreCase(p.getVisibility())).orElse(false);
        boolean hasInvite = roomService.isValidInvite(projectId, roomCode);

        if (ownerId != null && ownerId.startsWith("u_") && !isOwner && !isPublic && !hasInvite) {
            roomService.sendDirect(session, Map.of("type", "error", "detail", "Valid collaboration invite required for private cloud session."));
            session.close(CloseStatus.POLICY_VIOLATION);
            return;
        }
        if (roomCode != null && !hasInvite && !isOwner) {
            roomService.sendDirect(session, Map.of("type", "error", "detail", "Collaboration room code is invalid or expired."));
            session.close(CloseStatus.POLICY_VIOLATION);
            return;
        }

        String clientId = reqClientId != null ? reqClientId : "cli_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        String effectiveName = !principal.isGuest()
                ? principal.displayName()
                : (reqDisplayName != null ? reqDisplayName : "Guest Studio");

        CollabRoomService.PeerPresence peer = roomService.joinPeer(
                projectId,
                isGuestOwned && !principal.isGuest() ? principal.userId() : ownerId,
                clientId,
                principal.userId(),
                effectiveName,
                principal.role(),
                session
        );
        sessionContexts.put(session.getId(), new SessionContext(projectId, clientId, principal.userId(), effectiveName, principal.role()));

        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("type", "room_snapshot");
        snapshot.put("project_id", projectId);
        snapshot.put("client_id", clientId);
        snapshot.put("self", peer.toMap());
        snapshot.put("members", roomService.listMembers(projectId));
        snapshot.put("track_locks", roomService.listTrackLocks(projectId));
        snapshot.put("chat_history", roomService.listChatHistory(projectId));
        snapshot.put("revision", roomService.findRoom(projectId).map(r -> r.revision.get()).orElse(1L));
        roomService.sendDirect(session, snapshot);

        roomService.broadcast(projectId, Map.of(
                "type", "presence",
                "project_id", projectId,
                "members", roomService.listMembers(projectId)
        ), session.getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        SessionContext ctx = sessionContexts.get(session.getId());
        if (ctx == null) return;
        Map<String, Object> msg;
        try {
            msg = objectMapper.readValue(message.getPayload(), new TypeReference<>() {});
        } catch (Exception ex) {
            return;
        }
        String type = msg.get("type") != null ? msg.get("type").toString() : "";
        switch (type) {
            case "ping" -> roomService.sendDirect(session, Map.of("type", "pong"));
            case "cursor" -> {
                roomService.findRoom(ctx.projectId()).ifPresent(room -> {
                    CollabRoomService.PeerPresence p = room.peers.get(session.getId());
                    if (p != null) {
                        if (msg.get("bar") instanceof Number n) p.bar = Math.max(1, n.intValue());
                        if (msg.get("track_id") instanceof String t && !t.isBlank()) p.trackId = t;
                        if (msg.get("active_tab") instanceof String tab && !tab.isBlank()) p.activeTab = tab;
                    }
                });
                roomService.broadcast(ctx.projectId(), Map.of(
                        "type", "presence",
                        "project_id", ctx.projectId(),
                        "members", roomService.listMembers(ctx.projectId())
                ), null);
            }
            case "track_lock" -> {
                String trackId = msg.get("track_id") instanceof String s ? s.trim() : "";
                boolean locked = Boolean.TRUE.equals(msg.get("locked"));
                roomService.findRoom(ctx.projectId()).ifPresent(room -> {
                    CollabRoomService.PeerPresence peer = room.peers.get(session.getId());
                    if (peer == null) return;
                    Optional<String> err = roomService.trySetTrackLock(ctx.projectId(), peer, trackId, locked);
                    if (err.isPresent()) {
                        roomService.sendDirect(session, Map.of("type", "error", "detail", err.get()));
                    } else {
                        roomService.broadcast(ctx.projectId(), Map.of(
                                "type", "track_locks",
                                "project_id", ctx.projectId(),
                                "track_locks", roomService.listTrackLocks(ctx.projectId())
                        ), null);
                    }
                });
            }
            case "room_chat" -> {
                String rawText = msg.get("text") instanceof String s ? s.trim() : "";
                if (rawText.isBlank()) return;
                if (rawText.length() > 400) rawText = rawText.substring(0, 400);
                final String safeText = rawText;
                roomService.findRoom(ctx.projectId()).ifPresent(room -> {
                    CollabRoomService.PeerPresence peer = room.peers.get(session.getId());
                    if (peer == null) return;
                    Map<String, Object> chatMsg = roomService.appendChatMessage(ctx.projectId(), peer, safeText);
                    roomService.broadcast(ctx.projectId(), Map.of(
                            "type", "room_chat",
                            "project_id", ctx.projectId(),
                            "message", chatMsg
                    ), null);
                });
            }
            case "transport_cue" -> {
                Map<String, Object> cue = new LinkedHashMap<>();
                cue.put("type", "transport_cue");
                cue.put("project_id", ctx.projectId());
                cue.put("client_id", ctx.clientId());
                cue.put("display_name", ctx.displayName());
                cue.put("playing", Boolean.TRUE.equals(msg.get("playing")));
                if (msg.get("bar") instanceof Number n) cue.put("bar", n.intValue());
                roomService.broadcast(ctx.projectId(), cue, session.getId());
            }
            case "state_sync" -> {
                Object stateObj = msg.get("state");
                if (stateObj == null) return;
                long rev = roomService.bumpRevision(ctx.projectId());
                try {
                    ProjectState incoming = objectMapper.convertValue(stateObj, ProjectState.class);
                    Optional<ProjectState> existing = projectAccess.findOrRehydrate(ctx.projectId());
                    incoming.setProjectId(ctx.projectId());
                    existing.ifPresent(prev -> {
                        incoming.setOwnerId(prev.getOwnerId());
                        incoming.setVisibility(prev.getVisibility());
                        incoming.setShareSlug(prev.getShareSlug());
                        incoming.setPublishedAt(prev.getPublishedAt());
                    });
                    ProjectState saved = store.saveProject(incoming);
                    projectAccess.mirrorToCloud(saved, null);

                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("type", "state_sync");
                    out.put("project_id", ctx.projectId());
                    out.put("client_id", ctx.clientId());
                    out.put("display_name", ctx.displayName());
                    out.put("revision", rev);
                    out.put("state", saved);
                    roomService.broadcast(ctx.projectId(), out, session.getId());
                } catch (Exception ignored) {
                }
            }
            default -> {
            }
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        SessionContext ctx = sessionContexts.remove(session.getId());
        if (ctx != null) {
            roomService.leavePeer(ctx.projectId(), session.getId());
            roomService.broadcast(ctx.projectId(), Map.of(
                    "type", "presence",
                    "project_id", ctx.projectId(),
                    "members", roomService.listMembers(ctx.projectId())
            ), session.getId());
            roomService.broadcast(ctx.projectId(), Map.of(
                    "type", "track_locks",
                    "project_id", ctx.projectId(),
                    "track_locks", roomService.listTrackLocks(ctx.projectId())
            ), session.getId());
        }
    }

    private static String trimOrNull(String v) {
        return (v != null && !v.isBlank()) ? v.trim() : null;
    }
}
