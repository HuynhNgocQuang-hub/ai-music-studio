import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  AUTO_SAVE_INTERVAL_MS,
  deleteDraft,
  getDraft,
  getLatestRestorableDraft,
  markDraftSaved,
  saveDraft,
  type StoredDraft,
} from '@/lib/storage/indexeddb';
import { checkHealth, syncProject, testLlmConnection } from '@/lib/api/client';
import { DAW_TEMPLATES, buildProjectFromTemplate } from '@/lib/music/presets';
import {
  createDefaultProjectState,
  type CoachSuggestedAction,
  type OverdubFitCheckResponse,
  type ProjectState,
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

      if (coachExecutorRef.current) {
        const res = await coachExecutorRef.current(act);
        return {
          notice: res?.notice || `Đã áp dụng đề xuất: ${act.label}`,
          snapshot: res?.revertable === false ? undefined : prevSnapshot,
        };
      }

      // Non-studio fallback: open Studio cleanly or update basic config
      if (act.action === 'navigate_tab') {
        if (typeof payload.tab === 'string') {
          setStudioUiMeta((prev) => ({ ...prev, activeTab: payload.tab as string }));
        }
        navigate(`/studio/${encodeURIComponent(prevSnapshot.project_id)}`);
        return { notice: `Đang mở Phòng thu DAW (${prevSnapshot.title || prevSnapshot.project_id}).` };
      }

      const next = updateProject((prev) => ({
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
        },
      }));
      await saveNow(true, next).catch(() => {});
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
