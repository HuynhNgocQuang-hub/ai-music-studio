import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  FolderOpen,
  Mic2,
  Music4,
  RotateCcw,
  Settings,
  Sliders,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { useProjectSession } from '@/components/providers/ProjectProvider';
import { listDrafts, type StoredDraft } from '@/lib/storage/indexeddb';

export default function HomePage() {
  const navigate = useNavigate();
  const { project, acceptRestoreDraft } = useProjectSession();
  const [recentDrafts, setRecentDrafts] = useState<StoredDraft[]>([]);

  useEffect(() => {
    void listDrafts().then(setRecentDrafts).catch(() => {});
  }, []);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl border border-slate-800 bg-gradient-to-br from-[#141a2e] via-[#101526] to-[#0d121d] p-6 md:p-10">
        <div className="max-w-2xl space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-300">
            <Sparkles className="h-3.5 w-3.5" />
            <span>Phase 1 MVP • Dual LLM Multi-Agent + DSP</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white md:text-4xl">
            Biến đoạn ngân nga thành bản phối hoàn chỉnh
          </h1>
          <p className="text-sm leading-relaxed text-slate-300 md:text-base">
            Thu âm hoặc tải giọng hát mộc, lọc ồn AI Denoise, chỉnh phô Auto-Tune, phối khí đa
            track bằng Multi-Agent (Gemini / OpenAI) và tinh chỉnh trong Hybrid Studio với
            Auto-Save chống mất bài.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Link
              to="/create"
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition hover:bg-indigo-500"
            >
              <Mic2 className="h-4 w-4" />
              <span>Bắt đầu tạo nhạc mới</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to={`/studio/${encodeURIComponent(project.project_id)}`}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/70 px-5 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <Sliders className="h-4 w-4 text-emerald-400" />
              <span>Mở Phòng thu Studio</span>
            </Link>
          </div>
        </div>
      </section>

      {/* Quick Navigation Cards */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Link
          to="/create"
          className="group rounded-2xl border border-slate-800 bg-[#121622] p-5 transition hover:border-indigo-500/50"
        >
          <Wand2 className="h-6 w-6 text-indigo-400" />
          <h2 className="mt-3 text-base font-semibold text-white">1. Wizard Tạo nhạc</h2>
          <p className="mt-1 text-xs text-slate-400">
            4 bước: Input & Dry Check → Analyze & Auto-Tune → Style & AI Generate → Quick Preview.
          </p>
        </Link>

        <Link
          to={`/studio/${encodeURIComponent(project.project_id)}`}
          className="group rounded-2xl border border-slate-800 bg-[#121622] p-5 transition hover:border-emerald-500/50"
        >
          <Music4 className="h-6 w-6 text-emerald-400" />
          <h2 className="mt-3 text-base font-semibold text-white">2. Hybrid Studio</h2>
          <p className="mt-1 text-xs text-slate-400">
            Transport Bar, Multi-Track Mixer (M/S/Lock/Vol/Pan), Auto-Tune Pro, Lyrics & AI Coach.
          </p>
        </Link>

        <Link
          to="/library"
          className="group rounded-2xl border border-slate-800 bg-[#121622] p-5 transition hover:border-amber-500/50"
        >
          <FolderOpen className="h-6 w-6 text-amber-400" />
          <h2 className="mt-3 text-base font-semibold text-white">3. Thư viện & Bản nháp</h2>
          <p className="mt-1 text-xs text-slate-400">
            Tìm kiếm, phân trang 12/24/48, khôi phục bản nháp IndexedDB & import file `.aimusic`.
          </p>
        </Link>

        <Link
          to="/settings"
          className="group rounded-2xl border border-slate-800 bg-[#121622] p-5 transition hover:border-sky-500/50"
        >
          <Settings className="h-6 w-6 text-sky-400" />
          <h2 className="mt-3 text-base font-semibold text-white">4. Cài đặt & Sức khỏe</h2>
          <p className="mt-1 text-xs text-slate-400">
            Cấu hình Gemini / OpenAI API Key, phân vai Agent và kiểm tra FastAPI / Redis / SoundFont.
          </p>
        </Link>
      </section>

      {/* Recent IndexedDB Drafts */}
      {recentDrafts.length > 0 && (
        <section className="rounded-2xl border border-slate-800 bg-[#121622] p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              <RotateCcw className="h-4 w-4 text-amber-400" />
              <span>Bản nháp gần đây (IndexedDB Rolling Cap: tối đa 5)</span>
            </h3>
            <Link to="/library" className="text-xs text-indigo-400 hover:underline">
              Xem tất cả →
            </Link>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {recentDrafts.slice(0, 3).map((d) => (
              <div
                key={d.project_id}
                className="flex items-center justify-between rounded-xl border border-slate-800 bg-[#171c2b] p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">
                    {d.state.title || d.project_id}
                  </p>
                  <p className="text-xs text-slate-400">
                    {d.state.config.genre} • {d.state.analysis.bpm} BPM •{' '}
                    {d.state.analysis.detected_key} {d.state.analysis.detected_scale}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    acceptRestoreDraft(d);
                    navigate(`/studio/${encodeURIComponent(d.project_id)}`);
                  }}
                  className="shrink-0 rounded-lg bg-indigo-600/20 px-2.5 py-1 text-xs font-medium text-indigo-300 hover:bg-indigo-600/30"
                >
                  Mở
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
