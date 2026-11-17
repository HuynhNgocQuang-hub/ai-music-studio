import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
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
  XCircle,
} from 'lucide-react';
import {
  checkHealth,
  clearBackendCache,
  DEFAULT_LLM_SETTINGS,
  loadStudioSettings,
  saveStudioSettings,
} from '@/lib/api/client';
import { clearAllDrafts, getStorageUsageBytes } from '@/lib/storage/indexeddb';
import type { HealthResponse, LLMProvider, StudioLLMSettings } from '@/types/project';

export default function SettingsPage() {
  const [settings, setSettings] = useState<StudioLLMSettings>(DEFAULT_LLM_SETTINGS);
  const [showGemini, setShowGemini] = useState(false);
  const [showOpenai, setShowOpenai] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
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

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Cài đặt Dual LLM & Sức khỏe Hệ thống</h1>
        <p className="text-xs text-slate-400">
          Cấu hình Gemini API Key, OpenAI API Key, phân vai Agent và kiểm tra kết nối Spring Boot /
          Redis / FluidSynth.
        </p>
      </div>

      {/* Infrastructure Health Card */}
      <section className="rounded-2xl border border-slate-800 bg-[#121622] p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <Activity className="h-4 w-4 text-emerald-400" />
            <span>Trạng thái Hạ tầng Local (Docker + Node)</span>
          </h2>
          <button
            type="button"
            disabled={checkingHealth}
            onClick={() => void refreshHealth()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
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

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-800 bg-[#171c2b] p-3.5">
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

          <div className="rounded-xl border border-slate-800 bg-[#171c2b] p-3.5">
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

          <div className="rounded-xl border border-slate-800 bg-[#171c2b] p-3.5">
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
              {health?.engines?.fluidsynth_available
                ? health.engines.soundfont_available
                  ? 'FluidSynth + SoundFont Ready'
                  : 'FluidSynth (No SoundFont)'
                : health
                ? `Synth Fallback (${health.engines?.ffmpeg_available ? 'FFmpeg OK' : 'Pure DSP'})`
                : 'Unknown'}
            </p>
          </div>
        </div>
      </section>

      {/* Dual LLM API Key Form */}
      <form
        onSubmit={handleSave}
        className="space-y-5 rounded-2xl border border-slate-800 bg-[#121622] p-5"
      >
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <KeyRound className="h-4 w-4 text-indigo-400" />
          <span>Dual LLM API Keys & Phân vai Multi-Agent</span>
        </h2>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              Backend Spring Boot URL
            </label>
            <input
              type="url"
              value={settings.backendUrl}
              onChange={(e) => setSettings((s) => ({ ...s, backendUrl: e.target.value }))}
              placeholder="http://localhost:8000"
              className="w-full rounded-xl border border-slate-700 bg-[#0b0d14] px-3 py-2 text-sm text-white"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              Provider Mặc định (khi không truyền Key dùng Mock)
            </label>
            <select
              value={settings.defaultProvider}
              onChange={(e) =>
                setSettings((s) => ({ ...s, defaultProvider: e.target.value as LLMProvider }))
              }
              className="w-full rounded-xl border border-slate-700 bg-[#0b0d14] px-3 py-2 text-sm text-white"
            >
              <option value="gemini">Google Gemini API</option>
              <option value="openai">OpenAI API</option>
              <option value="mock">Mock Provider (Offline / Test)</option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              Gemini API Key (Google AI Studio)
            </label>
            <div className="relative">
              <input
                type={showGemini ? 'text' : 'password'}
                value={settings.geminiApiKey}
                onChange={(e) => setSettings((s) => ({ ...s, geminiApiKey: e.target.value }))}
                placeholder="AIza..."
                className="w-full rounded-xl border border-slate-700 bg-[#0b0d14] py-2 pl-3 pr-10 text-sm text-white"
              />
              <button
                type="button"
                onClick={() => setShowGemini((v) => !v)}
                className="absolute right-2.5 top-2 text-slate-400 hover:text-white"
              >
                {showGemini ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              OpenAI API Key (OpenAI Platform)
            </label>
            <div className="relative">
              <input
                type={showOpenai ? 'text' : 'password'}
                value={settings.openaiApiKey}
                onChange={(e) => setSettings((s) => ({ ...s, openaiApiKey: e.target.value }))}
                placeholder="sk-..."
                className="w-full rounded-xl border border-slate-700 bg-[#0b0d14] py-2 pl-3 pr-10 text-sm text-white"
              />
              <button
                type="button"
                onClick={() => setShowOpenai((v) => !v)}
                className="absolute right-2.5 top-2 text-slate-400 hover:text-white"
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
              <div key={key} className="rounded-xl border border-slate-800 bg-[#171c2b] p-2.5">
                <label className="block text-[11px] font-medium text-slate-300 mb-1">{label}</label>
                <select
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
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white"
                >
                  <option value="gemini">Gemini</option>
                  <option value="openai">OpenAI</option>
                  <option value="mock">Mock</option>
                </select>
              </div>
            ))}
          </div>
        </div>

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
              className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-rose-300 hover:bg-rose-500/20"
            >
              <Trash2 className="h-3 w-3" /> Dọn Cache
            </button>
            {cacheNotice && <span className="text-emerald-400">{cacheNotice}</span>}
          </div>

          <div className="flex items-center gap-3">
            {savedToast && (
              <span className="text-xs font-medium text-emerald-400">Đã lưu cài đặt!</span>
            )}
            <button
              type="submit"
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
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
