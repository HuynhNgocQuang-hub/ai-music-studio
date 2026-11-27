package com.aimusic.studio.collab;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * In-memory WebSocket room coordinator for Phase 9 realtime Studio collaboration:
 * invite links (room_code), peer presence/cursor tracking, state sync, and live bar notes.
 */
@Service
public class CollabRoomService {

    private static final String[] PEER_COLORS = {
            "#f59e0b", "#10b981", "#38bdf8", "#a855f7", "#fb7185", "#2dd4bf"
    };

    public static class PeerPresence {
        public final String sessionId;
        public final String clientId;
        public final String userId;
        public final String displayName;
        public final String role;
        public final String color;
        public final WebSocketSession wsSession;
        public volatile int bar = 1;
        public volatile String trackId = "vocal";
        public volatile String activeTab = "sequencer";
        public final String joinedAt = Instant.now().toString();

        PeerPresence(
                String sessionId,
                String clientId,
                String userId,
                String displayName,
                String role,
                String color,
                WebSocketSession wsSession
        ) {
            this.sessionId = sessionId;
            this.clientId = clientId;
            this.userId = userId;
            this.displayName = displayName;
            this.role = role;
            this.color = color;
            this.wsSession = wsSession;
        }

        public Map<String, Object> toMap() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("client_id", clientId);
            out.put("user_id", userId);
            out.put("display_name", displayName);
            out.put("role", role);
            out.put("color", color);
            out.put("bar", bar);
            out.put("track_id", trackId);
            out.put("active_tab", activeTab);
            out.put("joined_at", joinedAt);
            return out;
        }
    }

    public static class RoomState {
        public final String projectId;
        public final String ownerId;
        public volatile String roomCode;
        public final AtomicLong revision = new AtomicLong(1);
        public final ConcurrentHashMap<String, PeerPresence> peers = new ConcurrentHashMap<>();

        RoomState(String projectId, String ownerId, String roomCode) {
            this.projectId = projectId;
            this.ownerId = ownerId;
            this.roomCode = roomCode;
        }
    }

    private final ConcurrentHashMap<String, RoomState> roomsByProject = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper;

    public CollabRoomService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public RoomState openOrGetRoom(String projectId, String ownerId) {
        return roomsByProject.compute(projectId, (pid, existing) -> {
            if (existing != null && existing.roomCode != null && !existing.roomCode.isBlank()) {
                return existing;
            }
            String code = "col_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            return new RoomState(pid, ownerId != null ? ownerId : "guest", code);
        });
    }

    public Optional<RoomState> findRoom(String projectId) {
        if (projectId == null || projectId.isBlank()) return Optional.empty();
        return Optional.ofNullable(roomsByProject.get(projectId));
    }

    public boolean isValidInvite(String projectId, String roomCode) {
        if (projectId == null || roomCode == null || roomCode.isBlank()) return false;
        RoomState room = roomsByProject.get(projectId);
        return room != null && room.roomCode != null && room.roomCode.equals(roomCode.trim());
    }

    public boolean closeRoom(String projectId) {
        RoomState removed = roomsByProject.remove(projectId);
        if (removed == null) return false;
        Map<String, Object> closePayload = Map.of("type", "room_closed", "project_id", projectId);
        broadcastPayload(removed, closePayload, null);
        for (PeerPresence peer : removed.peers.values()) {
            try {
                if (peer.wsSession != null && peer.wsSession.isOpen()) {
                    peer.wsSession.close(CloseStatus.NORMAL);
                }
            } catch (IOException ignored) {
            }
        }
        removed.peers.clear();
        return true;
    }

    public PeerPresence joinPeer(
            String projectId,
            String ownerId,
            String clientId,
            String userId,
            String displayName,
            String role,
            WebSocketSession wsSession
    ) {
        RoomState room = openOrGetRoom(projectId, ownerId);
        String color = PEER_COLORS[Math.abs((userId + clientId).hashCode()) % PEER_COLORS.length];
        PeerPresence peer = new PeerPresence(
                wsSession.getId(),
                clientId,
                userId,
                (displayName != null && !displayName.isBlank()) ? displayName : "Producer",
                role != null ? role : "guest",
                color,
                wsSession
        );
        room.peers.put(wsSession.getId(), peer);
        return peer;
    }

    public Optional<RoomState> leavePeer(String projectId, String sessionId) {
        RoomState room = roomsByProject.get(projectId);
        if (room == null) return Optional.empty();
        room.peers.remove(sessionId);
        return Optional.of(room);
    }

    public long bumpRevision(String projectId) {
        RoomState room = roomsByProject.get(projectId);
        return room != null ? room.revision.incrementAndGet() : 1L;
    }

    public List<Map<String, Object>> listMembers(String projectId) {
        RoomState room = roomsByProject.get(projectId);
        if (room == null) return List.of();
        List<Map<String, Object>> list = new ArrayList<>();
        for (PeerPresence p : room.peers.values()) {
            list.add(p.toMap());
        }
        return list;
    }

    public Map<String, Object> roomSummary(String projectId, boolean includeSecretCode) {
        RoomState room = roomsByProject.get(projectId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("project_id", projectId);
        out.put("active", room != null);
        out.put("peer_count", room != null ? room.peers.size() : 0);
        out.put("members", room != null ? listMembers(projectId) : List.of());
        out.put("revision", room != null ? room.revision.get() : 0L);
        if (room != null && includeSecretCode) {
            out.put("room_code", room.roomCode);
            out.put("invite_url", "/studio/" + projectId + "?collab=" + room.roomCode);
        }
        return out;
    }

    public void broadcast(String projectId, Map<String, Object> payload, String excludeSessionId) {
        RoomState room = roomsByProject.get(projectId);
        if (room != null) {
            broadcastPayload(room, payload, excludeSessionId);
        }
    }

    public void sendDirect(WebSocketSession session, Map<String, Object> payload) {
        if (session == null || !session.isOpen()) return;
        try {
            String json = objectMapper.writeValueAsString(payload);
            synchronized (session) {
                if (session.isOpen()) {
                    session.sendMessage(new TextMessage(json));
                }
            }
        } catch (IOException ignored) {
        }
    }

    private void broadcastPayload(RoomState room, Map<String, Object> payload, String excludeSessionId) {
        String json;
        try {
            json = objectMapper.writeValueAsString(payload);
        } catch (Exception ex) {
            return;
        }
        TextMessage msg = new TextMessage(json);
        for (PeerPresence peer : room.peers.values()) {
            if (excludeSessionId != null && excludeSessionId.equals(peer.sessionId)) continue;
            WebSocketSession s = peer.wsSession;
            if (s != null && s.isOpen()) {
                try {
                    synchronized (s) {
                        if (s.isOpen()) {
                            s.sendMessage(msg);
                        }
                    }
                } catch (IOException ignored) {
                }
            }
        }
    }
}
