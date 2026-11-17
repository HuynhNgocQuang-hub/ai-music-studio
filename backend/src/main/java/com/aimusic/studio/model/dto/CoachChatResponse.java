package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.List;

public class CoachChatResponse {

    @JsonProperty("reply")
    private String reply;

    @JsonProperty("suggested_actions")
    private List<CoachSuggestedAction> suggestedActions = new ArrayList<>();

    @JsonProperty("provider")
    private String provider;

    public CoachChatResponse() {}

    public CoachChatResponse(String reply, List<CoachSuggestedAction> suggestedActions, String provider) {
        this.reply = reply;
        this.suggestedActions = suggestedActions != null ? suggestedActions : new ArrayList<>();
        this.provider = provider;
    }

    public String getReply() { return reply; }
    public void setReply(String reply) { this.reply = reply; }

    public List<CoachSuggestedAction> getSuggestedActions() { return suggestedActions; }
    public void setSuggestedActions(List<CoachSuggestedAction> suggestedActions) { this.suggestedActions = suggestedActions; }

    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }
}
