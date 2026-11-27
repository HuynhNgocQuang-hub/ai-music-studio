package com.aimusic.studio.collab;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * In-memory WebSocket room coordinator for realtime Studio collaboration:
 * invite links (room_code), peer presence/cursor tracking, per-track soft locks,
 * live room chat, state sync, and live bar notes.
 */
@Service
public class CollabRoomService {

    private static final String[] PEER_COLORS = {
            "#f59e0b", "#10b981", "#38bdf8", "#a855f7", "#fb7185", "#2dd4bf"
    };

    public record TrackLockInfo(
            String trackId,
            String clientId,
            String userId,
            String displayName,
            String color,
            String lockedAt
    ) {
        public Map<String, Object> toMap() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("track_id", trackId);
            out.put("client_id", clientId);
            out.put("user_id", userId);
            out.put("display_name", displayName);
            out.put("color", color);
            out.put("locked_at", lockedAt);
            return out;
        }
    }

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
        public final ConcurrentHashMap<String, TrackLockInfo> trackLocks = new ConcurrentHashMap<>();
        public final List<Map<String, Object>> chatHistory = Collections.synchronizedList(new ArrayList<>());

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
        removed.trackLocks.clear();
        removed.chatHistory.clear();
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
        PeerPresence removed = room.peers.remove(sessionId);
        if (removed != null) {
            boolean otherSameClient = room.peers.values().stream()
                    .anyMatch(p -> removed.clientId.equals(p.clientId));
            if (!otherSameClient) {
                room.trackLocks.entrySet().removeIf(e -> removed.clientId.equals(e.getValue().clientId()));
            }
        }
        return Optional.of(room);
    }

    public synchronized Optional<String> trySetTrackLock(
            String projectId,
            PeerPresence peer,
            String trackId,
            boolean locked
    ) {
        if (trackId == null || trackId.isBlank()) {
            return Optional.of("Missing track_id.");
        }
        RoomState room = roomsByProject.get(projectId);
        if (room == null) return Optional.of("Collaboration room not found.");
        String key = trackId.trim();
        TrackLockInfo current = room.trackLocks.get(key);
        if (locked) {
            if (current != null && !current.clientId().equals(peer.clientId)) {
                return Optional.of("Track '" + key + "' đang được khóa bởi " + current.displayName() + ".");
            }
            room.trackLocks.put(key, new TrackLockInfo(
                    key, peer.clientId, peer.userId, peer.displayName, peer.color, Instant.now().toString()
            ));
            return Optional.empty();
        }
        if (current != null) {
            boolean isHolder = current.clientId().equals(peer.clientId);
            boolean isRoomOwner = room.ownerId != null && !room.ownerId.equals("guest") && room.ownerId.equals(peer.userId);
            if (!isHolder && !isRoomOwner) {
                return Optional.of("Chỉ " + current.displayName() + " hoặc chủ phòng mới có thể mở khóa track '" + key + "'.");
            }
            room.trackLocks.remove(key);
        }
        return Optional.empty();
    }

    public Map<String, Object> listTrackLocks(String projectId) {
        RoomState room = roomsByProject.get(projectId);
        if (room == null) return Map.of();
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, TrackLockInfo> e : room.trackLocks.entrySet()) {
            out.put(e.getKey(), e.getValue().toMap());
        }
        return out;
    }

    public Map<String, Object> appendChatMessage(String projectId, PeerPresence peer, String text) {
        RoomState room = roomsByProject.get(projectId);
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("id", "msg_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10));
        msg.put("project_id", projectId);
        msg.put("client_id", peer.clientId);
        msg.put("user_id", peer.userId);
        msg.put("display_name", peer.displayName);
        msg.put("color", peer.color);
        msg.put("text", text);
        msg.put("created_at", Instant.now().toString());
        if (room != null) {
            synchronized (room.chatHistory) {
                room.chatHistory.add(msg);
                while (room.chatHistory.size() > 50) {
                    room.chatHistory.remove(0);
                }
            }
        }
        return msg;
    }

    public List<Map<String, Object>> listChatHistory(String projectId) {
        RoomState room = roomsByProject.get(projectId);
        if (room == null) return List.of();
        synchronized (room.chatHistory) {
            return new ArrayList<>(room.chatHistory);
        }
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
        out.put("track_locks", room != null ? listTrackLocks(projectId) : Map.of());
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
