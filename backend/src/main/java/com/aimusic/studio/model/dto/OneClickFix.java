package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public class OneClickFix {

    @JsonProperty("id")
    private String id;

    @JsonProperty("label")
    private String label;

    @JsonProperty("action_type")
    private String actionType;

    @JsonProperty("value")
    private Object value;

    public OneClickFix() {}

    public OneClickFix(String id, String label, String actionType, Object value) {
        this.id = id;
        this.label = label;
        this.actionType = actionType;
        this.value = value;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getLabel() { return label; }
    public void setLabel(String label) { this.label = label; }

    public String getActionType() { return actionType; }
    public void setActionType(String actionType) { this.actionType = actionType; }

    public Object getValue() { return value; }
    public void setValue(Object value) { this.value = value; }
}
