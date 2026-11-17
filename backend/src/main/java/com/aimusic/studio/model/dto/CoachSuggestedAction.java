package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

public class CoachSuggestedAction {

    @JsonProperty("id")
    private String id;

    @JsonProperty("label")
    private String label;

    @JsonProperty("action")
    private String action;

    @JsonProperty("action_type")
    private String actionType;

    @JsonProperty("payload")
    private Map<String, Object> payload;

    public CoachSuggestedAction() {}

    public CoachSuggestedAction(String id, String label, String action, Map<String, Object> payload) {
        this.id = id;
        this.label = label;
        this.action = action;
        this.actionType = action;
        this.payload = payload;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getLabel() { return label; }
    public void setLabel(String label) { this.label = label; }

    public String getAction() { return action; }
    public void setAction(String action) { this.action = action; }

    public String getActionType() { return actionType; }
    public void setActionType(String actionType) { this.actionType = actionType; }

    public Map<String, Object> getPayload() { return payload; }
    public void setPayload(Map<String, Object> payload) { this.payload = payload; }
}
