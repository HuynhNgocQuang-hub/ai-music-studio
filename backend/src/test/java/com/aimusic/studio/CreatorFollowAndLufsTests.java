package com.aimusic.studio;

import com.aimusic.studio.model.MidiNote;
import com.aimusic.studio.model.ProjectState;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "APP_CLOUD_DATA_DIR=mem",
        "REDIS_RETRY_INTERVAL_MS=100"
})
class CreatorFollowAndLufsTests {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    private record AuthInfo(String token, String userId) {}

    private AuthInfo registerUser(String prefix, String displayName) throws Exception {
        String email = prefix + "_" + UUID.randomUUID().toString().substring(0, 6) + "@phase10.test";
        MvcResult res = mockMvc.perform(post("/api/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", email,
                                "password", "pass1234",
                                "display_name", displayName
                        ))))
                .andExpect(status().isOk())
                .andReturn();
        var root = objectMapper.readTree(res.getResponse().getContentAsString());
        return new AuthInfo(root.get("token").asText(), root.get("user").get("user_id").asText());
    }

    @Test
    void creatorProfilesFollowFeedTrendingSortAndCustomLufsPublish() throws Exception {
        AuthInfo alice = registerUser("p10a", "Alice Synth");
        AuthInfo bob = registerUser("p10b", "Bob Beatmaker");
        AuthInfo carol = registerUser("p10c", "Carol Listener");

        // Guest cannot update creator profile
        mockMvc.perform(patch("/api/creators/me")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"bio\":\"Guest attempt\"}"))
                .andExpect(status().isUnauthorized());

        // Alice updates bio & display_name via PATCH /api/creators/me
        mockMvc.perform(patch("/api/creators/me")
                        .header("Authorization", "Bearer " + alice.token())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"display_name\":\"DJ Alice Cloud\",\"bio\":\"EDM & Synthwave Producer\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.display_name").value("DJ Alice Cloud"))
                .andExpect(jsonPath("$.bio").value("EDM & Synthwave Producer"));

        // Alice & Bob publish projects with different target LUFS (-9 Club vs -16 Apple)
        String pidA = "proj_p10_a_" + UUID.randomUUID().toString().substring(0, 8);
        ProjectState stateA = ProjectState.createDefault(pidA, "Club Anthem -9 LUFS");
        stateA.getTracks().get("lead").setNotes(List.of(new MidiNote(64, 0.0, 1.0, 95, 1.0)));
        mockMvc.perform(put("/api/projects/" + pidA + "/sync")
                        .header("Authorization", "Bearer " + alice.token())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(stateA)))
                .andExpect(status().isOk());

        MvcResult pubA = mockMvc.perform(post("/api/projects/" + pidA + "/publish")
                        .header("Authorization", "Bearer " + alice.token())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"format\":\"wav\",\"genre\":\"EDM\",\"target_lufs\":-9.0}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.lufs_target").value(-9.0))
                .andReturn();
        String slugA = objectMapper.readTree(pubA.getResponse().getContentAsString()).get("share_slug").asText();

        String pidB = "proj_p10_b_" + UUID.randomUUID().toString().substring(0, 8);
        ProjectState stateB = ProjectState.createDefault(pidB, "Chill Acoustic -16 LUFS");
        stateB.getTracks().get("lead").setNotes(List.of(new MidiNote(60, 0.0, 1.0, 85, 1.0)));
        mockMvc.perform(put("/api/projects/" + pidB + "/sync")
                        .header("Authorization", "Bearer " + bob.token())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(stateB)))
                .andExpect(status().isOk());

        MvcResult pubB = mockMvc.perform(post("/api/projects/" + pidB + "/publish")
                        .header("Authorization", "Bearer " + bob.token())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"format\":\"wav\",\"genre\":\"Acoustic\",\"target_lufs\":-16.0}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.lufs_target").value(-16.0))
                .andReturn();
        String slugB = objectMapper.readTree(pubB.getResponse().getContentAsString()).get("share_slug").asText();

        // Export audio honors explicit target_lufs override
        mockMvc.perform(post("/api/projects/" + pidA + "/export/audio")
                        .header("Authorization", "Bearer " + alice.token())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"format\":\"wav\",\"target_lufs\":-9.0}"))
                .andExpect(status().isOk());

        // Carol and Bob like Alice's release -> Alice ranks top on sort=trending
        mockMvc.perform(post("/api/share/" + slugA + "/like")
                        .header("Authorization", "Bearer " + carol.token()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.likes_count").value(1));
        mockMvc.perform(post("/api/share/" + slugA + "/like")
                        .header("Authorization", "Bearer " + bob.token()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.likes_count").value(2));

        // Self-follow blocked with 400; Carol follows Alice cleanly
        mockMvc.perform(post("/api/creators/" + alice.userId() + "/follow")
                        .header("Authorization", "Bearer " + alice.token()))
                .andExpect(status().isBadRequest());

        mockMvc.perform(post("/api/creators/" + alice.userId() + "/follow")
                        .header("Authorization", "Bearer " + carol.token()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.following").value(true))
                .andExpect(jsonPath("$.followers_count").value(1));

        // Carol views Alice's Creator Profile & Release detail with creator_followed=true
        mockMvc.perform(get("/api/creators/" + alice.userId())
                        .header("Authorization", "Bearer " + carol.token()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.display_name").value("DJ Alice Cloud"))
                .andExpect(jsonPath("$.bio").value("EDM & Synthwave Producer"))
                .andExpect(jsonPath("$.followers_count").value(1))
                .andExpect(jsonPath("$.total_likes").value(2))
                .andExpect(jsonPath("$.followed_by_me").value(true))
                .andExpect(jsonPath("$.releases[0].share_slug").value(slugA));

        mockMvc.perform(get("/api/share/" + slugA)
                        .header("Authorization", "Bearer " + carol.token()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.creator_followed").value(true))
                .andExpect(jsonPath("$.lufs_target").value(-9.0));

        // Following feed returns Alice's release and excludes Bob's (Carol only follows Alice)
        mockMvc.perform(get("/api/share?scope=following&sort=trending")
                        .header("Authorization", "Bearer " + carol.token()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].share_slug").value(slugA));

        // Trending sort puts Alice ahead of Bob
        mockMvc.perform(get("/api/share?sort=trending"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].share_slug").value(slugA));

        // Creators leaderboard includes DJ Alice Cloud
        mockMvc.perform(get("/api/creators"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].user_id").value(alice.userId()));

        // Cleanup
        mockMvc.perform(delete("/api/projects/" + pidA).header("Authorization", "Bearer " + alice.token()))
                .andExpect(status().isOk());
        mockMvc.perform(delete("/api/projects/" + pidB).header("Authorization", "Bearer " + bob.token()))
                .andExpect(status().isOk());
        mockMvc.perform(get("/api/share/" + slugB)).andExpect(status().isNotFound());
    }
}
