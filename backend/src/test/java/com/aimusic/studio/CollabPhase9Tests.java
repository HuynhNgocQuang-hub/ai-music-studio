package com.aimusic.studio;

import com.aimusic.studio.cloud.CloudDatabaseService;
import com.aimusic.studio.model.MidiNote;
import com.aimusic.studio.model.ProjectState;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.net.URI;
import java.util.List;
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
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
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
class CollabPhase9Tests {

    @LocalServerPort
    private int port;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private CloudDatabaseService cloudDb;

    private String registerUser(String prefix, String displayName) throws Exception {
        String email = prefix + "_" + UUID.randomUUID().toString().substring(0, 6) + "@phase9.test";
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
    void showcaseLikesTimestampCommentsAndDeletionGuards() throws Exception {
        String aliceToken = registerUser("p9a", "Alice Composer");
        String bobToken = registerUser("p9b", "Bob Listener");
        String eveToken = registerUser("p9e", "Eve Stranger");

        String pid = "proj_p9_social_" + UUID.randomUUID().toString().substring(0, 8);
        ProjectState state = ProjectState.createDefault(pid, "Neon Acoustic Demo");
        state.getSongStructure().setTotalBars(4);
        state.getTracks().get("lead").setNotes(List.of(new MidiNote(67, 0.0, 1.0, 95, 1.0)));

        mockMvc.perform(put("/api/projects/" + pid + "/sync")
                        .header("Authorization", "Bearer " + aliceToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(state)))
                .andExpect(status().isOk());

        MvcResult pubRes = mockMvc.perform(post("/api/projects/" + pid + "/publish")
                        .header("Authorization", "Bearer " + aliceToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"format\":\"wav\",\"artist\":\"Alice\"}"))
                .andExpect(status().isOk())
                .andReturn();
        String slug = objectMapper.readTree(pubRes.getResponse().getContentAsString()).get("share_slug").asText();

        // Toggle Like on & off
        mockMvc.perform(post("/api/share/" + slug + "/like").header("Authorization", "Bearer " + bobToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.liked").value(true))
                .andExpect(jsonPath("$.likes_count").value(1));
        mockMvc.perform(post("/api/share/" + slug + "/like").header("Authorization", "Bearer " + aliceToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.liked").value(true))
                .andExpect(jsonPath("$.likes_count").value(2));
        mockMvc.perform(post("/api/share/" + slug + "/like").header("Authorization", "Bearer " + bobToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.liked").value(false))
                .andExpect(jsonPath("$.likes_count").value(1));

        // Add timestamped comments out of chronological order -> GET returns sorted by timestamp_sec ASC
        MvcResult cLate = mockMvc.perform(post("/api/share/" + slug + "/comments")
                        .header("Authorization", "Bearer " + bobToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"timestamp_sec\":12.5,\"bar_number\":7,\"text\":\"Chorus drop nghe rat da!\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.author_name").value("Bob Listener"))
                .andReturn();
        String cLateId = objectMapper.readTree(cLate.getResponse().getContentAsString()).get("id").asText();

        mockMvc.perform(post("/api/share/" + slug + "/comments")
                        .header("Authorization", "Bearer " + aliceToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"timestamp_sec\":2.0,\"bar_number\":2,\"text\":\"Intro guitar bat nhip\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(get("/api/share/" + slug))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.likes_count").value(1))
                .andExpect(jsonPath("$.comments_count").value(2))
                .andExpect(jsonPath("$.comments", hasSize(2)))
                .andExpect(jsonPath("$.comments[0].timestamp_sec").value(2.0))
                .andExpect(jsonPath("$.comments[1].timestamp_sec").value(12.5));

        // Eve cannot delete Bob's comment (403), but Alice (release owner) or Bob (author) can
        mockMvc.perform(delete("/api/share/" + slug + "/comments/" + cLateId)
                        .header("Authorization", "Bearer " + eveToken))
                .andExpect(status().isForbidden());
        mockMvc.perform(delete("/api/share/" + slug + "/comments/" + cLateId)
                        .header("Authorization", "Bearer " + aliceToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.comments_count").value(1));

        // Deleting project cascades to release social data
        mockMvc.perform(delete("/api/projects/" + pid).header("Authorization", "Bearer " + aliceToken))
                .andExpect(status().isOk());
        assertEquals(0, cloudDb.listReleaseComments(slug).size());
        assertEquals(0, cloudDb.countReleaseLikes(slug));
    }

    @Test
    void realtimeWebSocketCollabRoomPresenceSyncAndBarComments() throws Exception {
        String aliceToken = registerUser("wsa", "Alice Owner");
        String bobToken = registerUser("wsb", "Bob Peer");
        String eveToken = registerUser("wse", "Eve Uninvited");

        String pid = "proj_p9_ws_" + UUID.randomUUID().toString().substring(0, 8);
        ProjectState state = ProjectState.createDefault(pid, "Live Jam Track");
        mockMvc.perform(put("/api/projects/" + pid + "/sync")
                        .header("Authorization", "Bearer " + aliceToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(state)))
                .andExpect(status().isOk());

        // Eve cannot open collab room on Alice's private project
        mockMvc.perform(post("/api/studio/" + pid + "/collab/session")
                        .header("Authorization", "Bearer " + eveToken))
                .andExpect(status().isForbidden());

        // Alice enables collab room & receives invite room_code
        MvcResult roomRes = mockMvc.perform(post("/api/studio/" + pid + "/collab/session")
                        .header("Authorization", "Bearer " + aliceToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(true))
                .andExpect(jsonPath("$.room_code").isNotEmpty())
                .andReturn();
        String roomCode = objectMapper.readTree(roomRes.getResponse().getContentAsString()).get("room_code").asText();

        // Bob reads project with ?collab=roomCode (allowed even though private!)
        mockMvc.perform(get("/api/projects/" + pid + "?collab=" + roomCode)
                        .header("Authorization", "Bearer " + bobToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("Live Jam Track"));

        BlockingQueue<JsonNode> aliceInbox = new LinkedBlockingQueue<>();
        BlockingQueue<JsonNode> bobInbox = new LinkedBlockingQueue<>();
        BlockingQueue<JsonNode> eveInbox = new LinkedBlockingQueue<>();

        jakarta.websocket.WebSocketContainer wsContainer = jakarta.websocket.ContainerProvider.getWebSocketContainer();
        wsContainer.setDefaultMaxTextMessageBufferSize(2 * 1024 * 1024);
        StandardWebSocketClient wsClient = new StandardWebSocketClient(wsContainer);
        WebSocketSession aliceWs = wsClient.execute(
                new CollectingHandler(aliceInbox),
                new WebSocketHttpHeaders(),
                URI.create("ws://127.0.0.1:" + port + "/ws/collab?projectId=" + pid + "&room=" + roomCode + "&token=" + aliceToken + "&clientId=c_alice")
        ).get(5, TimeUnit.SECONDS);

        WebSocketSession bobWs = wsClient.execute(
                new CollectingHandler(bobInbox),
                new WebSocketHttpHeaders(),
                URI.create("ws://127.0.0.1:" + port + "/ws/collab?projectId=" + pid + "&room=" + roomCode + "&token=" + bobToken + "&clientId=c_bob")
        ).get(5, TimeUnit.SECONDS);

        // Eve without valid room code must get rejected
        WebSocketSession eveWs = wsClient.execute(
                new CollectingHandler(eveInbox),
                new WebSocketHttpHeaders(),
                URI.create("ws://127.0.0.1:" + port + "/ws/collab?projectId=" + pid + "&token=" + eveToken + "&clientId=c_eve")
        ).get(5, TimeUnit.SECONDS);
        JsonNode eveErr = eveInbox.poll(3, TimeUnit.SECONDS);
        assertNotNull(eveErr);
        assertEquals("error", eveErr.get("type").asText());

        // Wait for Bob's initial snapshot with 2 peers
        JsonNode bobSnap = waitForMessageType(bobInbox, "room_snapshot", 5);
        assertNotNull(bobSnap);
        assertEquals(2, bobSnap.get("members").size());

        // Alice broadcasts a >16KB state_sync (beyond Tomcat's default 8KB limit) -> Bob receives updated title & notes over WebSocket
        state.setTitle("Live Jam Track (Synced!)");
        java.util.ArrayList<MidiNote> largeNotes = new java.util.ArrayList<>();
        for (int i = 0; i < 300; i++) {
            largeNotes.add(new MidiNote(60 + (i % 12), i * 0.25, 0.25, 92, 1.0));
        }
        state.getTracks().get("lead").setNotes(largeNotes);
        String syncPayload = objectMapper.writeValueAsString(Map.of(
                "type", "state_sync",
                "state", state
        ));
        assertTrue(syncPayload.length() > 16_000, "Expected >16KB payload to guard WebSocket buffer size");
        aliceWs.sendMessage(new TextMessage(syncPayload));
        JsonNode bobSynced = waitForMessageType(bobInbox, "state_sync", 5);
        assertNotNull(bobSynced);
        assertEquals("Live Jam Track (Synced!)", bobSynced.get("state").get("title").asText());
        assertEquals(300, bobSynced.get("state").get("tracks").get("lead").get("notes").size());
        assertTrue(aliceWs.isOpen());
        assertTrue(bobWs.isOpen());

        // Bob updates cursor bar -> Alice receives presence update with Bob at Bar 7
        bobWs.sendMessage(new TextMessage("{\"type\":\"cursor\",\"bar\":7,\"track_id\":\"bass\",\"active_tab\":\"mixer\"}"));
        JsonNode alicePresence = waitForCondition(aliceInbox,
                n -> "presence".equals(n.path("type").asText())
                        && n.path("members").toString().contains("\"bar\":7"),
                5);
        assertNotNull(alicePresence);

        // Bar comment created via REST broadcasts bar_comment_event to WebSocket room!
        MvcResult bcmtRes = mockMvc.perform(post("/api/studio/" + pid + "/comments?collab=" + roomCode)
                        .header("Authorization", "Bearer " + bobToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"bar_number\":7,\"track_id\":\"bass\",\"text\":\"Tang sub bass doan nay\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bar_number").value(7))
                .andReturn();
        String commentId = objectMapper.readTree(bcmtRes.getResponse().getContentAsString()).get("id").asText();

        JsonNode aliceBarNoteEvt = waitForMessageType(aliceInbox, "bar_comment_event", 5);
        assertNotNull(aliceBarNoteEvt);
        assertEquals("added", aliceBarNoteEvt.get("action").asText());

        // Resolve bar comment & verify list
        mockMvc.perform(patch("/api/studio/" + pid + "/comments/" + commentId + "?collab=" + roomCode)
                        .header("Authorization", "Bearer " + aliceToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"resolved\":true}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.resolved").value(true));

        // Close collab room & cleanup
        mockMvc.perform(delete("/api/studio/" + pid + "/collab/session")
                        .header("Authorization", "Bearer " + aliceToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(false));

        if (aliceWs.isOpen()) aliceWs.close(CloseStatus.NORMAL);
        if (bobWs.isOpen()) bobWs.close(CloseStatus.NORMAL);
        if (eveWs.isOpen()) eveWs.close(CloseStatus.NORMAL);

        mockMvc.perform(delete("/api/projects/" + pid).header("Authorization", "Bearer " + aliceToken))
                .andExpect(status().isOk());
        assertTrue(cloudDb.listStudioBarComments(pid).isEmpty());
    }

    private JsonNode waitForMessageType(BlockingQueue<JsonNode> q, String type, long seconds) throws InterruptedException {
        return waitForCondition(q, n -> type.equals(n.path("type").asText()), seconds);
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
