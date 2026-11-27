package com.aimusic.studio.cloud;

import com.aimusic.studio.model.ProjectState;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Shared DTO serializer for published release summaries, detailed share views, and comments,
 * guaranteeing field consistency across {@code PublishShareController} and {@code CreatorController}.
 */
@Service
public class ReleaseDtoMapper {

    private final CloudDatabaseService cloudDb;

    public ReleaseDtoMapper(CloudDatabaseService cloudDb) {
        this.cloudDb = cloudDb;
    }

    public Map<String, Object> toCreatorReleaseMap(
            CloudDatabaseService.PublishedReleaseRecord r,
            String actorKey
    ) {
        List<CloudDatabaseService.ReleaseCommentRecord> comments = cloudDb.listReleaseComments(r.shareSlug());
        return buildBaseReleaseMap(r, actorKey, comments.size());
    }

    public Map<String, Object> toShareReleaseMap(
            CloudDatabaseService.PublishedReleaseRecord r,
            ProjectState state,
            String actorKey
    ) {
        List<CloudDatabaseService.ReleaseCommentRecord> comments = cloudDb.listReleaseComments(r.shareSlug());
        Map<String, Object> map = buildBaseReleaseMap(r, actorKey, comments.size());
        map.put("creator_followed", r.ownerId() != null && !r.ownerId().isBlank() && cloudDb.isFollowingCreator(actorKey, r.ownerId()));
        if (state != null) {
            map.put("sections", state.getSongStructure() != null ? state.getSongStructure().getSections() : List.of());
            map.put("chords", state.getSongStructure() != null ? state.getSongStructure().getChords() : List.of());
            map.put("lyrics", state.getLyrics() != null ? state.getLyrics().getLines() : List.of());
            map.put("comments", comments.stream().map(ReleaseDtoMapper::toCommentMap).toList());
            if (state.getRemixedFrom() != null && !state.getRemixedFrom().isEmpty()) {
                map.put("remixed_from", state.getRemixedFrom());
            }
        }
        return map;
    }

    public static Map<String, Object> toCommentMap(CloudDatabaseService.ReleaseCommentRecord c) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("id", c.id());
        map.put("share_slug", c.shareSlug());
        map.put("author_id", c.authorId());
        map.put("author_name", c.authorName());
        map.put("timestamp_sec", c.timestampSec());
        map.put("bar_number", c.barNumber());
        map.put("text", c.text());
        map.put("created_at", c.createdAt());
        return map;
    }

    private Map<String, Object> buildBaseReleaseMap(
            CloudDatabaseService.PublishedReleaseRecord r,
            String actorKey,
            int commentsCount
    ) {
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
        map.put("comments_count", commentsCount);
        map.put("created_at", r.createdAt());
        map.put("share_url", "/share/" + r.shareSlug());
        map.put("stream_url", "/api/share/" + r.shareSlug() + "/audio");
        map.put("lyrics_summary", r.lyricsSummary());
        return map;
    }
}
