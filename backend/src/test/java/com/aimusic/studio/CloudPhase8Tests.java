package com.aimusic.studio;

import com.aimusic.studio.cloud.CloudDatabaseService;
import com.aimusic.studio.cloud.JwtService;
import com.aimusic.studio.cloud.ObjectStorageService;
import com.aimusic.studio.cloud.QuotaRateLimitService;
import com.aimusic.studio.cloud.UserPrincipal;
import com.aimusic.studio.model.LyricLine;
import com.aimusic.studio.model.MidiNote;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.store.ProjectStateStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.hamcrest.Matchers.greaterThan;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class CloudPhase8Tests {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JwtService jwtService;

    @Autowired
    private ProjectStateStore store;

    @Autowired
    private CloudDatabaseService cloudDb;

    @Autowired
    private ObjectStorageService objectStorage;

    @Autowired
    private QuotaRateLimitService quotaService;

    @Test
    void jwtPasswordHashingAndTamperRejectionWork() {
        String hash = jwtService.hashPassword("secret123");
        assertTrue(jwtService.verifyPassword("secret123", hash));
        assertFalse(jwtService.verifyPassword("wrong", hash));

        UserPrincipal u = new UserPrincipal("u_alice", "alice@studio.dev", "Alice", "user");
        String token = jwtService.issueToken(u);
        assertEquals(3, token.split("\\.").length);

        UserPrincipal parsed = jwtService.verifyToken(token).orElseThrow();
        assertEquals("u_alice", parsed.userId());
        assertEquals("alice@studio.dev", parsed.email());

        String tampered = token.substring(0, token.length() - 4) + "AAAA";
        assertTrue(jwtService.verifyToken(tampered).isEmpty());

        assertTrue(jwtService.revokeToken(token));
        assertTrue(jwtService.verifyToken(token).isEmpty());
    }

    @Test
    void loginLogoutRevokesJwtAndReturnsGuestOnReLogin() throws Exception {
        String email = "auth_flow_" + UUID.randomUUID().toString().substring(0, 6) + "@music.test";
        MvcResult reg = mockMvc.perform(post("/api/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", email,
                                "password", "pass1234",
                                "display_name", "Auth Lifecycle Tester"
                        ))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.authenticated").value(true))
                .andReturn();
        String token1 = objectMapper.readTree(reg.getResponse().getContentAsString()).get("token").asText();

        mockMvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token1))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.authenticated").value(true))
                .andExpect(jsonPath("$.user.email").value(email));

        // Server-side logout revokes token1 immediately
        mockMvc.perform(post("/api/auth/logout").header("Authorization", "Bearer " + token1))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("logged_out"))
                .andExpect(jsonPath("$.authenticated").value(false))
                .andExpect(jsonPath("$.revoked").value(true));

        // Replaying logged-out token1 must return 401 Unauthorized
        mockMvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token1))
                .andExpect(status().isUnauthorized());

        // Anonymous request (no header) still accesses Hybrid Guest mode seamlessly
        mockMvc.perform(get("/api/auth/me"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.authenticated").value(false))
                .andExpect(jsonPath("$.user.user_id").value("guest"));

        // Re-login returns fresh valid token2
        MvcResult reLogin = mockMvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", email,
                                "password", "pass1234"
                        ))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.authenticated").value(true))
                .andReturn();
        String token2 = objectMapper.readTree(reLogin.getResponse().getContentAsString()).get("token").asText();
        assertNotEquals(token1, token2);

        mockMvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token2))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.authenticated").value(true))
                .andExpect(jsonPath("$.user.display_name").value("Auth Lifecycle Tester"));
    }

    @Test
    void authOwnershipCloudRehydrationQuotaAndPublishShareFlow() throws Exception {
        String aliceEmail = "alice_" + UUID.randomUUID().toString().substring(0, 6) + "@music.test";
        String bobEmail = "bob_" + UUID.randomUUID().toString().substring(0, 6) + "@music.test";

        // 1. Register Alice & reject wrong login
        MvcResult regAlice = mockMvc.perform(post("/api/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", aliceEmail,
                                "password", "pass1234",
                                "display_name", "Alice Beatmaker"
                        ))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.authenticated").value(true))
                .andExpect(jsonPath("$.token").isNotEmpty())
                .andExpect(jsonPath("$.user.display_name").value("Alice Beatmaker"))
                .andReturn();
        String aliceToken = objectMapper.readTree(regAlice.getResponse().getContentAsString()).get("token").asText();

        mockMvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", aliceEmail,
                                "password", "wrongpass"
                        ))))
                .andExpect(status().isUnauthorized());

        // Register Bob
        MvcResult regBob = mockMvc.perform(post("/api/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", bobEmail,
                                "password", "pass1234",
                                "display_name", "Bob"
                        ))))
                .andExpect(status().isOk())
                .andReturn();
        String bobToken = objectMapper.readTree(regBob.getResponse().getContentAsString()).get("token").asText();

        // 2. Sync Alice's private project (persists to CloudDB too)
        String pid = "proj_cloud_" + UUID.randomUUID().toString().substring(0, 8);
        ProjectState state = ProjectState.createDefault(pid, "Midnight Cloud Ballad");
        state.getConfig().setGenre("Ballad");
        state.getAnalysis().setBpm(120.0);
        state.getSongStructure().setTotalBars(2);
        state.getLyrics().setLines(List.of(new LyricLine("Chorus", 1, "Bay giữa bầu trời sao đêm nay")));
        state.getTracks().get("lead").setNotes(List.of(new MidiNote(64, 0.0, 1.0, 96, 1.0)));

        mockMvc.perform(put("/api/projects/" + pid + "/sync")
                        .header("Authorization", "Bearer " + aliceToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(state)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("Midnight Cloud Ballad"));

        // Bob cannot read, overwrite, publish, or delete Alice's private project
        mockMvc.perform(get("/api/projects/" + pid).header("Authorization", "Bearer " + bobToken))
                .andExpect(status().isForbidden());
        mockMvc.perform(post("/api/projects/" + pid + "/publish").header("Authorization", "Bearer " + bobToken))
                .andExpect(status().isForbidden());
        mockMvc.perform(delete("/api/projects/" + pid).header("Authorization", "Bearer " + bobToken))
                .andExpect(status().isForbidden());

        // 3. Alice deletes hot Redis/Memory cache ONLY -> CloudDB auto-rehydrates GET /api/projects/{id}!
        store.deleteProject(pid);
        assertTrue(cloudDb.findProject(pid).isPresent());
        mockMvc.perform(get("/api/projects/" + pid).header("Authorization", "Bearer " + aliceToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.project_id").value(pid))
                .andExpect(jsonPath("$.title").value("Midnight Cloud Ballad"));

        // 4. Alice publishes public demo link -> GET /api/share/{slug} & /audio work anonymously
        MvcResult pubRes = mockMvc.perform(post("/api/projects/" + pid + "/publish")
                        .header("Authorization", "Bearer " + aliceToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "format", "wav",
                                "artist", "Alice Live"
                        ))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("published"))
                .andExpect(jsonPath("$.share_slug").isNotEmpty())
                .andReturn();
        JsonNode pubJson = objectMapper.readTree(pubRes.getResponse().getContentAsString());
        String slug = pubJson.get("share_slug").asText();

        mockMvc.perform(get("/api/share"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.total", greaterThan(0)));

        mockMvc.perform(get("/api/share/" + slug))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("Midnight Cloud Ballad"))
                .andExpect(jsonPath("$.artist").value("Alice Live"))
                .andExpect(jsonPath("$.plays_count").value(1));

        MvcResult audioStream = mockMvc.perform(get("/api/share/" + slug + "/audio"))
                .andExpect(status().isOk())
                .andReturn();
        assertTrue(audioStream.getResponse().getContentAsByteArray().length > 44);
        assertEquals("RIFF", new String(audioStream.getResponse().getContentAsByteArray(), 0, 4));

        // 5. Revoke share -> 404 on slug
        mockMvc.perform(delete("/api/projects/" + pid + "/publish")
                        .header("Authorization", "Bearer " + aliceToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("unpublished"));
        mockMvc.perform(get("/api/share/" + slug))
                .andExpect(status().isNotFound());

        // 6. Health endpoint reports Phase 8 Cloud infrastructure details
        mockMvc.perform(get("/api/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.cloud.database_ready").value(true))
                .andExpect(jsonPath("$.cloud.auth_mode").value("hybrid_jwt"));

        // 7. Clean up Alice's project
        mockMvc.perform(delete("/api/projects/" + pid).header("Authorization", "Bearer " + aliceToken))
                .andExpect(status().isOk());

        // 8. Quota rate limit enforcement (HTTP 429 when daily generate limit exceeded)
        String actorKey = "user:u_quota_test";
        UserPrincipal qp = new UserPrincipal("u_quota_test", "q@test.com", "Quota", "user");
        quotaService.resetForActor(actorKey);
        for (int i = 0; i < 30; i++) {
            quotaService.consumeGenerateQuota(qp, actorKey);
        }
        assertThrows(org.springframework.web.server.ResponseStatusException.class,
                () -> quotaService.consumeGenerateQuota(qp, actorKey));
        quotaService.resetForActor(actorKey);
        assertNotNull(objectStorage.status().get("object_storage_backend"));
    }
}
