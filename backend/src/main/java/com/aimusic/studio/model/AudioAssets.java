package com.aimusic.studio.model;

import com.fasterxml.jackson.annotation.JsonProperty;

public class AudioAssets {

    @JsonProperty("raw_input_ref")
    private String rawInputRef;

    @JsonProperty("dry_denoised_ref")
    private String dryDenoisedRef;

    @JsonProperty("tuned_vocal_ref")
    private String tunedVocalRef;

    @JsonProperty("rendered_mix_ref")
    private String renderedMixRef;

    @JsonProperty("accompaniment_ref")
    private String accompanimentRef;

    @JsonProperty("preserve_mix_ref")
    private String preserveMixRef;

    @JsonProperty("enhance_mix_ref")
    private String enhanceMixRef;

    public AudioAssets() {}

    public String getRawInputRef() { return rawInputRef; }
    public void setRawInputRef(String rawInputRef) { this.rawInputRef = rawInputRef; }

    public String getDryDenoisedRef() { return dryDenoisedRef; }
    public void setDryDenoisedRef(String dryDenoisedRef) { this.dryDenoisedRef = dryDenoisedRef; }

    public String getTunedVocalRef() { return tunedVocalRef; }
    public void setTunedVocalRef(String tunedVocalRef) { this.tunedVocalRef = tunedVocalRef; }

    public String getRenderedMixRef() { return renderedMixRef; }
    public void setRenderedMixRef(String renderedMixRef) { this.renderedMixRef = renderedMixRef; }

    public String getAccompanimentRef() { return accompanimentRef; }
    public void setAccompanimentRef(String accompanimentRef) { this.accompanimentRef = accompanimentRef; }

    public String getPreserveMixRef() { return preserveMixRef; }
    public void setPreserveMixRef(String preserveMixRef) { this.preserveMixRef = preserveMixRef; }

    public String getEnhanceMixRef() { return enhanceMixRef; }
    public void setEnhanceMixRef(String enhanceMixRef) { this.enhanceMixRef = enhanceMixRef; }
}
