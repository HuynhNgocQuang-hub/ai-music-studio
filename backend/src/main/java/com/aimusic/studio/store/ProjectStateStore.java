package com.aimusic.studio.store;

import com.aimusic.studio.config.AppProperties;
import com.aimusic.studio.model.AudioClip;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.TrackState;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.connection.RedisConnection;
import org.springframework.data.redis.core.Cursor;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.core.ScanOptions;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

@Service
public class ProjectStateStore {

    private static final Logger log = LoggerFactory.getLogger(ProjectStateStore.class);
    private static final int DEFAULT_MAX_UNDO = 50;

    private record MemoryEntry(byte[] data, long expiresAtNanos) {
        boolean isExpired(long nowNanos) {
            return expiresAtNanos > 0L && nowNanos >= expiresAtNanos;
        }
    }

    public record PagedProjects(List<ProjectState> items, int total) {}

    private final ObjectMapper objectMapper;
    private final long projectTtlSeconds;
    private final long audioTtlSeconds;
    private final RedisTemplate<String, byte[]> redisTemplate;
    private final AtomicBoolean redisAvailable = new AtomicBoolean(false);
    private final AtomicLong lastRedisFailureNanos = new AtomicLong(0L);
    private volatile long redisRetryIntervalNanos = TimeUnit.SECONDS.toNanos(5);

    private final ConcurrentHashMap<String, MemoryEntry> memoryData = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Deque<String>> memoryLists = new ConcurrentHashMap<>();

    @Autowired
    public ProjectStateStore(
            ObjectMapper objectMapper,
            AppProperties properties,
            @Autowired(required = false) RedisTemplate<String, byte[]> redisTemplate
    ) {
        this.objectMapper = objectMapper;
        this.projectTtlSeconds = properties.getProjectTtlSeconds();
        this.audioTtlSeconds = properties.getAudioTtlSeconds();
        this.redisTemplate = redisTemplate;
        probeRedis();
    }

    public ProjectStateStore(ObjectMapper objectMapper, long projectTtlSeconds, long audioTtlSeconds, boolean forceMemory) {
        this.objectMapper = objectMapper;
        this.projectTtlSeconds = projectTtlSeconds;
        this.audioTtlSeconds = audioTtlSeconds;
        this.redisTemplate = null;
        this.redisAvailable.set(false);
    }

    private void probeRedis() {
        if (redisTemplate == null) {
            redisAvailable.set(false);
            return;
        }
        try {
            String pong = redisTemplate.execute((RedisCallback<String>) RedisConnection::ping);
            boolean ok = pong != null && !pong.isBlank();
            if (ok) {
                markRedisUp();
                log.info("Connected to Redis state store.");
            } else {
                redisAvailable.set(false);
            }
        } catch (Exception ex) {
            markRedisDown(ex);
            log.info("Redis unreachable ({}); using In-Memory ConcurrentHashMap TTL fallback.", ex.getMessage());
        }
    }

    private boolean shouldUseRedis() {
        if (redisTemplate == null) {
            return false;
        }
        if (redisAvailable.get()) {
            return true;
        }
        long lastFail = lastRedisFailureNanos.get();
        long now = System.nanoTime();
        if (lastFail == 0L || (now - lastFail) >= redisRetryIntervalNanos) {
            return lastRedisFailureNanos.compareAndSet(lastFail, now);
        }
        return false;
    }

    private void markRedisUp() {
        lastRedisFailureNanos.set(0L);
        if (redisAvailable.compareAndSet(false, true)) {
            log.info("Redis connection recovered; resuming Redis state store.");
        }
    }

    private void markRedisDown(Exception ex) {
        lastRedisFailureNanos.set(System.nanoTime());
        if (redisAvailable.compareAndSet(true, false)) {
            log.warn("Redis error ({}); falling back to in-memory TTL store.", ex.getMessage());
        }
    }

    public boolean isRedisAvailable() {
        return redisAvailable.get();
    }

    public void setRedisRetryIntervalMs(long retryIntervalMs) {
        this.redisRetryIntervalNanos = TimeUnit.MILLISECONDS.toNanos(Math.max(0L, retryIntervalMs));
    }

    private void memSet(String key, byte[] value, long ttlSeconds) {
        long exp = ttlSeconds > 0 ? System.nanoTime() + Duration.ofSeconds(ttlSeconds).toNanos() : -1L;
        memoryData.put(key, new MemoryEntry(value, exp));
    }

    private byte[] memGet(String key) {
        MemoryEntry entry = memoryData.get(key);
        if (entry == null) {
            return null;
        }
        if (entry.isExpired(System.nanoTime())) {
            memoryData.remove(key, entry);
            return null;
        }
        return entry.data();
    }

    private boolean memDelete(String key) {
        boolean existed = memoryData.remove(key) != null;
        existed = (memoryLists.remove(key) != null) || existed;
        return existed;
    }

    private List<String> memKeys(String prefix) {
        long now = System.nanoTime();
        List<String> result = new ArrayList<>();
        for (Map.Entry<String, MemoryEntry> e : memoryData.entrySet()) {
            if (e.getValue().isExpired(now)) {
                memoryData.remove(e.getKey(), e.getValue());
            } else if (e.getKey().startsWith(prefix)) {
                result.add(e.getKey());
            }
        }
        return result;
    }

    // --- Project CRUD & Pagination ---

    public ProjectState saveProject(ProjectState project) {
        return saveProject(project, null);
    }

    public ProjectState saveProject(ProjectState project, Long ttlSeconds) {
        project.setUpdatedAt(Instant.now().toString());
        if (project.getCreatedAt() == null || project.getCreatedAt().isBlank()) {
            project.setCreatedAt(project.getUpdatedAt());
        }
        if (project.getConfig() != null) {
            if (project.getTitle() == null || project.getTitle().isBlank()) {
                project.setTitle(project.getConfig().getTitle());
            } else if (project.getConfig().getTitle() == null || project.getConfig().getTitle().isBlank()) {
                project.getConfig().setTitle(project.getTitle());
            }
        }

        long exp = ttlSeconds != null ? ttlSeconds : projectTtlSeconds;
        String key = "project:" + project.getProjectId();
        try {
            byte[] payload = objectMapper.writeValueAsBytes(project);
            if (shouldUseRedis()) {
                try {
                    if (exp > 0) {
                        redisTemplate.opsForValue().set(key, payload, Duration.ofSeconds(exp));
                    } else {
                        redisTemplate.opsForValue().set(key, payload);
                    }
                    // Keep short hot-failover copy so transient mid-request Redis timeouts never 404
                    memSet(key, payload, exp > 0 ? Math.min(exp, 30L) : 30L);
                    markRedisUp();
                    return project;
                } catch (Exception ex) {
                    markRedisDown(ex);
                }
            }
            memSet(key, payload, exp);
            return project;
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to serialize ProjectState", ex);
        }
    }

    public Optional<ProjectState> getProject(String projectId) {
        if (projectId == null || projectId.isBlank()) {
            return Optional.empty();
        }
        String key = "project:" + projectId;
        byte[] raw = null;
        if (shouldUseRedis()) {
            try {
                raw = redisTemplate.opsForValue().get(key);
                markRedisUp();
            } catch (Exception ex) {
                markRedisDown(ex);
            }
        }
        if (raw == null) {
            raw = memGet(key);
        }
        if (raw == null) {
            return Optional.empty();
        }
        try {
            return Optional.of(objectMapper.readValue(raw, ProjectState.class));
        } catch (Exception ex) {
            log.warn("Failed to deserialize project {}: {}", projectId, ex.getMessage());
            return Optional.empty();
        }
    }

    public boolean deleteProject(String projectId) {
        String key = "project:" + projectId;
        String undoKey = "undo:" + projectId;
        boolean deleted = memDelete(key);
        memDelete(undoKey);
        if (shouldUseRedis()) {
            try {
                Long count = redisTemplate.delete(List.of(key, undoKey));
                markRedisUp();
                deleted = deleted || (count != null && count > 0);
            } catch (Exception ex) {
                markRedisDown(ex);
            }
        }
        return deleted;
    }

    public PagedProjects listProjects(int page, int limit, String search, String genre, String keyFilter) {
        Set<String> keys = new LinkedHashSet<>();
        if (shouldUseRedis()) {
            try {
                Set<String> scanned = scanKeys("project:*");
                markRedisUp();
                keys.addAll(scanned);
            } catch (Exception ex) {
                markRedisDown(ex);
            }
        }
        keys.addAll(memKeys("project:"));

        List<ProjectState> all = new ArrayList<>();
        for (String k : keys) {
            String pid = k.substring("project:".length());
            getProject(pid).ifPresent(all::add);
        }

        String q = search != null ? search.trim().toLowerCase(Locale.ROOT) : "";
        String g = genre != null ? genre.trim().toLowerCase(Locale.ROOT) : "";
        String kf = keyFilter != null ? keyFilter.trim().toLowerCase(Locale.ROOT) : "";

        List<ProjectState> filtered = new ArrayList<>();
        for (ProjectState p : all) {
            String pTitle = p.getConfig() != null && p.getConfig().getTitle() != null
                    ? p.getConfig().getTitle().toLowerCase(Locale.ROOT) : "";
            String pGenre = p.getConfig() != null && p.getConfig().getGenre() != null
                    ? p.getConfig().getGenre().toLowerCase(Locale.ROOT) : "";
            String pId = p.getProjectId() != null ? p.getProjectId().toLowerCase(Locale.ROOT) : "";
            String pKey = p.getAnalysis() != null && p.getAnalysis().getDetectedKey() != null
                    ? p.getAnalysis().getDetectedKey().toLowerCase(Locale.ROOT) : "";

            if (!q.isEmpty() && !pTitle.contains(q) && !pId.contains(q) && !pGenre.contains(q)) {
                continue;
            }
            if (!g.isEmpty() && !pGenre.equals(g)) {
                continue;
            }
            if (!kf.isEmpty() && !pKey.equals(kf)) {
                continue;
            }
            filtered.add(p);
        }

        filtered.sort(Comparator.comparing(
                (ProjectState p) -> p.getUpdatedAt() != null ? p.getUpdatedAt() : "",
                Comparator.reverseOrder()
        ));

        int total = filtered.size();
        int safeLimit = Math.max(1, Math.min(limit, 100));
        int totalPages = total > 0 ? Math.max(1, (int) Math.ceil((double) total / safeLimit)) : 1;
        int safePage = Math.max(1, Math.min(page, totalPages));
        int start = (safePage - 1) * safeLimit;
        int end = Math.min(total, start + safeLimit);
        List<ProjectState> pageItems = start < end ? filtered.subList(start, end) : List.of();
        return new PagedProjects(pageItems, total);
    }

    // --- Undo History (max 50 snapshots) ---

    public void pushUndo(String projectId, ProjectState snapshot) {
        pushUndo(projectId, snapshot, DEFAULT_MAX_UNDO);
    }

    public void pushUndo(String projectId, ProjectState snapshot, int maxHistory) {
        int cap = Math.max(1, maxHistory);
        String undoKey = "undo:" + projectId;
        try {
            String json = objectMapper.writeValueAsString(snapshot);
            if (shouldUseRedis()) {
                try {
                    redisTemplate.opsForList().leftPush(undoKey, json.getBytes(StandardCharsets.UTF_8));
                    redisTemplate.opsForList().trim(undoKey, 0, cap - 1L);
                    if (projectTtlSeconds > 0) {
                        redisTemplate.expire(undoKey, Duration.ofSeconds(projectTtlSeconds));
                    }
                    markRedisUp();
                    return;
                } catch (Exception ex) {
                    markRedisDown(ex);
                }
            }
            Deque<String> deque = memoryLists.computeIfAbsent(undoKey, k -> new ConcurrentLinkedDeque<>());
            synchronized (deque) {
                deque.addFirst(json);
                while (deque.size() > cap) {
                    deque.removeLast();
                }
            }
        } catch (Exception ex) {
            log.warn("Failed to push undo snapshot for {}: {}", projectId, ex.getMessage());
        }
    }

    public Optional<ProjectState> popUndo(String projectId) {
        String undoKey = "undo:" + projectId;
        String raw = null;
        if (shouldUseRedis()) {
            try {
                byte[] bytes = redisTemplate.opsForList().leftPop(undoKey);
                markRedisUp();
                if (bytes != null) {
                    raw = new String(bytes, StandardCharsets.UTF_8);
                }
            } catch (Exception ex) {
                markRedisDown(ex);
            }
        }
        if (raw == null) {
            Deque<String> deque = memoryLists.get(undoKey);
            if (deque != null) {
                synchronized (deque) {
                    raw = deque.pollFirst();
                }
            }
        }
        if (raw == null) {
            return Optional.empty();
        }
        try {
            ProjectState restored = objectMapper.readValue(raw, ProjectState.class);
            return Optional.of(saveProject(restored));
        } catch (Exception ex) {
            log.warn("Failed to restore undo snapshot for {}: {}", projectId, ex.getMessage());
            return Optional.empty();
        }
    }

    // --- Audio Asset Bytes (mem://...) ---

    public String saveAudioBytes(String ref, byte[] data) {
        return saveAudioBytes(ref, data, null);
    }

    public String saveAudioBytes(String ref, byte[] data, Long ttlSeconds) {
        String key = "audio:" + ref;
        long exp = ttlSeconds != null ? ttlSeconds : audioTtlSeconds;
        if (shouldUseRedis()) {
            try {
                if (exp > 0) {
                    redisTemplate.opsForValue().set(key, data, Duration.ofSeconds(exp));
                } else {
                    redisTemplate.opsForValue().set(key, data);
                }
                // Short hot-failover mirror prevents mid-pipeline 404 on transient Redis timeouts
                memSet(key, data, exp > 0 ? Math.min(exp, 30L) : 30L);
                markRedisUp();
                return ref;
            } catch (Exception ex) {
                markRedisDown(ex);
            }
        }
        memSet(key, data, exp);
        return ref;
    }

    public Optional<byte[]> getAudioBytes(String ref) {
        if (ref == null || ref.isBlank()) {
            return Optional.empty();
        }
        String key = "audio:" + ref;
        byte[] data = null;
        if (shouldUseRedis()) {
            try {
                data = redisTemplate.opsForValue().get(key);
                markRedisUp();
            } catch (Exception ex) {
                markRedisDown(ex);
            }
        }
        if (data == null) {
            data = memGet(key);
        }
        return Optional.ofNullable(data);
    }

    public Map<String, byte[]> collectAudioAssets(ProjectState project) {
        Map<String, byte[]> map = new LinkedHashMap<>();
        if (project == null) return map;
        if (project.getAudioAssets() != null) {
            putAudioIfPresent(map, project.getAudioAssets().getRawInputRef());
            putAudioIfPresent(map, project.getAudioAssets().getDryDenoisedRef());
            putAudioIfPresent(map, project.getAudioAssets().getTunedVocalRef());
            putAudioIfPresent(map, project.getAudioAssets().getRenderedMixRef());
            putAudioIfPresent(map, project.getAudioAssets().getAccompanimentRef());
            putAudioIfPresent(map, project.getAudioAssets().getPreserveMixRef());
            putAudioIfPresent(map, project.getAudioAssets().getEnhanceMixRef());
        }
        if (project.getTracks() != null) {
            for (TrackState track : project.getTracks().values()) {
                if (track == null || track.getClips() == null) continue;
                for (AudioClip clip : track.getClips()) {
                    if (clip != null) {
                        putAudioIfPresent(map, clip.getSource());
                    }
                }
            }
        }
        return map;
    }

    private void putAudioIfPresent(Map<String, byte[]> map, String ref) {
        if (ref != null && !ref.isBlank() && !map.containsKey(ref)) {
            getAudioBytes(ref).ifPresent(bytes -> map.put(ref, bytes));
        }
    }

    public boolean deleteAudioBytes(String ref) {
        String key = "audio:" + ref;
        boolean deleted = memDelete(key);
        if (shouldUseRedis()) {
            try {
                Boolean res = redisTemplate.delete(key);
                markRedisUp();
                deleted = deleted || Boolean.TRUE.equals(res);
            } catch (Exception ex) {
                markRedisDown(ex);
            }
        }
        return deleted;
    }

    // --- Job State & Cancel Flags ---

    public void setJob(String jobId, Map<String, Object> data, long ttlSeconds) {
        String key = "job:" + jobId;
        try {
            byte[] payload = objectMapper.writeValueAsBytes(data);
            if (shouldUseRedis()) {
                try {
                    redisTemplate.opsForValue().set(key, payload, Duration.ofSeconds(ttlSeconds));
                    markRedisUp();
                    return;
                } catch (Exception ex) {
                    markRedisDown(ex);
                }
            }
            memSet(key, payload, ttlSeconds);
        } catch (Exception ex) {
            log.warn("Failed to serialize job {}: {}", jobId, ex.getMessage());
        }
    }

    public Optional<Map<String, Object>> getJob(String jobId) {
        String key = "job:" + jobId;
        byte[] raw = null;
        if (shouldUseRedis()) {
            try {
                raw = redisTemplate.opsForValue().get(key);
                markRedisUp();
            } catch (Exception ex) {
                markRedisDown(ex);
            }
        }
        if (raw == null) {
            raw = memGet(key);
        }
        if (raw == null) {
            return Optional.empty();
        }
        try {
            return Optional.of(objectMapper.readValue(raw, new TypeReference<Map<String, Object>>() {}));
        } catch (Exception ex) {
            return Optional.empty();
        }
    }

    public void setCancelFlag(String jobId, long ttlSeconds) {
        String key = "job_cancel:" + jobId;
        byte[] flag = "1".getBytes(StandardCharsets.UTF_8);
        if (shouldUseRedis()) {
            try {
                redisTemplate.opsForValue().set(key, flag, Duration.ofSeconds(ttlSeconds));
                markRedisUp();
                return;
            } catch (Exception ex) {
                markRedisDown(ex);
            }
        }
        memSet(key, flag, ttlSeconds);
    }

    public boolean isCancelled(String jobId) {
        String key = "job_cancel:" + jobId;
        if (shouldUseRedis()) {
            try {
                byte[] val = redisTemplate.opsForValue().get(key);
                markRedisUp();
                if (val != null) return true;
            } catch (Exception ex) {
                markRedisDown(ex);
            }
        }
        return memGet(key) != null;
    }

    // --- Health & Cache Cleanup ---

    public Map<String, Object> ping() {
        if (redisTemplate != null) {
            try {
                String pong = redisTemplate.execute((RedisCallback<String>) RedisConnection::ping);
                if (pong != null && !pong.isBlank()) {
                    markRedisUp();
                    Long dbSize = redisTemplate.execute((RedisCallback<Long>) conn -> conn.serverCommands().dbSize());
                    Map<String, Object> info = new LinkedHashMap<>();
                    info.put("connected", true);
                    info.put("backend", "redis");
                    info.put("keys_count", dbSize != null ? dbSize : 0L);
                    info.put("used_memory_human", "redis");
                    return info;
                }
            } catch (Exception ex) {
                markRedisDown(ex);
            }
        }

        List<String> keys = memKeys("");
        long totalBytes = 0L;
        for (String k : keys) {
            MemoryEntry e = memoryData.get(k);
            if (e != null && e.data() != null) {
                totalBytes += e.data().length;
            }
        }
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("connected", false);
        info.put("backend", "memory");
        info.put("keys_count", keys.size());
        info.put("memory_bytes", totalBytes);
        info.put("used_memory_human", String.format(Locale.ROOT, "%.1f KB", totalBytes / 1024.0));
        return info;
    }

    public Map<String, Object> clearCache() {
        int cleared = 0;
        for (String prefix : List.of("audio:", "job:", "job_cancel:")) {
            for (String key : memKeys(prefix)) {
                if (memDelete(key)) {
                    cleared++;
                }
            }
        }
        if (shouldUseRedis()) {
            try {
                for (String pattern : List.of("audio:*", "job:*", "job_cancel:*")) {
                    Set<String> keys = scanKeys(pattern);
                    if (!keys.isEmpty()) {
                        Long del = redisTemplate.delete(keys);
                        if (del != null) cleared += del.intValue();
                    }
                }
                markRedisUp();
            } catch (Exception ex) {
                markRedisDown(ex);
            }
        }
        return Map.of("cleared_keys", cleared);
    }

    private Set<String> scanKeys(String pattern) {
        Set<String> keys = new LinkedHashSet<>();
        if (redisTemplate == null) return keys;
        redisTemplate.execute((RedisCallback<Void>) connection -> {
            try (Cursor<byte[]> cursor = connection.keyCommands().scan(
                    ScanOptions.scanOptions().match(pattern).count(200).build())) {
                while (cursor.hasNext()) {
                    keys.add(new String(cursor.next(), StandardCharsets.UTF_8));
                }
            }
            return null;
        });
        return keys;
    }
}
