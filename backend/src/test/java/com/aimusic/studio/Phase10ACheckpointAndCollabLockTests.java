package com.aimusic.studio;

import com.aimusic.studio.cloud.CloudDatabaseService;
import com.aimusic.studio.model.ProjectState;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.websocket.ContainerProvider;
import jakarta.websocket.WebSocketContainer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.net.URI;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.hamcrest.Matchers.hasSize;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "APP_CLOUD_DATA_DIR=mem",
        "REDIS_RETRY_INTERVAL_MS=100"
})
class Phase10ACheckpointAndCollabLockTests {

    @LocalServerPort
    private int port;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private CloudDatabaseService cloudDb;

    private String registerUser(String prefix, String displayName) throws Exception {
        String email = prefix + "_" + UUID.randomUUID().toString().substring(0, 6) + "@phase10a.test";
        MvcResult res = mockMvc.perform(post("/api/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", email,
                                "password", "pass1234",
                                "display_name", displayName
                        ))))
                .andExpect(status().isOk())
                .andReturn();
        return objectMapper.readTree(res.getResponse().getContentAsString()).get("token").asText();
    }

    @Test
    void versionCheckpointsCollabTrackLocksRoomChatAndRemixLineage() throws Exception {
        String aliceToken = registerUser("p10a_alice", "Alice Producer");
        String bobToken = registerUser("p10a_bob", "Bob Arranger");
        String eveToken = registerUser("p10a_eve", "Eve Stranger");

        String pid = "proj_p10a_" + UUID.randomUUID().toString().substring(0, 8);
        ProjectState state = ProjectState.createDefault(pid, "Checkpoint Masterpiece");
        state.getAnalysis().setBpm(105.0);
        state.setRemixedFrom(Map.of(
                "share_slug", "origin-hit-123456",
                "title", "Origin Hit",
                "artist", "Original Mentor"
        ));

        mockMvc.perform(put("/api/projects/" + pid + "/sync")
                        .header("Authorization", "Bearer " + aliceToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(state)))
                .andExpect(status().isOk());

        // Publish & verify remixed_from lineage metadata preserved on Showcase
        MvcResult pubRes = mockMvc.perform(post("/api/projects/" + pid + "/publish")
                        .header("Authorization", "Bearer " + aliceToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"format\":\"wav\",\"artist\":\"Alice Producer\"}"))
                .andExpect(status().isOk())
                .andReturn();
        String slug = objectMapper.readTree(pubRes.getResponse().getContentAsString()).get("share_slug").asText();

        mockMvc.perform(get("/api/share/" + slug))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.remixed_from.share_slug").value("origin-hit-123456"))
                .andExpect(jsonPath("$.remixed_from.title").value("Origin Hit"));

        // Save Checkpoint v1 at 105 BPM
        MvcResult verRes = mockMvc.perform(post("/api/projects/" + pid + "/versions")
                        .header("Authorization", "Bearer " + aliceToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"label\":\"Pre-Drop 105 BPM\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.label").value("Pre-Drop 105 BPM"))
                .andExpect(jsonPath("$.bpm").value(105.0))
                .andReturn();
        String verId = objectMapper.readTree(verRes.getResponse().getContentAsString()).get("id").asText();

        mockMvc.perform(get("/api/projects/" + pid + "/versions")
                        .header("Authorization", "Bearer " + aliceToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items", hasSize(1)));

        // Enable collab room and join Alice + Bob
        MvcResult roomRes = mockMvc.perform(post("/api/studio/" + pid + "/collab/session")
                        .header("Authorization", "Bearer " + aliceToken))
                .andExpect(status().isOk())
                .andReturn();
        String roomCode = objectMapper.readTree(roomRes.getResponse().getContentAsString()).get("room_code").asText();

        WebSocketContainer wsContainer = ContainerProvider.getWebSocketContainer();
        wsContainer.setDefaultMaxTextMessageBufferSize(2 * 1024 * 1024);
        StandardWebSocketClient wsClient = new StandardWebSocketClient(wsContainer);
        BlockingQueue<JsonNode> aliceInbox = new LinkedBlockingQueue<>();
        BlockingQueue<JsonNode> bobInbox = new LinkedBlockingQueue<>();

        WebSocketSession aliceWs = wsClient.execute(
                new CollectingHandler(aliceInbox),
                new WebSocketHttpHeaders(),
                URI.create("ws://127.0.0.1:" + port + "/ws/collab?projectId=" + pid + "&room=" + roomCode + "&token=" + aliceToken + "&clientId=cli_a")
        ).get(5, TimeUnit.SECONDS);

        WebSocketSession bobWs = wsClient.execute(
                new CollectingHandler(bobInbox),
                new WebSocketHttpHeaders(),
                URI.create("ws://127.0.0.1:" + port + "/ws/collab?projectId=" + pid + "&room=" + roomCode + "&token=" + bobToken + "&clientId=cli_b")
        ).get(5, TimeUnit.SECONDS);

        assertNotNull(waitForCondition(bobInbox, n -> "room_snapshot".equals(n.path("type").asText()), 5));

        // Alice locks "bass" track -> Bob receives track_locks, and Bob's attempt to lock "bass" returns error!
        aliceWs.sendMessage(new TextMessage("{\"type\":\"track_lock\",\"track_id\":\"bass\",\"locked\":true}"));
        JsonNode lockEvt = waitForCondition(bobInbox,
                n -> "track_locks".equals(n.path("type").asText()) && n.path("track_locks").has("bass"), 5);
        assertNotNull(lockEvt);
        assertEquals("cli_a", lockEvt.path("track_locks").path("bass").path("client_id").asText());

        bobWs.sendMessage(new TextMessage("{\"type\":\"track_lock\",\"track_id\":\"bass\",\"locked\":true}"));
        JsonNode conflictErr = waitForCondition(bobInbox, n -> "error".equals(n.path("type").asText()), 5);
        assertNotNull(conflictErr);

        // Live Room Chat over WS
        bobWs.sendMessage(new TextMessage("{\"type\":\"room_chat\",\"text\":\"Anh giu track bass nhe!\"}"));
        JsonNode chatEvt = waitForCondition(aliceInbox, n -> "room_chat".equals(n.path("type").asText()), 5);
        assertNotNull(chatEvt);
        assertEquals("Anh giu track bass nhe!", chatEvt.path("message").path("text").asText());

        // Alice edits BPM -> 132 then restores Checkpoint v1 (105 BPM) -> Bob gets live state_sync with 105 BPM!
        state.getAnalysis().setBpm(132.0);
        mockMvc.perform(put("/api/projects/" + pid + "/sync")
                        .header("Authorization", "Bearer " + aliceToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(state)))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/projects/" + pid + "/versions/" + verId + "/restore")
                        .header("Authorization", "Bearer " + aliceToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.project_state.analysis.bpm").value(105.0));

        JsonNode restoreSync = waitForCondition(bobInbox,
                n -> "state_sync".equals(n.path("type").asText())
                        && Math.abs(n.path("state").path("analysis").path("bpm").asDouble() - 105.0) < 0.1,
                5);
        assertNotNull(restoreSync);

        // Disconnecting Alice auto-releases "bass" track lock -> Bob sees empty track_locks
        aliceWs.close(CloseStatus.NORMAL);
        JsonNode unlockEvt = waitForCondition(bobInbox,
                n -> "track_locks".equals(n.path("type").asText()) && !n.path("track_locks").has("bass"), 5);
        assertNotNull(unlockEvt);

        if (bobWs.isOpen()) bobWs.close(CloseStatus.NORMAL);

        // Eve cannot delete Alice's checkpoint (403); deleting project cascades project_versions
        mockMvc.perform(delete("/api/projects/" + pid + "/versions/" + verId)
                        .header("Authorization", "Bearer " + eveToken))
                .andExpect(status().isForbidden());

        mockMvc.perform(delete("/api/projects/" + pid).header("Authorization", "Bearer " + aliceToken))
                .andExpect(status().isOk());
        assertTrue(cloudDb.listProjectVersions(pid).isEmpty());
    }

    private JsonNode waitForCondition(
            BlockingQueue<JsonNode> q,
            java.util.function.Predicate<JsonNode> pred,
            long seconds
    ) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        while (System.nanoTime() < deadline) {
            long remMs = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
            if (remMs <= 0) break;
            JsonNode next = q.poll(Math.min(remMs, 250), TimeUnit.MILLISECONDS);
            if (next != null && pred.test(next)) return next;
        }
        return null;
    }

    private class CollectingHandler extends TextWebSocketHandler {
        private final BlockingQueue<JsonNode> inbox;

        CollectingHandler(BlockingQueue<JsonNode> inbox) {
            this.inbox = inbox;
        }

        @Override
        protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
            inbox.offer(objectMapper.readTree(message.getPayload()));
        }
    }
}
