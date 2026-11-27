import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  Disc3,
  ExternalLink,
  Headphones,
  Heart,
  Loader2,
  MessageSquare,
  Save,
  UserPlus,
  Users,
} from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import { TrackArtwork } from '@/components/shared/TrackArtwork';
import {
  ApiError,
  getCreatorProfile,
  listCreators,
  toggleFollowCreator,
  updateMyCreatorProfile,
} from '@/lib/api/client';
import type { CreatorProfile } from '@/types/project';

export default function CreatorProfilePage() {
  const { creatorId } = useParams<{ creatorId?: string }>();
  const { authenticated, user, refreshAuth } = useAuth();

  const [creators, setCreators] = useState<CreatorProfile[]>([]);
  const [profile, setProfile] = useState<CreatorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);

  const [editName, setEditName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setProfileNotice(null);
    try {
      if (creatorId) {
        const res = await getCreatorProfile(creatorId);
        setProfile(res);
        setEditName(res.display_name || '');
        setEditBio(res.bio || '');
      } else {
        const res = await listCreators(24);
        setCreators(res.items || []);
        setProfile(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Không thể tải hồ sơ Producer.');
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [creatorId]);

  useEffect(() => {
    void loadData();
  }, [loadData, authenticated, user.user_id]);

  const handleToggleFollow = async (targetId: string) => {
    if (followBusy) return;
    setFollowBusy(true);
    setError(null);
    try {
      const res = await toggleFollowCreator(targetId);
      if (profile && profile.user_id === targetId) {
        setProfile((prev) =>
          prev
            ? {
                ...prev,
                followed_by_me: res.following,
                followers_count: res.followers_count,
              }
            : prev
        );
      }
      setCreators((prev) =>
        prev.map((c) =>
          c.user_id === targetId
            ? { ...c, followed_by_me: res.following, followers_count: res.followers_count }
            : c
        )
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Không thể cập nhật trạng thái theo dõi.');
    } finally {
      setFollowBusy(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile || savingProfile) return;
    setSavingProfile(true);
    setProfileNotice(null);
    setError(null);
    try {
      const updated = await updateMyCreatorProfile({
        display_name: editName.trim(),
        bio: editBio.trim(),
      });
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              display_name: updated.display_name,
              bio: updated.bio,
            }
          : prev
      );
      setProfileNotice('Đã lưu hồ sơ Producer.');
      void refreshAuth();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Không thể lưu hồ sơ Producer.');
    } finally {
      setSavingProfile(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[280px] items-center justify-center gap-2 text-xs text-slate-300">
        <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
        <span>Đang tải hồ sơ Producer...</span>
      </div>
    );
  }

  if (!creatorId) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold text-white">Bảng xếp hạng Producer</h1>
            <p className="text-xs text-slate-400">
              Khám phá các nhà sản xuất nổi bật và theo dõi để cập nhật bản phối mới trên Feed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {authenticated && (
              <Link
                to={`/creators/${encodeURIComponent(user.user_id)}`}
                className="rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/25"
              >
                Hồ sơ của tôi
              </Link>
            )}
            <Link
              to="/share"
              className="rounded-lg border border-white/15 bg-[#1b1f27] px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10"
            >
              Về Showcase
            </Link>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/15 px-4 py-3 text-xs text-rose-200">
            {error}
          </div>
        )}

        {creators.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-[#16191f] py-14 text-center">
            <Users className="h-10 w-10 text-slate-500" />
            <p className="mt-3 text-sm font-semibold text-white">Chưa có Producer phát hành bài công khai</p>
            <p className="mt-1 text-xs text-slate-400">
              Mở Studio và Publish bản demo đầu tiên để xuất hiện trên bảng Producer!
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {creators.map((c) => {
              const isSelf = authenticated && user.user_id === c.user_id;
              return (
                <article
                  key={c.user_id}
                  className="flex flex-col justify-between rounded-2xl border border-white/10 bg-[#16191f] p-4 transition hover:border-amber-400/40"
                >
                  <div className="space-y-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <Link to={`/creators/${encodeURIComponent(c.user_id)}`} className="min-w-0 flex-1">
                        <h2 className="truncate text-sm font-bold text-white hover:text-amber-300">
                          {c.display_name}
                        </h2>
                        <p className="text-[11px] uppercase tracking-wider text-slate-400">{c.role}</p>
                      </Link>
                      {!isSelf && (
                        <button
                          type="button"
                          disabled={followBusy}
                          onClick={() => void handleToggleFollow(c.user_id)}
                          data-testid={`directory-follow-${c.user_id}`}
                          className={`inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition ${
                            c.followed_by_me
                              ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-200'
                              : 'border-white/15 bg-[#20242e] text-slate-200 hover:border-amber-400/50'
                          }`}
                        >
                          {c.followed_by_me ? <Check className="h-3 w-3" /> : <UserPlus className="h-3 w-3" />}
                          <span>{c.followed_by_me ? 'Đang theo dõi' : 'Theo dõi'}</span>
                        </button>
                      )}
                    </div>
                    <p className="line-clamp-2 min-h-[32px] text-xs text-slate-300">
                      {c.bio || 'Producer & Beatmaker trên AI Music Studio.'}
                    </p>
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2.5 text-[11px] text-slate-300 tabular-nums">
                    <span>{c.followers_count} followers • {c.releases_count} bài</span>
                    <Link
                      to={`/creators/${encodeURIComponent(c.user_id)}`}
                      className="font-semibold text-amber-300 hover:text-amber-200"
                    >
                      Xem kênh →
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-rose-500/40 bg-rose-500/10 p-6 text-center">
        <Users className="mx-auto h-8 w-8 text-rose-400" />
        <h1 className="mt-2 text-base font-bold text-white">Không tìm thấy Producer</h1>
        <p className="mt-1 text-xs text-rose-200">{error || 'Hồ sơ Producer không tồn tại.'}</p>
        <Link
          to="/share"
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/20"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Về Showcase
        </Link>
      </div>
    );
  }

  const isSelf = authenticated && user.user_id === profile.user_id;
  const releases = profile.releases || [];

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex items-center gap-2 text-xs text-slate-300">
        <Link to="/share" className="inline-flex items-center gap-1 hover:text-amber-300">
          <ArrowLeft className="h-3.5 w-3.5" /> Demo Showcase
        </Link>
        <span className="text-slate-600">/</span>
        <Link to="/creators" className="hover:text-amber-300">Producers</Link>
        <span className="text-slate-600">/</span>
        <span className="font-semibold text-white">{profile.display_name}</span>
      </div>

      {/* Producer Header Banner */}
      <section className="rounded-2xl border border-white/15 bg-gradient-to-br from-[#191d26] to-[#12151b] p-6 shadow-xl">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-4">
            <div
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500 to-rose-600 font-display text-2xl font-extrabold text-slate-950 shadow-lg"
              aria-hidden="true"
            >
              {(profile.display_name || 'P').slice(0, 1).toUpperCase()}
            </div>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display text-2xl font-extrabold text-white">{profile.display_name}</h1>
                <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[10px] font-bold uppercase text-amber-300">
                  {profile.role}
                </span>
              </div>
              <p className="text-xs text-slate-300">
                {profile.bio || 'Chưa cập nhật tiểu sử Producer.'}
              </p>
            </div>
          </div>

          {!isSelf && (
            <button
              type="button"
              disabled={followBusy}
              onClick={() => void handleToggleFollow(profile.user_id)}
              data-testid="creator-follow-btn"
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-4 py-2 text-xs font-bold transition ${
                profile.followed_by_me
                  ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
                  : 'border-amber-400/60 bg-amber-500 text-slate-950 hover:bg-amber-400'
              }`}
            >
              {profile.followed_by_me ? <Check className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
              <span>{profile.followed_by_me ? 'Đang theo dõi' : 'Theo dõi Producer'}</span>
            </button>
          )}
        </div>

        {/* Metrics Bar */}
        <div className="mt-5 grid grid-cols-2 gap-3 border-t border-white/10 pt-4 sm:grid-cols-5">
          <div className="rounded-xl bg-[#0e1116] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">Followers</p>
            <p className="font-mono text-base font-bold text-white" data-testid="creator-followers-count">
              {profile.followers_count}
            </p>
          </div>
          <div className="rounded-xl bg-[#0e1116] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">Following</p>
            <p className="font-mono text-base font-bold text-white">{profile.following_count}</p>
          </div>
          <div className="rounded-xl bg-[#0e1116] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">Bản phát hành</p>
            <p className="font-mono text-base font-bold text-amber-300">{profile.releases_count}</p>
          </div>
          <div className="rounded-xl bg-[#0e1116] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">Tổng lượt phát</p>
            <p className="font-mono text-base font-bold text-emerald-300">{profile.total_plays}</p>
          </div>
          <div className="rounded-xl bg-[#0e1116] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">Tổng lượt thích</p>
            <p className="font-mono text-base font-bold text-rose-300">{profile.total_likes}</p>
          </div>
        </div>
      </section>

      {/* Self-Edit Profile Panel */}
      {isSelf && (
        <section className="rounded-2xl border border-white/10 bg-[#16191f] p-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
            Cập nhật Hồ sơ Producer của bạn
          </h2>
          <form onSubmit={(e) => void handleSaveProfile(e)} className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="creator-display-name-input" className="mb-1 block text-[11px] font-medium text-slate-300">
                Nghệ danh / Tên hiển thị
              </label>
              <input
                id="creator-display-name-input"
                name="creatorDisplayName"
                type="text"
                maxLength={100}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full rounded-lg border border-white/15 bg-[#0b0d11] px-3 py-2 text-xs text-white focus:border-amber-400 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="creator-bio-input" className="mb-1 block text-[11px] font-medium text-slate-300">
                Tiểu sử ngắn (Bio)
              </label>
              <input
                id="creator-bio-input"
                name="creatorBio"
                type="text"
                maxLength={400}
                value={editBio}
                onChange={(e) => setEditBio(e.target.value)}
                placeholder="VD: Lo-fi & Synthpop Producer tại TP.HCM"
                className="w-full rounded-lg border border-white/15 bg-[#0b0d11] px-3 py-2 text-xs text-white placeholder-slate-400 focus:border-amber-400 focus:outline-none"
              />
            </div>
            <div className="flex items-center justify-between sm:col-span-2">
              <span className="text-xs text-emerald-300">{profileNotice || ''}</span>
              <button
                type="submit"
                disabled={savingProfile || !editName.trim()}
                data-testid="creator-save-profile-btn"
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                <span>{savingProfile ? 'Đang lưu...' : 'Lưu Hồ sơ'}</span>
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Releases Grid */}
      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
          Danh sách Bản phát hành ({releases.length})
        </h2>
        {releases.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-[#16191f] py-12 text-center">
            <Disc3 className="h-9 w-9 text-slate-500" />
            <p className="mt-2 text-xs text-slate-400">Producer này chưa có bản Master công khai nào.</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {releases.map((item) => (
              <Link
                key={item.share_slug}
                to={`/share/${encodeURIComponent(item.share_slug)}`}
                className="group flex flex-col justify-between rounded-2xl border border-white/10 bg-[#16191f] p-4 transition hover:border-amber-400/50"
              >
                <div className="flex items-start gap-3">
                  <TrackArtwork title={item.title} genre={item.genre} seed={item.share_slug} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-bold uppercase text-amber-300">
                        {item.master_format} • {item.lufs_target} LUFS
                      </span>
                      <span className="inline-flex items-center gap-1 text-slate-400">
                        <Headphones className="h-3 w-3" /> {item.plays_count}
                      </span>
                    </div>
                    <h3 className="mt-1 truncate text-sm font-bold text-white group-hover:text-amber-300">
                      {item.title}
                    </h3>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400 tabular-nums">
                      <span>{item.genre} • {Math.round(item.bpm)} BPM</span>
                      <span className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-0.5 text-rose-300">
                          <Heart className="h-3 w-3" /> {item.likes_count ?? 0}
                        </span>
                        <span className="inline-flex items-center gap-0.5 text-sky-300">
                          <MessageSquare className="h-3 w-3" /> {item.comments_count ?? 0}
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2 text-xs text-sky-300">
                  <span>Nghe Master</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
