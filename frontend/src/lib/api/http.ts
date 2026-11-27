import type { StudioLLMSettings } from '@/types/project';

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

export function buildLLMHeaders(): Record<string, string> {
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

async function throwResponseError(response: Response, allowPlainText: boolean): Promise<never> {
  let detail = `HTTP ${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { detail?: string; message?: string };
    detail = body.detail || body.message || detail;
  } catch {
    if (allowPlainText) {
      const text = await response.text().catch(() => '');
      if (text) detail = text;
    }
  }
  throw new ApiError(response.status, detail);
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    await throwResponseError(response, true);
  }

  return (await response.json()) as T;
}

export async function requestBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const url = `${getApiBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    ...buildLLMHeaders(),
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    await throwResponseError(response, false);
  }
  return await response.blob();
}
