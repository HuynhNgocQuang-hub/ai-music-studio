package com.aimusic.studio.agents;

import com.aimusic.studio.audio.JavaAudioFallbackService;

import java.util.Locale;

/**
 * Inspects attached audio bytes (WAV PCM or raw vocal stem) to supply real acoustic telemetry
 * (loudness, crest factor, brightness tilt, silence ratio, detected key/BPM) to {@link CoachLyricistAgent}.
 */
final class CoachAudioInspector {

    record AudioTelemetry(
            double durationSec,
            double peakDbfs,
            double rmsDbfs,
            double crestDb,
            double silenceRatio,
            double brightRatio,
            boolean clipping,
            boolean tooQuiet,
            String detectedKey,
            String detectedScale,
            double detectedBpm
    ) {
        String summary() {
            String musical = (detectedKey != null && detectedBpm > 0)
                    ? String.format(Locale.ROOT, ", estKey=%s %s, estBpm=%.0f", detectedKey, detectedScale, detectedBpm)
                    : "";
            return String.format(Locale.ROOT,
                    "dur=%.1fs, peak=%.1fdBFS, rms=%.1fdBFS, crest=%.1fdB, silence=%.0f%%, bright=%.2f, clip=%s, quiet=%s%s",
                    durationSec, peakDbfs, rmsDbfs, crestDb, silenceRatio * 100.0, brightRatio, clipping, tooQuiet, musical);
        }
    }

    private CoachAudioInspector() {}

    static AudioTelemetry inspect(byte[] audioBytes, JavaAudioFallbackService audioFallback) {
        if (audioBytes == null || audioBytes.length < 44 || audioFallback == null) {
            return null;
        }
        try {
            JavaAudioFallbackService.DecodedWav wav = audioFallback.decodeWavBytes(audioBytes);
            float[] mono = wav.mono();
            if (mono.length == 0) return null;

            double peak = 1e-6;
            double sumSq = 0.0;
            double diffSq = 0.0;
            int silentSamples = 0;
            float prev = mono[0];
            for (int i = 0; i < mono.length; i++) {
                float s = mono[i];
                double a = Math.abs(s);
                if (a > peak) peak = a;
                if (a < 0.008) silentSamples++;
                sumSq += s * s;
                if (i > 0) {
                    double d = s - prev;
                    diffSq += d * d;
                    prev = s;
                }
            }

            double rms = Math.sqrt(sumSq / mono.length);
            double peakDb = 20.0 * Math.log10(Math.max(peak, 1e-6));
            double rmsDb = 20.0 * Math.log10(Math.max(rms, 1e-6));
            double crestDb = Math.max(0.0, peakDb - rmsDb);
            double silenceRatio = (double) silentSamples / mono.length;
            double brightRatio = sumSq > 1e-9 ? Math.sqrt(diffSq / Math.max(1.0, sumSq)) : 0.0;
            double dur = (double) mono.length / Math.max(8000, wav.sampleRate());

            String detKey = null;
            String detScale = null;
            double detBpm = 0.0;
            if (dur >= 1.2) {
                try {
                    JavaAudioFallbackService.AnalyzeResult analysis = audioFallback.analyzeAudio(audioBytes, null, null, null);
                    detKey = analysis.detectedKey();
                    detScale = analysis.detectedScale();
                    detBpm = analysis.bpm();
                } catch (Exception ignored) {
                    // Best-effort pitch/BPM estimation
                }
            }

            return new AudioTelemetry(
                    dur, peakDb, rmsDb, crestDb, silenceRatio, brightRatio,
                    peakDb > -1.0, rmsDb < -34.0, detKey, detScale, detBpm
            );
        } catch (Exception ignored) {
            return null;
        }
    }
}
