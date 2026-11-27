import type {
  AnalyzeRequest,
  AnalyzeResponse,
  AuthSessionResponse,
  AutoMixResponse,
  AutoTrimVocalResponse,
  AutotuneRequest,
  AutotuneResponse,
  ClipUploadResponse,
  CoachAssistantMode,
  CoachChatRequest,
  CoachChatResponse,
  CoachSuggestedAction,
  CollabSessionSummary,
  DenoiseRequest,
  DenoiseResponse,
  HealthResponse,
  JobCreatedResponse,
  JobGenerateRequest,
  JobRearrangeRequest,
  JobRegenerateTrackRequest,
  JobSSEEvent,
  LlmTestResponse,
  LyricsSuggestRequest,
  LyricsSuggestResponse,
  OverdubFitCheckResponse,
  PaginatedProjectsResponse,
  PaginatedReleasesResponse,
  ProjectState,
  PublishedRelease,
  PublishReleaseRequest,
  PublishReleaseResponse,
  ReleaseComment,
  StudioBarComment,
  StudioLLMSettings,
  UploadAudioResponse,
} from '@/types/project';

const SETTINGS_STORAGE_KEY = 'ai_music_studio_settings_v1';
const AUTH_TOKEN_STORAGE_KEY = 'ai_music_studio_auth_token_v1';

export function getAuthToken(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '';
}

export function setAuthToken(token: string): void {
  if (typeof window === 'undefined') return;
  if (token) {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  }
}

export function clearAuthToken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

export const ALLOWED_AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'ogg', 'flac'] as const;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB (SRS FR-INP)
export const MIN_AUDIO_DURATION_SEC = 3; // 3 seconds minimum (SRS FR-INP)
export const MAX_HUM_DURATION_SEC = 60; // 1 minute in hum mode (SRS FR-INP)
export const MAX_VOCAL_DURATION_SEC = 300; // 5 minutes in vocal mode (SRS FR-INP)

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
  backendUrl: import.meta.env.VITE_API_BASE_URL ?? '',
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
  if (s.agentProviders) headers['X-Agent-Providers'] = JSON.stringify(s.agentProviders);
  const token = getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
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
  mode:
    | 'raw'
    | 'dry'
    | 'autotune'
    | 'ai_mix'
    | 'dry_beat'
    | 'autotune_beat'
    | 'preserve'
    | 'enhance' = 'ai_mix'
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

export async function testLlmConnection(): Promise<LlmTestResponse> {
  return requestJson<LlmTestResponse>('/api/health/llm-test', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function clearBackendCache(): Promise<{ status: string; cleared_assets?: number }> {
  return requestJson<{ status: string; cleared_assets?: number }>('/api/settings/cache/clear', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// ============================================================
// 3.1 Audio Input, Denoise & Auto-Tune
// ============================================================
export async function uploadAudio(
  file: Blob | File,
  filename = 'recording.wav',
  projectId?: string,
  mode: 'hum' | 'vocal' = 'hum'
): Promise<UploadAudioResponse> {
  const formData = new FormData();
  formData.append('file', file, filename);
  if (projectId) {
    formData.append('project_id', projectId);
  }
  formData.append('mode', mode);
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

export async function uploadTrackClip(
  projectId: string,
  file: File | Blob,
  trackId = 'texture'
): Promise<ClipUploadResponse> {
  const formData = new FormData();
  formData.append('project_id', projectId);
  formData.append('track_id', trackId);
  const filename = file instanceof File ? file.name : `${trackId}_clip.wav`;
  formData.append('file', file, filename);
  const res = await requestJson<ClipUploadResponse>('/api/audio/clip-upload', {
    method: 'POST',
    body: formData,
  });
  return {
    ...res,
    project_state: hydrateProjectTitle(res.project_state),
  };
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

export async function autoTrimVocal(projectId: string): Promise<AutoTrimVocalResponse> {
  const raw = await requestJson<AutoTrimVocalResponse | (ProjectState & { summary?: string })>(
    '/api/studio/auto-trim-vocal',
    {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId }),
    }
  );
  if ('project_state' in raw && raw.project_state) {
    return {
      ...raw,
      project_state: hydrateProjectTitle(raw.project_state),
    };
  }
  return {
    project_state: hydrateProjectTitle(raw as ProjectState),
    summary: raw.summary,
  };
}

export interface SeparateStemsResponse {
  project_id: string;
  vocal_ref: string;
  beat_ref: string;
  method: string;
  duration_sec?: number;
  summary: string;
  project_state: ProjectState;
}

export async function separateStems(
  projectId: string,
  sourceRef?: string
): Promise<SeparateStemsResponse> {
  const raw = await requestJson<SeparateStemsResponse>('/api/studio/separate-stems', {
    method: 'POST',
    body: JSON.stringify({
      project_id: projectId,
      ...(sourceRef ? { source_ref: sourceRef } : {}),
    }),
  });
  return {
    ...raw,
    project_state: hydrateProjectTitle(raw.project_state),
  };
}

export interface SoundFontUploadResponse {
  status: string;
  filename: string;
  size_bytes: number;
  active_on_worker: boolean;
}

export async function uploadSoundFont(file: File): Promise<SoundFontUploadResponse> {
  const formData = new FormData();
  formData.append('file', file, file.name);
  return requestJson<SoundFontUploadResponse>('/api/audio/soundfont', {
    method: 'POST',
    body: formData,
  });
}

export async function autoMixProject(projectId: string): Promise<AutoMixResponse> {
  const raw = await requestJson<AutoMixResponse | (ProjectState & { summary?: string; mix_notes?: string[] })>(
    '/api/studio/auto-mix',
    {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId }),
    }
  );
  if ('project_state' in raw && raw.project_state) {
    return {
      ...raw,
      project_state: hydrateProjectTitle(raw.project_state),
    };
  }
  return {
    project_state: hydrateProjectTitle(raw as ProjectState),
    summary: raw.summary,
    mix_notes: raw.mix_notes,
  };
}

export async function suggestLyrics(payload: LyricsSuggestRequest): Promise<LyricsSuggestResponse> {
  return requestJson<LyricsSuggestResponse>('/api/lyrics/suggest', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function chatWithCoach(payload: CoachChatRequest): Promise<CoachChatResponse> {
  const cleanHistory = payload.history.map(({ role, content, timestamp }) => ({
    role,
    content,
    ...(timestamp ? { timestamp } : {}),
  }));
  return requestJson<CoachChatResponse>('/api/coach/chat', {
    method: 'POST',
    body: JSON.stringify({
      ...payload,
      history: cleanHistory,
    }),
  });
}

export async function streamCoachChat(
  payload: CoachChatRequest,
  handlers: {
    onChunk: (deltaText: string) => void;
    onActions?: (data: { provider?: string; suggested_actions: CoachSuggestedAction[] }) => void;
    onDone?: (res: CoachChatResponse) => void;
    signal?: AbortSignal;
  }
): Promise<CoachChatResponse> {
  const cleanHistory = payload.history.map(({ role, content, timestamp }) => ({
    role,
    content,
    ...(timestamp ? { timestamp } : {}),
  }));
  const url = `${getApiBaseUrl()}/api/coach/chat/stream`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...buildLLMHeaders(),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      ...payload,
      history: cleanHistory,
    }),
    signal: handlers.signal,
  });

  if (!response.ok || !response.body) {
    const fallback = await chatWithCoach(payload);
    handlers.onChunk(fallback.reply);
    handlers.onActions?.({ provider: fallback.provider, suggested_actions: fallback.suggested_actions });
    handlers.onDone?.(fallback);
    return fallback;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];
  let accReply = '';
  let lastProvider: string | undefined;
  let lastActions: CoachSuggestedAction[] = [];
  let finalResp: CoachChatResponse | null = null;

  const dispatchEvent = (evt: string, rawData: string) => {
    if (!rawData) return;
    try {
      const parsed = JSON.parse(rawData) as Record<string, unknown>;
      if (evt === 'chunk' && typeof parsed.text === 'string') {
        accReply += parsed.text;
        handlers.onChunk(parsed.text);
      } else if (evt === 'actions') {
        lastProvider = typeof parsed.provider === 'string' ? parsed.provider : lastProvider;
        lastActions = Array.isArray(parsed.suggested_actions)
          ? (parsed.suggested_actions as CoachSuggestedAction[])
          : lastActions;
        handlers.onActions?.({ provider: lastProvider, suggested_actions: lastActions });
      } else if (evt === 'done') {
        finalResp = {
          reply: typeof parsed.reply === 'string' ? parsed.reply : accReply,
          provider: typeof parsed.provider === 'string' ? parsed.provider : lastProvider,
          suggested_actions: Array.isArray(parsed.suggested_actions)
            ? (parsed.suggested_actions as CoachSuggestedAction[])
            : lastActions,
        };
        handlers.onDone?.(finalResp);
      } else if (evt === 'error' && typeof parsed.message === 'string') {
        throw new ApiError(500, parsed.message);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        dispatchEvent(eventName, dataLines.join('\n'));
        eventName = 'message';
        dataLines = [];
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  if (dataLines.length > 0) {
    dispatchEvent(eventName, dataLines.join('\n'));
  }

  return (
    finalResp ?? {
      reply: accReply,
      provider: lastProvider,
      suggested_actions: lastActions,
    }
  );
}

export async function chatWithCoachAudio(params: {
  project_id: string;
  message: string;
  mode?: CoachAssistantMode;
  route?: string;
  file?: Blob;
  filename?: string;
}): Promise<CoachChatResponse> {
  const form = new FormData();
  form.append('project_id', params.project_id);
  form.append('message', params.message);
  if (params.mode) form.append('mode', params.mode);
  if (params.route) form.append('route', params.route);
  if (params.file) {
    form.append('file', params.file, params.filename || 'chat_audio.wav');
  }
  return requestJson<CoachChatResponse>('/api/coach/chat/audio', {
    method: 'POST',
    body: form,
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
  scope?: 'all' | 'mine' | 'public';
}): Promise<PaginatedProjectsResponse> {
  const query = new URLSearchParams();
  query.set('page', String(params.page ?? 1));
  query.set('limit', String(params.limit ?? 12));
  if (params.search) query.set('search', params.search);
  if (params.genre) query.set('genre', params.genre);
  if (params.scope) query.set('scope', params.scope);
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

export async function getProject(projectId: string, collabCode?: string | null): Promise<ProjectState> {
  const basePath = `/api/projects/${encodeURIComponent(projectId)}`;
  const path = collabCode ? `${basePath}?collab=${encodeURIComponent(collabCode)}` : basePath;
  const res = await requestJson<ProjectState>(path, {
    method: 'GET',
  });
  return hydrateProjectTitle(res);
}

export async function syncProject(
  projectId: string,
  state: ProjectState,
  collabCode?: string | null
): Promise<ProjectState> {
  const normalized = hydrateProjectTitle(state);
  const basePath = `/api/projects/${encodeURIComponent(projectId)}/sync`;
  const path = collabCode ? `${basePath}?collab=${encodeURIComponent(collabCode)}` : basePath;
  const res = await requestJson<ProjectState>(path, {
    method: 'PUT',
    body: JSON.stringify(normalized),
  });
  return hydrateProjectTitle(res);
}

export async function deleteProject(projectId: string): Promise<{ status: string; project_id: string }> {
  return requestJson<{ status: string; project_id: string }>(
    `/api/projects/${encodeURIComponent(projectId)}`,
    {
      method: 'DELETE',
    }
  );
}

export async function exportAimusic(projectId: string): Promise<Blob> {
  return requestBlob(`/api/projects/${encodeURIComponent(projectId)}/export/aimusic`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function importAimusic(file: File, overwrite = false): Promise<ProjectState> {
  const formData = new FormData();
  formData.append('file', file, file.name);
  formData.append('overwrite', String(overwrite));
  const res = await requestJson<ProjectState>('/api/projects/import', {
    method: 'POST',
    body: formData,
  });
  return hydrateProjectTitle(res);
}

export async function exportAudio(
  projectId: string,
  format: 'wav' | 'mp3' | 'flac' | 'stems',
  applyMastering = true,
  mode: 'ai_mix' | 'dry_beat' | 'autotune_beat' | 'preserve' | 'enhance' = 'ai_mix',
  bitrate: '192k' | '320k' = '320k',
  metadata?: { title?: string; artist?: string; album?: string; genre?: string }
): Promise<Blob> {
  return requestBlob(`/api/projects/${encodeURIComponent(projectId)}/export/audio`, {
    method: 'POST',
    body: JSON.stringify({
      format,
      apply_mastering: applyMastering,
      mode,
      bitrate,
      ...(metadata || {}),
    }),
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

// ============================================================
// 3.5 Phase 8: Multi-User JWT Auth, Cloud Quota & Public Share
// ============================================================
export async function registerAccount(payload: {
  email: string;
  password: string;
  display_name: string;
}): Promise<AuthSessionResponse> {
  return requestJson<AuthSessionResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function loginAccount(payload: {
  email: string;
  password: string;
}): Promise<AuthSessionResponse> {
  return requestJson<AuthSessionResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function oauthDevLogin(provider: 'google' | 'github'): Promise<AuthSessionResponse> {
  return requestJson<AuthSessionResponse>('/api/auth/oauth/dev', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  });
}

export async function fetchAuthMe(): Promise<AuthSessionResponse> {
  return requestJson<AuthSessionResponse>('/api/auth/me', {
    method: 'GET',
  });
}

export async function logoutAccount(): Promise<{ status: string; authenticated: boolean; revoked?: boolean }> {
  try {
    return await requestJson<{ status: string; authenticated: boolean; revoked?: boolean }>('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } finally {
    clearAuthToken();
  }
}

export async function publishProject(
  projectId: string,
  payload: PublishReleaseRequest = {}
): Promise<PublishReleaseResponse> {
  return requestJson<PublishReleaseResponse>(`/api/projects/${encodeURIComponent(projectId)}/publish`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function unpublishProject(
  projectId: string
): Promise<{ status: string; project_id: string }> {
  return requestJson<{ status: string; project_id: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/publish`,
    {
      method: 'DELETE',
    }
  );
}

export async function listPublicReleases(params: {
  page?: number;
  limit?: number;
  search?: string;
  genre?: string;
} = {}): Promise<PaginatedReleasesResponse> {
  const query = new URLSearchParams();
  query.set('page', String(params.page ?? 1));
  query.set('limit', String(params.limit ?? 12));
  if (params.search) query.set('search', params.search);
  if (params.genre) query.set('genre', params.genre);
  return requestJson<PaginatedReleasesResponse>(`/api/share?${query.toString()}`, {
    method: 'GET',
  });
}

export async function getPublicShare(slug: string): Promise<PublishedRelease> {
  return requestJson<PublishedRelease>(`/api/share/${encodeURIComponent(slug)}`, {
    method: 'GET',
  });
}

export function getPublicShareAudioUrl(slug: string): string {
  return `${getApiBaseUrl()}/api/share/${encodeURIComponent(slug)}/audio`;
}

// ============================================================
// 3.6 Phase 9: Showcase Likes/Comments & Realtime Studio Collab
// ============================================================
export async function toggleShareLike(
  slug: string
): Promise<{ share_slug: string; liked: boolean; likes_count: number }> {
  return requestJson<{ share_slug: string; liked: boolean; likes_count: number }>(
    `/api/share/${encodeURIComponent(slug)}/like`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );
}

export async function listShareComments(
  slug: string
): Promise<{ share_slug: string; items: ReleaseComment[]; count: number }> {
  return requestJson<{ share_slug: string; items: ReleaseComment[]; count: number }>(
    `/api/share/${encodeURIComponent(slug)}/comments`,
    { method: 'GET' }
  );
}

export async function postShareComment(
  slug: string,
  payload: { timestamp_sec: number; bar_number?: number; text: string; author_name?: string }
): Promise<ReleaseComment & { comments_count?: number }> {
  return requestJson<ReleaseComment & { comments_count?: number }>(
    `/api/share/${encodeURIComponent(slug)}/comments`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export async function deleteShareComment(
  slug: string,
  commentId: string
): Promise<{ status: string; comment_id: string; comments_count: number }> {
  return requestJson<{ status: string; comment_id: string; comments_count: number }>(
    `/api/share/${encodeURIComponent(slug)}/comments/${encodeURIComponent(commentId)}`,
    { method: 'DELETE' }
  );
}

export async function getCollabSession(
  projectId: string,
  collabCode?: string | null
): Promise<CollabSessionSummary> {
  const q = collabCode ? `?collab=${encodeURIComponent(collabCode)}` : '';
  return requestJson<CollabSessionSummary>(`/api/studio/${encodeURIComponent(projectId)}/collab/session${q}`, {
    method: 'GET',
  });
}

export async function enableCollabSession(projectId: string): Promise<CollabSessionSummary> {
  return requestJson<CollabSessionSummary>(`/api/studio/${encodeURIComponent(projectId)}/collab/session`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function closeCollabSession(
  projectId: string
): Promise<{ project_id: string; active: boolean; closed: boolean }> {
  return requestJson<{ project_id: string; active: boolean; closed: boolean }>(
    `/api/studio/${encodeURIComponent(projectId)}/collab/session`,
    { method: 'DELETE' }
  );
}

export async function listStudioBarComments(
  projectId: string,
  collabCode?: string | null
): Promise<{ project_id: string; items: StudioBarComment[] }> {
  const q = collabCode ? `?collab=${encodeURIComponent(collabCode)}` : '';
  return requestJson<{ project_id: string; items: StudioBarComment[] }>(
    `/api/studio/${encodeURIComponent(projectId)}/comments${q}`,
    { method: 'GET' }
  );
}

export async function addStudioBarComment(
  projectId: string,
  payload: { bar_number: number; track_id?: string; text: string; author_name?: string },
  collabCode?: string | null
): Promise<StudioBarComment> {
  const q = collabCode ? `?collab=${encodeURIComponent(collabCode)}` : '';
  return requestJson<StudioBarComment>(`/api/studio/${encodeURIComponent(projectId)}/comments${q}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function toggleStudioBarCommentResolved(
  projectId: string,
  commentId: string,
  resolved: boolean,
  collabCode?: string | null
): Promise<StudioBarComment> {
  const q = collabCode ? `?collab=${encodeURIComponent(collabCode)}` : '';
  return requestJson<StudioBarComment>(
    `/api/studio/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(commentId)}${q}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ resolved }),
    }
  );
}

export async function deleteStudioBarComment(
  projectId: string,
  commentId: string,
  collabCode?: string | null
): Promise<{ status: string; comment_id: string }> {
  const q = collabCode ? `?collab=${encodeURIComponent(collabCode)}` : '';
  return requestJson<{ status: string; comment_id: string }>(
    `/api/studio/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(commentId)}${q}`,
    { method: 'DELETE' }
  );
}

export function buildCollabWsUrl(params: {
  projectId: string;
  clientId: string;
  roomCode?: string | null;
  displayName?: string | null;
}): string {
  const base = getApiBaseUrl();
  let wsOrigin: string;
  if (base.startsWith('https://')) {
    wsOrigin = 'wss://' + base.slice('https://'.length);
  } else if (base.startsWith('http://')) {
    wsOrigin = 'ws://' + base.slice('http://'.length);
  } else if (typeof window !== 'undefined') {
    wsOrigin = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
  } else {
    wsOrigin = 'ws://127.0.0.1:8000';
  }
  const qs = new URLSearchParams();
  qs.set('projectId', params.projectId);
  qs.set('clientId', params.clientId);
  if (params.roomCode) qs.set('room', params.roomCode);
  if (params.displayName) qs.set('displayName', params.displayName);
  const token = getAuthToken();
  if (token) qs.set('token', token);
  return `${wsOrigin.replace(/\/+$/, '')}/ws/collab?${qs.toString()}`;
}
