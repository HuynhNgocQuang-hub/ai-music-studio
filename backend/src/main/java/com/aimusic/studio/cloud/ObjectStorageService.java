package com.aimusic.studio.cloud;

import com.aimusic.studio.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * S3/MinIO object storage client using AWS SigV4 with automatic local disk or memory fallback.
 */
@Service
public class ObjectStorageService {

    private static final Logger log = LoggerFactory.getLogger(ObjectStorageService.class);
    private static final DateTimeFormatter AMZ_DATE_FMT = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'");
    private static final DateTimeFormatter DATE_STAMP_FMT = DateTimeFormatter.ofPattern("yyyyMMdd");

    private final String s3Endpoint;
    private final String bucket;
    private final String accessKey;
    private final String secretKey;
    private final boolean memoryFallbackOnly;
    private final Path localRoot;
    private final HttpClient httpClient;
    private final AtomicBoolean s3Connected = new AtomicBoolean(false);
    private final AtomicBoolean bucketEnsured = new AtomicBoolean(false);
    private final ConcurrentHashMap<String, byte[]> memoryObjects = new ConcurrentHashMap<>();

    public ObjectStorageService(AppProperties properties) {
        String rawEndpoint = properties.getS3Endpoint();
        this.s3Endpoint = (rawEndpoint != null && !rawEndpoint.isBlank())
                ? rawEndpoint.trim().replaceAll("/+$", "")
                : "";
        this.bucket = (properties.getS3Bucket() != null && !properties.getS3Bucket().isBlank())
                ? properties.getS3Bucket().trim()
                : "aimusic-cloud";
        this.accessKey = properties.getS3AccessKey() != null ? properties.getS3AccessKey() : "minioadmin";
        this.secretKey = properties.getS3SecretKey() != null ? properties.getS3SecretKey() : "minioadmin";
        String dir = properties.getCloudDataDir() != null ? properties.getCloudDataDir().trim() : "./data";
        this.memoryFallbackOnly = "mem".equalsIgnoreCase(dir);
        this.localRoot = this.memoryFallbackOnly ? null : Path.of(dir, "s3-fallback", this.bucket).toAbsolutePath().normalize();
        this.httpClient = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(2))
                .build();
        probeS3();
    }

    public boolean isS3Connected() {
        return s3Connected.get();
    }

    public String getBackendName() {
        if (s3Connected.get()) return "minio-s3";
        return memoryFallbackOnly ? "memory-s3-fallback" : "local-s3-fallback";
    }

    public Map<String, Object> status() {
        if (!s3Endpoint.isEmpty() && !s3Connected.get()) {
            probeS3();
        }
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("object_storage_backend", getBackendName());
        info.put("object_storage_connected", s3Connected.get());
        info.put("bucket", bucket);
        return info;
    }

    public String putObject(String key, byte[] data, String contentType) {
        String cleanKey = sanitizeKey(key);
        byte[] bytes = data != null ? data : new byte[0];
        if (!s3Endpoint.isEmpty() && ensureBucket()) {
            try {
                HttpResponse<byte[]> resp = signedS3Request("PUT", "/" + bucket + "/" + cleanKey, bytes, contentType);
                if (resp.statusCode() >= 200 && resp.statusCode() < 300) {
                    s3Connected.set(true);
                    return cleanKey;
                }
                log.warn("S3 PUT {} returned HTTP {}; falling back locally.", cleanKey, resp.statusCode());
            } catch (Exception ex) {
                s3Connected.set(false);
                log.debug("S3 PUT {} failed ({}); falling back locally.", cleanKey, ex.getMessage());
            }
        }
        writeFallback(cleanKey, bytes);
        return cleanKey;
    }

    public Optional<byte[]> getObject(String key) {
        String cleanKey = sanitizeKey(key);
        if (!s3Endpoint.isEmpty() && s3Connected.get()) {
            try {
                HttpResponse<byte[]> resp = signedS3Request("GET", "/" + bucket + "/" + cleanKey, new byte[0], null);
                if (resp.statusCode() == 200) {
                    return Optional.of(resp.body());
                }
            } catch (Exception ex) {
                s3Connected.set(false);
                log.debug("S3 GET {} failed ({}); trying local fallback.", cleanKey, ex.getMessage());
            }
        }
        return readFallback(cleanKey);
    }

    public void deleteObject(String key) {
        String cleanKey = sanitizeKey(key);
        if (!s3Endpoint.isEmpty() && s3Connected.get()) {
            try {
                signedS3Request("DELETE", "/" + bucket + "/" + cleanKey, new byte[0], null);
            } catch (Exception ex) {
                log.debug("S3 DELETE {} failed: {}", cleanKey, ex.getMessage());
            }
        }
        if (memoryFallbackOnly) {
            memoryObjects.remove(cleanKey);
        } else if (localRoot != null) {
            try {
                Files.deleteIfExists(resolveSafeFallbackPath(cleanKey));
            } catch (IOException ignored) {
            }
        }
    }

    private void probeS3() {
        if (s3Endpoint.isEmpty()) {
            s3Connected.set(false);
            return;
        }
        try {
            HttpResponse<byte[]> head = signedS3Request("HEAD", "/" + bucket, new byte[0], null);
            if (head.statusCode() >= 200 && head.statusCode() < 500) {
                s3Connected.set(true);
                if (head.statusCode() == 200) {
                    bucketEnsured.set(true);
                }
                log.info("Connected to S3/MinIO object storage at {} (bucket={}).", s3Endpoint, bucket);
            } else {
                s3Connected.set(false);
            }
        } catch (Exception ex) {
            s3Connected.set(false);
            log.info("MinIO/S3 unreachable ({}); using {} fallback.", ex.getMessage(), getBackendName());
        }
    }

    private boolean ensureBucket() {
        if (bucketEnsured.get() && s3Connected.get()) return true;
        try {
            HttpResponse<byte[]> head = signedS3Request("HEAD", "/" + bucket, new byte[0], null);
            if (head.statusCode() == 200) {
                s3Connected.set(true);
                bucketEnsured.set(true);
                return true;
            }
            HttpResponse<byte[]> mk = signedS3Request("PUT", "/" + bucket, new byte[0], null);
            if (mk.statusCode() >= 200 && mk.statusCode() < 300 || mk.statusCode() == 409) {
                s3Connected.set(true);
                bucketEnsured.set(true);
                return true;
            }
        } catch (Exception ex) {
            s3Connected.set(false);
        }
        return false;
    }

    private HttpResponse<byte[]> signedS3Request(String method, String canonicalUri, byte[] body, String contentType) throws Exception {
        URI endpointUri = URI.create(s3Endpoint);
        String host = endpointUri.getPort() > 0
                ? endpointUri.getHost() + ":" + endpointUri.getPort()
                : endpointUri.getHost();
        ZonedDateTime now = ZonedDateTime.now(ZoneOffset.UTC);
        String amzDate = AMZ_DATE_FMT.format(now);
        String dateStamp = DATE_STAMP_FMT.format(now);
        String payloadHash = sha256Hex(body);

        String canonicalHeaders = "host:" + host + "\n"
                + "x-amz-content-sha256:" + payloadHash + "\n"
                + "x-amz-date:" + amzDate + "\n";
        String signedHeaders = "host;x-amz-content-sha256;x-amz-date";
        String canonicalRequest = method + "\n" + canonicalUri + "\n\n"
                + canonicalHeaders + "\n" + signedHeaders + "\n" + payloadHash;

        String scope = dateStamp + "/us-east-1/s3/aws4_request";
        String stringToSign = "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n"
                + sha256Hex(canonicalRequest.getBytes(StandardCharsets.UTF_8));

        byte[] signingKey = getSignatureKey(secretKey, dateStamp, "us-east-1", "s3");
        String signature = HexFormat.of().formatHex(hmacSha256(signingKey, stringToSign));
        String authorization = "AWS4-HMAC-SHA256 Credential=" + accessKey + "/" + scope
                + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;

        HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                .uri(URI.create(s3Endpoint + canonicalUri))
                .timeout(Duration.ofSeconds(10))
                .header("Host", host)
                .header("x-amz-date", amzDate)
                .header("x-amz-content-sha256", payloadHash)
                .header("Authorization", authorization);

        if (contentType != null && !contentType.isBlank()) {
            reqBuilder.header("Content-Type", contentType);
        }

        HttpRequest.BodyPublisher publisher = ("PUT".equals(method) || "POST".equals(method))
                ? HttpRequest.BodyPublishers.ofByteArray(body)
                : HttpRequest.BodyPublishers.noBody();
        reqBuilder.method(method, publisher);

        return httpClient.send(reqBuilder.build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    private void writeFallback(String cleanKey, byte[] data) {
        if (memoryFallbackOnly) {
            memoryObjects.put(cleanKey, data);
            return;
        }
        try {
            Path target = resolveSafeFallbackPath(cleanKey);
            Files.createDirectories(target.getParent());
            Files.write(target, data);
        } catch (IOException ex) {
            throw new IllegalStateException("Failed to write fallback object " + cleanKey, ex);
        }
    }

    private Optional<byte[]> readFallback(String cleanKey) {
        if (memoryFallbackOnly) {
            return Optional.ofNullable(memoryObjects.get(cleanKey));
        }
        try {
            Path target = resolveSafeFallbackPath(cleanKey);
            if (Files.isRegularFile(target)) {
                return Optional.of(Files.readAllBytes(target));
            }
        } catch (IOException ignored) {
        }
        return Optional.empty();
    }

    private Path resolveSafeFallbackPath(String cleanKey) {
        Path resolved = localRoot.resolve(cleanKey).normalize();
        if (!resolved.startsWith(localRoot)) {
            throw new IllegalArgumentException("Invalid object storage key.");
        }
        return resolved;
    }

    private static String sanitizeKey(String rawKey) {
        String cleaned = (rawKey != null ? rawKey : "object").replace('\\', '/').replaceAll("^/+", "");
        cleaned = cleaned.replace("..", "_").replaceAll("[^A-Za-z0-9._/-]", "_");
        return cleaned.isBlank() ? "object" : cleaned;
    }

    private static String sha256Hex(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static byte[] hmacSha256(byte[] key, String data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
    }

    private static byte[] getSignatureKey(String key, String dateStamp, String region, String service) throws Exception {
        byte[] kSecret = ("AWS4" + key).getBytes(StandardCharsets.UTF_8);
        byte[] kDate = hmacSha256(kSecret, dateStamp);
        byte[] kRegion = hmacSha256(kDate, region);
        byte[] kService = hmacSha256(kRegion, service);
        return hmacSha256(kService, "aws4_request");
    }
}
