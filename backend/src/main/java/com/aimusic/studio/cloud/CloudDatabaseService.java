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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * JDBC persistence service targeting PostgreSQL when configured/reachable,
 * with automatic embedded H2 fallback for zero-Docker local execution and unit tests.
 */
@Service
public class CloudDatabaseService {

    private static final Logger log = LoggerFactory.getLogger(CloudDatabaseService.class);

    public record UserRecord(String id, String email, String displayName, String passwordHash, String role, String createdAt) {}

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
        List<PublishedReleaseRecord> all = jdbc.query(
                "SELECT * FROM published_releases ORDER BY created_at DESC",
                (rs, i) -> mapRelease(rs)
        );
        String q = search != null ? search.trim().toLowerCase(Locale.ROOT) : "";
        String g = genre != null ? genre.trim().toLowerCase(Locale.ROOT) : "";
        List<PublishedReleaseRecord> out = new ArrayList<>();
        for (PublishedReleaseRecord r : all) {
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
        return out;
    }

    public void incrementReleasePlays(String shareSlug) {
        jdbc.update("UPDATE published_releases SET plays_count = plays_count + 1 WHERE share_slug = ?", shareSlug);
    }

    public int deleteReleaseByProjectId(String projectId) {
        return jdbc.update("DELETE FROM published_releases WHERE project_id = ?", projectId);
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
