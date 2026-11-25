package com.aimusic.studio.cloud;

import com.aimusic.studio.config.AppProperties;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Per-actor daily quota (persisted in CloudDatabaseService) and sliding-window burst rate-limiter.
 */
@Service
public class QuotaRateLimitService {

    private static final DateTimeFormatter UTC_DAY_FMT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneOffset.UTC);
    private static final int BURST_LIMIT_PER_MINUTE = 90;
    private static final long GUEST_STORAGE_LIMIT_BYTES = 100L * 1024 * 1024;
    private static final long USER_STORAGE_LIMIT_BYTES = 500L * 1024 * 1024;

    private final CloudDatabaseService db;
    private final int userGenLimit;
    private final int userExportLimit;
    private final int guestGenLimit;
    private final int guestExportLimit;
    private final ConcurrentHashMap<String, Deque<Long>> burstWindow = new ConcurrentHashMap<>();

    public QuotaRateLimitService(CloudDatabaseService db, AppProperties properties) {
        this.db = db;
        this.userGenLimit = Math.max(1, properties.getQuotaDailyGenerate());
        this.userExportLimit = Math.max(1, properties.getQuotaDailyExport());
        this.guestGenLimit = Math.max(1, Math.min(this.userGenLimit, 20));
        this.guestExportLimit = Math.max(1, Math.min(this.userExportLimit, 30));
    }

    public Map<String, Object> getSummary(UserPrincipal principal, String actorKey) {
        String key = (actorKey != null && !actorKey.isBlank()) ? actorKey : "guest:local";
        boolean isGuest = principal == null || principal.isGuest();
        String day = UTC_DAY_FMT.format(Instant.now());
        CloudDatabaseService.QuotaRecord rec = db.getOrCreateQuota(key + ":" + day, key, day);

        int genLimit = isGuest ? guestGenLimit : userGenLimit;
        int expLimit = isGuest ? guestExportLimit : userExportLimit;
        long storageLimit = isGuest ? GUEST_STORAGE_LIMIT_BYTES : USER_STORAGE_LIMIT_BYTES;

        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("actor", key);
        summary.put("tier", isGuest ? "guest" : "cloud");
        summary.put("date_utc", day);
        summary.put("generate_used", rec.genCount());
        summary.put("generate_limit", genLimit);
        summary.put("generate_remaining", Math.max(0, genLimit - rec.genCount()));
        summary.put("export_used", rec.exportCount());
        summary.put("export_limit", expLimit);
        summary.put("export_remaining", Math.max(0, expLimit - rec.exportCount()));
        summary.put("storage_used_bytes", rec.storageBytes());
        summary.put("storage_limit_bytes", storageLimit);
        return summary;
    }

    public synchronized Map<String, Object> consumeGenerateQuota(UserPrincipal principal, String actorKey) {
        enforceBurstLimit(actorKey);
        boolean isGuest = principal == null || principal.isGuest();
        int limit = isGuest ? guestGenLimit : userGenLimit;
        String key = (actorKey != null && !actorKey.isBlank()) ? actorKey : "guest:local";
        String day = UTC_DAY_FMT.format(Instant.now());
        String quotaKey = key + ":" + day;

        CloudDatabaseService.QuotaRecord rec = db.getOrCreateQuota(quotaKey, key, day);
        if (rec.genCount() >= limit) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                    "Daily AI generation quota exceeded (" + rec.genCount() + "/" + limit
                            + "). Sign in or retry tomorrow UTC.");
        }
        db.updateQuota(new CloudDatabaseService.QuotaRecord(
                rec.quotaKey(), rec.userId(), rec.dayUtc(),
                rec.genCount() + 1, rec.exportCount(), rec.storageBytes()
        ));
        return getSummary(principal, key);
    }

    public synchronized Map<String, Object> consumeExportQuota(UserPrincipal principal, String actorKey, long bytesAdded) {
        enforceBurstLimit(actorKey);
        boolean isGuest = principal == null || principal.isGuest();
        int limit = isGuest ? guestExportLimit : userExportLimit;
        String key = (actorKey != null && !actorKey.isBlank()) ? actorKey : "guest:local";
        String day = UTC_DAY_FMT.format(Instant.now());
        String quotaKey = key + ":" + day;

        CloudDatabaseService.QuotaRecord rec = db.getOrCreateQuota(quotaKey, key, day);
        if (rec.exportCount() >= limit) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                    "Daily export/publish quota exceeded (" + rec.exportCount() + "/" + limit + ").");
        }
        long nextStorage = Math.max(0L, rec.storageBytes() + Math.max(0L, bytesAdded));
        db.updateQuota(new CloudDatabaseService.QuotaRecord(
                rec.quotaKey(), rec.userId(), rec.dayUtc(),
                rec.genCount(), rec.exportCount() + 1, nextStorage
        ));
        return getSummary(principal, key);
    }

    public synchronized void addStorageBytes(String actorKey, long bytesDelta) {
        if (bytesDelta <= 0 || actorKey == null || actorKey.isBlank()) return;
        String day = UTC_DAY_FMT.format(Instant.now());
        CloudDatabaseService.QuotaRecord rec = db.getOrCreateQuota(actorKey + ":" + day, actorKey, day);
        db.updateQuota(new CloudDatabaseService.QuotaRecord(
                rec.quotaKey(), rec.userId(), rec.dayUtc(),
                rec.genCount(), rec.exportCount(), rec.storageBytes() + bytesDelta
        ));
    }

    public synchronized void resetForActor(String actorKey) {
        if (actorKey != null) {
            burstWindow.remove(actorKey);
            db.resetQuotasForActor(actorKey);
        }
    }

    private void enforceBurstLimit(String actorKey) {
        String key = (actorKey != null && !actorKey.isBlank()) ? actorKey : "guest:local";
        long nowMs = System.currentTimeMillis();
        long cutoff = nowMs - 60_000L;
        Deque<Long> timestamps = burstWindow.computeIfAbsent(key, k -> new ArrayDeque<>());
        synchronized (timestamps) {
            while (!timestamps.isEmpty() && timestamps.peekFirst() < cutoff) {
                timestamps.pollFirst();
            }
            if (timestamps.size() >= BURST_LIMIT_PER_MINUTE) {
                throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                        "Rate limit exceeded (" + BURST_LIMIT_PER_MINUTE + " requests/min). Please slow down.");
            }
            timestamps.addLast(nowMs);
        }
    }
}
