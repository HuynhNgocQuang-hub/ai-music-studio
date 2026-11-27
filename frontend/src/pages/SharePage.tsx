import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Disc3,
  Download,
  ExternalLink,
  Headphones,
  Heart,
  Loader2,
  MessageSquare,
  Music,
  Pause,
  Play,
  Search,
  Send,
  Share2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import { TrackArtwork } from '@/components/shared/TrackArtwork';
import { useProjectSession } from '@/components/providers/ProjectProvider';
import {
  ApiError,
  deleteShareComment,
  getProject,
  getPublicShare,
  getPublicShareAudioUrl,
  listPublicReleases,
  postShareComment,
  toggleShareLike,
  unpublishProject,
} from '@/lib/api/client';
import type { PublishedRelease, ReleaseComment } from '@/types/project';

const SHARE_GENRES = ['', 'Pop', 'Ballad', 'Lo-fi', 'R&B', 'Hip-hop', 'EDM', 'Acoustic', 'Rock'];

function formatMmSs(sec: number): string {
  const safe = Math.max(0, Math.floor(sec));
  const mins = Math.floor(safe / 60);
  const rem = safe % 60;
  return `${mins}:${rem.toString().padStart(2, '0')}`;
}

export default function SharePage() {
  const { slug } = useParams<{ slug?: string }>();
  const navigate = useNavigate();
  const { authenticated, user } = useAuth();
  const { loadProjectIntoSession } = useProjectSession();

  const [release, setRelease] = useState<PublishedRelease | null>(null);
  const [comments, setComments] = useState<ReleaseComment[]>([]);
  const [gallery, setGallery] = useState<PublishedRelease[]>([]);
  const [search, setSearch] = useState('');
  const [genre, setGenre] = useState('');
  const [page, setPage] = useState(1);
  const [totalReleases, setTotalReleases] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [commentText, setCommentText] = useState('');
  const [pinnedTimestampSec, setPinnedTimestampSec] = useState<number | null>(null);
  const [likeBusy, setLikeBusy] = useState(false);
  const [commentBusy, setCommentBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [remixing, setRemixing] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const loadGallery = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listPublicReleases({ page, limit: 12, search, genre });
      setGallery(res.items || []);
      setTotalReleases(res.total || 0);
      setTotalPages(Math.max(1, res.total_pages || 1));
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Không thể tải danh sách bản phát hành.');
    } finally {
      setLoading(false);
    }
  }, [page, search, genre]);

  useEffect(() => {
    let active = true;
    setIsPlaying(false);
    setCurrentTimeSec(0);
    setDurationSec(0);
    setPinnedTimestampSec(null);

    if (slug) {
      setLoading(true);
      setError(null);
      getPublicShare(slug)
        .then((res) => {
          if (active) {
            setRelease(res);
            setComments(res.comments || []);
          }
        })
        .catch((err) => {
          if (active) {
            setRelease(null);
            setComments([]);
            setError(err instanceof ApiError ? err.detail : 'Không tìm thấy bản nhạc được chia sẻ.');
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    } else {
      setRelease(null);
      setComments([]);
      void loadGallery();
    }

    return () => {
      active = false;
    };
  }, [slug, loadGallery, authenticated, user.user_id]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  };

  const seekAndPlayAt = (ts: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, ts);
    setCurrentTimeSec(audio.currentTime);
    void audio.play().then(() => setIsPlaying(true)).catch(() => {});
  };

  const handleToggleLike = async () => {
    if (!release || likeBusy) return;
    setLikeBusy(true);
    try {
      const res = await toggleShareLike(release.share_slug);
      setRelease((prev) =>
        prev ? { ...prev, liked_by_me: res.liked, likes_count: res.likes_count } : prev
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Không thể cập nhật lượt thích.');
    } finally {
      setLikeBusy(false);
    }
  };

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!release || !commentText.trim() || commentBusy) return;
    const stamp = pinnedTimestampSec ?? currentTimeSec;
    const estimatedBar =
      release.bpm > 0 ? Math.max(1, Math.floor((stamp * release.bpm) / 240) + 1) : undefined;
    setCommentBusy(true);
    try {
      const created = await postShareComment(release.share_slug, {
        timestamp_sec: Number(stamp.toFixed(2)),
        bar_number: estimatedBar,
        text: commentText.trim(),
      });
      setComments((prev) =>
        [...prev, created].sort((a, b) => a.timestamp_sec - b.timestamp_sec)
      );
      setRelease((prev) =>
        prev
          ? {
              ...prev,
              comments_count: created.comments_count ?? (prev.comments_count ?? 0) + 1,
            }
          : prev
      );
      setCommentText('');
      setPinnedTimestampSec(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Không thể đăng bình luận.');
    } finally {
      setCommentBusy(false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!release) return;
    try {
      const res = await deleteShareComment(release.share_slug, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
      setRelease((prev) => (prev ? { ...prev, comments_count: res.comments_count } : prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Không có quyền xóa bình luận này.');
    }
  };

  const handleCopyShareLink = async () => {
    if (typeof window === 'undefined' || !release) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/share/${release.share_slug}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleRemixInStudio = async () => {
    if (!release) return;
    setRemixing(true);
    try {
      const state = await getProject(release.project_id);
      const remixId = `remix_${Date.now()}`;
      const remixTitle = `${state.title || release.title} (Remix)`;
      loadProjectIntoSession(
        {
          ...state,
          project_id: remixId,
          title: remixTitle,
          owner_id: authenticated ? user.user_id : 'guest',
          visibility: 'private',
          share_slug: null,
          published_at: null,
          source: 'draft',
          config: { ...state.config, title: remixTitle },
        },
        { dirty: true }
      );
      navigate(`/studio/${encodeURIComponent(remixId)}`);
    } catch {
      navigate('/create');
    } finally {
      setRemixing(false);
    }
  };

  const handleUnpublishFromShare = async () => {
    if (!release) return;
    setUnpublishing(true);
    try {
      await unpublishProject(release.project_id);
      navigate('/share', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Không thể thu hồi liên kết công khai.');
    } finally {
      setUnpublishing(false);
    }
  };

  if (loading && !slug && gallery.length === 0 && !search && !genre) {
    return (
      <div className="flex min-h-[300px] items-center justify-center gap-2 text-sm text-slate-300">
        <Loader2 className="h-5 w-5 animate-spin text-amber-400" />
        <span>Đang tải trang Demo Showcase...</span>
      </div>
    );
  }

  if (loading && slug) {
    return (
      <div className="flex min-h-[300px] items-center justify-center gap-2 text-sm text-slate-300">
        <Loader2 className="h-5 w-5 animate-spin text-amber-400" />
        <span>Đang tải trang Demo Showcase...</span>
      </div>
    );
  }

  if (!slug) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold text-white">Cộng đồng Demo &amp; Xuất bản</h1>
            <p className="text-xs text-slate-400">
              {totalReleases} bản phối Master (<code>-14 LUFS</code>, MP3 / FLAC / WAV) được chia sẻ công khai.
            </p>
          </div>
          <Link
            to="/studio"
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-bold text-slate-950 hover:bg-amber-400"
          >
            <Sparkles className="h-3.5 w-3.5" /> Mở Studio xuất bản bài
          </Link>
        </div>

        {/* Search & Genre Filter Bar */}
        <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-white/10 bg-[#16191f] p-3">
          <div className="relative min-w-[200px] flex-1">
            <label htmlFor="share-search-input" className="sr-only">
              Tìm demo công khai
            </label>
            <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              id="share-search-input"
              name="shareSearch"
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Tìm theo tên bài hát hoặc nghệ sĩ..."
              className="w-full rounded-lg border border-white/10 bg-[#0d1015] py-1.5 pl-9 pr-3 text-xs text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none"
            />
          </div>
          <label htmlFor="share-genre-filter" className="sr-only">
            Lọc thể loại
          </label>
          <select
            id="share-genre-filter"
            name="shareGenre"
            value={genre}
            onChange={(e) => {
              setGenre(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-white/10 bg-[#0d1015] px-3 py-1.5 text-xs text-white"
          >
            {SHARE_GENRES.map((g) => (
              <option key={g || 'all'} value={g}>
                {g ? `Genre: ${g}` : 'Tất cả thể loại'}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/15 px-4 py-3 text-xs text-rose-200">
            {error}
          </div>
        )}

        {gallery.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-[#16191f] py-16 text-center">
            <Disc3 className="h-10 w-10 text-slate-600" />
            <p className="mt-3 text-sm font-semibold text-white">
              {search || genre ? 'Không có bản demo phù hợp bộ lọc' : 'Chưa có bản demo công khai nào'}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {search || genre
                ? 'Hãy thử từ khóa khác hoặc đặt lại bộ lọc.'
                : 'Mở Studio và bấm nút Publish để tạo link chia sẻ đầu tiên!'}
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {gallery.map((item) => (
                <Link
                  key={item.share_slug}
                  to={`/share/${encodeURIComponent(item.share_slug)}`}
                  className="group flex flex-col justify-between rounded-2xl border border-white/10 bg-[#16191f] p-4 transition hover:border-amber-400/50"
                >
                  <div className="flex items-start gap-3">
                    <TrackArtwork title={item.title} genre={item.genre} seed={item.share_slug} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1">
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-300">
                            {item.master_format}
                          </span>
                          {authenticated && item.owner_id === user.user_id && (
                            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                              Của bạn
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] text-slate-400">{item.plays_count} lượt nghe</span>
                      </div>
                      <h2 className="mt-1 truncate text-sm font-bold text-white group-hover:text-amber-300">
                        {item.title}
                      </h2>
                      <p className="truncate text-xs text-slate-400">{item.artist}</p>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-400 tabular-nums">
                        <span className="truncate">
                          {item.genre} • {Math.round(item.bpm)} BPM • {item.key} {item.scale}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
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
                  <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2.5 text-xs text-sky-300">
                    <span>Nghe Master Demo</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </div>
                </Link>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-1 text-xs text-slate-400">
                <span>
                  Trang {page} / {totalPages}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="inline-flex items-center gap-1 rounded border border-white/15 px-3 py-1 text-slate-200 hover:bg-white/10 disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Trước
                  </button>
                  <button
                    type="button"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="inline-flex items-center gap-1 rounded border border-white/15 px-3 py-1 text-slate-200 hover:bg-white/10 disabled:opacity-40"
                  >
                    Sau <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  if (error || !release) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-rose-500/40 bg-rose-500/10 p-6 text-center">
        <Music className="mx-auto h-8 w-8 text-rose-400" />
        <h2 className="mt-2 text-base font-bold text-white">Không tìm thấy bản Demo</h2>
        <p className="mt-1 text-xs text-rose-200">{error || 'Liên kết không tồn tại hoặc đã bị tác giả thu hồi.'}</p>
        <Link
          to="/share"
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/20"
        >
          Xem Showcase cộng đồng
        </Link>
      </div>
    );
  }

  const audioUrl = getPublicShareAudioUrl(release.share_slug);
  const isOwner = authenticated && release.owner_id === user.user_id;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="rounded-2xl border border-white/15 bg-gradient-to-br from-[#191d26] to-[#12151b] p-6 shadow-xl">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <TrackArtwork
            title={release.title}
            genre={release.genre}
            seed={release.share_slug}
            size="lg"
            isPlaying={isPlaying}
          />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 font-bold text-emerald-300">
                MASTER RELEASE ({release.master_format.toUpperCase()} • {release.lufs_target} LUFS)
              </span>
              {isOwner && (
                <span className="rounded-full bg-sky-500/20 px-2.5 py-0.5 font-bold text-sky-300">
                  Bản phát hành của bạn
                </span>
              )}
              <span className="inline-flex items-center gap-1 text-slate-400">
                <Headphones className="h-3.5 w-3.5" /> {release.plays_count} lượt phát
              </span>
            </div>
            <h1 className="font-display text-2xl font-extrabold text-white">{release.title}</h1>
            <p className="text-sm font-medium text-amber-300">{release.artist}</p>
            <p className="text-xs text-slate-400 tabular-nums">
              {release.genre} • {Math.round(release.bpm)} BPM • {release.key} {release.scale} • {release.total_bars} bars
            </p>
          </div>
        </div>

        {/* Native Audio Player + Timestamp Comment Markers */}
        <div className="mt-5 space-y-2.5 rounded-xl border border-white/10 bg-[#0d1015] p-3.5">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={togglePlay}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500 text-slate-950 transition hover:bg-amber-400"
              aria-label={isPlaying ? 'Tạm dừng' : 'Phát Master'}
            >
              {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 translate-x-0.5" />}
            </button>
            <audio
              ref={audioRef}
              src={audioUrl}
              controls
              onLoadedMetadata={(e) => setDurationSec(e.currentTarget.duration || 0)}
              onTimeUpdate={(e) => setCurrentTimeSec(e.currentTarget.currentTime || 0)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
              className="h-9 min-w-0 flex-1"
            />
          </div>

          {comments.length > 0 && (
            <div className="relative h-6 rounded-md border border-white/[0.06] bg-[#141821] px-2">
              <span className="pointer-events-none text-[10px] leading-6 text-slate-400">
                Mốc bình luận ({comments.length}):
              </span>
              {comments.map((c) => {
                const denom = durationSec > 0 ? durationSec : Math.max(c.timestamp_sec + 1, 20);
                const pct = Math.max(4, Math.min(96, (c.timestamp_sec / denom) * 100));
                return (
                  <button
                    key={`pin-${c.id}`}
                    type="button"
                    onClick={() => seekAndPlayAt(c.timestamp_sec)}
                    title={`${formatMmSs(c.timestamp_sec)} — ${c.author_name}: ${c.text}`}
                    aria-label={`Nhảy tới bình luận tại ${formatMmSs(c.timestamp_sec)}`}
                    style={{ left: `${pct}%` }}
                    className="absolute top-1 -translate-x-1/2 rounded-full bg-amber-400 px-1.5 py-0.5 font-mono text-[9px] font-bold text-slate-950 shadow transition hover:scale-110 hover:bg-amber-300"
                  >
                    {formatMmSs(c.timestamp_sec)}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Share, Like & Remix Actions */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={likeBusy}
              onClick={() => void handleToggleLike()}
              data-testid="share-like-btn"
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                release.liked_by_me
                  ? 'border-rose-400/60 bg-rose-500/20 text-rose-200'
                  : 'border-white/15 bg-[#20242e] text-slate-200 hover:border-rose-400/40 hover:text-rose-200'
              }`}
            >
              <Heart className={`h-3.5 w-3.5 ${release.liked_by_me ? 'fill-rose-400 text-rose-400' : 'text-rose-300'}`} />
              <span>{release.likes_count ?? 0} Thích</span>
            </button>
            <button
              type="button"
              onClick={() => void handleCopyShareLink()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#20242e] px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10"
            >
              <Share2 className="h-3.5 w-3.5 text-amber-400" />
              <span>{copied ? 'Đã copy link!' : 'Copy Share Link'}</span>
            </button>
            <a
              href={audioUrl}
              download={`${release.share_slug}.${release.master_format}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#20242e] px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-white/10"
            >
              <Download className="h-3.5 w-3.5" /> Tải Master ({release.master_format.toUpperCase()})
            </a>
            {isOwner && (
              <button
                type="button"
                disabled={unpublishing}
                onClick={() => void handleUnpublishFromShare()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/20 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>{unpublishing ? 'Đang thu hồi...' : 'Thu hồi Publish'}</span>
              </button>
            )}
          </div>

          <button
            type="button"
            disabled={remixing}
            onClick={() => void handleRemixInStudio()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-indigo-400 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>{remixing ? 'Đang nhân bản...' : 'Remix trong Studio'}</span>
          </button>
        </div>
      </div>

      {/* Sections / Chords / Lyrics Preview */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-[#16191f] p-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Hòa âm &amp; Cấu trúc</h2>
          {release.sections && release.sections.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {release.sections.map((sec, i) => (
                <span
                  key={`${sec.name}-${i}`}
                  className="rounded border border-white/10 bg-[#1d222c] px-2.5 py-1 text-[11px] text-slate-200"
                >
                  {sec.name} ({sec.bars}b)
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-400">Chưa có thông tin cấu trúc đoạn.</p>
          )}
          {release.chords && release.chords.length > 0 && (
            <p className="mt-3 text-xs text-amber-300">
              Vòng hợp âm: {release.chords.slice(0, 12).map((c) => c.symbol).join(' → ')}
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#16191f] p-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Lời bài hát</h2>
          {release.lyrics && release.lyrics.length > 0 ? (
            <div className="mt-2 space-y-1 text-xs text-slate-200">
              {release.lyrics.map((l, idx) => (
                <p key={idx}>
                  <span className="mr-1.5 text-[10px] font-bold text-slate-400">[{l.section}]</span>
                  {l.text}
                </p>
              ))}
            </div>
          ) : release.lyrics_summary ? (
            <p className="mt-2 whitespace-pre-line text-xs text-slate-300">{release.lyrics_summary}</p>
          ) : (
            <p className="mt-2 text-xs text-slate-400">Bản phối không lời / Instrumental.</p>
          )}
        </div>
      </div>

      {/* Phase 9: Community Timestamp Comments */}
      <section className="space-y-3 rounded-2xl border border-white/10 bg-[#16191f] p-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-300">
            <MessageSquare className="h-3.5 w-3.5 text-amber-400" />
            <span>Bình luận theo Thời gian ({comments.length})</span>
          </h2>
          <span className="text-[11px] text-slate-400">
            Bấm vào mốc thời gian để nghe đúng đoạn đó
          </span>
        </div>

        <form onSubmit={(e) => void handleSubmitComment(e)} className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setPinnedTimestampSec(currentTimeSec)}
            title="Cố định mốc thời gian đang phát"
            className="inline-flex items-center gap-1 rounded-lg border border-amber-400/35 bg-amber-500/10 px-2.5 py-2 font-mono text-xs font-bold text-amber-300 hover:bg-amber-500/20"
          >
            <Clock className="h-3.5 w-3.5" />
            <span>{formatMmSs(pinnedTimestampSec ?? currentTimeSec)}</span>
          </button>
          <div className="min-w-[200px] flex-1">
            <label htmlFor="share-comment-input" className="sr-only">
              Viết bình luận theo mốc thời gian
            </label>
            <input
              id="share-comment-input"
              name="shareComment"
              type="text"
              maxLength={500}
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder={`Nhận xét tại ${formatMmSs(pinnedTimestampSec ?? currentTimeSec)}...`}
              className="w-full rounded-lg border border-white/15 bg-[#0d1015] px-3 py-2 text-xs text-white placeholder-slate-400 focus:border-amber-400 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={commentBusy || !commentText.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
            <span>{commentBusy ? 'Đang gửi...' : 'Gửi bình luận'}</span>
          </button>
        </form>

        {comments.length === 0 ? (
          <p className="py-3 text-center text-xs text-slate-400">
            Chưa có bình luận nào. Hãy nghe và để lại nhận xét tại giây đầu tiên!
          </p>
        ) : (
          <div className="space-y-2">
            {comments.map((c) => {
              const canDelete = isOwner || (authenticated && c.author_id === user.user_id);
              return (
                <div
                  key={c.id}
                  className="flex items-start justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#11141a] px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <button
                        type="button"
                        onClick={() => seekAndPlayAt(c.timestamp_sec)}
                        className="rounded bg-amber-500/20 px-2 py-0.5 font-mono font-bold text-amber-300 hover:bg-amber-500/35"
                      >
                        @ {formatMmSs(c.timestamp_sec)}
                      </button>
                      {c.bar_number && (
                        <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">
                          Bar {c.bar_number}
                        </span>
                      )}
                      <span className="font-semibold text-white">{c.author_name}</span>
                      <span className="text-slate-400">
                        {new Date(c.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-xs text-slate-200">{c.text}</p>
                  </div>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteComment(c.id)}
                      aria-label={`Xóa bình luận của ${c.author_name}`}
                      className="rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
