package com.aimusic.studio.cloud;

/**
 * Authenticated user or guest identity bound to the current HTTP request.
 */
public record UserPrincipal(
        String userId,
        String email,
        String displayName,
        String role
) {
    public static final UserPrincipal GUEST = new UserPrincipal("guest", "guest@local", "Guest Producer", "guest");

    public boolean isGuest() {
        return userId == null || userId.isBlank() || "guest".equals(userId);
    }
}
