import React, { useEffect, useRef } from 'react';
import { MessageSquare, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import type {
  CoachAssistantMode,
  CoachMessage,
  CoachSuggestedAction,
  OneClickFix,
  OverdubFitCheckResponse,
} from '@/types/project';

const CHAT_MODES: Array<{
  id: CoachAssistantMode;
  label: string;
  desc: string;
  prompts: string[];
}> = [
  {
    id: 'producer',
    label: 'Producer',
    desc: 'Tổng quan & Cấu trúc',
    prompts: ['Góp ý cấu trúc bài', 'Tăng +8 BPM cho sôi động', 'Đặt mô-típ làm Chorus'],
  },
  {
    id: 'arrangement',
    label: 'Hòa âm',
    desc: 'Chords & Track MIDI',
    prompts: ['Đổi hợp âm cho buồn hơn', 'Tạo lại track Drums', 'Tạo lại track Bass'],
  },
  {
    id: 'lyricist',
    label: 'Viết lời',
    desc: 'Lyrics & Vần điệu',
    prompts: ['Gợi ý lời cho điệp khúc', 'Viết lại câu Chorus bắt tai'],
  },
  {
    id: 'mix',
    label: 'Mix / Tune',
    desc: 'EQ, FX & Auto-Tune',
    prompts: ['Cân bằng Mix chống vỡ tiếng', 'Bật Auto-Tune mức Vừa'],
  },
];

interface AiCoachChatDrawerProps {
  assistantMode: CoachAssistantMode;
  onModeChange: (mode: CoachAssistantMode) => void;
  messages: CoachMessage[];
  inputValue: string;
  loading: boolean;
  appliedActions: string[];
  applyingActionKey: string | null;
  fitCheck: OverdubFitCheckResponse | null;
  appliedFixIds: string[];
  onClose: () => void;
  onInputChange: (value: string) => void;
  onSend: (overrideText?: string) => void;
  onClearChat: () => void;
  onApplyAction: (msgIdx: number, act: CoachSuggestedAction) => void;
  onApplyFix: (fix: OneClickFix) => void;
}

export default function AiCoachChatDrawer({
  assistantMode,
  onModeChange,
  messages,
  inputValue,
  loading,
  appliedActions,
  applyingActionKey,
  fitCheck,
  appliedFixIds,
  onClose,
  onInputChange,
  onSend,
  onClearChat,
  onApplyAction,
  onApplyFix,
}: AiCoachChatDrawerProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeModeSpec = CHAT_MODES.find((m) => m.id === assistantMode) || CHAT_MODES[0];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, loading]);

  return (
    <aside className="flex w-80 shrink-0 flex-col rounded-lg border border-white/[0.08] bg-[#16191f] shadow-xl shadow-black/40">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.08] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-amber-400" />
          <div>
            <span className="block font-display text-xs font-bold text-white">
              AI Music Chatbot
            </span>
            <span className="block text-[10px] text-slate-400">{activeModeSpec.desc}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title="Xóa lịch sử chat"
            aria-label="Xóa lịch sử chat"
            onClick={onClearChat}
            className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Đóng AI Coach"
            onClick={onClose}
            className="rounded p-1 text-xs text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Assistant Persona Mode Switcher */}
      <div className="grid grid-cols-4 gap-1 border-b border-white/[0.08] bg-[#12141a] p-1.5">
        {CHAT_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onModeChange(m.id)}
            className={`rounded px-1.5 py-1 text-[10px] font-semibold transition ${
              assistantMode === m.id
                ? 'bg-amber-500 text-slate-950'
                : 'bg-white/[0.04] text-slate-300 hover:bg-white/10 hover:text-white'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Overdub Fit Check Banner (when present) */}
      {fitCheck && (
        <div className="space-y-2 border-b border-white/[0.08] bg-amber-500/10 p-3 text-xs">
          <p className="font-semibold text-amber-200">Kết quả Overdub Fit Check</p>
          <p className="text-slate-300">
            Lệch nhịp: <strong>{fitCheck.timing_offset_ms} ms</strong> • {fitCheck.gain_suggestion}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {fitCheck.one_click_fixes.map((fix) => {
              const applied = appliedFixIds.includes(fix.id);
              return (
                <button
                  key={fix.id}
                  type="button"
                  disabled={applied}
                  onClick={() => onApplyFix(fix)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium text-white ${
                    applied ? 'cursor-default bg-emerald-600/60' : 'bg-sky-600 hover:bg-sky-500'
                  }`}
                >
                  {applied ? `✓ ${fix.label}` : fix.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Conversation Feed */}
      <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto p-3 text-xs">
        {messages.map((m, idx) => (
          <div
            key={idx}
            className={`space-y-2 rounded-2xl p-2.5 leading-relaxed ${
              m.role === 'user'
                ? 'ml-6 border border-amber-500/25 bg-amber-500/15 text-amber-100'
                : 'mr-3 border border-white/[0.08] bg-[#1b1e25] text-slate-200'
            }`}
          >
            {m.role === 'assistant' && m.provider && (
              <div className="flex items-center justify-between text-[9px] font-bold uppercase tracking-wider text-slate-400">
                <span className="flex items-center gap-1 text-sky-300">
                  <Sparkles className="h-2.5 w-2.5" />
                  {m.provider}
                </span>
              </div>
            )}
            <p className="whitespace-pre-wrap">{m.content}</p>
            {m.role === 'assistant' && m.suggested_actions && m.suggested_actions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-t border-white/[0.07] pt-1.5">
                {m.suggested_actions.map((act) => {
                  const actionKey = `${idx}:${act.id}`;
                  const applied = appliedActions.includes(actionKey);
                  const busy = applyingActionKey === actionKey;
                  return (
                    <button
                      key={act.id}
                      type="button"
                      disabled={applied || busy}
                      onClick={() => onApplyAction(idx, act)}
                      className={`rounded-full px-2.5 py-1 text-[11px] font-medium text-white transition ${
                        applied
                          ? 'cursor-default bg-emerald-600/60'
                          : 'bg-sky-600 hover:bg-sky-500 disabled:opacity-50'
                      }`}
                    >
                      {busy ? 'Đang áp dụng...' : applied ? `✓ ${act.label}` : act.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="rounded-xl border border-white/10 bg-[#1b1e25] px-3 py-2 text-xs text-slate-400">
            AI Chatbot ({activeModeSpec.label}) đang phân tích dự án...
          </div>
        )}
      </div>

      {/* Mode Quick Prompt Chips + Input */}
      <div className="space-y-2 border-t border-white/[0.08] p-2.5">
        <div className="flex flex-wrap gap-1">
          {activeModeSpec.prompts.map((promptText) => (
            <button
              key={promptText}
              type="button"
              disabled={loading}
              onClick={() => onSend(promptText)}
              className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-300 transition hover:border-amber-400/50 hover:text-amber-200 disabled:opacity-40"
            >
              {promptText}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <input
            id="studio-coach-input"
            name="coachInput"
            aria-label="Hỏi AI Music Coach"
            type="text"
            value={inputValue}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSend();
            }}
            placeholder={`Hỏi chế độ ${activeModeSpec.label}...`}
            className="flex-1 rounded-full border border-white/15 bg-[#0b0d11] px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none"
          />
          <button
            type="button"
            aria-label="Gửi câu hỏi tới AI Coach"
            disabled={loading || !inputValue.trim()}
            onClick={() => onSend()}
            className="rounded-md bg-amber-500 px-3 py-1.5 text-black hover:bg-amber-400 disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
