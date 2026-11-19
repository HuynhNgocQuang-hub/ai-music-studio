import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Download,
  FileArchive,
  MessageSquare,
  Music,
  Pause,
  Play,
  Redo2,
  Repeat,
  Save,
  Scissors,
  Send,
  Sliders,
  Sparkles,
  Square,
  Undo2,
  Volume2,
  Wand2,
} from 'lucide-react';
import {
  ApiError,
  autoMixProject,
  autoTrimVocal,
  autotuneAudio,
  chatWithCoach,
  exportAimusic,
  exportAudio,
  exportMidi,
  getProject,
  overdubFitCheck,
  rearrangeChordsJob,
  regenerateTrackJob,
  subscribeJobEvents,
  suggestLyrics,
  triggerBlobDownload,
  uploadTrackClip,
} from '@/lib/api/client';
import {
  encodeBlobToWav,
  getAudioEngine,
  type TransportSnapshot,
  type VocalABMode,
} from '@/lib/audio/player';
import { getAudioBlob, getDraft, markDraftSaved, saveAudioBlob } from '@/lib/storage/indexeddb';
import { useProjectSession } from '@/components/providers/ProjectProvider';
import PianoRollEditor from '@/components/studio/PianoRollEditor';
import TimelineEditor from '@/components/studio/TimelineEditor';
import type {
  AudioClip,
  AutoTunePreset,
  AutotuneSettings,
  CoachMessage,
  OneClickFix,
  OverdubFitCheckResponse,
  ProjectState,
} from '@/types/project';

const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SCALES = ['major', 'minor', 'pentatonic_major', 'pentatonic_minor'];
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

export default function StudioPage() {
  const params = useParams<{ id: string }>();
  const routeId = params?.id ? decodeURIComponent(params.id) : '';
  const { project, updateProject, loadProjectIntoSession, saveNow } = useProjectSession();
  const engine = useMemo(() => getAudioEngine(), []);
  const latestProjectRef = useRef(project);
  latestProjectRef.current = project;

  const [transport, setTransport] = useState<TransportSnapshot>(() => engine.getSnapshot());
  const [tool, setTool] = useState<'select' | 'split'>('select');
  const [snapGrid, setSnapGrid] = useState<'1/4' | '1/8' | '1/16'>('1/8');
  const [dockOpen, setDockOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<'mixer' | 'piano_roll' | 'autotune' | 'lyrics'>('mixer');
  const [selectedTrack, setSelectedTrack] = useState<'drums' | 'bass' | 'harmony' | 'lead'>('harmony');
  const [coachOpen, setCoachOpen] = useState(true);

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
  const [studioNotice, setStudioNotice] = useState<string | null>(null);
  const [busyJobTrack, setBusyJobTrack] = useState<string | null>(null);
  const [autoTrimBusy, setAutoTrimBusy] = useState(false);
  const [autoMixBusy, setAutoMixBusy] = useState(false);
  const [clipUploadBusy, setClipUploadBusy] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // Overdub & AI Fit Check
  const [isOverdubbing, setIsOverdubbing] = useState(false);
  const [fitCheck, setFitCheck] = useState<OverdubFitCheckResponse | null>(null);
  const [lastOverdubClipId, setLastOverdubClipId] = useState<string | null>(null);
  const [appliedFixIds, setAppliedFixIds] = useState<string[]>([]);
  const overdubRecorderRef = useRef<MediaRecorder | null>(null);
  const sseCleanupRef = useRef<(() => void) | null>(null);

  // Lyrics & AI Coach
  const [lyricTopic, setLyricTopic] = useState('Ký ức mùa hè');
  const [lyricLoading, setLyricLoading] = useState(false);
  const [coachMessages, setCoachMessages] = useState<CoachMessage[]>([
    {
      role: 'assistant',
      content:
        'Xin chào! Tôi là AI Music Coach. Bạn có thể hỏi tôi cách sửa lời, đổi hợp âm cho cảm xúc hơn, hoặc thu đè Overdub để tôi kiểm tra nhịp & cao độ.',
    },
  ]);
  const [coachInput, setCoachInput] = useState('');
  const [coachLoading, setCoachLoading] = useState(false);

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

  // Re-sync audio buffers only when audio asset refs, track clips/notes, or bar structure change
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
          : `${k}:m:${t!.instrument || ''}:${t!.notes.length}`
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
      project.song_structure.total_bars,
      trackSig,
    ].join('::');
  }, [
    project.project_id,
    project.audio_assets,
    project.tracks,
    project.song_structure.total_bars,
  ]);

  useEffect(() => {
    const current = latestProjectRef.current;
    void engine.syncFromProject(current);
    const hasOverdubClip = (current.tracks.vocal?.clips || []).some(
      (c) => c.id.startsWith('clip_overdub_') || c.source.includes('overdub')
    );
    if (hasOverdubClip && !engine.hasBuffer('overdub')) {
      void getAudioBlob(current.project_id, 'overdub').then((blob) => {
        if (blob) void engine.loadAudioFromBlob('overdub', blob);
      });
    }
  }, [audioSignature, engine]);

  useEffect(() => {
    const unsub = engine.subscribe(setTransport);
    const snap = engine.getSnapshot();
    if (snap.abMode === 'preserve' || snap.abMode === 'enhance') {
      engine.setABMode('ai_mix');
    }
    return () => {
      unsub();
      sseCleanupRef.current?.();
      sseCleanupRef.current = null;
    };
  }, [engine]);

  const mutateWithUndo = useCallback(
    (updater: (prev: ProjectState) => ProjectState) => {
      setUndoStack((s) => [...s.slice(-19), latestProjectRef.current]);
      setRedoStack([]);
      updateProject(updater);
    },
    [updateProject]
  );

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

  // Keyboard shortcuts: Ctrl+Z (Undo) and Ctrl+Y / Ctrl+Shift+Z (Redo)
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
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo, handleRedo]);

  // Keep loop end bar clamped to project total_bars when structure changes
  useEffect(() => {
    const maxEnd = Math.max(2, (project.song_structure.total_bars || 8) + 1);
    setLoopEndBar((curr) => {
      if (curr > maxEnd || curr <= loopStartBar) return maxEnd;
      return curr;
    });
  }, [project.song_structure.total_bars, loopStartBar]);

  // Compute Bar:Beat readout
  const beatsPerBar = project.analysis.time_signature === '3/4' ? 3 : 4;
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
        setStudioNotice('AI Fit Check đang phân tích bản thu Overdub...');
        try {
          const wavBlob = await encodeBlobToWav(rawBlob);
          const currentId = latestProjectRef.current.project_id;
          await saveAudioBlob(currentId, 'overdub', wavBlob);
          await engine.loadAudioFromBlob('overdub', wavBlob);

          const clipId = `clip_overdub_${Date.now()}`;
          const overdubClip: AudioClip = {
            id: clipId,
            source: `idb://overdub/${clipId}`,
            start_bar: 1,
            trim_start_sec: 0,
            fade_in_ms: 20,
            fade_out_ms: 20,
            offset_ms: 0,
          };
          setLastOverdubClipId(clipId);
          setAppliedFixIds([]);
          mutateWithUndo((prev) => ({
            ...prev,
            tracks: {
              ...prev.tracks,
              vocal: {
                ...prev.tracks.vocal,
                clips: [...(prev.tracks.vocal?.clips || []), overdubClip],
              },
            },
          }));

          const res = await overdubFitCheck(currentId, wavBlob);
          setFitCheck(res);
          setCoachOpen(true);
          setStudioNotice('Đã lưu bản thu Overdub vào IndexedDB và hoàn tất AI Fit Check.');
        } catch (err) {
          setStudioNotice(err instanceof ApiError ? err.detail : 'Lỗi chạy AI Fit Check.');
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
      setAppliedFixIds((prev) => (prev.includes(fix.id) ? prev : [...prev, fix.id]));
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
      setAppliedFixIds((prev) => (prev.includes(fix.id) ? prev : [...prev, fix.id]));
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
        mutateWithUndo((prev) => ({ ...prev, autotune_settings: nextSettings }));
        await saveNow(true);
        const res = await autotuneAudio({
          project_id: current.project_id,
          autotune_settings: nextSettings,
        });
        const updated: ProjectState = {
          ...latestProjectRef.current,
          autotune_settings: nextSettings,
          audio_assets: {
            ...latestProjectRef.current.audio_assets,
            tuned_vocal_ref: res.tuned_vocal_ref,
          },
        };
        updateProject((prev) => ({
          ...prev,
          autotune_settings: nextSettings,
          audio_assets: { ...prev.audio_assets, tuned_vocal_ref: res.tuned_vocal_ref },
        }));
        await engine.syncFromProject(updated, { forceSlots: ['autotune'] });
        engine.setABMode('autotune');
        setAppliedFixIds((prev) => (prev.includes(fix.id) ? prev : [...prev, fix.id]));
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

  const handleSendCoach = async () => {
    const msg = coachInput.trim();
    if (!msg) return;
    const nextHistory: CoachMessage[] = [
      ...coachMessages,
      { role: 'user', content: msg, timestamp: new Date().toISOString() },
    ];
    setCoachMessages(nextHistory);
    setCoachInput('');
    setCoachLoading(true);
    try {
      const res = await chatWithCoach({
        project_id: project.project_id,
        message: msg,
        history: nextHistory,
      });
      setCoachMessages((prev) => [
        ...prev,
        { role: 'assistant', content: res.reply, timestamp: new Date().toISOString() },
      ]);
    } catch (err) {
      setCoachMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: err instanceof ApiError ? `Lỗi: ${err.detail}` : 'AI Coach hiện không phản hồi.',
        },
      ]);
    } finally {
      setCoachLoading(false);
    }
  };

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

  const handleExport = async (kind: 'wav' | 'mp3' | 'stems' | 'midi') => {
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
        const blob = await exportAudio(project.project_id, kind, project.mastering.auto_mix_enabled);
        const ext = kind === 'stems' ? 'zip' : kind;
        triggerBlobDownload(blob, `${safeName}.${ext}`);
      }
      setStudioNotice(`Đã xuất file ${kind.toUpperCase()} thành công.`);
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

  return (
    <div className="flex h-[calc(100vh-5.5rem)] flex-col gap-3 overflow-hidden">
      {/* 1. TOP TRANSPORT BAR */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#121622] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => (transport.isPlaying ? engine.pause() : engine.play())}
            aria-label={transport.isPlaying ? 'Pause' : 'Play'}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-white hover:bg-indigo-500"
          >
            {transport.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
          </button>
          <button
            type="button"
            onClick={() => engine.stop()}
            aria-label="Stop"
            className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800"
          >
            <Square className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => engine.setLoop(!transport.loopEnabled)}
            title="Loop"
            className={`rounded-lg border p-2 ${
              transport.loopEnabled
                ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300'
                : 'border-slate-700 text-slate-400 hover:bg-slate-800'
            }`}
          >
            <Repeat className="h-4 w-4" />
          </button>

          {/* Bar:Beat & mm:ss */}
          <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-[#0b0d14] px-3 py-1 font-mono text-xs">
            <span className="font-bold text-indigo-300">
              Bar {currentBar}:{currentBeat}
            </span>
            <span className="text-slate-600">|</span>
            <span className="text-slate-300">{formatTimeMMSS(transport.currentTimeSec)}</span>
          </div>

          {/* BPM & Key */}
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-[#0b0d14] px-2 py-1 text-xs">
            <span className="text-slate-400">BPM</span>
            <input
              type="number"
              min={40}
              max={220}
              value={project.analysis.bpm}
              onChange={(e) => {
                const val = Math.max(40, Math.min(220, Number(e.target.value) || 100));
                mutateWithUndo((p) => ({ ...p, analysis: { ...p.analysis, bpm: val } }));
                engine.setBpm(val);
              }}
              className="w-12 bg-transparent font-mono font-bold text-white focus:outline-none"
            />
            <span className="text-slate-600">|</span>
            <select
              value={project.analysis.detected_key}
              onChange={(e) =>
                mutateWithUndo((p) => ({
                  ...p,
                  analysis: { ...p.analysis, detected_key: e.target.value },
                  autotune_settings: p.autotune_settings.auto_follow_project_key
                    ? { ...p.autotune_settings, key: e.target.value }
                    : p.autotune_settings,
                }))
              }
              className="bg-transparent font-semibold text-emerald-300 focus:outline-none"
            >
              {KEYS.map((k) => (
                <option key={k} value={k} className="bg-slate-900">
                  {k}
                </option>
              ))}
            </select>
          </div>

          {/* Undo / Redo */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={undoStack.length === 0}
              onClick={handleUndo}
              title="Undo (Ctrl+Z)"
              className="rounded-lg border border-slate-700 p-1.5 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              disabled={redoStack.length === 0}
              onClick={handleRedo}
              title="Redo (Ctrl+Y)"
              className="rounded-lg border border-slate-700 p-1.5 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              <Redo2 className="h-4 w-4" />
            </button>
          </div>

          {/* Timeline tools */}
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#0b0d14] p-0.5">
            <button
              type="button"
              onClick={() => setTool('select')}
              className={`rounded px-2 py-1 text-[11px] font-medium ${
                tool === 'select' ? 'bg-indigo-600 text-white' : 'text-slate-400'
              }`}
            >
              Select
            </button>
            <button
              type="button"
              onClick={() => setTool('split')}
              title="Dao cắt (Split Audio Clip)"
              className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium ${
                tool === 'split' ? 'bg-indigo-600 text-white' : 'text-slate-400'
              }`}
            >
              <Scissors className="h-3 w-3" />
              Split
            </button>
            <select
              value={snapGrid}
              onChange={(e) => setSnapGrid(e.target.value as '1/4' | '1/8' | '1/16')}
              className="bg-transparent px-1.5 text-[11px] text-slate-300 focus:outline-none"
            >
              <option value="1/4" className="bg-slate-900">Snap 1/4</option>
              <option value="1/8" className="bg-slate-900">Snap 1/8</option>
              <option value="1/16" className="bg-slate-900">Snap 1/16</option>
            </select>
          </div>
        </div>

        {/* Right Transport Controls: A/B + Auto-Mix + Save .aimusic + Export + Coach Drawer Toggle */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border border-slate-800 bg-[#0b0d14] p-0.5 text-[11px]">
            {(
              [
                { id: 'dry', label: 'Dry' },
                { id: 'autotune', label: 'Auto-Tune' },
                { id: 'ai_mix', label: 'AI Mix' },
              ] as Array<{ id: VocalABMode; label: string }>
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => engine.setABMode(m.id)}
                className={`rounded px-2 py-1 font-medium ${
                  transport.abMode === m.id ? 'bg-indigo-600 text-white' : 'text-slate-400'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={autoMixBusy}
            onClick={() => void handleAutoMix()}
            title="AI tự cân bằng Volume, Pan & Master Limiter"
            className="flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-600/20 px-2.5 py-1.5 text-xs font-semibold text-indigo-200 hover:bg-indigo-600/35 disabled:opacity-50"
          >
            <Wand2 className="h-3.5 w-3.5 text-indigo-300" />
            <span>{autoMixBusy ? 'Auto-Mixing...' : 'Auto-Mix'}</span>
          </button>

          <button
            type="button"
            onClick={() => void handleSaveAimusic()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            <Save className="h-3.5 w-3.5 text-amber-400" />
            <span>Save .aimusic</span>
          </button>

          <div className="relative">
            <button
              type="button"
              onClick={() => setExportMenuOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export</span>
            </button>
            {exportMenuOpen && (
              <div className="absolute right-0 z-30 mt-1.5 w-44 rounded-xl border border-slate-700 bg-[#171c2b] p-1.5 shadow-xl">
                <button
                  type="button"
                  onClick={() => void handleExport('wav')}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800"
                >
                  <Music className="h-3.5 w-3.5 text-indigo-400" /> WAV (44.1kHz)
                </button>
                <button
                  type="button"
                  onClick={() => void handleExport('mp3')}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800"
                >
                  <Music className="h-3.5 w-3.5 text-emerald-400" /> MP3 (320kbps)
                </button>
                <button
                  type="button"
                  onClick={() => void handleExport('stems')}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800"
                >
                  <FileArchive className="h-3.5 w-3.5 text-amber-400" /> Stems (.zip)
                </button>
                <button
                  type="button"
                  onClick={() => void handleExport('midi')}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800"
                >
                  <Sliders className="h-3.5 w-3.5 text-sky-400" /> MIDI (.mid)
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setCoachOpen((o) => !o)}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
              coachOpen
                ? 'border-indigo-500 bg-indigo-600/20 text-indigo-200'
                : 'border-slate-700 text-slate-300'
            }`}
          >
            <Bot className="h-3.5 w-3.5" />
            <span>AI Coach</span>
          </button>
        </div>
      </div>

      {studioNotice && (
        <div className="flex items-center justify-between rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-200">
          <span>{studioNotice}</span>
          <button type="button" onClick={() => setStudioNotice(null)} className="text-slate-400 hover:text-white">
            ✕
          </button>
        </div>
      )}

      {/* MAIN WORKSPACE: Center Timeline + Right AI Coach Drawer */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden">
          {/* 2. INTERACTIVE MULTI-TRACK TIMELINE, SECTION/CHORD & CLIP EDITOR */}
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
              setActiveTab('piano_roll');
              setDockOpen(true);
            }}
            getClipDurationSec={getClipDurationSec}
            onNotice={setStudioNotice}
          />

          {/* 3. BOTTOM TABBED DOCK */}
          <div className="rounded-xl border border-slate-800 bg-[#121622]">
            <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
              <div className="flex items-center gap-1">
                {(
                  [
                    { id: 'mixer', label: 'Mixer' },
                    { id: 'piano_roll', label: 'Piano Roll' },
                    { id: 'autotune', label: 'Auto-Tune Pro' },
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
                    className={`rounded-lg px-3 py-1 text-xs font-semibold transition ${
                      activeTab === tab.id && dockOpen
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setDockOpen((o) => !o)}
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                {dockOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              </button>
            </div>

            {dockOpen && (
              <div
                className={`overflow-y-auto p-3 ${
                  activeTab === 'piano_roll' ? 'max-h-96' : 'max-h-60'
                }`}
              >
                {/* Tab 1: Mixer */}
                {activeTab === 'mixer' && (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    {trackKeys.map((trackId) => {
                      const track = project.tracks[trackId];
                      if (!track) return null;
                      const volPct = Math.round((track.volume ?? 0.85) * 100);
                      const panVal = Math.round((track.pan ?? 0) * 100);
                      return (
                        <div
                          key={trackId}
                          className="rounded-xl border border-slate-800 bg-[#171c2b] p-3 space-y-2"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold uppercase text-white">{trackId}</span>
                            <span className="font-mono text-[11px] text-indigo-300">{volPct}%</span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={120}
                            value={volPct}
                            onChange={(e) =>
                              handleTrackVolumePan(trackId, 'volume', Number(e.target.value) / 100)
                            }
                            className="w-full accent-indigo-500"
                          />
                          <div className="flex items-center justify-between text-[10px] text-slate-400">
                            <span>Pan: {panVal === 0 ? 'C' : panVal < 0 ? `${Math.abs(panVal)}L` : `${panVal}R`}</span>
                            {track.type === 'midi' && (
                              <select
                                value={track.instrument || ''}
                                onChange={(e) =>
                                  mutateWithUndo((p) => ({
                                    ...p,
                                    tracks: {
                                      ...p.tracks,
                                      [trackId]: { ...track, instrument: e.target.value },
                                    },
                                  }))
                                }
                                className="rounded bg-slate-900 px-1 py-0.5 text-[10px] text-slate-200"
                              >
                                {(INSTRUMENTS[trackId] || (track.instrument ? [track.instrument] : [])).map((inst) => (
                                  <option key={inst} value={inst}>
                                    {inst}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                          <input
                            type="range"
                            min={-100}
                            max={100}
                            value={panVal}
                            onChange={(e) =>
                              handleTrackVolumePan(trackId, 'pan', Number(e.target.value) / 100)
                            }
                            className="w-full accent-emerald-500"
                          />
                        </div>
                      );
                    })}

                    {/* Master Bus Limiter Card */}
                    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-300">
                        <Volume2 className="h-3.5 w-3.5" />
                        <span>MASTER BUS</span>
                      </div>
                      <p className="text-[11px] text-slate-300">
                        Limiter: {project.mastering.limiter_ceiling_db} dBFS
                      </p>
                      <p className="font-mono text-xs text-emerald-200">
                        Peak: {transport.masterPeakDb.toFixed(1)} dBFS
                      </p>
                      <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
                        <input
                          type="checkbox"
                          checked={project.mastering.auto_mix_enabled}
                          onChange={(e) =>
                            updateProject((p) => ({
                              ...p,
                              mastering: { ...p.mastering, auto_mix_enabled: e.target.checked },
                            }))
                          }
                        />
                        <span>Auto-Mix / Anti-Clip</span>
                      </label>
                      <button
                        type="button"
                        disabled={autoMixBusy}
                        onClick={() => void handleAutoMix()}
                        className="w-full rounded-lg bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {autoMixBusy ? 'Đang chạy...' : 'Chạy AI Auto-Mix'}
                      </button>
                    </div>
                  </div>
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

                {/* Tab 3: Auto-Tune Pro */}
                {activeTab === 'autotune' && (
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 items-end">
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Key & Scale</label>
                      <div className="flex gap-1.5">
                        <select
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
                          className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white"
                        >
                          {KEYS.map((k) => (
                            <option key={k} value={k}>
                              {k}
                            </option>
                          ))}
                        </select>
                        <select
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
                          className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white"
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
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Retune Speed ({project.autotune_settings.retune_speed_ms} ms)
                      </label>
                      <input
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
                        className="w-full accent-indigo-500"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Humanize ({Math.round(project.autotune_settings.humanize * 100)}%)
                      </label>
                      <input
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
                        className="w-full accent-indigo-500"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Dry/Wet Mix ({project.autotune_settings.mix_percent}%)
                      </label>
                      <input
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
                        className="w-full accent-emerald-500"
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
                        <input
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
                        />
                        <span>Auto-Follow Key</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => void handleApplyAutotunePro()}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                      >
                        Áp dụng Auto-Tune
                      </button>
                    </div>
                  </div>
                )}

                {/* Tab 4: Lyrics & Karaoke */}
                {activeTab === 'lyrics' && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={project.lyrics.language}
                        onChange={(e) =>
                          updateProject((p) => ({
                            ...p,
                            lyrics: { ...p.lyrics, language: e.target.value },
                          }))
                        }
                        className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-white"
                      >
                        <option value="vi">Tiếng Việt</option>
                        <option value="en">Tiếng Anh</option>
                        <option value="bilingual">Song ngữ</option>
                      </select>
                      <input
                        type="text"
                        value={lyricTopic}
                        onChange={(e) => setLyricTopic(e.target.value)}
                        placeholder="Chủ đề lời bài hát..."
                        className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white"
                      />
                      <button
                        type="button"
                        disabled={lyricLoading}
                        onClick={() => void handleSuggestLyrics()}
                        className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        <span>{lyricLoading ? 'Đang gợi ý...' : 'AI Gợi ý lời'}</span>
                      </button>
                    </div>

                    {/* Karaoke Active Line Stage */}
                    {project.lyrics.lines.length > 0 && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-gradient-to-r from-indigo-950/60 via-[#151c2e] to-emerald-950/50 px-3.5 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                            <span>Karaoke Sync • Bar {currentBar}:{currentBeat}</span>
                            {activeLyricIdx >= 0 && (
                              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-200">
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
                        return (
                          <div
                            key={i}
                            className={`flex items-center gap-2 rounded-lg p-1 text-xs transition ${
                              isActiveLine
                                ? 'border border-emerald-400/60 bg-emerald-500/15 ring-1 ring-emerald-400/30'
                                : ''
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => engine.seekToBar(line.bar)}
                              title={`Nhảy tới Bar ${line.bar}`}
                              className={`w-24 shrink-0 rounded px-2 py-1 text-center font-mono text-[10px] transition ${
                                isActiveLine
                                  ? 'bg-emerald-500 font-bold text-slate-950'
                                  : 'bg-slate-800 text-indigo-300 hover:bg-slate-700'
                              }`}
                            >
                              {line.section} b{line.bar}
                            </button>
                            <input
                              value={line.text}
                              onChange={(e) =>
                                updateProject((p) => {
                                  const next = [...p.lyrics.lines];
                                  next[i] = { ...next[i], text: e.target.value };
                                  return { ...p, lyrics: { ...p.lyrics, lines: next } };
                                })
                              }
                              className={`flex-1 rounded border px-2.5 py-1 ${
                                isActiveLine
                                  ? 'border-emerald-400/50 bg-[#0d151c] font-semibold text-emerald-100'
                                  : 'border-slate-800 bg-[#0b0d14] text-slate-200'
                              }`}
                            />
                            {isActiveLine && (
                              <span className="shrink-0 rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                                Đang hát
                              </span>
                            )}
                          </div>
                        );
                      })}
                      {project.lyrics.lines.length === 0 && (
                        <p className="text-xs text-slate-500">
                          Chưa có lời. Nhập chủ đề và bấm &quot;AI Gợi ý lời&quot; để tạo theo cấu trúc bài.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 4. RIGHT DRAWER: AI MUSIC COACH & OVERDUB FIT CHECK */}
        {coachOpen && (
          <aside className="flex w-80 shrink-0 flex-col rounded-xl border border-slate-800 bg-[#121622]">
            <div className="flex items-center justify-between border-b border-slate-800 px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-indigo-400" />
                <span className="text-xs font-bold text-white">AI Music Coach & Fit Check</span>
              </div>
              <button
                type="button"
                onClick={() => setCoachOpen(false)}
                className="text-xs text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            {/* Overdub Fit Check Card */}
            {fitCheck && (
              <div className="border-b border-slate-800 bg-indigo-500/10 p-3 space-y-2 text-xs">
                <p className="font-semibold text-indigo-200">Kết quả Overdub Fit Check</p>
                <p className="text-slate-300">
                  Lệch nhịp: <strong>{fitCheck.timing_offset_ms} ms</strong> • {fitCheck.gain_suggestion}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {fitCheck.one_click_fixes.map((fix) => {
                    const applied = appliedFixIds.includes(fix.id);
                    return (
                      <button
                        key={fix.id}
                        type="button"
                        disabled={applied}
                        onClick={() => void handleApplyOneClickFix(fix)}
                        className={`rounded-md px-2 py-1 text-[11px] font-medium text-white ${
                          applied
                            ? 'bg-emerald-600/60 cursor-default'
                            : 'bg-indigo-600 hover:bg-indigo-500'
                        }`}
                      >
                        {applied ? `✓ ${fix.label}` : fix.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Coach Messages */}
            <div className="flex-1 space-y-2.5 overflow-y-auto p-3 text-xs">
              {coachMessages.map((m, idx) => (
                <div
                  key={idx}
                  className={`rounded-xl p-2.5 leading-relaxed ${
                    m.role === 'user'
                      ? 'ml-6 bg-indigo-600/25 text-indigo-100'
                      : 'mr-4 border border-slate-800 bg-[#171c2b] text-slate-200'
                  }`}
                >
                  {m.content}
                </div>
              ))}
              {coachLoading && (
                <div className="text-xs text-slate-400">AI Coach đang suy nghĩ...</div>
              )}
            </div>

            {/* Chat Input */}
            <div className="border-t border-slate-800 p-2.5">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={coachInput}
                  onChange={(e) => setCoachInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSendCoach();
                  }}
                  placeholder="Hỏi AI Coach về hợp âm, lời..."
                  className="flex-1 rounded-lg border border-slate-700 bg-[#0b0d14] px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={coachLoading || !coachInput.trim()}
                  onClick={() => void handleSendCoach()}
                  className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-white hover:bg-indigo-500 disabled:opacity-40"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
