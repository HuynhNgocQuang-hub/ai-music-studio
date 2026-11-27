package com.aimusic.studio.controller;

import com.aimusic.studio.cloud.AuthContextHolder;
import com.aimusic.studio.cloud.CloudDatabaseService;
import com.aimusic.studio.cloud.UserPrincipal;
import org.springframework.http.HttpStatus;
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

/**
 * Phase 10B REST endpoints for Producer Profiles (/api/creators), bio updates, and Follow Feed relationships.
 */
@RestController
@RequestMapping("/api/creators")
public class CreatorController {

    private final CloudDatabaseService cloudDb;

    public CreatorController(CloudDatabaseService cloudDb) {
        this.cloudDb = cloudDb;
    }

    @GetMapping
    public Map<String, Object> listCreators(@RequestParam(value = "limit", defaultValue = "12") int limit) {
        String actorKey = AuthContextHolder.getActorQuotaKey();
        int safeLimit = Math.max(1, Math.min(limit, 50));
        List<Map<String, Object>> items = cloudDb.listTopCreators(safeLimit).stream()
                .map(c -> toCreatorMap(c, actorKey))
                .toList();
        return Map.of("items", items, "total", items.size());
    }

    @GetMapping("/{creatorId}")
    public Map<String, Object> getCreatorProfile(@PathVariable("creatorId") String creatorId) {
        String actorKey = AuthContextHolder.getActorQuotaKey();
        CloudDatabaseService.CreatorSummaryRecord summary = cloudDb.getCreatorSummary(creatorId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Creator profile not found."));

        List<Map<String, Object>> releases = cloudDb.listReleases("", "", "recent", creatorId, null).stream()
                .map(r -> toReleaseItem(r, actorKey))
                .toList();

        Map<String, Object> out = new LinkedHashMap<>(toCreatorMap(summary, actorKey));
        out.put("releases", releases);
        return out;
    }

    @PatchMapping("/me")
    public Map<String, Object> updateMyProfile(@RequestBody Map<String, String> body) {
        UserPrincipal caller = AuthContextHolder.get();
        if (caller.isGuest()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Sign in with a Cloud account to customize your Producer Profile.");
        }
        String displayName = body != null ? body.get("display_name") : null;
        String bio = body != null ? body.get("bio") : null;
        CloudDatabaseService.UserProfileRecord updated = cloudDb.updateUserProfile(caller.userId(), displayName, bio)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User profile not found."));
        CloudDatabaseService.CreatorSummaryRecord summary = cloudDb.getCreatorSummary(caller.userId())
                .orElse(new CloudDatabaseService.CreatorSummaryRecord(
                        updated.id(), updated.displayName(), updated.bio() != null ? updated.bio() : "",
                        updated.role(), cloudDb.countFollowers(updated.id()), cloudDb.countFollowing("user:" + updated.id()),
                        0, 0, 0
                ));
        return toCreatorMap(summary, AuthContextHolder.getActorQuotaKey());
    }

    @PostMapping("/{creatorId}/follow")
    public Map<String, Object> toggleFollowCreator(@PathVariable("creatorId") String creatorId) {
        cloudDb.getCreatorSummary(creatorId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Creator not found."));

        UserPrincipal caller = AuthContextHolder.get();
        if ((!caller.isGuest() && caller.userId().equals(creatorId))
                || (caller.isGuest() && "guest".equals(creatorId))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot follow your own profile.");
        }
        String followerKey = AuthContextHolder.getActorQuotaKey();
        return cloudDb.toggleCreatorFollow(followerKey, creatorId);
    }

    private Map<String, Object> toCreatorMap(CloudDatabaseService.CreatorSummaryRecord c, String actorKey) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("user_id", c.userId());
        map.put("display_name", c.displayName());
        map.put("bio", c.bio());
        map.put("role", c.role());
        map.put("followers_count", c.followersCount());
        map.put("following_count", c.followingCount());
        map.put("releases_count", c.releasesCount());
        map.put("total_plays", c.totalPlays());
        map.put("total_likes", c.totalLikes());
        map.put("followed_by_me", cloudDb.isFollowingCreator(actorKey, c.userId()));
        return map;
    }

    private Map<String, Object> toReleaseItem(CloudDatabaseService.PublishedReleaseRecord r, String actorKey) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("share_slug", r.shareSlug());
        map.put("project_id", r.projectId());
        map.put("owner_id", r.ownerId());
        map.put("title", r.title());
        map.put("artist", r.artist());
        map.put("genre", r.genre());
        map.put("bpm", r.bpm());
        map.put("key", r.detectedKey());
        map.put("scale", r.scale());
        map.put("total_bars", r.totalBars());
        map.put("master_format", r.masterFormat());
        map.put("lufs_target", r.lufsTarget());
        map.put("plays_count", r.playsCount());
        map.put("likes_count", cloudDb.countReleaseLikes(r.shareSlug()));
        map.put("liked_by_me", cloudDb.hasActorLikedRelease(r.shareSlug(), actorKey));
        map.put("comments_count", cloudDb.listReleaseComments(r.shareSlug()).size());
        map.put("created_at", r.createdAt());
        map.put("share_url", "/share/" + r.shareSlug());
        map.put("stream_url", "/api/share/" + r.shareSlug() + "/audio");
        map.put("lyrics_summary", r.lyricsSummary());
        return map;
    }
}
