import React, { useMemo, useRef } from 'react';
import { Mic, MicOff, Paperclip, Send, Square, Volume2 } from 'lucide-react';

const SLASH_COMMANDS: Array<{ cmd: string; template: string; desc: string }> = [
  { cmd: '/audit', template: 'Phân tích & đánh giá toàn bộ bài này giúp tôi', desc: 'Chẩn đoán Mix, EQ, Hợp âm & Cấu trúc' },
  { cmd: '/mix', template: 'Vocal hơi chói và thiếu reverb, hãy cân bằng Mix', desc: 'Chỉnh EQ, FX & Auto-Mix -1.0 dBFS' },
  { cmd: '/bpm', template: 'Chuyển tốc độ lên 124 BPM', desc: 'Đổi BPM chính xác (40-220)' },
  { cmd: '/key', template: 'Đổi giọng sang Dm', desc: 'Đổi Tone/Scale (VD: Am, Dm, C major)' },
  { cmd: '/chords', template: 'Gợi ý vòng hợp âm buồn phù hợp giọng bài này', desc: 'Hợp âm chuẩn điệu + Nghe thử A/B' },
  { cmd: '/lyrics', template: 'Viết 4 câu lời Chorus về mưa đêm Sài Gòn', desc: 'Sáng tác & ghi thẳng vào Lyrics' },
  { cmd: '/bridge', template: 'Thêm đoạn Bridge và đẩy năng lượng Chorus lên 95%', desc: 'Mở rộng cấu trúc & Dynamics' },
  { cmd: '/autotune', template: 'Bật Auto-Tune mức Vừa theo giọng bài hát', desc: 'Auto-Tune Pro giữ Formant' },
  { cmd: '/stem', template: 'Tách stem vocal và beat', desc: 'Tách 2 clip Vocal/Beat HPSS' },
  { cmd: '/checkpoint', template: 'Lưu checkpoint phiên bản hiện tại', desc: 'Tạo mốc Version khôi phục an toàn' },
  { cmd: '/publish', template: 'Mở bảng Publish demo và chia sẻ bài hát', desc: 'Master & phát hành /share/:slug' },
  { cmd: '/export', template: 'Xuất file MP3 320kbps', desc: 'Xuất WAV / MP3 / Stems / MIDI' },
];

interface CoachComposerBarProps {
  inputValue: string;
  onChangeInput: (val: string) => void;
  onSend: (overrideText?: string) => Promise<void>;
  onStop: () => void;
  loading: boolean;
  quickPrompts: string[];
  attachedAudioFile: File | null;
  onClearAttachedFile: () => void;
  onAttachClick: () => void;
  hasProjectVocal: boolean;
  attachProjectVocal: boolean;
  onToggleAttachProjectVocal: () => void;
  isListeningVoice: boolean;
  onToggleVoice: () => Promise<void>;
  placeholder: string;
}

export default function CoachComposerBar({
  inputValue,
  onChangeInput,
  onSend,
  onStop,
  loading,
  quickPrompts,
  attachedAudioFile,
  onClearAttachedFile,
  onAttachClick,
  hasProjectVocal,
  attachProjectVocal,
  onToggleAttachProjectVocal,
  isListeningVoice,
  onToggleVoice,
  placeholder,
}: CoachComposerBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const slashMatches = useMemo(() => {
    const trimmed = inputValue.trimStart().toLowerCase();
    if (!trimmed.startsWith('/')) return [];
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(trimmed) || c.desc.toLowerCase().includes(trimmed.slice(1))).slice(0, 6);
  }, [inputValue]);

  const adjustHeight = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(112, Math.max(36, el.scrollHeight))}px`;
  };

  const handleSelectSlash = (template: string) => {
    onChangeInput(template);
    window.requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        adjustHeight(textareaRef.current);
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (slashMatches.length > 0 && inputValue.trim().startsWith('/') && !inputValue.trim().includes(' ')) {
        handleSelectSlash(slashMatches[0].template);
        return;
      }
      if (!loading && inputValue.trim()) {
        void onSend();
      }
    } else if (e.key === 'Tab' && slashMatches.length > 0) {
      e.preventDefault();
      handleSelectSlash(slashMatches[0].template);
    }
  };

  return (
    <div className="relative space-y-2 border-t border-white/[0.08] p-2.5">
      {slashMatches.length > 0 && (
        <div
          role="listbox"
          aria-label="Lệnh nhanh Copilot"
          className="absolute bottom-full left-2.5 right-2.5 z-20 mb-1 max-h-52 overflow-y-auto rounded-xl border border-amber-400/30 bg-[#12151c] p-1 shadow-2xl"
        >
          {slashMatches.map((item) => (
            <button
              key={item.cmd}
              type="button"
              onClick={() => handleSelectSlash(item.template)}
              className="flex min-h-[28px] w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1 text-left text-[11px] hover:bg-amber-500/15"
            >
              <span className="font-mono font-bold text-amber-300">{item.cmd}</span>
              <span className="truncate text-slate-300">{item.desc}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1">
        {quickPrompts.map((promptText) => (
          <button
            key={promptText}
            type="button"
            disabled={loading}
            onClick={() => void onSend(promptText)}
            className="min-h-[24px] rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[10px] text-slate-200 transition hover:border-amber-400/50 hover:text-amber-200 disabled:opacity-40"
          >
            {promptText}
          </button>
        ))}
      </div>

      {(attachedAudioFile || hasProjectVocal) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          {attachedAudioFile ? (
            <span className="inline-flex min-h-[24px] items-center gap-1 rounded bg-cyan-500/20 px-2 py-0.5 text-cyan-200">
              <Volume2 className="h-3 w-3" /> {attachedAudioFile.name}
              <button
                type="button"
                aria-label="Gỡ file audio đính kèm"
                onClick={onClearAttachedFile}
                className="ml-1 inline-flex min-h-[24px] min-w-[24px] items-center justify-center font-bold hover:text-white"
              >
                ×
              </button>
            </span>
          ) : (
            hasProjectVocal && (
              <button
                type="button"
                onClick={onToggleAttachProjectVocal}
                className={`inline-flex min-h-[24px] items-center gap-1 rounded border px-2 py-0.5 transition ${
                  attachProjectVocal
                    ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200'
                    : 'border-white/15 bg-white/[0.04] text-slate-200 hover:border-emerald-400/40'
                }`}
              >
                <Volume2 className="h-3 w-3" />
                <span>{attachProjectVocal ? '✓ Kèm Vocal để AI nghe' : 'Gửi kèm Vocal để AI nghe'}</span>
              </button>
            )
          )}
        </div>
      )}

      <div className="flex items-end gap-1.5">
        <button
          type="button"
          title="Đính kèm đoạn Audio (<= 10MB) để AI nghe & phân tích"
          aria-label="Đính kèm Audio cho AI"
          onClick={onAttachClick}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/15 bg-[#1b1e25] text-slate-200 hover:border-cyan-400/50 hover:text-cyan-200"
        >
          <Paperclip className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={isListeningVoice ? 'Dừng nói / thu âm' : 'Nói câu hỏi bằng giọng nói (Mic)'}
          aria-label="Nhập câu hỏi bằng giọng nói"
          onClick={() => void onToggleVoice()}
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition ${
            isListeningVoice
              ? 'animate-pulse border-rose-400 bg-rose-500/25 text-rose-200'
              : 'border-white/15 bg-[#1b1e25] text-slate-200 hover:border-amber-400/50 hover:text-amber-200'
          }`}
        >
          {isListeningVoice ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
        </button>
        <textarea
          ref={textareaRef}
          id="studio-coach-input"
          name="coachInput"
          aria-label="Hỏi AI Music Coach"
          rows={1}
          value={inputValue}
          onChange={(e) => {
            onChangeInput(e.target.value);
            adjustHeight(e.target);
          }}
          onKeyDown={handleKeyDown}
          placeholder={`${placeholder} (gõ / xem lệnh nhanh)`}
          className="min-h-[36px] max-h-28 min-w-0 flex-1 resize-none rounded-xl border border-white/15 bg-[#0b0d11] px-3 py-1.5 text-xs text-white placeholder-slate-400 focus:border-amber-400 focus:outline-none"
        />
        {loading ? (
          <button
            type="button"
            aria-label="Dừng tạo phản hồi AI"
            title="Dừng tạo phản hồi"
            onClick={onStop}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-500 text-white hover:bg-rose-400"
          >
            <Square className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Gửi câu hỏi tới AI Coach"
            disabled={!inputValue.trim()}
            onClick={() => void onSend()}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500 text-slate-950 hover:bg-amber-400 disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
