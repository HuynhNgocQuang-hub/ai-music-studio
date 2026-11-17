import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Disc3,
  FolderOpen,
  Loader2,
  Mic2,
  RotateCcw,
  Save,
  Settings,
  Sliders,
  Sparkles,
  X,
} from 'lucide-react';
import { useProjectSession } from '@/components/providers/ProjectProvider';

function formatRelativeSeconds(iso: string | null): string {
  if (!iso) return 'Chưa lưu';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 5) return 'vừa xong';
  if (diffSec < 60) return `${diffSec}s trước`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins} phút trước`;
  return `${Math.floor(mins / 60)} giờ trước`;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const {
    project,
    saveNow,
    autoSaveStatus,
    lastSavedAt,
    restorableDraft,
    dismissRestorePrompt,
    acceptRestoreDraft,
  } = useProjectSession();

  const [collapsed, setCollapsed] = useState(false);
  const [, setTick] = useState(0);

  // Auto-collapse sidebar when entering /studio/* for maximum timeline space
  useEffect(() => {
    if (pathname.startsWith('/studio')) {
      setCollapsed(true);
    }
  }, [pathname]);

  // Update relative "Xs trước" label smoothly
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const navItems = [
    {
      label: 'Tạo nhạc mới',
      sublabel: 'Wizard 4 bước',
      href: '/create',
      active: pathname.startsWith('/create'),
      icon: Sparkles,
    },
    {
      label: 'Phòng thu (Studio)',
      sublabel: 'Hybrid DAW-lite',
      href: `/studio/${encodeURIComponent(project.project_id)}`,
      active: pathname.startsWith('/studio'),
      icon: Sliders,
    },
    {
      label: 'Thư viện & Bản nháp',
      sublabel: 'IndexedDB & Redis',
      href: '/library',
      active: pathname.startsWith('/library'),
      icon: FolderOpen,
    },
    {
      label: 'Cài đặt & API',
      sublabel: 'Gemini / OpenAI / Health',
      href: '/settings',
      active: pathname.startsWith('/settings'),
      icon: Settings,
    },
  ];

  const handleRestoreDraft = () => {
    if (!restorableDraft) return;
    const id = restorableDraft.project_id;
    acceptRestoreDraft(restorableDraft);
    navigate(`/studio/${encodeURIComponent(id)}`);
  };

  return (
    <div className="flex min-h-screen bg-[#0b0d14] text-slate-100">
      {/* Collapsible Left Sidebar */}
      <aside
        className={`sticky top-0 flex h-screen flex-col border-r border-slate-800/80 bg-[#0f131f] transition-all duration-200 ${
          collapsed ? 'w-[68px]' : 'w-64'
        }`}
      >
        <div className="flex h-14 items-center justify-between border-b border-slate-800/80 px-3">
          <Link to="/" className="flex items-center gap-2.5 overflow-hidden">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-emerald-500 text-white shadow-md shadow-indigo-500/20">
              <Disc3 className="h-5 w-5" />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <p className="truncate text-sm font-bold tracking-tight text-white">AI Music Studio</p>
                <p className="truncate text-[11px] text-slate-400">Hybrid Multi-Agent</p>
              </div>
            )}
          </Link>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Mở rộng menu' : 'Thu gọn menu'}
            title={collapsed ? 'Mở rộng menu' : 'Thu gọn menu'}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>

        <nav className="flex-1 space-y-1.5 p-2.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                to={item.href}
                title={collapsed ? item.label : undefined}
                className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                  item.active
                    ? 'bg-indigo-600/20 text-indigo-300 ring-1 ring-indigo-500/40'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
                }`}
              >
                <Icon
                  className={`h-5 w-5 shrink-0 ${
                    item.active ? 'text-indigo-400' : 'text-slate-400 group-hover:text-slate-200'
                  }`}
                />
                {!collapsed && (
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.label}</p>
                    <p className="truncate text-[11px] text-slate-500">{item.sublabel}</p>
                  </div>
                )}
              </Link>
            );
          })}
        </nav>

        {!collapsed && (
          <div className="border-t border-slate-800/80 p-3 text-xs text-slate-400">
            <div className="rounded-xl border border-slate-800 bg-[#141928] p-2.5">
              <div className="flex items-center gap-1.5 font-medium text-slate-300">
                <Mic2 className="h-3.5 w-3.5 text-emerald-400" />
                <span className="truncate">{project.title || 'Untitled Session'}</span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {project.analysis.bpm} BPM • {project.analysis.detected_key}{' '}
                {project.analysis.detected_scale}
              </p>
            </div>
          </div>
        )}
      </aside>

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar with Auto-Save Status Badge */}
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-slate-800/80 bg-[#0b0d14]/90 px-4 backdrop-blur-md">
          <div className="flex items-center gap-3 min-w-0">
            <span className="hidden rounded-md border border-slate-800 bg-slate-900/90 px-2 py-0.5 text-xs font-mono text-slate-400 sm:inline-block">
              {project.project_id}
            </span>
            <span className="truncate text-sm font-semibold text-slate-200">
              {project.title || 'Untitled Session'}
            </span>
            <span className="hidden rounded-full bg-slate-800 px-2.5 py-0.5 text-xs text-slate-300 md:inline-block">
              {project.config.genre} • {project.analysis.bpm} BPM • {project.analysis.detected_key}{' '}
              {project.analysis.detected_scale}
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            {/* Auto-Save Status Badge */}
            <div
              data-testid="autosave-badge"
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                autoSaveStatus === 'saving'
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                  : autoSaveStatus === 'error'
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              }`}
            >
              {autoSaveStatus === 'saving' ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Đang lưu nháp...</span>
                </>
              ) : autoSaveStatus === 'saved' ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>Đã lưu nháp {formatRelativeSeconds(lastSavedAt)}</span>
                </>
              ) : autoSaveStatus === 'error' ? (
                <>
                  <Clock className="h-3.5 w-3.5" />
                  <span>Lỗi Auto-Save</span>
                </>
              ) : (
                <>
                  <Clock className="h-3.5 w-3.5 text-slate-400" />
                  <span className="text-slate-300">Auto-Save bật (7s)</span>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => void saveNow(true)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-indigo-500/50 hover:bg-slate-800"
            >
              <Save className="h-3.5 w-3.5 text-indigo-400" />
              <span className="hidden sm:inline">Đồng bộ Redis</span>
            </button>
          </div>
        </header>

        {/* Restore Draft Prompt Banner (IndexedDB recovery on reopen) */}
        {restorableDraft && (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-amber-200">
                <RotateCcw className="h-4 w-4 shrink-0 text-amber-400" />
                <span>
                  Phát hiện bản nháp chưa lưu:{' '}
                  <strong className="text-white">
                    {restorableDraft.state.title || restorableDraft.project_id}
                  </strong>{' '}
                  (cập nhật {formatRelativeSeconds(restorableDraft.updated_at)}).
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRestoreDraft}
                  className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-amber-400"
                >
                  Khôi phục phiên gần nhất
                </button>
                <button
                  type="button"
                  onClick={dismissRestorePrompt}
                  aria-label="Đóng thông báo khôi phục"
                  className="rounded-lg p-1 text-amber-300 hover:bg-amber-500/20"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
