import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Circle,
  Download,
  FileArchive,
  FolderTree,
  Grid3X3,
  Maximize2,
  Mic,
  Minimize2,
  Music,
  Pause,
  Play,
  Plus,
  Redo2,
  Repeat,
  Save,
  Scissors,
  SkipBack,
  Sliders,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';
import {
  ApiError,
  autoMixProject,
  autoTrimVocal,
  autotuneAudio,
  cancelJob,
  denoiseAudio,
  exportAimusic,
  exportAudio,
  exportMidi,
  getProject,
  overdubFitCheck,
  rearrangeChordsJob,
  regenerateTrackJob,
  startGenerateJob,
  subscribeJobEvents,
  suggestLyrics,
  syncProject,
  triggerBlobDownload,
  uploadAudio,
  uploadTrackClip,
} from '@/lib/api/client';
import {
  encodeBlobToWav,
  getAudioEngine,
  type TransportSnapshot,
  type VocalABMode,
} from '@/lib/audio/player';
import {
  CHORD_PROGRESSIONS,
  DAW_TEMPLATES,
  GENRES,
  MOODS,
  buildProjectFromTemplate,
  generateBassFromChords,
  generateDrumPattern,
  generateHarmonyFromChords,
  getBeatsPerBar,
  type DrumGrooveStyle,
} from '@/lib/music/presets';
import { getAudioBlob, getDraft, markDraftSaved, saveAudioBlob } from '@/lib/storage/indexeddb';
import { useProjectSession } from '@/components/providers/ProjectProvider';
import ConsoleMixerPanel from '@/components/studio/ConsoleMixerPanel';
import PianoRollEditor from '@/components/studio/PianoRollEditor';
import QuickStudioView from '@/components/studio/QuickStudioView';
import StepSequencer from '@/components/studio/StepSequencer';
import TimelineEditor from '@/components/studio/TimelineEditor';
import type {
  AudioClip,
  AutoTunePreset,
  AutotuneSettings,
  ChordEvent,
  CoachSuggestedAction,
  LyricLine,
  MelodyMode,
  MotifPosition,
  OneClickFix,
  OutputMode,
  ProjectState,
  StructurePreset,
} from '@/types/project';

const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SCALES = ['major', 'minor', 'pentatonic_major', 'pentatonic_minor', 'chromatic'];
const INSTRUMENTS: Record<string, string[]> = {
  drums: ['acoustic_kit', 'electronic_808', 'lofi_kit'],
  bass: ['finger_bass', 'synth_bass', 'upright_bass'],
  harmony: ['grand_piano', 'acoustic_guitar', 'warm_pad'],
  lead: ['electric_piano', 'synth_lead', 'flute'],
};

function formatTimeMMSS(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function dbToSegmentCount(db: number, total = 12): number {
  if (!Number.isFinite(db) || db <= -58) return 0;
  const clamped = Math.max(-54, Math.min(0, db));
  return Math.round(((clamped + 54) / 54) * total);
}

export default function StudioPage() {
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const routeId = params?.id ? decodeURIComponent(params.id) : '';
  const {
    project,
    updateProject,
    loadProjectIntoSession,
    saveNow,
    autoSaveStatus,
    copilotOpen,
    setCopilotOpen,
    setLatestFitCheck,
    studioUiMeta,
    setStudioUiMeta,
    registerCoachExecutor,
  } = useProjectSession();
  const engine = useMemo(() => getAudioEngine(), []);
  const latestProjectRef = useRef(project);
  latestProjectRef.current = project;
  const rehydratedProjectIdsRef = useRef<Set<string>>(new Set());

  const [transport, setTransport] = useState<TransportSnapshot>(() => engine.getSnapshot());
  const [tool, setTool] = useState<'select' | 'split'>('select');
  const [snapGrid, setSnapGrid] = useState<'1/4' | '1/8' | '1/16'>('1/8');
  const [browserOpen, setBrowserOpen] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 1280 : true
  );
  const [browserTab, setBrowserTab] = useState<'patterns' | 'inspector' | 'templates'>('patterns');
  const [inspectedTrackId, setInspectedTrackId] = useState<string>('drums');
  const [dockOpen, setDockOpen] = useState(true);
  const [dockMaximized, setDockMaximized] = useState(false);
  const [dockHeightPx, setDockHeightPx] = useState<number>(332);
  const [fxBusUi, setFxBusUi] = useState<{
    reverbReturn: number;
    delayReturn: number;
    bypassed: boolean;
  }>({ reverbReturn: 1.0, delayReturn: 1.0, bypassed: false });
  const [activeTab, setActiveTab] = useState<
    'sequencer' | 'piano_roll' | 'mixer' | 'autotune' | 'lyrics'
  >(() => {
    const t = studioUiMeta.activeTab;
    return t === 'piano_roll' || t === 'mixer' || t === 'autotune' || t === 'lyrics'
      ? t
      : 'sequencer';
  });
  const [selectedTrack, setSelectedTrack] = useState<'drums' | 'bass' | 'harmony' | 'lead'>('harmony');

  // Undo / Redo (up to 20 snapshots)
  const [undoStack, setUndoStack] = useState<ProjectState[]>([]);
  const [redoStack, setRedoStack] = useState<ProjectState[]>([]);

  // Chords sync dirty flag & Loop Region
  const [chordsDirty, setChordsDirty] = useState(false);
  const [loopStartBar, setLoopStartBar] = useState<number>(1);
  const [loopEndBar, setLoopEndBar] = useState<number>(() =>
    Math.max(2, (project.song_structure.total_bars || 8) + 1)
  );

  // Status / Job feedback
  const [studioMode, setStudioMode] = useState<'pro' | 'quick'>('pro');
  const [studioNotice, setStudioNotice] = useState<string | null>(null);
  const [busyJobTrack, setBusyJobTrack] = useState<string | null>(null);
  const [regenFullBusy, setRegenFullBusy] = useState(false);
  const [regenJobId, setRegenJobId] = useState<string | null>(null);
  const [regenProgress, setRegenProgress] = useState<number>(0);
  const [autoTrimBusy, setAutoTrimBusy] = useState(false);
  const [autoMixBusy, setAutoMixBusy] = useState(false);
  const [clipUploadBusy, setClipUploadBusy] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const autoFollowTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!exportMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExportMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [exportMenuOpen]);

  // Overdub & Lyrics state (Global AI Copilot lives in ProjectProvider / AppShell)
  const [isOverdubbing, setIsOverdubbing] = useState(false);
  const [lastOverdubClipId, setLastOverdubClipId] = useState<string | null>(null);
  const overdubRecorderRef = useRef<MediaRecorder | null>(null);
  const sseCleanupRef = useRef<(() => void) | null>(null);

  const [lyricTopic, setLyricTopic] = useState('Ký ức mùa hè');
  const [lyricLoading, setLyricLoading] = useState(false);

  useEffect(() => {
    setStudioUiMeta({ studioMode, activeTab });
  }, [studioMode, activeTab, setStudioUiMeta]);

  // Load project from IndexedDB or Backend only when routeId changes
  useEffect(() => {
    if (!routeId || routeId === latestProjectRef.current.project_id) {
      return;
    }
    let active = true;
    void (async () => {
      const local = await getDraft(routeId);
      if (local && active) {
        loadProjectIntoSession(local.state, { dirty: local.dirty });
        return;
      }
      try {
        const remote = await getProject(routeId);
        if (active) {
          loadProjectIntoSession(remote, { dirty: false });
        }
      } catch {
        // Keep current project fallback if backend offline
      }
    })();
    return () => {
      active = false;
    };
  }, [routeId, loadProjectIntoSession]);

  // Re-sync audio buffers & engine project snapshot whenever audio refs, clips, MIDI notes, or tempo/bars change
  const audioSignature = useMemo(() => {
    const assets = project.audio_assets;
    const trackSig = Object.entries(project.tracks)
      .filter(([, t]) => Boolean(t))
      .map(([k, t]) =>
        t!.type === 'audio'
          ? `${k}:a:${t!.clips
            .map(
              (c) =>
                `${c.id}:${c.source}:${c.start_bar}:${c.trim_start_sec}:${c.trim_end_sec ?? ''}:${c.fade_in_ms}:${c.fade_out_ms ?? 20}:${c.offset_ms ?? 0}`
            )
            .join(',')}`
          : `${k}:m:${t!.instrument || ''}:${t!.notes
            .map((n) => `${n.pitch}:${n.start_beat}:${n.duration}:${n.velocity}`)
            .join(';')}`
      )
      .join('|');
    return [
      project.project_id,
      assets.raw_input_ref ?? '',
      assets.dry_denoised_ref ?? '',
      assets.tuned_vocal_ref ?? '',
      assets.rendered_mix_ref ?? '',
      assets.accompaniment_ref ?? '',
      assets.preserve_mix_ref ?? '',
      assets.enhance_mix_ref ?? '',
      project.analysis.bpm,
      project.analysis.time_signature,
      project.song_structure.total_bars,
      trackSig,
    ].join('::');
  }, [
    project.project_id,
    project.audio_assets,
    project.tracks,
    project.analysis.bpm,
    project.analysis.time_signature,
    project.song_structure.total_bars,
  ]);

  useEffect(() => {
    let cancelled = false;
    const current = latestProjectRef.current;
    void (async () => {
      await engine.syncFromProject(current);
      if (cancelled) return;

      // Restore raw_input audio blob from IndexedDB & rehydrate Redis audio/DSP if expired after TTL
      const hadRawAssetRef = Boolean(current.audio_assets.raw_input_ref);
      const rawMissingOnServer = hadRawAssetRef && !engine.hasBuffer('raw');
      if (!engine.hasBuffer('raw')) {
        const rawBlob = await getAudioBlob(current.project_id, 'raw_input');
        if (rawBlob && !cancelled) {
          await engine.loadAudioFromBlob('raw', rawBlob);
          if (rawMissingOnServer && !rehydratedProjectIdsRef.current.has(current.project_id)) {
            rehydratedProjectIdsRef.current.add(current.project_id);
            try {
              const modeHint = (current.analysis.duration_sec ?? 0) > 58 ? 'vocal' : 'hum';
              const upRes = await uploadAudio(rawBlob, 'recovered_raw.wav', current.project_id, modeHint);
              let recoveredDryRef = current.audio_assets.dry_denoised_ref;
              let recoveredTunedRef = current.audio_assets.tuned_vocal_ref;

              if (current.audio_assets.dry_denoised_ref && !engine.hasBuffer('dry')) {
                const dryRes = await denoiseAudio({
                  project_id: current.project_id,
                  enable_denoise: true,
                  auto_trim: false,
                });
                recoveredDryRef = dryRes.dry_denoised_ref;
              }
              if (
                current.autotune_settings?.enabled !== false &&
                current.audio_assets.tuned_vocal_ref &&
                !engine.hasBuffer('autotune')
              ) {
                const tuneRes = await autotuneAudio({
                  project_id: current.project_id,
                  autotune_settings: current.autotune_settings,
                });
                recoveredTunedRef = tuneRes.tuned_vocal_ref;
              }
              if (!cancelled) {
                const recovered = updateProject((prev) => ({
                  ...prev,
                  audio_assets: {
                    ...prev.audio_assets,
                    raw_input_ref: upRes.raw_input_ref,
                    dry_denoised_ref: recoveredDryRef,
                    tuned_vocal_ref: recoveredTunedRef,
                  },
                }));
                await syncProject(recovered.project_id, recovered).catch(() => {});
                await engine.syncFromProject(recovered, { forceSlots: ['dry', 'autotune'] });
                setStudioNotice('Đã tự khôi phục vocal từ IndexedDB lên hệ thống sau khi hết cache Redis.');
              }
            } catch {
              // Keep offline IndexedDB buffer playback if backend is unavailable
            }
          }
        }
      }

      // Restore any custom/overdub clip blobs from IndexedDB if missing from engine
      for (const track of Object.values(current.tracks)) {
        if (!track || track.type !== 'audio') continue;
        for (const clip of track.clips || []) {
          const src = clip.source || '';
          const isCustomClip =
            src.startsWith('mem://clips/') ||
            src.startsWith('idb://') ||
            clip.id.startsWith('clip_overdub_') ||
            src === 'overdub';
          if (!isCustomClip) continue;
          const cacheKey = src || clip.id;
          if (!engine.hasBuffer(cacheKey)) {
            const clipBlob =
              (await getAudioBlob(current.project_id, cacheKey)) ||
              (clip.id !== cacheKey ? await getAudioBlob(current.project_id, clip.id) : null) ||
              (clip.id.startsWith('clip_overdub_') || src.includes('overdub')
                ? await getAudioBlob(current.project_id, 'overdub')
                : null);
            if (clipBlob && !cancelled) {
              await engine.loadAudioFromBlob(cacheKey, clipBlob);
            }
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [audioSignature, engine]);

  useEffect(() => {
    engine.setPreferPreRenderedMix(false);
    const unsub = engine.subscribe(setTransport);
    const snap = engine.getSnapshot();
    if (snap.abMode === 'preserve' || snap.abMode === 'enhance') {
      engine.setABMode('ai_mix');
    }
    return () => {
      unsub();
      sseCleanupRef.current?.();
      sseCleanupRef.current = null;
      if (autoFollowTimerRef.current) {
        clearTimeout(autoFollowTimerRef.current);
        autoFollowTimerRef.current = null;
      }
    };
  }, [engine]);

  const scheduleAutoFollowRetune = useCallback(
    (nextState: ProjectState) => {
      if (autoFollowTimerRef.current) {
        clearTimeout(autoFollowTimerRef.current);
      }
      const at = nextState.autotune_settings;
      const hasVocalSrc = Boolean(
        nextState.audio_assets.dry_denoised_ref || nextState.audio_assets.raw_input_ref
      );
      if (!at.auto_follow_project_key || !at.enabled || !hasVocalSrc) {
        return;
      }
      autoFollowTimerRef.current = window.setTimeout(() => {
        void (async () => {
          const latest = latestProjectRef.current;
          if (!latest.autotune_settings.auto_follow_project_key || !latest.autotune_settings.enabled) {
            return;
          }
          try {
            await saveNow(true, latest);
            const res = await autotuneAudio({
              project_id: latest.project_id,
              autotune_settings: latest.autotune_settings,
            });
            const updated = updateProject((prev) => ({
              ...prev,
              audio_assets: { ...prev.audio_assets, tuned_vocal_ref: res.tuned_vocal_ref },
            }));
            await engine.syncFromProject(updated, { forceSlots: ['autotune'] });
            setStudioNotice(
              `Auto-Follow đã đồng bộ Auto-Tune theo ${updated.analysis.detected_key} ${updated.analysis.detected_scale}.`
            );
          } catch {
            // Keep UI responsive silently when offline
          }
        })();
      }, 650);
    },
    [engine, saveNow, updateProject]
  );

  const mutateWithUndo = useCallback(
    (updater: (prev: ProjectState) => ProjectState): ProjectState => {
      const prev = latestProjectRef.current;
      setUndoStack((s) => [...s.slice(-19), prev]);
      setRedoStack([]);
      const next = updateProject(updater);
      latestProjectRef.current = next;
      return next;
    },
    [updateProject]
  );

  const handleChannelEq = (
    trackId: string,
    patch: Partial<{ lowDb: number; midDb: number; highDb: number }>,
    withUndo = false
  ) => {
    const applyFn = withUndo ? mutateWithUndo : updateProject;
    applyFn((prev) => {
      const curr = prev.tracks[trackId];
      if (!curr) return prev;
      const nextLow = Math.max(-12, Math.min(12, patch.lowDb ?? curr.low_db ?? 0));
      const nextMid = Math.max(-12, Math.min(12, patch.midDb ?? curr.mid_db ?? 0));
      const nextHigh = Math.max(-12, Math.min(12, patch.highDb ?? curr.high_db ?? 0));
      engine.setChannelEq(trackId, { lowDb: nextLow, midDb: nextMid, highDb: nextHigh });
      return {
        ...prev,
        tracks: {
          ...prev.tracks,
          [trackId]: {
            ...curr,
            low_db: nextLow,
            mid_db: nextMid,
            high_db: nextHigh,
          },
        },
      };
    });
  };

  const handleChannelSend = (
    trackId: string,
    patch: Partial<{ reverbSend: number; delaySend: number }>,
    withUndo = false
  ) => {
    const applyFn = withUndo ? mutateWithUndo : updateProject;
    applyFn((prev) => {
      const curr = prev.tracks[trackId];
      if (!curr) return prev;
      const nextRev = Math.max(0, Math.min(1, patch.reverbSend ?? curr.reverb_send ?? 0));
      const nextDly = Math.max(0, Math.min(1, patch.delaySend ?? curr.delay_send ?? 0));
      engine.setChannelSends(trackId, { reverbSend: nextRev, delaySend: nextDly });
      return {
        ...prev,
        tracks: {
          ...prev.tracks,
          [trackId]: {
            ...curr,
            reverb_send: nextRev,
            delay_send: nextDly,
          },
        },
      };
    });
  };

  const handleFxBusChange = (
    patch: Partial<{ reverbReturn: number; delayReturn: number; bypassed: boolean }>
  ) => {
    setFxBusUi((prev) => {
      const next = { ...prev, ...patch };
      engine.setFxBusConfig(next);
      return next;
    });
  };

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((s) => [...s, latestProjectRef.current]);
    loadProjectIntoSession(prev, { dirty: true });
    void engine.syncFromProject(prev);
  }, [undoStack, engine, loadProjectIntoSession]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((s) => s.slice(0, -1));
    setUndoStack((s) => [...s.slice(-19), latestProjectRef.current]);
    loadProjectIntoSession(next, { dirty: true });
    void engine.syncFromProject(next);
  }, [redoStack, engine, loadProjectIntoSession]);

  // Keyboard shortcuts: Space (Play/Pause), V (Select), C (Split), M (Metronome), Ctrl+S (Save), Ctrl+Z/Y (Undo/Redo)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (engine.getSnapshot().isPlaying) {
          engine.pause();
        } else {
          engine.play();
        }
        return;
      }
      const key = e.key.toLowerCase();
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (key === 'v') {
          setTool('select');
          return;
        }
        if (key === 'c') {
          setTool('split');
          return;
        }
        if (key === 'm') {
          const next = !engine.getSnapshot().metronomeEnabled;
          engine.setMetronomeEnabled(next);
          setStudioNotice(next ? 'Đã bật Metronome CLICK.' : 'Đã tắt Metronome CLICK.');
          return;
        }
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (key === 's') {
        e.preventDefault();
        void saveNow(true);
        setStudioNotice('Đã lưu session cục bộ & đồng bộ.');
      } else if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo, handleRedo, engine, saveNow]);

  // Keep loop end bar clamped to project total_bars when structure changes
  useEffect(() => {
    const maxEnd = Math.max(2, (project.song_structure.total_bars || 8) + 1);
    setLoopEndBar((curr) => {
      if (curr > maxEnd || curr <= loopStartBar) return maxEnd;
      return curr;
    });
  }, [project.song_structure.total_bars, loopStartBar]);

  // Compute Bar:Beat readout
  const beatsPerBar = getBeatsPerBar(project.analysis.time_signature);
  const totalBeats = (transport.currentTimeSec * (project.analysis.bpm || 100)) / 60;
  const currentBar = Math.floor(totalBeats / beatsPerBar) + 1;
  const currentBeat = Math.floor(totalBeats % beatsPerBar) + 1;

  const allTracksMuted = Object.values(project.tracks).every((t) => !t || Boolean(t.mute));

  const handleToggleTrackFlag = (trackId: string, flag: 'mute' | 'solo' | 'locked') => {
    mutateWithUndo((prev) => {
      const current = prev.tracks[trackId];
      if (!current) return prev;
      const nextTrack = { ...current, [flag]: !current[flag] };
      const nextState: ProjectState = {
        ...prev,
        tracks: { ...prev.tracks, [trackId]: nextTrack },
      };
      engine.setChannelConfig({
        id: trackId,
        mute: Boolean(nextTrack.mute),
        solo: Boolean(nextTrack.solo),
        volume: nextTrack.volume ?? 0.85,
        pan: nextTrack.pan ?? 0.0,
      });
      return nextState;
    });
  };

  const handleTrackVolumePan = (trackId: string, field: 'volume' | 'pan', value: number) => {
    updateProject((prev) => {
      const current = prev.tracks[trackId];
      if (!current) return prev;
      const nextTrack = { ...current, [field]: value };
      engine.setChannelConfig({
        id: trackId,
        mute: Boolean(nextTrack.mute),
        solo: Boolean(nextTrack.solo),
        volume: nextTrack.volume ?? 0.85,
        pan: nextTrack.pan ?? 0.0,
      });
      return {
        ...prev,
        tracks: { ...prev.tracks, [trackId]: nextTrack },
      };
    });
  };

  const handleRegenerateTrack = async (trackId: string) => {
    const current = latestProjectRef.current;
    const track = current.tracks[trackId];
    if (!track || track.type !== 'midi' || track.locked) return;
    setBusyJobTrack(trackId);
    setStudioNotice(`Đang tạo lại track ${trackId}...`);
    try {
      await saveNow(true);
      const { job_id } = await regenerateTrackJob({
        project_id: current.project_id,
        target_track: trackId,
        instrument: track.instrument || 'grand_piano',
      });
      sseCleanupRef.current?.();
      sseCleanupRef.current = subscribeJobEvents(
        job_id,
        (evt) => {
          if (evt.type === 'completed') {
            setBusyJobTrack(null);
            if (evt.project_state) {
              loadProjectIntoSession(evt.project_state, { dirty: true });
              void engine.syncFromProject(evt.project_state);
            }
            setStudioNotice(`Đã cập nhật lại track ${trackId}.`);
          } else if (evt.type === 'error') {
            setBusyJobTrack(null);
            setStudioNotice(evt.message || evt.error || 'Lỗi tạo lại track.');
          }
        },
        () => {
          setBusyJobTrack(null);
          setStudioNotice(`Mất kết nối SSE khi tạo lại track ${trackId}.`);
        }
      );
    } catch (err) {
      setBusyJobTrack(null);
      setStudioNotice(err instanceof ApiError ? err.detail : 'Không thể gọi API regenerate-track.');
    }
  };

  const handleRearrangeChords = async () => {
    const current = latestProjectRef.current;
    setBusyJobTrack('rearrange');
    setStudioNotice('Đang đồng bộ hòa âm cho các track chưa khóa...');
    try {
      await saveNow(true);
      const lockedTracks = Object.entries(current.tracks)
        .filter(([, t]) => Boolean(t?.locked))
        .map(([k]) => k);
      const { job_id } = await rearrangeChordsJob({
        project_id: current.project_id,
        chords: current.song_structure.chords,
        locked_tracks: lockedTracks,
        sections: current.song_structure.sections,
        total_bars: current.song_structure.total_bars,
      });
      sseCleanupRef.current?.();
      sseCleanupRef.current = subscribeJobEvents(
        job_id,
        (evt) => {
          if (evt.type === 'completed') {
            setBusyJobTrack(null);
            setChordsDirty(false);
            if (evt.project_state) {
              loadProjectIntoSession(evt.project_state, { dirty: true });
              void engine.syncFromProject(evt.project_state);
            }
            setStudioNotice('Đã đồng bộ nhạc đệm theo hợp âm mới.');
          } else if (evt.type === 'error') {
            setBusyJobTrack(null);
            setStudioNotice(evt.message || evt.error || 'Lỗi đồng bộ hợp âm.');
          }
        },
        () => {
          setBusyJobTrack(null);
          setStudioNotice('Mất kết nối SSE khi đồng bộ hợp âm.');
        }
      );
    } catch (err) {
      setBusyJobTrack(null);
      setStudioNotice(err instanceof ApiError ? err.detail : 'Không thể kết nối API rearrange.');
    }
  };

  const handleRegenerateFullSong = async () => {
    const current = latestProjectRef.current;
    setRegenFullBusy(true);
    setRegenProgress(8);
    setStudioNotice(`Đang phối lại toàn bài (${current.config.genre} • ${current.config.mood})...`);
    try {
      await saveNow(true, current);
      const { job_id } = await startGenerateJob({
        project_id: current.project_id,
        config: current.config,
      });
      setRegenJobId(job_id);
      sseCleanupRef.current?.();
      sseCleanupRef.current = subscribeJobEvents(
        job_id,
        (evt) => {
          if (typeof evt.progress === 'number') {
            setRegenProgress(evt.progress);
          }
          if (evt.type === 'completed') {
            setRegenFullBusy(false);
            setRegenJobId(null);
            setRegenProgress(100);
            if (evt.project_state) {
              setUndoStack((s) => [...s.slice(-19), current]);
              setRedoStack([]);
              loadProjectIntoSession(evt.project_state, { dirty: true });
              void engine.syncFromProject(evt.project_state);
            }
            setStudioNotice('Đã phối lại toàn bộ bài hát bằng Multi-Agent.');
          } else if (evt.type === 'error') {
            setRegenFullBusy(false);
            setRegenJobId(null);
            setStudioNotice(evt.message || evt.error || 'Lỗi phối lại toàn bài.');
          }
        },
        () => {
          setRegenFullBusy(false);
          setRegenJobId(null);
          setStudioNotice('Mất kết nối SSE khi phối lại bài hát.');
        }
      );
    } catch (err) {
      setRegenFullBusy(false);
      setRegenJobId(null);
      setStudioNotice(err instanceof ApiError ? err.detail : 'Không thể gọi API phối lại toàn bài.');
    }
  };

  const handleCancelRegenJob = async () => {
    if (!regenJobId) return;
    try {
      await cancelJob(regenJobId);
    } catch {
      // ignore
    }
    sseCleanupRef.current?.();
    sseCleanupRef.current = null;
    setRegenFullBusy(false);
    setRegenJobId(null);
    setStudioNotice('Đã hủy tác vụ phối lại toàn bài.');
  };

  const handleStartOverdub = async () => {
    if (isOverdubbing) {
      overdubRecorderRef.current?.stop();
      setIsOverdubbing(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStudioNotice('Trình duyệt không hỗ trợ Microphone cho Overdub.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        engine.stop();
        const rawBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        setStudioNotice('Đang lưu Overdub & chạy AI Fit Check...');
        try {
          const wavBlob = await encodeBlobToWav(rawBlob);
          const current = latestProjectRef.current;
          try {
            await saveNow(true, current);
            const clipRes = await uploadTrackClip(current.project_id, wavBlob, 'vocal');
            const clip = clipRes.clip;
            const cacheKey = clip.source || clipRes.audio_ref || clip.id;

            await saveAudioBlob(current.project_id, cacheKey, wavBlob);
            await engine.loadAudioFromBlob(cacheKey, wavBlob);

            setLastOverdubClipId(clip.id);
            setUndoStack((s) => [...s.slice(-19), current]);
            setRedoStack([]);
            loadProjectIntoSession(clipRes.project_state, { dirty: true });
            await engine.syncFromProject(clipRes.project_state);

            const res = await overdubFitCheck(current.project_id, wavBlob);
            setLatestFitCheck(res);
            setCopilotOpen(true);
            setStudioNotice('Đã upload bản thu Overdub và hoàn tất AI Fit Check.');
          } catch {
            const localClipId = `clip_overdub_${Date.now()}`;
            const localSource = `idb://overdub/${localClipId}`;
            await saveAudioBlob(current.project_id, localSource, wavBlob);
            await engine.loadAudioFromBlob(localSource, wavBlob);
            const newClip: AudioClip = {
              id: localClipId,
              source: localSource,
              start_bar: 1,
              trim_start_sec: 0,
              fade_in_ms: 20,
              fade_out_ms: 20,
              offset_ms: 0,
            };
            setLastOverdubClipId(localClipId);
            mutateWithUndo((prev) => ({
              ...prev,
              tracks: {
                ...prev.tracks,
                vocal: {
                  ...prev.tracks.vocal,
                  clips: [...(prev.tracks.vocal?.clips || []), newClip],
                },
              },
            }));
            setStudioNotice(
              'Backend offline — đã lưu bản thu Overdub cục bộ vào Timeline (IndexedDB).'
            );
          }
        } catch (err) {
          setStudioNotice(err instanceof ApiError ? err.detail : 'Không thể xử lý bản thu Micro.');
        }
      };
      overdubRecorderRef.current = recorder;
      recorder.start();
      engine.play(0);
      setIsOverdubbing(true);
    } catch {
      setStudioNotice('Không thể truy cập Microphone để thu đè.');
    }
  };

  const handleApplyOneClickFix = async (fix: OneClickFix) => {
    const current = latestProjectRef.current;
    if (fix.action_type === 'shift_timing') {
      const shiftMs = Number(fix.value) || 0;
      mutateWithUndo((prev) => {
        const clips = [...(prev.tracks.vocal?.clips || [])];
        if (clips.length === 0) {
          clips.push({
            id: `clip_overdub_${Date.now()}`,
            source: 'overdub',
            start_bar: 1,
            trim_start_sec: 0,
            fade_in_ms: 20,
            fade_out_ms: 20,
            offset_ms: shiftMs,
          });
        } else {
          const targetIdx = lastOverdubClipId
            ? clips.findIndex((c) => c.id === lastOverdubClipId)
            : clips.length - 1;
          const idx = targetIdx >= 0 ? targetIdx : clips.length - 1;
          clips[idx] = {
            ...clips[idx],
            offset_ms: Math.round(((clips[idx].offset_ms ?? 0) + shiftMs) * 10) / 10,
          };
        }
        return {
          ...prev,
          tracks: {
            ...prev.tracks,
            vocal: { ...prev.tracks.vocal, clips },
          },
        };
      });
      setStudioNotice(`Đã dịch timing vocal ${shiftMs > 0 ? `+${shiftMs}` : shiftMs} ms.`);
      return;
    }

    if (fix.action_type === 'adjust_gain') {
      const deltaDb = Number(fix.value) || 0;
      const factor = Math.pow(10, deltaDb / 20);
      const currVol = current.tracks.vocal?.volume ?? 0.95;
      const nextVol = Math.max(0, Math.min(1.2, Number((currVol * factor).toFixed(3))));
      mutateWithUndo((prev) => ({
        ...prev,
        tracks: {
          ...prev.tracks,
          vocal: { ...prev.tracks.vocal, volume: nextVol },
        },
      }));
      engine.setChannelConfig({
        id: 'vocal',
        mute: Boolean(current.tracks.vocal?.mute),
        solo: Boolean(current.tracks.vocal?.solo),
        volume: nextVol,
        pan: current.tracks.vocal?.pan ?? 0.0,
      });
      setStudioNotice(`Đã chỉnh Gain vocal (${deltaDb > 0 ? `+${deltaDb}` : deltaDb} dB → ${Math.round(nextVol * 100)}%).`);
      return;
    }

    if (fix.action_type === 'apply_autotune') {
      const presetVal = String(fix.value || 'natural') as AutoTunePreset;
      const preset: AutoTunePreset =
        presetVal === 'natural' || presetVal === 'balanced' || presetVal === 'modern'
          ? presetVal
          : 'natural';
      const nextSettings: AutotuneSettings = {
        ...current.autotune_settings,
        enabled: true,
        preset,
        key: current.analysis.detected_key,
        scale: current.analysis.detected_scale,
        retune_speed_ms: preset === 'modern' ? 5 : preset === 'balanced' ? 20 : 45,
        humanize: preset === 'modern' ? 0.15 : preset === 'balanced' ? 0.4 : 0.7,
        mix_percent: preset === 'modern' ? 100 : preset === 'balanced' ? 90 : 75,
      };
      setStudioNotice('Đang áp dụng Auto-Tune 1-Click Fix...');
      try {
        const nextState = mutateWithUndo((prev) => ({ ...prev, autotune_settings: nextSettings }));
        await saveNow(true, nextState);
        const res = await autotuneAudio({
          project_id: current.project_id,
          autotune_settings: nextSettings,
        });
        const updated = updateProject((prev) => ({
          ...prev,
          autotune_settings: nextSettings,
          audio_assets: { ...prev.audio_assets, tuned_vocal_ref: res.tuned_vocal_ref },
        }));
        await engine.syncFromProject(updated, { forceSlots: ['autotune'] });
        engine.setABMode('autotune');
        setStudioNotice(`Đã bật Auto-Tune (${preset}) theo ${nextSettings.key} ${nextSettings.scale}.`);
      } catch (err) {
        setStudioNotice(err instanceof ApiError ? err.detail : 'Lỗi áp dụng Auto-Tune 1-Click Fix.');
      }
    }
  };

  const handleApplyAutotunePro = async () => {
    const current = latestProjectRef.current;
    const effectiveSettings: AutotuneSettings =
      current.autotune_settings.enabled && current.autotune_settings.preset === 'off'
        ? { ...current.autotune_settings, preset: 'balanced' }
        : current.autotune_settings;
    setStudioNotice('Đang render Auto-Tune Pro...');
    try {
      await saveNow(true);
      const res = await autotuneAudio({
        project_id: current.project_id,
        autotune_settings: effectiveSettings,
      });
      const updated: ProjectState = {
        ...latestProjectRef.current,
        autotune_settings: effectiveSettings,
        audio_assets: {
          ...latestProjectRef.current.audio_assets,
          tuned_vocal_ref: res.tuned_vocal_ref,
        },
      };
      updateProject((prev) => ({
        ...prev,
        autotune_settings: effectiveSettings,
        audio_assets: { ...prev.audio_assets, tuned_vocal_ref: res.tuned_vocal_ref },
      }));
      await engine.syncFromProject(updated, { forceSlots: ['autotune'] });
      engine.setABMode(effectiveSettings.enabled ? 'autotune' : 'dry');
      setStudioNotice('Đã cập nhật Auto-Tune Pro.');
    } catch (err) {
      setStudioNotice(err instanceof ApiError ? err.detail : 'Lỗi áp dụng Auto-Tune Pro.');
    }
  };

  const handleSuggestLyrics = async () => {
    setLyricLoading(true);
    try {
      try {
        await saveNow(true);
      } catch {
        // Proceed and let suggestLyrics report connection/API status
      }
      const res = await suggestLyrics({
        project_id: project.project_id,
        language: project.lyrics.language || 'vi',
        topic: lyricTopic || 'Tình yêu & hy vọng',
        section: 'Chorus',
      });
      mutateWithUndo((prev) => ({
        ...prev,
        lyrics: { ...prev.lyrics, lines: res.lines },
      }));
      setStudioNotice('Đã gợi ý lời bài hát mới.');
    } catch (err) {
      setStudioNotice(err instanceof ApiError ? err.detail : 'Lỗi gợi ý lời bài hát.');
    } finally {
      setLyricLoading(false);
    }
  };

  const handleExecuteStudioCoachAction = async (
    act: CoachSuggestedAction
  ): Promise<{ notice?: string; revertable?: boolean }> => {
    const payload = act.payload ?? {};
    const current = latestProjectRef.current;

    if (act.action === 'apply_fit_fix' && payload.fix) {
      await handleApplyOneClickFix(payload.fix as OneClickFix);
      return { notice: `Đã áp dụng Fit Fix: ${act.label}`, revertable: true };
    }
    if (act.action === 'auto_mix') {
      await handleAutoMix();
      return { notice: 'Đã chạy AI Auto-Mix (-1.0 dBFS).', revertable: true };
    }
    if (act.action === 'auto_trim_vocal') {
      await handleAutoTrimVocal();
      return { notice: 'Đã chạy AI Auto-Trim Vocal.', revertable: true };
    }
    if (act.action === 'navigate_tab') {
      const targetTab = String(payload.tab || 'mixer');
      if (
        targetTab === 'sequencer' ||
        targetTab === 'piano_roll' ||
        targetTab === 'mixer' ||
        targetTab === 'autotune' ||
        targetTab === 'lyrics'
      ) {
        setStudioMode('pro');
        setDockOpen(true);
        setActiveTab(targetTab);
        return { notice: `Đã chuyển sang tab ${targetTab}.`, revertable: false };
      }
      return { notice: 'Đã mở Pro DAW Dock.', revertable: false };
    }
    if (act.action === 'export_project') {
      const fmt = String(payload.format || 'mp3').toLowerCase();
      if (fmt === 'aimusic') {
        await handleSaveAimusic();
        return { notice: 'Đang tải xuống file .aimusic.', revertable: false };
      }
      const kind = fmt === 'wav' || fmt === 'stems' || fmt === 'midi' ? fmt : 'mp3';
      const bitrate = payload.bitrate === '192k' ? '192k' : '320k';
      await handleExport(kind, bitrate);
      return { notice: `Đã xuất file ${kind.toUpperCase()}.`, revertable: false };
    }
    if (act.action === 'set_track_mix') {
      const tid = String(payload.track_id || 'vocal');
      const nextState = mutateWithUndo((prev) => {
        const currTrack = prev.tracks[tid];
        if (!currTrack) return prev;
        const nextVol =
          typeof payload.volume === 'number'
            ? Math.max(0, Math.min(1.2, payload.volume))
            : currTrack.volume ?? 0.85;
        const nextPan =
          typeof payload.pan === 'number'
            ? Math.max(-1, Math.min(1, payload.pan))
            : currTrack.pan ?? 0;
        const nextLow =
          typeof payload.low_db === 'number'
            ? Math.max(-12, Math.min(12, payload.low_db))
            : currTrack.low_db ?? 0;
        const nextMid =
          typeof payload.mid_db === 'number'
            ? Math.max(-12, Math.min(12, payload.mid_db))
            : currTrack.mid_db ?? 0;
        const nextHigh =
          typeof payload.high_db === 'number'
            ? Math.max(-12, Math.min(12, payload.high_db))
            : currTrack.high_db ?? 0;
        const nextRev =
          typeof payload.reverb_send === 'number'
            ? Math.max(0, Math.min(1, payload.reverb_send))
            : currTrack.reverb_send ?? 0;
        const nextDly =
          typeof payload.delay_send === 'number'
            ? Math.max(0, Math.min(1, payload.delay_send))
            : currTrack.delay_send ?? 0;
        const nextMute = typeof payload.mute === 'boolean' ? payload.mute : Boolean(currTrack.mute);
        const nextSolo = typeof payload.solo === 'boolean' ? payload.solo : Boolean(currTrack.solo);

        engine.setChannelConfig({ id: tid, mute: nextMute, solo: nextSolo, volume: nextVol, pan: nextPan });
        engine.setChannelEq(tid, { lowDb: nextLow, midDb: nextMid, highDb: nextHigh });
        engine.setChannelSends(tid, { reverbSend: nextRev, delaySend: nextDly });

        return {
          ...prev,
          tracks: {
            ...prev.tracks,
            [tid]: {
              ...currTrack,
              volume: nextVol,
              pan: nextPan,
              mute: nextMute,
              solo: nextSolo,
              low_db: nextLow,
              mid_db: nextMid,
              high_db: nextHigh,
              reverb_send: nextRev,
              delay_send: nextDly,
              ...(currTrack.type === 'midi' && typeof payload.instrument === 'string'
                ? { instrument: payload.instrument }
                : {}),
            },
          },
        };
      });
      await saveNow(true, nextState);
      if (typeof payload.instrument === 'string') {
        await engine.syncFromProject(nextState);
      }
      setStudioNotice(`Copilot đã chỉnh Mix/EQ track ${tid.toUpperCase()}.`);
      return { notice: `Đã chỉnh Mix/EQ cho ${tid.toUpperCase()}.`, revertable: true };
    }
    if (act.action === 'edit_structure_and_dynamics') {
      const nextState = mutateWithUndo((prev) => {
        let nextTimeSig = prev.analysis.time_signature;
        if (
          payload.time_signature === '4/4' ||
          payload.time_signature === '3/4' ||
          payload.time_signature === '6/8'
        ) {
          nextTimeSig = payload.time_signature;
        }
        let nextSections = [...prev.song_structure.sections];
        if (typeof payload.target_section === 'string' && typeof payload.section_energy === 'number') {
          const tSec = payload.target_section.toLowerCase();
          const val = Math.max(0.1, Math.min(1, payload.section_energy));
          nextSections = nextSections.map((s) =>
            s.name.toLowerCase().includes(tSec) ? { ...s, energy: val } : s
          );
        }
        let nextTotalBars = prev.song_structure.total_bars;
        if (typeof payload.add_section_name === 'string' && payload.add_section_name.trim()) {
          const bars = Math.max(1, Math.min(16, Number(payload.section_bars) || 4));
          const last = nextSections[nextSections.length - 1];
          const startBar = last ? last.start_bar + last.bars : 1;
          nextSections.push({
            name: payload.add_section_name.trim(),
            start_bar: startBar,
            bars,
            energy: typeof payload.section_energy === 'number' ? Math.max(0.1, Math.min(1, payload.section_energy)) : 0.78,
          });
          nextTotalBars = Math.max(4, startBar + bars - 1);
        }
        return {
          ...prev,
          analysis: { ...prev.analysis, time_signature: nextTimeSig },
          song_structure: {
            ...prev.song_structure,
            total_bars: nextTotalBars,
            sections: nextSections,
          },
        };
      });
      await saveNow(true, nextState);
      if (payload.time_signature === '6/8' || payload.time_signature === '3/4' || payload.time_signature === '4/4') {
        setStudioMode('pro');
        setDockOpen(true);
        setActiveTab('sequencer');
      }
      setStudioNotice(`Đã cập nhật Cấu trúc / Dynamics (${act.label}).`);
      return { notice: `Đã cập nhật Cấu trúc & Dynamics.`, revertable: true };
    }
    if (act.action === 'update_lyrics_lines' && Array.isArray(payload.lines)) {
      const incoming = payload.lines
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map((item, i) => ({
          section: typeof item.section === 'string' ? item.section : 'Chorus',
          bar: Math.max(1, Number(item.bar) || i + 1),
          text: String(item.text || '').trim(),
        }))
        .filter((l) => l.text.length > 0);
      if (incoming.length > 0) {
        const nextState = mutateWithUndo((prev) => ({
          ...prev,
          lyrics: { ...prev.lyrics, lines: incoming },
        }));
        await saveNow(true, nextState);
        setStudioMode('pro');
        setDockOpen(true);
        setActiveTab('lyrics');
        setStudioNotice(`Copilot đã cập nhật ${incoming.length} câu lời vào Lyrics & Karaoke.`);
        return { notice: `Đã cập nhật ${incoming.length} câu lời.`, revertable: true };
      }
    }
    if (act.action === 'suggest_lyrics') {
      const res = await suggestLyrics({
        project_id: current.project_id,
        language: typeof payload.language === 'string' ? payload.language : current.lyrics.language || 'vi',
        topic: typeof payload.topic === 'string' ? payload.topic : lyricTopic || 'Ký ức & Hy vọng',
        section: typeof payload.section === 'string' ? payload.section : 'Chorus',
      });
      mutateWithUndo((prev) => ({
        ...prev,
        lyrics: { ...prev.lyrics, lines: res.lines },
      }));
      setStudioMode('pro');
      setDockOpen(true);
      setActiveTab('lyrics');
      setStudioNotice(`AI Copilot đã gợi ý lời (${res.lines.length} câu) & cập nhật vào tab Lyrics.`);
      return { notice: `Đã gợi ý ${res.lines.length} câu lời mới.`, revertable: true };
    }
    if (act.action === 'regenerate_track') {
      const targetTrack = typeof payload.target_track === 'string' ? payload.target_track : 'drums';
      await handleRegenerateTrack(targetTrack);
      return { notice: `Đang tái tạo lại track ${targetTrack.toUpperCase()}...`, revertable: true };
    }
    if (act.action === 'apply_autotune' || act.action === 'update_autotune' || payload.autotune_settings || payload.preset) {
      const rawPreset = String(
        (payload.autotune_settings as Partial<AutotuneSettings> | undefined)?.preset ||
          payload.preset ||
          (current.autotune_settings.preset === 'off' ? 'balanced' : current.autotune_settings.preset)
      ) as AutoTunePreset;
      const preset: AutoTunePreset =
        rawPreset === 'off' || rawPreset === 'natural' || rawPreset === 'balanced' || rawPreset === 'modern'
          ? rawPreset
          : 'balanced';
      const isOff = preset === 'off';
      const nextSettings: AutotuneSettings = {
        ...current.autotune_settings,
        ...(typeof payload.autotune_settings === 'object' && payload.autotune_settings
          ? (payload.autotune_settings as Partial<AutotuneSettings>)
          : {}),
        enabled: !isOff,
        preset,
        key: typeof payload.key === 'string' ? payload.key : current.autotune_settings.key,
        scale: typeof payload.scale === 'string' ? payload.scale : current.autotune_settings.scale,
        mix_percent: isOff ? 0 : current.autotune_settings.mix_percent || 85,
      };
      const nextState = mutateWithUndo((prev) => ({
        ...prev,
        autotune_settings: nextSettings,
        ...(isOff ? { audio_assets: { ...prev.audio_assets, tuned_vocal_ref: null } } : {}),
      }));
      await saveNow(true, nextState);
      const res = await autotuneAudio({
        project_id: current.project_id,
        autotune_settings: nextSettings,
      });
      const updated = updateProject((prev) => ({
        ...prev,
        autotune_settings: nextSettings,
        audio_assets: { ...prev.audio_assets, tuned_vocal_ref: isOff ? null : res.tuned_vocal_ref },
      }));
      await engine.syncFromProject(updated, isOff ? undefined : { forceSlots: ['autotune'] });
      engine.setABMode(isOff ? 'dry' : 'autotune');
      setStudioNotice(`Đã áp dụng đề xuất Copilot: ${act.label}`);
      return { notice: `Đã áp dụng Auto-Tune (${preset}).`, revertable: true };
    }
    if (act.action === 'rearrange_chords' || Array.isArray(payload.chords)) {
      let nextChords: ChordEvent[] = current.song_structure.chords;
      const totalBars = Math.max(4, current.song_structure.total_bars || 8);
      const beatsPerChord = getBeatsPerBar(current.analysis.time_signature);
      if (Array.isArray(payload.chords) && payload.chords.length > 0) {
        if (typeof payload.chords[0] === 'string') {
          const syms = payload.chords as string[];
          nextChords = Array.from({ length: totalBars }, (_, barIdx) => ({
            bar: barIdx + 1,
            beat: 1,
            symbol: syms[barIdx % syms.length],
            duration_beats: beatsPerChord,
          }));
        } else {
          nextChords = payload.chords as ChordEvent[];
        }
      } else {
        const rootIdx = Math.max(0, KEYS.indexOf(current.analysis.detected_key));
        const prog = [
          `${KEYS[(rootIdx + 9) % 12]}m`,
          KEYS[(rootIdx + 5) % 12],
          KEYS[rootIdx],
          KEYS[(rootIdx + 7) % 12],
        ];
        nextChords = Array.from({ length: totalBars }, (_, barIdx) => ({
          bar: barIdx + 1,
          beat: 1,
          symbol: prog[barIdx % prog.length],
          duration_beats: beatsPerChord,
        }));
      }
      const nextState = mutateWithUndo((prev) => ({
        ...prev,
        song_structure: { ...prev.song_structure, chords: nextChords },
      }));
      setChordsDirty(true);
      await saveNow(true, nextState);
      setStudioNotice(`Đã cập nhật hợp âm theo Copilot (${act.label}). Đang đồng bộ hòa âm...`);
      await handleRearrangeChords();
      return { notice: 'Đã đổi hợp âm & đồng bộ track đệm.', revertable: true };
    }

    const nextState = mutateWithUndo((prev) => {
      const nextConfig = { ...prev.config };
      const nextAnalysis = { ...prev.analysis };
      let nextAutotune = prev.autotune_settings;

      if (typeof payload.motif_position === 'string') {
        nextConfig.motif_position = payload.motif_position as MotifPosition;
      }
      if (typeof payload.output_mode === 'string') {
        nextConfig.output_mode = payload.output_mode as OutputMode;
      }
      if (typeof payload.melody_mode === 'string') {
        nextConfig.melody_mode = payload.melody_mode as MelodyMode;
      }
      if (typeof payload.structure_preset === 'string') {
        nextConfig.structure_preset = payload.structure_preset as StructurePreset;
      }
      if (typeof payload.genre === 'string') nextConfig.genre = payload.genre;
      if (typeof payload.mood === 'string') nextConfig.mood = payload.mood;

      if (typeof payload.bpm === 'number' && Number.isFinite(payload.bpm)) {
        const clampedBpm = Math.max(40, Math.min(220, Math.round(payload.bpm)));
        nextAnalysis.bpm = clampedBpm;
        nextAnalysis.bpm_locked = true;
        engine.setBpm(clampedBpm);
      }
      if (typeof payload.key === 'string') {
        nextAnalysis.detected_key = payload.key;
        nextAnalysis.key_locked = true;
        if (nextAutotune.auto_follow_project_key) {
          nextAutotune = { ...nextAutotune, key: payload.key };
        }
      }
      if (typeof payload.scale === 'string') {
        nextAnalysis.detected_scale = payload.scale;
        nextAnalysis.key_locked = true;
        if (nextAutotune.auto_follow_project_key) {
          nextAutotune = { ...nextAutotune, scale: payload.scale };
        }
      }

      return {
        ...prev,
        config: nextConfig,
        analysis: nextAnalysis,
        autotune_settings: nextAutotune,
      };
    });

    await saveNow(true, nextState);
    setStudioNotice(`Đã áp dụng đề xuất Copilot: ${act.label}`);
    return { notice: `Đã áp dụng: ${act.label}`, revertable: true };
  };

  const coachExecutorRef = useRef(handleExecuteStudioCoachAction);
  coachExecutorRef.current = handleExecuteStudioCoachAction;

  useEffect(() => {
    registerCoachExecutor((act) => coachExecutorRef.current(act));
    return () => registerCoachExecutor(null);
  }, [registerCoachExecutor]);

  const handleAutoTrimVocal = async () => {
    const current = latestProjectRef.current;
    setAutoTrimBusy(true);
    setStudioNotice('AI đang phân tích khoảng lặng & căn nhịp Vocal...');
    try {
      await saveNow(true);
      const res = await autoTrimVocal(current.project_id);
      setUndoStack((s) => [...s.slice(-19), current]);
      setRedoStack([]);
      loadProjectIntoSession(res.project_state, { dirty: true });
      await engine.syncFromProject(res.project_state);
      setStudioNotice(
        res.summary || 'Đã chạy AI Auto-Trim Vocal và cập nhật trim/offset trên timeline.'
      );
    } catch (err) {
      setStudioNotice(err instanceof ApiError ? err.detail : 'Lỗi chạy AI Auto-Trim Vocal.');
    } finally {
      setAutoTrimBusy(false);
    }
  };

  const handleAutoMix = async () => {
    const current = latestProjectRef.current;
    setAutoMixBusy(true);
    setStudioNotice('AI đang cân bằng Gain, Pan và Master Limiter (-1.0 dBFS)...');
    try {
      await saveNow(true);
      const res = await autoMixProject(current.project_id);
      setUndoStack((s) => [...s.slice(-19), current]);
      setRedoStack([]);
      loadProjectIntoSession(res.project_state, { dirty: true });
      await engine.syncFromProject(res.project_state);
      const detail =
        res.summary ||
        (res.mix_notes && res.mix_notes.length > 0 ? res.mix_notes.join(' • ') : null) ||
        'Đã hoàn tất AI Auto-Mix & Master Limiter (-1.0 dBFS).';
      setStudioNotice(detail);
    } catch (err) {
      setStudioNotice(err instanceof ApiError ? err.detail : 'Lỗi chạy AI Auto-Mix.');
    } finally {
      setAutoMixBusy(false);
    }
  };

  const handleUploadTextureClip = async (file: File) => {
    const current = latestProjectRef.current;
    setClipUploadBusy(true);
    setStudioNotice(`Đang import audio sample "${file.name}" vào track Texture...`);
    try {
      await saveNow(true);
      const res = await uploadTrackClip(current.project_id, file, 'texture');
      if (res.audio_ref) {
        await saveAudioBlob(current.project_id, res.audio_ref, file);
        await engine.loadAudioFromBlob(res.audio_ref, file);
      }
      setUndoStack((s) => [...s.slice(-19), current]);
      setRedoStack([]);
      loadProjectIntoSession(res.project_state, { dirty: true });
      await engine.syncFromProject(res.project_state);
      setStudioNotice(`Đã import sample "${file.name}" vào track Texture.`);
    } catch (err) {
      setStudioNotice(err instanceof ApiError ? err.detail : 'Lỗi import audio sample.');
    } finally {
      setClipUploadBusy(false);
    }
  };

  const getClipDurationSec = useCallback(
    (clip: AudioClip, trackId: string): number => {
      const bufDur = engine.getClipBufferDuration(clip, trackId);
      const fallbackDur = project.analysis.duration_sec || transport.durationSec || 8;
      const sourceEnd = clip.trim_end_sec ?? bufDur ?? fallbackDur;
      return Math.max(0.1, sourceEnd - (clip.trim_start_sec || 0));
    },
    [engine, project.analysis.duration_sec, transport.durationSec]
  );

  const handleSaveAimusic = async () => {
    try {
      await saveNow(true);
      const blob = await exportAimusic(project.project_id);
      const safeName = (project.title || project.project_id).replace(/[^a-zA-Z0-9_-]/g, '_');
      triggerBlobDownload(blob, `${safeName}.aimusic`);
      await markDraftSaved(project.project_id);
      setStudioNotice(`Đã lưu ${safeName}.aimusic`);
    } catch (err) {
      setStudioNotice(err instanceof ApiError ? err.detail : 'Lỗi lưu file .aimusic');
    }
  };

  const handleExport = async (kind: 'wav' | 'mp3' | 'stems' | 'midi', bitrate: '192k' | '320k' = '320k') => {
    setExportMenuOpen(false);
    if (allTracksMuted) {
      setStudioNotice('Cảnh báo: Tất cả các track đang bị Mute. Hãy bỏ Mute ít nhất 1 track trước khi Export!');
      return;
    }
    try {
      await saveNow(true);
      const safeName = (project.title || project.project_id).replace(/[^a-zA-Z0-9_-]/g, '_');
      if (kind === 'midi') {
        const blob = await exportMidi(project.project_id);
        triggerBlobDownload(blob, `${safeName}.mid`);
      } else {
        const blob = await exportAudio(project.project_id, kind, project.mastering.auto_mix_enabled, 'ai_mix', bitrate);
        const ext = kind === 'stems' ? 'zip' : kind;
        triggerBlobDownload(blob, `${safeName}.${ext}`);
      }
      setStudioNotice(
        kind === 'mp3'
          ? `Đã xuất file MP3 (${bitrate === '192k' ? '192kbps' : '320kbps'}) thành công.`
          : `Đã xuất file ${kind.toUpperCase()} thành công.`
      );
    } catch (err) {
      setStudioNotice(err instanceof ApiError ? err.detail : `Lỗi xuất ${kind.toUpperCase()}.`);
    }
  };

  const trackKeys: Array<'vocal' | 'texture' | 'drums' | 'bass' | 'harmony' | 'lead'> = useMemo(() => {
    const base: Array<'vocal' | 'texture' | 'drums' | 'bass' | 'harmony' | 'lead'> = ['vocal'];
    if (project.tracks.texture) base.push('texture');
    base.push('drums', 'bass', 'harmony', 'lead');
    return base;
  }, [project.tracks.texture]);

  // Determine active Karaoke lyric line index based on currentBar
  const activeLyricIdx = useMemo(() => {
    const lines = project.lyrics.lines;
    if (!lines.length) return -1;
    let bestIdx = -1;
    let bestBar = -Infinity;
    lines.forEach((line, idx) => {
      if (line.bar <= currentBar && line.bar >= bestBar) {
        bestBar = line.bar;
        bestIdx = idx;
      }
    });
    return bestIdx;
  }, [project.lyrics.lines, currentBar]);

  const masterSegments = dbToSegmentCount(transport.masterPeakDb, 10);
  const inspectedTrack = project.tracks[inspectedTrackId] ?? project.tracks.vocal;

  const startResizeDock = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = dockHeightPx;
    const handleMove = (ev: PointerEvent) => {
      const delta = startY - ev.clientY;
      setDockHeightPx(Math.max(185, Math.min(480, startHeight + delta)));
      setDockOpen(true);
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  const applyChordProgressionPreset = (symbols: string[], label: string) => {
    const bars = Math.max(4, project.song_structure.total_bars || 8);
    const nextChords: ChordEvent[] = Array.from({ length: bars }, (_, idx) => ({
      bar: idx + 1,
      beat: 1,
      symbol: symbols[idx % symbols.length],
      duration_beats: beatsPerBar,
    }));
    const bassNotes = generateBassFromChords(nextChords, bars, beatsPerBar);
    const harmNotes = generateHarmonyFromChords(nextChords, bars, beatsPerBar);
    mutateWithUndo((prev) => {
      const updateTrackNotes = (
        existing: ProjectState['tracks']['bass'] | undefined,
        notes: typeof bassNotes,
        fallback: { volume: number; pan: number; instrument: string }
      ) =>
        existing
          ? { ...existing, notes }
          : {
            type: 'midi' as const,
            locked: false,
            mute: false,
            solo: false,
            volume: fallback.volume,
            pan: fallback.pan,
            low_db: 0,
            mid_db: 0,
            high_db: 0,
            reverb_send: 0,
            delay_send: 0,
            instrument: fallback.instrument,
            notes,
          };

      return {
        ...prev,
        song_structure: { ...prev.song_structure, chords: nextChords },
        tracks: {
          ...prev.tracks,
          bass: prev.tracks.bass?.locked
            ? prev.tracks.bass
            : updateTrackNotes(prev.tracks.bass, bassNotes, {
              volume: 0.85,
              pan: 0,
              instrument: 'finger_bass',
            }),
          harmony: prev.tracks.harmony?.locked
            ? prev.tracks.harmony
            : updateTrackNotes(prev.tracks.harmony, harmNotes, {
              volume: 0.8,
              pan: -0.1,
              instrument: 'grand_piano',
            }),
        },
      };
    });
    setStudioNotice(`Đã nạp vòng hợp âm ${label} và cập nhật Bass / Harmony.`);
  };

  const handleApplyTotalBars = (bars: number) => {
    const nextBars = Math.max(4, Math.min(32, bars));
    mutateWithUndo((prev) => {
      const existingChords = prev.song_structure.chords;
      const expandedChords: ChordEvent[] = Array.from({ length: nextBars }, (_, i) => {
        const found = existingChords.find((c) => c.bar === i + 1);
        if (found) return found;
        const fallback = existingChords[i % Math.max(1, existingChords.length)];
        return {
          bar: i + 1,
          beat: 1,
          symbol: fallback?.symbol || 'C',
          duration_beats: beatsPerBar,
        };
      });
      return {
        ...prev,
        song_structure: {
          ...prev.song_structure,
          total_bars: nextBars,
          chords: expandedChords,
        },
      };
    });
    setLoopEndBar(nextBars + 1);
    engine.setLoopRegionBars(loopStartBar, nextBars + 1);
    setStudioNotice(`Đã đổi độ dài Arrangement thành ${nextBars} Bars.`);
  };

  return (
    <div className="flex h-full flex-col gap-1 overflow-hidden">
      {/* 1. PRO HARDWARE TOP TRANSPORT BAR (Single-row clean workstation bar) */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 rounded-lg border border-white/10 bg-[#181b22] px-2 py-1">
        {/* Left: Browser Toggle + Session Title + Transport Cluster + LCD + Edit Tools */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setBrowserOpen((o) => !o)}
            title="Ẩn/Hiện DAW Browser & Inspector"
            aria-label="Ẩn/Hiện DAW Browser"
            className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-semibold transition ${browserOpen
                ? 'border-amber-400/50 bg-amber-500/15 text-amber-200'
                : 'border-white/10 bg-[#111317] text-slate-300 hover:bg-white/10'
              }`}
          >
            <FolderTree className="h-3.5 w-3.5" />
            <span className="hidden 2xl:inline">Browser</span>
          </button>

          <div className="flex items-center gap-1">
            <input
              id="studio-project-title"
              name="projectTitle"
              aria-label="Tên bài hát"
              value={project.title || ''}
              onChange={(e) =>
                updateProject((p) => ({
                  ...p,
                  title: e.target.value,
                  config: { ...p.config, title: e.target.value },
                }))
              }
              onBlur={() => {
                if (!(project.title || '').trim()) {
                  updateProject((p) => ({
                    ...p,
                    title: 'Untitled Session',
                    config: { ...p.config, title: 'Untitled Session' },
                  }));
                }
              }}
              className="w-24 truncate rounded border border-transparent bg-transparent px-1.5 py-0.5 text-xs font-bold text-white hover:border-white/15 focus:border-amber-400 focus:bg-[#0b0d11] focus:outline-none sm:w-28 xl:w-36"
            />
            <button
              type="button"
              data-testid="autosave-badge"
              onClick={() => void saveNow(true)}
              title="Lưu & đồng bộ dự án (Ctrl+S)"
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold transition ${autoSaveStatus === 'saving'
                  ? 'bg-amber-500/20 text-amber-300'
                  : autoSaveStatus === 'error'
                    ? 'bg-rose-500/20 text-rose-300'
                    : 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                }`}
            >
              {autoSaveStatus === 'saving' ? 'Saving...' : 'Saved'}
            </button>
          </div>

          {/* Hardware Transport Buttons */}
          <div className="flex items-center gap-0.5 rounded border border-white/10 bg-[#0d0f13] p-0.5">
            <button
              type="button"
              onClick={() => engine.seekToBar(1)}
              title="Về đầu bài (Bar 1)"
              aria-label="Về đầu bài"
              className="rounded p-1 text-slate-300 hover:bg-white/10 hover:text-white"
            >
              <SkipBack className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => (transport.isPlaying ? engine.pause() : engine.play())}
              aria-label={transport.isPlaying ? 'Pause' : 'Play'}
              title="Play / Pause (Space)"
              className={`flex h-6 w-7 items-center justify-center rounded transition ${transport.isPlaying
                  ? 'bg-emerald-500 text-slate-950'
                  : 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                }`}
            >
              {transport.isPlaying ? (
                <Pause className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />
              )}
            </button>
            <button
              type="button"
              onClick={() => engine.stop()}
              aria-label="Stop"
              title="Stop"
              className="rounded p-1 text-slate-300 hover:bg-white/10 hover:text-white"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void handleStartOverdub()}
              aria-label={isOverdubbing ? 'Dừng thu Mic' : 'Thu âm Mic Overdub'}
              title={isOverdubbing ? 'Dừng thu Mic' : 'Record Mic Overdub'}
              className={`flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-bold transition ${isOverdubbing
                  ? 'animate-pulse bg-rose-600 text-white'
                  : 'text-rose-400 hover:bg-rose-500/20'
                }`}
            >
              <Circle className="h-2.5 w-2.5 fill-current" />
              <span className="hidden xl:inline">{isOverdubbing ? 'REC' : 'Rec'}</span>
            </button>
            <button
              type="button"
              onClick={() => engine.setLoop(!transport.loopEnabled)}
              title="Loop Region"
              aria-label="Bật/Tắt lặp vùng"
              className={`rounded p-1 transition ${transport.loopEnabled
                  ? 'bg-amber-500/25 text-amber-300'
                  : 'text-slate-400 hover:bg-white/10 hover:text-white'
                }`}
            >
              <Repeat className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => engine.setMetronomeEnabled(!transport.metronomeEnabled)}
              title="Metronome Click (Đếm nhịp - phím M)"
              aria-label="Bật/Tắt Metronome"
              className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold transition ${transport.metronomeEnabled
                  ? 'bg-sky-500 text-slate-950'
                  : 'text-slate-400 hover:bg-white/10 hover:text-white'
                }`}
            >
              CLICK
            </button>
          </div>

          {/* Center LCD Display */}
          <div className="flex items-center gap-1.5 rounded border border-white/10 bg-[#090b0e] px-2 py-0.5 font-mono text-[11px] shadow-inner">
            <span className="font-bold tabular-nums text-amber-300">
              {String(currentBar).padStart(3, '0')}:{currentBeat}
            </span>
            <span className="text-slate-700">|</span>
            <span className="hidden tabular-nums text-slate-200 sm:inline">
              {formatTimeMMSS(transport.currentTimeSec)}
            </span>
            <span className="hidden text-slate-700 sm:inline">|</span>

            <label htmlFor="studio-bpm-input" className="flex items-center gap-1">
              <span className="text-[10px] text-slate-500">BPM</span>
              <input
                id="studio-bpm-input"
                name="studioBpm"
                type="number"
                min={40}
                max={220}
                value={bpmDraft ?? String(project.analysis.bpm)}
                onChange={(e) => {
                  const raw = e.target.value;
                  setBpmDraft(raw);
                  const num = Number(raw);
                  if (raw.trim() !== '' && Number.isFinite(num) && num >= 40 && num <= 220) {
                    const rounded = Math.round(num);
                    mutateWithUndo((p) => ({
                      ...p,
                      analysis: { ...p.analysis, bpm: rounded, bpm_locked: true },
                    }));
                    engine.setBpm(rounded);
                  }
                }}
                onBlur={() => {
                  if (bpmDraft !== null) {
                    const num = Number(bpmDraft);
                    const val =
                      bpmDraft.trim() !== '' && Number.isFinite(num)
                        ? Math.max(40, Math.min(220, Math.round(num)))
                        : project.analysis.bpm;
                    if (val !== project.analysis.bpm) {
                      mutateWithUndo((p) => ({
                        ...p,
                        analysis: { ...p.analysis, bpm: val, bpm_locked: true },
                      }));
                      engine.setBpm(val);
                    }
                    setBpmDraft(null);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                className="w-10 bg-transparent font-bold tabular-nums text-white focus:outline-none"
              />
            </label>
            <span className="text-slate-700">|</span>

            <select
              id="studio-key-select"
              name="studioKey"
              aria-label="Project Key"
              value={project.analysis.detected_key}
              onChange={(e) => {
                const next = mutateWithUndo((p) => ({
                  ...p,
                  analysis: { ...p.analysis, detected_key: e.target.value, key_locked: true },
                  autotune_settings: p.autotune_settings.auto_follow_project_key
                    ? { ...p.autotune_settings, key: e.target.value }
                    : p.autotune_settings,
                }));
                scheduleAutoFollowRetune(next);
              }}
              className="bg-transparent font-bold text-emerald-300 focus:outline-none"
            >
              {KEYS.map((k) => (
                <option key={k} value={k} className="bg-slate-900">
                  {k}
                </option>
              ))}
            </select>
            <select
              id="studio-scale-select"
              name="studioScale"
              aria-label="Project Scale"
              value={project.analysis.detected_scale}
              onChange={(e) => {
                const next = mutateWithUndo((p) => ({
                  ...p,
                  analysis: { ...p.analysis, detected_scale: e.target.value, key_locked: true },
                  autotune_settings: p.autotune_settings.auto_follow_project_key
                    ? { ...p.autotune_settings, scale: e.target.value }
                    : p.autotune_settings,
                }));
                scheduleAutoFollowRetune(next);
              }}
              className="bg-transparent text-[11px] font-medium text-emerald-200 focus:outline-none"
            >
              {SCALES.map((sc) => (
                <option key={sc} value={sc} className="bg-slate-900">
                  {sc}
                </option>
              ))}
            </select>
            <span className="text-slate-700">|</span>
            <select
              id="studio-timesig-select"
              name="studioTimeSignature"
              aria-label="Time Signature"
              value={project.analysis.time_signature || '4/4'}
              onChange={(e) =>
                mutateWithUndo((p) => ({
                  ...p,
                  analysis: { ...p.analysis, time_signature: e.target.value },
                }))
              }
              className="bg-transparent text-[11px] font-bold text-sky-300 focus:outline-none"
            >
              <option value="4/4" className="bg-slate-900">4/4</option>
              <option value="3/4" className="bg-slate-900">3/4</option>
              <option value="6/8" className="bg-slate-900">6/8</option>
            </select>

            <div className="hidden items-center gap-0.5 pl-1 2xl:flex" title={`Master ${transport.masterPeakDb.toFixed(1)} dBFS`}>
              {Array.from({ length: 10 }, (_, idx) => {
                const lit = idx < masterSegments;
                const color =
                  idx >= 8 ? 'bg-rose-500' : idx >= 6 ? 'bg-amber-400' : 'bg-emerald-400';
                return (
                  <span
                    key={idx}
                    className={`h-2.5 w-1 rounded-[1px] ${lit ? color : 'bg-white/10'}`}
                  />
                );
              })}
            </div>
          </div>

          {/* Undo / Redo + Edit Tools */}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              disabled={undoStack.length === 0}
              onClick={handleUndo}
              title="Undo (Ctrl+Z)"
              aria-label="Hoàn tác"
              className="rounded border border-white/10 bg-[#111317] p-1 text-slate-300 hover:bg-white/10 disabled:opacity-35"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              disabled={redoStack.length === 0}
              onClick={handleRedo}
              title="Redo (Ctrl+Y)"
              aria-label="Làm lại"
              className="rounded border border-white/10 bg-[#111317] p-1 text-slate-300 hover:bg-white/10 disabled:opacity-35"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="flex items-center gap-0.5 rounded border border-white/10 bg-[#111317] p-0.5">
            <button
              type="button"
              onClick={() => setTool('select')}
              title="Chọn & di chuyển (Phím V)"
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition ${tool === 'select' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'
                }`}
            >
              Select
            </button>
            <button
              type="button"
              onClick={() => setTool('split')}
              title="Dao cắt Audio Clip (Phím C)"
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold transition ${tool === 'split' ? 'bg-rose-500 text-white' : 'text-slate-400 hover:text-white'
                }`}
            >
              <Scissors className="h-3 w-3" />
              Split
            </button>
            <select
              id="studio-snap-select"
              name="snapGrid"
              aria-label="Lưới Snap Grid"
              value={snapGrid}
              onChange={(e) => setSnapGrid(e.target.value as '1/4' | '1/8' | '1/16')}
              className="bg-transparent px-1 text-[10px] font-medium text-slate-300 focus:outline-none"
            >
              <option value="1/4" className="bg-slate-900">1/4</option>
              <option value="1/8" className="bg-slate-900">1/8</option>
              <option value="1/16" className="bg-slate-900">1/16</option>
            </select>
          </div>
        </div>

        {/* Right Controls: Quick/Pro Switcher + Monitor A/B + Export (with .aimusic) + AI Coach */}
        <div className="flex items-center gap-1.5">
          <div className="flex items-center rounded border border-white/10 bg-[#111317] p-0.5 text-[10px]">
            <button
              type="button"
              onClick={() => setStudioMode('quick')}
              title="Chế độ Quick View gọn nhẹ (Nghe nhanh, Đổi Genre/Mood, Regenerate)"
              className={`rounded px-1.5 py-0.5 font-semibold transition ${studioMode === 'quick' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'
                }`}
            >
              Quick
            </button>
            <button
              type="button"
              onClick={() => setStudioMode('pro')}
              title="Chế độ Studio Pro DAW (Multi-track, Piano Roll, Mixer)"
              className={`rounded px-1.5 py-0.5 font-semibold transition ${studioMode === 'pro' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'
                }`}
            >
              Pro DAW
            </button>
          </div>

          <div className="flex items-center rounded border border-white/10 bg-[#111317] p-0.5 text-[10px]">
            {(
              [
                { id: 'raw', label: 'Raw' },
                { id: 'dry', label: 'Dry' },
                { id: 'autotune', label: 'Tune' },
                { id: 'ai_mix', label: 'Mix' },
              ] as Array<{ id: VocalABMode; label: string }>
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => engine.setABMode(m.id)}
                title={`Chế độ nghe A/B: ${m.label}`}
                className={`rounded px-1.5 py-0.5 font-semibold transition ${transport.abMode === m.id ? 'bg-sky-500 text-slate-950' : 'text-slate-400 hover:text-white'
                  }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div ref={exportMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setExportMenuOpen((o) => !o)}
              className="flex items-center gap-1 rounded bg-emerald-500 px-2.5 py-1 text-[11px] font-bold text-slate-950 hover:bg-emerald-400"
            >
              <Download className="h-3 w-3" />
              <span>Export</span>
            </button>
            {exportMenuOpen && (
              <div className="absolute right-0 z-50 mt-1.5 w-52 rounded-lg border border-white/15 bg-[#1b1e25] p-1.5 shadow-2xl">
                <button
                  type="button"
                  onClick={() => {
                    setExportMenuOpen(false);
                    void handleSaveAimusic();
                  }}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs font-medium text-amber-200 hover:bg-white/10"
                >
                  <Save className="h-3.5 w-3.5 text-amber-400" /> Lưu Project (.aimusic)
                </button>
                <div className="my-1 h-px bg-white/10" />
                <button
                  type="button"
                  onClick={() => void handleExport('wav')}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10"
                >
                  <Music className="h-3.5 w-3.5 text-sky-400" /> WAV (44.1kHz)
                </button>
                <button
                  type="button"
                  onClick={() => void handleExport('mp3', '320k')}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10"
                >
                  <Music className="h-3.5 w-3.5 text-emerald-400" /> MP3 (320kbps · Studio)
                </button>
                <button
                  type="button"
                  onClick={() => void handleExport('mp3', '192k')}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10"
                >
                  <Music className="h-3.5 w-3.5 text-teal-400" /> MP3 (192kbps · Nhẹ)
                </button>
                <button
                  type="button"
                  onClick={() => void handleExport('stems')}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10"
                >
                  <FileArchive className="h-3.5 w-3.5 text-amber-400" /> Stems (.zip)
                </button>
                <button
                  type="button"
                  onClick={() => void handleExport('midi')}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10"
                >
                  <Sliders className="h-3.5 w-3.5 text-violet-400" /> MIDI (.mid)
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setCopilotOpen((o) => !o)}
            title="Bật/Tắt AI Music Copilot"
            className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-semibold transition ${copilotOpen
                ? 'border-amber-400/50 bg-amber-500/20 text-amber-200'
                : 'border-white/15 bg-[#232730] text-slate-300 hover:bg-white/10'
              }`}
          >
            <Bot className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">AI Coach</span>
          </button>
        </div>
      </div>

      {studioNotice && (
        <div className="flex items-center justify-between rounded border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-100">
          <span>{studioNotice}</span>
          <button
            type="button"
            aria-label="Đóng thông báo"
            onClick={() => setStudioNotice(null)}
            className="text-slate-400 hover:text-white"
          >
            ✕
          </button>
        </div>
      )}

      {/* 2. QUICK MODE STREAMLINED VIEW OR 3-PANE PRO DAW WORKSTATION */}
      {studioMode === 'quick' ? (
        <QuickStudioView
          project={project}
          transport={transport}
          waveformPeaks={engine.getWaveformPeaksForSlot(
            transport.abMode === 'raw' ? 'raw' : transport.abMode === 'autotune' ? 'autotune' : 'dry',
            96
          )}
          regenFullBusy={regenFullBusy}
          regenProgress={regenProgress}
          onSwitchToPro={() => setStudioMode('pro')}
          onSetABMode={(id) => engine.setABMode(id)}
          onSeek={(sec) => engine.seek(sec)}
          onMutateWithUndo={mutateWithUndo}
          onRegenerateFullSong={() => void handleRegenerateFullSong()}
          onCancelRegenJob={() => void handleCancelRegenJob()}
          onExport={(fmt, bitrate) => void handleExport(fmt, bitrate)}
          onSaveAimusic={() => void handleSaveAimusic()}
        />
      ) : (
        <div className="relative flex min-h-0 flex-1 gap-1.5 overflow-hidden">
          {/* LEFT DAW BROWSER & TRACK INSPECTOR (Responsive Overlay Drawer on <1024px, Docked on lg+) */}
          {browserOpen && (
            <aside className="absolute top-0 bottom-0 left-0 z-40 flex w-60 shrink-0 flex-col overflow-hidden rounded-lg border border-white/15 bg-[#16191f] shadow-2xl lg:static lg:z-auto lg:w-56 lg:border-white/10 lg:shadow-none xl:w-60">
              <div className="flex items-center gap-1 border-b border-white/10 bg-[#1b1e25] p-1">
                <div className="grid flex-1 grid-cols-3 text-[11px] font-bold">
                  {(
                    [
                      ['patterns', 'Patterns'],
                      ['inspector', 'Inspector'],
                      ['templates', 'Presets'],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setBrowserTab(id)}
                      className={`rounded py-1 transition ${browserTab === id
                          ? 'bg-amber-500 text-slate-950'
                          : 'text-slate-400 hover:text-white'
                        }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  aria-label="Đóng Browser"
                  onClick={() => setBrowserOpen(false)}
                  className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white lg:hidden"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="flex-1 space-y-4 overflow-y-auto p-3 text-xs">
                {browserTab === 'patterns' && (
                  <>
                    <div className="space-y-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Độ dài Arrangement
                      </p>
                      <div className="grid grid-cols-4 gap-1">
                        {[4, 8, 12, 16].map((bars) => (
                          <button
                            key={bars}
                            type="button"
                            onClick={() => handleApplyTotalBars(bars)}
                            className={`rounded border py-1 font-mono text-[11px] font-bold ${project.song_structure.total_bars === bars
                                ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                                : 'border-white/10 bg-[#111317] text-slate-300 hover:bg-white/10'
                              }`}
                          >
                            {bars}b
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Vòng hợp âm nhanh (Chords + Bass)
                      </p>
                      {CHORD_PROGRESSIONS.map((prog) => (
                        <button
                          key={prog.id}
                          type="button"
                          onClick={() => applyChordProgressionPreset(prog.symbols, prog.label)}
                          className="flex w-full flex-col rounded border border-white/10 bg-[#1b1e25] px-2.5 py-2 text-left transition hover:border-sky-400/50 hover:bg-[#232730]"
                        >
                          <span className="text-[11px] font-semibold text-white">{prog.label}</span>
                          <span className="mt-0.5 font-mono text-[10px] text-sky-300">
                            {prog.symbols.join(' – ')}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {browserTab === 'inspector' && inspectedTrack && (
                  <div className="space-y-3">
                    <div className="rounded border border-white/10 bg-[#1b1e25] p-2.5">
                      <p className="text-[10px] uppercase tracking-wider text-slate-400">
                        Selected Track
                      </p>
                      <p className="mt-0.5 text-sm font-extrabold uppercase text-amber-300">
                        {inspectedTrackId}
                      </p>
                    </div>

                    {inspectedTrack.type === 'midi' && (
                      <div className="space-y-2">
                        <label
                          htmlFor="inspector-inst-select"
                          className="block text-[10px] font-bold uppercase text-slate-400"
                        >
                          Instrument Preset
                        </label>
                        <select
                          id="inspector-inst-select"
                          name="inspectorInstrument"
                          value={inspectedTrack.instrument || ''}
                          onChange={(e) =>
                            mutateWithUndo((p) => ({
                              ...p,
                              tracks: {
                                ...p.tracks,
                                [inspectedTrackId]: { ...inspectedTrack, instrument: e.target.value },
                              },
                            }))
                          }
                          className="w-full rounded border border-white/15 bg-[#0b0d11] px-2 py-1.5 text-xs text-white"
                        >
                          {(
                            INSTRUMENTS[inspectedTrackId] ||
                            (inspectedTrack.instrument ? [inspectedTrack.instrument] : [])
                          ).map((inst) => (
                            <option key={inst} value={inst}>
                              {inst}
                            </option>
                          ))}
                        </select>

                        <button
                          type="button"
                          onClick={() => {
                            if (
                              inspectedTrackId === 'drums' ||
                              inspectedTrackId === 'bass' ||
                              inspectedTrackId === 'harmony' ||
                              inspectedTrackId === 'lead'
                            ) {
                              setSelectedTrack(inspectedTrackId);
                              setActiveTab(inspectedTrackId === 'drums' ? 'sequencer' : 'piano_roll');
                              setDockOpen(true);
                            }
                          }}
                          className="w-full rounded bg-amber-500 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-amber-400"
                        >
                          {inspectedTrackId === 'drums'
                            ? 'Mở Step Sequencer Drums'
                            : 'Mở Piano Roll Track này'}
                        </button>

                        <button
                          type="button"
                          disabled={inspectedTrack.locked || busyJobTrack === inspectedTrackId}
                          onClick={() => void handleRegenerateTrack(inspectedTrackId)}
                          className="w-full rounded border border-sky-400/40 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/25 disabled:opacity-40"
                        >
                          AI Tạo lại Track ({inspectedTrackId})
                        </button>
                      </div>
                    )}

                    <div className="space-y-2 border-t border-white/10 pt-2">
                      <label
                        htmlFor="inspector-track-vol"
                        className="flex justify-between text-[11px] text-slate-300"
                      >
                        <span>Volume</span>
                        <span className="font-mono">{Math.round((inspectedTrack.volume ?? 0.85) * 100)}%</span>
                      </label>
                      <input
                        id="inspector-track-vol"
                        name="inspectorTrackVol"
                        type="range"
                        min={0}
                        max={120}
                        value={Math.round((inspectedTrack.volume ?? 0.85) * 100)}
                        onChange={(e) =>
                          handleTrackVolumePan(inspectedTrackId, 'volume', Number(e.target.value) / 100)
                        }
                        className="w-full accent-amber-400"
                      />
                      <label
                        htmlFor="inspector-track-pan"
                        className="flex justify-between text-[11px] text-slate-300"
                      >
                        <span>Pan</span>
                        <span className="font-mono">
                          {Math.round((inspectedTrack.pan ?? 0) * 100) === 0
                            ? 'CENTER'
                            : (inspectedTrack.pan ?? 0) < 0
                              ? `${Math.abs(Math.round((inspectedTrack.pan ?? 0) * 100))}L`
                              : `${Math.round((inspectedTrack.pan ?? 0) * 100)}R`}
                        </span>
                      </label>
                      <input
                        id="inspector-track-pan"
                        name="inspectorTrackPan"
                        type="range"
                        min={-100}
                        max={100}
                        value={Math.round((inspectedTrack.pan ?? 0) * 100)}
                        onChange={(e) =>
                          handleTrackVolumePan(inspectedTrackId, 'pan', Number(e.target.value) / 100)
                        }
                        className="w-full accent-cyan-400"
                      />
                    </div>
                  </div>
                )}

                {browserTab === 'templates' && (
                  <div className="space-y-3">
                    <div className="space-y-2 rounded border border-violet-500/30 bg-violet-500/10 p-2.5">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-violet-200">
                        AI Remix Toàn Bài (Multi-Agent)
                      </p>
                      <div className="grid grid-cols-2 gap-1.5">
                        <select
                          aria-label="Chọn Genre phối lại"
                          value={project.config.genre}
                          onChange={(e) =>
                            mutateWithUndo((p) => ({
                              ...p,
                              config: { ...p.config, genre: e.target.value },
                            }))
                          }
                          className="rounded border border-white/15 bg-[#0b0d11] px-1.5 py-1 text-[11px] text-white"
                        >
                          {GENRES.map((g) => (
                            <option key={g} value={g}>
                              {g}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label="Chọn Mood phối lại"
                          value={project.config.mood}
                          onChange={(e) =>
                            mutateWithUndo((p) => ({
                              ...p,
                              config: { ...p.config, mood: e.target.value },
                            }))
                          }
                          className="rounded border border-white/15 bg-[#0b0d11] px-1.5 py-1 text-[11px] text-white"
                        >
                          {MOODS.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        disabled={regenFullBusy}
                        onClick={() => void handleRegenerateFullSong()}
                        className="flex w-full items-center justify-center gap-1.5 rounded bg-violet-600 py-1.5 text-[11px] font-bold text-white hover:bg-violet-500 disabled:opacity-50"
                      >
                        <Wand2 className="h-3.5 w-3.5" />
                        <span>
                          {regenFullBusy ? `Đang phối lại (${regenProgress}%)...` : 'Phối lại toàn bài'}
                        </span>
                      </button>
                    </div>

                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Đổi nhanh Starter Kit
                    </p>
                    {DAW_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => {
                          const fresh = buildProjectFromTemplate(tpl);
                          loadProjectIntoSession(fresh, { dirty: true });
                          navigate(`/studio/${encodeURIComponent(fresh.project_id)}`);
                        }}
                        className="w-full rounded border border-white/10 bg-[#1b1e25] p-2.5 text-left transition hover:border-amber-400/50 hover:bg-[#232730]"
                      >
                        <p className="text-xs font-bold text-white">{tpl.name}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-slate-400">
                          {tpl.bpm} BPM • {tpl.key} {tpl.scale}
                        </p>
                      </button>
                    ))}

                    <Link
                      to="/create"
                      className="mt-2 flex w-full items-center justify-center gap-1.5 rounded border border-sky-400/40 bg-sky-500/15 py-2 text-xs font-bold text-sky-200 hover:bg-sky-500/25"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>Mở AI Hum-to-Music</span>
                    </Link>
                  </div>
                )}
              </div>
            </aside>
          )}

          {/* CENTER TIMELINE + RESIZER + PRODUCTION DOCK */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {!(dockOpen && dockMaximized) && (
              <>
                <div className="flex min-h-[150px] flex-1 flex-col overflow-hidden">
                  <TimelineEditor
                    project={project}
                    transport={transport}
                    tool={tool}
                    snapGrid={snapGrid}
                    chordsDirty={chordsDirty}
                    busyJobTrack={busyJobTrack}
                    isOverdubbing={isOverdubbing}
                    autoTrimBusy={autoTrimBusy}
                    clipUploadBusy={clipUploadBusy}
                    loopStartBar={loopStartBar}
                    loopEndBar={loopEndBar}
                    selectedTrackId={inspectedTrackId}
                    onSelectTrackHeader={(tid) => {
                      setInspectedTrackId(tid);
                      if (tid === 'drums' || tid === 'bass' || tid === 'harmony' || tid === 'lead') {
                        setSelectedTrack(tid);
                      }
                    }}
                    onSeekBar={(bar) => engine.seekToBar(bar)}
                    onLoopRegionChange={(s, e) => {
                      setLoopStartBar(s);
                      setLoopEndBar(e);
                      engine.setLoopRegionBars(s, e);
                    }}
                    onMutateWithUndo={mutateWithUndo}
                    onMarkChordsDirty={() => setChordsDirty(true)}
                    onRearrangeChords={() => void handleRearrangeChords()}
                    onToggleTrackFlag={handleToggleTrackFlag}
                    onRegenerateTrack={(tid) => void handleRegenerateTrack(tid)}
                    onStartOverdub={() => void handleStartOverdub()}
                    onAutoTrimVocal={() => void handleAutoTrimVocal()}
                    onUploadTextureClip={(f) => void handleUploadTextureClip(f)}
                    onSelectMidiTrack={(tid) => {
                      setSelectedTrack(tid);
                      setInspectedTrackId(tid);
                      setActiveTab(tid === 'drums' ? 'sequencer' : 'piano_roll');
                      setDockOpen(true);
                    }}
                    getClipDurationSec={getClipDurationSec}
                    onNotice={setStudioNotice}
                  />
                </div>

                {/* Draggable Horizontal Splitter Bar */}
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  title="Kéo lên/xuống để thay đổi chiều cao vùng chỉnh sửa (Double-click để đặt lại)"
                  onPointerDown={startResizeDock}
                  onDoubleClick={() => setDockHeightPx(332)}
                  className="group my-1 flex h-2 shrink-0 cursor-row-resize items-center justify-center rounded bg-[#181b22] hover:bg-amber-500/25"
                >
                  <span className="h-0.5 w-12 rounded-full bg-white/20 group-hover:bg-amber-400" />
                </div>
              </>
            )}

            {/* 3. BOTTOM DAW DOCK (Channel Rack Step Sequencer + Piano Roll + Mixer + Auto-Tune + Lyrics) */}
            <div
              style={dockOpen && !dockMaximized ? { height: `${dockHeightPx}px` } : undefined}
              className={`flex flex-col overflow-hidden rounded-lg border border-white/10 bg-[#16191f] ${dockOpen && dockMaximized ? 'min-h-0 flex-1' : 'shrink-0'
                }`}
            >
              <div
                onDoubleClick={() => {
                  if (dockOpen) setDockMaximized((m) => !m);
                  else setDockOpen(true);
                }}
                className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#1b1e25] px-2.5 py-1"
              >
                <div className="flex flex-wrap items-center gap-1">
                  {(
                    [
                      { id: 'sequencer', label: 'Step Sequencer', icon: Grid3X3 },
                      { id: 'piano_roll', label: 'Piano Roll' },
                      { id: 'mixer', label: 'Console Mixer' },
                      { id: 'autotune', label: 'Auto-Tune DSP' },
                      { id: 'lyrics', label: 'Lyrics & Karaoke' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => {
                        setActiveTab(tab.id);
                        setDockOpen(true);
                      }}
                      className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-bold transition ${activeTab === tab.id && dockOpen
                          ? 'bg-amber-500 text-slate-950'
                          : 'text-slate-400 hover:bg-white/[0.06] hover:text-white'
                        }`}
                    >
                      {'icon' in tab && tab.icon && <tab.icon className="h-3 w-3" />}
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1">
                  {dockOpen && (
                    <button
                      type="button"
                      aria-label={dockMaximized ? 'Thu về chế độ chia đôi' : 'Phóng to Editor'}
                      title={dockMaximized ? 'Thu về chế độ chia đôi' : 'Phóng to toàn màn hình Editor'}
                      onClick={() => setDockMaximized((m) => !m)}
                      className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-amber-300"
                    >
                      {dockMaximized ? (
                        <Minimize2 className="h-3.5 w-3.5" />
                      ) : (
                        <Maximize2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={dockOpen ? 'Thu gọn bảng công cụ' : 'Mở bảng công cụ'}
                    onClick={() => {
                      if (dockOpen && dockMaximized) setDockMaximized(false);
                      setDockOpen((o) => !o);
                    }}
                    className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
                  >
                    {dockOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {dockOpen && (
                <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                  {activeTab === 'sequencer' && (
                    <StepSequencer
                      project={project}
                      transport={transport}
                      onMutateWithUndo={mutateWithUndo}
                      onAuditionNote={(pitch, tid) => engine.auditionMidiNote(pitch, tid)}
                      onNotice={setStudioNotice}
                    />
                  )}

                  {activeTab === 'mixer' && (
                    <ConsoleMixerPanel
                      project={project}
                      trackKeys={trackKeys}
                      instruments={INSTRUMENTS}
                      transport={transport}
                      fxBusUi={fxBusUi}
                      autoMixBusy={autoMixBusy}
                      onToggleTrackFlag={handleToggleTrackFlag}
                      onMutateWithUndo={mutateWithUndo}
                      onUpdateProject={updateProject}
                      onChannelEq={handleChannelEq}
                      onChannelSend={handleChannelSend}
                      onTrackVolumePan={handleTrackVolumePan}
                      onFxBusChange={handleFxBusChange}
                      onAutoMix={() => void handleAutoMix()}
                    />
                  )}

                  {/* Tab 2: Interactive Piano Roll */}
                  {activeTab === 'piano_roll' && (
                    <PianoRollEditor
                      project={project}
                      transport={transport}
                      selectedTrack={selectedTrack}
                      snapGrid={snapGrid}
                      onSelectTrack={setSelectedTrack}
                      onMutateWithUndo={mutateWithUndo}
                      onAuditionNote={(pitch, trackId) => engine.auditionMidiNote(pitch, trackId)}
                      onNotice={setStudioNotice}
                    />
                  )}

                  {/* Tab 3: Auto-Tune Pro VST Rack */}
                  {activeTab === 'autotune' && (
                    <div className="grid items-end gap-4 rounded-xl border border-white/[0.08] bg-[#1b1e25] p-4 sm:grid-cols-2 lg:grid-cols-5">
                      <div>
                        <span className="mb-1.5 block text-[11px] font-medium text-slate-400">
                          Key &amp; Scale
                        </span>
                        <div className="flex gap-1.5">
                          <select
                            id="studio-autotune-key"
                            name="autotuneKey"
                            aria-label="Auto-Tune Key"
                            value={project.autotune_settings.key}
                            onChange={(e) =>
                              updateProject((p) => ({
                                ...p,
                                autotune_settings: {
                                  ...p.autotune_settings,
                                  enabled: true,
                                  preset:
                                    p.autotune_settings.preset === 'off'
                                      ? 'balanced'
                                      : p.autotune_settings.preset,
                                  auto_follow_project_key: false,
                                  key: e.target.value,
                                },
                              }))
                            }
                            className="rounded-lg border border-white/15 bg-[#0b0d11] px-2.5 py-1.5 text-xs font-semibold text-white"
                          >
                            {KEYS.map((k) => (
                              <option key={k} value={k}>
                                {k}
                              </option>
                            ))}
                          </select>
                          <select
                            id="studio-autotune-scale"
                            name="autotuneScale"
                            aria-label="Auto-Tune Scale"
                            value={project.autotune_settings.scale}
                            onChange={(e) =>
                              updateProject((p) => ({
                                ...p,
                                autotune_settings: {
                                  ...p.autotune_settings,
                                  enabled: true,
                                  preset:
                                    p.autotune_settings.preset === 'off'
                                      ? 'balanced'
                                      : p.autotune_settings.preset,
                                  auto_follow_project_key: false,
                                  scale: e.target.value,
                                },
                              }))
                            }
                            className="flex-1 rounded-lg border border-white/15 bg-[#0b0d11] px-2.5 py-1.5 text-xs text-white"
                          >
                            {SCALES.map((sc) => (
                              <option key={sc} value={sc}>
                                {sc}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div>
                        <label
                          htmlFor="studio-autotune-retune"
                          className="mb-1.5 block text-[11px] font-medium text-slate-300"
                        >
                          Retune Speed ({project.autotune_settings.retune_speed_ms} ms)
                        </label>
                        <input
                          id="studio-autotune-retune"
                          name="retuneSpeedMs"
                          type="range"
                          min={0}
                          max={200}
                          value={project.autotune_settings.retune_speed_ms}
                          onChange={(e) =>
                            updateProject((p) => ({
                              ...p,
                              autotune_settings: {
                                ...p.autotune_settings,
                                enabled: true,
                                preset:
                                  p.autotune_settings.preset === 'off'
                                    ? 'balanced'
                                    : p.autotune_settings.preset,
                                retune_speed_ms: Number(e.target.value),
                              },
                            }))
                          }
                          className="w-full accent-amber-400"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="studio-autotune-humanize"
                          className="mb-1.5 block text-[11px] font-medium text-slate-300"
                        >
                          Humanize ({Math.round(project.autotune_settings.humanize * 100)}%)
                        </label>
                        <input
                          id="studio-autotune-humanize"
                          name="autotuneHumanize"
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round(project.autotune_settings.humanize * 100)}
                          onChange={(e) =>
                            updateProject((p) => ({
                              ...p,
                              autotune_settings: {
                                ...p.autotune_settings,
                                enabled: true,
                                preset:
                                  p.autotune_settings.preset === 'off'
                                    ? 'balanced'
                                    : p.autotune_settings.preset,
                                humanize: Number(e.target.value) / 100,
                              },
                            }))
                          }
                          className="w-full accent-amber-400"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="studio-autotune-mix"
                          className="mb-1.5 block text-[11px] font-medium text-slate-300"
                        >
                          Dry/Wet Mix ({project.autotune_settings.mix_percent}%)
                        </label>
                        <input
                          id="studio-autotune-mix"
                          name="autotuneMixPercent"
                          type="range"
                          min={0}
                          max={100}
                          value={project.autotune_settings.mix_percent}
                          onChange={(e) =>
                            updateProject((p) => ({
                              ...p,
                              autotune_settings: {
                                ...p.autotune_settings,
                                enabled: true,
                                preset:
                                  p.autotune_settings.preset === 'off'
                                    ? 'balanced'
                                    : p.autotune_settings.preset,
                                mix_percent: Number(e.target.value),
                              },
                            }))
                          }
                          className="w-full accent-emerald-400"
                        />
                      </div>

                      <div className="flex flex-col gap-2">
                        <label
                          htmlFor="studio-autotune-autofollow"
                          className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-300"
                        >
                          <input
                            id="studio-autotune-autofollow"
                            name="autoFollowProjectKey"
                            type="checkbox"
                            checked={project.autotune_settings.auto_follow_project_key}
                            onChange={(e) =>
                              updateProject((p) => ({
                                ...p,
                                autotune_settings: {
                                  ...p.autotune_settings,
                                  auto_follow_project_key: e.target.checked,
                                },
                              }))
                            }
                            className="accent-amber-400"
                          />
                          <span>Auto-Follow Key</span>
                        </label>
                        <button
                          type="button"
                          onClick={() => void handleApplyAutotunePro()}
                          className="rounded-md bg-amber-500 px-3.5 py-1.5 text-xs font-bold text-black hover:bg-amber-400"
                        >
                          Áp dụng Auto-Tune
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Tab 4: Lyrics & Karaoke Stage */}
                  {activeTab === 'lyrics' && (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          id="studio-lyric-lang"
                          name="lyricLanguage"
                          aria-label="Ngôn ngữ lời bài hát"
                          value={project.lyrics.language}
                          onChange={(e) =>
                            updateProject((p) => ({
                              ...p,
                              lyrics: { ...p.lyrics, language: e.target.value },
                            }))
                          }
                          className="rounded-xl border border-white/15 bg-[#0b0d11] px-3 py-1.5 text-xs text-white"
                        >
                          <option value="vi">Tiếng Việt</option>
                          <option value="en">Tiếng Anh</option>
                          <option value="bilingual">Song ngữ</option>
                        </select>
                        <input
                          id="studio-lyric-topic"
                          name="lyricTopic"
                          aria-label="Chủ đề lời bài hát"
                          type="text"
                          value={lyricTopic}
                          onChange={(e) => setLyricTopic(e.target.value)}
                          placeholder="Chủ đề lời bài hát..."
                          className="flex-1 rounded-xl border border-white/15 bg-[#0b0d11] px-3 py-1.5 text-xs text-white"
                        />
                        <button
                          type="button"
                          disabled={lyricLoading}
                          onClick={() => void handleSuggestLyrics()}
                          className="flex items-center gap-1.5 rounded-md bg-amber-500 px-3.5 py-1.5 text-xs font-bold text-black hover:bg-amber-400 disabled:opacity-50"
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                          <span>{lyricLoading ? 'Đang gợi ý...' : 'AI Gợi ý lời'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const totalBars = Math.max(4, project.song_structure.total_bars || 8);
                            const lines = project.lyrics.lines;
                            const last = lines[lines.length - 1];
                            const nextBar = last
                              ? Math.min(totalBars, last.bar + 1)
                              : Math.max(1, currentBar);
                            const matchSection =
                              project.song_structure.sections.find(
                                (s) => nextBar >= s.start_bar && nextBar < s.start_bar + s.bars
                              )?.name ||
                              last?.section ||
                              'Verse';
                            mutateWithUndo((p) => ({
                              ...p,
                              lyrics: {
                                ...p.lyrics,
                                lines: [
                                  ...p.lyrics.lines,
                                  { section: matchSection, bar: nextBar, text: '' },
                                ],
                              },
                            }));
                          }}
                          className="flex items-center gap-1 rounded-md border border-white/15 bg-[#1b1e25] px-3 py-1.5 text-xs font-semibold text-white hover:border-amber-400/50 hover:bg-[#242832]"
                        >
                          <Plus className="h-3.5 w-3.5 text-amber-400" />
                          <span>Thêm dòng</span>
                        </button>
                      </div>

                      {project.lyrics.lines.length > 0 && (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-gradient-to-r from-[#1b1e25] via-[#181b22] to-emerald-950/40 px-4 py-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                              <span>Karaoke Sync • Bar {currentBar}:{currentBeat}</span>
                              {activeLyricIdx >= 0 && (
                                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-emerald-200">
                                  {project.lyrics.lines[activeLyricIdx].section}
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 truncate text-sm font-bold text-white">
                              {activeLyricIdx >= 0
                                ? project.lyrics.lines[activeLyricIdx].text || '(Chưa nhập lời)'
                                : 'Chuẩn bị vào câu hát...'}
                            </p>
                            {activeLyricIdx >= 0 && activeLyricIdx + 1 < project.lyrics.lines.length && (
                              <p className="truncate text-[11px] text-slate-400">
                                Tiếp theo (b{project.lyrics.lines[activeLyricIdx + 1].bar}):{' '}
                                {project.lyrics.lines[activeLyricIdx + 1].text}
                              </p>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="space-y-1.5">
                        {project.lyrics.lines.map((line, i) => {
                          const isActiveLine = i === activeLyricIdx;
                          const maxBars = Math.max(4, project.song_structure.total_bars || 8);
                          return (
                            <div
                              key={i}
                              className={`flex flex-wrap items-center gap-1.5 rounded-lg p-1 text-xs transition ${isActiveLine
                                  ? 'border border-emerald-400/60 bg-emerald-500/15 ring-1 ring-emerald-400/30'
                                  : 'border border-white/[0.04] bg-white/[0.015]'
                                }`}
                            >
                              <button
                                type="button"
                                onClick={() => engine.seekToBar(line.bar)}
                                title={`Nhảy tới Bar ${line.bar}`}
                                className={`shrink-0 rounded px-2 py-1 font-mono text-[10px] font-bold transition ${isActiveLine
                                    ? 'bg-emerald-400 text-slate-950'
                                    : 'bg-white/10 text-amber-200 hover:bg-white/20'
                                  }`}
                              >
                                ▶ b{line.bar}
                              </button>
                              <input
                                id={`studio-lyric-section-${i}`}
                                name={`lyricSection_${i}`}
                                aria-label={`Section dòng ${i + 1}`}
                                value={line.section}
                                onChange={(e) =>
                                  updateProject((p) => {
                                    const next = [...p.lyrics.lines];
                                    next[i] = { ...next[i], section: e.target.value };
                                    return { ...p, lyrics: { ...p.lyrics, lines: next } };
                                  })
                                }
                                className="w-20 shrink-0 rounded border border-white/10 bg-[#0b0d11] px-2 py-1 text-[11px] font-medium text-amber-200"
                              />
                              <label
                                htmlFor={`studio-lyric-bar-${i}`}
                                className="flex items-center gap-1 text-[10px] text-slate-400"
                              >
                                <span>b</span>
                                <input
                                  id={`studio-lyric-bar-${i}`}
                                  name={`lyricBar_${i}`}
                                  type="number"
                                  min={1}
                                  max={maxBars}
                                  value={line.bar}
                                  onChange={(e) =>
                                    updateProject((p) => {
                                      const next = [...p.lyrics.lines];
                                      next[i] = {
                                        ...next[i],
                                        bar: Math.max(1, Math.min(maxBars, Number(e.target.value) || 1)),
                                      };
                                      return { ...p, lyrics: { ...p.lyrics, lines: next } };
                                    })
                                  }
                                  className="w-11 rounded border border-white/10 bg-[#0b0d11] px-1 py-1 text-center font-mono text-[11px] text-white"
                                />
                              </label>
                              <input
                                id={`studio-lyric-line-${i}`}
                                name={`lyricLine_${i}`}
                                aria-label={`Lời dòng ${i + 1}`}
                                value={line.text}
                                placeholder="Nhập câu lời..."
                                onChange={(e) =>
                                  updateProject((p) => {
                                    const next = [...p.lyrics.lines];
                                    next[i] = { ...next[i], text: e.target.value };
                                    return { ...p, lyrics: { ...p.lyrics, lines: next } };
                                  })
                                }
                                className={`min-w-[180px] flex-1 rounded-lg border px-2.5 py-1 ${isActiveLine
                                    ? 'border-emerald-400/50 bg-[#0d151c] font-semibold text-emerald-100'
                                    : 'border-white/10 bg-[#0b0d11] text-slate-200'
                                  }`}
                              />
                              {isActiveLine && (
                                <span className="shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                                  Đang hát
                                </span>
                              )}
                              <button
                                type="button"
                                aria-label={`Xóa dòng lời ${i + 1}`}
                                title="Xóa dòng lời này"
                                onClick={() =>
                                  mutateWithUndo((p) => ({
                                    ...p,
                                    lyrics: {
                                      ...p.lyrics,
                                      lines: p.lyrics.lines.filter((_, idx) => idx !== i),
                                    },
                                  }))
                                }
                                className="shrink-0 rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          );
                        })}
                        {project.lyrics.lines.length === 0 && (
                          <p className="text-xs text-slate-500">
                            Chưa có lời. Nhập chủ đề rồi bấm &quot;AI Gợi ý lời&quot; hoặc bấm &quot;+ Thêm dòng&quot; để tự viết lời theo từng Bar.
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
