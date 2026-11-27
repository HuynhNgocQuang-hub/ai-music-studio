package com.aimusic.studio.cloud;

import com.aimusic.studio.config.AppProperties;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * JDBC persistence service targeting PostgreSQL when configured/reachable,
 * with automatic embedded H2 fallback for zero-Docker local execution and unit tests.
 */
@Service
public class CloudDatabaseService {

    private static final Logger log = LoggerFactory.getLogger(CloudDatabaseService.class);

    public record UserRecord(String id, String email, String displayName, String passwordHash, String role, String createdAt) {}

    public record UserProfileRecord(String id, String displayName, String role, String bio, String createdAt) {}

    public record CreatorSummaryRecord(
            String userId,
            String displayName,
            String bio,
            String role,
            int followersCount,
            int followingCount,
            int releasesCount,
            int totalPlays,
            int totalLikes
    ) {}

    public record CloudProjectRecord(
            String projectId,
            String ownerId,
            String title,
            String genre,
            String visibility,
            String shareSlug,
            String publishedAt,
            String storageKey,
            String updatedAt,
            String stateJson
    ) {}

    public record PublishedReleaseRecord(
            String shareSlug,
            String projectId,
            String ownerId,
            String title,
            String artist,
            String genre,
            double bpm,
            String detectedKey,
            String scale,
            int totalBars,
            String masterFormat,
            double lufsTarget,
            String masterStorageKey,
            String lyricsSummary,
            int playsCount,
            String createdAt
    ) {}

    public record QuotaRecord(String quotaKey, String userId, String dayUtc, int genCount, int exportCount, long storageBytes) {}

    public record ReleaseCommentRecord(
            String id,
            String shareSlug,
            String authorId,
            String authorName,
            double timestampSec,
            Integer barNumber,
            String text,
            String createdAt
    ) {}

    public record StudioBarCommentRecord(
            String id,
            String projectId,
            int barNumber,
            String trackId,
            String authorId,
            String authorName,
            String text,
            boolean resolved,
            String createdAt
    ) {}

    private final HikariDataSource dataSource;
    private final JdbcTemplate jdbc;
    private final String backendName;
    private final boolean postgresConnected;

    public CloudDatabaseService(AppProperties properties) {
        String configuredUrl = properties.getDatabaseUrl() != null ? properties.getDatabaseUrl().trim() : "";
        String user = properties.getDatabaseUser() != null ? properties.getDatabaseUser() : "aimusic";
        String pass = properties.getDatabasePass() != null ? properties.getDatabasePass() : "aimusic_dev_pass";
        String cloudDir = properties.getCloudDataDir() != null ? properties.getCloudDataDir().trim() : "./data";

        boolean pgOk = false;
        if (configuredUrl.startsWith("jdbc:postgresql:")) {
            pgOk = probePostgres(configuredUrl, user, pass);
        }

        HikariConfig cfg = new HikariConfig();
        if (pgOk) {
            cfg.setJdbcUrl(configuredUrl);
            cfg.setUsername(user);
            cfg.setPassword(pass);
            cfg.setMaximumPoolSize(6);
            this.backendName = "postgresql";
            this.postgresConnected = true;
            log.info("Connected to PostgreSQL cloud database.");
        } else {
            String h2Url;
            String detectedBackend;
            if ("mem".equalsIgnoreCase(cloudDir)) {
                h2Url = "jdbc:h2:mem:aimusic_" + UUID.randomUUID().toString().replace("-", "")
                        + ";MODE=PostgreSQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE";
                detectedBackend = "h2-memory";
            } else {
                try {
                    Path dbDir = Path.of(cloudDir).toAbsolutePath().normalize();
                    Files.createDirectories(dbDir);
                    Path dbFile = dbDir.resolve("aimusic-cloud");
                    h2Url = "jdbc:h2:file:" + dbFile.toString().replace('\\', '/')
                            + ";MODE=PostgreSQL;LOCK_TIMEOUT=5000;DATABASE_TO_LOWER=TRUE";
                    detectedBackend = "h2-local";
                } catch (Exception ex) {
                    h2Url = "jdbc:h2:mem:aimusic_fallback;MODE=PostgreSQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE";
                    detectedBackend = "h2-memory";
                }
            }
            this.backendName = detectedBackend;
            cfg.setJdbcUrl(h2Url);
            cfg.setUsername("sa");
            cfg.setPassword("");
            cfg.setMaximumPoolSize(4);
            this.postgresConnected = false;
            if (!configuredUrl.isEmpty()) {
                log.info("PostgreSQL unreachable; using {} database fallback.", this.backendName);
            }
        }

        this.dataSource = new HikariDataSource(cfg);
        this.jdbc = new JdbcTemplate(this.dataSource);
        initSchema();
    }

    private boolean probePostgres(String url, String user, String pass) {
        int prevTimeout = DriverManager.getLoginTimeout();
        try {
            DriverManager.setLoginTimeout(2);
            try (Connection ignored = DriverManager.getConnection(url, user, pass)) {
                return true;
            }
        } catch (Exception ex) {
            log.info("PostgreSQL connection check failed ({}); falling back to embedded H2.", ex.getMessage());
            return false;
        } finally {
            DriverManager.setLoginTimeout(prevTimeout);
        }
    }

    private void initSchema() {
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id VARCHAR(64) PRIMARY KEY,
                    email VARCHAR(255) UNIQUE NOT NULL,
                    display_name VARCHAR(120) NOT NULL,
                    password_hash VARCHAR(255) NOT NULL,
                    role VARCHAR(32) NOT NULL,
                    created_at VARCHAR(64) NOT NULL
                )""");
        try {
            jdbc.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(500)");
        } catch (Exception ignored) {
        }
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS creator_follows (
                    follower_id VARCHAR(64) NOT NULL,
                    creator_id VARCHAR(64) NOT NULL,
                    created_at VARCHAR(64) NOT NULL,
                    PRIMARY KEY (follower_id, creator_id)
                )""");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS cloud_projects (
                    project_id VARCHAR(128) PRIMARY KEY,
                    owner_id VARCHAR(64) NOT NULL,
                    title VARCHAR(255) NOT NULL,
                    genre VARCHAR(64) NOT NULL,
                    visibility VARCHAR(24) NOT NULL,
                    share_slug VARCHAR(128),
                    published_at VARCHAR(64),
                    storage_key VARCHAR(255),
                    updated_at VARCHAR(64) NOT NULL,
                    state_json TEXT NOT NULL
                )""");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS published_releases (
                    share_slug VARCHAR(128) PRIMARY KEY,
                    project_id VARCHAR(128) NOT NULL,
                    owner_id VARCHAR(64) NOT NULL,
                    title VARCHAR(255) NOT NULL,
                    artist VARCHAR(160) NOT NULL,
                    genre VARCHAR(64) NOT NULL,
                    bpm DOUBLE PRECISION NOT NULL,
                    detected_key VARCHAR(16) NOT NULL,
                    scale VARCHAR(32) NOT NULL,
                    total_bars INT NOT NULL,
                    master_format VARCHAR(16) NOT NULL,
                    lufs_target DOUBLE PRECISION NOT NULL,
                    master_storage_key VARCHAR(255) NOT NULL,
                    lyrics_summary TEXT NOT NULL,
                    plays_count INT NOT NULL,
                    created_at VARCHAR(64) NOT NULL
                )""");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS usage_quotas (
                    quota_key VARCHAR(160) PRIMARY KEY,
                    user_id VARCHAR(64) NOT NULL,
                    day_utc VARCHAR(16) NOT NULL,
                    gen_count INT NOT NULL,
                    export_count INT NOT NULL,
                    storage_bytes BIGINT NOT NULL
                )""");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS revoked_tokens (
                    jti VARCHAR(64) PRIMARY KEY,
                    expires_at BIGINT NOT NULL
                )""");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS release_likes (
                    share_slug VARCHAR(128) NOT NULL,
                    actor_id VARCHAR(128) NOT NULL,
                    created_at VARCHAR(64) NOT NULL,
                    PRIMARY KEY (share_slug, actor_id)
                )""");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS release_comments (
                    id VARCHAR(64) PRIMARY KEY,
                    share_slug VARCHAR(128) NOT NULL,
                    author_id VARCHAR(128) NOT NULL,
                    author_name VARCHAR(120) NOT NULL,
                    timestamp_sec DOUBLE PRECISION NOT NULL,
                    bar_number INT,
                    text VARCHAR(1000) NOT NULL,
                    created_at VARCHAR(64) NOT NULL
                )""");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS studio_bar_comments (
                    id VARCHAR(64) PRIMARY KEY,
                    project_id VARCHAR(128) NOT NULL,
                    bar_number INT NOT NULL,
                    track_id VARCHAR(64),
                    author_id VARCHAR(128) NOT NULL,
                    author_name VARCHAR(120) NOT NULL,
                    text VARCHAR(1000) NOT NULL,
                    resolved BOOLEAN NOT NULL,
                    created_at VARCHAR(64) NOT NULL
                )""");
    }

    public void saveRevokedToken(String jti, long expiresAtEpochSec) {
        if (jti == null || jti.isBlank()) return;
        int updated = jdbc.update("UPDATE revoked_tokens SET expires_at = ? WHERE jti = ?", expiresAtEpochSec, jti);
        if (updated == 0) {
            jdbc.update("INSERT INTO revoked_tokens (jti, expires_at) VALUES (?, ?)", jti, expiresAtEpochSec);
        }
    }

    public boolean isTokenRevokedInDb(String jti) {
        if (jti == null || jti.isBlank()) return false;
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM revoked_tokens WHERE jti = ?",
                Integer.class,
                jti
        );
        return count != null && count > 0;
    }

    public void pruneExpiredRevokedTokens(long nowEpochSec) {
        jdbc.update("DELETE FROM revoked_tokens WHERE expires_at <= ?", nowEpochSec);
    }

    public Map<String, Object> status() {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("database_backend", backendName);
        info.put("database_ready", true);
        info.put("postgres_connected", postgresConnected);
        return info;
    }

    // --- Users ---

    public UserRecord createUser(String id, String email, String displayName, String passwordHash, String role) {
        String normEmail = email.trim().toLowerCase(Locale.ROOT);
        String now = Instant.now().toString();
        jdbc.update(
                "INSERT INTO users (id, email, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                id, normEmail, displayName.trim(), passwordHash, role, now
        );
        return new UserRecord(id, normEmail, displayName.trim(), passwordHash, role, now);
    }

    public Optional<UserRecord> findUserByEmail(String email) {
        if (email == null || email.isBlank()) return Optional.empty();
        String norm = email.trim().toLowerCase(Locale.ROOT);
        List<UserRecord> rows = jdbc.query(
                "SELECT id, email, display_name, password_hash, role, created_at FROM users WHERE email = ?",
                (rs, i) -> new UserRecord(
                        rs.getString("id"), rs.getString("email"), rs.getString("display_name"),
                        rs.getString("password_hash"), rs.getString("role"), rs.getString("created_at")
                ),
                norm
        );
        return rows.stream().findFirst();
    }

    public Optional<UserRecord> findUserById(String id) {
        if (id == null || id.isBlank()) return Optional.empty();
        List<UserRecord> rows = jdbc.query(
                "SELECT id, email, display_name, password_hash, role, created_at FROM users WHERE id = ?",
                (rs, i) -> new UserRecord(
                        rs.getString("id"), rs.getString("email"), rs.getString("display_name"),
                        rs.getString("password_hash"), rs.getString("role"), rs.getString("created_at")
                ),
                id
        );
        return rows.stream().findFirst();
    }

    // --- Cloud Projects ---

    public void upsertProject(CloudProjectRecord rec) {
        int updated = jdbc.update(
                "UPDATE cloud_projects SET owner_id=?, title=?, genre=?, visibility=?, share_slug=?, published_at=?, storage_key=?, updated_at=?, state_json=? WHERE project_id=?",
                rec.ownerId(), rec.title(), rec.genre(), rec.visibility(), rec.shareSlug(),
                rec.publishedAt(), rec.storageKey(), rec.updatedAt(), rec.stateJson(), rec.projectId()
        );
        if (updated == 0) {
            jdbc.update(
                    "INSERT INTO cloud_projects (project_id, owner_id, title, genre, visibility, share_slug, published_at, storage_key, updated_at, state_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rec.projectId(), rec.ownerId(), rec.title(), rec.genre(), rec.visibility(),
                    rec.shareSlug(), rec.publishedAt(), rec.storageKey(), rec.updatedAt(), rec.stateJson()
            );
        }
    }

    public Optional<CloudProjectRecord> findProject(String projectId) {
        if (projectId == null || projectId.isBlank()) return Optional.empty();
        List<CloudProjectRecord> rows = jdbc.query(
                "SELECT * FROM cloud_projects WHERE project_id = ?",
                (rs, i) -> new CloudProjectRecord(
                        rs.getString("project_id"), rs.getString("owner_id"), rs.getString("title"),
                        rs.getString("genre"), rs.getString("visibility"), rs.getString("share_slug"),
                        rs.getString("published_at"), rs.getString("storage_key"),
                        rs.getString("updated_at"), rs.getString("state_json")
                ),
                projectId
        );
        return rows.stream().findFirst();
    }

    public List<CloudProjectRecord> listAllProjects() {
        return jdbc.query(
                "SELECT * FROM cloud_projects ORDER BY updated_at DESC",
                (rs, i) -> new CloudProjectRecord(
                        rs.getString("project_id"), rs.getString("owner_id"), rs.getString("title"),
                        rs.getString("genre"), rs.getString("visibility"), rs.getString("share_slug"),
                        rs.getString("published_at"), rs.getString("storage_key"),
                        rs.getString("updated_at"), rs.getString("state_json")
                )
        );
    }

    public void deleteProject(String projectId) {
        findReleaseByProjectId(projectId).ifPresent(rel -> cleanupReleaseSocial(rel.shareSlug()));
        jdbc.update("DELETE FROM studio_bar_comments WHERE project_id = ?", projectId);
        jdbc.update("DELETE FROM cloud_projects WHERE project_id = ?", projectId);
        jdbc.update("DELETE FROM published_releases WHERE project_id = ?", projectId);
    }

    // --- Published Releases ---

    public void upsertRelease(PublishedReleaseRecord rec) {
        int updated = jdbc.update(
                "UPDATE published_releases SET project_id=?, owner_id=?, title=?, artist=?, genre=?, bpm=?, detected_key=?, scale=?, total_bars=?, master_format=?, lufs_target=?, master_storage_key=?, lyrics_summary=?, created_at=? WHERE share_slug=?",
                rec.projectId(), rec.ownerId(), rec.title(), rec.artist(), rec.genre(),
                rec.bpm(), rec.detectedKey(), rec.scale(), rec.totalBars(),
                rec.masterFormat(), rec.lufsTarget(), rec.masterStorageKey(),
                rec.lyricsSummary(), rec.createdAt(), rec.shareSlug()
        );
        if (updated == 0) {
            jdbc.update(
                    "INSERT INTO published_releases (share_slug, project_id, owner_id, title, artist, genre, bpm, detected_key, scale, total_bars, master_format, lufs_target, master_storage_key, lyrics_summary, plays_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rec.shareSlug(), rec.projectId(), rec.ownerId(), rec.title(), rec.artist(), rec.genre(),
                    rec.bpm(), rec.detectedKey(), rec.scale(), rec.totalBars(),
                    rec.masterFormat(), rec.lufsTarget(), rec.masterStorageKey(),
                    rec.lyricsSummary(), rec.playsCount(), rec.createdAt()
            );
        }
    }

    public Optional<PublishedReleaseRecord> findReleaseBySlug(String shareSlug) {
        if (shareSlug == null || shareSlug.isBlank()) return Optional.empty();
        List<PublishedReleaseRecord> rows = jdbc.query(
                "SELECT * FROM published_releases WHERE share_slug = ?",
                (rs, i) -> mapRelease(rs),
                shareSlug
        );
        return rows.stream().findFirst();
    }

    public Optional<PublishedReleaseRecord> findReleaseByProjectId(String projectId) {
        if (projectId == null || projectId.isBlank()) return Optional.empty();
        List<PublishedReleaseRecord> rows = jdbc.query(
                "SELECT * FROM published_releases WHERE project_id = ?",
                (rs, i) -> mapRelease(rs),
                projectId
        );
        return rows.stream().findFirst();
    }

    public List<PublishedReleaseRecord> listReleases(String search, String genre) {
        return listReleases(search, genre, "recent", null, null);
    }

    public List<PublishedReleaseRecord> listReleases(
            String search,
            String genre,
            String sort,
            String ownerId,
            Set<String> followingIds
    ) {
        List<PublishedReleaseRecord> all = jdbc.query(
                "SELECT * FROM published_releases ORDER BY created_at DESC",
                (rs, i) -> mapRelease(rs)
        );
        String q = search != null ? search.trim().toLowerCase(Locale.ROOT) : "";
        String g = genre != null ? genre.trim().toLowerCase(Locale.ROOT) : "";
        String creatorFilter = ownerId != null ? ownerId.trim() : "";
        List<PublishedReleaseRecord> out = new ArrayList<>();
        for (PublishedReleaseRecord r : all) {
            if (!creatorFilter.isEmpty() && !creatorFilter.equals(r.ownerId())) {
                continue;
            }
            if (followingIds != null && !followingIds.contains(r.ownerId())) {
                continue;
            }
            if (!q.isEmpty() && !r.title().toLowerCase(Locale.ROOT).contains(q)
                    && !r.artist().toLowerCase(Locale.ROOT).contains(q)
                    && !r.genre().toLowerCase(Locale.ROOT).contains(q)) {
                continue;
            }
            if (!g.isEmpty() && !r.genre().equalsIgnoreCase(g)) {
                continue;
            }
            out.add(r);
        }

        String normSort = sort != null ? sort.trim().toLowerCase(Locale.ROOT) : "recent";
        if ("trending".equals(normSort) || "likes".equals(normSort) || "plays".equals(normSort)) {
            Map<String, Integer> likesCache = new HashMap<>();
            jdbc.query("SELECT share_slug, COUNT(*) AS cnt FROM release_likes GROUP BY share_slug", rs -> {
                likesCache.put(rs.getString("share_slug"), rs.getInt("cnt"));
            });
            out.sort(Comparator.comparingInt((PublishedReleaseRecord r) -> {
                int likes = likesCache.getOrDefault(r.shareSlug(), 0);
                return switch (normSort) {
                    case "likes" -> likes * 100 + r.playsCount();
                    case "plays" -> r.playsCount() * 100 + likes;
                    default -> (likes * 3) + r.playsCount();
                };
            }).reversed().thenComparing(PublishedReleaseRecord::createdAt, Comparator.reverseOrder()));
        }
        return out;
    }

    public void incrementReleasePlays(String shareSlug) {
        jdbc.update("UPDATE published_releases SET plays_count = plays_count + 1 WHERE share_slug = ?", shareSlug);
    }

    public int deleteReleaseByProjectId(String projectId) {
        findReleaseByProjectId(projectId).ifPresent(rel -> cleanupReleaseSocial(rel.shareSlug()));
        return jdbc.update("DELETE FROM published_releases WHERE project_id = ?", projectId);
    }

    private void cleanupReleaseSocial(String shareSlug) {
        if (shareSlug == null || shareSlug.isBlank()) return;
        jdbc.update("DELETE FROM release_likes WHERE share_slug = ?", shareSlug);
        jdbc.update("DELETE FROM release_comments WHERE share_slug = ?", shareSlug);
    }

    // --- Phase 9: Release Likes & Timestamp Comments + Studio Bar Notes ---

    public Map<String, Object> toggleReleaseLike(String shareSlug, String actorId) {
        String key = (actorId != null && !actorId.isBlank()) ? actorId : "guest:local";
        Integer existing = jdbc.queryForObject(
                "SELECT COUNT(*) FROM release_likes WHERE share_slug = ? AND actor_id = ?",
                Integer.class, shareSlug, key
        );
        boolean liked;
        if (existing != null && existing > 0) {
            jdbc.update("DELETE FROM release_likes WHERE share_slug = ? AND actor_id = ?", shareSlug, key);
            liked = false;
        } else {
            jdbc.update(
                    "INSERT INTO release_likes (share_slug, actor_id, created_at) VALUES (?, ?, ?)",
                    shareSlug, key, Instant.now().toString()
            );
            liked = true;
        }
        int total = countReleaseLikes(shareSlug);
        return Map.of("share_slug", shareSlug, "liked", liked, "likes_count", total);
    }

    public int countReleaseLikes(String shareSlug) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM release_likes WHERE share_slug = ?",
                Integer.class, shareSlug
        );
        return n != null ? n : 0;
    }

    public boolean hasActorLikedRelease(String shareSlug, String actorId) {
        if (actorId == null || actorId.isBlank()) return false;
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM release_likes WHERE share_slug = ? AND actor_id = ?",
                Integer.class, shareSlug, actorId
        );
        return n != null && n > 0;
    }

    public ReleaseCommentRecord addReleaseComment(
            String shareSlug,
            String authorId,
            String authorName,
            double timestampSec,
            Integer barNumber,
            String text
    ) {
        String id = "cmt_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String now = Instant.now().toString();
        double safeTs = Math.max(0.0, timestampSec);
        jdbc.update(
                "INSERT INTO release_comments (id, share_slug, author_id, author_name, timestamp_sec, bar_number, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                id, shareSlug, authorId, authorName, safeTs, barNumber, text, now
        );
        return new ReleaseCommentRecord(id, shareSlug, authorId, authorName, safeTs, barNumber, text, now);
    }

    public List<ReleaseCommentRecord> listReleaseComments(String shareSlug) {
        return jdbc.query(
                "SELECT id, share_slug, author_id, author_name, timestamp_sec, bar_number, text, created_at FROM release_comments WHERE share_slug = ? ORDER BY timestamp_sec ASC, created_at ASC",
                (rs, i) -> {
                    int barRaw = rs.getInt("bar_number");
                    Integer bar = rs.wasNull() ? null : barRaw;
                    return new ReleaseCommentRecord(
                            rs.getString("id"), rs.getString("share_slug"),
                            rs.getString("author_id"), rs.getString("author_name"),
                            rs.getDouble("timestamp_sec"), bar,
                            rs.getString("text"), rs.getString("created_at")
                    );
                },
                shareSlug
        );
    }

    public Optional<ReleaseCommentRecord> findReleaseComment(String commentId) {
        List<ReleaseCommentRecord> rows = jdbc.query(
                "SELECT id, share_slug, author_id, author_name, timestamp_sec, bar_number, text, created_at FROM release_comments WHERE id = ?",
                (rs, i) -> {
                    int barRaw = rs.getInt("bar_number");
                    Integer bar = rs.wasNull() ? null : barRaw;
                    return new ReleaseCommentRecord(
                            rs.getString("id"), rs.getString("share_slug"),
                            rs.getString("author_id"), rs.getString("author_name"),
                            rs.getDouble("timestamp_sec"), bar,
                            rs.getString("text"), rs.getString("created_at")
                    );
                },
                commentId
        );
        return rows.stream().findFirst();
    }

    public void deleteReleaseComment(String commentId) {
        jdbc.update("DELETE FROM release_comments WHERE id = ?", commentId);
    }

    public StudioBarCommentRecord addStudioBarComment(
            String projectId,
            int barNumber,
            String trackId,
            String authorId,
            String authorName,
            String text
    ) {
        String id = "bcmt_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String now = Instant.now().toString();
        int safeBar = Math.max(1, barNumber);
        jdbc.update(
                "INSERT INTO studio_bar_comments (id, project_id, bar_number, track_id, author_id, author_name, text, resolved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                id, projectId, safeBar, trackId, authorId, authorName, text, false, now
        );
        return new StudioBarCommentRecord(id, projectId, safeBar, trackId, authorId, authorName, text, false, now);
    }

    public List<StudioBarCommentRecord> listStudioBarComments(String projectId) {
        return jdbc.query(
                "SELECT id, project_id, bar_number, track_id, author_id, author_name, text, resolved, created_at FROM studio_bar_comments WHERE project_id = ? ORDER BY bar_number ASC, created_at ASC",
                (rs, i) -> new StudioBarCommentRecord(
                        rs.getString("id"), rs.getString("project_id"),
                        rs.getInt("bar_number"), rs.getString("track_id"),
                        rs.getString("author_id"), rs.getString("author_name"),
                        rs.getString("text"), rs.getBoolean("resolved"), rs.getString("created_at")
                ),
                projectId
        );
    }

    public Optional<StudioBarCommentRecord> findStudioBarComment(String commentId) {
        List<StudioBarCommentRecord> rows = jdbc.query(
                "SELECT id, project_id, bar_number, track_id, author_id, author_name, text, resolved, created_at FROM studio_bar_comments WHERE id = ?",
                (rs, i) -> new StudioBarCommentRecord(
                        rs.getString("id"), rs.getString("project_id"),
                        rs.getInt("bar_number"), rs.getString("track_id"),
                        rs.getString("author_id"), rs.getString("author_name"),
                        rs.getString("text"), rs.getBoolean("resolved"), rs.getString("created_at")
                ),
                commentId
        );
        return rows.stream().findFirst();
    }

    public Optional<StudioBarCommentRecord> setStudioBarCommentResolved(String commentId, boolean resolved) {
        jdbc.update("UPDATE studio_bar_comments SET resolved = ? WHERE id = ?", resolved, commentId);
        return findStudioBarComment(commentId);
    }

    public void deleteStudioBarComment(String commentId) {
        jdbc.update("DELETE FROM studio_bar_comments WHERE id = ?", commentId);
    }

    // --- Phase 10B: Creator Profiles & Follow Graph ---

    public Optional<UserProfileRecord> getUserProfile(String userId) {
        if (userId == null || userId.isBlank()) return Optional.empty();
        List<UserProfileRecord> rows = jdbc.query(
                "SELECT id, display_name, role, bio, created_at FROM users WHERE id = ?",
                (rs, i) -> new UserProfileRecord(
                        rs.getString("id"), rs.getString("display_name"),
                        rs.getString("role"), rs.getString("bio"), rs.getString("created_at")
                ),
                userId
        );
        return rows.stream().findFirst();
    }

    public Optional<UserProfileRecord> updateUserProfile(String userId, String displayName, String bio) {
        Optional<UserProfileRecord> existing = getUserProfile(userId);
        if (existing.isEmpty()) return Optional.empty();
        UserProfileRecord prev = existing.get();
        String nextName = (displayName != null && !displayName.isBlank())
                ? displayName.trim().substring(0, Math.min(displayName.trim().length(), 100))
                : prev.displayName();
        String nextBio = bio != null
                ? bio.trim().substring(0, Math.min(bio.trim().length(), 400))
                : prev.bio();
        jdbc.update("UPDATE users SET display_name = ?, bio = ? WHERE id = ?", nextName, nextBio, userId);
        return getUserProfile(userId);
    }

    public Map<String, Object> toggleCreatorFollow(String followerActorKey, String creatorId) {
        String key = (followerActorKey != null && !followerActorKey.isBlank()) ? followerActorKey : "guest:local";
        Integer existing = jdbc.queryForObject(
                "SELECT COUNT(*) FROM creator_follows WHERE follower_id = ? AND creator_id = ?",
                Integer.class, key, creatorId
        );
        boolean following;
        if (existing != null && existing > 0) {
            jdbc.update("DELETE FROM creator_follows WHERE follower_id = ? AND creator_id = ?", key, creatorId);
            following = false;
        } else {
            jdbc.update(
                    "INSERT INTO creator_follows (follower_id, creator_id, created_at) VALUES (?, ?, ?)",
                    key, creatorId, Instant.now().toString()
            );
            following = true;
        }
        return Map.of(
                "creator_id", creatorId,
                "following", following,
                "followers_count", countFollowers(creatorId)
        );
    }

    public boolean isFollowingCreator(String followerActorKey, String creatorId) {
        if (followerActorKey == null || followerActorKey.isBlank() || creatorId == null || creatorId.isBlank()) {
            return false;
        }
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM creator_follows WHERE follower_id = ? AND creator_id = ?",
                Integer.class, followerActorKey, creatorId
        );
        return n != null && n > 0;
    }

    public int countFollowers(String creatorId) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM creator_follows WHERE creator_id = ?",
                Integer.class, creatorId
        );
        return n != null ? n : 0;
    }

    public int countFollowing(String followerActorKey) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM creator_follows WHERE follower_id = ?",
                Integer.class, followerActorKey
        );
        return n != null ? n : 0;
    }

    public Set<String> listFollowingIds(String followerActorKey) {
        if (followerActorKey == null || followerActorKey.isBlank()) return Set.of();
        List<String> ids = jdbc.queryForList(
                "SELECT creator_id FROM creator_follows WHERE follower_id = ?",
                String.class, followerActorKey
        );
        return new HashSet<>(ids);
    }

    public Optional<CreatorSummaryRecord> getCreatorSummary(String creatorId) {
        if (creatorId == null || creatorId.isBlank()) return Optional.empty();
        Optional<UserProfileRecord> userOpt = getUserProfile(creatorId);
        List<PublishedReleaseRecord> releases = listReleases("", "", "recent", creatorId, null);
        if (userOpt.isEmpty() && releases.isEmpty()) {
            return Optional.empty();
        }
        String name = userOpt.map(UserProfileRecord::displayName)
                .orElseGet(() -> releases.stream().map(PublishedReleaseRecord::artist).filter(a -> a != null && !a.isBlank()).findFirst().orElse("AI Producer"));
        String bio = userOpt.map(u -> u.bio() != null ? u.bio() : "").orElse("");
        String role = userOpt.map(UserProfileRecord::role).orElse("creator");
        int totalPlays = releases.stream().mapToInt(PublishedReleaseRecord::playsCount).sum();
        int totalLikes = releases.stream().mapToInt(r -> countReleaseLikes(r.shareSlug())).sum();
        int followers = countFollowers(creatorId);
        int following = countFollowing("user:" + creatorId);
        return Optional.of(new CreatorSummaryRecord(
                creatorId, name, bio, role, followers, following, releases.size(), totalPlays, totalLikes
        ));
    }

    public List<CreatorSummaryRecord> listTopCreators(int limit) {
        List<PublishedReleaseRecord> all = listReleases("", "", "recent", null, null);
        Map<String, List<PublishedReleaseRecord>> byOwner = new LinkedHashMap<>();
        for (PublishedReleaseRecord r : all) {
            String owner = (r.ownerId() != null && !r.ownerId().isBlank()) ? r.ownerId() : "guest";
            byOwner.computeIfAbsent(owner, k -> new ArrayList<>()).add(r);
        }
        List<CreatorSummaryRecord> summaries = new ArrayList<>();
        for (String ownerId : byOwner.keySet()) {
            getCreatorSummary(ownerId).ifPresent(summaries::add);
        }
        summaries.sort(Comparator.comparingInt((CreatorSummaryRecord c) ->
                (c.totalLikes() * 3) + c.totalPlays() + (c.followersCount() * 5)
        ).reversed());
        if (summaries.size() > limit) {
            return summaries.subList(0, limit);
        }
        return summaries;
    }

    private PublishedReleaseRecord mapRelease(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new PublishedReleaseRecord(
                rs.getString("share_slug"), rs.getString("project_id"), rs.getString("owner_id"),
                rs.getString("title"), rs.getString("artist"), rs.getString("genre"),
                rs.getDouble("bpm"), rs.getString("detected_key"), rs.getString("scale"),
                rs.getInt("total_bars"), rs.getString("master_format"), rs.getDouble("lufs_target"),
                rs.getString("master_storage_key"), rs.getString("lyrics_summary"),
                rs.getInt("plays_count"), rs.getString("created_at")
        );
    }

    // --- Quotas ---

    public QuotaRecord getOrCreateQuota(String quotaKey, String actorId, String dayUtc) {
        List<QuotaRecord> rows = jdbc.query(
                "SELECT quota_key, user_id, day_utc, gen_count, export_count, storage_bytes FROM usage_quotas WHERE quota_key = ?",
                (rs, i) -> new QuotaRecord(
                        rs.getString("quota_key"), rs.getString("user_id"), rs.getString("day_utc"),
                        rs.getInt("gen_count"), rs.getInt("export_count"), rs.getLong("storage_bytes")
                ),
                quotaKey
        );
        if (!rows.isEmpty()) {
            return rows.get(0);
        }
        QuotaRecord created = new QuotaRecord(quotaKey, actorId, dayUtc, 0, 0, 0L);
        jdbc.update(
                "INSERT INTO usage_quotas (quota_key, user_id, day_utc, gen_count, export_count, storage_bytes) VALUES (?, ?, ?, 0, 0, 0)",
                quotaKey, actorId, dayUtc
        );
        return created;
    }

    public void updateQuota(QuotaRecord rec) {
        jdbc.update(
                "UPDATE usage_quotas SET gen_count=?, export_count=?, storage_bytes=? WHERE quota_key=?",
                rec.genCount(), rec.exportCount(), rec.storageBytes(), rec.quotaKey()
        );
    }

    public void resetQuotasForActor(String actorId) {
        jdbc.update("DELETE FROM usage_quotas WHERE user_id = ?", actorId);
    }

    @PreDestroy
    public void close() {
        if (dataSource != null && !dataSource.isClosed()) {
            dataSource.close();
        }
    }
}
