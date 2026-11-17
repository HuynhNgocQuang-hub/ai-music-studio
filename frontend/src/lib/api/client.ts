import type {
  AnalyzeRequest,
  AnalyzeResponse,
  AutotuneRequest,
  AutotuneResponse,
  CoachChatRequest,
  CoachChatResponse,
  DenoiseRequest,
  DenoiseResponse,
  HealthResponse,
  JobCreatedResponse,
  JobGenerateRequest,
  JobRearrangeRequest,
  JobRegenerateTrackRequest,
  JobSSEEvent,
  LyricsSuggestRequest,
  LyricsSuggestResponse,
  OverdubFitCheckResponse,
  PaginatedProjectsResponse,
  ProjectState,
  StudioLLMSettings,
  UploadAudioResponse,
} from '@/types/project';

const SETTINGS_STORAGE_KEY = 'ai_music_studio_settings_v1';

export const ALLOWED_AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'ogg', 'flac'] as const;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB (SRS FR-INP)
export const MIN_AUDIO_DURATION_SEC = 3; // 3 seconds minimum (SRS FR-INP)

export const DEFAULT_LLM_SETTINGS: StudioLLMSettings = {
  geminiApiKey: '',
  openaiApiKey: '',
  defaultProvider: 'gemini',
  agentProviders: {
    composer: 'gemini',
    arranger: 'openai',
    lyricist: 'gemini',
    coach: 'gemini',
    qa: 'openai',
  },
  backendUrl: process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000',
};

export function loadStudioSettings(): StudioLLMSettings {
  if (typeof window === 'undefined') return DEFAULT_LLM_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_LLM_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<StudioLLMSettings>;
    return {
      ...DEFAULT_LLM_SETTINGS,
      ...parsed,
      agentProviders: {
        ...DEFAULT_LLM_SETTINGS.agentProviders,
        ...(parsed.agentProviders || {}),
      },
    };
  } catch {
    return DEFAULT_LLM_SETTINGS;
  }
}

export function saveStudioSettings(settings: StudioLLMSettings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function getApiBaseUrl(): string {
  const settings = loadStudioSettings();
  return (settings.backendUrl || DEFAULT_LLM_SETTINGS.backendUrl).replace(/\/+$/, '');
}

function buildLLMHeaders(): Record<string, string> {
  const s = loadStudioSettings();
  const headers: Record<string, string> = {};
  if (s.geminiApiKey) headers['X-Gemini-Api-Key'] = s.geminiApiKey;
  if (s.openaiApiKey) headers['X-OpenAI-Api-Key'] = s.openaiApiKey;
  if (s.defaultProvider) headers['X-LLM-Provider'] = s.defaultProvider;
  return headers;
}

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${getApiBaseUrl()}${path}`;
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const headers: Record<string, string> = {
    ...buildLLMHeaders(),
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...((init.headers as Record<string, string>) || {}),
  };

  const response = await fetch(url, {
    ...init,
    headers,
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: string; message?: string };
      detail = body.detail || body.message || detail;
    } catch {
      const text = await response.text().catch(() => '');
      if (text) detail = text;
    }
    throw new ApiError(response.status, detail);
  }

  return (await response.json()) as T;
}

async function requestBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const url = `${getApiBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    ...buildLLMHeaders(),
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    let detail = `HTTP ${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // ignore parse failure
    }
    throw new ApiError(response.status, detail);
  }
  return await response.blob();
}

/**
 * Resolve backend audio ref (`mem://...` or `/api/...` or full http URL) into a playable URL.
 */
export function resolveAudioUrl(ref: string | null | undefined, _projectId?: string): string | null {
  if (!ref) return null;
  if (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('blob:')) {
    return ref;
  }
  const base = getApiBaseUrl();
  if (ref.startsWith('/')) {
    return `${base}${ref}`;
  }
  const params = new URLSearchParams({ ref });
  return `${base}/api/audio/asset?${params.toString()}`;
}

export function getQuickPreviewUrl(
  projectId: string,
  mode: 'ai_mix' | 'dry_beat' | 'autotune_beat' | 'preserve' | 'enhance' = 'ai_mix'
): string {
  const params = new URLSearchParams({ mode });
  return `${getApiBaseUrl()}/api/audio/preview/${encodeURIComponent(projectId)}?${params.toString()}`;
}

export function validateAudioFileClient(file: File): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (!ALLOWED_AUDIO_EXTENSIONS.includes(ext as (typeof ALLOWED_AUDIO_EXTENSIONS)[number])) {
    return `Định dạng không hỗ trợ (.${ext || '?'}). Chỉ chấp nhận: WAV, MP3, M4A, OGG, FLAC.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `Dung lượng file (${(file.size / 1024 / 1024).toFixed(1)} MB) vượt quá giới hạn 50 MB.`;
  }
  return null;
}

// ============================================================
// 3.0 Health & Settings
// ============================================================
export async function checkHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/api/health', { method: 'GET' });
}

// ============================================================
// 3.1 Audio Input, Denoise & Auto-Tune
// ============================================================
export async function uploadAudio(file: Blob | File, filename = 'recording.wav', projectId?: string): Promise<UploadAudioResponse> {
  const formData = new FormData();
  formData.append('file', file, filename);
  if (projectId) {
    formData.append('project_id', projectId);
  }
  return requestJson<UploadAudioResponse>('/api/audio/upload', {
    method: 'POST',
    body: formData,
  });
}

export async function denoiseAudio(payload: DenoiseRequest): Promise<DenoiseResponse> {
  return requestJson<DenoiseResponse>('/api/audio/denoise', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function analyzeAudio(payload: AnalyzeRequest): Promise<AnalyzeResponse> {
  return requestJson<AnalyzeResponse>('/api/audio/analyze', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function autotuneAudio(payload: AutotuneRequest): Promise<AutotuneResponse> {
  return requestJson<AutotuneResponse>('/api/audio/autotune', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ============================================================
// 3.2 Multi-Agent Jobs & Realtime SSE Progress
// ============================================================
export async function startGenerateJob(payload: JobGenerateRequest): Promise<JobCreatedResponse> {
  return requestJson<JobCreatedResponse>('/api/jobs/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function regenerateTrackJob(payload: JobRegenerateTrackRequest): Promise<JobCreatedResponse> {
  return requestJson<JobCreatedResponse>('/api/jobs/regenerate-track', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function rearrangeChordsJob(payload: JobRearrangeRequest): Promise<JobCreatedResponse> {
  return requestJson<JobCreatedResponse>('/api/jobs/rearrange', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function cancelJob(jobId: string): Promise<{ status: string }> {
  return requestJson<{ status: string }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  });
}

/**
 * Subscribe to SSE stream `/api/jobs/{jobId}/events`.
 * Supports named SSE events (`agent_step`, `qa_retry`, `progress`, `completed`, `fallback_warning`, `error`)
 * as well as default `message` events carrying `{ type, ... }`.
 */
export function subscribeJobEvents(
  jobId: string,
  onEvent: (event: JobSSEEvent) => void,
  onTransportError?: (err: unknown) => void
): () => void {
  const url = `${getApiBaseUrl()}/api/jobs/${encodeURIComponent(jobId)}/events`;
  const source = new EventSource(url);
  let closed = false;

  const eventTypes: JobSSEEvent['type'][] = [
    'agent_step',
    'qa_retry',
    'progress',
    'completed',
    'fallback_warning',
    'error',
  ];

  const handleParsed = (fallbackType: JobSSEEvent['type'], rawData: string) => {
    try {
      const parsed = JSON.parse(rawData) as Partial<JobSSEEvent>;
      const evt: JobSSEEvent = {
        ...parsed,
        type: parsed.type || fallbackType,
      };
      onEvent(evt);
      if (evt.type === 'completed' || evt.type === 'error') {
        cleanup();
      }
    } catch {
      onEvent({ type: fallbackType, message: rawData });
    }
  };

  const listeners: Array<[string, (e: MessageEvent) => void]> = [];

  for (const typeName of eventTypes) {
    const fn = (e: MessageEvent) => handleParsed(typeName, e.data);
    source.addEventListener(typeName, fn as EventListener);
    listeners.push([typeName, fn]);
  }

  source.onmessage = (e: MessageEvent) => {
    handleParsed('agent_step', e.data);
  };

  source.onerror = (err) => {
    if (closed) return;
    onTransportError?.(err);
    cleanup();
  };

  function cleanup() {
    if (closed) return;
    closed = true;
    for (const [typeName, fn] of listeners) {
      source.removeEventListener(typeName, fn as EventListener);
    }
    source.close();
  }

  return cleanup;
}

// ============================================================
// 3.3 Studio, Overdub Fit Check, Lyrics & Coach
// ============================================================
export async function overdubFitCheck(
  projectId: string,
  audioBlob: Blob
): Promise<OverdubFitCheckResponse> {
  const formData = new FormData();
  formData.append('project_id', projectId);
  formData.append('file', audioBlob, 'overdub.wav');
  return requestJson<OverdubFitCheckResponse>('/api/studio/overdub-fit-check', {
    method: 'POST',
    body: formData,
  });
}

export async function suggestLyrics(payload: LyricsSuggestRequest): Promise<LyricsSuggestResponse> {
  return requestJson<LyricsSuggestResponse>('/api/lyrics/suggest', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function chatWithCoach(payload: CoachChatRequest): Promise<CoachChatResponse> {
  return requestJson<CoachChatResponse>('/api/coach/chat', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ============================================================
// 3.4 Persistence, Sync & Export
// ============================================================
export async function listProjects(params: {
  page?: number;
  limit?: number;
  search?: string;
  genre?: string;
}): Promise<PaginatedProjectsResponse> {
  const query = new URLSearchParams();
  query.set('page', String(params.page ?? 1));
  query.set('limit', String(params.limit ?? 12));
  if (params.search) query.set('search', params.search);
  if (params.genre) query.set('genre', params.genre);
  return requestJson<PaginatedProjectsResponse>(`/api/projects?${query.toString()}`, {
    method: 'GET',
  });
}

function hydrateProjectTitle(state: ProjectState): ProjectState {
  const effectiveTitle = state.config?.title || state.title || 'Untitled Session';
  return {
    ...state,
    title: effectiveTitle,
    config: {
      ...state.config,
      title: effectiveTitle,
    },
  };
}

export async function getProject(projectId: string): Promise<ProjectState> {
  const res = await requestJson<ProjectState>(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'GET',
  });
  return hydrateProjectTitle(res);
}

export async function syncProject(projectId: string, state: ProjectState): Promise<ProjectState> {
  const normalized = hydrateProjectTitle(state);
  const res = await requestJson<ProjectState>(`/api/projects/${encodeURIComponent(projectId)}/sync`, {
    method: 'PUT',
    body: JSON.stringify(normalized),
  });
  return hydrateProjectTitle(res);
}

export async function exportAimusic(projectId: string): Promise<Blob> {
  return requestBlob(`/api/projects/${encodeURIComponent(projectId)}/export/aimusic`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function importAimusic(file: File): Promise<ProjectState> {
  const formData = new FormData();
  formData.append('file', file, file.name);
  const res = await requestJson<ProjectState>('/api/projects/import', {
    method: 'POST',
    body: formData,
  });
  return hydrateProjectTitle(res);
}

export async function exportAudio(
  projectId: string,
  format: 'wav' | 'mp3' | 'stems',
  applyMastering = true,
  mode: 'ai_mix' | 'dry_beat' | 'autotune_beat' | 'preserve' | 'enhance' = 'ai_mix'
): Promise<Blob> {
  return requestBlob(`/api/projects/${encodeURIComponent(projectId)}/export/audio`, {
    method: 'POST',
    body: JSON.stringify({ format, apply_mastering: applyMastering, mode }),
  });
}

export async function exportMidi(projectId: string): Promise<Blob> {
  return requestBlob(`/api/projects/${encodeURIComponent(projectId)}/export/midi`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  if (typeof window === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
