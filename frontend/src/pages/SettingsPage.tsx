import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Cloud,
  Cpu,
  Database,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  RefreshCw,
  Save,
  Server,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  checkHealth,
  clearBackendCache,
  DEFAULT_LLM_SETTINGS,
  loadStudioSettings,
  saveStudioSettings,
  testLlmConnection,
  uploadSoundFont,
} from '@/lib/api/client';
import { clearAllDrafts, getStorageUsageBytes } from '@/lib/storage/indexeddb';
import type { HealthResponse, LLMProvider, LlmTestResponse, StudioLLMSettings } from '@/types/project';

export default function SettingsPage() {
  const { setAuthModalOpen } = useAuth();
  const [settings, setSettings] = useState<StudioLLMSettings>(DEFAULT_LLM_SETTINGS);
  const [showGemini, setShowGemini] = useState(false);
  const [showOpenai, setShowOpenai] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);
  const [sf2Busy, setSf2Busy] = useState(false);
  const sf2InputRef = useRef<HTMLInputElement | null>(null);

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [testingLlm, setTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<LlmTestResponse | null>(null);
  const [storageInfo, setStorageInfo] = useState({ draftsCount: 0, totalBytes: 0 });

  const refreshHealth = useCallback(async () => {
    setCheckingHealth(true);
    setHealthError(null);
    try {
      const res = await checkHealth();
      setHealth(res);
    } catch {
      setHealth(null);
      setHealthError('Không thể kết nối Backend Spring Boot tại URL đã cấu hình.');
    } finally {
      setCheckingHealth(false);
    }
  }, []);

  const refreshStorage = useCallback(async () => {
    try {
      const usage = await getStorageUsageBytes();
      setStorageInfo(usage);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    setSettings(loadStudioSettings());
    void refreshHealth();
    void refreshStorage();
  }, [refreshHealth, refreshStorage]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    saveStudioSettings(settings);
    setSavedToast(true);
    setTimeout(() => setSavedToast(false), 2500);
    void refreshHealth();
  };

  const handleClearCache = async () => {
    setCacheNotice(null);
    await clearAllDrafts();
    let backendCleared = false;
    try {
      await clearBackendCache();
      backendCleared = true;
    } catch {
      // Backend may be offline; IndexedDB drafts are cleared
    }
    await refreshStorage();
    setCacheNotice(
      backendCleared
        ? 'Đã dọn cache IndexedDB và Backend Spring Boot.'
        : 'Đã dọn cache IndexedDB (Backend offline).'
    );
    setTimeout(() => setCacheNotice(null), 3000);
  };

  const handleTestLlm = async () => {
    saveStudioSettings(settings);
    setTestingLlm(true);
    setLlmTestResult(null);
    try {
      const res = await testLlmConnection();
      setLlmTestResult(res);
      void refreshHealth();
    } catch (err) {
      setLlmTestResult({
        ok: false,
        provider: settings.defaultProvider,
        message: err instanceof Error ? err.message : 'Không thể kết nối Backend để kiểm tra API Key.',
      });
    } finally {
      setTestingLlm(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-white">Cài đặt &amp; Hệ thống</h1>
        <p className="text-xs text-slate-400">
          Cấu hình Gemini / OpenAI API Key, phân vai Multi-Agent và kiểm tra trạng thái Spring Boot,
          Redis, FluidSynth Audio Worker.
        </p>
      </div>

      {/* Infrastructure Health Card */}
      <section className="space-y-4 rounded-2xl border border-white/[0.08] bg-[#16191f] p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <Activity className="h-4 w-4 text-emerald-400" />
            <span>Trạng thái Hạ tầng Local (Docker + Spring Boot)</span>
          </h2>
          <button
            type="button"
            disabled={checkingHealth}
            onClick={() => void refreshHealth()}
            className="flex items-center gap-1.5 rounded-full border border-white/10 px-3.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${checkingHealth ? 'animate-spin' : ''}`} />
            <span>Kiểm tra lại</span>
          </button>
        </div>

        {healthError && (
          <div className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200">
            <XCircle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>{healthError}</span>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-white/[0.08] bg-[#1b1e25] p-3.5">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5" /> Backend Spring Boot
              </span>
              {health?.status === 'ok' || health?.status === 'degraded' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <XCircle className="h-4 w-4 text-rose-400" />
              )}
            </div>
            <p className="mt-1.5 text-sm font-semibold text-white">
              {health ? `Online (${health.status})` : 'Offline'}
            </p>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-[#1b1e25] p-3.5">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="flex items-center gap-1.5">
                <Database className="h-3.5 w-3.5" /> Redis State
              </span>
              {health?.redis?.connected ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <Activity className="h-4 w-4 text-amber-400" />
              )}
            </div>
            <p className="mt-1.5 text-sm font-semibold text-white">
              {health?.redis?.connected
                ? `Connected (${health.redis.used_memory_human || health.redis.backend || 'OK'})`
                : health
                ? `Fallback (${health.redis?.backend || 'In-Memory'})`
                : 'Unknown'}
            </p>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-[#1b1e25] p-3.5">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5" /> FluidSynth / DSP
              </span>
              {health?.engines?.fluidsynth_available ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <Activity className="h-4 w-4 text-amber-400" />
              )}
            </div>
            <p className="mt-1.5 text-sm font-semibold text-white">
              {health?.engines?.custom_soundfont_active
                ? 'Custom .sf2 Active'
                : health?.engines?.fluidsynth_available
                ? health.engines.soundfont_available
                  ? 'FluidSynth + SoundFont Ready'
                  : 'FluidSynth (No SoundFont)'
                : health
                ? `Synth Fallback (${health.engines?.ffmpeg_available ? 'FFmpeg OK' : 'Pure DSP'})`
                : 'Unknown'}
            </p>
            <input
              ref={sf2InputRef}
              type="file"
              accept=".sf2"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                setSf2Busy(true);
                void uploadSoundFont(file)
                  .then((res) => {
                    setCacheNotice(`Đã nạp SoundFont ${res.filename} (${Math.round(res.size_bytes / 1024)} KB).`);
                    void refreshHealth();
                  })
                  .catch((err) => {
                    setCacheNotice(err instanceof Error ? err.message : 'Lỗi tải file .sf2.');
                  })
                  .finally(() => setSf2Busy(false));
              }}
            />
            <button
              type="button"
              disabled={sf2Busy}
              onClick={() => sf2InputRef.current?.click()}
              className="mt-2 inline-flex items-center gap-1 rounded border border-amber-400/35 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
            >
              <Upload className="h-2.5 w-2.5" />
              <span>{sf2Busy ? 'Đang nạp...' : 'Nạp SoundFont (.sf2)'}</span>
            </button>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-[#1b1e25] p-3.5">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5" /> LLM AI Provider
              </span>
              {health?.llm_providers?.gemini_configured || health?.llm_providers?.openai_configured ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <Activity className="h-4 w-4 text-amber-400" />
              )}
            </div>
            <p className="mt-1.5 text-sm font-semibold text-white">
              {health?.llm_providers?.gemini_configured
                ? 'Gemini Key Ready'
                : health?.llm_providers?.openai_configured
                ? 'OpenAI Key Ready'
                : 'Mock Fallback Mode'}
            </p>
          </div>
        </div>

        {/* Phase 8 Cloud & Storage Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#1b1e25] px-4 py-3 text-xs">
          <div className="flex flex-wrap items-center gap-4 text-slate-300">
            <span className="inline-flex items-center gap-1.5">
              <Cloud className="h-3.5 w-3.5 text-amber-400" />
              Cloud DB:{' '}
              <strong className="text-white">
                {health?.cloud?.postgres_connected
                  ? 'PostgreSQL Online'
                  : health?.cloud?.database_backend || 'H2 Local Fallback'}
              </strong>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <HardDrive className="h-3.5 w-3.5 text-emerald-400" />
              Object Storage:{' '}
              <strong className="text-white">
                {health?.cloud?.object_storage_connected
                  ? `MinIO S3 (${health.cloud.bucket || 'aimusic-cloud'})`
                  : health?.cloud?.object_storage_backend || 'Local S3 Fallback'}
              </strong>
            </span>
          </div>
          <button
            type="button"
            onClick={() => setAuthModalOpen(true)}
            className="rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-[11px] font-bold text-amber-200 transition hover:bg-amber-500/25"
          >
            Quản lý Tài khoản Cloud &amp; Quota
          </button>
        </div>
      </section>

      {/* Dual LLM API Key Form */}
      <form
        onSubmit={handleSave}
        autoComplete="off"
        className="space-y-5 rounded-2xl border border-white/[0.08] bg-[#16191f] p-5"
      >
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <KeyRound className="h-4 w-4 text-amber-400" />
          <span>Dual LLM API Keys &amp; Phân vai Multi-Agent</span>
        </h2>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label
              htmlFor="settings-backend-url"
              className="mb-1.5 block text-xs font-medium text-slate-300"
            >
              Backend Spring Boot URL
            </label>
            <input
              id="settings-backend-url"
              name="backendUrl"
              type="url"
              autoComplete="url"
              value={settings.backendUrl}
              onChange={(e) => setSettings((s) => ({ ...s, backendUrl: e.target.value }))}
              placeholder="http://localhost:8000"
              className="w-full rounded-xl border border-white/10 bg-[#0b0d11] px-3 py-2 text-sm text-white focus:border-amber-400 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="settings-default-provider"
              className="mb-1.5 block text-xs font-medium text-slate-300"
            >
              Provider Mặc định (khi không truyền Key dùng Mock)
            </label>
            <select
              id="settings-default-provider"
              name="defaultProvider"
              value={settings.defaultProvider}
              onChange={(e) =>
                setSettings((s) => ({ ...s, defaultProvider: e.target.value as LLMProvider }))
              }
              className="w-full rounded-xl border border-white/10 bg-[#0b0d11] px-3 py-2 text-sm text-white focus:border-amber-400 focus:outline-none"
            >
              <option value="gemini">Google Gemini API</option>
              <option value="openai">OpenAI API</option>
              <option value="mock">Mock Provider (Offline / Test)</option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label
              htmlFor="settings-gemini-key"
              className="mb-1.5 block text-xs font-medium text-slate-300"
            >
              Gemini API Key (Google AI Studio)
            </label>
            <div className="relative">
              <input
                id="settings-gemini-key"
                name="geminiApiKey"
                type={showGemini ? 'text' : 'password'}
                autoComplete="off"
                value={settings.geminiApiKey}
                onChange={(e) => setSettings((s) => ({ ...s, geminiApiKey: e.target.value }))}
                placeholder="AQ... hoặc AIza..."
                className="w-full rounded-xl border border-white/10 bg-[#0b0d11] py-2 pl-3 pr-10 text-sm text-white focus:border-amber-400 focus:outline-none"
              />
              <button
                type="button"
                aria-label={showGemini ? 'Ẩn Gemini API Key' : 'Hiện Gemini API Key'}
                onClick={() => setShowGemini((v) => !v)}
                className="absolute right-2.5 top-2.5 text-slate-400 hover:text-white"
              >
                {showGemini ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor="settings-openai-key"
              className="mb-1.5 block text-xs font-medium text-slate-300"
            >
              OpenAI API Key (OpenAI Platform)
            </label>
            <div className="relative">
              <input
                id="settings-openai-key"
                name="openaiApiKey"
                type={showOpenai ? 'text' : 'password'}
                autoComplete="off"
                value={settings.openaiApiKey}
                onChange={(e) => setSettings((s) => ({ ...s, openaiApiKey: e.target.value }))}
                placeholder="sk-..."
                className="w-full rounded-xl border border-white/10 bg-[#0b0d11] py-2 pl-3 pr-10 text-sm text-white focus:border-amber-400 focus:outline-none"
              />
              <button
                type="button"
                aria-label={showOpenai ? 'Ẩn OpenAI API Key' : 'Hiện OpenAI API Key'}
                onClick={() => setShowOpenai((v) => !v)}
                className="absolute right-2.5 top-2.5 text-slate-400 hover:text-white"
              >
                {showOpenai ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* Agent Role Assignment */}
        <div>
          <p className="mb-2 text-xs font-semibold text-slate-400">Phân vai cho từng Agent</p>
          <div className="grid gap-3 sm:grid-cols-5">
            {(
              [
                ['composer', 'Composer'],
                ['arranger', 'Arranger'],
                ['lyricist', 'Lyricist'],
                ['coach', 'AI Coach'],
                ['qa', 'QA Reviewer'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="rounded-xl border border-white/[0.08] bg-[#1b1e25] p-2.5">
                <label
                  htmlFor={`agent-provider-${key}`}
                  className="mb-1 block text-[11px] font-medium text-slate-300"
                >
                  {label}
                </label>
                <select
                  id={`agent-provider-${key}`}
                  name={`agentProvider_${key}`}
                  value={settings.agentProviders[key]}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      agentProviders: {
                        ...s.agentProviders,
                        [key]: e.target.value as LLMProvider,
                      },
                    }))
                  }
                  className="w-full rounded-lg border border-white/10 bg-[#0b0d11] px-2 py-1 text-xs text-white"
                >
                  <option value="gemini">Gemini</option>
                  <option value="openai">OpenAI</option>
                  <option value="mock">Mock</option>
                </select>
              </div>
            ))}
          </div>
        </div>

        {llmTestResult && (
          <div
            className={`flex items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-xs ${
              llmTestResult.ok
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : llmTestResult.is_mock
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
            }`}
          >
            <div className="flex items-center gap-2">
              {llmTestResult.ok ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
              ) : (
                <XCircle className="h-4 w-4 shrink-0 text-rose-400" />
              )}
              <span>
                <strong>[{llmTestResult.provider.toUpperCase()}]</strong> {llmTestResult.message}
              </span>
            </div>
            {typeof llmTestResult.latency_ms === 'number' && llmTestResult.latency_ms > 0 && (
              <span className="shrink-0 font-mono text-[11px] opacity-85">
                {llmTestResult.latency_ms}ms
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <HardDrive className="h-4 w-4 text-amber-400" />
            <span>
              Cache IndexedDB: {storageInfo.draftsCount} nháp (
              {(storageInfo.totalBytes / 1024).toFixed(1)} KB)
            </span>
            <button
              type="button"
              onClick={() => void handleClearCache()}
              className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-rose-300 transition hover:bg-rose-500/20"
            >
              <Trash2 className="h-3 w-3" /> Dọn Cache
            </button>
            {cacheNotice && <span className="text-emerald-400">{cacheNotice}</span>}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {savedToast && (
              <span className="text-xs font-medium text-emerald-400">Đã lưu cài đặt!</span>
            )}
            <button
              type="button"
              disabled={testingLlm}
              onClick={() => void handleTestLlm()}
              className="flex items-center gap-1.5 rounded-lg border border-sky-400/40 bg-sky-500/15 px-4 py-2 text-xs font-bold text-sky-200 transition hover:bg-sky-500/25 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${testingLlm ? 'animate-spin' : ''}`} />
              <span>{testingLlm ? 'Đang kiểm tra...' : 'Test API Key'}</span>
            </button>
            <button
              type="submit"
              className="flex items-center gap-2 rounded-lg bg-amber-500 px-5 py-2 text-sm font-bold text-slate-950 transition hover:bg-amber-400"
            >
              <Save className="h-4 w-4" />
              <span>Lưu cấu hình</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
