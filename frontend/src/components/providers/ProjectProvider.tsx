'use client';

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
import { syncProject } from '@/lib/api/client';
import { createDefaultProjectState, type ProjectState } from '@/types/project';

export type AutoSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface ProjectContextValue {
  project: ProjectState;
  setProject: React.Dispatch<React.SetStateAction<ProjectState>>;
  updateProject: (updater: (prev: ProjectState) => ProjectState) => void;
  loadProjectIntoSession: (state: ProjectState, options?: { dirty?: boolean }) => void;
  resetProject: () => ProjectState;
  saveNow: (syncToBackend?: boolean) => Promise<void>;
  autoSaveStatus: AutoSaveStatus;
  lastSavedAt: string | null;
  restorableDraft: StoredDraft | null;
  dismissRestorePrompt: () => void;
  acceptRestoreDraft: (draft: StoredDraft) => void;
  discardDraftById: (projectId: string) => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [project, setProject] = useState<ProjectState>(() => createDefaultProjectState());
  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [restorableDraft, setRestorableDraft] = useState<StoredDraft | null>(null);

  const isDirtyRef = useRef(false);
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
    setAutoSaveStatus('saving');
    try {
      const saved = await saveDraft(state, { dirty: !syncBackend });
      if (saved) {
        setLastSavedAt(saved.updated_at);
      }
      if (syncBackend) {
        try {
          await syncProject(state.project_id, state);
          await markDraftSaved(state.project_id);
        } catch {
          // Backend might be offline; IndexedDB still safely holds the draft
        }
      }
      isDirtyRef.current = false;
      setAutoSaveStatus('saved');
    } catch {
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

  const updateProject = useCallback((updater: (prev: ProjectState) => ProjectState) => {
    isDirtyRef.current = true;
    setProject((prev) => {
      const next = updater(prev);
      return {
        ...next,
        version: (prev.version || 1) + 1,
        updated_at: new Date().toISOString(),
      };
    });
  }, []);

  const loadProjectIntoSession = useCallback(
    (state: ProjectState, options: { dirty?: boolean } = {}) => {
      isDirtyRef.current = options.dirty ?? false;
      setProject(state);
      void saveDraft(state, { dirty: options.dirty ?? false }).then((d) => {
        if (d) setLastSavedAt(d.updated_at);
        setAutoSaveStatus('saved');
      });
    },
    []
  );

  const resetProject = useCallback(() => {
    const fresh = createDefaultProjectState();
    isDirtyRef.current = false;
    setProject(fresh);
    setAutoSaveStatus('idle');
    return fresh;
  }, []);

  const saveNow = useCallback(
    async (syncToBackend = true) => {
      await persistDraft(latestProjectRef.current, syncToBackend);
    },
    [persistDraft]
  );

  const dismissRestorePrompt = useCallback(() => {
    setRestorableDraft(null);
  }, []);

  const acceptRestoreDraft = useCallback((draft: StoredDraft) => {
    isDirtyRef.current = false;
    setProject(draft.state);
    setLastSavedAt(draft.updated_at);
    setAutoSaveStatus('saved');
    setRestorableDraft(null);
  }, []);

  const discardDraftById = useCallback(async (projectId: string) => {
    await deleteDraft(projectId);
    setRestorableDraft((curr) => (curr?.project_id === projectId ? null : curr));
  }, []);

  // Helper to hydrate if navigating directly to /studio/[id]
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const match = window.location.pathname.match(/^\/studio\/([^/]+)$/);
    if (match && match[1] && match[1] !== latestProjectRef.current.project_id) {
      const targetId = decodeURIComponent(match[1]);
      void getDraft(targetId).then((draft) => {
        if (draft) {
          setProject(draft.state);
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
        lastSavedAt,
        restorableDraft,
        dismissRestorePrompt,
        acceptRestoreDraft,
        discardDraftById,
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
