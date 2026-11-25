package com.aimusic.studio.audio;

import com.aimusic.studio.agents.MusicTheory;
import com.aimusic.studio.config.AppProperties;
import com.aimusic.studio.model.AudioClip;
import com.aimusic.studio.model.AutotuneSettings;
import com.aimusic.studio.model.MidiNote;
import com.aimusic.studio.model.ProjectState;
import com.aimusic.studio.model.TrackState;
import com.aimusic.studio.model.dto.OneClickFix;
import com.aimusic.studio.model.dto.OverdubFitCheckResponse;
import com.aimusic.studio.model.dto.PitchIssue;
import com.aimusic.studio.store.ProjectStateStore;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import javax.sound.midi.MetaMessage;
import javax.sound.midi.MidiEvent;
import javax.sound.midi.MidiSystem;
import javax.sound.midi.Sequence;
import javax.sound.midi.ShortMessage;
import javax.sound.midi.Track;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

@Service
public class JavaAudioFallbackService {

    public record DecodedWav(float[] mono, int sampleRate, int channels) {}
    public record ValidatedAudio(byte[] wavBytes, String filename, String format, long sizeBytes,
                                 double durationSec, int sampleRate, int channels, List<String> warnings) {}
    public record DenoiseResult(byte[] wavBytes, double trimmedStartSec, double trimmedEndSec,
                                double durationSec, double snrDbEstimate, List<String> warnings) {}
    public record AnalyzeResult(double bpm, String timeSignature, String detectedKey, String detectedScale,
                                double keyConfidence, boolean lowConfidenceWarning, int bars,
                                double durationSec, List<MidiNote> rawMelodyMidi) {}
    public record RenderedMix(float[][] stereo, Map<String, float[][]> stems, int sampleRate) {}
    public record AutoTrimAnalysis(double trimStartSec, double trimEndSec, double offsetMs,
                                   double durationSec, double leadingSilenceSec, double trailingSilenceSec,
                                   String summary) {}
    public record AutoMixResult(List<String> mixNotes, String summary) {}

    private static final String[] NOTE_NAMES = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
    private static final double[] MAJOR_PROFILE = {6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88};
    private static final double[] MINOR_PROFILE = {6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17};

    private final ObjectMapper objectMapper;

    public JavaAudioFallbackService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    // --- WAV Encoding & Decoding ---

    public DecodedWav decodeWavBytes(byte[] wavBytes) {
        if (wavBytes == null || wavBytes.length < 44) {
            throw new AudioValidationException("Invalid or truncated WAV file.", HttpStatus.BAD_REQUEST);
        }
        if (wavBytes[0] != 'R' || wavBytes[1] != 'I' || wavBytes[2] != 'F' || wavBytes[3] != 'F'
                || wavBytes[8] != 'W' || wavBytes[9] != 'A' || wavBytes[10] != 'V' || wavBytes[11] != 'E') {
            throw new AudioValidationException("Payload is not a valid RIFF/WAVE file.", HttpStatus.BAD_REQUEST);
        }

        ByteBuffer buf = ByteBuffer.wrap(wavBytes).order(ByteOrder.LITTLE_ENDIAN);
        int pos = 12;
        int audioFormat = -1;
        int channels = 1;
        int sampleRate = 44100;
        int bitsPerSample = 16;
        byte[] dataBytes = null;

        while (pos + 8 <= wavBytes.length) {
            String chunkId = new String(wavBytes, pos, 4, StandardCharsets.US_ASCII);
            int chunkSize = buf.getInt(pos + 4);
            int chunkDataStart = pos + 8;
            if (chunkSize < 0 || chunkDataStart + chunkSize > wavBytes.length) {
                chunkSize = Math.max(0, Math.min(chunkSize, wavBytes.length - chunkDataStart));
            }
            if ("fmt ".equals(chunkId) && chunkSize >= 16) {
                audioFormat = buf.getShort(chunkDataStart) & 0xFFFF;
                channels = Math.max(1, buf.getShort(chunkDataStart + 2) & 0xFFFF);
                sampleRate = Math.max(8000, buf.getInt(chunkDataStart + 4));
                bitsPerSample = buf.getShort(chunkDataStart + 14) & 0xFFFF;
            } else if ("data".equals(chunkId)) {
                dataBytes = Arrays.copyOfRange(wavBytes, chunkDataStart, chunkDataStart + chunkSize);
                break;
            }
            pos = chunkDataStart + chunkSize + (chunkSize % 2);
        }

        if (audioFormat < 0 || dataBytes == null || dataBytes.length == 0) {
            throw new AudioValidationException("WAV file missing fmt or data chunk.", HttpStatus.BAD_REQUEST);
        }

        int bytesPerSample = Math.max(1, bitsPerSample / 8);
        int frameBytes = bytesPerSample * channels;
        int numFrames = dataBytes.length / frameBytes;
        if (numFrames <= 0) {
            throw new AudioValidationException("Audio contains no samples.", HttpStatus.BAD_REQUEST);
        }

        float[] mono = new float[numFrames];
        ByteBuffer db = ByteBuffer.wrap(dataBytes).order(ByteOrder.LITTLE_ENDIAN);

        for (int i = 0; i < numFrames; i++) {
            double sum = 0.0;
            for (int c = 0; c < channels; c++) {
                int offset = (i * channels + c) * bytesPerSample;
                float sample = 0.0f;
                if (audioFormat == 1) {
                    if (bitsPerSample == 16) {
                        sample = db.getShort(offset) / 32768.0f;
                    } else if (bitsPerSample == 24) {
                        int b0 = dataBytes[offset] & 0xFF;
                        int b1 = dataBytes[offset + 1] & 0xFF;
                        int b2 = dataBytes[offset + 2];
                        int val = (b2 << 16) | (b1 << 8) | b0;
                        sample = val / 8388608.0f;
                    } else if (bitsPerSample == 32) {
                        sample = (float) (db.getInt(offset) / 2147483648.0);
                    } else if (bitsPerSample == 8) {
                        sample = ((dataBytes[offset] & 0xFF) - 128) / 128.0f;
                    } else {
                        throw new AudioValidationException("Unsupported PCM bit depth: " + bitsPerSample, HttpStatus.BAD_REQUEST);
                    }
                } else if (audioFormat == 3 && bitsPerSample == 32) {
                    sample = db.getFloat(offset);
                } else {
                    throw new AudioValidationException("Unsupported WAV encoding format=" + audioFormat, HttpStatus.BAD_REQUEST);
                }
                sum += sample;
            }
            mono[i] = (float) (sum / channels);
        }

        return new DecodedWav(mono, sampleRate, channels);
    }

    public byte[] encodeWavMono(float[] samples, int sampleRate) {
        int n = samples.length;
        int dataSize = n * 2;
        ByteBuffer buf = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN);
        writeWavHeader(buf, 1, sampleRate, 16, dataSize);
        for (float s : samples) {
            float clamped = Math.max(-1.0f, Math.min(1.0f, s));
            short val = (short) Math.max(-32768, Math.min(32767, Math.round(clamped * 32767.0f)));
            buf.putShort(val);
        }
        return buf.array();
    }

    public byte[] encodeWavStereo(float[][] stereo, int sampleRate) {
        int n = stereo.length;
        int dataSize = n * 4;
        ByteBuffer buf = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN);
        writeWavHeader(buf, 2, sampleRate, 16, dataSize);
        for (int i = 0; i < n; i++) {
            float l = Math.max(-1.0f, Math.min(1.0f, stereo[i][0]));
            float r = Math.max(-1.0f, Math.min(1.0f, stereo[i][1]));
            short sl = (short) Math.max(-32768, Math.min(32767, Math.round(l * 32767.0f)));
            short srVal = (short) Math.max(-32768, Math.min(32767, Math.round(r * 32767.0f)));
            buf.putShort(sl);
            buf.putShort(srVal);
        }
        return buf.array();
    }

    private void writeWavHeader(ByteBuffer buf, int channels, int sampleRate, int bitsPerSample, int dataSize) {
        int byteRate = sampleRate * channels * (bitsPerSample / 8);
        short blockAlign = (short) (channels * (bitsPerSample / 8));
        buf.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(36 + dataSize);
        buf.put("WAVE".getBytes(StandardCharsets.US_ASCII));
        buf.put("fmt ".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(16);
        buf.putShort((short) 1);
        buf.putShort((short) channels);
        buf.putInt(sampleRate);
        buf.putInt(byteRate);
        buf.putShort(blockAlign);
        buf.putShort((short) bitsPerSample);
        buf.put("data".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(dataSize);
    }

    public float[] resampleLinear(float[] samples, int origSr, int targetSr) {
        if (origSr == targetSr || samples.length == 0) {
            return Arrays.copyOf(samples, samples.length);
        }
        int newLen = Math.max(1, (int) Math.round((double) samples.length * targetSr / origSr));
        float[] out = new float[newLen];
        double ratio = (double) (samples.length - 1) / Math.max(1, newLen - 1);
        for (int i = 0; i < newLen; i++) {
            double pos = i * ratio;
            int idx = (int) Math.floor(pos);
            double frac = pos - idx;
            float s0 = samples[Math.min(idx, samples.length - 1)];
            float s1 = samples[Math.min(idx + 1, samples.length - 1)];
            out[i] = (float) (s0 * (1.0 - frac) + s1 * frac);
        }
        return out;
    }

    // --- Validation (FR-INP) ---

    public ValidatedAudio validateAndDecodeAudio(
            byte[] fileBytes,
            String filename,
            long maxBytes,
            double minDurationSec,
            double maxDurationSec,
            int targetSr
    ) {
        String safeName = (filename == null || filename.isBlank()) ? "upload.wav" : filename;
        String ext = "";
        int dot = safeName.lastIndexOf('.');
        if (dot >= 0 && dot < safeName.length() - 1) {
            ext = safeName.substring(dot + 1).toLowerCase(Locale.ROOT);
        }
        if (!AppProperties.ALLOWED_AUDIO_EXTENSIONS.contains(ext)) {
            throw new AudioValidationException(
                    "Unsupported audio format '." + ext + "'. Allowed: .wav, .mp3, .m4a, .ogg, .flac",
                    HttpStatus.BAD_REQUEST
            );
        }
        if (fileBytes == null || fileBytes.length == 0) {
            throw new AudioValidationException("Uploaded audio file is empty.", HttpStatus.BAD_REQUEST);
        }
        if (fileBytes.length > maxBytes) {
            throw new AudioValidationException(
                    String.format(Locale.ROOT, "File size (%.1f MB) exceeds maximum %d MB.",
                            fileBytes.length / (1024.0 * 1024.0), maxBytes / (1024L * 1024L)),
                    HttpStatus.PAYLOAD_TOO_LARGE
            );
        }

        DecodedWav decoded = decodeWavBytes(fileBytes);
        double durationSec = (double) decoded.mono().length / decoded.sampleRate();
        if (durationSec < minDurationSec) {
            throw new AudioValidationException(
                    String.format(Locale.ROOT, "Audio duration (%.2fs) is shorter than minimum %.1fs.", durationSec, minDurationSec),
                    HttpStatus.BAD_REQUEST
            );
        }
        if (durationSec > maxDurationSec) {
            throw new AudioValidationException(
                    String.format(Locale.ROOT, "Audio duration (%.2fs) exceeds maximum %.1fs.", durationSec, maxDurationSec),
                    HttpStatus.BAD_REQUEST
            );
        }

        float[] normalized = resampleLinear(decoded.mono(), decoded.sampleRate(), targetSr);
        List<String> warnings = new ArrayList<>();
        float peak = 0.0f;
        int clipCount = 0;
        for (float v : normalized) {
            float abs = Math.abs(v);
            if (abs > peak) peak = abs;
            if (abs >= 0.99f) clipCount++;
        }
        double peakDb = 20.0 * Math.log10(Math.max(peak, 1e-9));
        double clipRatio = normalized.length > 0 ? (double) clipCount / normalized.length : 0.0;
        if (peakDb < -50.0) {
            warnings.add("Audio signal is very quiet (< -50 dBFS); consider recording closer to the mic.");
        }
        if (clipRatio > 0.05) {
            warnings.add("Audio contains heavy clipping; consider lowering input gain.");
        }

        byte[] wavOut = encodeWavMono(normalized, targetSr);
        double outDur = Math.round(((double) normalized.length / targetSr) * 1000.0) / 1000.0;
        return new ValidatedAudio(wavOut, safeName, ext, fileBytes.length, outDur, targetSr, decoded.channels(), warnings);
    }

    // --- Denoise & Auto-Trim ---

    public DenoiseResult denoiseAndTrim(byte[] wavBytes, boolean enableDenoise, boolean autoTrim) {
        DecodedWav decoded = decodeWavBytes(wavBytes);
        float[] samples = Arrays.copyOf(decoded.mono(), decoded.mono().length);
        int sr = decoded.sampleRate();
        int origLen = samples.length;
        List<String> warnings = new ArrayList<>();

        if (enableDenoise && samples.length > 512) {
            samples = applyHighPass75Hz(samples, sr);
            samples = applyNoiseGate(samples, sr);
        }

        double[] absVals = new double[samples.length];
        for (int i = 0; i < samples.length; i++) absVals[i] = Math.abs(samples[i]);
        Arrays.sort(absVals);
        double noiseEst = percentileSorted(absVals, 0.15) + 1e-7;
        double sigEst = percentileSorted(absVals, 0.95) + 1e-7;
        double snrDb = Math.round(20.0 * Math.log10(sigEst / noiseEst) * 100.0) / 100.0;

        double trimmedStartSec = 0.0;
        double trimmedEndSec = 0.0;
        double minKeepSec = 1.0;

        if (autoTrim && samples.length > (int) (sr * minKeepSec)) {
            int hop = Math.max(1, (int) (0.02 * sr));
            int numFrames = (samples.length + hop - 1) / hop;
            double[] frameRms = new double[numFrames];
            double peakRms = 0.0;
            for (int f = 0; f < numFrames; f++) {
                int s = f * hop;
                int e = Math.min(samples.length, s + hop);
                double sumSq = 0.0;
                for (int i = s; i < e; i++) sumSq += samples[i] * samples[i];
                double rms = Math.sqrt(sumSq / Math.max(1, e - s));
                frameRms[f] = rms;
                if (rms > peakRms) peakRms = rms;
            }
            double threshold = Math.max(peakRms * 0.03, Math.pow(10.0, -48.0 / 20.0));
            int firstActive = -1;
            int lastActive = -1;
            for (int f = 0; f < numFrames; f++) {
                if (frameRms[f] >= threshold) {
                    if (firstActive < 0) firstActive = f;
                    lastActive = f;
                }
            }
            if (firstActive >= 0) {
                int padFrames = 3;
                int startIdx = Math.max(0, (firstActive - padFrames) * hop);
                int endIdx = Math.min(samples.length, (lastActive + 1 + padFrames) * hop);
                if (endIdx - startIdx >= (int) (sr * minKeepSec)) {
                    trimmedStartSec = Math.round(((double) startIdx / sr) * 1000.0) / 1000.0;
                    trimmedEndSec = Math.round(((double) (origLen - endIdx) / sr) * 1000.0) / 1000.0;
                    samples = Arrays.copyOfRange(samples, startIdx, endIdx);
                }
            }
        }

        float peak = 0.0f;
        for (float v : samples) peak = Math.max(peak, Math.abs(v));
        if (peak > 1e-4f && peak < 0.25f) {
            float gain = Math.min(0.5f / peak, 8.0f);
            for (int i = 0; i < samples.length; i++) samples[i] *= gain;
        } else if (peak < 1e-4f) {
            warnings.add("Denoised signal is nearly silent.");
        }

        byte[] outBytes = encodeWavMono(samples, sr);
        double outDur = Math.round(((double) samples.length / sr) * 1000.0) / 1000.0;
        return new DenoiseResult(outBytes, trimmedStartSec, trimmedEndSec, outDur, snrDb, warnings);
    }

    private float[] applyHighPass75Hz(float[] x, int sr) {
        double rc = 1.0 / (2.0 * Math.PI * 75.0);
        double dt = 1.0 / sr;
        double alpha = rc / (rc + dt);
        float[] y = new float[x.length];
        if (x.length == 0) return y;
        y[0] = x[0];
        for (int i = 1; i < x.length; i++) {
            y[i] = (float) (alpha * (y[i - 1] + x[i] - x[i - 1]));
        }
        return y;
    }

    private float[] applyNoiseGate(float[] x, int sr) {
        int hop = Math.max(64, (int) (0.015 * sr));
        int numFrames = (x.length + hop - 1) / hop;
        double[] rmsArr = new double[numFrames];
        for (int f = 0; f < numFrames; f++) {
            int s = f * hop;
            int e = Math.min(x.length, s + hop);
            double sum = 0.0;
            for (int i = s; i < e; i++) sum += x[i] * x[i];
            rmsArr[f] = Math.sqrt(sum / Math.max(1, e - s));
        }
        double[] sorted = Arrays.copyOf(rmsArr, rmsArr.length);
        Arrays.sort(sorted);
        double floor = percentileSorted(sorted, 0.20);
        float[] y = Arrays.copyOf(x, x.length);
        for (int f = 0; f < numFrames; f++) {
            double r = rmsArr[f];
            double gain = Math.max(0.18, Math.min(1.0, (r - 1.15 * floor) / (r + 1e-8)));
            int s = f * hop;
            int e = Math.min(y.length, s + hop);
            for (int i = s; i < e; i++) {
                y[i] *= (float) gain;
            }
        }
        return y;
    }

    private double percentileSorted(double[] sorted, double p) {
        if (sorted.length == 0) return 0.0;
        int idx = Math.max(0, Math.min(sorted.length - 1, (int) Math.round(p * (sorted.length - 1))));
        return sorted[idx];
    }

    // --- Audio Analysis (BPM, Key/Scale, F0 YIN-lite, Raw Melody MIDI) ---

    public AnalyzeResult analyzeAudio(byte[] wavBytes, Double bpmOverride, String keyOverride, String scaleOverride) {
        DecodedWav decoded = decodeWavBytes(wavBytes);
        float[] samples = decoded.mono();
        int sr = decoded.sampleRate();
        double durationSec = Math.round(((double) samples.length / sr) * 1000.0) / 1000.0;

        double bpm = bpmOverride != null ? clampBpm(bpmOverride) : estimateBpm(samples, sr);

        int hopLength = 512;
        int frameLength = 2048;
        float[][] f0AndConf = extractF0Contour(samples, sr, frameLength, hopLength);
        List<MidiNote> notes = segmentNotes(f0AndConf[0], f0AndConf[1], sr, hopLength, bpm);

        String detectedKey = "C";
        String detectedScale = "major";
        double keyConf = 0.35;
        if (!notes.isEmpty()) {
            double[] chroma = new double[12];
            double chromaSum = 0.0;
            for (MidiNote n : notes) {
                double w = n.getDuration() * n.getConfidence();
                chroma[Math.floorMod(n.getPitch(), 12)] += w;
                chromaSum += w;
            }
            if (chromaSum > 0.0) {
                double[] keyRes = estimateKeyFromChroma(chroma);
                int bestIdx = (int) keyRes[0];
                boolean isMinor = keyRes[1] > 0.5;
                detectedKey = NOTE_NAMES[bestIdx];
                detectedScale = isMinor ? "minor" : "major";
                keyConf = keyRes[2];
            }
        }

        if (keyOverride != null && !keyOverride.isBlank()) {
            detectedKey = keyOverride;
            keyConf = 1.0;
        }
        if (scaleOverride != null && !scaleOverride.isBlank()) {
            detectedScale = scaleOverride;
        }

        boolean lowConfWarning = keyConf < 0.6;
        String timeSig = estimateTimeSignature(samples, sr, bpm);
        int beatsPerBar = MusicTheory.beatsPerBarFromTs(timeSig);
        double barDurSec = beatsPerBar * (60.0 / bpm);
        int bars = Math.max(1, (int) Math.round(durationSec / Math.max(barDurSec, 0.1)));

        return new AnalyzeResult(bpm, timeSig, detectedKey, detectedScale, keyConf, lowConfWarning, bars, durationSec, notes);
    }

    private String estimateTimeSignature(float[] samples, int sr, double bpm) {
        int hop = Math.max(1, (int) (0.01 * sr));
        int numFrames = (samples.length + hop - 1) / hop;
        double fps = (double) sr / hop;
        double beatSec = 60.0 / Math.max(40.0, bpm);
        int lag3 = (int) Math.round(3.0 * beatSec * fps);
        int lag4 = (int) Math.round(4.0 * beatSec * fps);
        if (lag4 <= 0 || numFrames < lag4 * 3) {
            return "4/4";
        }
        double[] onset = new double[numFrames];
        double prevRms = 0.0;
        for (int f = 0; f < numFrames; f++) {
            int s = f * hop;
            int e = Math.min(samples.length, s + hop);
            double sum = 0.0;
            for (int i = s; i < e; i++) sum += samples[i] * samples[i];
            double rms = Math.sqrt(sum / Math.max(1, e - s));
            onset[f] = f > 0 ? Math.max(0.0, rms - prevRms) : 0.0;
            prevRms = rms;
        }
        double s3 = lagCorr(onset, lag3);
        double s4 = lagCorr(onset, lag4);
        if (s3 > 1.38 * Math.max(s4, 1e-6)) {
            int lag6 = lag3 * 2;
            double s6 = (lag6 < numFrames - 10) ? lagCorr(onset, lag6) : 0.0;
            return (bpm >= 115.0 && s6 >= 0.85 * s3) ? "6/8" : "3/4";
        }
        return "4/4";
    }

    private double lagCorr(double[] arr, int lag) {
        if (lag <= 0 || lag >= arr.length) return 0.0;
        double sum = 0.0;
        int n = arr.length - lag;
        for (int i = 0; i < n; i++) {
            sum += arr[i] * arr[i + lag];
        }
        return sum / Math.max(1, n);
    }

    private double clampBpm(double raw) {
        if (!Double.isFinite(raw) || raw <= 0.0) return 120.0;
        double bpm = raw;
        while (bpm < 40.0) bpm *= 2.0;
        while (bpm > 220.0) bpm /= 2.0;
        return Math.round(bpm * 10.0) / 10.0;
    }

    private double estimateBpm(float[] samples, int sr) {
        int hop = Math.max(1, (int) (0.01 * sr));
        int numFrames = (samples.length + hop - 1) / hop;
        if (numFrames < 50) return 120.0;
        double[] env = new double[numFrames];
        for (int f = 0; f < numFrames; f++) {
            int s = f * hop;
            int e = Math.min(samples.length, s + hop);
            double sum = 0.0;
            for (int i = s; i < e; i++) sum += samples[i] * samples[i];
            env[f] = Math.sqrt(sum / Math.max(1, e - s));
        }
        double[] onset = new double[numFrames];
        double mean = 0.0;
        for (int i = 1; i < numFrames; i++) {
            onset[i] = Math.max(0.0, env[i] - env[i - 1]);
            mean += onset[i];
        }
        mean /= numFrames;
        for (int i = 0; i < numFrames; i++) onset[i] -= mean;

        double fps = (double) sr / hop;
        int minLag = Math.max(1, (int) Math.round(fps * 60.0 / 200.0));
        int maxLag = Math.min(numFrames - 1, (int) Math.round(fps * 60.0 / 50.0));
        if (maxLag <= minLag) return 120.0;

        int bestLag = minLag;
        double bestVal = Double.NEGATIVE_INFINITY;
        for (int lag = minLag; lag <= maxLag; lag++) {
            double corr = 0.0;
            for (int i = 0; i < numFrames - lag; i++) {
                corr += onset[i] * onset[i + lag];
            }
            if (corr > bestVal) {
                bestVal = corr;
                bestLag = lag;
            }
        }
        if (bestVal <= 0.0) return 120.0;
        return clampBpm(60.0 * fps / bestLag);
    }

    public float[][] extractF0Contour(float[] samples, int sr, int frameLength, int hopLength) {
        double fmin = 65.0;
        double fmax = 1046.5;
        int minLag = Math.max(1, (int) (sr / fmax));
        int maxLag = Math.min(frameLength / 2, (int) (sr / fmin));
        int numFrames = Math.max(1, 1 + Math.max(0, samples.length - frameLength) / hopLength);

        float[] f0 = new float[numFrames];
        float[] conf = new float[numFrames];

        double sumAll = 0.0;
        for (float v : samples) sumAll += v * v;
        double rmsAll = samples.length > 0 ? Math.sqrt(sumAll / samples.length) : 0.0;
        double silThresh = Math.max(rmsAll * 0.08, 1e-4);

        for (int idx = 0; idx < numFrames; idx++) {
            int start = idx * hopLength;
            float[] frame = new float[frameLength];
            int copyLen = Math.min(frameLength, Math.max(0, samples.length - start));
            double sumSq = 0.0;
            double mean = 0.0;
            for (int i = 0; i < copyLen; i++) {
                float v = samples[start + i];
                frame[i] = v;
                sumSq += v * v;
                mean += v;
            }
            double rms = Math.sqrt(sumSq / frameLength);
            if (rms < silThresh) continue;

            mean /= frameLength;
            for (int i = 0; i < frameLength; i++) frame[i] -= (float) mean;

            double acf0 = 0.0;
            for (int i = 0; i < frameLength; i++) acf0 += frame[i] * frame[i];
            if (acf0 <= 1e-10) continue;

            int bestLag = -1;
            double bestVal = -1.0;
            double[] seg = new double[Math.max(0, maxLag - minLag + 1)];
            for (int lag = minLag; lag <= maxLag; lag++) {
                double c = 0.0;
                for (int i = 0; i < frameLength - lag; i++) {
                    c += frame[i] * frame[i + lag];
                }
                double normVal = c / acf0;
                seg[lag - minLag] = normVal;
                if (normVal > bestVal) {
                    bestVal = normVal;
                    bestLag = lag;
                }
            }
            if (bestLag < 0 || bestVal < 0.45) continue;

            double bestLagF = bestLag;
            int rel = bestLag - minLag;
            if (rel > 0 && rel < seg.length - 1) {
                double y0 = seg[rel - 1], y1 = seg[rel], y2 = seg[rel + 1];
                double denom = y0 - 2.0 * y1 + y2;
                if (Math.abs(denom) > 1e-9) {
                    double shift = Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / denom));
                    bestLagF = bestLag + shift;
                }
            }
            if (bestLagF > 0.0) {
                f0[idx] = (float) (sr / bestLagF);
                conf[idx] = (float) Math.max(0.0, Math.min(1.0, bestVal));
            }
        }
        return new float[][]{f0, conf};
    }

    private List<MidiNote> segmentNotes(float[] f0, float[] conf, int sr, int hopLength, double bpm) {
        double frameDur = (double) hopLength / sr;
        double beatsPerSec = bpm / 60.0;
        double[] midiRaw = new double[f0.length];
        for (int i = 0; i < f0.length; i++) {
            if (f0[i] > 0.0f && conf[i] >= 0.5f) {
                midiRaw[i] = 69.0 + 12.0 * (Math.log(Math.max(f0[i], 1e-6) / 440.0) / Math.log(2.0));
            }
        }

        List<MidiNote> notes = new ArrayList<>();
        List<Double> curPitches = new ArrayList<>();
        List<Double> curConfs = new ArrayList<>();
        int startIdx = 0;

        for (int i = 0; i < midiRaw.length; i++) {
            double m = midiRaw[i];
            if (m <= 0.0) {
                flushNote(notes, curPitches, curConfs, startIdx, i, frameDur, beatsPerSec);
                curPitches.clear();
                curConfs.clear();
                continue;
            }
            if (curPitches.isEmpty()) {
                startIdx = i;
                curPitches.add(m);
                curConfs.add((double) conf[i]);
            } else {
                double refPitch = median(curPitches);
                if (Math.abs(m - refPitch) <= 0.75) {
                    curPitches.add(m);
                    curConfs.add((double) conf[i]);
                } else {
                    flushNote(notes, curPitches, curConfs, startIdx, i, frameDur, beatsPerSec);
                    startIdx = i;
                    curPitches.clear();
                    curConfs.clear();
                    curPitches.add(m);
                    curConfs.add((double) conf[i]);
                }
            }
        }
        flushNote(notes, curPitches, curConfs, startIdx, midiRaw.length, frameDur, beatsPerSec);
        return notes;
    }

    private void flushNote(List<MidiNote> notes, List<Double> pitches, List<Double> confs,
                           int startIdx, int endIdx, double frameDur, double beatsPerSec) {
        if (pitches.isEmpty()) return;
        double durSec = (endIdx - startIdx) * frameDur;
        double avgConf = confs.stream().mapToDouble(Double::doubleValue).average().orElse(0.0);
        if (durSec < 0.06 || avgConf < 0.5) return;
        int midi = Math.max(21, Math.min(108, (int) Math.round(median(pitches))));
        double startBeat = Math.round(startIdx * frameDur * beatsPerSec * 1000.0) / 1000.0;
        double durBeats = Math.max(0.05, Math.round(durSec * beatsPerSec * 1000.0) / 1000.0);
        notes.add(new MidiNote(midi, startBeat, durBeats, 85, Math.round(avgConf * 1000.0) / 1000.0));
    }

    private double median(List<Double> vals) {
        double[] arr = vals.stream().mapToDouble(Double::doubleValue).sorted().toArray();
        if (arr.length == 0) return 0.0;
        int mid = arr.length / 2;
        return arr.length % 2 == 1 ? arr[mid] : 0.5 * (arr[mid - 1] + arr[mid]);
    }

    private double[] estimateKeyFromChroma(double[] chroma) {
        double meanC = Arrays.stream(chroma).average().orElse(0.0);
        double[] cNorm = new double[12];
        double normC = 0.0;
        for (int i = 0; i < 12; i++) {
            cNorm[i] = chroma[i] - meanC;
            normC += cNorm[i] * cNorm[i];
        }
        normC = Math.sqrt(normC) + 1e-9;

        double bestCorr = Double.NEGATIVE_INFINITY;
        double secondCorr = Double.NEGATIVE_INFINITY;
        int bestRoot = 0;
        boolean bestMinor = false;

        for (int root = 0; root < 12; root++) {
            for (int mode = 0; mode < 2; mode++) {
                double[] prof = mode == 0 ? MAJOR_PROFILE : MINOR_PROFILE;
                double meanP = Arrays.stream(prof).average().orElse(0.0);
                double dot = 0.0;
                double normP = 0.0;
                for (int i = 0; i < 12; i++) {
                    double pVal = prof[Math.floorMod(i - root, 12)] - meanP;
                    dot += cNorm[i] * pVal;
                    normP += pVal * pVal;
                }
                double corr = dot / (normC * (Math.sqrt(normP) + 1e-9));
                if (corr > bestCorr) {
                    secondCorr = bestCorr;
                    bestCorr = corr;
                    bestRoot = root;
                    bestMinor = (mode == 1);
                } else if (corr > secondCorr) {
                    secondCorr = corr;
                }
            }
        }

        double margin = Math.max(0.0, bestCorr - Math.max(-1.0, secondCorr));
        double conf = Math.max(0.0, Math.min(0.99, 0.45 + 0.45 * Math.max(0.0, bestCorr) + 0.6 * margin));
        return new double[]{bestRoot, bestMinor ? 1.0 : 0.0, Math.round(conf * 1000.0) / 1000.0};
    }

    // --- Auto-Tune DSP ---

    public AutotuneSettings applyPreset(String preset, String key, String scale) {
        AutotuneSettings s = new AutotuneSettings();
        String p = preset != null ? preset.toLowerCase(Locale.ROOT) : "off";
        s.setKey(key != null ? key : "C");
        s.setScale(scale != null ? scale : "major");
        switch (p) {
            case "natural" -> { s.setEnabled(true); s.setPreset("natural"); s.setRetuneSpeedMs(65.0); s.setHumanize(0.7); s.setMixPercent(75.0); }
            case "balanced" -> { s.setEnabled(true); s.setPreset("balanced"); s.setRetuneSpeedMs(25.0); s.setHumanize(0.35); s.setMixPercent(95.0); }
            case "modern" -> { s.setEnabled(true); s.setPreset("modern"); s.setRetuneSpeedMs(0.0); s.setHumanize(0.05); s.setMixPercent(100.0); }
            default -> { s.setEnabled(false); s.setPreset("off"); s.setRetuneSpeedMs(200.0); s.setHumanize(1.0); s.setMixPercent(0.0); }
        }
        return s;
    }

    public AutotuneSettings resolveAutotuneSettings(AutotuneSettings input) {
        AutotuneSettings s = input != null ? input.copy() : new AutotuneSettings();
        // In Auto-Tune Pro, enabled=true with mix_percent > 0 must remain active even if preset is still "off"
        if (!s.isEnabled() || s.getMixPercent() <= 0.0) {
            if ("off".equalsIgnoreCase(s.getPreset())) {
                s.setEnabled(false);
                s.setMixPercent(0.0);
            }
        }
        return s;
    }

    public byte[] applyAutotune(byte[] wavBytes, AutotuneSettings settings) {
        DecodedWav decoded = decodeWavBytes(wavBytes);
        float[] samples = decoded.mono();
        int sr = decoded.sampleRate();
        AutotuneSettings eff = resolveAutotuneSettings(settings);

        if (!eff.isEnabled() || eff.getMixPercent() <= 0.0) {
            return encodeWavMono(samples, sr);
        }

        int hopLength = 512;
        int winLength = 2048;
        float[][] f0AndConf = extractF0Contour(samples, sr, winLength, hopLength);
        float[] f0 = f0AndConf[0];
        float[] conf = f0AndConf[1];

        double frameMs = ((double) hopLength / sr) * 1000.0;
        double alpha = eff.getRetuneSpeedMs() <= 1.0
                ? 1.0
                : Math.max(0.05, Math.min(1.0, frameMs / (eff.getRetuneSpeedMs() + frameMs)));

        double[] ratios = new double[f0.length];
        double prevRatio = 1.0;
        double humanize = Math.max(0.0, Math.min(1.0, eff.getHumanize()));

        for (int i = 0; i < f0.length; i++) {
            double desiredRatio = 1.0;
            if (f0[i] > 0.0f && conf[i] >= 0.5f) {
                double midiIn = 69.0 + 12.0 * (Math.log(f0[i] / 440.0) / Math.log(2.0));
                double midiTarget = MusicTheory.nearestScaleMidi(midiIn, eff.getKey(), eff.getScale());
                double midiBlended = midiTarget * (1.0 - 0.5 * humanize) + midiIn * (0.5 * humanize);
                double semitoneShift = Math.max(-5.0, Math.min(5.0, midiBlended - midiIn));
                desiredRatio = Math.pow(2.0, semitoneShift / 12.0);
            }
            double smoothed = prevRatio + alpha * (desiredRatio - prevRatio);
            ratios[i] = smoothed;
            prevRatio = smoothed;
        }

        float[] wet = pitchShiftOla(samples, ratios, hopLength, winLength);
        double mix = Math.max(0.0, Math.min(1.0, eff.getMixPercent() / 100.0));
        float[] blended = new float[samples.length];
        for (int i = 0; i < samples.length; i++) {
            blended[i] = (float) ((1.0 - mix) * samples[i] + mix * wet[i]);
        }
        return encodeWavMono(blended, sr);
    }

    private float[] pitchShiftOla(float[] samples, double[] ratios, int hopLength, int winLength) {
        int n = samples.length;
        if (n == 0) return new float[0];
        float[] out = new float[n];
        float[] norm = new float[n];
        float[] window = new float[winLength];
        for (int i = 0; i < winLength; i++) {
            window[i] = (float) (0.5 * (1.0 - Math.cos(2.0 * Math.PI * i / (winLength - 1))));
        }
        int half = winLength / 2;

        for (int idx = 0; idx < ratios.length; idx++) {
            int center = idx * hopLength;
            if (center >= n) break;
            double ratio = Math.max(0.707, Math.min(1.414, ratios[idx]));
            float[] srcSeg = new float[winLength];
            if (Math.abs(ratio - 1.0) < 0.003) {
                int sStart = Math.max(0, center - half);
                int sEnd = Math.min(n, center + half);
                int dStart = sStart - (center - half);
                System.arraycopy(samples, sStart, srcSeg, dStart, sEnd - sStart);
            } else {
                for (int w = 0; w < winLength; w++) {
                    double offset = (w - half) * ratio + center;
                    if (offset >= 0 && offset < n - 1) {
                        int i0 = (int) Math.floor(offset);
                        double frac = offset - i0;
                        srcSeg[w] = (float) (samples[i0] * (1.0 - frac) + samples[i0 + 1] * frac);
                    }
                }
            }

            int oStart = Math.max(0, center - half);
            int oEnd = Math.min(n, center + half);
            int wStart = oStart - (center - half);
            for (int o = oStart; o < oEnd; o++) {
                float wVal = window[wStart + (o - oStart)];
                out[o] += srcSeg[wStart + (o - oStart)] * wVal;
                norm[o] += wVal * wVal;
            }
        }

        for (int i = 0; i < n; i++) {
            out[i] = norm[i] > 1e-6f ? out[i] / norm[i] : samples[i];
        }
        return out;
    }

    // --- Master Limiter (<= -1.0 dBFS) & Multi-Track Renderer ---

    public double peakDbfs(float[][] stereo) {
        if (stereo == null || stereo.length == 0) return -120.0;
        double peak = 0.0;
        for (float[] frame : stereo) {
            peak = Math.max(peak, Math.abs(frame[0]));
            peak = Math.max(peak, Math.abs(frame[1]));
        }
        if (peak <= 1e-12) return -120.0;
        return 20.0 * Math.log10(peak);
    }

    public float[][] applyMasterLimiter(float[][] stereo, double ceilingDb, double targetLufs) {
        if (stereo == null || stereo.length == 0) return new float[0][2];
        double safeCeilingDb = Math.min(ceilingDb, -1.0);
        double ceilingLinear = Math.pow(10.0, safeCeilingDb / 20.0);

        float[][] x = new float[stereo.length][2];
        double sumSq = 0.0;
        for (int i = 0; i < stereo.length; i++) {
            x[i][0] = stereo[i][0];
            x[i][1] = stereo[i][1];
            sumSq += x[i][0] * x[i][0] + x[i][1] * x[i][1];
        }

        double rms = Math.sqrt(sumSq / (stereo.length * 2.0));
        if (rms > 1e-5) {
            double rmsDb = 20.0 * Math.log10(rms);
            double desiredGainDb = Math.max(-12.0, Math.min(12.0, targetLufs - rmsDb));
            float gain = (float) Math.pow(10.0, desiredGainDb / 20.0);
            for (int i = 0; i < x.length; i++) {
                x[i][0] *= gain;
                x[i][1] *= gain;
            }
        }

        double peak = 0.0;
        for (float[] f : x) {
            peak = Math.max(peak, Math.max(Math.abs(f[0]), Math.abs(f[1])));
        }
        if (peak > ceilingLinear) {
            for (int i = 0; i < x.length; i++) {
                x[i][0] = (float) (Math.tanh(x[i][0] / ceilingLinear) * ceilingLinear);
                x[i][1] = (float) (Math.tanh(x[i][1] / ceilingLinear) * ceilingLinear);
            }
        }

        float hardCap = (float) (ceilingLinear * 0.994);
        for (int i = 0; i < x.length; i++) {
            x[i][0] = Math.max(-hardCap, Math.min(hardCap, x[i][0]));
            x[i][1] = Math.max(-hardCap, Math.min(hardCap, x[i][1]));
        }
        return x;
    }

    public String normalizePreviewMode(String mode) {
        if (mode == null || mode.isBlank()) return "ai_mix";
        String m = mode.trim().toLowerCase(Locale.ROOT);
        return switch (m) {
            case "mix", "ai_mix" -> "ai_mix";
            case "raw", "dry", "dry_beat", "autotune", "autotune_beat", "preserve", "enhance" -> m;
            default -> "ai_mix";
        };
    }

    public String toWorkerRenderMode(String mode) {
        String norm = normalizePreviewMode(mode);
        return switch (norm) {
            case "raw" -> "preserve";
            case "dry", "dry_beat" -> "dry_beat";
            case "autotune", "autotune_beat" -> "autotune_beat";
            case "preserve" -> "preserve";
            case "enhance" -> "enhance";
            default -> "ai_mix";
        };
    }

    public ProjectState preparePreviewProject(ProjectState source, String mode) {
        String norm = normalizePreviewMode(mode);
        ProjectState copy;
        try {
            copy = objectMapper.readValue(objectMapper.writeValueAsBytes(source), ProjectState.class);
        } catch (Exception e) {
            copy = source;
        }
        Map<String, TrackState> tracks = copy.getTracks();
        if (tracks == null) return copy;

        if ("raw".equals(norm)) {
            muteAllMidiTracks(tracks);
            String rawRef = copy.getAudioAssets() != null ? copy.getAudioAssets().getRawInputRef() : null;
            if (copy.getAudioAssets() != null && rawRef != null && !rawRef.isBlank()) {
                copy.getAudioAssets().setDryDenoisedRef(rawRef);
                copy.getAudioAssets().setTunedVocalRef(rawRef);
            }
            setVocalClipSource(tracks.get("vocal"), "raw_input_ref");
        } else if ("dry".equals(norm)) {
            muteAllMidiTracks(tracks);
            setVocalClipSource(tracks.get("vocal"), "dry_denoised_ref");
        } else if ("dry_beat".equals(norm)) {
            setVocalClipSource(tracks.get("vocal"), "dry_denoised_ref");
        } else if ("autotune".equals(norm)) {
            muteAllMidiTracks(tracks);
            boolean autotuneEnabled = copy.getAutotuneSettings() == null || copy.getAutotuneSettings().isEnabled();
            setVocalClipSource(tracks.get("vocal"), autotuneEnabled ? "tuned_vocal_ref" : "dry_denoised_ref");
        } else if ("preserve".equals(norm)) {
            TrackState lead = tracks.get("lead");
            if (lead != null) {
                lead.setMute(true);
                lead.setSolo(false);
            }
            for (Map.Entry<String, TrackState> e : tracks.entrySet()) {
                if (!"vocal".equalsIgnoreCase(e.getKey()) && !"lead".equalsIgnoreCase(e.getKey())
                        && e.getValue() != null && !"audio".equalsIgnoreCase(e.getValue().getType())) {
                    e.getValue().setVolume(Math.max(0.0, e.getValue().getVolume() * 0.78));
                }
            }
        } else if ("enhance".equals(norm)) {
            TrackState vocal = tracks.get("vocal");
            if (vocal != null) {
                vocal.setVolume(Math.max(0.0, vocal.getVolume() * 0.90));
            }
            TrackState lead = tracks.computeIfAbsent("lead",
                    k -> TrackState.midiTrack("electric_piano", 0.85, 0.1));
            lead.setMute(false);
            if ((lead.getNotes() == null || lead.getNotes().isEmpty())) {
                List<MidiNote> srcNotes = (copy.getMelodyNotes() != null && !copy.getMelodyNotes().isEmpty())
                        ? copy.getMelodyNotes()
                        : (copy.getAnalysis() != null ? copy.getAnalysis().getRawMelodyMidi() : List.of());
                if (srcNotes != null && !srcNotes.isEmpty()) {
                    List<MidiNote> synthLead = new ArrayList<>(srcNotes.size());
                    for (MidiNote n : srcNotes) {
                        synthLead.add(new MidiNote(
                                Math.min(127, n.getPitch() + 12),
                                n.getStartBeat(),
                                n.getDuration(),
                                Math.min(127, Math.max(70, n.getVelocity())),
                                n.getConfidence()
                        ));
                    }
                    lead.setNotes(synthLead);
                }
            }
            for (Map.Entry<String, TrackState> e : tracks.entrySet()) {
                TrackState t = e.getValue();
                if (t != null && !"audio".equalsIgnoreCase(t.getType())) {
                    t.setVolume(Math.min(1.2, t.getVolume() * 1.12));
                }
            }
        }
        if (!"raw".equals(norm)
                && copy.getAutotuneSettings() != null
                && !copy.getAutotuneSettings().isEnabled()
                && copy.getAudioAssets() != null) {
            copy.getAudioAssets().setTunedVocalRef(null);
        }
        return copy;
    }

    private void muteAllMidiTracks(Map<String, TrackState> tracks) {
        for (Map.Entry<String, TrackState> e : tracks.entrySet()) {
            TrackState t = e.getValue();
            if (t == null) continue;
            if ("vocal".equalsIgnoreCase(e.getKey())) {
                t.setMute(false);
                t.setSolo(false);
            } else {
                t.setMute(true);
                t.setSolo(false);
            }
        }
    }

    private void setVocalClipSource(TrackState vocalTrack, String targetSource) {
        if (vocalTrack == null) return;
        vocalTrack.setMute(false);
        if (vocalTrack.getClips() == null) return;
        for (AudioClip clip : vocalTrack.getClips()) {
            if (clip == null) continue;
            String s = clip.getSource();
            if (s == null || s.isBlank()
                    || "raw_input_ref".equals(s)
                    || "dry_denoised_ref".equals(s)
                    || "tuned_vocal_ref".equals(s)) {
                clip.setSource(targetSource);
            }
        }
    }

    public RenderedMix renderProjectMix(ProjectState project, ProjectStateStore store,
                                        String mode, boolean applyMastering, int sampleRate) {
        Map<String, TrackState> origTracks = project.getTracks();
        if (origTracks != null && !origTracks.isEmpty() && origTracks.values().stream().allMatch(TrackState::isMute)) {
            throw new IllegalArgumentException("All tracks are muted; unmute at least one track before exporting.");
        }

        String normMode = normalizePreviewMode(mode);
        ProjectState effectiveProject = preparePreviewProject(project, normMode);
        Map<String, TrackState> tracks = effectiveProject.getTracks();

        double bpm = effectiveProject.getAnalysis() != null && effectiveProject.getAnalysis().getBpm() > 0
                ? Math.max(40.0, Math.min(220.0, effectiveProject.getAnalysis().getBpm())) : 120.0;
        int structBars = effectiveProject.getSongStructure() != null ? effectiveProject.getSongStructure().getTotalBars() : 4;
        int analysisBars = effectiveProject.getAnalysis() != null ? effectiveProject.getAnalysis().getBars() : 4;
        if (structBars > 256 || analysisBars > 256) {
            throw new AudioValidationException(
                    "Project duration exceeds maximum supported 256 bars.", HttpStatus.BAD_REQUEST);
        }
        int totalBars = Math.max(1, Math.max(structBars, analysisBars));
        String timeSig = effectiveProject.getAnalysis() != null ? effectiveProject.getAnalysis().getTimeSignature() : "4/4";
        int beatsPerBar = MusicTheory.beatsPerBarFromTs(timeSig);
        long rawSamples = Math.round(totalBars * beatsPerBar * (60.0 / bpm) * sampleRate);
        int maxSamples = Math.max(sampleRate, sampleRate * 360);
        int totalSamples = (int) Math.max(1L, Math.min(maxSamples, rawSamples));

        boolean anySolo = tracks != null && tracks.values().stream().anyMatch(TrackState::isSolo);
        Map<String, float[][]> stems = new LinkedHashMap<>();
        float[][] mix = new float[totalSamples][2];
        float[][] reverbSendBus = null;
        float[][] delaySendBus = null;
        boolean hasReverbSend = false;
        boolean hasDelaySend = false;

        if (tracks != null) {
            for (Map.Entry<String, TrackState> entry : tracks.entrySet()) {
                String name = entry.getKey();
                TrackState track = entry.getValue();
                float[] mono = "audio".equalsIgnoreCase(track.getType())
                        ? renderAudioTrack(name, track, effectiveProject, store, totalSamples, sampleRate, normMode, bpm, beatsPerBar)
                        : synthesizeMidiTrack(name, track.getNotes(), bpm, totalSamples, sampleRate);

                float[] eqMono = applyTrackEq(mono, track, sampleRate);
                boolean active = !track.isMute() && (!anySolo || track.isSolo());
                float[][] stereo = panStereo(eqMono, track.getPan(), active ? track.getVolume() : 0.0);
                stems.put(name, stereo);
                if (active) {
                    double revSend = track.getReverbSend();
                    double dlySend = track.getDelaySend();
                    float revScale = (float) (revSend * 0.55);
                    float dlyScale = (float) (dlySend * 0.50);
                    if (revSend > 0.001) {
                        hasReverbSend = true;
                        if (reverbSendBus == null) {
                            reverbSendBus = new float[totalSamples][2];
                        }
                    }
                    if (dlySend > 0.001) {
                        hasDelaySend = true;
                        if (delaySendBus == null) {
                            delaySendBus = new float[totalSamples][2];
                        }
                    }

                    for (int i = 0; i < totalSamples; i++) {
                        float l = stereo[i][0];
                        float r = stereo[i][1];
                        mix[i][0] += l;
                        mix[i][1] += r;
                        if (revSend > 0.001) {
                            reverbSendBus[i][0] += l * revScale;
                            reverbSendBus[i][1] += r * revScale;
                        }
                        if (dlySend > 0.001) {
                            delaySendBus[i][0] += l * dlyScale;
                            delaySendBus[i][1] += r * dlyScale;
                        }
                    }
                }
            }
        }

        if (hasReverbSend && reverbSendBus != null) {
            addStereoInPlace(mix, renderStereoReverb(reverbSendBus, sampleRate));
        }
        if (hasDelaySend && delaySendBus != null) {
            addStereoInPlace(mix, renderStereoDelay(delaySendBus, bpm, sampleRate));
        }

        if (applyMastering) {
            double ceiling = effectiveProject.getMastering() != null ? effectiveProject.getMastering().getLimiterCeilingDb() : -1.0;
            double lufs = effectiveProject.getMastering() != null ? effectiveProject.getMastering().getTargetLufs() : -14.0;
            mix = applyMasterLimiter(mix, ceiling, lufs);
        }

        return new RenderedMix(mix, stems, sampleRate);
    }

    private float[] renderAudioTrack(String trackName, TrackState track, ProjectState project, ProjectStateStore store,
                                     int totalSamples, int sr, String mode, double bpm, int beatsPerBar) {
        float[] buf = new float[totalSamples];
        double secPerBar = beatsPerBar * (60.0 / bpm);
        List<AudioClip> clips = track.getClips();

        if (clips == null || clips.isEmpty()) {
            if ("vocal".equalsIgnoreCase(trackName)) {
                String fallbackRef = resolvePreferredAudioRef(project, mode);
                if (fallbackRef != null) {
                    store.getAudioBytes(fallbackRef).ifPresent(bytes -> {
                        DecodedWav decoded = decodeWavBytes(bytes);
                        float[] samples = decoded.sampleRate() != sr
                                ? resampleLinear(decoded.mono(), decoded.sampleRate(), sr)
                                : decoded.mono();
                        int n = Math.min(totalSamples, samples.length);
                        for (int i = 0; i < n; i++) buf[i] += samples[i];
                    });
                }
            }
            return buf;
        }

        for (AudioClip clip : clips) {
            byte[] wavBytes = resolveClipBytes(clip.getSource(), project, store, mode);
            if (wavBytes == null) continue;
            DecodedWav decoded = decodeWavBytes(wavBytes);
            float[] samples = decoded.sampleRate() != sr
                    ? resampleLinear(decoded.mono(), decoded.sampleRate(), sr)
                    : decoded.mono();
            int tStart = Math.max(0, (int) Math.round(clip.getTrimStartSec() * sr));
            int tEnd = clip.getTrimEndSec() != null ? (int) Math.round(clip.getTrimEndSec() * sr) : samples.length;
            tEnd = Math.min(samples.length, Math.max(tStart, tEnd));
            if (tEnd <= tStart) continue;

            float[] seg = Arrays.copyOfRange(samples, tStart, tEnd);
            int fi = Math.min(seg.length, (int) Math.round((clip.getFadeInMs() / 1000.0) * sr));
            int fo = Math.min(seg.length, (int) Math.round((clip.getFadeOutMs() / 1000.0) * sr));
            for (int i = 0; i < fi; i++) seg[i] *= (float) i / Math.max(1, fi);
            for (int i = 0; i < fo; i++) seg[seg.length - 1 - i] *= (float) i / Math.max(1, fo);

            double startSec = (clip.getStartBar() - 1.0) * secPerBar + (clip.getOffsetMs() / 1000.0);
            int startIdx = (int) Math.round(startSec * sr);
            int segOffset = 0;
            if (startIdx < 0) {
                segOffset = -startIdx;
                startIdx = 0;
            }
            if (startIdx >= totalSamples || segOffset >= seg.length) continue;
            int copyLen = Math.min(totalSamples - startIdx, seg.length - segOffset);
            for (int i = 0; i < copyLen; i++) {
                buf[startIdx + i] += seg[segOffset + i];
            }
        }
        return buf;
    }

    private String resolvePreferredAudioRef(ProjectState project, String mode) {
        var assets = project.getAudioAssets();
        if (assets == null) return null;
        String norm = normalizePreviewMode(mode);
        boolean autotuneEnabled = project.getAutotuneSettings() == null || project.getAutotuneSettings().isEnabled();
        if ("raw".equals(norm)) {
            if (assets.getRawInputRef() != null) return assets.getRawInputRef();
            if (assets.getDryDenoisedRef() != null) return assets.getDryDenoisedRef();
            return autotuneEnabled ? assets.getTunedVocalRef() : null;
        }
        if ("dry".equals(norm) || "dry_beat".equals(norm)) {
            return assets.getDryDenoisedRef() != null ? assets.getDryDenoisedRef() : assets.getRawInputRef();
        }
        if (autotuneEnabled && assets.getTunedVocalRef() != null) return assets.getTunedVocalRef();
        if (assets.getDryDenoisedRef() != null) return assets.getDryDenoisedRef();
        return assets.getRawInputRef();
    }

    private byte[] resolveClipBytes(String src, ProjectState project, ProjectStateStore store, String mode) {
        String norm = normalizePreviewMode(mode);
        boolean isStandardVocalSrc = src == null || src.isBlank()
                || "raw_input_ref".equals(src)
                || "dry_denoised_ref".equals(src)
                || "tuned_vocal_ref".equals(src);
        if (isStandardVocalSrc) {
            String pref = resolvePreferredAudioRef(project, norm);
            if (pref != null) {
                Optional<byte[]> b = store.getAudioBytes(pref);
                if (b.isPresent()) return b.get();
            }
        }
        var assets = project.getAudioAssets();
        if (assets != null) {
            if ("dry_denoised_ref".equals(src) && assets.getDryDenoisedRef() != null) {
                return store.getAudioBytes(assets.getDryDenoisedRef()).orElse(null);
            }
            if ("tuned_vocal_ref".equals(src) && assets.getTunedVocalRef() != null) {
                return store.getAudioBytes(assets.getTunedVocalRef()).orElse(null);
            }
            if ("raw_input_ref".equals(src) && assets.getRawInputRef() != null) {
                return store.getAudioBytes(assets.getRawInputRef()).orElse(null);
            }
        }
        if (src == null || src.isBlank()) return null;
        return store.getAudioBytes(src).orElse(null);
    }

    private float[] synthesizeMidiTrack(String trackName, List<MidiNote> notes, double bpm, int totalSamples, int sr) {
        float[] buf = new float[totalSamples];
        if (notes == null || notes.isEmpty()) return buf;
        double secPerBeat = 60.0 / Math.max(bpm, 1.0);
        boolean isDrums = "drums".equalsIgnoreCase(trackName);

        for (MidiNote note : notes) {
            int startIdx = (int) Math.round(note.getStartBeat() * secPerBeat * sr);
            if (startIdx < 0 || startIdx >= totalSamples) continue;
            int durSamples = Math.max(64, (int) Math.round(note.getDuration() * secPerBeat * sr));
            float vel = Math.max(0.05f, Math.min(1.0f, note.getVelocity() / 127.0f));
            float[] voice = isDrums
                    ? synthesizeDrumHit(note.getPitch(), Math.max(durSamples, (int) (0.25 * sr)), sr, vel)
                    : synthesizeTonalNote(note.getPitch(), durSamples, sr, vel, trackName);
            int endIdx = Math.min(totalSamples, startIdx + voice.length);
            for (int i = startIdx; i < endIdx; i++) {
                buf[i] += voice[i - startIdx];
            }
        }
        return buf;
    }

    private float[] synthesizeDrumHit(int pitch, int durSamples, int sr, float velocity) {
        int n = Math.max(1, Math.min(durSamples, (int) (0.45 * sr)));
        float[] hit = new float[n];
        Random rng = new Random(pitch);
        if (pitch == 35 || pitch == 36) {
            double phase = 0.0;
            for (int i = 0; i < n; i++) {
                double t = (double) i / sr;
                double freq = 135.0 * Math.exp(-26.0 * t) + 45.0;
                phase += 2.0 * Math.PI * freq / sr;
                hit[i] = (float) (Math.sin(phase) * Math.exp(-12.0 * t) * 0.9 * velocity);
            }
        } else if (pitch == 38 || pitch == 40 || pitch == 39) {
            for (int i = 0; i < n; i++) {
                double t = (double) i / sr;
                double body = Math.sin(2.0 * Math.PI * 185.0 * t) * Math.exp(-22.0 * t) * 0.4;
                double noise = rng.nextGaussian() * Math.exp(-16.0 * t) * 0.5;
                hit[i] = (float) ((body + noise) * velocity);
            }
        } else {
            double decay = (pitch == 42 || pitch == 44) ? 28.0 : 10.0;
            double prev = 0.0;
            for (int i = 0; i < n; i++) {
                double t = (double) i / sr;
                double noise = rng.nextGaussian();
                double hp = noise - prev;
                prev = noise;
                hit[i] = (float) (hp * Math.exp(-decay * t) * 0.35 * velocity);
            }
        }
        return hit;
    }

    private float[] synthesizeTonalNote(int pitch, int durSamples, int sr, float velocity, String trackName) {
        int n = Math.max(64, durSamples);
        float[] out = new float[n];
        double freq = 440.0 * Math.pow(2.0, (pitch - 69) / 12.0);
        double attackS = "bass".equals(trackName) ? 0.008 : ("lead".equals(trackName) ? 0.015 : 0.01);
        double releaseS = Math.min("bass".equals(trackName) ? 0.08 : 0.15, (double) n / sr * 0.35);
        int aLen = Math.min(n, Math.max(1, (int) (attackS * sr)));
        int rLen = Math.min(n, Math.max(1, (int) (releaseS * sr)));

        for (int i = 0; i < n; i++) {
            double t = (double) i / sr;
            double w;
            if ("bass".equals(trackName)) {
                w = 0.75 * Math.sin(2.0 * Math.PI * freq * t) + 0.25 * Math.sin(4.0 * Math.PI * freq * t);
            } else if ("lead".equals(trackName)) {
                w = 0.60 * Math.sin(2.0 * Math.PI * freq * t)
                        + 0.25 * Math.sin(4.0 * Math.PI * freq * t)
                        + 0.15 * Math.sin(6.0 * Math.PI * freq * t);
            } else {
                w = (0.65 * Math.sin(2.0 * Math.PI * freq * t)
                        + 0.22 * Math.sin(4.0 * Math.PI * freq * t)
                        + 0.13 * Math.sin(8.0 * Math.PI * freq * t)) * Math.exp(-1.5 * t);
            }
            double env = 1.0;
            if (i < aLen) env *= (double) i / aLen;
            if (i >= n - rLen) env *= (double) (n - 1 - i) / Math.max(1, rLen);
            out[i] = (float) (w * env * velocity * 0.35);
        }
        return out;
    }

    private float[][] panStereo(float[] mono, double pan, double volume) {
        double p = Math.max(-1.0, Math.min(1.0, pan));
        double angle = (p + 1.0) * (Math.PI / 4.0);
        float lg = (float) (Math.cos(angle) * volume);
        float rg = (float) (Math.sin(angle) * volume);
        float[][] stereo = new float[mono.length][2];
        for (int i = 0; i < mono.length; i++) {
            stereo[i][0] = mono[i] * lg;
            stereo[i][1] = mono[i] * rg;
        }
        return stereo;
    }

    private float[] applyTrackEq(float[] mono, TrackState track, int sr) {
        double lowDb = track.getLowDb();
        double midDb = track.getMidDb();
        double highDb = track.getHighDb();
        if (Math.abs(lowDb) < 0.05 && Math.abs(midDb) < 0.05 && Math.abs(highDb) < 0.05) {
            return mono;
        }
        float[] out = Arrays.copyOf(mono, mono.length);
        if (Math.abs(lowDb) >= 0.05) {
            out = applyRbjBiquad(out, "lowshelf", 110.0, sr, lowDb, 0.70710678);
        }
        if (Math.abs(midDb) >= 0.05) {
            out = applyRbjBiquad(out, "peaking", 1000.0, sr, midDb, 0.9);
        }
        if (Math.abs(highDb) >= 0.05) {
            out = applyRbjBiquad(out, "highshelf", 6500.0, sr, highDb, 0.70710678);
        }
        return out;
    }

    private float[] applyRbjBiquad(float[] samples, String kind, double f0, int sr, double dbGain, double q) {
        if (samples.length == 0 || f0 <= 0.0 || f0 >= 0.49 * sr || Math.abs(dbGain) < 0.05) {
            return samples;
        }
        double aLin = Math.pow(10.0, dbGain / 40.0);
        double w0 = 2.0 * Math.PI * f0 / sr;
        double cosW = Math.cos(w0);
        double sinW = Math.sin(w0);
        double b0, b1, b2, a0, a1, a2;

        if ("peaking".equals(kind)) {
            double alpha = sinW / (2.0 * Math.max(0.1, q));
            b0 = 1.0 + alpha * aLin;
            b1 = -2.0 * cosW;
            b2 = 1.0 - alpha * aLin;
            a0 = 1.0 + alpha / aLin;
            a1 = -2.0 * cosW;
            a2 = 1.0 - alpha / aLin;
        } else if ("lowshelf".equals(kind)) {
            double alpha = sinW / Math.sqrt(2.0);
            double twoSqrtAAlpha = 2.0 * Math.sqrt(aLin) * alpha;
            b0 = aLin * ((aLin + 1.0) - (aLin - 1.0) * cosW + twoSqrtAAlpha);
            b1 = 2.0 * aLin * ((aLin - 1.0) - (aLin + 1.0) * cosW);
            b2 = aLin * ((aLin + 1.0) - (aLin - 1.0) * cosW - twoSqrtAAlpha);
            a0 = (aLin + 1.0) + (aLin - 1.0) * cosW + twoSqrtAAlpha;
            a1 = -2.0 * ((aLin - 1.0) + (aLin + 1.0) * cosW);
            a2 = (aLin + 1.0) + (aLin - 1.0) * cosW - twoSqrtAAlpha;
        } else {
            double alpha = sinW / Math.sqrt(2.0);
            double twoSqrtAAlpha = 2.0 * Math.sqrt(aLin) * alpha;
            b0 = aLin * ((aLin + 1.0) + (aLin - 1.0) * cosW + twoSqrtAAlpha);
            b1 = -2.0 * aLin * ((aLin - 1.0) + (aLin + 1.0) * cosW);
            b2 = aLin * ((aLin + 1.0) + (aLin - 1.0) * cosW - twoSqrtAAlpha);
            a0 = (aLin + 1.0) - (aLin - 1.0) * cosW + twoSqrtAAlpha;
            a1 = 2.0 * ((aLin - 1.0) - (aLin + 1.0) * cosW);
            a2 = (aLin + 1.0) - (aLin - 1.0) * cosW - twoSqrtAAlpha;
        }

        double invA0 = 1.0 / (Math.abs(a0) > 1e-12 ? a0 : 1e-12);
        double nb0 = b0 * invA0;
        double nb1 = b1 * invA0;
        double nb2 = b2 * invA0;
        double na1 = a1 * invA0;
        double na2 = a2 * invA0;

        float[] out = new float[samples.length];
        double z1 = 0.0;
        double z2 = 0.0;
        for (int i = 0; i < samples.length; i++) {
            double x = samples[i];
            double y = nb0 * x + z1;
            z1 = nb1 * x - na1 * y + z2;
            z2 = nb2 * x - na2 * y;
            out[i] = (float) y;
        }
        return out;
    }

    private void addStereoInPlace(float[][] dst, float[][] src) {
        int n = Math.min(dst.length, src.length);
        for (int i = 0; i < n; i++) {
            dst[i][0] += src[i][0];
            dst[i][1] += src[i][1];
        }
    }

    private float[][] renderStereoReverb(float[][] sendStereo, int sr) {
        int n = sendStereo.length;
        float[][] out = new float[n][2];
        if (n == 0) return out;

        int preDelay = Math.max(0, (int) Math.round(0.018 * sr));
        int[] baseCombs = {1116, 1188, 1277, 1356};
        double scale = sr / 44100.0;
        double feedback = 0.78;
        double damp = 0.42;

        for (int ch = 0; ch < 2; ch++) {
            int offsetStereo = ch == 1 ? 23 : 0;
            double[] sum = new double[n];
            for (int baseLen : baseCombs) {
                int delayLen = Math.max(32, (int) Math.round((baseLen + offsetStereo) * scale));
                double[] buf = new double[delayLen];
                int idx = 0;
                double filterStore = 0.0;
                for (int i = 0; i < n; i++) {
                    double input = i >= preDelay ? sendStereo[i - preDelay][ch] : 0.0;
                    double delayed = buf[idx];
                    filterStore = delayed * (1.0 - damp) + filterStore * damp;
                    buf[idx] = input + filterStore * feedback;
                    sum[i] += delayed;
                    idx = (idx + 1) % delayLen;
                }
            }
            for (int i = 0; i < n; i++) {
                out[i][ch] = (float) (sum[i] * 0.16);
            }
        }
        return out;
    }

    private float[][] renderStereoDelay(float[][] sendStereo, double bpm, int sr) {
        int n = sendStereo.length;
        float[][] out = new float[n][2];
        if (n == 0) return out;

        double delaySec = Math.max(0.12, Math.min(0.75, 0.75 * (60.0 / Math.max(bpm, 40.0))));
        int step = Math.max(1, (int) Math.round(delaySec * sr));

        // 1-pole lowpass damping (~3.4 kHz warmth)
        float[][] filtered = new float[n][2];
        double lpL = 0.0;
        double lpR = 0.0;
        for (int i = 0; i < n; i++) {
            lpL = 0.38 * sendStereo[i][0] + 0.62 * lpL;
            lpR = 0.38 * sendStereo[i][1] + 0.62 * lpR;
            filtered[i][0] = (float) lpL;
            filtered[i][1] = (float) lpR;
        }

        float gain = 0.44f;
        for (int tap = 1; tap <= 5; tap++) {
            int offset = tap * step;
            if (offset >= n) break;
            boolean cross = (tap % 2) == 1;
            float gL = cross ? gain * 0.85f : gain;
            float gR = cross ? gain : gain * 0.85f;
            for (int i = offset; i < n; i++) {
                int sIdx = i - offset;
                out[i][0] += filtered[sIdx][cross ? 1 : 0] * gL;
                out[i][1] += filtered[sIdx][cross ? 0 : 1] * gR;
            }
            gain *= 0.48f;
        }
        return out;
    }

    // --- Exporters (Stems ZIP, MP3, MIDI, .aimusic) ---

    public byte[] exportStemsZip(Map<String, float[][]> stems, int sampleRate) {
        if (stems == null || stems.isEmpty()) {
            throw new IllegalArgumentException("No stems available for export.");
        }
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(baos)) {
            for (Map.Entry<String, float[][]> entry : stems.entrySet()) {
                ZipEntry ze = new ZipEntry("stems/" + entry.getKey() + ".wav");
                zos.putNextEntry(ze);
                zos.write(encodeWavStereo(entry.getValue(), sampleRate));
                zos.closeEntry();
            }
        } catch (IOException ex) {
            throw new IllegalStateException("Failed to build stems ZIP", ex);
        }
        return baos.toByteArray();
    }

    public byte[] exportMp3ViaFfmpeg(float[][] stereo, int sampleRate) {
        return exportMp3ViaFfmpeg(stereo, sampleRate, "320k", null, null, null);
    }

    public byte[] exportMp3ViaFfmpeg(float[][] stereo, int sampleRate, String bitrate) {
        return exportMp3ViaFfmpeg(stereo, sampleRate, bitrate, null, null, null);
    }

    public byte[] exportMp3ViaFfmpeg(float[][] stereo, int sampleRate, String bitrate,
                                      String title, String artist, String genre) {
        String normBitrate = (bitrate != null && bitrate.trim().startsWith("192")) ? "192k" : "320k";
        List<String> cmd = new ArrayList<>(List.of(
                "ffmpeg", "-y", "-f", "wav", "-i", "pipe:0",
                "-codec:a", "libmp3lame", "-b:a", normBitrate
        ));
        appendFfmpegMetadataArgs(cmd, title, artist, genre);
        cmd.addAll(List.of("-f", "mp3", "pipe:1"));
        return runFfmpegPipe(encodeWavStereo(stereo, sampleRate), cmd,
                "MP3 export requires audio-worker or ffmpeg to be available.");
    }

    public byte[] exportFlacViaFfmpeg(float[][] stereo, int sampleRate,
                                       String title, String artist, String genre) {
        List<String> cmd = new ArrayList<>(List.of(
                "ffmpeg", "-y", "-f", "wav", "-i", "pipe:0",
                "-codec:a", "flac"
        ));
        appendFfmpegMetadataArgs(cmd, title, artist, genre);
        cmd.addAll(List.of("-f", "flac", "pipe:1"));
        return runFfmpegPipe(encodeWavStereo(stereo, sampleRate), cmd,
                "FLAC export requires audio-worker or ffmpeg to be available.");
    }

    private static void appendFfmpegMetadataArgs(List<String> cmd, String title, String artist, String genre) {
        if (title != null && !title.isBlank()) {
            cmd.add("-metadata");
            cmd.add("title=" + title.trim());
        }
        if (artist != null && !artist.isBlank()) {
            cmd.add("-metadata");
            cmd.add("artist=" + artist.trim());
        }
        if (genre != null && !genre.isBlank()) {
            cmd.add("-metadata");
            cmd.add("genre=" + genre.trim());
        }
    }

    private byte[] runFfmpegPipe(byte[] wavInput, List<String> command, String unavailableMessage) {
        Process p = null;
        Thread timeoutWatcher = null;
        try {
            p = new ProcessBuilder(command)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start();
            final Process proc = p;
            timeoutWatcher = Thread.ofVirtual().start(() -> {
                try {
                    if (!proc.waitFor(20, TimeUnit.SECONDS)) {
                        proc.destroyForcibly();
                    }
                } catch (InterruptedException ignored) {
                }
            });
            p.getOutputStream().write(wavInput);
            p.getOutputStream().close();
            byte[] encoded = p.getInputStream().readAllBytes();
            boolean finished = p.waitFor(5, TimeUnit.SECONDS);
            int code = finished ? p.exitValue() : -1;
            if (finished && code == 0 && encoded.length > 0) {
                return encoded;
            }
        } catch (Exception ignored) {
        } finally {
            if (timeoutWatcher != null) timeoutWatcher.interrupt();
            if (p != null && p.isAlive()) p.destroyForcibly();
        }
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, unavailableMessage);
    }

    public byte[] exportMidi(ProjectState project) {
        try {
            int ppq = 480;
            Sequence seq = new Sequence(Sequence.PPQ, ppq);
            double bpm = project.getAnalysis() != null && project.getAnalysis().getBpm() > 0
                    ? project.getAnalysis().getBpm() : 120.0;
            int tempoUs = Math.max(1, (int) Math.round(60_000_000.0 / bpm));
            int[] ts = MusicTheory.parseTimeSignature(
                    project.getAnalysis() != null ? project.getAnalysis().getTimeSignature() : "4/4");

            // Track 0: Meta Events (Track Name, Set Tempo, Time Signature, Key Signature)
            Track metaTrack = seq.createTrack();
            metaTrack.add(metaTextEvent(0x03, "Tempo & Meta", 0));

            MetaMessage tempoMsg = new MetaMessage();
            byte[] tempoData = new byte[]{
                    (byte) ((tempoUs >> 16) & 0xFF),
                    (byte) ((tempoUs >> 8) & 0xFF),
                    (byte) (tempoUs & 0xFF)
            };
            tempoMsg.setMessage(0x51, tempoData, 3);
            metaTrack.add(new MidiEvent(tempoMsg, 0));

            int denLog2 = Math.max(0, (int) Math.round(Math.log(ts[1]) / Math.log(2)));
            MetaMessage tsMsg = new MetaMessage();
            tsMsg.setMessage(0x58, new byte[]{(byte) ts[0], (byte) denLog2, 24, 8}, 4);
            metaTrack.add(new MidiEvent(tsMsg, 0));

            String detKey = project.getAnalysis() != null ? project.getAnalysis().getDetectedKey() : "C";
            String detScale = project.getAnalysis() != null ? project.getAnalysis().getDetectedScale() : "major";
            byte[] ksData = keySignatureBytes(detKey, detScale);
            MetaMessage ksMsg = new MetaMessage();
            ksMsg.setMessage(0x59, ksData, 2);
            metaTrack.add(new MidiEvent(ksMsg, 0));

            Map<String, Integer> channelMap = Map.of("drums", 9, "bass", 1, "harmony", 2, "lead", 3);
            if (project.getTracks() != null) {
                for (Map.Entry<String, TrackState> entry : project.getTracks().entrySet()) {
                    String trackName = entry.getKey();
                    TrackState t = entry.getValue();
                    boolean isVocal = "vocal".equalsIgnoreCase(trackName);
                    if (!"midi".equalsIgnoreCase(t.getType()) && !isVocal) continue;

                    List<MidiNote> notes = "midi".equalsIgnoreCase(t.getType())
                            ? t.getNotes()
                            : (project.getAnalysis() != null ? project.getAnalysis().getRawMelodyMidi() : List.of());
                    if (notes == null || notes.isEmpty()) continue;

                    int ch = channelMap.getOrDefault(trackName.toLowerCase(Locale.ROOT), 0);
                    Track midiTrack = seq.createTrack();
                    midiTrack.add(metaTextEvent(0x03, trackName, 0));
                    int program = resolveMidiProgram(trackName, t.getInstrument());
                    midiTrack.add(new MidiEvent(new ShortMessage(ShortMessage.PROGRAM_CHANGE, ch, program, 0), 0));

                    for (MidiNote n : notes) {
                        long startTick = Math.max(0L, Math.round(n.getStartBeat() * ppq));
                        long durTick = Math.max(1L, Math.round(n.getDuration() * ppq));
                        int pitch = Math.max(0, Math.min(127, n.getPitch()));
                        int vel = Math.max(1, Math.min(127, n.getVelocity()));
                        ShortMessage on = new ShortMessage(ShortMessage.NOTE_ON, ch, pitch, vel);
                        ShortMessage off = new ShortMessage(ShortMessage.NOTE_OFF, ch, pitch, 0);
                        midiTrack.add(new MidiEvent(on, startTick));
                        midiTrack.add(new MidiEvent(off, startTick + durTick));
                    }
                }
            }

            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            MidiSystem.write(seq, 1, baos);
            return baos.toByteArray();
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to export MIDI", ex);
        }
    }

    private static final Map<String, Integer> MIDI_INSTRUMENT_PROGRAMS = Map.ofEntries(
            Map.entry("grand_piano", 0),
            Map.entry("electric_piano", 4),
            Map.entry("rhodes_ep", 4),
            Map.entry("acoustic_guitar", 24),
            Map.entry("muted_guitar", 28),
            Map.entry("overdrive_guitar", 29),
            Map.entry("lead_guitar", 30),
            Map.entry("upright_bass", 32),
            Map.entry("finger_bass", 33),
            Map.entry("pick_bass", 34),
            Map.entry("fretless_bass", 35),
            Map.entry("synth_bass", 38),
            Map.entry("808_bass", 38),
            Map.entry("warm_sub_bass", 38),
            Map.entry("saw_bass", 39),
            Map.entry("strings", 48),
            Map.entry("string_ensemble", 48),
            Map.entry("vocal", 53),
            Map.entry("flute", 73),
            Map.entry("synth_lead", 80),
            Map.entry("lead_synth", 80),
            Map.entry("bright_lead", 80),
            Map.entry("pluck_synth", 81),
            Map.entry("synth_pad", 88),
            Map.entry("dark_pad", 88),
            Map.entry("supersaw_pad", 88),
            Map.entry("warm_pad", 89),
            Map.entry("acoustic_kit", 0),
            Map.entry("rock_kit", 0),
            Map.entry("brush_kit", 0),
            Map.entry("cajon_kit", 0),
            Map.entry("lofi_kit", 0),
            Map.entry("rnb_kit", 0),
            Map.entry("electronic_808", 25),
            Map.entry("808_kit", 25),
            Map.entry("electronic_kit", 25)
    );

    private int resolveMidiProgram(String trackName, String instrument) {
        if (instrument != null && !instrument.isBlank()) {
            Integer mapped = MIDI_INSTRUMENT_PROGRAMS.get(instrument.trim().toLowerCase(Locale.ROOT));
            if (mapped != null) return mapped;
        }
        String t = trackName != null ? trackName.trim().toLowerCase(Locale.ROOT) : "";
        return switch (t) {
            case "bass" -> 33;
            case "lead" -> 4;
            case "vocal" -> 53;
            default -> 0;
        };
    }

    private MidiEvent metaTextEvent(int type, String text, long tick) throws Exception {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        MetaMessage msg = new MetaMessage();
        msg.setMessage(type, bytes, bytes.length);
        return new MidiEvent(msg, tick);
    }

    private byte[] keySignatureBytes(String key, String scale) {
        boolean minor = scale != null && scale.toLowerCase(Locale.ROOT).contains("minor");
        int pc = MusicTheory.parseKeyRoot(key);
        // Map pitch class to circle-of-fifths sf (-5..+6)
        int[] majorSf = {0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5};
        int[] minorSf = {-3, 4, -1, 6, 1, -4, 3, -2, 5, 0, -5, 2};
        byte sf = (byte) (minor ? minorSf[pc] : majorSf[pc]);
        return new byte[]{sf, (byte) (minor ? 1 : 0)};
    }

    private static final int MAX_AIMUSIC_ENTRIES = 64;
    private static final int MAX_AIMUSIC_ENTRY_BYTES = 60 * 1024 * 1024;
    private static final long MAX_AIMUSIC_TOTAL_BYTES = 120L * 1024L * 1024L;

    public byte[] exportAimusicBundle(ProjectState project, ProjectStateStore store) {
        try {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            Map<String, String> manifest = new LinkedHashMap<>();
            manifest.put("schema_version", "1.0");
            manifest.put("app", "ai-music-studio");
            manifest.put("created_at", Instant.now().toString());

            var assets = project.getAudioAssets();
            byte[] rawBytes = assets != null && assets.getRawInputRef() != null
                    ? store.getAudioBytes(assets.getRawInputRef()).orElse(null) : null;
            byte[] dryBytes = assets != null && assets.getDryDenoisedRef() != null
                    ? store.getAudioBytes(assets.getDryDenoisedRef()).orElse(null) : null;
            boolean drySameAsRaw = rawBytes != null && dryBytes != null && Arrays.equals(rawBytes, dryBytes);
            if (drySameAsRaw) {
                manifest.put("dry_same_as_raw", "true");
            }
            boolean hasBaseVocal = rawBytes != null || dryBytes != null;

            try (ZipOutputStream zos = new ZipOutputStream(baos)) {
                zos.putNextEntry(new ZipEntry("manifest.json"));
                zos.write(objectMapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(manifest));
                zos.closeEntry();

                zos.putNextEntry(new ZipEntry("project.json"));
                zos.write(objectMapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(project));
                zos.closeEntry();

                if (rawBytes != null) {
                    writeBytesEntry(zos, "audio/raw_input.wav", rawBytes);
                }
                if (dryBytes != null && !drySameAsRaw) {
                    writeBytesEntry(zos, "audio/dry_denoised.wav", dryBytes);
                }
                // Omit regenerable vocal_autotuned.wav when dry/raw vocal + autotune_settings exist
                if (!hasBaseVocal && assets != null && assets.getTunedVocalRef() != null) {
                    writeBundleAsset(zos, store, "audio/vocal_autotuned.wav", assets.getTunedVocalRef());
                }

                Map<String, String> customClipPaths = new LinkedHashMap<>();
                if (project.getTracks() != null) {
                    int idx = 0;
                    for (TrackState t : project.getTracks().values()) {
                        if (t == null || t.getClips() == null) continue;
                        for (AudioClip clip : t.getClips()) {
                            if (clip == null || clip.getSource() == null || clip.getSource().isBlank()) continue;
                            String src = clip.getSource();
                            if ("raw_input_ref".equals(src) || "dry_denoised_ref".equals(src) || "tuned_vocal_ref".equals(src)
                                    || (assets != null && (src.equals(assets.getRawInputRef())
                                    || src.equals(assets.getDryDenoisedRef())
                                    || src.equals(assets.getTunedVocalRef())))) {
                                continue;
                            }
                            if (!customClipPaths.containsKey(src)) {
                                Optional<byte[]> clipBytes = store.getAudioBytes(src);
                                if (clipBytes.isPresent()) {
                                    String arcPath = "audio/clips/clip_" + (++idx) + ".wav";
                                    writeBytesEntry(zos, arcPath, clipBytes.get());
                                    customClipPaths.put(src, arcPath);
                                }
                            }
                        }
                    }
                }
                if (!customClipPaths.isEmpty()) {
                    zos.putNextEntry(new ZipEntry("clip_refs.json"));
                    zos.write(objectMapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(customClipPaths));
                    zos.closeEntry();
                }
            }
            return baos.toByteArray();
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to create .aimusic bundle", ex);
        }
    }

    private void writeBytesEntry(ZipOutputStream zos, String arcPath, byte[] bytes) throws IOException {
        zos.putNextEntry(new ZipEntry(arcPath));
        zos.write(bytes);
        zos.closeEntry();
    }

    private void writeBundleAsset(ZipOutputStream zos, ProjectStateStore store, String arcPath, String ref) throws IOException {
        if (ref == null || ref.isBlank()) return;
        Optional<byte[]> bytes = store.getAudioBytes(ref);
        if (bytes.isPresent()) {
            writeBytesEntry(zos, arcPath, bytes.get());
        }
    }

    public ProjectState importAimusicBundle(byte[] bundleBytes, ProjectStateStore store) {
        return importAimusicBundle(bundleBytes, store, true);
    }

    public ProjectState importAimusicBundle(byte[] bundleBytes, ProjectStateStore store, boolean overwrite) {
        if (bundleBytes == null || bundleBytes.length == 0) {
            throw new AudioValidationException("Invalid .aimusic archive: empty file", HttpStatus.BAD_REQUEST);
        }
        Map<String, byte[]> entries = new HashMap<>();
        long totalUnzipped = 0L;
        int entryCount = 0;
        try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(bundleBytes))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                String name = entry.getName();
                if (!isSafeZipEntryName(name)) {
                    throw new AudioValidationException("Unsafe archive entry path.", HttpStatus.BAD_REQUEST);
                }
                if (++entryCount > MAX_AIMUSIC_ENTRIES) {
                    throw new AudioValidationException("Archive exceeds maximum allowed file entries.", HttpStatus.BAD_REQUEST);
                }
                if (!entry.isDirectory()) {
                    long remainingBudget = MAX_AIMUSIC_TOTAL_BYTES - totalUnzipped;
                    int maxForEntry = (int) Math.min(MAX_AIMUSIC_ENTRY_BYTES, Math.max(0L, remainingBudget));
                    byte[] data = readZipEntryBounded(zis, maxForEntry);
                    totalUnzipped += data.length;
                    entries.put(name, data);
                }
                zis.closeEntry();
            }
        } catch (AudioValidationException ex) {
            throw ex;
        } catch (IOException ex) {
            throw new AudioValidationException("Invalid .aimusic archive: " + ex.getMessage(), HttpStatus.BAD_REQUEST);
        }

        byte[] projectJson = entries.get("project.json");
        if (projectJson == null) {
            throw new AudioValidationException("Invalid .aimusic archive: missing project.json", HttpStatus.BAD_REQUEST);
        }

        try {
            ProjectState project = objectMapper.readValue(projectJson, ProjectState.class);
            String origPid = sanitizeProjectId(project.getProjectId());
            String pid = origPid;
            if (!overwrite && store.getProject(pid).isPresent()) {
                String suffix = java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 6);
                pid = origPid + "_imp_" + suffix;
                String baseTitle = project.getTitle();
                if (baseTitle != null && !baseTitle.isBlank() && !baseTitle.endsWith("(Imported)")) {
                    String importedTitle = baseTitle + " (Imported)";
                    project.setTitle(importedTitle);
                    if (project.getConfig() != null) {
                        project.getConfig().setTitle(importedTitle);
                    }
                }
            }
            project.setProjectId(pid);

            boolean drySameAsRaw = false;
            if (entries.containsKey("manifest.json")) {
                try {
                    Map<String, Object> manifest = objectMapper.readValue(
                            entries.get("manifest.json"), new TypeReference<Map<String, Object>>() {});
                    drySameAsRaw = "true".equalsIgnoreCase(String.valueOf(manifest.get("dry_same_as_raw")));
                } catch (Exception ignored) {
                }
            }

            byte[] rawAudio = entries.get("audio/raw_input.wav");
            if (rawAudio != null) {
                String ref = "mem://raw/" + pid + ".wav";
                store.saveAudioBytes(ref, rawAudio);
                project.getAudioAssets().setRawInputRef(ref);
            }
            byte[] dryAudio = entries.get("audio/dry_denoised.wav");
            if (dryAudio != null) {
                String ref = "mem://processed/" + pid + "_dry.wav";
                store.saveAudioBytes(ref, dryAudio);
                project.getAudioAssets().setDryDenoisedRef(ref);
            } else if (drySameAsRaw && rawAudio != null) {
                String ref = "mem://processed/" + pid + "_dry.wav";
                store.saveAudioBytes(ref, rawAudio);
                project.getAudioAssets().setDryDenoisedRef(ref);
            }

            byte[] baseForAutotune = dryAudio != null ? dryAudio : (drySameAsRaw ? rawAudio : null);
            if (entries.containsKey("audio/vocal_autotuned.wav")) {
                String ref = "mem://processed/" + pid + "_tuned.wav";
                store.saveAudioBytes(ref, entries.get("audio/vocal_autotuned.wav"));
                project.getAudioAssets().setTunedVocalRef(ref);
            } else if (baseForAutotune != null && project.getAutotuneSettings() != null
                    && project.getAutotuneSettings().isEnabled()
                    && project.getAutotuneSettings().getMixPercent() > 0.0) {
                try {
                    byte[] resynth = applyAutotune(baseForAutotune, project.getAutotuneSettings());
                    String ref = "mem://processed/" + pid + "_tuned.wav";
                    store.saveAudioBytes(ref, resynth);
                    project.getAudioAssets().setTunedVocalRef(ref);
                } catch (Exception ignored) {
                }
            }

            if (entries.containsKey("clip_refs.json")) {
                Map<String, String> customClipPaths = objectMapper.readValue(
                        entries.get("clip_refs.json"),
                        new TypeReference<Map<String, String>>() {}
                );
                Map<String, String> remappedRefs = new HashMap<>();
                for (Map.Entry<String, String> e : customClipPaths.entrySet()) {
                    String clipRef = e.getKey();
                    String arcPath = e.getValue();
                    if (!isSafeClipRef(clipRef) || arcPath == null || !arcPath.startsWith("audio/clips/")) {
                        continue;
                    }
                    byte[] clipData = entries.get(arcPath);
                    if (clipData != null) {
                        String targetRef = (!pid.equals(origPid) && clipRef.contains("/" + origPid + "/"))
                                ? clipRef.replace("/" + origPid + "/", "/" + pid + "/")
                                : (!pid.equals(origPid) ? "mem://clips/" + pid + "/" + Integer.toUnsignedString(clipRef.hashCode()) + ".wav" : clipRef);
                        store.saveAudioBytes(targetRef, clipData);
                        if (!targetRef.equals(clipRef)) {
                            remappedRefs.put(clipRef, targetRef);
                        }
                    }
                }
                if (!remappedRefs.isEmpty() && project.getTracks() != null) {
                    for (TrackState t : project.getTracks().values()) {
                        if (t == null || t.getClips() == null) continue;
                        for (AudioClip clip : t.getClips()) {
                            if (clip != null && remappedRefs.containsKey(clip.getSource())) {
                                clip.setSource(remappedRefs.get(clip.getSource()));
                            }
                        }
                    }
                }
            }
            return store.saveProject(project);
        } catch (IOException ex) {
            throw new AudioValidationException("Invalid project.json in .aimusic archive: " + ex.getMessage(), HttpStatus.BAD_REQUEST);
        }
    }

    private static boolean isSafeZipEntryName(String name) {
        if (name == null || name.isBlank() || name.indexOf('\0') >= 0) return false;
        if (name.startsWith("/") || name.startsWith("\\") || name.contains("..")) return false;
        return name.length() <= 256;
    }

    private static boolean isSafeClipRef(String ref) {
        return ref != null && !ref.isBlank() && ref.length() <= 256
                && ref.startsWith("mem://") && !ref.contains("..")
                && ref.matches("^mem://[a-z]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$");
    }

    private static String sanitizeProjectId(String rawId) {
        if (rawId == null || rawId.isBlank()) {
            return "proj_imported_" + System.currentTimeMillis();
        }
        String cleaned = rawId.replaceAll("[^A-Za-z0-9_-]", "_");
        return cleaned.isBlank() ? "proj_imported_" + System.currentTimeMillis() : cleaned;
    }

    private static byte[] readZipEntryBounded(ZipInputStream zis, int maxBytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int total = 0;
        int read;
        while ((read = zis.read(buf)) != -1) {
            total += read;
            if (total > maxBytes) {
                throw new AudioValidationException(
                        "Decompressed .aimusic archive exceeds safe memory limit.",
                        HttpStatus.PAYLOAD_TOO_LARGE);
            }
            out.write(buf, 0, read);
        }
        return out.toByteArray();
    }

    // --- Overdub Fit Check ---

    public OverdubFitCheckResponse overdubFitCheck(byte[] audioBytes, double bpm, String key, String scale) {
        double peakNorm = 0.25;
        double rmsNorm = 0.08;
        double onsetSec = 0.02;
        List<MidiNote> notes = List.of();

        try {
            DecodedWav decoded = decodeWavBytes(audioBytes);
            float[] samples = decoded.mono();
            int sr = decoded.sampleRate();
            float maxAbs = 0.0f;
            double sumSq = 0.0;
            for (float s : samples) {
                float a = Math.abs(s);
                if (a > maxAbs) maxAbs = a;
                sumSq += s * s;
            }
            peakNorm = maxAbs;
            rmsNorm = samples.length > 0 ? Math.sqrt(sumSq / samples.length) : 0.0;
            if (maxAbs > 1e-4f) {
                float thresh = maxAbs * 0.15f;
                for (int i = 0; i < samples.length; i++) {
                    if (Math.abs(samples[i]) >= thresh) {
                        onsetSec = (double) i / sr;
                        break;
                    }
                }
            }
            AnalyzeResult analyzed = analyzeAudio(audioBytes, bpm, key, scale);
            notes = analyzed.rawMelodyMidi();
        } catch (Exception ignored) {
        }

        double peakDb = Math.round(20.0 * Math.log10(Math.max(peakNorm, 1e-6)) * 100.0) / 100.0;
        double rmsDb = Math.round(20.0 * Math.log10(Math.max(rmsNorm, 1e-6)) * 100.0) / 100.0;
        double beatSec = 60.0 / Math.max(40.0, bpm);
        double nearestBeatSec = Math.round(onsetSec / beatSec) * beatSec;
        double timingOffsetMs = Math.round((onsetSec - nearestBeatSec) * 1000.0 * 10.0) / 10.0;

        Set<Integer> scalePcs = new HashSet<>(MusicTheory.getScalePitchClasses(key, scale));
        List<PitchIssue> pitchIssues = new ArrayList<>();
        for (MidiNote n : notes) {
            int pc = Math.floorMod(n.getPitch(), 12);
            if (!scalePcs.contains(pc)) {
                int bar = (int) Math.floor(n.getStartBeat() / 4.0) + 1;
                String noteName = MusicTheory.midiToNoteName(n.getPitch());
                pitchIssues.add(new PitchIssue(bar, noteName, 50.0,
                        "Note " + noteName + " at bar " + bar + " is outside " + key + " " + scale + "."));
                if (pitchIssues.size() >= 6) break;
            }
        }

        List<OneClickFix> fixes = new ArrayList<>();
        if (Math.abs(timingOffsetMs) >= 15.0) {
            fixes.add(new OneClickFix(
                    "fix_shift_timing",
                    String.format(Locale.ROOT, "Dịch nhịp %+.0f ms cho khớp beat", -timingOffsetMs),
                    "shift_timing",
                    Math.round(-timingOffsetMs * 10.0) / 10.0
            ));
        }
        if (!pitchIssues.isEmpty()) {
            fixes.add(new OneClickFix(
                    "fix_apply_autotune",
                    "Bật Auto-Tune về " + key + " " + scale,
                    "apply_autotune",
                    "natural"
            ));
        }

        String gainSuggestion;
        if (peakDb > -1.0) {
            gainSuggestion = String.format(Locale.ROOT, "Vocal hơi lớn (peak %.1f dBFS), nên giảm -3 dB tránh clipping.", peakDb);
            fixes.add(new OneClickFix("fix_adjust_gain_down", "Giảm Gain vocal -3 dB", "adjust_gain", -3.0));
        } else if (rmsDb < -28.0) {
            gainSuggestion = String.format(Locale.ROOT, "Vocal hơi nhỏ (RMS %.1f dBFS), nên tăng +4 dB để nổi trên beat.", rmsDb);
            fixes.add(new OneClickFix("fix_adjust_gain_up", "Tăng Gain vocal +4 dB", "adjust_gain", 4.0));
        } else {
            gainSuggestion = String.format(Locale.ROOT, "Mức âm lượng cân bằng tốt (RMS %.1f dBFS, Peak %.1f dBFS).", rmsDb, peakDb);
        }

        return new OverdubFitCheckResponse(timingOffsetMs, pitchIssues, gainSuggestion, fixes);
    }

    // --- Phase 2 & 3 Studio Auto-Trim & Auto-Mix ---

    public AutoTrimAnalysis analyzeVocalTrimAndBeatOffset(byte[] wavBytes, double bpm) {
        DecodedWav decoded = decodeWavBytes(wavBytes);
        float[] samples = decoded.mono();
        int sr = decoded.sampleRate();
        double durationSec = Math.round(((double) samples.length / sr) * 1000.0) / 1000.0;

        int hop = Math.max(1, (int) (0.01 * sr));
        double hopSec = (double) hop / sr;
        int numFrames = (samples.length + hop - 1) / hop;
        double[] frameRms = new double[numFrames];
        double peakRms = 0.0;
        for (int f = 0; f < numFrames; f++) {
            int s = f * hop;
            int e = Math.min(samples.length, s + hop);
            double sumSq = 0.0;
            for (int i = s; i < e; i++) sumSq += samples[i] * samples[i];
            double rms = Math.sqrt(sumSq / Math.max(1, e - s));
            frameRms[f] = rms;
            if (rms > peakRms) peakRms = rms;
        }

        double threshold = Math.max(peakRms * 0.04, Math.pow(10.0, -45.0 / 20.0));
        int firstActive = -1;
        int lastActive = -1;
        for (int f = 0; f < numFrames; f++) {
            if (frameRms[f] >= threshold) {
                if (firstActive < 0) firstActive = f;
                lastActive = f;
            }
        }

        double leadingSilenceSec = 0.0;
        double trailingSilenceSec = 0.0;
        double trimStartSec = 0.0;
        double trimEndSec = durationSec;
        double padSec = 0.02;

        if (firstActive >= 0 && lastActive >= firstActive) {
            leadingSilenceSec = Math.round(firstActive * hopSec * 1000.0) / 1000.0;
            double activeEndSec = Math.min(durationSec, (lastActive + 1) * hopSec);
            trailingSilenceSec = Math.max(0.0, Math.round((durationSec - activeEndSec) * 1000.0) / 1000.0);

            trimStartSec = Math.max(0.0, Math.round((leadingSilenceSec - padSec) * 1000.0) / 1000.0);
            trimEndSec = Math.min(durationSec, Math.round((activeEndSec + padSec) * 1000.0) / 1000.0);
            double minKeep = Math.min(0.25, durationSec);
            if (trimEndSec - trimStartSec < minKeep) {
                trimStartSec = 0.0;
                trimEndSec = durationSec;
            }
        }

        double preRollMs = (leadingSilenceSec - trimStartSec) * 1000.0;
        double beatSec = 60.0 / Math.max(40.0, bpm);
        double nearestBeat = Math.round(leadingSilenceSec / beatSec) * beatSec;
        double beatDeltaMs = (nearestBeat - leadingSilenceSec) * 1000.0;
        double rawOffsetMs = -preRollMs + (Math.abs(beatDeltaMs) < 120.0 ? beatDeltaMs * 0.5 : 0.0);
        double offsetMs = Math.round(Math.max(-250.0, Math.min(250.0, rawOffsetMs)) * 10.0) / 10.0;

        String summary = String.format(Locale.ROOT,
                "Trimmed %.2fs leading & %.2fs trailing silence (range %.2fs-%.2fs); beat offset %+.1f ms.",
                leadingSilenceSec, trailingSilenceSec, trimStartSec, trimEndSec, offsetMs);
        return new AutoTrimAnalysis(trimStartSec, trimEndSec, offsetMs, durationSec, leadingSilenceSec, trailingSilenceSec, summary);
    }

    public AutoMixResult autoMixProject(ProjectState project, ProjectStateStore store) {
        Map<String, TrackState> tracks = project.getTracks();
        int totalBars = project.getSongStructure() != null && project.getSongStructure().getTotalBars() > 0
                ? project.getSongStructure().getTotalBars() : 4;

        TrackState vocalTrack = tracks.get("vocal");
        boolean vocalHasClips = vocalTrack != null && vocalTrack.getClips() != null && !vocalTrack.getClips().isEmpty();
        boolean vocalHasAssets = project.getAudioAssets() != null
                && ((project.getAudioAssets().getTunedVocalRef() != null && !project.getAudioAssets().getTunedVocalRef().isBlank())
                || (project.getAudioAssets().getDryDenoisedRef() != null && !project.getAudioAssets().getDryDenoisedRef().isBlank())
                || (project.getAudioAssets().getRawInputRef() != null && !project.getAudioAssets().getRawInputRef().isBlank()));
        boolean vocalPresent = vocalTrack != null && !vocalTrack.isMute() && (vocalHasClips || vocalHasAssets);

        double vocalRms = measureAudioTrackRms(vocalTrack, true, project, store, "ai_mix");
        List<String> mixNotes = new ArrayList<>();
        if (vocalPresent) {
            mixNotes.add(String.format(Locale.ROOT,
                    "Vocal detected (RMS %.3f): centered (pan 0.0) and ducked mid-range accompaniment for clarity.",
                    vocalRms));
        } else {
            mixNotes.add("Instrumental balance mode (no active vocal): boosted Lead & Harmony presence.");
        }

        for (Map.Entry<String, TrackState> entry : tracks.entrySet()) {
            String name = entry.getKey().toLowerCase(Locale.ROOT);
            TrackState track = entry.getValue();
            if (track == null) continue;

            double density = 0.0;
            double avgVel = 0.7;
            if ("midi".equalsIgnoreCase(track.getType()) && track.getNotes() != null && !track.getNotes().isEmpty()) {
                density = (double) track.getNotes().size() / Math.max(1, totalBars);
                avgVel = track.getNotes().stream().mapToInt(MidiNote::getVelocity).average().orElse(85.0) / 127.0;
            }

            double newVol;
            double newPan;
            switch (name) {
                case "vocal" -> {
                    double rmsBoost = vocalRms > 0.0 && vocalRms < 0.12 ? 0.10 : (vocalRms > 0.35 ? -0.06 : 0.02);
                    newVol = 0.98 + rmsBoost;
                    newPan = 0.0;
                }
                case "drums" -> {
                    double densityTrim = Math.min(0.10, density * 0.01);
                    newVol = (vocalPresent ? 0.80 : 0.86) - densityTrim * 0.5;
                    newPan = 0.0;
                }
                case "bass" -> {
                    double velTrim = (avgVel - 0.7) * 0.12;
                    newVol = (vocalPresent ? 0.78 : 0.84) - velTrim;
                    newPan = 0.0;
                }
                case "harmony" -> {
                    double densityTrim = Math.min(0.12, density * 0.012);
                    newVol = (vocalPresent ? 0.64 : 0.76) - densityTrim * 0.5;
                    newPan = -0.22;
                }
                case "lead" -> {
                    double densityTrim = Math.min(0.10, density * 0.01);
                    newVol = (vocalPresent ? 0.58 : 0.82) - densityTrim * 0.4;
                    newPan = 0.22;
                }
                case "texture" -> {
                    double texRms = measureAudioTrackRms(track, false, project, store, "ai_mix");
                    double rmsAdj = texRms > 0.25 ? -0.08 : 0.0;
                    newVol = (vocalPresent ? 0.56 : 0.68) + rmsAdj;
                    newPan = 0.30;
                }
                default -> {
                    newVol = vocalPresent ? 0.65 : 0.75;
                    newPan = 0.0;
                }
            }

            newVol = Math.round(Math.max(0.0, Math.min(1.15, newVol)) * 100.0) / 100.0;
            newPan = Math.round(Math.max(-0.5, Math.min(0.5, newPan)) * 100.0) / 100.0;
            track.setVolume(newVol);
            track.setPan(newPan);
            mixNotes.add(String.format(Locale.ROOT, "%s: vol=%.2f, pan=%+.2f", entry.getKey(), newVol, newPan));
        }

        if (project.getMastering() == null) {
            project.setMastering(new com.aimusic.studio.model.MasteringSettings());
        }
        project.getMastering().setAutoMixEnabled(true);
        project.getMastering().setLimiterCeilingDb(-1.0);
        if (project.getMastering().getTargetLufs() >= 0.0) {
            project.getMastering().setTargetLufs(-14.0);
        }
        mixNotes.add("Master Limiter ceiling set to -1.0 dBFS (target -14.0 LUFS).");

        String summary = String.format(Locale.ROOT,
                "Auto-Mix balanced %d tracks (%s) with Master Limiter <= -1.0 dBFS.",
                tracks.size(), vocalPresent ? "vocal-prioritized" : "instrumental");
        return new AutoMixResult(mixNotes, summary);
    }

    private double measureAudioTrackRms(TrackState track, boolean isVocalTrack,
                                        ProjectState project, ProjectStateStore store, String mode) {
        if (track == null || store == null) return 0.0;
        byte[] bytes = null;
        if (track.getClips() != null && !track.getClips().isEmpty()) {
            for (AudioClip clip : track.getClips()) {
                if (clip != null) {
                    bytes = resolveClipBytes(clip.getSource(), project, store, mode);
                    if (bytes != null) break;
                }
            }
        }
        if (bytes == null && isVocalTrack) {
            String ref = resolvePreferredAudioRef(project, mode);
            if (ref != null) {
                bytes = store.getAudioBytes(ref).orElse(null);
            }
        }
        if (bytes == null) return 0.0;
        try {
            float[] mono = decodeWavBytes(bytes).mono();
            if (mono.length == 0) return 0.0;
            double sumSq = 0.0;
            for (float s : mono) sumSq += s * s;
            return Math.sqrt(sumSq / mono.length);
        } catch (Exception e) {
            return 0.0;
        }
    }

    public record StemSeparationResult(byte[] vocalWav, byte[] beatWav, double durationSec, String method) {}

    public StemSeparationResult separateStemsFallback(byte[] wavBytes) {
        DecodedWav decoded = decodeWavBytes(wavBytes);
        float[] mono = decoded.mono();
        int sr = Math.max(8000, decoded.sampleRate());
        if (mono.length == 0) {
            throw new IllegalArgumentException("Empty audio cannot be separated.");
        }
        // Simple 1st-order bandpass (220Hz .. 4.8kHz) isolating center vocal vs residual accompaniment
        float[] vocal = new float[mono.length];
        float[] beat = new float[mono.length];
        double dt = 1.0 / sr;
        double rcHp = 1.0 / (2.0 * Math.PI * 220.0);
        double aHp = rcHp / (rcHp + dt);
        double rcLp = 1.0 / (2.0 * Math.PI * 4800.0);
        double aLp = dt / (rcLp + dt);
        double hpPrev = 0.0;
        double xPrev = 0.0;
        double lpPrev = 0.0;
        for (int i = 0; i < mono.length; i++) {
            double x = mono[i];
            double hp = aHp * (hpPrev + x - xPrev);
            hpPrev = hp;
            xPrev = x;
            double lp = lpPrev + aLp * (hp - lpPrev);
            lpPrev = lp;
            vocal[i] = (float) Math.max(-0.88, Math.min(0.88, lp * 0.92));
            beat[i] = (float) Math.max(-0.88, Math.min(0.88, (x - vocal[i]) * 0.85));
        }
        double dur = Math.round(((double) mono.length / sr) * 1000.0) / 1000.0;
        return new StemSeparationResult(encodeWavMono(vocal, sr), encodeWavMono(beat, sr), dur, "java_bandpass_fallback");
    }
}
