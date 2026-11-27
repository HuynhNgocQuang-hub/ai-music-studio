import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Disc3,
  Download,
  ExternalLink,
  Headphones,
  Loader2,
  Music,
  Pause,
  Play,
  Search,
  Share2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import { TrackArtwork } from '@/components/shared/TrackArtwork';
import { useProjectSession } from '@/components/providers/ProjectProvider';
import {
  ApiError,
  getProject,
  getPublicShare,
  getPublicShareAudioUrl,
  listPublicReleases,
  unpublishProject,
} from '@/lib/api/client';
import type { PublishedRelease } from '@/types/project';

const SHARE_GENRES = ['', 'Pop', 'Ballad', 'Lo-fi', 'R&B', 'Hip-hop', 'EDM', 'Acoustic', 'Rock'];

export default function SharePage() {
  const { slug } = useParams<{ slug?: string }>();
  const navigate = useNavigate();
  const { authenticated, user } = useAuth();
  const { loadProjectIntoSession } = useProjectSession();

  const [release, setRelease] = useState<PublishedRelease | null>(null);
  const [gallery, setGallery] = useState<PublishedRelease[]>([]);
  const [search, setSearch] = useState('');
  const [genre, setGenre] = useState('');
  const [page, setPage] = useState(1);
  const [totalReleases, setTotalReleases] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
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

    if (slug) {
      setLoading(true);
      setError(null);
      getPublicShare(slug)
        .then((res) => {
          if (active) setRelease(res);
        })
        .catch((err) => {
          if (active) {
            setRelease(null);
            setError(err instanceof ApiError ? err.detail : 'Không tìm thấy bản nhạc được chia sẻ.');
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    } else {
      setRelease(null);
      void loadGallery();
    }

    return () => {
      active = false;
    };
  }, [slug, loadGallery]);

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
                      <p className="mt-1 text-[11px] text-slate-400 tabular-nums">
                        {item.genre} • {Math.round(item.bpm)} BPM • {item.key} {item.scale}
                      </p>
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

        {/* Native Audio Player */}
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-[#0d1015] p-3.5">
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
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
            className="h-9 min-w-0 flex-1"
          />
        </div>

        {/* Share & Remix Actions */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-4">
          <div className="flex flex-wrap gap-2">
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
            <p className="mt-2 text-xs text-slate-500">Chưa có thông tin cấu trúc đoạn.</p>
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
                  <span className="mr-1.5 text-[10px] font-bold text-slate-500">[{l.section}]</span>
                  {l.text}
                </p>
              ))}
            </div>
          ) : release.lyrics_summary ? (
            <p className="mt-2 whitespace-pre-line text-xs text-slate-300">{release.lyrics_summary}</p>
          ) : (
            <p className="mt-2 text-xs text-slate-500">Bản phối không lời / Instrumental.</p>
          )}
        </div>
      </div>
    </div>
  );
}
