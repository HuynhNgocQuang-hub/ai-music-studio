import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  FileAudio,
  Loader2,
  Mic,
  Pause,
  Play,
  Sliders,
  Sparkles,
  Square,
  Upload,
  Volume2,
  Wand2,
  XCircle,
} from 'lucide-react';
import {
  analyzeAudio,
  ApiError,
  autotuneAudio,
  cancelJob,
  denoiseAudio,
  exportAudio,
  getQuickPreviewUrl,
  MAX_HUM_DURATION_SEC,
  MAX_VOCAL_DURATION_SEC,
  MIN_AUDIO_DURATION_SEC,
  startGenerateJob,
  subscribeJobEvents,
  triggerBlobDownload,
  uploadAudio,
  validateAudioFileClient,
} from '@/lib/api/client';
import {
  encodeBlobToWav,
  getAudioEngine,
  type TransportSnapshot,
  type VocalABMode,
} from '@/lib/audio/player';
import { saveAudioBlob } from '@/lib/storage/indexeddb';
import { GENRES, MOODS } from '@/lib/music/presets';
import { useProjectSession } from '@/components/providers/ProjectProvider';
import { TrackArtwork, getGenreTheme } from '@/components/shared/TrackArtwork';
import WaveformClipCanvas from '@/components/studio/WaveformClipCanvas';
import type {
  AutoTunePreset,
  AutotuneSettings,
  JobSSEEvent,
  MelodyMode,
  MotifPosition,
  OutputMode,
  ProjectState,
  StructurePreset,
} from '@/types/project';

const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SCALES = ['major', 'minor', 'pentatonic_major', 'pentatonic_minor', 'chromatic'];

const AUTOTUNE_PRESETS: Array<{
  id: AutoTunePreset;
  label: string;
  desc: string;
  retune_speed_ms: number;
  humanize: number;
  mix_percent: number;
}> = [
    { id: 'off', label: 'Off', desc: 'Giữ nguyên giọng mộc', retune_speed_ms: 200, humanize: 1.0, mix_percent: 0 },
    { id: 'natural', label: 'Nhẹ', desc: 'Tự nhiên, giữ độ rung', retune_speed_ms: 45, humanize: 0.7, mix_percent: 75 },
    { id: 'balanced', label: 'Vừa', desc: 'Cân bằng Pop / Ballad', retune_speed_ms: 20, humanize: 0.4, mix_percent: 90 },
    { id: 'modern', label: 'Mạnh', desc: 'Sắc nét, hiện đại', retune_speed_ms: 5, humanize: 0.15, mix_percent: 100 },
  ];

const STEPS = [
  { num: 1, title: 'Nhập & Làm sạch', sub: 'Input & Dry Check' },
  { num: 2, title: 'Phân tích & Auto-Tune', sub: 'Analyze & Tune' },
  { num: 3, title: 'Cấu hình AI & Phối khí', sub: 'Style & Generate' },
  { num: 4, title: 'Nghe thử nhanh', sub: 'Quick Preview' },
];

export default function CreateWizardPage() {
  const navigate = useNavigate();
  const { project, updateProject, loadProjectIntoSession, saveNow } = useProjectSession();
  const engine = useMemo(() => getAudioEngine(), []);
  const latestProjectRef = useRef(project);
  latestProjectRef.current = project;

  const [step, setStep] = useState<number>(1);
  const [transport, setTransport] = useState<TransportSnapshot>(() => engine.getSnapshot());

  // Step 1: Mic / Upload + Denoise
  const [inputMode, setInputMode] = useState<'mic' | 'upload'>('mic');
  const [audioUploadMode, setAudioUploadMode] = useState<'hum' | 'vocal'>('hum');
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>('');
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [countInEnabled, setCountInEnabled] = useState(true);
  const [countInBeat, setCountInBeat] = useState<number | null>(null);
  const [vuLevel, setVuLevel] = useState(0);
  const [enableDenoise, setEnableDenoise] = useState(true);
  const [autoTrim, setAutoTrim] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [denoising, setDenoising] = useState(false);
  const [fileMeta, setFileMeta] = useState<{
    name: string;
    durationSec?: number;
    sampleRate?: number;
    warning?: string;
  } | null>(() =>
    project.audio_assets.raw_input_ref
      ? {
        name: project.title || 'Session Audio',
        durationSec: project.analysis.duration_sec || undefined,
        sampleRate: 44100,
      }
      : null
  );
  const [stepError, setStepError] = useState<string | null>(null);

  // Step 2: Analysis & Auto-Tune
  const [analyzing, setAnalyzing] = useState(false);
  const [tuning, setTuning] = useState(false);
  const [metronomeOn, setMetronomeOn] = useState(false);
  const tapTimesRef = useRef<number[]>([]);

  // Step 3: Multi-Agent Job + SSE + 60s Timeout
  const [jobId, setJobId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [countdownSec, setCountdownSec] = useState(60);
  const [agentLogs, setAgentLogs] = useState<JobSSEEvent[]>([]);
  const [jobProgress, setJobProgress] = useState(0);
  const [jobWarning, setJobWarning] = useState<string | null>(null);
  const sseCleanupRef = useRef<(() => void) | null>(null);

  // Step 4: Quick Preview Export
  const [exportingFormat, setExportingFormat] = useState<'mp3' | 'wav' | null>(null);
  const [previewLayer, setPreviewLayer] = useState<'dry' | 'autotune' | 'preserve' | 'enhance'>('preserve');

  // Mic refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const analyserRafRef = useRef<number | null>(null);
  const isRecordingPausedRef = useRef(false);

  const refreshMicDevices = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      setMicDevices(inputs);
      setSelectedMicId((curr) =>
        curr && inputs.some((d) => d.deviceId === curr) ? curr : inputs[0]?.deviceId || ''
      );
    } catch {
      // ignore enumerateDevices errors
    }
  }, []);

  useEffect(() => {
    void refreshMicDevices();
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      const onDeviceChange = () => void refreshMicDevices();
      navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
      return () => {
        navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
      };
    }
    return undefined;
  }, [refreshMicDevices]);

  useEffect(() => {
    engine.setPreferPreRenderedMix(true);
    const unsub = engine.subscribe(setTransport);
    return () => {
      unsub();
      engine.stopMetronome();
      engine.setPreferPreRenderedMix(false);
    };
  }, [engine]);

  // Cleanup mic & SSE on unmount
  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (analyserRafRef.current) cancelAnimationFrame(analyserRafRef.current);
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      sseCleanupRef.current?.();
    };
  }, []);

  // Countdown timer during generation (60s timeout per SRS)
  useEffect(() => {
    if (!isGenerating) return;
    setCountdownSec(60);
    const id = window.setInterval(() => {
      setCountdownSec((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [isGenerating]);

  const measureBlobDuration = (blob: Blob): Promise<number> => {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.addEventListener('loadedmetadata', () => {
        const d = Number.isFinite(audio.duration) ? audio.duration : 0;
        URL.revokeObjectURL(url);
        resolve(d);
      });
      audio.addEventListener('error', () => {
        URL.revokeObjectURL(url);
        resolve(0);
      });
    });
  };

  const processAudioInput = useCallback(
    async (blob: Blob, filename: string) => {
      setStepError(null);
      setUploading(true);
      try {
        const dur = await measureBlobDuration(blob);
        if (dur > 0 && dur < MIN_AUDIO_DURATION_SEC) {
          setStepError(
            `Đoạn âm thanh quá ngắn (${dur.toFixed(1)}s). Cần tối thiểu ${MIN_AUDIO_DURATION_SEC} giây để AI bắt tông & nhịp.`
          );
          setUploading(false);
          return;
        }
        const maxDur = audioUploadMode === 'vocal' ? MAX_VOCAL_DURATION_SEC : MAX_HUM_DURATION_SEC;
        if (dur > maxDur) {
          setStepError(
            audioUploadMode === 'vocal'
              ? `Đoạn Vocal quá dài (${dur.toFixed(1)}s). Tối đa 5 phút (300 giây).`
              : `Đoạn ngân nga quá dài (${dur.toFixed(1)}s). Chế độ Hum tối đa 60 giây — hãy chuyển sang chế độ Vocal (<= 5 phút) nếu cần dài hơn.`
          );
          setUploading(false);
          return;
        }

        const currentId = latestProjectRef.current.project_id;
        await engine.loadAudioFromBlob('raw', blob);
        await saveAudioBlob(currentId, 'raw_input', blob);

        const uploadRes = await uploadAudio(blob, filename, currentId, audioUploadMode);
        const nextProjectId = uploadRes.project_id || currentId;
        if (nextProjectId !== currentId) {
          await saveAudioBlob(nextProjectId, 'raw_input', blob);
        }

        const warningMsg =
          uploadRes.warnings && uploadRes.warnings.length > 0
            ? uploadRes.warnings.join(' ')
            : undefined;

        setFileMeta({
          name: uploadRes.filename || filename,
          durationSec: uploadRes.duration_sec || dur,
          sampleRate: uploadRes.sample_rate || 44100,
          warning: warningMsg,
        });

        const derivedTitle = filename.replace(/\.[^.]+$/, '');
        updateProject((prev) => {
          const nextTitle =
            !prev.title || prev.title === 'Untitled Session' ? derivedTitle : prev.title;
          return {
            ...prev,
            project_id: nextProjectId,
            title: nextTitle,
            config: {
              ...prev.config,
              title: nextTitle,
            },
            audio_assets: {
              ...prev.audio_assets,
              raw_input_ref: uploadRes.raw_input_ref,
            },
          };
        });

        // Run AI Denoise + Auto-Trim automatically
        setDenoising(true);
        const denoiseRes = await denoiseAudio({
          project_id: nextProjectId,
          enable_denoise: enableDenoise,
          auto_trim: autoTrim,
        });

        updateProject((prev) => ({
          ...prev,
          project_id: nextProjectId,
          audio_assets: {
            ...prev.audio_assets,
            raw_input_ref: uploadRes.raw_input_ref,
            dry_denoised_ref: denoiseRes.dry_denoised_ref,
          },
        }));

        if (denoiseRes.warnings && denoiseRes.warnings.length > 0) {
          const denoiseWarn = denoiseRes.warnings.join(' ');
          setFileMeta((m) => (m ? { ...m, warning: denoiseWarn } : m));
        }

        // Load denoised buffer for instant A/B Dry Check
        const base = latestProjectRef.current;
        const nextTitle =
          !base.title || base.title === 'Untitled Session' ? derivedTitle : base.title;
        const syncedProject: ProjectState = {
          ...base,
          project_id: nextProjectId,
          title: nextTitle,
          config: {
            ...base.config,
            title: nextTitle,
          },
          audio_assets: {
            ...base.audio_assets,
            raw_input_ref: uploadRes.raw_input_ref,
            dry_denoised_ref: denoiseRes.dry_denoised_ref,
          },
        };
        await engine.syncFromProject(syncedProject, { forceSlots: ['dry'] });
        engine.setABMode('dry');
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.detail
            : 'Không thể kết nối Backend Spring Boot. Kiểm tra kết nối tại /settings.';
        setStepError(msg);
      } finally {
        setUploading(false);
        setDenoising(false);
      }
    },
    [audioUploadMode, autoTrim, enableDenoise, engine, updateProject]
  );

  const handleFileUpload = async (file: File) => {
    const validationErr = validateAudioFileClient(file);
    if (validationErr) {
      setStepError(validationErr);
      return;
    }
    await processAudioInput(file, file.name);
  };

  const startRecording = async () => {
    setStepError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setStepError('Trình duyệt không hỗ trợ ghi âm Microphone. Vui lòng chuyển sang tab Upload File.');
      return;
    }

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      micStreamRef.current = stream;
      void refreshMicDevices();

      // Setup live VU meter
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateVu = () => {
        if (!isRecordingPausedRef.current) {
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          setVuLevel(Math.min(100, Math.round((avg / 128) * 100)));
        } else {
          setVuLevel(0);
        }
        analyserRafRef.current = requestAnimationFrame(updateVu);
      };
      updateVu();

      // Optional 4-beat Count-in Metronome
      if (countInEnabled) {
        const beatMs = (60 / (project.analysis.bpm || 100)) * 1000;
        for (let b = 1; b <= 4; b++) {
          setCountInBeat(b);
          engine.playClick(b === 1);
          await new Promise((r) => setTimeout(r, beatMs));
        }
        setCountInBeat(null);
      }

      const recorder = new MediaRecorder(stream);
      micChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) micChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        if (recordTimerRef.current) clearInterval(recordTimerRef.current);
        if (analyserRafRef.current) cancelAnimationFrame(analyserRafRef.current);
        isRecordingPausedRef.current = false;
        setIsRecordingPaused(false);
        setVuLevel(0);
        stream.getTracks().forEach((t) => t.stop());
        void audioCtx.close();

        const rawBlob = new Blob(micChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        void (async () => {
          try {
            const wavBlob = await encodeBlobToWav(rawBlob);
            await processAudioInput(wavBlob, `mic_hum_${Date.now()}.wav`);
          } catch {
            setStepError('Không thể mã hóa bản thu Mic sang định dạng WAV.');
          }
        })();
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      isRecordingPausedRef.current = false;
      setIsRecordingPaused(false);
      setIsRecording(true);
      setRecordSec(0);
      recordTimerRef.current = window.setInterval(() => {
        if (!isRecordingPausedRef.current) {
          setRecordSec((s) => s + 1);
        }
      }, 1000);
    } catch {
      setStepError(
        'Trình duyệt từ chối quyền Microphone. Hãy cấp quyền Micro trên thanh địa chỉ hoặc chuyển sang tab Upload File.'
      );
    }
  };

  const togglePauseRecording = () => {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    if (rec.state === 'recording') {
      rec.pause();
      isRecordingPausedRef.current = true;
      setIsRecordingPaused(true);
    } else if (rec.state === 'paused') {
      rec.resume();
      isRecordingPausedRef.current = false;
      setIsRecordingPaused(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    isRecordingPausedRef.current = false;
    setIsRecordingPaused(false);
    setIsRecording(false);
  };

  const handleRerunDenoise = async () => {
    const current = latestProjectRef.current;
    if (!current.audio_assets.raw_input_ref) return;
    setDenoising(true);
    setStepError(null);
    try {
      const res = await denoiseAudio({
        project_id: current.project_id,
        enable_denoise: enableDenoise,
        auto_trim: autoTrim,
      });
      updateProject((prev) => ({
        ...prev,
        audio_assets: {
          ...prev.audio_assets,
          dry_denoised_ref: res.dry_denoised_ref,
        },
      }));
      const latest = latestProjectRef.current;
      await engine.syncFromProject(
        {
          ...latest,
          audio_assets: { ...latest.audio_assets, dry_denoised_ref: res.dry_denoised_ref },
        },
        { forceSlots: ['dry'] }
      );
      engine.setABMode('dry');
    } catch (err) {
      setStepError(err instanceof ApiError ? err.detail : 'Lỗi chạy AI Denoise.');
    } finally {
      setDenoising(false);
    }
  };

  // Step 2: Analyze + Auto-Tune
  const goToStep2AndAnalyze = async () => {
    setStep(2);
    const current = latestProjectRef.current;
    if (!current.audio_assets.dry_denoised_ref && !current.audio_assets.raw_input_ref) return;
    setAnalyzing(true);
    setStepError(null);
    try {
      const sourceRef =
        current.audio_assets.dry_denoised_ref || current.audio_assets.raw_input_ref || '';
      const res = await analyzeAudio({
        project_id: current.project_id,
        source_ref: sourceRef,
        ...(current.analysis.bpm_locked ? { bpm_override: current.analysis.bpm } : {}),
        ...(current.analysis.key_locked
          ? {
            key_override: current.analysis.detected_key,
            scale_override: current.analysis.detected_scale,
          }
          : {}),
      });
      updateProject((prev) => {
        const resolvedBpm = prev.analysis.bpm_locked ? prev.analysis.bpm : res.bpm;
        const resolvedKey = prev.analysis.key_locked ? prev.analysis.detected_key : res.key;
        const resolvedScale = prev.analysis.key_locked ? prev.analysis.detected_scale : res.scale;
        return {
          ...prev,
          analysis: {
            ...prev.analysis,
            bpm: resolvedBpm,
            time_signature: res.time_signature || prev.analysis.time_signature || '4/4',
            detected_key: resolvedKey,
            detected_scale: resolvedScale,
            key_confidence: res.key_confidence ?? 0.85,
            bars: res.bars ?? Math.max(4, Math.round(((fileMeta?.durationSec || 8) * resolvedBpm) / 240)),
            raw_melody_midi: res.raw_melody_midi || [],
          },
          autotune_settings: prev.autotune_settings.auto_follow_project_key
            ? { ...prev.autotune_settings, key: resolvedKey, scale: resolvedScale }
            : prev.autotune_settings,
        };
      });
      engine.setBpm(current.analysis.bpm_locked ? current.analysis.bpm : res.bpm);
    } catch (err) {
      setStepError(err instanceof ApiError ? err.detail : 'Không thể phân tích audio.');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleTapTempo = () => {
    const now = performance.now();
    const taps = tapTimesRef.current.filter((t) => now - t < 2500);
    taps.push(now);
    tapTimesRef.current = taps;
    if (taps.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
      const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const computedBpm = Math.max(40, Math.min(220, Math.round(60000 / avgMs)));
      updateProject((prev) => ({
        ...prev,
        analysis: { ...prev.analysis, bpm: computedBpm, bpm_locked: true },
      }));
      engine.setBpm(computedBpm);
    }
  };

  const toggleMetronome = () => {
    if (metronomeOn) {
      engine.stopMetronome();
      setMetronomeOn(false);
    } else {
      engine.startMetronome(project.analysis.bpm || 100);
      setMetronomeOn(true);
    }
  };

  const handleSelectAutotunePreset = async (preset: (typeof AUTOTUNE_PRESETS)[number]) => {
    const current = latestProjectRef.current;
    const isOff = preset.id === 'off';
    const nextSettings: AutotuneSettings = {
      ...current.autotune_settings,
      enabled: !isOff,
      preset: preset.id,
      key: current.analysis.detected_key,
      scale: current.analysis.detected_scale,
      retune_speed_ms: preset.retune_speed_ms,
      humanize: preset.humanize,
      mix_percent: isOff ? 0 : preset.mix_percent,
    };

    updateProject((prev) => ({
      ...prev,
      autotune_settings: nextSettings,
      ...(isOff
        ? {
          audio_assets: { ...prev.audio_assets, tuned_vocal_ref: null },
        }
        : {}),
    }));

    if (isOff) {
      engine.invalidateSlots(['autotune']);
      engine.setABMode('dry');
    }

    setTuning(true);
    setStepError(null);
    try {
      const res = await autotuneAudio({
        project_id: current.project_id,
        autotune_settings: nextSettings,
      });
      const nextTunedRef = isOff ? null : res.tuned_vocal_ref;
      const updated = updateProject((prev) => ({
        ...prev,
        autotune_settings: nextSettings,
        audio_assets: { ...prev.audio_assets, tuned_vocal_ref: nextTunedRef },
      }));
      await engine.syncFromProject(updated, isOff ? undefined : { forceSlots: ['autotune'] });
      engine.setABMode(isOff ? 'dry' : 'autotune');
    } catch (err) {
      setStepError(err instanceof ApiError ? err.detail : 'Lỗi áp dụng Auto-Tune.');
    } finally {
      setTuning(false);
    }
  };

  // Step 3: Multi-Agent Generate + SSE Stream
  const handleStartGenerate = async () => {
    setStepError(null);
    setJobWarning(null);
    setAgentLogs([]);
    setJobProgress(5);
    setIsGenerating(true);

    try {
      await saveNow(true);
      const { job_id } = await startGenerateJob({
        project_id: project.project_id,
        config: project.config,
      });
      setJobId(job_id);

      sseCleanupRef.current?.();
      sseCleanupRef.current = subscribeJobEvents(
        job_id,
        (evt) => {
          setAgentLogs((prev) => [...prev, evt]);
          if (typeof evt.progress === 'number') {
            setJobProgress(evt.progress);
          }
          if (evt.type === 'fallback_warning') {
            const warningText = evt.warning || evt.message;
            if (warningText) setJobWarning(warningText);
          }
          if (evt.type === 'error') {
            setStepError(evt.message || evt.error || 'Multi-Agent Job gặp lỗi.');
            setIsGenerating(false);
          }
          if (evt.type === 'completed') {
            setJobProgress(100);
            setIsGenerating(false);
            const resolvedState = evt.project_state ?? latestProjectRef.current;
            if (evt.project_state) {
              loadProjectIntoSession(evt.project_state, { dirty: true });
            }
            const nextLayer =
              resolvedState.config.melody_mode === 'enhance' ? 'enhance' : 'preserve';
            setPreviewLayer(nextLayer);
            setStep(4);
            void (async () => {
              await engine.syncFromProject(resolvedState);
              await Promise.all([
                engine.loadAudioFromUrl(
                  'preserve',
                  getQuickPreviewUrl(resolvedState.project_id, 'preserve'),
                  `preview:${resolvedState.project_id}:preserve:v${resolvedState.version}`
                ),
                engine.loadAudioFromUrl(
                  'enhance',
                  getQuickPreviewUrl(resolvedState.project_id, 'enhance'),
                  `preview:${resolvedState.project_id}:enhance:v${resolvedState.version}`
                ),
              ]);
              engine.setABMode(nextLayer);
            })();
          }
        },
        () => {
          setIsGenerating(false);
          setStepError('Mất kết nối SSE với Backend trong lúc phối khí.');
        }
      );
    } catch (err) {
      setIsGenerating(false);
      setStepError(err instanceof ApiError ? err.detail : 'Không thể khởi chạy Multi-Agent Job.');
    }
  };

  const handleCancelJob = async () => {
    if (!jobId) return;
    try {
      await cancelJob(jobId);
    } catch {
      // ignore
    }
    sseCleanupRef.current?.();
    setIsGenerating(false);
    setAgentLogs((prev) => [
      ...prev,
      { type: 'error', agent: 'Orchestrator', message: 'Đã hủy tác vụ theo yêu cầu.' },
    ]);
  };

  const handleSwitchPreviewLayer = (layer: 'dry' | 'autotune' | 'preserve' | 'enhance') => {
    setPreviewLayer(layer);
    const modeMap: Record<typeof layer, VocalABMode> = {
      dry: 'dry',
      autotune: 'autotune',
      preserve: 'preserve',
      enhance: 'enhance',
    };
    const nextMode = modeMap[layer];
    if ((layer === 'preserve' || layer === 'enhance') && !engine.hasBuffer(layer)) {
      const current = latestProjectRef.current;
      void engine
        .loadAudioFromUrl(
          layer,
          getQuickPreviewUrl(current.project_id, layer),
          `preview:${current.project_id}:${layer}:v${current.version}`
        )
        .then(() => {
          engine.setABMode(nextMode);
        });
      return;
    }
    engine.setABMode(nextMode);
  };

  const handleQuickExport = async (format: 'mp3' | 'wav') => {
    setExportingFormat(format);
    setStepError(null);
    try {
      const exportMode =
        previewLayer === 'preserve' || previewLayer === 'enhance'
          ? previewLayer
          : previewLayer === 'dry'
            ? 'dry_beat'
            : 'autotune_beat';
      const blob = await exportAudio(project.project_id, format, true, exportMode, '320k');
      const safeName = (project.title || project.project_id).replace(/[^a-zA-Z0-9_-]/g, '_');
      triggerBlobDownload(blob, `${safeName}.${format}`);
    } catch (err) {
      setStepError(err instanceof ApiError ? err.detail : `Lỗi xuất file ${format.toUpperCase()}.`);
    } finally {
      setExportingFormat(null);
    }
  };

  const hasAudioInput = Boolean(project.audio_assets.raw_input_ref || engine.hasBuffer('raw'));
  const hasGeneratedTracks =
    (project.tracks.drums?.notes?.length ?? 0) > 0 ||
    (project.tracks.harmony?.notes?.length ?? 0) > 0;
  const activeDrySlot = transport.abMode === 'raw' ? 'raw' : 'dry';
  const dryPeaks = engine.getWaveformPeaksForSlot(activeDrySlot, 72);
  const activePreviewSlot =
    previewLayer === 'preserve' && engine.hasBuffer('preserve')
      ? 'preserve'
      : previewLayer === 'enhance' && engine.hasBuffer('enhance')
        ? 'enhance'
        : previewLayer === 'autotune' && engine.hasBuffer('autotune')
          ? 'autotune'
          : engine.hasBuffer('dry')
            ? 'dry'
            : 'raw';
  const previewPeaks = engine.getWaveformPeaksForSlot(activePreviewSlot, 96);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Studio Stepper Header */}
      <nav aria-label="Wizard Steps" className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        {STEPS.map((s) => {
          const isCurrent = step === s.num;
          const isDone = step > s.num;
          const clickable = s.num <= step || (s.num === 2 && hasAudioInput) || (hasGeneratedTracks && s.num <= 4);
          return (
            <button
              key={s.num}
              type="button"
              disabled={!clickable}
              onClick={() => clickable && setStep(s.num)}
              className={`flex items-center gap-3 rounded-2xl border p-3.5 text-left transition ${isCurrent
                ? 'border-amber-400/70 bg-gradient-to-br from-amber-500/20 to-orange-500/10 text-white shadow-lg shadow-black/40'
                : isDone
                  ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15'
                  : 'border-white/[0.08] bg-[#16191f] text-slate-400 disabled:opacity-45'
                }`}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${isCurrent
                  ? 'bg-amber-500 text-slate-950'
                  : isDone
                    ? 'bg-emerald-500 text-slate-950'
                    : 'bg-white/10 text-slate-400'
                  }`}
              >
                {isDone ? <Check className="h-4 w-4" /> : s.num}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-bold">{s.title}</p>
                <p className="truncate text-[11px] text-slate-400">{s.sub}</p>
              </div>
            </button>
          );
        })}
      </nav>

      {stepError && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-rose-500/40 bg-rose-500/10 p-3.5 text-sm text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <p>{stepError}</p>
        </div>
      )}

      {/* STEP 1: Recording Booth & Dry Check */}
      {step === 1 && (
        <section className="space-y-6 rounded-3xl border border-white/[0.08] bg-[#16191f] p-6 shadow-xl shadow-black/30">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="font-display text-xl font-bold text-white">
                Bước 1: Nhập giai điệu &amp; Kiểm tra Giọng mộc
              </h1>
              <p className="text-xs text-slate-400">
                Hỗ trợ WAV, MP3, M4A, OGG, FLAC (tối thiểu 3 giây, tối đa 50 MB).
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-full border border-white/10 bg-[#0b0d11] p-1">
                <button
                  type="button"
                  onClick={() => setAudioUploadMode('hum')}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${audioUploadMode === 'hum'
                    ? 'bg-emerald-500 text-slate-950'
                    : 'text-slate-400 hover:text-white'
                    }`}
                >
                  Hum (&le; 60s)
                </button>
                <button
                  type="button"
                  onClick={() => setAudioUploadMode('vocal')}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${audioUploadMode === 'vocal'
                    ? 'bg-emerald-500 text-slate-950'
                    : 'text-slate-400 hover:text-white'
                    }`}
                >
                  Vocal (&le; 5 phút)
                </button>
              </div>
              <div className="inline-flex rounded-full border border-white/10 bg-[#0b0d11] p-1">
                <button
                  type="button"
                  onClick={() => setInputMode('mic')}
                  className={`flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-semibold transition ${inputMode === 'mic'
                    ? 'bg-violet-600 text-white'
                    : 'text-slate-400 hover:text-white'
                    }`}
                >
                  <Mic className="h-3.5 w-3.5" />
                  Ghi âm Mic
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode('upload')}
                  className={`flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-semibold transition ${inputMode === 'upload'
                    ? 'bg-violet-600 text-white'
                    : 'text-slate-400 hover:text-white'
                    }`}
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload File
                </button>
              </div>
            </div>
          </div>

          {inputMode === 'mic' ? (
            <div className="rounded-2xl border border-white/[0.08] bg-[#1b1e25] p-5 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <label
                    htmlFor="create-countin-checkbox"
                    className="flex cursor-pointer items-center gap-2 text-xs text-slate-300"
                  >
                    <input
                      id="create-countin-checkbox"
                      name="countInEnabled"
                      type="checkbox"
                      checked={countInEnabled}
                      onChange={(e) => setCountInEnabled(e.target.checked)}
                      className="rounded border-slate-600 bg-slate-800 accent-amber-400"
                    />
                    <span>Đếm nhịp 1 ô nhịp trước khi thu (Count-in)</span>
                  </label>
                  <label htmlFor="create-mic-select" className="sr-only">
                    Chọn thiết bị Microphone
                  </label>
                  <select
                    id="create-mic-select"
                    name="selectedMicId"
                    aria-label="Chọn thiết bị Microphone"
                    disabled={isRecording}
                    value={selectedMicId}
                    onChange={(e) => setSelectedMicId(e.target.value)}
                    className="max-w-[230px] rounded-xl border border-white/10 bg-[#0b0d11] px-3 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                  >
                    {micDevices.length === 0 ? (
                      <option value="">Microphone mặc định</option>
                    ) : (
                      micDevices.map((d, idx) => (
                        <option key={d.deviceId || idx} value={d.deviceId}>
                          {d.label || `Microphone ${idx + 1}`}
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <span className="rounded-full border border-white/10 bg-[#0b0d11] px-3.5 py-1 font-mono text-xs font-semibold tabular-nums text-cyan-300">
                  {countInBeat !== null
                    ? `Đếm nhịp: ${countInBeat} / 4`
                    : isRecording
                      ? `${isRecordingPaused ? 'Tạm dừng' : 'REC'}: 00:${String(recordSec).padStart(2, '0')}`
                      : 'Sẵn sàng thu'}
                </span>
              </div>

              {/* Segmented Studio LED VU Bar */}
              <div className="space-y-1.5">
                <div className="grid grid-cols-24 gap-1 rounded-xl border border-white/[0.06] bg-[#0b0d11] p-2">
                  {Array.from({ length: 24 }, (_, idx) => {
                    const threshold = ((idx + 1) / 24) * 100;
                    const lit = vuLevel >= threshold - 3;
                    const segColor =
                      idx >= 20
                        ? 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.7)]'
                        : idx >= 15
                          ? 'bg-amber-400'
                          : 'bg-emerald-400';
                    return (
                      <span
                        key={idx}
                        className={`h-2.5 rounded-xs transition-colors duration-75 ${lit ? segColor : 'bg-white/[0.06]'
                          }`}
                      />
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {!isRecording ? (
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => void startRecording()}
                    className="flex items-center gap-2 rounded-full bg-rose-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-rose-600/30 transition hover:bg-rose-500 disabled:opacity-50"
                  >
                    <Mic className="h-4 w-4" />
                    <span>Bắt đầu Ghi âm</span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={togglePauseRecording}
                      className="flex items-center gap-2 rounded-full border border-amber-500/50 bg-amber-500/20 px-4 py-2.5 text-sm font-semibold text-amber-200 hover:bg-amber-500/30"
                    >
                      {isRecordingPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                      <span>{isRecordingPaused ? 'Tiếp tục' : 'Tạm dừng'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={stopRecording}
                      className="flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-slate-200"
                    >
                      <Square className="h-4 w-4 fill-current" />
                      <span>Dừng thu</span>
                    </button>
                  </>
                )}
                {uploading && (
                  <span className="flex items-center gap-2 text-xs text-violet-300">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Đang tải lên &amp; lọc ồn AI Denoise...
                  </span>
                )}
              </div>
            </div>
          ) : (
            <label
              htmlFor="create-audio-file-input"
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDraggingOver(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDraggingOver(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDraggingOver(false);
                const f = e.dataTransfer?.files?.[0];
                if (f) void handleFileUpload(f);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-10 text-center transition ${isDraggingOver
                ? 'border-violet-400 bg-violet-600/15'
                : 'border-white/15 bg-[#1b1e25] hover:border-violet-500/70'
                }`}
            >
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-300">
                <FileAudio className="h-7 w-7" />
              </div>
              <p className="mt-3 text-sm font-semibold text-white">
                Kéo thả file âm thanh vào đây hoặc bấm để chọn
              </p>
              <p className="mt-1 text-xs text-slate-400">
                WAV, MP3, M4A, OGG, FLAC • Tối đa 50 MB •{' '}
                {audioUploadMode === 'vocal' ? 'Vocal (tối đa 5 phút)' : 'Hum (tối đa 60 giây)'}
              </p>
              <input
                id="create-audio-file-input"
                name="audioFile"
                type="file"
                accept=".wav,.mp3,.m4a,.ogg,.flac,audio/*"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFileUpload(f);
                }}
              />
            </label>
          )}

          {/* Denoise & Dry Check Waveform Deck */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-[#1b1e25] p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white">Tiền xử lý AI Denoise &amp; Trim</span>
                <button
                  type="button"
                  disabled={!hasAudioInput || denoising}
                  onClick={() => void handleRerunDenoise()}
                  className="rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-violet-200 transition hover:bg-white/10 disabled:opacity-40"
                >
                  {denoising ? 'Đang lọc...' : 'Áp dụng lại'}
                </button>
              </div>
              <label
                htmlFor="create-enable-denoise"
                className="flex cursor-pointer items-center justify-between text-xs text-slate-300"
              >
                <span>Bật AI Denoise (lọc ồn nền)</span>
                <input
                  id="create-enable-denoise"
                  name="enableDenoise"
                  type="checkbox"
                  checked={enableDenoise}
                  onChange={(e) => setEnableDenoise(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-amber-400"
                />
              </label>
              <label
                htmlFor="create-auto-trim"
                className="flex cursor-pointer items-center justify-between text-xs text-slate-300"
              >
                <span>AI Auto-Trim (cắt khoảng lặng đầu/cuối)</span>
                <input
                  id="create-auto-trim"
                  name="autoTrim"
                  type="checkbox"
                  checked={autoTrim}
                  onChange={(e) => setAutoTrim(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-amber-400"
                />
              </label>
            </div>

            <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-[#1b1e25] p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white">Nghe kiểm tra (Dry Check)</span>
                {fileMeta && (
                  <span className="truncate text-xs text-emerald-400">
                    {fileMeta.name} ({(fileMeta.durationSec || 0).toFixed(1)}s • {((fileMeta.sampleRate || 44100) / 1000).toFixed(1)} kHz)
                  </span>
                )}
              </div>

              {hasAudioInput && (
                <div className="h-9 rounded-xl border border-white/[0.06] bg-[#0b0d11] px-2 py-1">
                  <WaveformClipCanvas
                    peaks={dryPeaks}
                    seed={project.project_id}
                    color={
                      transport.abMode === 'raw'
                        ? 'rgba(245, 158, 11, 0.72)'
                        : 'rgba(16, 185, 129, 0.75)'
                    }
                    playedColor="rgba(34, 211, 238, 0.95)"
                    playProgress={
                      transport.durationSec > 0 ? transport.currentTimeSec / transport.durationSec : 0
                    }
                  />
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!hasAudioInput}
                  onClick={() => (transport.isPlaying ? engine.pause() : engine.play())}
                  className="flex items-center gap-1.5 rounded-full bg-violet-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
                >
                  {transport.isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  <span>{transport.isPlaying ? 'Tạm dừng' : 'Nghe thử'}</span>
                </button>
                <button
                  type="button"
                  disabled={!hasAudioInput}
                  onClick={() => engine.setABMode('raw')}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium ${transport.abMode === 'raw'
                    ? 'border-amber-500 bg-amber-500/20 text-amber-200'
                    : 'border-white/10 text-slate-400 hover:text-white'
                    }`}
                >
                  Giọng gốc
                </button>
                <button
                  type="button"
                  disabled={!hasAudioInput}
                  onClick={() => engine.setABMode('dry')}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium ${transport.abMode === 'dry'
                    ? 'border-emerald-500 bg-emerald-500/20 text-emerald-200'
                    : 'border-white/10 text-slate-400 hover:text-white'
                    }`}
                >
                  Đã lọc ồn
                </button>
              </div>
              {fileMeta?.warning && <p className="text-xs text-amber-300">{fileMeta.warning}</p>}
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              disabled={!hasAudioInput || uploading || denoising}
              onClick={() => void goToStep2AndAnalyze()}
              className="flex items-center gap-2 rounded-full bg-gradient-to-r from-violet-600 to-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-600/25 transition hover:brightness-110 disabled:opacity-40"
            >
              <span>Tiếp tục: Phân tích &amp; Auto-Tune</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* STEP 2: Pitch, Tempo & Auto-Tune Lab */}
      {step === 2 && (
        <section className="space-y-6 rounded-3xl border border-white/[0.08] bg-[#16191f] p-6 shadow-xl shadow-black/30">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="font-display text-xl font-bold text-white">
                Bước 2: Phân tích Giai điệu &amp; Auto-Tune nhanh
              </h1>
              <p className="text-xs text-slate-400">
                Kiểm tra nhịp BPM, Tông bài hát và chỉnh phô với 4 mức Auto-Tune.
              </p>
            </div>
            {analyzing && (
              <span className="flex items-center gap-2 text-xs text-violet-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                Đang phân tích giai điệu...
              </span>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {/* BPM + Tap Tempo + Metronome */}
            <div className="space-y-2.5 rounded-2xl border border-white/[0.08] bg-[#1b1e25] p-4">
              <div className="flex items-center justify-between">
                <label htmlFor="create-bpm-input" className="text-xs font-medium text-slate-400">
                  Tempo (BPM: 40–220)
                </label>
                {project.analysis.bpm_locked && (
                  <span className="rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] font-medium text-violet-200">
                    Đã khóa
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="create-bpm-input"
                  name="bpm"
                  type="number"
                  min={40}
                  max={220}
                  value={project.analysis.bpm}
                  onChange={(e) => {
                    const val = Math.max(40, Math.min(220, Number(e.target.value) || 100));
                    updateProject((prev) => ({
                      ...prev,
                      analysis: { ...prev.analysis, bpm: val, bpm_locked: true },
                    }));
                    engine.setBpm(val);
                  }}
                  className="w-20 rounded-xl border border-white/10 bg-[#0b0d11] px-3 py-1.5 font-mono text-base font-bold tabular-nums text-white"
                />
                <button
                  type="button"
                  onClick={handleTapTempo}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10"
                >
                  Tap Tempo
                </button>
                <button
                  type="button"
                  onClick={toggleMetronome}
                  className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${metronomeOn
                    ? 'bg-emerald-500 text-slate-950'
                    : 'border border-white/10 text-slate-300 hover:bg-white/10'
                    }`}
                >
                  {metronomeOn ? 'Tắt Click' : 'Metronome'}
                </button>
              </div>
            </div>

            {/* Key / Scale */}
            <div className="space-y-2.5 rounded-2xl border border-white/[0.08] bg-[#1b1e25] p-4">
              <div className="flex items-center justify-between">
                <label htmlFor="create-key-select" className="text-xs font-medium text-slate-400">
                  Key / Scale
                </label>
                <div className="flex items-center gap-1.5">
                  {project.analysis.key_locked && (
                    <span className="rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] font-medium text-violet-200">
                      Đã khóa
                    </span>
                  )}
                  {(project.analysis.key_confidence ?? 1) < 0.6 && (
                    <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-300">
                      Gợi ý
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <select
                  id="create-key-select"
                  name="detectedKey"
                  value={project.analysis.detected_key}
                  onChange={(e) =>
                    updateProject((prev) => ({
                      ...prev,
                      analysis: { ...prev.analysis, detected_key: e.target.value, key_locked: true },
                      autotune_settings: prev.autotune_settings.auto_follow_project_key
                        ? { ...prev.autotune_settings, key: e.target.value }
                        : prev.autotune_settings,
                    }))
                  }
                  className="rounded-xl border border-white/10 bg-[#0b0d11] px-3 py-1.5 text-sm font-semibold text-white"
                >
                  {KEYS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <select
                  id="create-scale-select"
                  name="detectedScale"
                  aria-label="Scale bài hát"
                  value={project.analysis.detected_scale}
                  onChange={(e) =>
                    updateProject((prev) => ({
                      ...prev,
                      analysis: { ...prev.analysis, detected_scale: e.target.value, key_locked: true },
                      autotune_settings: prev.autotune_settings.auto_follow_project_key
                        ? { ...prev.autotune_settings, scale: e.target.value }
                        : prev.autotune_settings,
                    }))
                  }
                  className="flex-1 rounded-xl border border-white/10 bg-[#0b0d11] px-3 py-1.5 text-sm text-white"
                >
                  {SCALES.map((sc) => (
                    <option key={sc} value={sc}>
                      {sc}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Bars, Time Signature & Notes */}
            <div className="space-y-1.5 rounded-2xl border border-white/[0.08] bg-[#1b1e25] p-4">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="create-timesig-select" className="text-xs font-medium text-slate-400">
                  Cấu trúc &amp; Nhịp
                </label>
                <select
                  id="create-timesig-select"
                  name="timeSignature"
                  aria-label="Loại nhịp"
                  value={project.analysis.time_signature || '4/4'}
                  onChange={(e) => {
                    const nextTs = e.target.value;
                    const beats = nextTs === '6/8' ? 6 : nextTs === '3/4' ? 3 : 4;
                    const durSec = project.analysis.duration_sec || fileMeta?.durationSec || 8;
                    const nextBars = Math.max(1, Math.round(durSec / (beats * (60 / (project.analysis.bpm || 100)))));
                    updateProject((prev) => ({
                      ...prev,
                      analysis: { ...prev.analysis, time_signature: nextTs, bars: nextBars },
                    }));
                  }}
                  className="rounded-lg border border-white/10 bg-[#0b0d11] px-2 py-0.5 font-mono text-xs font-semibold text-sky-300"
                >
                  <option value="4/4">4/4</option>
                  <option value="3/4">3/4</option>
                  <option value="6/8">6/8</option>
                </select>
              </div>
              <p className="font-mono text-lg font-bold tabular-nums text-white">
                {project.analysis.bars || 8} ô nhịp ({project.analysis.time_signature || '4/4'})
              </p>
              <p className="text-xs text-cyan-300">
                {project.analysis.raw_melody_midi.length} nốt giai điệu trích xuất
              </p>
            </div>
          </div>

          {/* Auto-Tune Quick Bar */}
          <div className="space-y-4 rounded-2xl border border-white/[0.08] bg-[#1b1e25] p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-white">Chỉnh phô Auto-Tune nhanh</h2>
                <p className="text-xs text-slate-400">
                  Chọn mức độ xử lý cao độ và nghe so sánh A/B trực tiếp.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => (transport.isPlaying ? engine.pause() : engine.play())}
                  className="flex items-center gap-1.5 rounded-full bg-violet-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-violet-500"
                >
                  {transport.isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  <span>{transport.isPlaying ? 'Dừng' : 'Nghe A/B'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => engine.setABMode(transport.abMode === 'autotune' ? 'dry' : 'autotune')}
                  className="rounded-full border border-white/15 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/10"
                >
                  Đang phát: {transport.abMode === 'autotune' ? 'Auto-Tune (Wet)' : 'Giọng mộc (Dry)'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {AUTOTUNE_PRESETS.map((p) => {
                const active = project.autotune_settings.preset === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={tuning}
                    onClick={() => void handleSelectAutotunePreset(p)}
                    className={`rounded-2xl border p-3.5 text-left transition ${active
                      ? 'border-violet-500 bg-violet-600/20 text-white shadow-md shadow-violet-950/30'
                      : 'border-white/10 bg-[#16191f] text-slate-300 hover:border-white/25'
                      }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-bold">{p.label}</span>
                      {tuning && active && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">{p.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="flex items-center gap-2 rounded-full border border-white/15 px-5 py-2 text-sm text-slate-300 hover:bg-white/10"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Quay lại</span>
            </button>
            <button
              type="button"
              onClick={() => {
                engine.stopMetronome();
                setMetronomeOn(false);
                setStep(3);
              }}
              className="flex items-center gap-2 rounded-full bg-gradient-to-r from-violet-600 to-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-600/25 hover:brightness-110"
            >
              <span>Tiếp tục: Cấu hình Phối khí</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* STEP 3: Style & Multi-Agent Generate */}
      {step === 3 && (
        <section className="space-y-6 rounded-3xl border border-white/[0.08] bg-[#16191f] p-6 shadow-xl shadow-black/30">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="font-display text-xl font-bold text-white">
                Bước 3: Chọn phong cách &amp; AI Phối khí
              </h1>
              <p className="text-xs text-slate-400">
                Thiết lập tên bài hát, thể loại, cảm xúc và cấu trúc phối khí tự động.
              </p>
            </div>
            <div className="min-w-[220px]">
              <label htmlFor="create-song-title" className="sr-only">
                Tên bài hát
              </label>
              <input
                id="create-song-title"
                name="songTitle"
                type="text"
                value={project.title || ''}
                onChange={(e) =>
                  updateProject((prev) => ({
                    ...prev,
                    title: e.target.value,
                    config: { ...prev.config, title: e.target.value },
                  }))
                }
                placeholder="Đặt tên bài hát..."
                className="w-full rounded-full border border-white/10 bg-[#0b0d11] px-4 py-1.5 text-xs font-semibold text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-2">
              <span className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                1. Chế độ giai điệu
              </span>
              <div className="grid grid-cols-2 gap-2.5">
                {(
                  [
                    { id: 'preserve', title: 'Preserve Original', desc: 'Giữ nguyên giai điệu gốc' },
                    { id: 'enhance', title: 'AI Enhance', desc: 'AI trau chuốt mượt mà hơn' },
                  ] as Array<{ id: MelodyMode; title: string; desc: string }>
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() =>
                      updateProject((prev) => ({
                        ...prev,
                        config: { ...prev.config, melody_mode: opt.id },
                      }))
                    }
                    className={`rounded-2xl border p-3.5 text-left transition ${project.config.melody_mode === opt.id
                      ? 'border-violet-500 bg-violet-600/20 text-white'
                      : 'border-white/10 bg-[#1b1e25] text-slate-300 hover:border-white/25'
                      }`}
                  >
                    <p className="text-sm font-bold">{opt.title}</p>
                    <p className="text-[11px] text-slate-400">{opt.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <span className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                2. Phạm vi đầu ra
              </span>
              <div className="grid grid-cols-2 gap-2.5">
                {(
                  [
                    { id: 'accompaniment', title: 'Accompaniment Only', desc: 'Chỉ tạo nhạc đệm' },
                    { id: 'full_song', title: 'Full Song', desc: 'Intro - Verse - Chorus - Outro' },
                  ] as Array<{ id: OutputMode; title: string; desc: string }>
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() =>
                      updateProject((prev) => ({
                        ...prev,
                        config: { ...prev.config, output_mode: opt.id },
                      }))
                    }
                    className={`rounded-2xl border p-3.5 text-left transition ${project.config.output_mode === opt.id
                      ? 'border-emerald-500 bg-emerald-500/20 text-white'
                      : 'border-white/10 bg-[#1b1e25] text-slate-300 hover:border-white/25'
                      }`}
                  >
                    <p className="text-sm font-bold">{opt.title}</p>
                    <p className="text-[11px] text-slate-400">{opt.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {project.config.output_mode === 'accompaniment' && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-[#1b1e25] px-4 py-3">
              <div>
                <p className="text-xs font-semibold text-white">Độ dài Nhạc đệm (Accompaniment)</p>
                <p className="text-[11px] text-slate-400">
                  Mặc định khớp chính xác số ô nhịp câu ngân nga; có thể thêm Count-in &amp; Tail nhẹ đầu/cuối.
                </p>
              </div>
              <label
                htmlFor="create-countin-tail"
                className="flex cursor-pointer items-center gap-2 text-xs text-slate-200"
              >
                <input
                  id="create-countin-tail"
                  name="addCountInTail"
                  type="checkbox"
                  checked={Boolean(project.config.add_count_in_tail)}
                  onChange={(e) =>
                    updateProject((prev) => ({
                      ...prev,
                      config: { ...prev.config, add_count_in_tail: e.target.checked },
                    }))
                  }
                  className="rounded border-slate-600 bg-slate-800 accent-amber-400"
                />
                <span>Thêm 1 bar Count-in &amp; 1 bar Outro nhẹ</span>
              </label>
            </div>
          )}

          {project.config.output_mode === 'full_song' && (
            <div className="space-y-4 rounded-2xl border border-white/[0.08] bg-[#1b1e25] p-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <label htmlFor="create-motif-pos" className="text-xs font-medium text-slate-300">
                    Vị trí đặt mô-típ ngân nga:
                  </label>
                  <select
                    id="create-motif-pos"
                    name="motifPosition"
                    value={project.config.motif_position}
                    onChange={(e) =>
                      updateProject((prev) => ({
                        ...prev,
                        config: { ...prev.config, motif_position: e.target.value as MotifPosition },
                      }))
                    }
                    className="rounded-xl border border-white/10 bg-[#0b0d11] px-3 py-1.5 text-xs text-white"
                  >
                    <option value="chorus">Chorus (Mặc định)</option>
                    <option value="verse">Verse</option>
                    <option value="auto">Theo AI đề xuất</option>
                  </select>
                </div>
                <label
                  htmlFor="create-lead-karaoke"
                  className="flex cursor-pointer items-center gap-2 text-xs text-slate-300"
                >
                  <input
                    id="create-lead-karaoke"
                    name="enableLeadKaraoke"
                    type="checkbox"
                    checked={Boolean(project.config.enable_lead_karaoke)}
                    onChange={(e) =>
                      updateProject((prev) => ({
                        ...prev,
                        config: { ...prev.config, enable_lead_karaoke: e.target.checked },
                      }))
                    }
                    className="rounded border-slate-600 bg-slate-800 accent-amber-400"
                  />
                  <span>Bật Lead Karaoke Guide + Gợi ý lời</span>
                </label>
              </div>

              <div className="space-y-2 border-t border-white/[0.07] pt-3">
                <span className="text-xs font-medium text-slate-300">
                  Cấu trúc bài hát (Structure Preset):
                </span>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {(
                    [
                      {
                        id: 'short',
                        title: 'Ngắn: 4 đoạn',
                        desc: 'Intro → Verse 1 → Chorus → Outro',
                      },
                      {
                        id: 'standard',
                        title: 'Chuẩn: có Bridge',
                        desc: 'Intro → Verse 1 → Chorus → Verse 2 → Bridge → Chorus → Outro',
                      },
                    ] as Array<{ id: StructurePreset; title: string; desc: string }>
                  ).map((preset) => {
                    const active = (project.config.structure_preset ?? 'standard') === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() =>
                          updateProject((prev) => ({
                            ...prev,
                            config: { ...prev.config, structure_preset: preset.id },
                          }))
                        }
                        className={`rounded-xl border p-3 text-left transition ${active
                          ? 'border-emerald-500 bg-emerald-500/20 text-white'
                          : 'border-white/10 bg-[#16191f] text-slate-300 hover:border-white/25'
                          }`}
                      >
                        <p className="text-xs font-bold">{preset.title}</p>
                        <p className="mt-0.5 text-[11px] text-slate-400">{preset.desc}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Genre & Mood Chip Clouds */}
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <span className="mb-2 block text-xs font-semibold text-slate-400">
                Thể loại (Genre)
              </span>
              <div className="flex flex-wrap gap-2">
                {GENRES.map((g) => {
                  const theme = getGenreTheme(g);
                  const active = project.config.genre === g;
                  return (
                    <button
                      key={g}
                      type="button"
                      onClick={() =>
                        updateProject((prev) => ({
                          ...prev,
                          config: { ...prev.config, genre: g },
                        }))
                      }
                      className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${active
                        ? 'bg-violet-600 text-white shadow-md shadow-violet-600/25'
                        : 'border border-white/10 bg-[#1b1e25] text-slate-300 hover:bg-white/10'
                        }`}
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: `linear-gradient(135deg, ${theme.from}, ${theme.to})` }}
                      />
                      {g}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <span className="mb-2 block text-xs font-semibold text-slate-400">
                Cảm xúc (Mood)
              </span>
              <div className="flex flex-wrap gap-2">
                {MOODS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() =>
                      updateProject((prev) => ({
                        ...prev,
                        config: { ...prev.config, mood: m },
                      }))
                    }
                    className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${project.config.mood === m
                      ? 'bg-emerald-500 text-slate-950'
                      : 'border border-white/10 bg-[#1b1e25] text-slate-300 hover:bg-white/10'
                      }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="create-prompt-textarea" className="text-xs font-semibold text-slate-400">
                Mô tả ý tưởng phối khí cho AI (tùy chọn)
              </label>
              <span className="text-[11px] tabular-nums text-slate-500">
                {project.config.user_prompt.length} / 500
              </span>
            </div>
            <textarea
              id="create-prompt-textarea"
              name="userPrompt"
              rows={3}
              maxLength={500}
              value={project.config.user_prompt}
              onChange={(e) =>
                updateProject((prev) => ({
                  ...prev,
                  config: { ...prev.config, user_prompt: e.target.value.slice(0, 500) },
                }))
              }
              placeholder="Ví dụ: Mở đầu bằng tiếng piano nhẹ, vào điệp khúc trống Pop dồn dập và bass ấm..."
              className="w-full rounded-2xl border border-white/10 bg-[#1b1e25] p-3.5 text-sm text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none"
            />
          </div>

          {/* SSE Multi-Agent Progress Panel */}
          {(isGenerating || agentLogs.length > 0) && (
            <div className="space-y-3 rounded-2xl border border-violet-500/35 bg-[#151829] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {isGenerating ? (
                    <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
                  ) : (
                    <Activity className="h-4 w-4 text-emerald-400" />
                  )}
                  <span className="text-sm font-bold text-white tabular-nums">
                    AI Producer đang phối khí ({jobProgress}%)
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {isGenerating && (
                    <span className="font-mono text-xs tabular-nums text-amber-300">
                      Timeout: {countdownSec}s
                    </span>
                  )}
                  {isGenerating && (
                    <button
                      type="button"
                      onClick={() => void handleCancelJob()}
                      className="flex items-center gap-1 rounded-full bg-rose-600/20 px-3 py-1 text-xs font-semibold text-rose-300 hover:bg-rose-600/35"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      <span>Hủy</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="h-2 w-full overflow-hidden rounded-full bg-[#0b0d11]">
                <div
                  className="h-full bg-gradient-to-r from-violet-500 via-indigo-400 to-cyan-400 transition-all duration-300"
                  style={{ width: `${jobProgress}%` }}
                />
              </div>

              <div className="max-h-36 space-y-1.5 overflow-y-auto text-xs">
                {agentLogs.map((log, i) => (
                  <div key={i} className="flex items-center gap-2 text-slate-300">
                    <span className="rounded-md bg-white/10 px-2 py-0.5 font-mono text-[10px] text-violet-300">
                      {log.agent || log.type}
                    </span>
                    <span>{log.message || log.step || log.warning || log.error}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-between">
            <button
              type="button"
              disabled={isGenerating}
              onClick={() => setStep(2)}
              className="flex items-center gap-2 rounded-full border border-white/15 px-5 py-2 text-sm text-slate-300 hover:bg-white/10 disabled:opacity-40"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Quay lại</span>
            </button>
            <button
              type="button"
              disabled={isGenerating}
              onClick={() => void handleStartGenerate()}
              className="flex items-center gap-2 rounded-full bg-gradient-to-r from-violet-600 via-indigo-600 to-cyan-500 px-7 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-600/30 transition hover:brightness-110 disabled:opacity-50"
            >
              <Wand2 className="h-4 w-4" />
              <span>{isGenerating ? 'Đang phối khí...' : 'Tạo nhạc bằng AI'}</span>
            </button>
          </div>
        </section>
      )}

      {/* STEP 4: Release Preview & Handoff to DAW */}
      {step === 4 && (
        <section className="space-y-6 rounded-3xl border border-white/[0.08] bg-[#16191f] p-6 shadow-xl shadow-black/30">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <TrackArtwork
                title={project.title}
                genre={project.config.genre}
                seed={project.project_id}
                size="md"
                isPlaying={transport.isPlaying}
              />
              <div>
                <h1 className="font-display text-xl font-bold text-white">
                  {project.title || 'Bản phối hoàn chỉnh'}
                </h1>
                <p className="text-xs text-slate-400">
                  {project.config.genre} • {project.analysis.bpm} BPM •{' '}
                  {project.analysis.detected_key} {project.analysis.detected_scale}
                </p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1 text-xs font-medium text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" />
              QA {project.qa_status.approved ? 'Approved' : 'Completed'} ({project.qa_status.iterations}{' '}
              vòng)
            </span>
          </div>

          {(jobWarning || project.qa_status.fallback_used) && (
            <div className="flex items-start gap-2.5 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <p>
                {jobWarning ||
                  'Hệ thống đã dùng Best-effort Fallback sau tối đa 2 vòng QA. Bạn có thể tinh chỉnh thêm trong Studio.'}
              </p>
            </div>
          )}

          {/* 4-Layer Comparison Bar */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {(
              [
                { id: 'dry', label: 'Giọng mộc + Beat', desc: 'Dry vocal gắn trực tiếp nền beat' },
                { id: 'autotune', label: 'Auto-Tune + Beat', desc: 'Giọng đã chỉnh phô + beat' },
                { id: 'preserve', label: 'Bản Preserve', desc: 'Giữ nguyên giai điệu gốc (Lead tắt)' },
                { id: 'enhance', label: 'Bản Enhance', desc: 'Phát triển Lead + hòa âm dày hơn' },
              ] as const
            ).map((layer) => (
              <button
                key={layer.id}
                type="button"
                onClick={() => handleSwitchPreviewLayer(layer.id)}
                className={`rounded-2xl border p-3.5 text-left transition ${previewLayer === layer.id
                  ? 'border-violet-500 bg-violet-600/20 text-white shadow-md shadow-violet-950/30'
                  : 'border-white/10 bg-[#1b1e25] text-slate-300 hover:border-white/25'
                  }`}
              >
                <p className="text-sm font-bold">{layer.label}</p>
                <p className="mt-0.5 text-[11px] text-slate-400">{layer.desc}</p>
              </button>
            ))}
          </div>

          {(previewLayer === 'preserve' || previewLayer === 'enhance') &&
            previewLayer !== project.config.melody_mode && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-500/35 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-100">
                <span>
                  Đang nghe thử đối chiếu góc độ mix{' '}
                  <strong>{previewLayer === 'enhance' ? 'AI Enhance' : 'Preserve Original'}</strong>. Bấm tạo
                  lại nếu muốn AI viết lại toàn bộ MIDI theo chế độ này trước khi vào Studio.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    updateProject((prev) => ({
                      ...prev,
                      config: { ...prev.config, melody_mode: previewLayer },
                    }));
                    setStep(3);
                  }}
                  className="shrink-0 rounded-full bg-amber-500 px-3 py-1 text-[11px] font-bold text-slate-950 hover:bg-amber-400"
                >
                  Đặt làm chế độ chính &amp; Tạo lại MIDI
                </button>
              </div>
            )}

          {/* Interactive Waveform Transport Player */}
          <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-[#1b1e25] p-4">
            <div className="relative h-14 overflow-hidden rounded-xl border border-white/[0.06] bg-[#0b0d11] px-2 py-1.5">
              <WaveformClipCanvas
                peaks={previewPeaks}
                seed={`${project.project_id}:${previewLayer}`}
                color="rgba(139, 92, 246, 0.72)"
                playedColor="rgba(34, 211, 238, 0.95)"
                playProgress={
                  transport.durationSec > 0 ? transport.currentTimeSec / transport.durationSec : 0
                }
              />
              <input
                id="create-preview-scrub"
                name="previewScrub"
                type="range"
                aria-label="Tua đoạn nghe thử"
                min={0}
                max={Math.max(0.1, transport.durationSec)}
                step={0.05}
                value={Math.min(Math.max(0.1, transport.durationSec), transport.currentTimeSec)}
                onChange={(e) => engine.seek(Number(e.target.value))}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label={transport.isPlaying ? 'Tạm dừng nghe thử' : 'Phát nghe thử'}
                  onClick={() => (transport.isPlaying ? engine.pause() : engine.play())}
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-slate-950 shadow-md transition hover:scale-105"
                >
                  {transport.isPlaying ? (
                    <Pause className="h-5 w-5 fill-current" />
                  ) : (
                    <Play className="ml-0.5 h-5 w-5 fill-current" />
                  )}
                </button>
                <button
                  type="button"
                  aria-label="Dừng nghe thử"
                  onClick={() => engine.stop()}
                  className="rounded-full border border-white/15 p-2.5 text-slate-300 hover:bg-white/10"
                >
                  <Square className="h-4 w-4" />
                </button>
                <div className="font-mono text-xs tabular-nums text-slate-300">
                  {transport.currentTimeSec.toFixed(1)}s / {transport.durationSec.toFixed(1)}s
                </div>
              </div>

              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Volume2 className="h-4 w-4 text-emerald-400" />
                <span>Master Limiter: {project.mastering.limiter_ceiling_db} dBFS</span>
              </div>
            </div>
          </div>

          {/* Primary Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                disabled={exportingFormat !== null}
                onClick={() => void handleQuickExport('mp3')}
                className="flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-4 py-2.5 text-sm font-medium text-white hover:bg-white/10 disabled:opacity-50"
              >
                <Download className="h-4 w-4 text-emerald-400" />
                <span>{exportingFormat === 'mp3' ? 'Đang xuất MP3...' : 'Tải nhanh MP3'}</span>
              </button>
              <button
                type="button"
                disabled={exportingFormat !== null}
                onClick={() => void handleQuickExport('wav')}
                className="flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-4 py-2.5 text-sm font-medium text-white hover:bg-white/10 disabled:opacity-50"
              >
                <Download className="h-4 w-4 text-violet-400" />
                <span>{exportingFormat === 'wav' ? 'Đang xuất WAV...' : 'Tải nhanh WAV'}</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => navigate(`/studio/${encodeURIComponent(project.project_id)}`)}
              className="flex items-center gap-2 rounded-full bg-gradient-to-r from-violet-600 via-indigo-600 to-cyan-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-600/30 transition hover:brightness-110"
            >
              <Sliders className="h-4 w-4" />
              <span>Mở trong Phòng thu DAW</span>
              <Sparkles className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
