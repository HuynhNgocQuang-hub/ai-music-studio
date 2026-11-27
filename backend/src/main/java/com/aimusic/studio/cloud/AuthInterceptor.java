package com.aimusic.studio.cloud;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.io.IOException;
import java.util.Optional;

/**
 * Resolves Bearer JWT into AuthContextHolder (or Guest identity in Hybrid SaaS mode) per request.
 * Explicitly presented invalid, expired, or logged-out Bearer tokens return HTTP 401.
 */
@Component
public class AuthInterceptor implements HandlerInterceptor {

    private final JwtService jwtService;

    public AuthInterceptor(JwtService jwtService) {
        this.jwtService = jwtService;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws IOException {
        String path = request.getRequestURI();
        String token = AuthContextHolder.extractToken(request);
        UserPrincipal principal = UserPrincipal.GUEST;

        if (token != null) {
            Optional<UserPrincipal> verified = jwtService.verifyToken(token);
            if (verified.isEmpty()) {
                // Allow idempotent logout even if client token already expired/revoked
                if (path != null && path.endsWith("/api/auth/logout")) {
                    AuthContextHolder.set(UserPrincipal.GUEST, extractIp(request));
                    return true;
                }
                response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                response.setContentType(MediaType.APPLICATION_JSON_VALUE);
                response.getWriter().write("{\"detail\":\"Session token is invalid, expired, or has been logged out.\"}");
                return false;
            }
            principal = verified.get();
        }

        AuthContextHolder.set(principal, extractIp(request));
        return true;
    }

    private static String extractIp(HttpServletRequest request) {
        String ip = request.getHeader("X-Forwarded-For");
        if (ip == null || ip.isBlank()) {
            ip = request.getRemoteAddr();
        } else {
            ip = ip.split(",")[0].trim();
        }
        return ip;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) {
        AuthContextHolder.clear();
    }
}
