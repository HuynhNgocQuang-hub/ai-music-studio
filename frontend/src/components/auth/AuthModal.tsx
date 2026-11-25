import React, { useState } from 'react';
import { Cloud, Database, HardDrive, LogOut, ShieldCheck, Sparkles, UserCheck, X } from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import { ApiError } from '@/lib/api/client';

export default function AuthModal() {
  const {
    authenticated,
    user,
    quota,
    cloud,
    authModalOpen,
    setAuthModalOpen,
    login,
    register,
    oauthLogin,
    logout,
  } = useAuth();

  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!authModalOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (tab === 'login') {
        await login(email, password);
      } else {
        await register(email, password, displayName);
      }
      setPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Không thể xác thực tài khoản Cloud.');
    } finally {
      setBusy(false);
    }
  };

  const handleOAuth = async (provider: 'google' | 'github') => {
    setError(null);
    setBusy(true);
    try {
      await oauthLogin(provider);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Lỗi đăng nhập OAuth Sandbox.');
    } finally {
      setBusy(false);
    }
  };

  const storageMb = quota ? (quota.storage_used_bytes / (1024 * 1024)).toFixed(2) : '0.00';
  const storageLimitMb = quota ? Math.round(quota.storage_limit_bytes / (1024 * 1024)) : 100;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Tài khoản Cloud & Quota"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
    >
      <div className="w-full max-w-md rounded-2xl border border-white/15 bg-[#16191f] p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <div className="flex items-center gap-2">
            <Cloud className="h-4.5 w-4.5 text-amber-400" />
            <h2 className="font-display text-sm font-bold text-white">
              {authenticated ? 'Cloud Workspace & Quota' : 'Đăng nhập / Đồng bộ Cloud SaaS'}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setAuthModalOpen(false)}
            aria-label="Đóng"
            className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Quota & Infra Summary */}
        {quota && (
          <div className="mt-3 space-y-2 rounded-xl border border-white/10 bg-[#101318] p-3 text-xs">
            <div className="flex items-center justify-between text-slate-300">
              <span className="font-semibold text-white">
                {authenticated ? `${user.display_name} (${user.email})` : 'Chế độ Guest (Local)'}
              </span>
              <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-300">
                {quota.tier}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-1 text-[11px] text-slate-400">
              <div className="rounded bg-[#181c23] p-2">
                <div>AI Jobs/ngày</div>
                <div className="mt-0.5 font-mono font-bold text-emerald-300">
                  {quota.generate_used} / {quota.generate_limit}
                </div>
              </div>
              <div className="rounded bg-[#181c23] p-2">
                <div>Export/Publish</div>
                <div className="mt-0.5 font-mono font-bold text-sky-300">
                  {quota.export_used} / {quota.export_limit}
                </div>
              </div>
              <div className="rounded bg-[#181c23] p-2">
                <div>Cloud S3</div>
                <div className="mt-0.5 font-mono font-bold text-amber-300">
                  {storageMb}/{storageLimitMb}MB
                </div>
              </div>
            </div>
            {cloud && (
              <div className="flex flex-wrap items-center gap-3 pt-1 text-[10px] text-slate-400">
                <span className="inline-flex items-center gap-1">
                  <Database className="h-3 w-3 text-sky-400" />
                  DB: {cloud.postgres_connected ? 'PostgreSQL' : cloud.database_backend || 'H2 Fallback'}
                </span>
                <span className="inline-flex items-center gap-1">
                  <HardDrive className="h-3 w-3 text-emerald-400" />
                  S3: {cloud.object_storage_connected ? 'MinIO Cloud' : cloud.object_storage_backend || 'Local S3'}
                </span>
              </div>
            )}
          </div>
        )}

        {authenticated ? (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
              <UserCheck className="h-4.5 w-4.5 shrink-0 text-emerald-400" />
              <span>
                Tài khoản đã xác thực JWT. Mọi dự án sync &amp; xuất bản công khai đều gắn quyền sở hữu của{' '}
                <strong className="text-white">{user.display_name}</strong>.
              </span>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={logout}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-3.5 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/25"
              >
                <LogOut className="h-3.5 w-3.5" /> Đăng xuất về Guest
              </button>
              <button
                type="button"
                onClick={() => setAuthModalOpen(false)}
                className="rounded-lg bg-amber-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-amber-400"
              >
                Tiếp tục làm nhạc
              </button>
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
                Tạo tài khoản Cloud
              </button>
            </div>

            <form onSubmit={handleSubmit} className="mt-3 space-y-3">
              {tab === 'register' && (
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-300">Tên nghệ danh / Producer</label>
                  <input
                    type="text"
                    required
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="VD: Quang Producer"
                    className="w-full rounded-lg border border-white/15 bg-[#0b0d11] px-3 py-2 text-xs text-white focus:border-amber-400 focus:outline-none"
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-300">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="creator@aimusic.dev"
                  className="w-full rounded-lg border border-white/15 bg-[#0b0d11] px-3 py-2 text-xs text-white focus:border-amber-400 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-300">Mật khẩu (&gt;= 6 ký tự)</label>
                <input
                  type="password"
                  required
                  minLength={6}
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
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 py-2 text-xs font-bold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
              >
                <ShieldCheck className="h-4 w-4" />
                <span>{busy ? 'Đang xử lý...' : tab === 'login' ? 'Đăng nhập Cloud JWT' : 'Đăng ký & Nhận Token'}</span>
              </button>
            </form>

            <div className="mt-3 border-t border-white/10 pt-3">
              <p className="mb-2 text-[10px] text-slate-400">
                Đăng nhập nhanh Local OAuth Sandbox (không cần cấu hình Google/GitHub Secret):
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleOAuth('google')}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-[#1d2129] py-1.5 text-xs font-medium text-slate-200 hover:bg-white/10"
                >
                  <Sparkles className="h-3.5 w-3.5 text-amber-400" /> Google Sandbox
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleOAuth('github')}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-[#1d2129] py-1.5 text-xs font-medium text-slate-200 hover:bg-white/10"
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
