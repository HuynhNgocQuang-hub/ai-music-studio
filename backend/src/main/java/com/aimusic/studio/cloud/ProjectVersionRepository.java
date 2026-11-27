package com.aimusic.studio.cloud;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Segregated repository owning persistence operations for named {@code project_versions} checkpoints.
 */
@Service
public class ProjectVersionRepository {

    private final JdbcTemplate jdbc;

    @Autowired
    public ProjectVersionRepository(CloudDatabaseService db) {
        this(db.getJdbcTemplate());
    }

    ProjectVersionRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public CloudDatabaseService.ProjectVersionRecord createProjectVersion(
            String projectId,
            String label,
            String authorId,
            String authorName,
            double bpm,
            int totalBars,
            String stateJson
    ) {
        String id = "ver_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String now = Instant.now().toString();
        jdbc.update(
                "INSERT INTO project_versions (id, project_id, label, author_id, author_name, bpm, total_bars, state_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                id, projectId, label, authorId, authorName, bpm, totalBars, stateJson, now
        );
        return new CloudDatabaseService.ProjectVersionRecord(id, projectId, label, authorId, authorName, bpm, totalBars, stateJson, now);
    }

    public List<CloudDatabaseService.ProjectVersionRecord> listProjectVersions(String projectId) {
        return jdbc.query(
                "SELECT id, project_id, label, author_id, author_name, bpm, total_bars, state_json, created_at FROM project_versions WHERE project_id = ? ORDER BY created_at DESC",
                (rs, i) -> mapVersionRow(rs),
                projectId
        );
    }

    public Optional<CloudDatabaseService.ProjectVersionRecord> findProjectVersion(String versionId) {
        if (versionId == null || versionId.isBlank()) return Optional.empty();
        List<CloudDatabaseService.ProjectVersionRecord> rows = jdbc.query(
                "SELECT id, project_id, label, author_id, author_name, bpm, total_bars, state_json, created_at FROM project_versions WHERE id = ?",
                (rs, i) -> mapVersionRow(rs),
                versionId
        );
        return rows.stream().findFirst();
    }

    public void deleteProjectVersion(String versionId) {
        jdbc.update("DELETE FROM project_versions WHERE id = ?", versionId);
    }

    private static CloudDatabaseService.ProjectVersionRecord mapVersionRow(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new CloudDatabaseService.ProjectVersionRecord(
                rs.getString("id"), rs.getString("project_id"),
                rs.getString("label"), rs.getString("author_id"), rs.getString("author_name"),
                rs.getDouble("bpm"), rs.getInt("total_bars"),
                rs.getString("state_json"), rs.getString("created_at")
        );
    }
}
