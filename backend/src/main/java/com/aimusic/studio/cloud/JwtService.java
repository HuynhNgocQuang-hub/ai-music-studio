package com.aimusic.studio.cloud;

import com.aimusic.studio.config.AppProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Pure-Java HMAC-SHA256 JWT token issuer/verifier with JTI server-side revocation and PBKDF2 password hashing.
 */
@Service
public class JwtService {

    private static final SecureRandom RNG = new SecureRandom();
    private static final int PBKDF2_ITERATIONS = 65536;
    private static final int PBKDF2_KEY_BITS = 256;

    private final ObjectMapper objectMapper;
    private final byte[] hmacSecret;
    private final long expirationSeconds;
    private final CloudDatabaseService cloudDb;
    private final ConcurrentHashMap<String, Long> revokedMemory = new ConcurrentHashMap<>();

    @Autowired
    public JwtService(
            ObjectMapper objectMapper,
            AppProperties properties,
            @Autowired(required = false) CloudDatabaseService cloudDb
    ) {
        this.objectMapper = objectMapper;
        this.cloudDb = cloudDb;
        this.expirationSeconds = Math.max(300L, properties.getJwtExpirationSeconds());
        String configured = properties.getJwtSecret();
        if (configured != null && !configured.isBlank()) {
            this.hmacSecret = sha256(configured.getBytes(StandardCharsets.UTF_8));
        } else {
            byte[] random = new byte[32];
            RNG.nextBytes(random);
            this.hmacSecret = random;
        }
    }

    public JwtService(ObjectMapper objectMapper, AppProperties properties) {
        this(objectMapper, properties, null);
    }

    public String hashPassword(String rawPassword) {
        if (rawPassword == null || rawPassword.length() < 6) {
            throw new IllegalArgumentException("Password must be at least 6 characters.");
        }
        byte[] salt = new byte[16];
        RNG.nextBytes(salt);
        byte[] derived = pbkdf2(rawPassword, salt);
        Base64.Encoder enc = Base64.getEncoder();
        return enc.encodeToString(salt) + ":" + enc.encodeToString(derived);
    }

    public boolean verifyPassword(String rawPassword, String storedHash) {
        if (rawPassword == null || storedHash == null || !storedHash.contains(":")) {
            return false;
        }
        String[] parts = storedHash.split(":", 2);
        try {
            Base64.Decoder dec = Base64.getDecoder();
            byte[] salt = dec.decode(parts[0]);
            byte[] expected = dec.decode(parts[1]);
            byte[] actual = pbkdf2(rawPassword, salt);
            return MessageDigest.isEqual(expected, actual);
        } catch (Exception ex) {
            return false;
        }
    }

    public String issueToken(UserPrincipal principal) {
        try {
            long now = Instant.now().getEpochSecond();
            String jti = UUID.randomUUID().toString().replace("-", "");
            Map<String, Object> header = Map.of("alg", "HS256", "typ", "JWT");
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("jti", jti);
            payload.put("sub", principal.userId());
            payload.put("email", principal.email());
            payload.put("name", principal.displayName());
            payload.put("role", principal.role());
            payload.put("iat", now);
            payload.put("exp", now + expirationSeconds);

            Base64.Encoder urlEnc = Base64.getUrlEncoder().withoutPadding();
            String hdrB64 = urlEnc.encodeToString(objectMapper.writeValueAsBytes(header));
            String payB64 = urlEnc.encodeToString(objectMapper.writeValueAsBytes(payload));
            String signingInput = hdrB64 + "." + payB64;
            String sigB64 = urlEnc.encodeToString(signHmac(signingInput.getBytes(StandardCharsets.UTF_8)));
            return signingInput + "." + sigB64;
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to sign JWT", ex);
        }
    }

    public boolean revokeToken(String token) {
        if (token == null || token.isBlank()) {
            return false;
        }
        String[] parts = token.trim().split("\\.");
        if (parts.length != 3) {
            return false;
        }
        try {
            String signingInput = parts[0] + "." + parts[1];
            byte[] expectedSig = signHmac(signingInput.getBytes(StandardCharsets.UTF_8));
            byte[] providedSig = Base64.getUrlDecoder().decode(parts[2]);
            if (!MessageDigest.isEqual(expectedSig, providedSig)) {
                return false;
            }
            byte[] payloadBytes = Base64.getUrlDecoder().decode(parts[1]);
            JsonNode claims = objectMapper.readTree(payloadBytes);
            String jti = claims.path("jti").asText("");
            long exp = claims.path("exp").asLong(Instant.now().getEpochSecond() + expirationSeconds);
            if (jti.isBlank()) {
                return false;
            }
            revokedMemory.put(jti, exp);
            if (cloudDb != null) {
                cloudDb.saveRevokedToken(jti, exp);
            }
            return true;
        } catch (Exception ex) {
            return false;
        }
    }

    public boolean isTokenRevoked(String jti) {
        if (jti == null || jti.isBlank()) {
            return false;
        }
        long now = Instant.now().getEpochSecond();
        Long memExp = revokedMemory.get(jti);
        if (memExp != null) {
            if (memExp > now) {
                return true;
            }
            revokedMemory.remove(jti);
        }
        if (cloudDb != null && cloudDb.isTokenRevokedInDb(jti)) {
            revokedMemory.put(jti, now + expirationSeconds);
            return true;
        }
        return false;
    }

    public Optional<UserPrincipal> verifyToken(String token) {
        if (token == null || token.isBlank()) {
            return Optional.empty();
        }
        String[] parts = token.trim().split("\\.");
        if (parts.length != 3) {
            return Optional.empty();
        }
        try {
            String signingInput = parts[0] + "." + parts[1];
            byte[] expectedSig = signHmac(signingInput.getBytes(StandardCharsets.UTF_8));
            byte[] providedSig = Base64.getUrlDecoder().decode(parts[2]);
            if (!MessageDigest.isEqual(expectedSig, providedSig)) {
                return Optional.empty();
            }
            byte[] payloadBytes = Base64.getUrlDecoder().decode(parts[1]);
            JsonNode claims = objectMapper.readTree(payloadBytes);
            long exp = claims.path("exp").asLong(0L);
            if (exp <= Instant.now().getEpochSecond()) {
                return Optional.empty();
            }
            String jti = claims.path("jti").asText("");
            if (isTokenRevoked(jti)) {
                return Optional.empty();
            }
            String sub = claims.path("sub").asText("");
            if (sub.isBlank() || "guest".equals(sub)) {
                return Optional.empty();
            }
            return Optional.of(new UserPrincipal(
                    sub,
                    claims.path("email").asText(""),
                    claims.path("name").asText("Creator"),
                    claims.path("role").asText("user")
            ));
        } catch (Exception ex) {
            return Optional.empty();
        }
    }

    private byte[] signHmac(byte[] data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(hmacSecret, "HmacSHA256"));
        return mac.doFinal(data);
    }

    private static byte[] pbkdf2(String password, byte[] salt) {
        try {
            PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, PBKDF2_ITERATIONS, PBKDF2_KEY_BITS);
            SecretKeyFactory skf = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
            return skf.generateSecret(spec).getEncoded();
        } catch (Exception ex) {
            throw new IllegalStateException("PBKDF2 unavailable", ex);
        }
    }

    private static byte[] sha256(byte[] bytes) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(bytes);
        } catch (Exception ex) {
            throw new IllegalStateException("SHA-256 unavailable", ex);
        }
    }
}
