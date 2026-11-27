package com.aimusic.studio.cloud;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Segregated social & profile repository managing producer profiles, follow graph queries,
 * and leaderboard aggregations without coupling callers to unrelated persistence tables.
 */
@Service
public class CreatorSocialRepository {

    interface ReleaseQueryPort {
        List<CloudDatabaseService.PublishedReleaseRecord> listReleases(
                String search, String genre, String sort, String ownerId, Set<String> allowedOwnerIds);

        int countReleaseLikes(String shareSlug);
    }

    private final JdbcTemplate jdbc;
    private final ReleaseQueryPort releasePort;

    @Autowired
    public CreatorSocialRepository(CloudDatabaseService db) {
        this(db.getJdbcTemplate(), new ReleaseQueryPort() {
            @Override
            public List<CloudDatabaseService.PublishedReleaseRecord> listReleases(
                    String search, String genre, String sort, String ownerId, Set<String> allowedOwnerIds) {
                return db.listReleases(search, genre, sort, ownerId, allowedOwnerIds);
            }

            @Override
            public int countReleaseLikes(String shareSlug) {
                return db.countReleaseLikes(shareSlug);
            }
        });
    }

    CreatorSocialRepository(JdbcTemplate jdbc, ReleaseQueryPort releasePort) {
        this.jdbc = jdbc;
        this.releasePort = releasePort;
    }

    public Optional<CloudDatabaseService.UserProfileRecord> getUserProfile(String userId) {
        if (userId == null || userId.isBlank()) return Optional.empty();
        List<CloudDatabaseService.UserProfileRecord> rows = jdbc.query(
                "SELECT id, display_name, role, bio, created_at FROM users WHERE id = ?",
                (rs, i) -> new CloudDatabaseService.UserProfileRecord(
                        rs.getString("id"), rs.getString("display_name"),
                        rs.getString("role"), rs.getString("bio"), rs.getString("created_at")
                ),
                userId
        );
        return rows.stream().findFirst();
    }

    public Optional<CloudDatabaseService.UserProfileRecord> updateUserProfile(String userId, String displayName, String bio) {
        Optional<CloudDatabaseService.UserProfileRecord> existing = getUserProfile(userId);
        if (existing.isEmpty()) return Optional.empty();
        CloudDatabaseService.UserProfileRecord prev = existing.get();
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

    public List<CloudDatabaseService.PublishedReleaseRecord> listCreatorReleases(String creatorId) {
        return releasePort.listReleases("", "", "recent", creatorId, null);
    }

    public Optional<CloudDatabaseService.CreatorSummaryRecord> getCreatorSummary(String creatorId) {
        if (creatorId == null || creatorId.isBlank()) return Optional.empty();
        Optional<CloudDatabaseService.UserProfileRecord> userOpt = getUserProfile(creatorId);
        List<CloudDatabaseService.PublishedReleaseRecord> releases = releasePort.listReleases("", "", "recent", creatorId, null);
        if (userOpt.isEmpty() && releases.isEmpty()) {
            return Optional.empty();
        }
        String name = userOpt.map(CloudDatabaseService.UserProfileRecord::displayName)
                .orElseGet(() -> releases.stream()
                        .map(CloudDatabaseService.PublishedReleaseRecord::artist)
                        .filter(a -> a != null && !a.isBlank())
                        .findFirst()
                        .orElse("AI Producer"));
        String bio = userOpt.map(u -> u.bio() != null ? u.bio() : "").orElse("");
        String role = userOpt.map(CloudDatabaseService.UserProfileRecord::role).orElse("creator");
        int totalPlays = releases.stream().mapToInt(CloudDatabaseService.PublishedReleaseRecord::playsCount).sum();
        int totalLikes = releases.stream().mapToInt(r -> releasePort.countReleaseLikes(r.shareSlug())).sum();
        int followers = countFollowers(creatorId);
        int following = countFollowing("user:" + creatorId);
        return Optional.of(new CloudDatabaseService.CreatorSummaryRecord(
                creatorId, name, bio, role, followers, following, releases.size(), totalPlays, totalLikes
        ));
    }

    public List<CloudDatabaseService.CreatorSummaryRecord> listTopCreators(int limit) {
        List<CloudDatabaseService.PublishedReleaseRecord> all = releasePort.listReleases("", "", "recent", null, null);
        Map<String, List<CloudDatabaseService.PublishedReleaseRecord>> byOwner = new LinkedHashMap<>();
        for (CloudDatabaseService.PublishedReleaseRecord r : all) {
            String owner = (r.ownerId() != null && !r.ownerId().isBlank()) ? r.ownerId() : "guest";
            byOwner.computeIfAbsent(owner, k -> new ArrayList<>()).add(r);
        }
        List<CloudDatabaseService.CreatorSummaryRecord> summaries = new ArrayList<>();
        for (String ownerId : byOwner.keySet()) {
            getCreatorSummary(ownerId).ifPresent(summaries::add);
        }
        summaries.sort(Comparator.comparingInt((CloudDatabaseService.CreatorSummaryRecord c) ->
                (c.totalLikes() * 3) + c.totalPlays() + (c.followersCount() * 5)
        ).reversed());
        if (summaries.size() > limit) {
            return summaries.subList(0, limit);
        }
        return summaries;
    }
}
