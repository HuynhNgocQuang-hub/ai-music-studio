import type { ProjectState } from '@/types/project';

const DB_NAME = 'ai_music_studio_db';
const DB_VERSION = 1;
const DRAFTS_STORE = 'drafts';
const AUDIO_STORE = 'audio_blobs';

/**
 * Rolling cap of recent drafts to avoid disk bloat (SRS 4.1: max 3-5 recent drafts).
 */
export const MAX_DRAFT_CAP = 5;
export const AUTO_SAVE_INTERVAL_MS = 7000; // 7s (within 5-10s spec)

export interface StoredDraft {
  project_id: string;
  state: ProjectState;
  updated_at: string;
  dirty: boolean; // true if modified and not explicitly saved/exported
  size_bytes: number;
}

export interface StoredAudioBlob {
  key: string; // `${project_id}:${slot}` e.g. 'proj_123:raw_input'
  project_id: string;
  slot: 'raw_input' | 'dry_denoised' | 'tuned_vocal' | 'overdub';
  mime_type: string;
  blob: Blob;
  updated_at: string;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase> {
  if (!isBrowser()) {
    return Promise.reject(new Error('IndexedDB is unavailable in non-browser environment'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFTS_STORE)) {
        const draftStore = db.createObjectStore(DRAFTS_STORE, { keyPath: 'project_id' });
        draftStore.createIndex('updated_at', 'updated_at', { unique: false });
      }
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        const audioStore = db.createObjectStore(AUDIO_STORE, { keyPath: 'key' });
        audioStore.createIndex('project_id', 'project_id', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

function estimateStateBytes(state: ProjectState): number {
  try {
    return new Blob([JSON.stringify(state)]).size;
  } catch {
    return JSON.stringify(state).length * 2;
  }
}

/**
 * Enforce rolling cap of MAX_DRAFT_CAP (5) most recent drafts.
 * Deletes oldest drafts AND their associated audio blobs so browser storage stays lean.
 */
async function enforceRollingCap(db: IDBDatabase): Promise<void> {
  const drafts = await getAllDraftsWithDb(db);
  if (drafts.length <= MAX_DRAFT_CAP) return;

  // Sort newest first
  const sorted = [...drafts].sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
  const toEvict = sorted.slice(MAX_DRAFT_CAP);

  for (const old of toEvict) {
    await deleteDraftInternal(db, old.project_id);
  }
}

function getAllDraftsWithDb(db: IDBDatabase): Promise<StoredDraft[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DRAFTS_STORE, 'readonly');
    const store = tx.objectStore(DRAFTS_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as StoredDraft[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

async function deleteDraftInternal(db: IDBDatabase, projectId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([DRAFTS_STORE, AUDIO_STORE], 'readwrite');
    tx.objectStore(DRAFTS_STORE).delete(projectId);

    const audioStore = tx.objectStore(AUDIO_STORE);
    const idx = audioStore.index('project_id');
    const cursorReq = idx.openCursor(IDBKeyRange.only(projectId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Save or update a project draft in IndexedDB and enforce the rolling cap of 5 drafts.
 */
export async function saveDraft(
  state: ProjectState,
  options: { dirty?: boolean } = {}
): Promise<StoredDraft | null> {
  if (!isBrowser()) return null;

  const db = await openDatabase();
  const now = new Date().toISOString();
  const normalizedState: ProjectState = {
    ...state,
    updated_at: now,
  };

  const entry: StoredDraft = {
    project_id: state.project_id,
    state: normalizedState,
    updated_at: now,
    dirty: options.dirty ?? true,
    size_bytes: estimateStateBytes(normalizedState),
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DRAFTS_STORE, 'readwrite');
    tx.objectStore(DRAFTS_STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await enforceRollingCap(db);
  db.close();
  return entry;
}

/**
 * Mark a draft as cleanly saved (so the restore prompt does not nag for already-saved work).
 */
export async function markDraftSaved(projectId: string): Promise<void> {
  if (!isBrowser()) return;
  const draft = await getDraft(projectId);
  if (!draft) return;
  await saveDraft({ ...draft.state, source: 'saved' }, { dirty: false });
}

export async function getDraft(projectId: string): Promise<StoredDraft | null> {
  if (!isBrowser()) return null;
  const db = await openDatabase();
  const result = await new Promise<StoredDraft | null>((resolve, reject) => {
    const tx = db.transaction(DRAFTS_STORE, 'readonly');
    const req = tx.objectStore(DRAFTS_STORE).get(projectId);
    req.onsuccess = () => resolve((req.result as StoredDraft | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export async function listDrafts(): Promise<StoredDraft[]> {
  if (!isBrowser()) return [];
  const db = await openDatabase();
  const drafts = await getAllDraftsWithDb(db);
  db.close();
  return drafts.sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
}

/**
 * Returns the most recent draft eligible for a "Restore session" prompt on reopen.
 */
export async function getLatestRestorableDraft(): Promise<StoredDraft | null> {
  const drafts = await listDrafts();
  if (drafts.length === 0) return null;
  const dirtyDraft = drafts.find((d) => d.dirty);
  return dirtyDraft ?? drafts[0];
}

export async function deleteDraft(projectId: string): Promise<void> {
  if (!isBrowser()) return;
  const db = await openDatabase();
  await deleteDraftInternal(db, projectId);
  db.close();
}

export async function clearAllDrafts(): Promise<void> {
  if (!isBrowser()) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([DRAFTS_STORE, AUDIO_STORE], 'readwrite');
    tx.objectStore(DRAFTS_STORE).clear();
    tx.objectStore(AUDIO_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function saveAudioBlob(
  projectId: string,
  slot: StoredAudioBlob['slot'],
  blob: Blob
): Promise<void> {
  if (!isBrowser()) return;
  const db = await openDatabase();
  const record: StoredAudioBlob = {
    key: `${projectId}:${slot}`,
    project_id: projectId,
    slot,
    mime_type: blob.type || 'audio/wav',
    blob,
    updated_at: new Date().toISOString(),
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getAudioBlob(
  projectId: string,
  slot: StoredAudioBlob['slot']
): Promise<Blob | null> {
  if (!isBrowser()) return null;
  const db = await openDatabase();
  const result = await new Promise<StoredAudioBlob | null>((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readonly');
    const req = tx.objectStore(AUDIO_STORE).get(`${projectId}:${slot}`);
    req.onsuccess = () => resolve((req.result as StoredAudioBlob | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result?.blob ?? null;
}

export async function getStorageUsageBytes(): Promise<{ draftsCount: number; totalBytes: number }> {
  if (!isBrowser()) return { draftsCount: 0, totalBytes: 0 };
  const db = await openDatabase();
  const drafts = await getAllDraftsWithDb(db);
  const audioRecords = await new Promise<StoredAudioBlob[]>((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readonly');
    const req = tx.objectStore(AUDIO_STORE).getAll();
    req.onsuccess = () => resolve((req.result as StoredAudioBlob[]) ?? []);
    req.onerror = () => reject(req.error);
  });
  db.close();

  const draftBytes = drafts.reduce((sum, d) => sum + (d.size_bytes || 0), 0);
  const audioBytes = audioRecords.reduce((sum, a) => sum + (a.blob?.size || 0), 0);
  return {
    draftsCount: drafts.length,
    totalBytes: draftBytes + audioBytes,
  };
}
