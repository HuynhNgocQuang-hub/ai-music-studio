import React, { useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Link2,
  MessageSquarePlus,
  Radio,
  Trash2,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type { CollabPeerPresence, StudioBarComment } from '@/types/project';

interface StudioCollabPanelProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  currentBar: number;
  totalBars: number;
  trackNames: string[];
  wsConnected: boolean;
  roomCode: string | null;
  isRoomOwner: boolean;
  peers: CollabPeerPresence[];
  lastSyncNotice: string | null;
  barComments: StudioBarComment[];
  collabError: string | null;
  onEnableInvite: () => Promise<void>;
  onCloseInvite: () => Promise<void>;
  onAddBarComment: (payload: { bar_number: number; track_id?: string; text: string }) => Promise<void>;
  onToggleResolved: (commentId: string, nextResolved: boolean) => Promise<void>;
  onDeleteComment: (commentId: string) => Promise<void>;
  onSeekToBar: (barNumber: number) => void;
  onBroadcastCue: () => void;
}

export default function StudioCollabPanel({
  open,
  onClose,
  projectId,
  currentBar,
  totalBars,
  trackNames,
  wsConnected,
  roomCode,
  isRoomOwner,
  peers,
  lastSyncNotice,
  barComments,
  collabError,
  onEnableInvite,
  onCloseInvite,
  onAddBarComment,
  onToggleResolved,
  onDeleteComment,
  onSeekToBar,
  onBroadcastCue,
}: StudioCollabPanelProps) {
  const [barInput, setBarInput] = useState<number>(Math.max(1, currentBar));
  const [trackInput, setTrackInput] = useState<string>('');
  const [noteText, setNoteText] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hideResolved, setHideResolved] = useState(false);

  if (!open) return null;

  const inviteUrl =
    typeof window !== 'undefined' && roomCode
      ? `${window.location.origin}/studio/${encodeURIComponent(projectId)}?collab=${encodeURIComponent(roomCode)}`
      : roomCode
      ? `/studio/${encodeURIComponent(projectId)}?collab=${encodeURIComponent(roomCode)}`
      : '';

  const handleCopyInvite = async () => {
    if (!inviteUrl || typeof window === 'undefined') return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard permissions error
    }
  };

  const handleSubmitNote = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = noteText.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await onAddBarComment({
        bar_number: Math.max(1, Math.min(totalBars, barInput)),
        track_id: trackInput || undefined,
        text: trimmed,
      });
      setNoteText('');
    } finally {
      setSubmitting(false);
    }
  };

  const visibleComments = hideResolved ? barComments.filter((c) => !c.resolved) : barComments;

  return (
    <aside
      aria-label="Phòng cộng tác Realtime & Ghi chú Bar"
      className="flex w-80 shrink-0 flex-col overflow-hidden rounded-lg border border-sky-400/25 bg-[#151922] shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-white/10 bg-[#1b202b] px-3 py-2">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-sky-400" />
          <span className="text-xs font-bold text-white">Realtime Studio Collab</span>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
              wsConnected ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-600/40 text-slate-300'
            }`}
          >
            {wsConnected ? <Wifi className="h-2.5 w-2.5" /> : <WifiOff className="h-2.5 w-2.5" />}
            {wsConnected ? 'LIVE' : 'Offline'}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng bảng Collab"
          className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-xs">
        {collabError && (
          <div className="rounded border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-200">
            {collabError}
          </div>
        )}

        {/* Room Invite Controls */}
        <section className="space-y-2 rounded-lg border border-white/10 bg-[#10131a] p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-200">
              Thành viên online ({peers.length})
            </span>
            <button
              type="button"
              onClick={onBroadcastCue}
              disabled={!wsConnected}
              className="inline-flex items-center gap-1 rounded border border-amber-400/35 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200 hover:bg-amber-500/20 disabled:opacity-40"
            >
              <Radio className="h-2.5 w-2.5" /> Cue Bar {currentBar}
            </button>
          </div>

          {peers.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {peers.map((p) => (
                <button
                  key={`${p.client_id}-${p.joined_at}`}
                  type="button"
                  onClick={() => onSeekToBar(p.bar)}
                  title={`Nhấn để nhảy tới Bar ${p.bar} (${p.track_id || 'studio'})`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[#191e29] px-2 py-0.5 text-[10px] text-slate-200 hover:border-sky-400/40"
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: p.color || '#38bdf8' }}
                  />
                  <span className="max-w-[90px] truncate font-semibold">{p.display_name}</span>
                  <span className="font-mono text-slate-400">B{p.bar}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-slate-400">Chỉ có bạn hoặc đang kết nối WebSocket...</p>
          )}

          {lastSyncNotice && (
            <p className="rounded bg-sky-500/10 px-2 py-1 text-[10px] text-sky-200">{lastSyncNotice}</p>
          )}

          {roomCode ? (
            <div className="space-y-1.5 border-t border-white/[0.06] pt-2">
              <div className="flex items-center gap-1.5">
                <input
                  id="collab-invite-link-input"
                  name="collabInviteUrl"
                  type="text"
                  readOnly
                  aria-label="Liên kết mời cộng tác"
                  value={inviteUrl}
                  className="min-w-0 flex-1 rounded border border-white/15 bg-[#0b0d11] px-2 py-1 font-mono text-[10px] text-slate-300"
                />
                <button
                  type="button"
                  onClick={() => void handleCopyInvite()}
                  className="inline-flex items-center gap-1 rounded bg-sky-500 px-2 py-1 text-[10px] font-bold text-slate-950 hover:bg-sky-400"
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  <span>{copied ? 'Đã copy' : 'Copy'}</span>
                </button>
              </div>
              {isRoomOwner && (
                <button
                  type="button"
                  onClick={() => void onCloseInvite()}
                  className="text-[10px] font-semibold text-rose-300 hover:text-rose-200"
                >
                  Thu hồi link &amp; Đóng phòng cộng tác
                </button>
              )}
            </div>
          ) : (
            isRoomOwner && (
              <button
                type="button"
                onClick={() => void onEnableInvite()}
                data-testid="collab-enable-btn"
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-sky-400/40 bg-sky-500/15 py-1.5 text-[11px] font-bold text-sky-200 hover:bg-sky-500/25"
              >
                <Link2 className="h-3.5 w-3.5" /> Tạo Link Mời Cộng Tác Live
              </button>
            )
          )}
        </section>

        {/* Pinned Bar Notes */}
        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
              Ghi chú theo Ô nhịp ({visibleComments.length})
            </h3>
            <label className="flex cursor-pointer items-center gap-1 text-[10px] text-slate-400">
              <input
                id="collab-hide-resolved"
                type="checkbox"
                checked={hideResolved}
                onChange={(e) => setHideResolved(e.target.checked)}
                className="accent-sky-400"
              />
              <span>Ẩn đã xong</span>
            </label>
          </div>

          <form onSubmit={(e) => void handleSubmitNote(e)} className="space-y-2 rounded-lg border border-white/10 bg-[#10131a] p-2.5">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="collab-note-bar" className="mb-0.5 block text-[10px] text-slate-400">
                  Ô nhịp (Bar)
                </label>
                <div className="flex items-center gap-1">
                  <input
                    id="collab-note-bar"
                    name="barNumber"
                    type="number"
                    min={1}
                    max={Math.max(1, totalBars)}
                    value={barInput}
                    onChange={(e) => setBarInput(Math.max(1, Number(e.target.value) || 1))}
                    className="w-full rounded border border-white/15 bg-[#0b0d11] px-2 py-1 font-mono text-[11px] text-white"
                  />
                  <button
                    type="button"
                    onClick={() => setBarInput(Math.max(1, currentBar))}
                    title="Lấy ô nhịp Playhead hiện tại"
                    className="rounded border border-white/15 px-1.5 py-1 text-[10px] text-amber-300 hover:bg-white/10"
                  >
                    B{currentBar}
                  </button>
                </div>
              </div>
              <div>
                <label htmlFor="collab-note-track" className="mb-0.5 block text-[10px] text-slate-400">
                  Track (tùy chọn)
                </label>
                <select
                  id="collab-note-track"
                  name="trackId"
                  value={trackInput}
                  onChange={(e) => setTrackInput(e.target.value)}
                  className="w-full rounded border border-white/15 bg-[#0b0d11] px-2 py-1 text-[11px] text-white"
                >
                  <option value="">Toàn bài</option>
                  {trackNames.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="collab-note-text" className="sr-only">
                Nội dung ghi chú ô nhịp
              </label>
              <input
                id="collab-note-text"
                name="barNoteText"
                type="text"
                maxLength={500}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="VD: Đoạn này nâng bass thêm 2dB..."
                className="w-full rounded border border-white/15 bg-[#0b0d11] px-2.5 py-1.5 text-[11px] text-white placeholder-slate-500 focus:border-sky-400 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={submitting || !noteText.trim()}
              className="flex w-full items-center justify-center gap-1.5 rounded bg-amber-500 py-1.5 text-[11px] font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              <span>{submitting ? 'Đang gửi...' : 'Ghim Ghi chú'}</span>
            </button>
          </form>

          {visibleComments.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-slate-400">Chưa có ghi chú nào.</p>
          ) : (
            <div className="space-y-1.5">
              {visibleComments.map((c) => (
                <div
                  key={c.id}
                  className={`rounded-lg border p-2 transition ${
                    c.resolved
                      ? 'border-white/[0.05] bg-[#101319]/60 opacity-65'
                      : 'border-white/10 bg-[#10131a]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onSeekToBar(c.bar_number)}
                        className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-300 hover:bg-amber-500/35"
                      >
                        Bar {c.bar_number}
                      </button>
                      {c.track_id && (
                        <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">
                          {c.track_id}
                        </span>
                      )}
                      <span className="text-[10px] font-semibold text-slate-300">{c.author_name}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void onToggleResolved(c.id, !c.resolved)}
                        title={c.resolved ? 'Mở lại ghi chú' : 'Đánh dấu đã xử lý'}
                        aria-label={c.resolved ? `Mở lại ghi chú Bar ${c.bar_number}` : `Xong ghi chú Bar ${c.bar_number}`}
                        className={`inline-flex h-6 w-6 items-center justify-center rounded ${
                          c.resolved ? 'text-emerald-400' : 'text-slate-400 hover:bg-white/5 hover:text-emerald-300'
                        }`}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDeleteComment(c.id)}
                        title="Xóa ghi chú"
                        aria-label={`Xóa ghi chú Bar ${c.bar_number}`}
                        className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-white/5 hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <p className={`mt-1 text-[11px] ${c.resolved ? 'line-through text-slate-400' : 'text-slate-200'}`}>
                    {c.text}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
