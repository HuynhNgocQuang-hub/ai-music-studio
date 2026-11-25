import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  AUTO_SAVE_INTERVAL_MS,
  clearAllDrafts,
  deleteDraft,
  getDraft,
  getLatestRestorableDraft,
  markDraftSaved,
  saveDraft,
  type StoredDraft,
} from '@/lib/storage/indexeddb';
import { checkHealth, clearBackendCache, syncProject, testLlmConnection } from '@/lib/api/client';
import {
  DAW_TEMPLATES,
  buildProjectFromTemplate,
  generateDrumPattern,
  getBeatsPerBar,
  type DrumGrooveStyle,
} from '@/lib/music/presets';
import {
  createDefaultProjectState,
  type AutomationPoint,
  type CoachSuggestedAction,
  type OverdubFitCheckResponse,
  type ProjectState,
  type TrackAutomationParam,
} from '@/types/project';

export type AutoSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export type CoachActionExecutor = (
  act: CoachSuggestedAction
) => Promise<{ notice?: string; revertable?: boolean } | void>;

interface ProjectContextValue {
  project: ProjectState;
  setProject: React.Dispatch<React.SetStateAction<ProjectState>>;
  updateProject: (updater: (prev: ProjectState) => ProjectState) => ProjectState;
  loadProjectIntoSession: (state: ProjectState, options?: { dirty?: boolean }) => void;
  resetProject: () => ProjectState;
  saveNow: (syncToBackend?: boolean, overrideState?: ProjectState) => Promise<void>;
  autoSaveStatus: AutoSaveStatus;
  syncError: string | null;
  lastSavedAt: string | null;
  restorableDraft: StoredDraft | null;
  dismissRestorePrompt: () => void;
  acceptRestoreDraft: (draft: StoredDraft) => void;
  discardDraftById: (projectId: string) => Promise<void>;
  copilotOpen: boolean;
  setCopilotOpen: React.Dispatch<React.SetStateAction<boolean>>;
  latestFitCheck: OverdubFitCheckResponse | null;
  setLatestFitCheck: React.Dispatch<React.SetStateAction<OverdubFitCheckResponse | null>>;
  studioUiMeta: { studioMode?: 'quick' | 'pro'; activeTab?: string };
  setStudioUiMeta: React.Dispatch<
    React.SetStateAction<{ studioMode?: 'quick' | 'pro'; activeTab?: string }>
  >;
  registerCoachExecutor: (executor: CoachActionExecutor | null) => void;
  executeGlobalCoachAction: (
    act: CoachSuggestedAction,
    navigate: (to: string) => void
  ) => Promise<{ notice: string; snapshot?: ProjectState }>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [project, setProjectState] = useState<ProjectState>(() => createDefaultProjectState());
  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>('idle');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [restorableDraft, setRestorableDraft] = useState<StoredDraft | null>(null);
  const [copilotOpen, setCopilotOpen] = useState<boolean>(false);
  const [latestFitCheck, setLatestFitCheck] = useState<OverdubFitCheckResponse | null>(null);
  const [studioUiMeta, setStudioUiMeta] = useState<{
    studioMode?: 'quick' | 'pro';
    activeTab?: string;
  }>({});
  const coachExecutorRef = useRef<CoachActionExecutor | null>(null);

  const isDirtyRef = useRef(false);
  const saveSeqRef = useRef(0);
  const latestProjectRef = useRef(project);
  latestProjectRef.current = project;

  // Check IndexedDB on mount for an unsaved draft to prompt restore
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const draft = await getLatestRestorableDraft();
        if (active && draft && draft.dirty) {
          setRestorableDraft(draft);
        }
      } catch {
        // ignore IndexedDB unavailable
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const persistDraft = useCallback(async (state: ProjectState, syncBackend = false) => {
    const seq = ++saveSeqRef.current;
    setAutoSaveStatus('saving');
    try {
      const saved = await saveDraft(state, { dirty: true });
      if (saved && seq === saveSeqRef.current) {
        setLastSavedAt(saved.updated_at);
      }
      if (syncBackend) {
        try {
          await syncProject(state.project_id, state);
          if (seq !== saveSeqRef.current) return;
          await markDraftSaved(state.project_id);
          setSyncError(null);
        } catch (err) {
          if (seq !== saveSeqRef.current) return;
          const msg = err instanceof Error ? err.message : 'Lỗi đồng bộ state lên Redis.';
          setSyncError(msg);
          setAutoSaveStatus('error');
          return;
        }
      } else if (seq === saveSeqRef.current) {
        setSyncError(null);
      }
      if (seq === saveSeqRef.current) {
        isDirtyRef.current = false;
        setAutoSaveStatus('saved');
      }
    } catch (err) {
      if (seq !== saveSeqRef.current) return;
      setSyncError(err instanceof Error ? err.message : 'Lỗi lưu bản nháp IndexedDB.');
      setAutoSaveStatus('error');
    }
  }, []);

  // Periodic background auto-save every 7 seconds (within 5-10s spec)
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (isDirtyRef.current) {
        void persistDraft(latestProjectRef.current, false);
      }
    }, AUTO_SAVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [persistDraft]);

  const setProject = useCallback<React.Dispatch<React.SetStateAction<ProjectState>>>((value) => {
    const prev = latestProjectRef.current;
    const next = typeof value === 'function' ? value(prev) : value;
    latestProjectRef.current = next;
    setProjectState(next);
  }, []);

  const updateProject = useCallback((updater: (prev: ProjectState) => ProjectState): ProjectState => {
    saveSeqRef.current += 1;
    isDirtyRef.current = true;
    const prev = latestProjectRef.current;
    const next = updater(prev);
    const effectiveTitle = next.title ?? next.config.title ?? 'Untitled Session';
    const normalized: ProjectState = {
      ...next,
      title: effectiveTitle,
      config: {
        ...next.config,
        title: effectiveTitle,
      },
      version: (prev.version || 1) + 1,
      updated_at: new Date().toISOString(),
    };
    latestProjectRef.current = normalized;
    setProjectState(normalized);
    return normalized;
  }, []);

  const loadProjectIntoSession = useCallback(
    (state: ProjectState, options: { dirty?: boolean } = {}) => {
      saveSeqRef.current += 1;
      const effectiveTitle = state.config?.title || state.title || 'Untitled Session';
      const normalized: ProjectState = {
        ...state,
        title: effectiveTitle,
        config: {
          ...state.config,
          title: effectiveTitle,
        },
      };
      isDirtyRef.current = options.dirty ?? false;
      latestProjectRef.current = normalized;
      setProjectState(normalized);
      void saveDraft(normalized, { dirty: options.dirty ?? false }).then((d) => {
        if (d) setLastSavedAt(d.updated_at);
        setSyncError(null);
        setAutoSaveStatus('saved');
      });
    },
    []
  );

  const resetProject = useCallback(() => {
    const fresh = createDefaultProjectState();
    isDirtyRef.current = false;
    latestProjectRef.current = fresh;
    setProjectState(fresh);
    setSyncError(null);
    setAutoSaveStatus('idle');
    return fresh;
  }, []);

  const saveNow = useCallback(
    async (syncToBackend = true, overrideState?: ProjectState) => {
      const stateToSave = overrideState ?? latestProjectRef.current;
      if (overrideState) {
        latestProjectRef.current = overrideState;
      }
      await persistDraft(stateToSave, syncToBackend);
    },
    [persistDraft]
  );

  const dismissRestorePrompt = useCallback(() => {
    setRestorableDraft(null);
  }, []);

  const acceptRestoreDraft = useCallback((draft: StoredDraft) => {
    isDirtyRef.current = false;
    latestProjectRef.current = draft.state;
    setProjectState(draft.state);
    setLastSavedAt(draft.updated_at);
    setSyncError(null);
    setAutoSaveStatus('saved');
    setRestorableDraft(null);
  }, []);

  const discardDraftById = useCallback(async (projectId: string) => {
    await deleteDraft(projectId);
    setRestorableDraft((curr) => (curr?.project_id === projectId ? null : curr));
  }, []);

  const registerCoachExecutor = useCallback((executor: CoachActionExecutor | null) => {
    coachExecutorRef.current = executor;
  }, []);

  const executeGlobalCoachAction = useCallback(
    async (
      act: CoachSuggestedAction,
      navigate: (to: string) => void
    ): Promise<{ notice: string; snapshot?: ProjectState }> => {
      const prevSnapshot = latestProjectRef.current;
      const payload = act.payload ?? {};

      if (act.action === 'create_template') {
        const requestedGenre = String(payload.genre || 'Pop').toLowerCase();
        const tpl =
          DAW_TEMPLATES.find((t) => t.genre.toLowerCase() === requestedGenre) ||
          DAW_TEMPLATES[0];
        const next = buildProjectFromTemplate(tpl);
        loadProjectIntoSession(next, { dirty: true });
        navigate(`/studio/${encodeURIComponent(next.project_id)}`);
        return { notice: `Đã khởi tạo "${tpl.name}" và mở Studio DAW.` };
      }

      if (act.action === 'test_health') {
        const [h, llm] = await Promise.all([
          checkHealth().catch(() => null),
          testLlmConnection().catch(() => null),
        ]);
        const msg = `Health=${h?.status ?? 'unknown'} | Redis=${h?.redis?.connected ? 'OK' : 'Offline'} | LLM=${llm?.provider ?? 'mock'}: ${llm?.message ?? 'Ready'}`;
        return { notice: msg };
      }

      if (act.action === 'clear_cache') {
        const scope = String(payload.scope || 'backend').toLowerCase();
        if (scope === 'local') {
          await clearAllDrafts().catch(() => { });
          return { notice: 'Đã dọn bộ nhớ nháp cục bộ (IndexedDB).' };
        }
        const cleared = await clearBackendCache().catch(() => null);
        return { notice: `Đã dọn cache Backend (${cleared?.cleared_assets ?? 0} asset).` };
      }

      if (act.action === 'navigate_route') {
        const target = String(payload.route || '/');
        const safePath =
          target === '/studio'
            ? `/studio/${encodeURIComponent(prevSnapshot.project_id)}`
            : target;
        navigate(safePath);
        return { notice: `Đang chuyển sang trang ${safePath}.` };
      }

      if (coachExecutorRef.current) {
        const res = await coachExecutorRef.current(act);
        return {
          notice: res?.notice || `Đã áp dụng đề xuất: ${act.label}`,
          snapshot: res?.revertable === false ? undefined : prevSnapshot,
        };
      }

      // Non-studio fallback: execute navigation, mix/track/structure/lyrics/mastering mutations directly cleanly
      if (act.action === 'switch_studio_mode') {
        const nextMode = payload.studio_mode === 'quick' ? 'quick' : 'pro';
        setStudioUiMeta((prev) => ({ ...prev, studioMode: nextMode }));
        navigate(`/studio/${encodeURIComponent(prevSnapshot.project_id)}`);
        return { notice: `Mở Studio ở chế độ ${nextMode.toUpperCase()}.` };
      }

      if (act.action === 'navigate_tab') {
        if (typeof payload.tab === 'string') {
          setStudioUiMeta((prev) => ({ ...prev, activeTab: payload.tab as string, studioMode: 'pro' }));
        }
        navigate(`/studio/${encodeURIComponent(prevSnapshot.project_id)}`);
        return { notice: `Đang mở Phòng thu DAW (${prevSnapshot.title || prevSnapshot.project_id}).` };
      }

      if (
        act.action === 'transport_control' ||
        act.action === 'auto_mix' ||
        act.action === 'auto_trim_vocal' ||
        act.action === 'separate_stems' ||
        act.action === 'regenerate_track' ||
        act.action === 'regenerate_song' ||
        act.action === 'export_project'
      ) {
        navigate(`/studio/${encodeURIComponent(prevSnapshot.project_id)}`);
        return { notice: `Đã mở Studio cho "${prevSnapshot.title || prevSnapshot.project_id}" — hãy bấm lại nút này hoặc nút tương ứng trên Studio để thực thi Audio trực tiếp.` };
      }

      const next = updateProject((prev) => {
        if (act.action === 'set_automation') {
          const tid = String(payload.track_id || 'vocal');
          const rawParam = String(payload.parameter || 'volume').toLowerCase();
          const param: TrackAutomationParam =
            rawParam === 'pan' || rawParam === 'filter' || rawParam === 'reverb' ? rawParam : 'volume';
          const rawPts = Array.isArray(payload.points) ? payload.points : [];
          const points: AutomationPoint[] = rawPts
            .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'))
            .map((p, idx) => ({
              bar: Math.max(1, Number(p.bar) || idx + 1),
              value: Math.max(0, Math.min(1, Number(p.value) ?? 0.8)),
            }));
          const currTrack = prev.tracks[tid];
          if (!currTrack || points.length === 0) return prev;
          return {
            ...prev,
            tracks: {
              ...prev.tracks,
              [tid]: {
                ...currTrack,
                automation: {
                  ...(currTrack.automation || {}),
                  [param]: points,
                },
              },
            },
          };
        }
        if (act.action === 'set_mastering') {
          const ceiling =
            typeof payload.limiter_ceiling_db === 'number'
              ? Math.min(-1.0, Math.max(-3.0, payload.limiter_ceiling_db))
              : prev.mastering.limiter_ceiling_db;
          const targetLufs =
            typeof payload.target_lufs === 'number'
              ? Math.max(-20, Math.min(-8, payload.target_lufs))
              : prev.mastering.target_lufs;
          return {
            ...prev,
            mastering: {
              auto_mix_enabled:
                typeof payload.auto_mix_enabled === 'boolean'
                  ? payload.auto_mix_enabled
                  : prev.mastering.auto_mix_enabled,
              limiter_ceiling_db: ceiling,
              target_lufs: targetLufs,
            },
          };
        }

        if (act.action === 'apply_drum_groove') {
          const styleRaw = String(payload.style || 'pop').toLowerCase();
          const style: DrumGrooveStyle =
            styleRaw === 'trap' || styleRaw === 'lofi' || styleRaw === 'edm' || styleRaw === 'clear'
              ? styleRaw
              : 'pop';
          const bars = Math.max(4, prev.song_structure.total_bars || 8);
          const beats = getBeatsPerBar(prev.analysis.time_signature);
          const notes = generateDrumPattern(style, bars, beats);
          const drums = prev.tracks.drums;
          return {
            ...prev,
            tracks: {
              ...prev.tracks,
              drums: drums
                ? { ...drums, notes }
                : {
                  type: 'midi',
                  locked: false,
                  mute: false,
                  solo: false,
                  volume: 0.85,
                  pan: 0,
                  low_db: 0,
                  mid_db: 0,
                  high_db: 0,
                  reverb_send: 0,
                  delay_send: 0,
                  instrument: style === 'trap' ? 'electronic_808' : style === 'lofi' ? 'lofi_kit' : 'acoustic_kit',
                  notes,
                },
            },
          };
        }

        if (act.action === 'set_track_mix') {
          const tid = String(payload.track_id || 'vocal');
          const currTrack = prev.tracks[tid];
          if (!currTrack) return prev;
          return {
            ...prev,
            tracks: {
              ...prev.tracks,
              [tid]: {
                ...currTrack,
                volume: typeof payload.volume === 'number' ? Math.max(0, Math.min(1.2, payload.volume)) : currTrack.volume,
                pan: typeof payload.pan === 'number' ? Math.max(-1, Math.min(1, payload.pan)) : currTrack.pan,
                low_db: typeof payload.low_db === 'number' ? Math.max(-12, Math.min(12, payload.low_db)) : currTrack.low_db ?? 0,
                mid_db: typeof payload.mid_db === 'number' ? Math.max(-12, Math.min(12, payload.mid_db)) : currTrack.mid_db ?? 0,
                high_db: typeof payload.high_db === 'number' ? Math.max(-12, Math.min(12, payload.high_db)) : currTrack.high_db ?? 0,
                reverb_send: typeof payload.reverb_send === 'number' ? Math.max(0, Math.min(1, payload.reverb_send)) : currTrack.reverb_send ?? 0,
                delay_send: typeof payload.delay_send === 'number' ? Math.max(0, Math.min(1, payload.delay_send)) : currTrack.delay_send ?? 0,
                mute: typeof payload.mute === 'boolean' ? payload.mute : currTrack.mute,
                solo: typeof payload.solo === 'boolean' ? payload.solo : currTrack.solo,
                locked: typeof payload.locked === 'boolean' ? payload.locked : currTrack.locked,
              },
            },
          };
        }

        if (act.action === 'edit_structure_and_dynamics') {
          let nextTs = prev.analysis.time_signature;
          if (payload.time_signature === '4/4' || payload.time_signature === '3/4' || payload.time_signature === '6/8') {
            nextTs = payload.time_signature;
          }
          let sections = [...prev.song_structure.sections];
          if (typeof payload.target_section === 'string' && typeof payload.section_energy === 'number') {
            const target = payload.target_section.toLowerCase();
            const val = Math.max(0.1, Math.min(1, payload.section_energy));
            sections = sections.map((s) => (s.name.toLowerCase().includes(target) ? { ...s, energy: val } : s));
          }
          let totalBars = prev.song_structure.total_bars;
          if (typeof payload.add_section_name === 'string' && payload.add_section_name.trim()) {
            const bars = Math.max(1, Math.min(16, Number(payload.section_bars) || 4));
            const last = sections[sections.length - 1];
            const startBar = last ? last.start_bar + last.bars : 1;
            sections.push({ name: payload.add_section_name.trim(), start_bar: startBar, bars, energy: 0.85 });
            totalBars = Math.max(4, startBar + bars - 1);
          }
          return {
            ...prev,
            analysis: { ...prev.analysis, time_signature: nextTs },
            song_structure: { ...prev.song_structure, total_bars: totalBars, sections },
          };
        }

        return {
          ...prev,
          config: {
            ...prev.config,
            ...(typeof payload.genre === 'string' ? { genre: payload.genre } : {}),
            ...(typeof payload.mood === 'string' ? { mood: payload.mood } : {}),
          },
          analysis: {
            ...prev.analysis,
            ...(typeof payload.bpm === 'number'
              ? { bpm: Math.max(40, Math.min(220, Math.round(payload.bpm))), bpm_locked: true }
              : {}),
            ...(typeof payload.key === 'string' ? { detected_key: payload.key, key_locked: true } : {}),
            ...(typeof payload.scale === 'string' ? { detected_scale: payload.scale, key_locked: true } : {}),
          },
        };
      });
      await saveNow(true, next).catch(() => { });
      return { notice: `Đã cập nhật: ${act.label}`, snapshot: prevSnapshot };
    },
    [loadProjectIntoSession, saveNow, updateProject]
  );

  // Helper to hydrate if navigating directly to /studio/[id]
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const match = window.location.pathname.match(/^\/studio\/([^/]+)$/);
    if (match && match[1] && match[1] !== latestProjectRef.current.project_id) {
      const targetId = decodeURIComponent(match[1]);
      void getDraft(targetId).then((draft) => {
        if (draft) {
          latestProjectRef.current = draft.state;
          setProjectState(draft.state);
          setLastSavedAt(draft.updated_at);
        }
      });
    }
  }, []);

  return (
    <ProjectContext.Provider
      value={{
        project,
        setProject,
        updateProject,
        loadProjectIntoSession,
        resetProject,
        saveNow,
        autoSaveStatus,
        syncError,
        lastSavedAt,
        restorableDraft,
        dismissRestorePrompt,
        acceptRestoreDraft,
        discardDraftById,
        copilotOpen,
        setCopilotOpen,
        latestFitCheck,
        setLatestFitCheck,
        studioUiMeta,
        setStudioUiMeta,
        registerCoachExecutor,
        executeGlobalCoachAction,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProjectSession(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error('useProjectSession must be used inside <ProjectProvider>');
  }
  return ctx;
}
