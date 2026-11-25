package com.aimusic.studio.controller;

import com.aimusic.studio.cloud.AuthContextHolder;
import com.aimusic.studio.cloud.CloudDatabaseService;
import com.aimusic.studio.cloud.JwtService;
import com.aimusic.studio.cloud.ObjectStorageService;
import com.aimusic.studio.cloud.QuotaRateLimitService;
import com.aimusic.studio.cloud.UserPrincipal;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private static final Pattern EMAIL_PATTERN = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$");

    private final CloudDatabaseService db;
    private final JwtService jwtService;
    private final QuotaRateLimitService quotaService;
    private final ObjectStorageService objectStorage;

    public AuthController(
            CloudDatabaseService db,
            JwtService jwtService,
            QuotaRateLimitService quotaService,
            ObjectStorageService objectStorage
    ) {
        this.db = db;
        this.jwtService = jwtService;
        this.quotaService = quotaService;
        this.objectStorage = objectStorage;
    }

    @PostMapping("/register")
    public Map<String, Object> register(@RequestBody Map<String, String> body) {
        String email = body != null && body.get("email") != null ? body.get("email").trim().toLowerCase(Locale.ROOT) : "";
        String password = body != null && body.get("password") != null ? body.get("password") : "";
        String displayName = body != null && body.get("display_name") != null ? body.get("display_name").trim() : "";

        if (!EMAIL_PATTERN.matcher(email).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid email address.");
        }
        if (password.length() < 6) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Password must be at least 6 characters.");
        }
        if (db.findUserByEmail(email).isPresent()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Email is already registered.");
        }
        if (displayName.isBlank()) {
            displayName = email.substring(0, email.indexOf('@'));
        }

        String userId = "u_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String passwordHash = jwtService.hashPassword(password);
        CloudDatabaseService.UserRecord created = db.createUser(userId, email, displayName, passwordHash, "user");
        UserPrincipal principal = new UserPrincipal(created.id(), created.email(), created.displayName(), created.role());
        String token = jwtService.issueToken(principal);
        return buildAuthPayload(true, token, principal);
    }

    @PostMapping("/login")
    public Map<String, Object> login(@RequestBody Map<String, String> body) {
        String email = body != null && body.get("email") != null ? body.get("email").trim().toLowerCase(Locale.ROOT) : "";
        String password = body != null && body.get("password") != null ? body.get("password") : "";
        if (email.isBlank() || password.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Email and password are required.");
        }

        CloudDatabaseService.UserRecord user = db.findUserByEmail(email)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid email or password."));
        if (!jwtService.verifyPassword(password, user.passwordHash())) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid email or password.");
        }

        UserPrincipal principal = new UserPrincipal(user.id(), user.email(), user.displayName(), user.role());
        String token = jwtService.issueToken(principal);
        return buildAuthPayload(true, token, principal);
    }

    @PostMapping("/oauth/dev")
    public Map<String, Object> oauthDevLogin(@RequestBody(required = false) Map<String, String> body) {
        String rawProvider = body != null && body.get("provider") != null
                ? body.get("provider").trim().toLowerCase(Locale.ROOT) : "google";
        final String provider = ("google".equals(rawProvider) || "github".equals(rawProvider)) ? rawProvider : "google";
        final String email = (body != null && body.get("email") != null && EMAIL_PATTERN.matcher(body.get("email").trim()).matches())
                ? body.get("email").trim().toLowerCase(Locale.ROOT)
                : provider + ".creator@aimusic.local";
        final String displayName = (body != null && body.get("display_name") != null && !body.get("display_name").isBlank())
                ? body.get("display_name").trim()
                : (provider.equals("github") ? "GitHub Producer" : "Google Creator");

        CloudDatabaseService.UserRecord user = db.findUserByEmail(email).orElseGet(() -> {
            String uid = "u_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            String pwHash = jwtService.hashPassword("oauth_" + UUID.randomUUID());
            return db.createUser(uid, email, displayName, pwHash, "oauth-" + provider);
        });

        UserPrincipal principal = new UserPrincipal(user.id(), user.email(), user.displayName(), user.role());
        String token = jwtService.issueToken(principal);
        Map<String, Object> out = buildAuthPayload(true, token, principal);
        out.put("oauth_provider", provider + "-local-sandbox");
        return out;
    }

    @GetMapping("/me")
    public Map<String, Object> currentSession() {
        UserPrincipal principal = AuthContextHolder.get();
        return buildAuthPayload(!principal.isGuest(), null, principal);
    }

    private Map<String, Object> buildAuthPayload(boolean authenticated, String token, UserPrincipal principal) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("authenticated", authenticated);
        if (token != null) {
            out.put("token", token);
        }
        Map<String, Object> userMap = new LinkedHashMap<>();
        userMap.put("user_id", principal.userId());
        userMap.put("email", principal.email());
        userMap.put("display_name", principal.displayName());
        userMap.put("role", principal.role());
        out.put("user", userMap);
        String actorKey = principal.isGuest() ? AuthContextHolder.getActorQuotaKey() : ("user:" + principal.userId());
        out.put("quota", quotaService.getSummary(principal, actorKey));

        Map<String, Object> cloud = new LinkedHashMap<>();
        cloud.putAll(db.status());
        cloud.putAll(objectStorage.status());
        out.put("cloud", cloud);
        return out;
    }
}
