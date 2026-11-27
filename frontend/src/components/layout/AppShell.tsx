import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Bot,
  Cloud,
  Disc3,
  FolderKanban,
  FolderOpen,
  LogIn,
  LogOut,
  Plus,
  Radio,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  Sparkles,
  UserCheck,
  X,
} from 'lucide-react';
import AuthModal from '@/components/auth/AuthModal';
import { useAuth } from '@/components/providers/AuthProvider';
import AiCoachChatDrawer from '@/components/studio/AiCoachChatDrawer';
import { useProjectSession } from '@/components/providers/ProjectProvider';
import { DAW_TEMPLATES, buildProjectFromTemplate } from '@/lib/music/presets';

export function AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { authenticated, user, quota, setAuthModalOpen, logout } = useAuth();
  const {
    project,
    loadProjectIntoSession,
    restorableDraft,
    dismissRestorePrompt,
    acceptRestoreDraft,
    copilotOpen,
    setCopilotOpen,
  } = useProjectSession();

  const isStudioRoute = pathname.startsWith('/studio');

  const navItems = [
    {
      label: 'Phòng thu DAW',
      href: `/studio/${encodeURIComponent(project.project_id)}`,
      active: isStudioRoute,
      icon: SlidersHorizontal,
    },
    {
      label: 'Dự án & Mẫu (Templates)',
      href: '/',
      active: pathname === '/',
      icon: FolderKanban,
    },
    {
      label: 'AI Hum-to-Music Wizard',
      href: '/create',
      active: pathname.startsWith('/create'),
      icon: Sparkles,
    },
    {
      label: 'Kho Session (.aimusic)',
      href: '/library',
      active: pathname.startsWith('/library'),
      icon: FolderOpen,
    },
    {
      label: 'Cộng đồng Demo Showcase',
      href: '/share',
      active: pathname.startsWith('/share'),
      icon: Radio,
    },
    {
      label: 'Audio Engine & API',
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

  const handleCreateBlankProject = () => {
    const blankTpl = DAW_TEMPLATES[DAW_TEMPLATES.length - 1];
    const next = buildProjectFromTemplate(blankTpl);
    loadProjectIntoSession(next, { dirty: true });
    navigate(`/studio/${encodeURIComponent(next.project_id)}`);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#111317] text-[#e6e9ef]">
      {/* Slim Pro DAW Hardware Activity Rail */}
      <aside className="flex w-13 shrink-0 flex-col items-center justify-between border-r border-white/10 bg-[#16191f] py-2.5">
        <div className="flex w-full flex-col items-center gap-2">
          <Link
            to="/"
            title="AI Music DAW Workstation"
            className="flex h-9 w-9 items-center justify-center rounded-md bg-gradient-to-br from-amber-500 to-orange-600 text-slate-950 shadow-sm"
          >
            <Disc3 className="h-5 w-5" />
          </Link>

          <div className="my-1 h-px w-7 bg-white/10" />

          <nav aria-label="Điều hướng DAW" className="flex w-full flex-col items-center gap-1.5 px-1.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  title={item.label}
                  aria-label={item.label}
                  className={`flex h-9 w-9 items-center justify-center rounded-md border transition ${
                    item.active
                      ? 'border-amber-400/50 bg-amber-500/20 text-amber-300'
                      : 'border-transparent text-slate-400 hover:bg-white/[0.07] hover:text-slate-100'
                  }`}
                >
                  <Icon className="h-4.5 w-4.5" />
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={() => setAuthModalOpen(true)}
            title={
              authenticated
                ? `${user.display_name} (${quota ? `${quota.generate_used}/${quota.generate_limit} jobs` : 'Cloud'})`
                : 'Đăng nhập Cloud SaaS / Xem Quota'
            }
            aria-label="Tài khoản Cloud & Quota"
            className={`flex h-9 w-9 items-center justify-center rounded-md border transition ${
              authenticated
                ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-300'
                : 'border-white/10 bg-[#1d212a] text-slate-300 hover:border-amber-400/40 hover:text-amber-200'
            }`}
          >
            {authenticated ? <UserCheck className="h-4.5 w-4.5" /> : <Cloud className="h-4.5 w-4.5" />}
          </button>

          {authenticated ? (
            <button
              type="button"
              onClick={() => void logout()}
              title="Đăng xuất tài khoản Cloud"
              aria-label="Đăng xuất tài khoản Cloud"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-rose-500/30 bg-rose-500/10 text-rose-300 transition hover:border-rose-400/60 hover:bg-rose-500/20 hover:text-rose-200"
            >
              <LogOut className="h-4.5 w-4.5" />
            </button>
          ) : (
            <Link
              to={
                pathname.startsWith('/login') || pathname.startsWith('/register')
                  ? '/login'
                  : `/login?redirect=${encodeURIComponent(pathname)}`
              }
              title="Đăng nhập / Đăng ký Cloud"
              aria-label="Đăng nhập / Đăng ký Cloud"
              className={`flex h-9 w-9 items-center justify-center rounded-md border transition ${
                pathname.startsWith('/login') || pathname.startsWith('/register')
                  ? 'border-amber-400/60 bg-amber-500/20 text-amber-300'
                  : 'border-white/10 bg-[#1d212a] text-slate-300 hover:border-amber-400/40 hover:text-amber-200'
              }`}
            >
              <LogIn className="h-4.5 w-4.5" />
            </Link>
          )}

          <button
            type="button"
            onClick={() => setCopilotOpen((o) => !o)}
            title="Bật/Tắt AI Music Copilot"
            aria-label="Bật/Tắt AI Music Copilot"
            className={`flex h-9 w-9 items-center justify-center rounded-md border transition ${
              copilotOpen
                ? 'border-sky-400/60 bg-sky-500/20 text-sky-200'
                : 'border-white/10 bg-[#1d212a] text-slate-300 hover:border-sky-400/40 hover:text-sky-200'
            }`}
          >
            <Bot className="h-4.5 w-4.5" />
          </button>

          <button
            type="button"
            onClick={handleCreateBlankProject}
            title="Tạo Project DAW mới ngay"
            aria-label="Tạo Project DAW mới ngay"
            className="flex h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-[#232730] text-slate-200 transition hover:border-amber-400/60 hover:text-amber-300"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </aside>

      {/* Main DAW / Launcher Container */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#111317]">
        {/* Minimal Launcher Top Bar (Hidden inside /studio so DAW owns 100% of screen height) */}
        {!isStudioRoute && (
          <header className="flex h-11 shrink-0 items-center justify-between border-b border-white/10 bg-[#16191f] px-5">
            <div className="flex items-center gap-3">
              <span className="font-display text-xs font-bold uppercase tracking-wider text-slate-200">
                AI Music Workstation
              </span>
              <span className="text-slate-600">/</span>
              <span className="truncate text-xs text-slate-400">
                {pathname === '/'
                  ? 'Project Hub & Templates'
                  : pathname.startsWith('/create')
                  ? 'AI Hum-to-Music Generator'
                  : pathname.startsWith('/library')
                  ? 'Session Vault'
                  : pathname.startsWith('/share')
                  ? 'Demo Showcase & Master Releases'
                  : pathname.startsWith('/login') || pathname.startsWith('/register')
                  ? 'Cloud Account & Session'
                  : 'Audio Engine & API Settings'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAuthModalOpen(true)}
                className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-semibold transition ${
                  authenticated
                    ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                    : 'border-white/15 bg-[#232730] text-slate-200 hover:border-amber-400/50 hover:text-amber-200'
                }`}
              >
                {authenticated ? <UserCheck className="h-3.5 w-3.5" /> : <Cloud className="h-3.5 w-3.5" />}
                <span>
                  {authenticated
                    ? `${user.display_name}${quota ? ` (${quota.generate_used}/${quota.generate_limit})` : ''}`
                    : 'Cloud Quota'}
                </span>
              </button>
              {authenticated ? (
                <button
                  type="button"
                  onClick={() => void logout()}
                  data-testid="topbar-logout-btn"
                  className="inline-flex items-center gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/20"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Đăng xuất</span>
                </button>
              ) : (
                <Link
                  to={
                    pathname.startsWith('/login') || pathname.startsWith('/register')
                      ? '/login'
                      : `/login?redirect=${encodeURIComponent(pathname)}`
                  }
                  data-testid="topbar-login-link"
                  className="inline-flex items-center gap-1.5 rounded border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-200 transition hover:bg-amber-500/20"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  <span>Đăng nhập</span>
                </Link>
              )}
              <button
                type="button"
                onClick={() => setCopilotOpen((o) => !o)}
                className={`inline-flex items-center gap-1.5 rounded border px-3 py-1 text-xs font-semibold transition ${
                  copilotOpen
                    ? 'border-sky-400/60 bg-sky-500/20 text-sky-200'
                    : 'border-white/15 bg-[#232730] text-slate-200 hover:border-sky-400/50 hover:text-sky-200'
                }`}
              >
                <Bot className="h-3.5 w-3.5" />
                <span>AI Copilot</span>
              </button>
              <button
                type="button"
                onClick={handleCreateBlankProject}
                className="inline-flex items-center gap-1.5 rounded border border-white/15 bg-[#232730] px-3 py-1 text-xs font-semibold text-slate-100 transition hover:border-amber-400/50 hover:text-amber-300"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Blank DAW</span>
              </button>
              <Link
                to={`/studio/${encodeURIComponent(project.project_id)}`}
                className="inline-flex items-center gap-1.5 rounded bg-amber-500 px-3 py-1 text-xs font-bold text-slate-950 transition hover:bg-amber-400"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                <span>Mở Studio</span>
              </Link>
            </div>
          </header>
        )}

        {/* Crash Recovery Notice on Non-Studio Launcher */}
        {restorableDraft && !isStudioRoute && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-5 py-1.5 text-xs text-amber-200">
            <div className="flex items-center gap-2">
              <RotateCcw className="h-3.5 w-3.5 text-amber-400" />
              <span>
                Bản nháp chưa đồng bộ:{' '}
                <strong className="text-white">
                  {restorableDraft.state.title || restorableDraft.project_id}
                </strong>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRestoreDraft}
                className="rounded bg-amber-500 px-2.5 py-0.5 text-[11px] font-bold text-slate-950 hover:bg-amber-400"
              >
                Khôi phục vào DAW
              </button>
              <button
                type="button"
                onClick={dismissRestorePrompt}
                aria-label="Đóng thông báo"
                className="rounded p-0.5 text-amber-300 hover:bg-white/10"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <main
            className={`min-w-0 min-h-0 flex-1 ${
              isStudioRoute ? 'overflow-hidden p-1.5' : 'overflow-y-auto p-5 md:p-6'
            }`}
          >
            {children}
          </main>
          <AiCoachChatDrawer />
        </div>
      </div>
      <AuthModal />
    </div>
  );
}
