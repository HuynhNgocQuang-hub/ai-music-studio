package com.aimusic.studio.controller;

import com.aimusic.studio.audio.AudioValidationException;
import com.aimusic.studio.audio.AudioWorkerClient;
import com.aimusic.studio.audio.JavaAudioFallbackService;
import com.aimusic.studio.config.AppProperties;
import com.aimusic.studio.model.AudioClip;
import com.aimusic.studio.model.AutotuneSettings;
import com.aimusic.studio.model.MidiNote;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.TrackState;
import com.aimusic.studio.model.dto.AnalyzeRequest;
import com.aimusic.studio.model.dto.AnalyzeResponse;
import com.aimusic.studio.model.dto.AudioUploadResponse;
import com.aimusic.studio.model.dto.AutotuneRequest;
import com.aimusic.studio.model.dto.AutotuneResponse;
import com.aimusic.studio.model.dto.ClipUploadResponse;
import com.aimusic.studio.model.dto.DenoiseRequest;
import com.aimusic.studio.model.dto.DenoiseResponse;
import com.aimusic.studio.store.ProjectStateStore;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

@RestController
@RequestMapping("/api/audio")
public class AudioController {

    private final AppProperties properties;
    private final ProjectStateStore store;
    private final AudioWorkerClient audioWorkerClient;
    private final JavaAudioFallbackService audioFallback;
    private final ObjectMapper objectMapper;

    public AudioController(
            AppProperties properties,
            ProjectStateStore store,
            AudioWorkerClient audioWorkerClient,
            JavaAudioFallbackService audioFallback,
            ObjectMapper objectMapper
    ) {
        this.properties = properties;
        this.store = store;
        this.audioWorkerClient = audioWorkerClient;
        this.audioFallback = audioFallback;
        this.objectMapper = objectMapper;
    }

    @PostMapping(value = "/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public AudioUploadResponse uploadAudio(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "project_id", required = false) String projectId,
            @RequestParam(value = "title", required = false) String title,
            @RequestParam(value = "mode", defaultValue = "hum") String mode
    ) throws IOException {
        byte[] rawBytes = file.getBytes();
        String filename = (file.getOriginalFilename() != null && !file.getOriginalFilename().isBlank())
                ? file.getOriginalFilename() : "upload.wav";
        double maxDur = "vocal".equalsIgnoreCase(mode)
                ? properties.getMaxVocalDurationSec()
                : properties.getMaxHumDurationSec();

        String ext = "";
        int dot = filename.lastIndexOf('.');
        if (dot >= 0 && dot < filename.length() - 1) {
            ext = filename.substring(dot + 1).toLowerCase(Locale.ROOT);
        }
        if (!AppProperties.ALLOWED_AUDIO_EXTENSIONS.contains(ext)) {
            throw new AudioValidationException(
                    "Unsupported audio format '." + ext + "'. Allowed: .wav, .mp3, .m4a, .ogg, .flac",
                    HttpStatus.BAD_REQUEST);
        }
        if (rawBytes.length == 0) {
            throw new AudioValidationException("Uploaded audio file is empty.", HttpStatus.BAD_REQUEST);
        }
        if (rawBytes.length > properties.getMaxUploadBytes()) {
            throw new AudioValidationException(
                    String.format(Locale.ROOT, "File size (%.1f MB) exceeds maximum %d MB.",
                            rawBytes.length / (1024.0 * 1024.0), properties.getMaxUploadMb()),
                    HttpStatus.PAYLOAD_TOO_LARGE);
        }

        byte[] bytesToValidate = rawBytes;
        if (!"wav".equals(ext)) {
            Optional<Map<String, Object>> workerDecoded = audioWorkerClient.denoise(rawBytes, filename, false, false);
            if (workerDecoded.isPresent() && workerDecoded.get().get("wav_base64") instanceof String b64) {
                bytesToValidate = Base64.getDecoder().decode(b64);
                filename = filename.substring(0, dot) + ".wav";
            }
        }

        JavaAudioFallbackService.ValidatedAudio meta = audioFallback.validateAndDecodeAudio(
                bytesToValidate,
                filename,
                properties.getMaxUploadBytes(),
                properties.getMinDurationSec(),
                maxDur,
                properties.getSampleRate()
        );

        String resolvedTitle = (title == null || title.isBlank())
                ? (filename.lastIndexOf('.') > 0 ? filename.substring(0, filename.lastIndexOf('.')) : filename)
                : title;

        ProjectState project = (projectId != null && !projectId.isBlank())
                ? store.getProject(projectId).orElseGet(() -> ProjectState.createDefault(projectId, resolvedTitle))
                : ProjectState.createDefault(null, resolvedTitle);

        String rawRef = "mem://raw/" + project.getProjectId() + ".wav";
        store.saveAudioBytes(rawRef, meta.wavBytes());
        project.getAudioAssets().setRawInputRef(rawRef);
        project.getAnalysis().setDurationSec(meta.durationSec());

        TrackState vocalTrack = project.getTracks().get("vocal");
        if (vocalTrack != null && (vocalTrack.getClips() == null || vocalTrack.getClips().isEmpty())) {
            vocalTrack.getClips().add(new AudioClip("clip_vocal_1", "raw_input_ref", 1.0, 0.0));
        }
        store.saveProject(project);

        return new AudioUploadResponse(
                project.getProjectId(),
                rawRef,
                file.getOriginalFilename() != null ? file.getOriginalFilename() : filename,
                meta.durationSec(),
                meta.sampleRate(),
                meta.channels(),
                rawBytes.length,
                ext,
                meta.warnings()
        );
    }

    @PostMapping(value = "/clip-upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ClipUploadResponse uploadTrackClip(
            @RequestParam("project_id") String projectId,
            @RequestParam(value = "track_id", defaultValue = "texture") String trackId,
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "start_bar", defaultValue = "1.0") double startBar
    ) throws IOException {
        if (projectId == null || projectId.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "project_id is required");
        }
        String normTrackId = (trackId == null || trackId.isBlank())
                ? "texture" : trackId.trim().toLowerCase(Locale.ROOT);

        byte[] rawBytes = file.getBytes();
        String filename = (file.getOriginalFilename() != null && !file.getOriginalFilename().isBlank())
                ? file.getOriginalFilename() : "clip.wav";
        String ext = "";
        int dot = filename.lastIndexOf('.');
        if (dot >= 0 && dot < filename.length() - 1) {
            ext = filename.substring(dot + 1).toLowerCase(Locale.ROOT);
        }
        if (!AppProperties.ALLOWED_AUDIO_EXTENSIONS.contains(ext)) {
            throw new AudioValidationException(
                    "Unsupported audio format '." + ext + "'. Allowed: .wav, .mp3, .m4a, .ogg, .flac",
                    HttpStatus.BAD_REQUEST);
        }
        if (rawBytes.length == 0) {
            throw new AudioValidationException("Uploaded clip file is empty.", HttpStatus.BAD_REQUEST);
        }
        if (rawBytes.length > properties.getMaxUploadBytes()) {
            throw new AudioValidationException(
                    String.format(Locale.ROOT, "File size (%.1f MB) exceeds maximum %d MB.",
                            rawBytes.length / (1024.0 * 1024.0), properties.getMaxUploadMb()),
                    HttpStatus.PAYLOAD_TOO_LARGE);
        }

        byte[] bytesToValidate = rawBytes;
        if (!"wav".equals(ext)) {
            Optional<Map<String, Object>> workerDecoded = audioWorkerClient.denoise(rawBytes, filename, false, false);
            if (workerDecoded.isPresent() && workerDecoded.get().get("wav_base64") instanceof String b64) {
                bytesToValidate = Base64.getDecoder().decode(b64);
                filename = filename.substring(0, dot) + ".wav";
            }
        }

        JavaAudioFallbackService.ValidatedAudio meta = audioFallback.validateAndDecodeAudio(
                bytesToValidate,
                filename,
                properties.getMaxUploadBytes(),
                0.1,
                properties.getMaxVocalDurationSec(),
                properties.getSampleRate()
        );

        Optional<ProjectState> existingOpt = store.getProject(projectId);
        ProjectState project = existingOpt.orElseGet(() -> ProjectState.createDefault(projectId, "Untitled Project"));
        existingOpt.ifPresent(prev -> store.pushUndo(projectId, prev));

        TrackState track = project.getTracks().get(normTrackId);
        if (track == null) {
            track = TrackState.audioTrack(0.75, 0.0);
            project.getTracks().put(normTrackId, track);
        } else if (!"audio".equalsIgnoreCase(track.getType())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Track '" + normTrackId + "' is not an audio track.");
        }

        String clipId = "clip_" + normTrackId + "_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        String audioRef = "mem://clips/" + projectId + "/" + clipId + ".wav";
        store.saveAudioBytes(audioRef, meta.wavBytes());

        AudioClip clip = new AudioClip(clipId, audioRef, Math.max(1.0, startBar), 0.0);
        clip.setTrimEndSec(meta.durationSec());
        clip.setFadeInMs(15.0);
        clip.setFadeOutMs(15.0);
        clip.setOffsetMs(0.0);
        track.getClips().add(clip);

        project.setVersion(project.getVersion() + 1);
        ProjectState saved = store.saveProject(project);

        return new ClipUploadResponse(saved, clip, audioRef, normTrackId, meta.durationSec(), meta.warnings());
    }

    @PostMapping("/denoise")
    public DenoiseResponse denoiseAudio(@RequestBody DenoiseRequest req) {
        ProjectState project = store.getProject(req.getProjectId())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Project '" + req.getProjectId() + "' not found."));

        String rawRef = project.getAudioAssets().getRawInputRef();
        if (rawRef == null || rawRef.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Project has no uploaded raw audio.");
        }
        byte[] rawBytes = store.getAudioBytes(rawRef)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Raw audio asset expired or missing."));

        byte[] dryBytes;
        double trimmedStart;
        double trimmedEnd;
        double durationSec;
        double snrDb;
        List<String> warnings;

        Optional<Map<String, Object>> workerResp = audioWorkerClient.denoise(
                rawBytes, "raw.wav", req.isEnableDenoise(), req.isAutoTrim());
        if (workerResp.isPresent() && workerResp.get().get("wav_base64") instanceof String b64) {
            Map<String, Object> m = workerResp.get();
            dryBytes = Base64.getDecoder().decode(b64);
            trimmedStart = toDouble(m.get("trimmed_start_sec"), 0.0);
            trimmedEnd = toDouble(m.get("trimmed_end_sec"), 0.0);
            durationSec = toDouble(m.get("duration_sec"), 0.0);
            snrDb = toDouble(m.get("snr_db_estimate"), 20.0);
            warnings = toStringList(m.get("warnings"));
        } else {
            JavaAudioFallbackService.DenoiseResult res = audioFallback.denoiseAndTrim(
                    rawBytes, req.isEnableDenoise(), req.isAutoTrim());
            dryBytes = res.wavBytes();
            trimmedStart = res.trimmedStartSec();
            trimmedEnd = res.trimmedEndSec();
            durationSec = res.durationSec();
            snrDb = res.snrDbEstimate();
            warnings = res.warnings();
        }

        String dryRef = "mem://processed/" + project.getProjectId() + "_dry.wav";
        store.saveAudioBytes(dryRef, dryBytes);

        project.getAudioAssets().setDryDenoisedRef(dryRef);
        project.getAnalysis().setDurationSec(durationSec);
        TrackState vocalTrack = project.getTracks().get("vocal");
        if (vocalTrack != null && vocalTrack.getClips() != null && !vocalTrack.getClips().isEmpty()) {
            vocalTrack.getClips().get(0).setSource("dry_denoised_ref");
        }
        store.saveProject(project);

        return new DenoiseResponse(
                project.getProjectId(),
                rawRef,
                dryRef,
                trimmedStart,
                trimmedEnd,
                durationSec,
                snrDb,
                warnings
        );
    }

    @PostMapping("/analyze")
    public AnalyzeResponse analyzeProjectAudio(@RequestBody AnalyzeRequest req) {
        ProjectState project = store.getProject(req.getProjectId())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Project '" + req.getProjectId() + "' not found."));

        String ref = req.getSourceRef();
        if (ref == null || ref.isBlank()) ref = project.getAudioAssets().getDryDenoisedRef();
        if (ref == null || ref.isBlank()) ref = project.getAudioAssets().getRawInputRef();
        if (ref == null || ref.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "No audio asset available for analysis.");
        }

        byte[] wavBytes = store.getAudioBytes(ref)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Audio asset expired or missing."));

        Double bpmOv = req.getBpmOverride() != null ? req.getBpmOverride()
                : (project.getAnalysis().isBpmLocked() ? project.getAnalysis().getBpm() : null);
        String keyOv = (req.getKeyOverride() != null && !req.getKeyOverride().isBlank()) ? req.getKeyOverride()
                : (project.getAnalysis().isKeyLocked() ? project.getAnalysis().getDetectedKey() : null);
        String scaleOv = (req.getScaleOverride() != null && !req.getScaleOverride().isBlank()) ? req.getScaleOverride()
                : (project.getAnalysis().isKeyLocked() ? project.getAnalysis().getDetectedScale() : null);

        double bpm;
        String timeSig;
        String detKey;
        String detScale;
        double keyConf;
        boolean lowConf;
        int bars;
        double durSec;
        List<MidiNote> rawMidi;

        Optional<Map<String, Object>> workerResp = audioWorkerClient.analyze(wavBytes, bpmOv, keyOv, scaleOv);
        if (workerResp.isPresent() && workerResp.get().containsKey("bpm")) {
            Map<String, Object> m = workerResp.get();
            bpm = toDouble(m.get("bpm"), 120.0);
            timeSig = m.get("time_signature") != null ? m.get("time_signature").toString() : "4/4";
            detKey = m.get("detected_key") != null ? m.get("detected_key").toString() : "C";
            detScale = m.get("detected_scale") != null ? m.get("detected_scale").toString() : "major";
            keyConf = toDouble(m.get("key_confidence"), 0.8);
            lowConf = Boolean.TRUE.equals(m.get("low_confidence_warning")) || keyConf < 0.6;
            bars = (int) toDouble(m.get("bars"), 4.0);
            durSec = toDouble(m.get("duration_sec"), 0.0);
            rawMidi = objectMapper.convertValue(
                    m.getOrDefault("raw_melody_midi", List.of()), new TypeReference<>() {});
        } else {
            JavaAudioFallbackService.AnalyzeResult res = audioFallback.analyzeAudio(wavBytes, bpmOv, keyOv, scaleOv);
            bpm = res.bpm();
            timeSig = res.timeSignature();
            detKey = res.detectedKey();
            detScale = res.detectedScale();
            keyConf = res.keyConfidence();
            lowConf = res.lowConfidenceWarning();
            bars = res.bars();
            durSec = res.durationSec();
            rawMidi = res.rawMelodyMidi();
        }

        project.getAnalysis().setBpm(bpm);
        project.getAnalysis().setTimeSignature(timeSig);
        project.getAnalysis().setDetectedKey(detKey);
        project.getAnalysis().setDetectedScale(detScale);
        project.getAnalysis().setKeyConfidence(keyConf);
        project.getAnalysis().setLowConfidenceWarning(lowConf);
        project.getAnalysis().setBars(bars);
        project.getAnalysis().setDurationSec(durSec);
        project.getAnalysis().setRawMelodyMidi(rawMidi);
        if (req.getBpmOverride() != null) {
            project.getAnalysis().setBpmLocked(true);
        }
        if (req.getKeyOverride() != null || req.getScaleOverride() != null) {
            project.getAnalysis().setKeyLocked(true);
        }

        project.getSongStructure().setTotalBars(Math.max(project.getSongStructure().getTotalBars(), bars));
        if (project.getAutotuneSettings().isAutoFollowProjectKey()) {
            project.getAutotuneSettings().setKey(detKey);
            if (isSupportedScale(detScale)) {
                project.getAutotuneSettings().setScale(normalizeScaleName(detScale));
            }
        }
        store.saveProject(project);

        return new AnalyzeResponse(
                project.getProjectId(), bpm, timeSig, detKey, detScale, keyConf, lowConf, bars, durSec, rawMidi);
    }

    @PostMapping("/autotune")
    public AutotuneResponse autotuneAudio(@RequestBody AutotuneRequest req) {
        ProjectState project = store.getProject(req.getProjectId())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Project '" + req.getProjectId() + "' not found."));

        String srcRef = project.getAudioAssets().getDryDenoisedRef();
        if (srcRef == null || srcRef.isBlank()) srcRef = project.getAudioAssets().getRawInputRef();
        if (srcRef == null || srcRef.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Project has no vocal audio to tune.");
        }

        byte[] srcBytes = store.getAudioBytes(srcRef)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Source audio asset expired or missing."));

        boolean hasProSettings = req.getAutotuneSettings() != null;
        AutotuneSettings rawSettings;
        if (hasProSettings) {
            rawSettings = req.getAutotuneSettings();
        } else if (req.getPreset() != null) {
            rawSettings = audioFallback.applyPreset(
                    req.getPreset(), project.getAnalysis().getDetectedKey(), project.getAnalysis().getDetectedScale());
        } else {
            rawSettings = new AutotuneSettings();
        }

        AutotuneSettings effective = audioFallback.resolveAutotuneSettings(rawSettings);
        if (effective.isAutoFollowProjectKey()) {
            if (!hasProSettings || !effective.isKeyProvided()) {
                effective.setKey(project.getAnalysis().getDetectedKey());
            }
            if (!hasProSettings || !effective.isScaleProvided()) {
                String detScale = project.getAnalysis().getDetectedScale();
                if (isSupportedScale(detScale)) {
                    effective.setScale(normalizeScaleName(detScale));
                }
            }
        }
        if (isSupportedScale(effective.getScale())) {
            effective.setScale(normalizeScaleName(effective.getScale()));
        }

        byte[] tunedBytes;
        Optional<Map<String, Object>> workerResp = audioWorkerClient.autotune(srcBytes, effective);
        if (workerResp.isPresent() && workerResp.get().get("wav_base64") instanceof String b64) {
            tunedBytes = Base64.getDecoder().decode(b64);
        } else {
            tunedBytes = audioFallback.applyAutotune(srcBytes, effective);
        }

        String tunedRef = "mem://processed/" + project.getProjectId() + "_tuned.wav";
        store.saveAudioBytes(tunedRef, tunedBytes);

        project.setAutotuneSettings(effective);
        project.getAudioAssets().setTunedVocalRef(tunedRef);
        TrackState vocalTrack = project.getTracks().get("vocal");
        if (vocalTrack != null && vocalTrack.getClips() != null && !vocalTrack.getClips().isEmpty()) {
            vocalTrack.getClips().get(0).setSource(effective.isEnabled() ? "tuned_vocal_ref" : "dry_denoised_ref");
        }
        store.saveProject(project);

        return new AutotuneResponse(project.getProjectId(), tunedRef, effective, project.getAnalysis().getDurationSec());
    }

    @GetMapping("/asset")
    public ResponseEntity<byte[]> getAudioAsset(@RequestParam("ref") String ref) {
        byte[] data = store.getAudioBytes(ref)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Audio asset '" + ref + "' not found."));
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("audio/wav"))
                .body(data);
    }

    @GetMapping("/preview/{projectId}")
    public ResponseEntity<byte[]> getQuickPreviewPath(
            @PathVariable("projectId") String projectId,
            @RequestParam(value = "mode", defaultValue = "ai_mix") String mode
    ) {
        return renderPreviewWav(projectId, mode);
    }

    @GetMapping("/preview")
    public ResponseEntity<byte[]> getQuickPreviewQuery(
            @RequestParam("project_id") String projectId,
            @RequestParam(value = "mode", defaultValue = "ai_mix") String mode
    ) {
        return renderPreviewWav(projectId, mode);
    }

    private ResponseEntity<byte[]> renderPreviewWav(String projectId, String mode) {
        ProjectState project = store.getProject(projectId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Project '" + projectId + "' not found."));

        Map<String, TrackState> tracks = project.getTracks();
        if (tracks != null && !tracks.isEmpty() && tracks.values().stream().allMatch(TrackState::isMute)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "All tracks are muted; unmute at least one track before previewing.");
        }

        String normMode = audioFallback.normalizePreviewMode(mode);
        if (audioWorkerClient.isHealthy()) {
            ProjectState previewProject = audioFallback.preparePreviewProject(project, normMode);
            String workerMode = audioFallback.toWorkerRenderMode(normMode);
            Map<String, byte[]> assets = store.collectAudioAssets(previewProject);
            Optional<byte[]> workerWav = audioWorkerClient.renderProjectMix(
                    previewProject, assets, workerMode, true, properties.getSampleRate());
            if (workerWav.isPresent()) {
                return ResponseEntity.ok()
                        .header(HttpHeaders.CONTENT_TYPE, "audio/wav")
                        .body(workerWav.get());
            }
        }

        JavaAudioFallbackService.RenderedMix mix = audioFallback.renderProjectMix(
                project, store, normMode, true, properties.getSampleRate());
        byte[] wav = audioFallback.encodeWavStereo(mix.stereo(), mix.sampleRate());
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, "audio/wav")
                .body(wav);
    }

    private static final Set<String> SUPPORTED_SCALES = Set.of(
            "major", "minor", "pentatonic_major", "pentatonic_minor", "chromatic"
    );

    private static String normalizeScaleName(String scale) {
        if (scale == null) return "";
        return scale.trim().toLowerCase(Locale.ROOT).replace(' ', '_');
    }

    private static boolean isSupportedScale(String scale) {
        return SUPPORTED_SCALES.contains(normalizeScaleName(scale));
    }

    private double toDouble(Object v, double fallback) {
        if (v instanceof Number n) return n.doubleValue();
        if (v != null) {
            try { return Double.parseDouble(v.toString()); } catch (Exception ignored) {}
        }
        return fallback;
    }

    private List<String> toStringList(Object v) {
        if (v instanceof List<?> list) {
            return list.stream().map(String::valueOf).toList();
        }
        return List.of();
    }
}
