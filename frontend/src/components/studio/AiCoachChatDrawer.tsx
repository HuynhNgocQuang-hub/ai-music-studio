import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  CheckCheck,
  Mic,
  MicOff,
  Paperclip,
  RotateCcw,
  Send,
  Sparkles,
  Undo2,
  Volume2,
  X,
} from 'lucide-react';
import {
  ApiError,
  chatWithCoachAudio,
  streamCoachChat,
  validateAudioFileClient,
} from '@/lib/api/client';
import { encodeBlobToWav, getAudioEngine } from '@/lib/audio/player';
import { deleteChatThread, getChatThread, saveChatThread } from '@/lib/storage/indexeddb';
import { useProjectSession } from '@/components/providers/ProjectProvider';
import type {
  CoachAssistantMode,
  CoachMessage,
  CoachSuggestedAction,
  ProjectState,
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
      desc: 'Toàn diện • Cấu trúc & Vận hành',
      prompts: [
        'AI làm được gì & Đề xuất mọi thứ',
        'Đẩy năng lượng Chorus lên 95%',
        'Xuất file MP3 320kbps',
      ],
    },
    {
      id: 'arrangement',
      label: 'Hòa âm',
      desc: 'Chords, Nhịp & MIDI Tracks',
      prompts: ['Đổi hợp âm vi - IV - I - V', 'Chuyển sang nhịp 6/8', 'Tạo lại track Drums'],
    },
    {
      id: 'lyricist',
      label: 'Viết lời',
      desc: 'Lyrics, Hook & Vần điệu',
      prompts: ['Gợi ý lời cho điệp khúc', 'Viết lại câu Chorus bắt tai'],
    },
    {
      id: 'mix',
      label: 'Mix / Tune',
      desc: 'EQ 3 băng, FX & Auto-Tune',
      prompts: ['Vocal hơi chói và khô', 'Cân bằng Mix chống vỡ tiếng', 'Bật Auto-Tune mức Vừa'],
    },
  ];

function getRouteQuickPrompts(pathname: string, modeSpec: (typeof CHAT_MODES)[number]): string[] {
  if (pathname === '/' || pathname.startsWith('/library')) {
    return [
      'AI làm được gì & Đề xuất mọi thứ',
      'Tạo beat Lo-fi nhẹ',
      'Tạo beat Trap / 808',
    ];
  }
  if (pathname.startsWith('/create')) {
    return [
      'AI làm được gì & Đề xuất mọi thứ',
      'Làm sao thu Mic không bị ồn?',
      'Nên chọn Preserve hay Enhance?',
    ];
  }
  if (pathname.startsWith('/settings')) {
    return ['Kiểm tra API Key & Hệ thống', 'Lỗi Gemini 404 hoặc 503 là gì?', 'Vào Studio DAW'];
  }
  return modeSpec.prompts;
}

function getDefaultGreeting(pathname: string): CoachMessage {
  if (pathname.startsWith('/studio')) {
    return {
      role: 'assistant',
      content:
        'Xin chào! Tôi là AI Music Copilot đa chế độ. Tôi đọc được toàn bộ Mix/EQ, Hợp âm, Lời, Dynamics & Overdub Fit Check của bài này — bạn có thể gõ, nói bằng Mic hoặc đính kèm đoạn Audio để tôi phân tích & áp dụng 1 chạm!',
    };
  }
  return {
    role: 'assistant',
    content:
      'Xin chào! Tôi là AI Music Copilot toàn hệ thống. Dù bạn đang chọn Template, thu Mic ở Wizard, quản lý Session hay chẩn đoán API Key ở Settings, hãy hỏi hoặc ra lệnh bất kỳ!',
  };
}

export default function AiCoachChatDrawer() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const engine = useMemo(() => getAudioEngine(), []);
  const {
    project,
    loadProjectIntoSession,
    copilotOpen,
    setCopilotOpen,
    latestFitCheck,
    studioUiMeta,
    executeGlobalCoachAction,
  } = useProjectSession();

  const isStudioRoute = pathname.startsWith('/studio');
  const threadId = isStudioRoute ? `studio:${project.project_id}` : 'workspace:global';

  const [assistantMode, setAssistantMode] = useState<CoachAssistantMode>('producer');
  const [messages, setMessages] = useState<CoachMessage[]>(() => [getDefaultGreeting(pathname)]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [appliedMap, setAppliedMap] = useState<Record<string, boolean>>({});
  const [revertSnapshots, setRevertSnapshots] = useState<Record<string, ProjectState>>({});
  const [applyingKey, setApplyingKey] = useState<string | null>(null);

  // Multimodal Audio / Voice Dictation state
  const [attachedAudioFile, setAttachedAudioFile] = useState<File | null>(null);
  const [attachProjectVocal, setAttachProjectVocal] = useState(false);
  const [isListeningVoice, setIsListeningVoice] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const loadedThreadRef = useRef<string | null>(null);

  const activeModeSpec = CHAT_MODES.find((m) => m.id === assistantMode) || CHAT_MODES[0];
  const quickPrompts = useMemo(
    () => getRouteQuickPrompts(pathname, activeModeSpec),
    [pathname, activeModeSpec]
  );
  const hasProjectVocal = Boolean(
    project.audio_assets.tuned_vocal_ref ||
    project.audio_assets.dry_denoised_ref ||
    project.audio_assets.raw_input_ref
  );

  // Load saved chat thread from IndexedDB when switching projects / global scope
  useEffect(() => {
    let active = true;
    loadedThreadRef.current = null;
    void (async () => {
      try {
        const stored = await getChatThread(threadId);
        if (!active) return;
        if (stored && stored.messages.length > 0) {
          setMessages(stored.messages);
          setAssistantMode(stored.mode || 'producer');
        } else {
          setMessages([getDefaultGreeting(pathname)]);
        }
        setAppliedMap({});
        setRevertSnapshots({});
        loadedThreadRef.current = threadId;
      } catch {
        if (active) {
          setMessages([getDefaultGreeting(pathname)]);
          loadedThreadRef.current = threadId;
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [threadId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist messages smoothly once thread hydration completed
  useEffect(() => {
    if (loadedThreadRef.current !== threadId || loading) return;
    void saveChatThread(threadId, assistantMode, messages).catch(() => { });
  }, [messages, assistantMode, threadId, loading]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, loading]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      recognitionRef.current?.stop();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  if (!copilotOpen) return null;

  const handleClearChat = () => {
    abortRef.current?.abort();
    setLoading(false);
    setAppliedMap({});
    setRevertSnapshots({});
    setActionNotice(null);
    setAttachedAudioFile(null);
    setAttachProjectVocal(false);
    const resetMsgs: CoachMessage[] = [
      {
        role: 'assistant',
        content:
          'Đã làm mới cuộc trò chuyện. Hãy chọn chế độ (Producer / Hòa âm / Viết lời / Mix) và đặt câu hỏi hoặc ra lệnh bất kỳ!',
      },
    ];
    setMessages(resetMsgs);
    void deleteChatThread(threadId).catch(() => { });
  };

  const handleVoiceToggle = async () => {
    if (isListeningVoice) {
      recognitionRef.current?.stop();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setIsListeningVoice(false);
      return;
    }

    const win = window as unknown as {
      SpeechRecognition?: new () => {
        lang: string;
        interimResults: boolean;
        maxAlternatives: number;
        onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
        onerror: (() => void) | null;
        onend: (() => void) | null;
        start: () => void;
        stop: () => void;
      };
      webkitSpeechRecognition?: new () => {
        lang: string;
        interimResults: boolean;
        maxAlternatives: number;
        onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
        onerror: (() => void) | null;
        onend: (() => void) | null;
        start: () => void;
        stop: () => void;
      };
    };

    const RecognitionCtor = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (RecognitionCtor) {
      try {
        const rec = new RecognitionCtor();
        rec.lang = 'vi-VN';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        rec.onresult = (e) => {
          const text = e.results?.[0]?.[0]?.transcript?.trim();
          if (text) {
            setInputValue((prev) => (prev ? `${prev} ${text}` : text));
          }
        };
        rec.onerror = () => setIsListeningVoice(false);
        rec.onend = () => setIsListeningVoice(false);
        recognitionRef.current = rec;
        setIsListeningVoice(true);
        rec.start();
        return;
      } catch {
        setIsListeningVoice(false);
      }
    }

    // Fallback: record short audio snippet and attach for Multimodal Chat analysis
    if (!navigator.mediaDevices?.getUserMedia) {
      setActionNotice('Trình duyệt không hỗ trợ Mic hoặc Web Speech API.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setIsListeningVoice(false);
        try {
          const wavBlob = await encodeBlobToWav(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
          const file = new File([wavBlob], `voice_note_${Date.now()}.wav`, { type: 'audio/wav' });
          setAttachedAudioFile(file);
          setInputValue((prev) => prev || 'Hãy nghe đoạn giọng/giai điệu vừa thu và nhận xét giúp tôi.');
        } catch {
          setActionNotice('Không thể mã hóa đoạn thu âm.');
        }
      };
      mediaRecorderRef.current = rec;
      setIsListeningVoice(true);
      setActionNotice('Đang thu âm đính kèm vào Chat (bấm lại biểu tượng Mic để dừng)...');
      rec.start();
    } catch {
      setActionNotice('Không truy cập được Microphone.');
    }
  };

  const handleAttachFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setActionNotice('Audio đính kèm vào Chat tối đa 10 MB.');
      return;
    }
    const err = validateAudioFileClient(file);
    if (err) {
      setActionNotice(err);
      return;
    }
    setAttachedAudioFile(file);
    setAttachProjectVocal(false);
  };

  const handleSend = async (overrideText?: string) => {
    const text = (overrideText ?? inputValue).trim();
    if (!text || loading) return;

    const userDisplay = attachedAudioFile
      ? `${text} [Đính kèm: ${attachedAudioFile.name}]`
      : attachProjectVocal
        ? `${text} [Kèm Vocal bài hiện tại]`
        : text;

    const nextHistory: CoachMessage[] = [
      ...messages,
      { role: 'user', content: userDisplay, timestamp: new Date().toISOString() },
    ];
    if (overrideText === undefined) setInputValue('');
    setActionNotice(null);
    setLoading(true);

    // Append placeholder assistant bubble for live SSE token streaming
    setMessages([...nextHistory, { role: 'assistant', content: '' }]);
    const assistantIndex = nextHistory.length;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      if (attachedAudioFile) {
        const res = await chatWithCoachAudio({
          project_id: project.project_id,
          message: text,
          mode: assistantMode,
          route: pathname,
          file: attachedAudioFile,
          filename: attachedAudioFile.name,
        });
        setAttachedAudioFile(null);
        setMessages((prev) =>
          prev.map((m, i) =>
            i === assistantIndex
              ? {
                ...m,
                content: res.reply,
                provider: res.provider,
                timestamp: new Date().toISOString(),
                suggested_actions: res.suggested_actions,
              }
              : m
          )
        );
        return;
      }

      await streamCoachChat(
        {
          project_id: project.project_id,
          message: text,
          mode: assistantMode,
          route: pathname,
          context: {
            studio_mode: studioUiMeta.studioMode,
            active_tab: studioUiMeta.activeTab,
            fit_check: latestFitCheck,
            attach_project_audio: attachProjectVocal,
          },
          project_state: project,
          history: nextHistory,
        },
        {
          signal: controller.signal,
          onChunk: (delta) => {
            setMessages((prev) =>
              prev.map((m, i) =>
                i === assistantIndex ? { ...m, content: `${m.content}${delta}` } : m
              )
            );
          },
          onActions: ({ provider, suggested_actions }) => {
            setMessages((prev) =>
              prev.map((m, i) =>
                i === assistantIndex ? { ...m, provider, suggested_actions } : m
              )
            );
          },
          onDone: (res) => {
            setMessages((prev) =>
              prev.map((m, i) =>
                i === assistantIndex
                  ? {
                    role: 'assistant',
                    content: res.reply || m.content,
                    provider: res.provider || m.provider,
                    timestamp: new Date().toISOString(),
                    suggested_actions: res.suggested_actions ?? m.suggested_actions,
                  }
                  : m
              )
            );
          },
        }
      );
      setAttachProjectVocal(false);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      const errText =
        err instanceof ApiError ? `Lỗi: ${err.detail}` : 'AI Copilot hiện không phản hồi.';
      setMessages((prev) =>
        prev.map((m, i) => (i === assistantIndex ? { role: 'assistant', content: errText } : m))
      );
    } finally {
      setLoading(false);
    }
  };

  const handleApplyAction = async (msgIdx: number, act: CoachSuggestedAction) => {
    const key = `${msgIdx}:${act.id}`;
    if (appliedMap[key]) return;
    setApplyingKey(key);
    try {
      const res = await executeGlobalCoachAction(act, navigate);
      setAppliedMap((prev) => ({ ...prev, [key]: true }));
      if (res.snapshot) {
        setRevertSnapshots((prev) => ({ ...prev, [key]: res.snapshot as ProjectState }));
      }
      setActionNotice(res.notice);
    } catch (err) {
      setActionNotice(err instanceof ApiError ? err.detail : `Lỗi áp dụng: ${act.label}`);
    } finally {
      setApplyingKey(null);
    }
  };

  const handleApplyAll = async (msgIdx: number, acts: CoachSuggestedAction[]) => {
    for (const act of acts) {
      const key = `${msgIdx}:${act.id}`;
      if (!appliedMap[key]) {
        await handleApplyAction(msgIdx, act);
      }
    }
  };

  const handleRevertAction = async (key: string, label: string) => {
    const snap = revertSnapshots[key];
    if (!snap) return;
    loadProjectIntoSession(snap, { dirty: true });
    await engine.syncFromProject(snap).catch(() => { });
    setAppliedMap((prev) => ({ ...prev, [key]: false }));
    setRevertSnapshots((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setActionNotice(`Đã hoàn tác đề xuất: ${label}`);
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-white/10 bg-[#16191f] shadow-2xl shadow-black/50 xl:w-88">
      <input
        ref={fileInputRef}
        type="file"
        accept=".wav,.mp3,.m4a,.ogg,.flac,audio/*"
        className="sr-only"
        onChange={handleAttachFile}
      />

      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.08] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-400" />
          <div>
            <span className="block font-display text-xs font-bold text-white">
              AI Music Copilot
            </span>
            <span className="block text-[10px] text-slate-400">
              {isStudioRoute ? activeModeSpec.desc : `Hỗ trợ trang ${pathname}`}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="Xóa lịch sử chat"
            aria-label="Xóa lịch sử chat"
            onClick={handleClearChat}
            className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Đóng AI Coach"
            onClick={() => setCopilotOpen(false)}
            className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
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
            onClick={() => setAssistantMode(m.id)}
            className={`rounded px-1.5 py-1 text-[10px] font-semibold transition ${assistantMode === m.id
              ? 'bg-amber-500 text-slate-950'
              : 'bg-white/[0.04] text-slate-300 hover:bg-white/10 hover:text-white'
              }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Overdub Fit Check Banner */}
      {latestFitCheck && isStudioRoute && (
        <div className="space-y-2 border-b border-white/[0.08] bg-amber-500/10 p-3 text-xs">
          <p className="font-semibold text-amber-200">Kết quả Overdub Fit Check</p>
          <p className="text-slate-300">
            Lệch nhịp: <strong>{latestFitCheck.timing_offset_ms} ms</strong> •{' '}
            {latestFitCheck.gain_suggestion}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {latestFitCheck.one_click_fixes.map((fix) => {
              const key = `fit:${fix.id}`;
              const applied = Boolean(appliedMap[key]);
              return (
                <button
                  key={fix.id}
                  type="button"
                  disabled={applied}
                  onClick={() =>
                    void handleApplyAction(-1, {
                      id: fix.id,
                      label: fix.label,
                      action: 'apply_fit_fix',
                      payload: { fix },
                    })
                  }
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium text-white ${applied ? 'cursor-default bg-emerald-600/60' : 'bg-sky-600 hover:bg-sky-500'
                    }`}
                >
                  {applied ? `✓ ${fix.label}` : fix.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Notice Banner inside Drawer */}
      {actionNotice && (
        <div className="flex items-center justify-between gap-2 border-b border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-200">
          <span className="truncate">{actionNotice}</span>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            className="text-emerald-300 hover:text-white"
          >
            ×
          </button>
        </div>
      )}

      {/* Conversation Feed */}
      <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto p-3 text-xs">
        {messages.map((m, idx) => {
          const actions = m.suggested_actions || [];
          const hasMultipleUnapplied =
            actions.filter((a) => !appliedMap[`${idx}:${a.id}`]).length >= 2;
          return (
            <div
              key={idx}
              className={`space-y-2 rounded-2xl p-2.5 leading-relaxed ${m.role === 'user'
                ? 'ml-6 border border-amber-500/25 bg-amber-500/15 text-amber-100'
                : 'mr-2 border border-white/[0.08] bg-[#1b1e25] text-slate-200'
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

              <p className="whitespace-pre-wrap">
                {m.content || (loading && idx === messages.length - 1 ? 'Đang suy nghĩ...' : '')}
              </p>

              {m.role === 'assistant' && actions.length > 0 && (
                <div className="space-y-1.5 border-t border-white/[0.07] pt-1.5">
                  {hasMultipleUnapplied && (
                    <button
                      type="button"
                      onClick={() => void handleApplyAll(idx, actions)}
                      className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-200 hover:bg-amber-500/35"
                    >
                      <CheckCheck className="h-3 w-3" /> Áp dụng tất cả
                    </button>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {actions.map((act) => {
                      const actionKey = `${idx}:${act.id}`;
                      const applied = Boolean(appliedMap[actionKey]);
                      const busy = applyingKey === actionKey;
                      const canRevert = applied && Boolean(revertSnapshots[actionKey]);
                      return (
                        <div key={act.id} className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            disabled={applied || busy}
                            onClick={() => void handleApplyAction(idx, act)}
                            className={`rounded-full px-2.5 py-1 text-[11px] font-medium text-white transition ${applied
                              ? 'cursor-default bg-emerald-600/60'
                              : 'bg-sky-600 hover:bg-sky-500 disabled:opacity-50'
                              }`}
                          >
                            {busy ? 'Đang xử lý...' : applied ? `✓ ${act.label}` : act.label}
                          </button>
                          {canRevert && (
                            <button
                              type="button"
                              title="Hoàn tác thay đổi vừa áp dụng"
                              onClick={() => void handleRevertAction(actionKey, act.label)}
                              className="inline-flex items-center gap-0.5 rounded-full border border-white/15 bg-white/10 px-2 py-1 text-[10px] text-slate-200 hover:bg-rose-500/30 hover:text-rose-200"
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
                                engine.auditionChordProgression(syms);
                              }}
                              className="inline-flex items-center gap-0.5 rounded-full border border-amber-400/40 bg-amber-500/15 px-2 py-1 text-[10px] text-amber-200 hover:bg-amber-500/30"
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
        })}
      </div>

      {/* Footer: Quick Prompts + Audio Attachment + Voice Mic + Input */}
      <div className="space-y-2 border-t border-white/[0.08] p-2.5">
        <div className="flex flex-wrap gap-1">
          {quickPrompts.map((promptText) => (
            <button
              key={promptText}
              type="button"
              disabled={loading}
              onClick={() => void handleSend(promptText)}
              className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-300 transition hover:border-amber-400/50 hover:text-amber-200 disabled:opacity-40"
            >
              {promptText}
            </button>
          ))}
        </div>

        {(attachedAudioFile || hasProjectVocal) && (
          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            {attachedAudioFile ? (
              <span className="inline-flex items-center gap-1 rounded bg-cyan-500/20 px-2 py-0.5 text-cyan-200">
                <Volume2 className="h-3 w-3" /> {attachedAudioFile.name}
                <button
                  type="button"
                  onClick={() => setAttachedAudioFile(null)}
                  className="ml-1 font-bold hover:text-white"
                >
                  ×
                </button>
              </span>
            ) : (
              hasProjectVocal && (
                <button
                  type="button"
                  onClick={() => setAttachProjectVocal((v) => !v)}
                  className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 transition ${attachProjectVocal
                    ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200'
                    : 'border-white/15 bg-white/[0.04] text-slate-300 hover:border-emerald-400/40'
                    }`}
                >
                  <Volume2 className="h-3 w-3" />
                  <span>{attachProjectVocal ? '✓ Kèm Vocal để AI nghe' : 'Gửi kèm Vocal để AI nghe'}</span>
                </button>
              )
            )}
          </div>
        )}

        <div className="flex items-center gap-1">
          <button
            type="button"
            title="Đính kèm đoạn Audio (<= 10MB) để AI nghe & phân tích"
            aria-label="Đính kèm Audio cho AI"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-md border border-white/15 bg-[#1b1e25] p-1.5 text-slate-300 hover:border-cyan-400/50 hover:text-cyan-200"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={isListeningVoice ? 'Dừng nói / thu âm' : 'Nói câu hỏi bằng giọng nói (Mic)'}
            aria-label="Nhập câu hỏi bằng giọng nói"
            onClick={() => void handleVoiceToggle()}
            className={`rounded-md border p-1.5 transition ${isListeningVoice
              ? 'animate-pulse border-rose-400 bg-rose-500/25 text-rose-200'
              : 'border-white/15 bg-[#1b1e25] text-slate-300 hover:border-amber-400/50 hover:text-amber-200'
              }`}
          >
            {isListeningVoice ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          </button>
          <input
            id="studio-coach-input"
            name="coachInput"
            aria-label="Hỏi AI Music Coach"
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSend();
            }}
            placeholder={isStudioRoute ? `Hỏi ${activeModeSpec.label}...` : 'Hỏi bất kỳ điều gì...'}
            className="min-w-0 flex-1 rounded-full border border-white/15 bg-[#0b0d11] px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none"
          />
          <button
            type="button"
            aria-label="Gửi câu hỏi tới AI Coach"
            disabled={loading || !inputValue.trim()}
            onClick={() => void handleSend()}
            className="rounded-md bg-amber-500 px-2.5 py-1.5 text-black hover:bg-amber-400 disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
