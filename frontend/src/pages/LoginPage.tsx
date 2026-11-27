import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Cloud,
  Database,
  Disc3,
  HardDrive,
  LogOut,
  ShieldCheck,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import { ApiError } from '@/lib/api/client';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { authenticated, user, quota, cloud, login, register, oauthLogin, logout } = useAuth();

  const searchParams = new URLSearchParams(location.search);
  const redirectParam = searchParams.get('redirect');
  const redirectTarget =
    redirectParam && redirectParam.startsWith('/') && !redirectParam.startsWith('//')
      ? redirectParam
      : '/';

  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (tab === 'login') {
        await login(email, password);
      } else {
        await register(email, password, displayName);
      }
      setPassword('');
      navigate(redirectTarget, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Không thể xác thực tài khoản Cloud.');
    } finally {
      setBusy(false);
    }
  };

  const handleOAuth = async (provider: 'google' | 'github') => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await oauthLogin(provider);
      navigate(redirectTarget, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Lỗi đăng nhập OAuth Sandbox.');
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    setError(null);
    await logout();
    setNotice('Đã đăng xuất và thu hồi JWT trên máy chủ. Bạn đang ở chế độ Guest.');
    setBusy(false);
  };

  const storageMb = quota ? (quota.storage_used_bytes / (1024 * 1024)).toFixed(2) : '0.00';
  const storageLimitMb = quota ? Math.round(quota.storage_limit_bytes / (1024 * 1024)) : 100;

  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-md flex-col justify-center py-4">
      <div className="rounded-2xl border border-white/15 bg-[#16191f] p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 text-slate-950">
              <Disc3 className="h-5 w-5" />
            </div>
            <div>
              <h1 className="font-display text-base font-bold text-white">
                {authenticated ? 'Tài khoản Cloud Studio' : 'Đăng nhập AI Music Studio'}
              </h1>
              <p className="text-[11px] text-slate-400">
                Hybrid Cloud JWT • Đồng bộ Workspace &amp; Xuất bản Demo
              </p>
            </div>
          </div>
          <Link
            to={redirectTarget}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/10"
          >
            <ArrowLeft className="h-3 w-3" /> Quay lại
          </Link>
        </div>

        {notice && (
          <div className="mt-4 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-200">
            {notice}
          </div>
        )}

        {authenticated ? (
          <div className="mt-4 space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-xs">
              <UserCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
              <div className="min-w-0 flex-1">
                <div className="font-bold text-white">{user.display_name}</div>
                <div className="truncate text-[11px] text-emerald-200/90">{user.email}</div>
                <div className="mt-1 inline-block rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">
                  {user.role} • Đã xác thực JWT
                </div>
              </div>
            </div>

            {quota && (
              <div className="grid grid-cols-3 gap-2 rounded-xl border border-white/10 bg-[#101318] p-3 text-[11px] text-slate-400">
                <div>
                  <div>AI Jobs/ngày</div>
                  <div className="mt-0.5 font-mono font-bold text-emerald-300">
                    {quota.generate_used} / {quota.generate_limit}
                  </div>
                </div>
                <div>
                  <div>Export/Publish</div>
                  <div className="mt-0.5 font-mono font-bold text-sky-300">
                    {quota.export_used} / {quota.export_limit}
                  </div>
                </div>
                <div>
                  <div>Cloud S3</div>
                  <div className="mt-0.5 font-mono font-bold text-amber-300">
                    {storageMb}/{storageLimitMb}MB
                  </div>
                </div>
              </div>
            )}

            {cloud && (
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                <span className="inline-flex items-center gap-1">
                  <Database className="h-3.5 w-3.5 text-sky-400" />
                  DB: {cloud.postgres_connected ? 'PostgreSQL' : cloud.database_backend || 'H2 Fallback'}
                </span>
                <span className="inline-flex items-center gap-1">
                  <HardDrive className="h-3.5 w-3.5 text-emerald-400" />
                  S3: {cloud.object_storage_connected ? 'MinIO Cloud' : cloud.object_storage_backend || 'Local S3'}
                </span>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleLogout()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-4 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/25 disabled:opacity-50"
              >
                <LogOut className="h-3.5 w-3.5" /> Đăng xuất (Logout)
              </button>
              <Link
                to="/library"
                className="rounded-lg bg-amber-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-amber-400"
              >
                Vào Kho Session
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-2 gap-1.5 rounded-xl bg-[#0d1015] p-1 text-xs">
              <button
                type="button"
                onClick={() => {
                  setTab('login');
                  setError(null);
                }}
                className={`rounded-lg py-1.5 font-semibold transition ${
                  tab === 'login' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'
                }`}
              >
                Đăng nhập
              </button>
              <button
                type="button"
                onClick={() => {
                  setTab('register');
                  setError(null);
                }}
                className={`rounded-lg py-1.5 font-semibold transition ${
                  tab === 'register' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'
                }`}
              >
                Đăng ký mới
              </button>
            </div>

            <form onSubmit={handleSubmit} className="mt-4 space-y-3.5">
              {tab === 'register' && (
                <div>
                  <label htmlFor="login-page-display-name" className="mb-1 block text-xs font-medium text-slate-300">
                    Tên nghệ danh / Producer
                  </label>
                  <input
                    id="login-page-display-name"
                    name="displayName"
                    type="text"
                    required
                    autoComplete="name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="VD: Quang Producer"
                    className="w-full rounded-lg border border-white/15 bg-[#0b0d11] px-3 py-2 text-xs text-white focus:border-amber-400 focus:outline-none"
                  />
                </div>
              )}

              <div>
                <label htmlFor="login-page-email" className="mb-1 block text-xs font-medium text-slate-300">
                  Email
                </label>
                <input
                  id="login-page-email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="creator@aimusic.dev"
                  className="w-full rounded-lg border border-white/15 bg-[#0b0d11] px-3 py-2 text-xs text-white focus:border-amber-400 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="login-page-password" className="mb-1 block text-xs font-medium text-slate-300">
                  Mật khẩu (&gt;= 6 ký tự)
                </label>
                <input
                  id="login-page-password"
                  name="password"
                  type="password"
                  required
                  minLength={6}
                  autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••"
                  className="w-full rounded-lg border border-white/15 bg-[#0b0d11] px-3 py-2 text-xs text-white focus:border-amber-400 focus:outline-none"
                />
              </div>

              {error && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-2 text-xs text-rose-200">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 py-2.5 text-xs font-bold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
              >
                <ShieldCheck className="h-4 w-4" />
                <span>{busy ? 'Đang xác thực...' : tab === 'login' ? 'Đăng nhập vào Studio' : 'Tạo tài khoản & Đăng nhập'}</span>
              </button>
            </form>

            <div className="mt-4 border-t border-white/10 pt-3.5">
              <p className="mb-2 text-[10px] text-slate-400">
                Hoặc dùng Local OAuth Sandbox để đăng nhập thử nhanh:
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleOAuth('google')}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-[#1d2129] py-2 text-xs font-medium text-slate-200 hover:bg-white/10"
                >
                  <Sparkles className="h-3.5 w-3.5 text-amber-400" /> Google Sandbox
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleOAuth('github')}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-[#1d2129] py-2 text-xs font-medium text-slate-200 hover:bg-white/10"
                >
                  <Cloud className="h-3.5 w-3.5 text-sky-400" /> GitHub Sandbox
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
