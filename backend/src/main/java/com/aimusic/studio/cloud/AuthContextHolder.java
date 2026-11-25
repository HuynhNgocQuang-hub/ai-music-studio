package com.aimusic.studio.cloud;

import jakarta.servlet.http.HttpServletRequest;

/**
 * Thread-local holder storing the resolved UserPrincipal and client IP key per request.
 */
public final class AuthContextHolder {

    private static final ThreadLocal<UserPrincipal> USER = new ThreadLocal<>();
    private static final ThreadLocal<String> REMOTE_ADDR = new ThreadLocal<>();

    private AuthContextHolder() {}

    public static void set(UserPrincipal principal, String remoteAddr) {
        USER.set(principal != null ? principal : UserPrincipal.GUEST);
        REMOTE_ADDR.set(remoteAddr != null && !remoteAddr.isBlank() ? remoteAddr : "127.0.0.1");
    }

    public static UserPrincipal get() {
        UserPrincipal p = USER.get();
        return p != null ? p : UserPrincipal.GUEST;
    }

    public static String getOwnerId() {
        UserPrincipal p = get();
        return p.isGuest() ? "guest" : p.userId();
    }

    public static String getActorQuotaKey() {
        UserPrincipal p = get();
        if (!p.isGuest()) {
            return "user:" + p.userId();
        }
        String ip = REMOTE_ADDR.get();
        return "guest:" + (ip != null && !ip.isBlank() ? ip : "local");
    }

    public static void clear() {
        USER.remove();
        REMOTE_ADDR.remove();
    }

    public static String extractToken(HttpServletRequest request) {
        if (request == null) return null;
        String auth = request.getHeader("Authorization");
        if (auth != null && auth.startsWith("Bearer ")) {
            String token = auth.substring(7).trim();
            if (!token.isEmpty()) return token;
        }
        String qp = request.getParameter("token");
        return (qp != null && !qp.isBlank()) ? qp.trim() : null;
    }
}
