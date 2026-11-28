import { useState } from 'react';
import { Check, CheckCheck, Copy, RefreshCw, Sparkles, Undo2, Volume2 } from 'lucide-react';
import type { CoachMessage, CoachSuggestedAction, ProjectState } from '@/types/project';
import CoachMarkdown from './CoachMarkdown';

interface CoachMessageBubbleProps {
  message: CoachMessage;
  index: number;
  isLast: boolean;
  loading: boolean;
  statusText?: string | null;
  appliedMap: Record<string, boolean>;
  revertSnapshots: Record<string, ProjectState>;
  applyingKey: string | null;
  onApplyAction: (msgIdx: number, act: CoachSuggestedAction) => Promise<void>;
  onApplyAll: (msgIdx: number, acts: CoachSuggestedAction[]) => Promise<void>;
  onRevertAction: (actionKey: string, label: string) => Promise<void>;
  onRevertAll: (msgIdx: number, acts: CoachSuggestedAction[]) => Promise<void>;
  onAuditionChords: (chords: string[]) => void;
  onRegenerate?: () => void;
}

function summarizeActionTag(act: CoachSuggestedAction): string | null {
  const p = act.payload;
  if (!p) return null;
  if (act.action === 'set_track_mix') {
    const bits: string[] = [];
    if (typeof p.track_id === 'string') bits.push(p.track_id.toUpperCase());
    if (typeof p.volume === 'number') bits.push(`vol ${Math.round(p.volume * 100)}%`);
    if (typeof p.low_db === 'number') bits.push(`L ${p.low_db > 0 ? `+${p.low_db}` : p.low_db}dB`);
    if (typeof p.mid_db === 'number') bits.push(`M ${p.mid_db > 0 ? `+${p.mid_db}` : p.mid_db}dB`);
    if (typeof p.high_db === 'number') bits.push(`H ${p.high_db > 0 ? `+${p.high_db}` : p.high_db}dB`);
    if (typeof p.reverb_send === 'number') bits.push(`rev ${Math.round(p.reverb_send * 100)}%`);
    return bits.slice(0, 3).join(' · ') || null;
  }
  if (act.action === 'update_config') {
    const bits: string[] = [];
    if (typeof p.bpm === 'number') bits.push(`${Math.round(p.bpm)} BPM`);
    if (typeof p.key === 'string') bits.push(`${p.key}${typeof p.scale === 'string' ? ` ${p.scale}` : ''}`);
    if (typeof p.title === 'string') bits.push(`"${p.title}"`);
    return bits.join(' · ') || null;
  }
  if (act.action === 'rearrange_chords' && Array.isArray(p.chords)) {
    return (p.chords as string[]).slice(0, 4).join('-');
  }
  if (act.action === 'set_mastering' && typeof p.target_lufs === 'number') {
    return `${p.target_lufs} LUFS`;
  }
  return null;
}

export default function CoachMessageBubble({
  message,
  index,
  isLast,
  loading,
  statusText,
  appliedMap,
  revertSnapshots,
  applyingKey,
  onApplyAction,
  onApplyAll,
  onRevertAction,
  onRevertAll,
  onAuditionChords,
  onRegenerate,
}: CoachMessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const actions = message.suggested_actions || [];
  const unappliedCount = actions.filter((a) => !appliedMap[`${index}:${a.id}`]).length;
  const revertibleAppliedCount = actions.filter(
    (a) => appliedMap[`${index}:${a.id}`] && Boolean(revertSnapshots[`${index}:${a.id}`])
  ).length;

  const handleCopyMessage = async () => {
    if (!message.content) return;
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // ignore clipboard errors
    }
  };

  if (message.role === 'user') {
    return (
      <div className="ml-6 rounded-2xl border border-amber-500/30 bg-amber-500/15 p-2.5 text-[12px] leading-relaxed text-amber-50">
        <p className="whitespace-pre-wrap">{message.content}</p>
      </div>
    );
  }

  return (
    <div className="mr-1 space-y-2 rounded-2xl border border-white/[0.08] bg-[#1b1e25] p-3 text-slate-200">
      <div className="flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-300">
        <span className="flex items-center gap-1 text-sky-300">
          <Sparkles className="h-3 w-3" />
          <span>{message.provider === 'mock' ? 'Local Engine' : message.provider || 'Copilot'}</span>
        </span>
        <div className="flex items-center gap-1">
          {message.content && (
            <button
              type="button"
              onClick={() => void handleCopyMessage()}
              title="Sao chép câu trả lời"
              aria-label="Sao chép câu trả lời"
              className="inline-flex min-h-[24px] min-w-[24px] items-center justify-center rounded px-1.5 text-slate-300 hover:bg-white/10 hover:text-white"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
            </button>
          )}
          {isLast && !loading && index > 0 && onRegenerate && (
            <button
              type="button"
              onClick={onRegenerate}
              title="Tạo lại câu trả lời khác"
              aria-label="Thử lại câu trả lời"
              className="inline-flex min-h-[24px] items-center gap-1 rounded px-1.5 text-[10px] font-semibold normal-case text-slate-300 hover:bg-white/10 hover:text-amber-200"
            >
              <RefreshCw className="h-3 w-3" />
              <span>Thử lại</span>
            </button>
          )}
        </div>
      </div>

      {message.content ? (
        <CoachMarkdown content={message.content} />
      ) : loading && isLast ? (
        <div className="flex items-center gap-2 py-1 text-[11px] text-amber-200">
          <span className="h-2 w-2 animate-ping rounded-full bg-amber-400" />
          <span>{statusText || 'Đang phân tích & suy nghĩ...'}</span>
        </div>
      ) : null}

      {actions.length > 0 && (
        <div className="space-y-1.5 border-t border-white/[0.08] pt-2">
          {(unappliedCount >= 2 || revertibleAppliedCount >= 2) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {unappliedCount >= 2 && (
                <button
                  type="button"
                  onClick={() => void onApplyAll(index, actions)}
                  className="inline-flex min-h-[24px] items-center gap-1 rounded-md bg-amber-500/25 px-2.5 py-0.5 text-[10px] font-bold text-amber-200 hover:bg-amber-500/35"
                >
                  <CheckCheck className="h-3 w-3" /> Áp dụng tất cả ({unappliedCount})
                </button>
              )}
              {revertibleAppliedCount >= 2 && (
                <button
                  type="button"
                  onClick={() => void onRevertAll(index, actions)}
                  className="inline-flex min-h-[24px] items-center gap-1 rounded-md border border-rose-400/35 bg-rose-500/15 px-2.5 py-0.5 text-[10px] font-bold text-rose-200 hover:bg-rose-500/25"
                >
                  <Undo2 className="h-3 w-3" /> Hoàn tác tất cả
                </button>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-1.5">
            {actions.map((act) => {
              const actionKey = `${index}:${act.id}`;
              const applied = Boolean(appliedMap[actionKey]);
              const busy = applyingKey === actionKey;
              const canRevert = applied && Boolean(revertSnapshots[actionKey]);
              const paramTag = summarizeActionTag(act);

              return (
                <div key={act.id} className="inline-flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    disabled={applied || busy}
                    onClick={() => void onApplyAction(index, act)}
                    title={paramTag || act.action}
                    className={`inline-flex min-h-[26px] items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-white transition ${
                      applied
                        ? 'cursor-default bg-emerald-700/90 text-emerald-50'
                        : 'bg-sky-700 hover:bg-sky-600 disabled:opacity-50'
                    }`}
                  >
                    <span>{busy ? 'Đang xử lý...' : applied ? `✓ ${act.label}` : act.label}</span>
                    {paramTag && !applied && (
                      <span className="rounded bg-black/30 px-1.5 py-0.2 font-mono text-[9px] text-sky-100">
                        {paramTag}
                      </span>
                    )}
                  </button>
                  {canRevert && (
                    <button
                      type="button"
                      title="Hoàn tác thay đổi vừa áp dụng"
                      onClick={() => void onRevertAction(actionKey, act.label)}
                      className="inline-flex min-h-[26px] items-center gap-0.5 rounded-full border border-white/15 bg-white/10 px-2 py-1 text-[10px] text-slate-200 hover:bg-rose-500/30 hover:text-rose-100"
                    >
                      <Undo2 className="h-2.5 w-2.5" /> Hoàn tác
                    </button>
                  )}
                  {act.action === 'rearrange_chords' && (
                    <button
                      type="button"
                      title="Nghe thử hợp âm A/B trước khi áp dụng"
                      onClick={() => {
                        const syms = Array.isArray(act.payload?.chords)
                          ? (act.payload.chords as string[])
                          : ['Am', 'F', 'C', 'G'];
                        onAuditionChords(syms);
                      }}
                      className="inline-flex min-h-[26px] items-center gap-0.5 rounded-full border border-amber-400/40 bg-amber-500/15 px-2 py-1 text-[10px] text-amber-200 hover:bg-amber-500/30"
                    >
                      <Volume2 className="h-2.5 w-2.5" /> Nghe thử
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
