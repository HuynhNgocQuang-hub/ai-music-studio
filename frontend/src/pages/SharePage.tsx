import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Disc3,
  Download,
  ExternalLink,
  Headphones,
  Loader2,
  Music,
  Pause,
  Play,
  Share2,
  Sparkles,
} from 'lucide-react';
import { TrackArtwork } from '@/components/shared/TrackArtwork';
import { useProjectSession } from '@/components/providers/ProjectProvider';
import {
  ApiError,
  getProject,
  getPublicShare,
  getPublicShareAudioUrl,
  listPublicReleases,
} from '@/lib/api/client';
import type { PublishedRelease } from '@/types/project';

export default function SharePage() {
  const { slug } = useParams<{ slug?: string }>();
  const navigate = useNavigate();
  const { loadProjectIntoSession } = useProjectSession();

  const [release, setRelease] = useState<PublishedRelease | null>(null);
  const [gallery, setGallery] = useState<PublishedRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [remixing, setRemixing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setIsPlaying(false);

    if (slug) {
      getPublicShare(slug)
        .then((res) => {
          if (active) setRelease(res);
        })
        .catch((err) => {
          if (active) setError(err instanceof ApiError ? err.detail : 'Không tìm thấy bản nhạc được chia sẻ.');
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    } else {
      listPublicReleases({ page: 1, limit: 24 })
        .then((res) => {
          if (active) setGallery(res.items || []);
        })
        .catch((err) => {
          if (active) setError(err instanceof ApiError ? err.detail : 'Không thể tải danh sách bản phát hành.');
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }

    return () => {
      active = false;
    };
  }, [slug]);

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
      loadProjectIntoSession(
        {
          ...state,
          project_id: `remix_${Date.now()}`,
          title: `${state.title} (Remix)`,
          visibility: 'private',
          share_slug: null,
        },
        { dirty: true }
      );
      navigate('/studio');
    } catch {
      navigate('/create');
    } finally {
      setRemixing(false);
    }
  };

  if (loading) {
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
              Các bản phối Master (`-14 LUFS`, MP3 / FLAC / WAV) được nghệ sĩ chia sẻ công khai từ AI Music Studio.
            </p>
          </div>
          <Link
            to="/studio"
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-bold text-slate-950 hover:bg-amber-400"
          >
            <Sparkles className="h-3.5 w-3.5" /> Mở Studio xuất bản bài
          </Link>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/15 px-4 py-3 text-xs text-rose-200">
            {error}
          </div>
        )}

        {gallery.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-[#16191f] py-16 text-center">
            <Disc3 className="h-10 w-10 text-slate-600" />
            <p className="mt-3 text-sm font-semibold text-white">Chưa có bản demo công khai nào</p>
            <p className="mt-1 text-xs text-slate-400">
              Mở Studio và bấm nút <strong>Publish</strong> để tạo link chia sẻ đầu tiên!
            </p>
          </div>
        ) : (
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
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-300">
                        {item.master_format}
                      </span>
                      <span className="text-[11px] text-slate-400">{item.plays_count} lượt nghe</span>
                    </div>
                    <h2 className="mt-1 truncate text-sm font-bold text-white group-hover:text-amber-300">
                      {item.title}
                    </h2>
                    <p className="truncate text-xs text-slate-400">{item.artist}</p>
                    <p className="mt-1 text-[11px] text-slate-500 tabular-nums">
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
