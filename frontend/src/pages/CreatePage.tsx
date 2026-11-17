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
import { useProjectSession } from '@/components/providers/ProjectProvider';
import type {
  AutoTunePreset,
  AutotuneSettings,
  JobSSEEvent,
  MelodyMode,
  MotifPosition,
  OutputMode,
  ProjectState,
} from '@/types/project';

const GENRES = ['Pop', 'Ballad', 'Lo-fi', 'R&B', 'Hip-hop', 'EDM', 'Acoustic', 'Rock'];
const MOODS = ['Uplifting', 'Emotional', 'Chill', 'Energetic', 'Melancholic', 'Romantic'];
const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SCALES = ['major', 'minor', 'pentatonic_major', 'pentatonic_minor'];

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
  const [isRecording, setIsRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [countInEnabled, setCountInEnabled] = useState(true);
  const [countInBeat, setCountInBeat] = useState<number | null>(null);
  const [vuLevel, setVuLevel] = useState(0);
  const [enableDenoise, setEnableDenoise] = useState(true);
  const [autoTrim, setAutoTrim] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [denoising, setDenoising] = useState(false);
  const [fileMeta, setFileMeta] = useState<{ name: string; durationSec?: number; warning?: string } | null>(null);
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

  useEffect(() => {
    const unsub = engine.subscribe(setTransport);
    return () => {
      unsub();
      engine.stopMetronome();
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

        const currentId = latestProjectRef.current.project_id;
        await engine.loadAudioFromBlob('raw', blob);
        await saveAudioBlob(currentId, 'raw_input', blob);

        const uploadRes = await uploadAudio(blob, filename, currentId);
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
    [autoTrim, enableDenoise, engine, updateProject]
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      // Setup live VU meter
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateVu = () => {
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        setVuLevel(Math.min(100, Math.round((avg / 128) * 100)));
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
      setIsRecording(true);
      setRecordSec(0);
      recordTimerRef.current = window.setInterval(() => {
        setRecordSec((s) => s + 1);
      }, 1000);
    } catch {
      setStepError(
        'Trình duyệt từ chối quyền Microphone. Hãy cấp quyền Micro trên thanh địa chỉ hoặc chuyển sang tab Upload File.'
      );
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
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
    if (!project.audio_assets.dry_denoised_ref && !project.audio_assets.raw_input_ref) return;
    setAnalyzing(true);
    setStepError(null);
    try {
      const sourceRef =
        project.audio_assets.dry_denoised_ref || project.audio_assets.raw_input_ref || '';
      const res = await analyzeAudio({
        project_id: project.project_id,
        source_ref: sourceRef,
      });
      updateProject((prev) => ({
        ...prev,
        analysis: {
          bpm: res.bpm,
          time_signature: res.time_signature || prev.analysis.time_signature || '4/4',
          detected_key: res.key,
          detected_scale: res.scale,
          key_confidence: res.key_confidence ?? 0.85,
          bars: res.bars ?? Math.max(4, Math.round(((fileMeta?.durationSec || 8) * res.bpm) / 240)),
          raw_melody_midi: res.raw_melody_midi || [],
        },
        autotune_settings: prev.autotune_settings.auto_follow_project_key
          ? { ...prev.autotune_settings, key: res.key, scale: res.scale }
          : prev.autotune_settings,
      }));
      engine.setBpm(res.bpm);
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
        analysis: { ...prev.analysis, bpm: computedBpm },
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
    const nextSettings: AutotuneSettings = {
      ...current.autotune_settings,
      enabled: preset.id !== 'off',
      preset: preset.id,
      key: current.analysis.detected_key,
      scale: current.analysis.detected_scale,
      retune_speed_ms: preset.retune_speed_ms,
      humanize: preset.humanize,
      mix_percent: preset.mix_percent,
    };

    updateProject((prev) => ({ ...prev, autotune_settings: nextSettings }));

    if (preset.id === 'off') {
      engine.setABMode('dry');
      return;
    }

    setTuning(true);
    setStepError(null);
    try {
      const res = await autotuneAudio({
        project_id: current.project_id,
        autotune_settings: nextSettings,
      });
      const latest = latestProjectRef.current;
      const updated: ProjectState = {
        ...latest,
        autotune_settings: nextSettings,
        audio_assets: { ...latest.audio_assets, tuned_vocal_ref: res.tuned_vocal_ref },
      };
      updateProject((prev) => ({
        ...prev,
        autotune_settings: nextSettings,
        audio_assets: { ...prev.audio_assets, tuned_vocal_ref: res.tuned_vocal_ref },
      }));
      await engine.syncFromProject(updated, { forceSlots: ['autotune'] });
      engine.setABMode('autotune');
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
      const blob = await exportAudio(project.project_id, format, true, exportMode);
      const safeName = (project.title || project.project_id).replace(/[^a-zA-Z0-9_-]/g, '_');
      triggerBlobDownload(blob, `${safeName}.${format}`);
    } catch (err) {
      setStepError(err instanceof ApiError ? err.detail : `Lỗi xuất file ${format.toUpperCase()}.`);
    } finally {
      setExportingFormat(null);
    }
  };

  const hasAudioInput = Boolean(project.audio_assets.raw_input_ref || engine.hasBuffer('raw'));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* 4-Step Stepper */}
      <nav aria-label="Wizard Steps" className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        {STEPS.map((s) => {
          const isCurrent = step === s.num;
          const isDone = step > s.num;
          const clickable = s.num <= step || (s.num === 2 && hasAudioInput);
          return (
            <button
              key={s.num}
              type="button"
              disabled={!clickable}
              onClick={() => clickable && setStep(s.num)}
              className={`flex items-center gap-3 rounded-xl border p-3 text-left transition ${
                isCurrent
                  ? 'border-indigo-500 bg-indigo-600/15 text-white'
                  : isDone
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15'
                  : 'border-slate-800 bg-[#121622] text-slate-400 disabled:opacity-50'
              }`}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  isCurrent
                    ? 'bg-indigo-500 text-white'
                    : isDone
                    ? 'bg-emerald-500 text-slate-950'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {isDone ? <Check className="h-4 w-4" /> : s.num}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold">{s.title}</p>
                <p className="truncate text-[11px] text-slate-400">{s.sub}</p>
              </div>
            </button>
          );
        })}
      </nav>

      {stepError && (
        <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5 text-sm text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <p>{stepError}</p>
        </div>
      )}

      {/* STEP 1: Input & Dry Check */}
      {step === 1 && (
        <section className="space-y-6 rounded-2xl border border-slate-800 bg-[#121622] p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-white">Bước 1: Nhập giai điệu & Kiểm tra Giọng mộc</h1>
              <p className="text-xs text-slate-400">
                Hỗ trợ WAV, MP3, M4A, OGG, FLAC (tối thiểu 3 giây, tối đa 50 MB).
              </p>
            </div>
            <div className="inline-flex rounded-xl border border-slate-800 bg-[#0b0d14] p-1">
              <button
                type="button"
                onClick={() => setInputMode('mic')}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  inputMode === 'mic' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Mic className="h-3.5 w-3.5" />
                Ghi âm Mic
              </button>
              <button
                type="button"
                onClick={() => setInputMode('upload')}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  inputMode === 'upload' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Upload className="h-3.5 w-3.5" />
                Upload File
              </button>
            </div>
          </div>

          {inputMode === 'mic' ? (
            <div className="rounded-xl border border-slate-800 bg-[#171c2b] p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={countInEnabled}
                    onChange={(e) => setCountInEnabled(e.target.checked)}
                    className="rounded border-slate-600 bg-slate-800 text-indigo-500"
                  />
                  <span>Đếm nhịp 1 ô nhịp trước khi thu (Count-in Metronome)</span>
                </label>
                <span className="font-mono text-sm font-semibold text-indigo-300">
                  {countInBeat !== null
                    ? `Đếm nhịp: ${countInBeat} / 4`
                    : isRecording
                    ? `Đang thu: 00:${String(recordSec).padStart(2, '0')}`
                    : 'Sẵn sàng thu'}
                </span>
              </div>

              {/* VU Meter */}
              <div className="h-3 w-full overflow-hidden rounded-full bg-slate-900">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 via-amber-400 to-rose-500 transition-all duration-75"
                  style={{ width: `${vuLevel}%` }}
                />
              </div>

              <div className="flex items-center gap-3">
                {!isRecording ? (
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => void startRecording()}
                    className="flex items-center gap-2 rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
                  >
                    <Mic className="h-4 w-4" />
                    <span>Bắt đầu Ghi âm</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={stopRecording}
                    className="flex items-center gap-2 rounded-xl bg-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-white"
                  >
                    <Square className="h-4 w-4 fill-current" />
                    <span>Dừng thu</span>
                  </button>
                )}
                {uploading && (
                  <span className="flex items-center gap-2 text-xs text-indigo-300">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Đang tải lên & lọc ồn AI Denoise...
                  </span>
                )}
              </div>
            </div>
          ) : (
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-700 bg-[#171c2b] p-8 text-center transition hover:border-indigo-500">
              <FileAudio className="h-10 w-10 text-indigo-400" />
              <p className="mt-3 text-sm font-medium text-white">
                Bấm để chọn file hoặc kéo thả vào đây
              </p>
              <p className="mt-1 text-xs text-slate-400">WAV, MP3, M4A, OGG, FLAC • Tối đa 50 MB</p>
              <input
                type="file"
                accept=".wav,.mp3,.m4a,.ogg,.flac,audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFileUpload(f);
                }}
              />
            </label>
          )}

          {/* Denoise & Dry Check Controls */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-[#161b29] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white">Tiền xử lý AI Denoise & Trim</span>
                <button
                  type="button"
                  disabled={!hasAudioInput || denoising}
                  onClick={() => void handleRerunDenoise()}
                  className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-indigo-300 hover:bg-slate-800 disabled:opacity-40"
                >
                  {denoising ? 'Đang lọc...' : 'Áp dụng lại'}
                </button>
              </div>
              <label className="flex items-center justify-between text-xs text-slate-300">
                <span>Bật AI Denoise (lọc ồn nền)</span>
                <input
                  type="checkbox"
                  checked={enableDenoise}
                  onChange={(e) => setEnableDenoise(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500"
                />
              </label>
              <label className="flex items-center justify-between text-xs text-slate-300">
                <span>AI Auto-Trim (cắt khoảng lặng đầu/cuối)</span>
                <input
                  type="checkbox"
                  checked={autoTrim}
                  onChange={(e) => setAutoTrim(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500"
                />
              </label>
            </div>

            {/* Dry Check A/B Player */}
            <div className="rounded-xl border border-slate-800 bg-[#161b29] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white">Kiểm tra Giọng mộc (Dry Check)</span>
                {fileMeta && (
                  <span className="text-xs text-emerald-400">
                    {fileMeta.name} ({(fileMeta.durationSec || 0).toFixed(1)}s)
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!hasAudioInput}
                  onClick={() => (transport.isPlaying ? engine.pause() : engine.play())}
                  className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
                >
                  {transport.isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  <span>{transport.isPlaying ? 'Tạm dừng' : 'Nghe thử'}</span>
                </button>
                <button
                  type="button"
                  disabled={!hasAudioInput}
                  onClick={() => engine.setABMode('raw')}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium border ${
                    transport.abMode === 'raw'
                      ? 'border-amber-500 bg-amber-500/20 text-amber-200'
                      : 'border-slate-700 text-slate-400'
                  }`}
                >
                  Giọng mộc gốc
                </button>
                <button
                  type="button"
                  disabled={!hasAudioInput}
                  onClick={() => engine.setABMode('dry')}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium border ${
                    transport.abMode === 'dry'
                      ? 'border-emerald-500 bg-emerald-500/20 text-emerald-200'
                      : 'border-slate-700 text-slate-400'
                  }`}
                >
                  Đã lọc ồn (Denoised)
                </button>
              </div>
              {fileMeta?.warning && (
                <p className="text-xs text-amber-300">{fileMeta.warning}</p>
              )}
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              disabled={!hasAudioInput || uploading || denoising}
              onClick={() => void goToStep2AndAnalyze()}
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              <span>Tiếp tục: Phân tích & Auto-Tune</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* STEP 2: Analyze & Auto-Tune Quick Bar */}
      {step === 2 && (
        <section className="space-y-6 rounded-2xl border border-slate-800 bg-[#121622] p-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-white">Bước 2: Phân tích Giai điệu & Auto-Tune nhanh</h1>
              <p className="text-xs text-slate-400">
                Kiểm tra BPM, Key/Scale và chỉnh phô bằng 4 mức Quick Presets.
              </p>
            </div>
            {analyzing && (
              <span className="flex items-center gap-2 text-xs text-indigo-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                Đang trích xuất BPM, Key & Pitch MIDI...
              </span>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {/* BPM + Tap Tempo + Metronome */}
            <div className="rounded-xl border border-slate-800 bg-[#171c2b] p-4 space-y-2.5">
              <label className="text-xs font-medium text-slate-400">Tempo (BPM: 40–220)</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={40}
                  max={220}
                  value={project.analysis.bpm}
                  onChange={(e) => {
                    const val = Math.max(40, Math.min(220, Number(e.target.value) || 100));
                    updateProject((prev) => ({
                      ...prev,
                      analysis: { ...prev.analysis, bpm: val },
                    }));
                    engine.setBpm(val);
                  }}
                  className="w-24 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm font-bold text-white"
                />
                <button
                  type="button"
                  onClick={handleTapTempo}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
                >
                  Tap Tempo
                </button>
                <button
                  type="button"
                  onClick={toggleMetronome}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                    metronomeOn
                      ? 'bg-emerald-600 text-white'
                      : 'border border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {metronomeOn ? 'Tắt Click' : 'Metronome'}
                </button>
              </div>
            </div>

            {/* Key / Scale */}
            <div className="rounded-xl border border-slate-800 bg-[#171c2b] p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-slate-400">Key / Scale</label>
                {(project.analysis.key_confidence ?? 1) < 0.6 && (
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">
                    Gợi ý (độ tin cậy thấp)
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <select
                  value={project.analysis.detected_key}
                  onChange={(e) =>
                    updateProject((prev) => ({
                      ...prev,
                      analysis: { ...prev.analysis, detected_key: e.target.value },
                    }))
                  }
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-white"
                >
                  {KEYS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <select
                  value={project.analysis.detected_scale}
                  onChange={(e) =>
                    updateProject((prev) => ({
                      ...prev,
                      analysis: { ...prev.analysis, detected_scale: e.target.value },
                    }))
                  }
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-white"
                >
                  {SCALES.map((sc) => (
                    <option key={sc} value={sc}>
                      {sc}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Bars & Notes */}
            <div className="rounded-xl border border-slate-800 bg-[#171c2b] p-4 space-y-1.5">
              <p className="text-xs font-medium text-slate-400">Cấu trúc phát hiện</p>
              <p className="text-lg font-bold text-white">
                {project.analysis.bars || 8} ô nhịp ({project.analysis.time_signature})
              </p>
              <p className="text-xs text-slate-400">
                {project.analysis.raw_melody_midi.length} nốt MIDI trích xuất
              </p>
            </div>
          </div>

          {/* Auto-Tune Quick Bar */}
          <div className="rounded-xl border border-slate-800 bg-[#171c2b] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-white">Auto-Tune Quick Bar</h2>
                <p className="text-xs text-slate-400">
                  Chọn mức chỉnh cao độ và nghe so sánh A/B ngay lập tức.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => (transport.isPlaying ? engine.pause() : engine.play())}
                  className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                >
                  {transport.isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  <span>{transport.isPlaying ? 'Dừng' : 'Nghe A/B'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => engine.setABMode(transport.abMode === 'autotune' ? 'dry' : 'autotune')}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
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
                    className={`rounded-xl border p-3.5 text-left transition ${
                      active
                        ? 'border-indigo-500 bg-indigo-600/20 text-white'
                        : 'border-slate-700 bg-[#121622] text-slate-300 hover:border-slate-600'
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
              className="flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
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
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              <span>Tiếp tục: Cấu hình Phối khí</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* STEP 3: Style & Multi-Agent Generate */}
      {step === 3 && (
        <section className="space-y-6 rounded-2xl border border-slate-800 bg-[#121622] p-6">
          <div>
            <h1 className="text-xl font-bold text-white">Bước 3: Cấu hình AI & Phối khí Multi-Agent</h1>
            <p className="text-xs text-slate-400">
              Chọn cách xử lý giai điệu, phạm vi bài hát, thể loại và theo dõi tiến trình Agent theo thời gian thực.
            </p>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            {/* Melody Mode */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                1. Chế độ giai điệu
              </label>
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
                    className={`rounded-xl border p-3 text-left ${
                      project.config.melody_mode === opt.id
                        ? 'border-indigo-500 bg-indigo-600/20 text-white'
                        : 'border-slate-700 bg-[#171c2b] text-slate-300'
                    }`}
                  >
                    <p className="text-sm font-semibold">{opt.title}</p>
                    <p className="text-[11px] text-slate-400">{opt.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Output Mode */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                2. Phạm vi đầu ra
              </label>
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
                    className={`rounded-xl border p-3 text-left ${
                      project.config.output_mode === opt.id
                        ? 'border-emerald-500 bg-emerald-600/20 text-white'
                        : 'border-slate-700 bg-[#171c2b] text-slate-300'
                    }`}
                  >
                    <p className="text-sm font-semibold">{opt.title}</p>
                    <p className="text-[11px] text-slate-400">{opt.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Full Song extra options */}
          {project.config.output_mode === 'full_song' && (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-[#171c2b] p-4">
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium text-slate-300">Vị trí đặt mô-típ ngân nga:</span>
                <select
                  value={project.config.motif_position}
                  onChange={(e) =>
                    updateProject((prev) => ({
                      ...prev,
                      config: { ...prev.config, motif_position: e.target.value as MotifPosition },
                    }))
                  }
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white"
                >
                  <option value="chorus">Chorus (Mặc định)</option>
                  <option value="verse">Verse</option>
                  <option value="auto">Theo AI đề xuất</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={Boolean(project.config.enable_lead_karaoke)}
                  onChange={(e) =>
                    updateProject((prev) => ({
                      ...prev,
                      config: { ...prev.config, enable_lead_karaoke: e.target.checked },
                    }))
                  }
                  className="rounded border-slate-600 bg-slate-800 text-indigo-500"
                />
                <span>Bật Lead Karaoke Guide + Gợi ý lời</span>
              </label>
            </div>
          )}

          {/* Genre, Mood & Prompt */}
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-400">Thể loại (Genre)</label>
              <div className="flex flex-wrap gap-2">
                {GENRES.map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() =>
                      updateProject((prev) => ({
                        ...prev,
                        config: { ...prev.config, genre: g },
                      }))
                    }
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      project.config.genre === g
                        ? 'bg-indigo-600 text-white'
                        : 'border border-slate-700 bg-[#171c2b] text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-400">Cảm xúc (Mood)</label>
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
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      project.config.mood === m
                        ? 'bg-emerald-600 text-white'
                        : 'border border-slate-700 bg-[#171c2b] text-slate-300 hover:bg-slate-800'
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
              <label className="text-xs font-semibold text-slate-400">
                Mô tả thêm cho AI (Prompt — tùy chọn)
              </label>
              <span className="text-[11px] text-slate-500">
                {project.config.user_prompt.length} / 500
              </span>
            </div>
            <textarea
              rows={3}
              maxLength={500}
              value={project.config.user_prompt}
              onChange={(e) =>
                updateProject((prev) => ({
                  ...prev,
                  config: { ...prev.config, user_prompt: e.target.value.slice(0, 500) },
                }))
              }
              placeholder="Ví dụ: Thêm tiếng piano nhẹ ở đầu, bass ấm và trống pop nhẹ nhàng..."
              className="w-full rounded-xl border border-slate-700 bg-[#171c2b] p-3 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {/* SSE Multi-Agent Progress Panel */}
          {(isGenerating || agentLogs.length > 0) && (
            <div className="rounded-xl border border-indigo-500/30 bg-[#151a2b] p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {isGenerating ? (
                    <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
                  ) : (
                    <Activity className="h-4 w-4 text-emerald-400" />
                  )}
                  <span className="text-sm font-semibold text-white">
                    Tiến trình Multi-Agent ({jobProgress}%)
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {isGenerating && (
                    <span className="font-mono text-xs text-amber-300">
                      Timeout: {countdownSec}s
                    </span>
                  )}
                  {isGenerating && (
                    <button
                      type="button"
                      onClick={() => void handleCancelJob()}
                      className="flex items-center gap-1 rounded-lg bg-rose-600/20 px-3 py-1 text-xs font-semibold text-rose-300 hover:bg-rose-600/30"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      <span>Hủy (Cancel)</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-900">
                <div
                  className="h-full bg-gradient-to-r from-indigo-500 to-emerald-500 transition-all duration-300"
                  style={{ width: `${jobProgress}%` }}
                />
              </div>

              <div className="max-h-36 space-y-1.5 overflow-y-auto text-xs">
                {agentLogs.map((log, i) => (
                  <div key={i} className="flex items-center gap-2 text-slate-300">
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300">
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
              className="flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Quay lại</span>
            </button>
            <button
              type="button"
              disabled={isGenerating}
              onClick={() => void handleStartGenerate()}
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-emerald-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 hover:opacity-95 disabled:opacity-50"
            >
              <Wand2 className="h-4 w-4" />
              <span>{isGenerating ? 'Đang phối khí...' : 'Tạo nhạc bằng AI'}</span>
            </button>
          </div>
        </section>
      )}

      {/* STEP 4: Quick Preview & Handoff to Studio */}
      {step === 4 && (
        <section className="space-y-6 rounded-2xl border border-slate-800 bg-[#121622] p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-white">Bước 4: Nghe thử nhanh & Chuyển vào Studio</h1>
              <p className="text-xs text-slate-400">
                So sánh trực tiếp 4 lớp âm thanh với Master Limiter (&le; -1.0 dBFS).
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" />
              QA {project.qa_status.approved ? 'Approved' : 'Completed'} ({project.qa_status.iterations}{' '}
              vòng)
            </span>
          </div>

          {(jobWarning || project.qa_status.fallback_used) && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200">
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
                { id: 'dry', label: 'Giọng mộc + Beat', desc: 'Dry vocal + nhạc đệm' },
                { id: 'autotune', label: 'Auto-Tune + Beat', desc: 'Giọng chỉnh phô + beat' },
                { id: 'preserve', label: 'Bản Preserve', desc: 'Bám sát giai điệu gốc' },
                { id: 'enhance', label: 'Bản Enhance', desc: 'AI phát triển giai điệu' },
              ] as const
            ).map((layer) => (
              <button
                key={layer.id}
                type="button"
                onClick={() => handleSwitchPreviewLayer(layer.id)}
                className={`rounded-xl border p-3.5 text-left transition ${
                  previewLayer === layer.id
                    ? 'border-indigo-500 bg-indigo-600/20 text-white'
                    : 'border-slate-700 bg-[#171c2b] text-slate-300 hover:border-slate-600'
                }`}
              >
                <p className="text-sm font-semibold">{layer.label}</p>
                <p className="mt-0.5 text-[11px] text-slate-400">{layer.desc}</p>
              </button>
            ))}
          </div>

          {/* Transport Player */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-[#171c2b] p-4">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => (transport.isPlaying ? engine.pause() : engine.play())}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-indigo-600 text-white hover:bg-indigo-500"
              >
                {transport.isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
              </button>
              <button
                type="button"
                onClick={() => engine.stop()}
                className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800"
              >
                <Square className="h-4 w-4" />
              </button>
              <div className="font-mono text-xs text-slate-300">
                {transport.currentTimeSec.toFixed(1)}s / {transport.durationSec.toFixed(1)}s
              </div>
            </div>

            <div className="flex items-center gap-3 text-xs text-slate-400">
              <Volume2 className="h-4 w-4 text-emerald-400" />
              <span>Limiter Ceiling: {project.mastering.limiter_ceiling_db} dBFS</span>
            </div>
          </div>

          {/* Primary Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                disabled={exportingFormat !== null}
                onClick={() => void handleQuickExport('mp3')}
                className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
              >
                <Download className="h-4 w-4 text-emerald-400" />
                <span>{exportingFormat === 'mp3' ? 'Đang xuất MP3...' : 'Tải nhanh MP3'}</span>
              </button>
              <button
                type="button"
                disabled={exportingFormat !== null}
                onClick={() => void handleQuickExport('wav')}
                className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
              >
                <Download className="h-4 w-4 text-indigo-400" />
                <span>{exportingFormat === 'wav' ? 'Đang xuất WAV...' : 'Tải nhanh WAV'}</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => navigate(`/studio/${encodeURIComponent(project.project_id)}`)}
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-emerald-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 hover:opacity-95"
            >
              <Sliders className="h-4 w-4" />
              <span>Mở trong Hybrid Studio</span>
              <Sparkles className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
