import React, { useState } from 'react';
import { Lock, MessageSquare, Send, Unlock } from 'lucide-react';
import type { CollabChatMessage, CollabTrackLock } from '@/types/project';

interface CollabLockChatTabProps {
  clientId: string;
  trackNames: string[];
  wsConnected: boolean;
  isRoomOwner: boolean;
  trackLocks: Record<string, CollabTrackLock>;
  chatMessages: CollabChatMessage[];
  onToggleTrackLock: (trackId: string, locked: boolean) => void;
  onSendRoomChat: (text: string) => void;
}

export default function CollabLockChatTab({
  clientId,
  trackNames,
  wsConnected,
  isRoomOwner,
  trackLocks,
  chatMessages,
  onToggleTrackLock,
  onSendRoomChat,
}: CollabLockChatTabProps) {
  const [chatInput, setChatInput] = useState<string>('');

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    onSendRoomChat(chatInput);
    setChatInput('');
  };

  return (
    <>
      {/* Per-Track Collab Soft Locks */}
      <section className="space-y-2 rounded-lg border border-white/10 bg-[#10131a] p-2.5">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
            Khóa Track Cộng tác
          </h3>
          <span className="text-[10px] text-slate-400">
            {wsConnected ? 'WS Ready' : 'Cần WS LIVE'}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {trackNames.map((t) => {
            const lock = trackLocks[t];
            const heldBySelf = lock?.client_id === clientId;
            const heldByOther = Boolean(lock && !heldBySelf);
            return (
              <button
                key={t}
                type="button"
                disabled={!wsConnected || (heldByOther && !isRoomOwner)}
                onClick={() => onToggleTrackLock(t, !lock)}
                data-testid={`collab-lock-track-${t}`}
                className={`flex items-center justify-between rounded border px-2 py-1.5 text-[10px] font-semibold transition ${
                  heldBySelf
                    ? 'border-amber-400/60 bg-amber-500/20 text-amber-200'
                    : heldByOther
                    ? 'border-rose-400/50 bg-rose-500/15 text-rose-200'
                    : 'border-white/10 bg-[#161a24] text-slate-300 hover:border-sky-400/40'
                } disabled:opacity-50`}
              >
                <span className="truncate uppercase">{t}</span>
                <span className="inline-flex items-center gap-1">
                  {lock ? <Lock className="h-2.5 w-2.5" /> : <Unlock className="h-2.5 w-2.5 text-slate-400" />}
                  <span className="max-w-[56px] truncate">
                    {heldBySelf ? 'Của bạn' : heldByOther ? lock.display_name : 'Trống'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Live Room Chat */}
      <section className="flex flex-col space-y-2 rounded-lg border border-white/10 bg-[#10131a] p-2.5">
        <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-300">
          <MessageSquare className="h-3.5 w-3.5 text-sky-400" />
          <span>Chat phòng Studio ({chatMessages.length})</span>
        </h3>

        <div className="max-h-56 space-y-1.5 overflow-y-auto rounded border border-white/[0.06] bg-[#0b0d12] p-2">
          {chatMessages.length === 0 ? (
            <p className="py-4 text-center text-[10px] text-slate-400">
              Chưa có tin nhắn nào. Trao đổi trực tiếp với cộng tác viên tại đây.
            </p>
          ) : (
            chatMessages.map((m) => (
              <div key={m.id} className="space-y-0.5 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: m.color || '#38bdf8' }}
                  />
                  <span className="font-bold text-white">{m.display_name}</span>
                  <span className="text-[9px] text-slate-400">
                    {new Date(m.created_at).toLocaleTimeString()}
                  </span>
                </div>
                <p className="pl-3.5 text-slate-200">{m.text}</p>
              </div>
            ))
          )}
        </div>

        <form onSubmit={handleSendChat} className="flex items-center gap-1.5">
          <label htmlFor="collab-chat-input" className="sr-only">
            Tin nhắn phòng cộng tác
          </label>
          <input
            id="collab-chat-input"
            name="collabChatText"
            type="text"
            maxLength={400}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder={wsConnected ? 'Nhắn tới cả phòng...' : 'Cần WS LIVE để nhắn tin'}
            className="min-w-0 flex-1 rounded border border-white/15 bg-[#0b0d11] px-2.5 py-1.5 text-[11px] text-white placeholder-slate-400 focus:border-sky-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!wsConnected || !chatInput.trim()}
            data-testid="collab-chat-send"
            aria-label="Gửi tin nhắn phòng"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded bg-sky-500 text-slate-950 hover:bg-sky-400 disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </form>
      </section>
    </>
  );
}
