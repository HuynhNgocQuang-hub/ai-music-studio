import { Share2, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ProjectState } from '@/types/project';

interface StudioPublishModalProps {
  open: boolean;
  project: ProjectState;
  authenticated: boolean;
  displayName: string;
  publishArtist: string;
  publishFormat: 'mp3' | 'flac' | 'wav';
  publishBusy: boolean;
  onClose: () => void;
  onChangeArtist: (value: string) => void;
  onChangeFormat: (value: 'mp3' | 'flac' | 'wav') => void;
  onChangeTargetLufs: (lufs: number) => void;
  onPublish: () => Promise<void>;
  onUnpublish: () => Promise<void>;
  onOpenAuthModal: () => void;
}

export default function StudioPublishModal({
  open,
  project,
  authenticated,
  displayName,
  publishArtist,
  publishFormat,
  publishBusy,
  onClose,
  onChangeArtist,
  onChangeFormat,
  onChangeTargetLufs,
  onPublish,
  onUnpublish,
  onOpenAuthModal,
}: StudioPublishModalProps) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Xuất bản & Chia sẻ Demo"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
    >
      <div className="w-full max-w-md rounded-2xl border border-white/15 bg-[#16191f] p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <div className="flex items-center gap-2">
            <Share2 className="h-4 w-4 text-amber-400" />
            <h3 className="font-display text-sm font-bold text-white">
              Xuất bản Master &amp; Chia sẻ Demo
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-3 text-xs">
          <div>
            <label
              htmlFor="studio-publish-artist"
              className="mb-1 block text-[11px] font-medium text-slate-300"
            >
              Tên nghệ sĩ / Producer (ID3 Tag)
            </label>
            <input
              id="studio-publish-artist"
              name="publishArtist"
              type="text"
              autoComplete="name"
              value={publishArtist}
              onChange={(e) => onChangeArtist(e.target.value)}
              placeholder={authenticated ? displayName : 'AI Music Studio Creator'}
              className="w-full rounded-lg border border-white/15 bg-[#0b0d11] px-3 py-2 text-xs text-white focus:border-amber-400 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="studio-publish-format"
              className="mb-1 block text-[11px] font-medium text-slate-300"
            >
              Định dạng Master ({project.mastering.target_lufs} LUFS / Peak &lt;= -1.0 dBFS)
            </label>
            <select
              id="studio-publish-format"
              name="publishFormat"
              value={publishFormat}
              onChange={(e) => onChangeFormat(e.target.value as 'mp3' | 'flac' | 'wav')}
              className="w-full rounded-lg border border-white/15 bg-[#0b0d11] px-3 py-2 text-xs text-white"
            >
              <option value="mp3">MP3 320kbps + ID3 Tags (Nhẹ &amp; Streaming)</option>
              <option value="flac">FLAC Lossless + Tags (Chất lượng gốc)</option>
              <option value="wav">WAV 44.1kHz PCM 16-bit</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="studio-publish-lufs"
              className="mb-1 block text-[11px] font-medium text-slate-300"
            >
              Mục tiêu Âm lượng (Target LUFS)
            </label>
            <select
              id="studio-publish-lufs"
              name="publishTargetLufs"
              value={String(project.mastering.target_lufs ?? -14)}
              onChange={(e) => onChangeTargetLufs(Number(e.target.value))}
              className="w-full rounded-lg border border-white/15 bg-[#0b0d11] px-3 py-2 text-xs text-white"
            >
              <option value="-9">-9.0 LUFS (Club / EDM Mạnh mẽ)</option>
              <option value="-14">-14.0 LUFS (Spotify / YouTube Chuẩn)</option>
              <option value="-16">-16.0 LUFS (Apple Music / Động rộng)</option>
            </select>
          </div>

          {project.visibility === 'public' && project.share_slug && (
            <div className="space-y-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3">
              <div className="flex items-center justify-between text-emerald-200">
                <span className="font-semibold">Đang chia sẻ công khai</span>
                <Link
                  to={`/share/${encodeURIComponent(project.share_slug)}`}
                  onClick={onClose}
                  className="font-bold text-amber-300 underline hover:text-amber-200"
                >
                  Mở trang Demo
                </Link>
              </div>
              <div className="truncate rounded bg-[#0b0d11] px-2.5 py-1.5 font-mono text-[11px] text-slate-300">
                {typeof window !== 'undefined'
                  ? `${window.location.origin}/share/${project.share_slug}`
                  : `/share/${project.share_slug}`}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <button
              type="button"
              onClick={onOpenAuthModal}
              className="text-[11px] text-sky-300 underline hover:text-sky-200"
            >
              {authenticated ? `Cloud: ${displayName}` : 'Đăng nhập Cloud & Quota'}
            </button>

            <div className="flex items-center gap-2">
              {project.visibility === 'public' && project.share_slug && (
                <button
                  type="button"
                  disabled={publishBusy}
                  onClick={() => void onUnpublish()}
                  className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 font-semibold text-rose-200 hover:bg-rose-500/25 disabled:opacity-50"
                >
                  Thu hồi Link
                </button>
              )}
              <button
                type="button"
                disabled={publishBusy}
                onClick={() => void onPublish()}
                className="rounded-lg bg-amber-500 px-4 py-1.5 font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {publishBusy
                  ? 'Đang Master & Upload...'
                  : project.visibility === 'public'
                  ? 'Cập nhật Bản Publish'
                  : 'Publish & Lấy Link'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
