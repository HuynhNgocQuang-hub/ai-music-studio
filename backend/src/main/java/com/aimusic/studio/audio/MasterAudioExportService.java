package com.aimusic.studio.audio;

import com.aimusic.studio.config.AppProperties;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.store.ProjectStateStore;
import org.springframework.stereotype.Service;

import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Coordinates master audio rendering and encoding via Python Audio Worker with automatic
 * Java DSP fallback, eliminating duplicated export pipelines across controllers.
 */
@Service
public class MasterAudioExportService {

    public record ExportRequestParams(
            String format,
            String mode,
            boolean applyMastering,
            String bitrate,
            String title,
            String artist,
            String album,
            String genre,
            boolean fallbackToWavOnCodecError
    ) {}

    public record ExportResult(byte[] audioBytes, String resolvedFormat) {}

    private final AudioWorkerClient audioWorkerClient;
    private final JavaAudioFallbackService audioFallback;
    private final AppProperties properties;
    private final ProjectStateStore store;

    public MasterAudioExportService(
            AudioWorkerClient audioWorkerClient,
            JavaAudioFallbackService audioFallback,
            AppProperties properties,
            ProjectStateStore store
    ) {
        this.audioWorkerClient = audioWorkerClient;
        this.audioFallback = audioFallback;
        this.properties = properties;
        this.store = store;
    }

    public ExportResult renderMasterAudio(ProjectState project, ExportRequestParams params) {
        String normalizedFormat = (params.format() != null && !params.format().isBlank())
                ? params.format().trim().toLowerCase(Locale.ROOT)
                : "wav";
        int sampleRate = properties.getSampleRate();
        Map<String, byte[]> audioAssets = store.collectAudioAssets(project);

        Optional<byte[]> workerExport = audioWorkerClient.exportAudio(
                project,
                audioAssets,
                normalizedFormat,
                params.mode(),
                params.applyMastering(),
                sampleRate,
                params.bitrate(),
                params.title(),
                params.artist(),
                params.album(),
                params.genre()
        );
        if (workerExport.isPresent()) {
            return new ExportResult(workerExport.get(), normalizedFormat);
        }

        JavaAudioFallbackService.RenderedMix rendered = audioFallback.renderProjectMix(
                project,
                store,
                params.mode(),
                params.applyMastering(),
                sampleRate
        );

        return encodeFallbackMix(rendered, normalizedFormat, params);
    }

    private ExportResult encodeFallbackMix(
            JavaAudioFallbackService.RenderedMix rendered,
            String format,
            ExportRequestParams params
    ) {
        return switch (format) {
            case "mp3" -> {
                if (params.fallbackToWavOnCodecError()) {
                    try {
                        byte[] mp3 = audioFallback.exportMp3ViaFfmpeg(
                                rendered.stereo(), rendered.sampleRate(), params.bitrate(),
                                params.title(), params.artist(), params.genre());
                        yield new ExportResult(mp3, "mp3");
                    } catch (Exception ex) {
                        yield new ExportResult(
                                audioFallback.encodeWavStereo(rendered.stereo(), rendered.sampleRate()),
                                "wav"
                        );
                    }
                }
                yield new ExportResult(
                        audioFallback.exportMp3ViaFfmpeg(
                                rendered.stereo(), rendered.sampleRate(), params.bitrate(),
                                params.title(), params.artist(), params.genre()),
                        "mp3"
                );
            }
            case "flac" -> {
                if (params.fallbackToWavOnCodecError()) {
                    try {
                        byte[] flac = audioFallback.exportFlacViaFfmpeg(
                                rendered.stereo(), rendered.sampleRate(),
                                params.title(), params.artist(), params.genre());
                        yield new ExportResult(flac, "flac");
                    } catch (Exception ex) {
                        yield new ExportResult(
                                audioFallback.encodeWavStereo(rendered.stereo(), rendered.sampleRate()),
                                "wav"
                        );
                    }
                }
                yield new ExportResult(
                        audioFallback.exportFlacViaFfmpeg(
                                rendered.stereo(), rendered.sampleRate(),
                                params.title(), params.artist(), params.genre()),
                        "flac"
                );
            }
            case "stems" -> new ExportResult(
                    audioFallback.exportStemsZip(rendered.stems(), rendered.sampleRate()),
                    "stems"
            );
            default -> new ExportResult(
                    audioFallback.encodeWavStereo(rendered.stereo(), rendered.sampleRate()),
                    "wav"
            );
        };
    }
}
