import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Maximize2, Minimize2, RotateCcw, Sparkles, X } from 'lucide-react';
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
import CoachComposerBar from './coach/CoachComposerBar';
import CoachMessageBubble from './coach/CoachMessageBubble';

const CHAT_MODES: Array<{
  id: CoachAssistantMode;
  label: string;
  desc: string;
  prompts: string[];
}> = [
  {
    id: 'producer',
    label: 'Producer',
    desc: 'Toàn diện • Mix, Cấu trúc & Cloud',
    prompts: [
      'Phân tích & đề xuất mọi thứ cho bài này',
      'Đẩy năng lượng Chorus lên 95%',
      'Lưu Checkpoint hiện tại',
    ],
  },
  {
    id: 'arrangement',
    label: 'Hòa âm',
    desc: 'Chords, Nhịp & MIDI Tracks',
    prompts: [
      'Gợi ý vòng hợp âm hợp giọng bài này',
      'Chuyển sang nhịp 6/8',
      'Nạp điệu trống Trap',
    ],
  },
  {
    id: 'lyricist',
    label: 'Viết lời',
    desc: 'Lyrics, Hook & Vần điệu',
    prompts: [
      'Viết 4 câu lời Chorus về mưa đêm Sài Gòn',
      'Gợi ý lời cho đoạn Verse',
    ],
  },
  {
    id: 'mix',
    label: 'Mix / Tune',
    desc: 'EQ 3 băng, FX, Stems & LUFS',
    prompts: [
      'Vocal hơi chói và thiếu reverb',
      'Cân bằng Mix chống vỡ tiếng',
      'Đặt Mastering -9 LUFS',
    ],
  },
];

function getRouteQuickPrompts(pathname: string, modeSpec: (typeof CHAT_MODES)[number]): string[] {
  if (pathname === '/' || pathname.startsWith('/library')) {
    return [
      'AI làm được gì & Đề xuất mọi thứ',
      'Tạo beat Lo-fi nhẹ',
      'Mở Cộng đồng Demo (/share)',
    ];
  }
  if (pathname.startsWith('/create')) {
    return [
      'AI làm được gì & Đề xuất mọi thứ',
      'Làm sao thu Mic không bị ồn?',
      'Nên chọn Preserve hay Enhance?',
    ];
  }
  if (pathname.startsWith('/share') || pathname.startsWith('/creators')) {
    return [
      'Hướng dẫn Publish Master & Remix bài này',
      'Mở Phòng thu DAW',
      'Xem bảng xếp hạng Producer',
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
        '### Xin chào! Tôi là **AI Music Copilot v2**\n'
        + 'Tôi đọc trực tiếp **Mix/EQ**, **Hợp âm chuẩn điệu**, **Lời**, **Dynamics**, **Mastering LUFS** & **Overdub Fit Check** của bài hát này.\n'
        + '- Gõ tự nhiên *(VD: `"Chuyển tone sang Dm, 124 BPM"` hoặc `"Viết Chorus về mưa đêm"`)*\n'
        + '- Hoặc gõ `/` để mở danh sách lệnh nhanh — mọi thay đổi đều áp dụng & **Hoàn tác 1 chạm**!',
    };
  }
  return {
    role: 'assistant',
    content:
      '### Xin chào! Tôi là **AI Music Copilot v2**\n'
      + 'Tôi đồng hành xuyên suốt mọi màn hình: tạo Template ở Home, hướng dẫn thu Mic ở Wizard, quản lý Session/Cloud, chẩn đoán API Key ở Settings và hỗ trợ Producer Showcase.',
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
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [appliedMap, setAppliedMap] = useState<Record<string, boolean>>({});
  const [revertSnapshots, setRevertSnapshots] = useState<Record<string, ProjectState>>({});
  const [applyingKey, setApplyingKey] = useState<string | null>(null);
  const [wideMode, setWideMode] = useState(false);

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
    setStreamStatus(null);
    setAppliedMap({});
    setRevertSnapshots({});
    setActionNotice(null);
    setAttachedAudioFile(null);
    setAttachProjectVocal(false);
    const resetMsgs: CoachMessage[] = [
      {
        role: 'assistant',
        content:
          'Đã làm mới cuộc trò chuyện. Hãy chọn chế độ (Producer / Hòa âm / Viết lời / Mix) và gõ yêu cầu hoặc gõ `/` để chọn lệnh nhanh!',
      },
    ];
    setMessages(resetMsgs);
    void deleteChatThread(threadId).catch(() => { });
  };

  const handleStopStreaming = () => {
    abortRef.current?.abort();
    setLoading(false);
    setStreamStatus(null);
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

  const sendConversationTurn = async (text: string, baseMessages: CoachMessage[]) => {
    const userDisplay = attachedAudioFile
      ? `${text} [Đính kèm: ${attachedAudioFile.name}]`
      : attachProjectVocal
        ? `${text} [Kèm Vocal bài hiện tại]`
        : text;

    const nextHistory: CoachMessage[] = [
      ...baseMessages,
      { role: 'user', content: userDisplay, timestamp: new Date().toISOString() },
    ];
    setActionNotice(null);
    setLoading(true);
    setStreamStatus('Đang phân tích Mix, Hợp âm & Cấu trúc...');

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
          history: nextHistory.map(({ role, content, timestamp }) => ({ role, content, timestamp })),
          project_state: project,
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
          onStatus: (st) => {
            if (st.text) setStreamStatus(st.text);
          },
          onChunk: (delta) => {
            setStreamStatus(null);
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
            setStreamStatus(null);
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
      setStreamStatus(null);
      setLoading(false);
    }
  };

  const handleSend = async (overrideText?: string) => {
    const text = (overrideText ?? inputValue).trim();
    if (!text || loading) return;
    if (overrideText === undefined) setInputValue('');
    await sendConversationTurn(text, messages);
  };

  const handleRegenerateLast = () => {
    if (loading || messages.length < 2) return;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return;
    const rawUserContent = messages[lastUserIdx].content.replace(/\s*\[(?:Đính kèm|Kèm Vocal)[^\]]*\]$/, '').trim();
    const priorHistory = messages.slice(0, lastUserIdx);
    void sendConversationTurn(rawUserContent, priorHistory);
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

  const handleRevertAll = async (msgIdx: number, acts: CoachSuggestedAction[]) => {
    let earliestSnap: ProjectState | undefined;
    const nextApplied = { ...appliedMap };
    const nextSnaps = { ...revertSnapshots };
    for (const act of acts) {
      const key = `${msgIdx}:${act.id}`;
      if (!earliestSnap && nextSnaps[key]) {
        earliestSnap = nextSnaps[key];
      }
      nextApplied[key] = false;
      delete nextSnaps[key];
    }
    if (!earliestSnap) return;
    loadProjectIntoSession(earliestSnap, { dirty: true });
    await engine.syncFromProject(earliestSnap).catch(() => { });
    setAppliedMap(nextApplied);
    setRevertSnapshots(nextSnaps);
    setActionNotice('Đã hoàn tác toàn bộ thay đổi trong nhóm đề xuất.');
  };

  return (
    <aside
      aria-label="AI Music Copilot Drawer"
      className={`flex shrink-0 flex-col border-l border-white/10 bg-[#16191f] shadow-2xl shadow-black/50 transition-all ${
        wideMode ? 'w-96 xl:w-[28rem]' : 'w-80 xl:w-88'
      }`}
    >
      <input
        ref={fileInputRef}
        id="studio-coach-audio-file"
        type="file"
        aria-label="Chọn tệp Audio để đính kèm"
        accept=".wav,.mp3,.m4a,.ogg,.flac,audio/*"
        className="sr-only"
        onChange={handleAttachFile}
      />

      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-amber-400" />
          <div className="min-w-0">
            <span className="block truncate font-display text-xs font-bold text-white">
              AI Music Copilot
            </span>
            <span className="block truncate text-[10px] text-slate-300">
              {isStudioRoute ? activeModeSpec.desc : `Hỗ trợ trang ${pathname}`}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title={wideMode ? 'Thu gọn khung chat' : 'Mở rộng khung chat'}
            aria-label={wideMode ? 'Thu gọn khung chat' : 'Mở rộng khung chat'}
            onClick={() => setWideMode((w) => !w)}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-300 hover:bg-white/10 hover:text-white"
          >
            {wideMode ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            title="Xóa lịch sử chat"
            aria-label="Xóa lịch sử chat"
            onClick={handleClearChat}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-300 hover:bg-white/10 hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Đóng AI Coach"
            onClick={() => setCopilotOpen(false)}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-300 hover:bg-white/10 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Live Project Context Strip */}
      <div className="flex flex-wrap items-center gap-1 border-b border-white/[0.06] bg-[#101319] px-3 py-1.5 font-mono text-[10px] text-slate-300">
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-amber-300">
          {project.config.genre}
        </span>
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-sky-200">
          {project.analysis.detected_key} {project.analysis.detected_scale}
        </span>
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5">
          {Math.round(project.analysis.bpm)} BPM
        </span>
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-emerald-300">
          {project.mastering.target_lufs} LUFS
        </span>
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5">
          {project.lyrics.lines.length} câu lời
        </span>
      </div>

      {/* Assistant Persona Mode Switcher */}
      <div className="grid grid-cols-4 gap-1 border-b border-white/[0.08] bg-[#12141a] p-1.5">
        {CHAT_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setAssistantMode(m.id)}
            className={`min-h-[24px] rounded px-1.5 py-1 text-[10px] font-semibold transition ${
              assistantMode === m.id
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
          <p className="text-slate-200">
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
                  className={`min-h-[24px] rounded-full px-2.5 py-1 text-[11px] font-medium text-white ${
                    applied ? 'cursor-default bg-emerald-700/80' : 'bg-sky-600 hover:bg-sky-500'
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
            aria-label="Đóng thông báo"
            onClick={() => setActionNotice(null)}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-emerald-200 hover:text-white"
          >
            ×
          </button>
        </div>
      )}

      {/* Conversation Feed */}
      <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto p-3 text-xs">
        {messages.map((m, idx) => (
          <CoachMessageBubble
            key={idx}
            message={m}
            index={idx}
            isLast={idx === messages.length - 1}
            loading={loading}
            statusText={idx === messages.length - 1 ? streamStatus : null}
            appliedMap={appliedMap}
            revertSnapshots={revertSnapshots}
            applyingKey={applyingKey}
            onApplyAction={handleApplyAction}
            onApplyAll={handleApplyAll}
            onRevertAction={handleRevertAction}
            onRevertAll={handleRevertAll}
            onAuditionChords={(syms) => engine.auditionChordProgression(syms)}
            onRegenerate={handleRegenerateLast}
          />
        ))}
      </div>

      {/* Footer: Slash Menu + Quick Prompts + Multimodal Composer */}
      <CoachComposerBar
        inputValue={inputValue}
        onChangeInput={setInputValue}
        onSend={handleSend}
        onStop={handleStopStreaming}
        loading={loading}
        quickPrompts={quickPrompts}
        attachedAudioFile={attachedAudioFile}
        onClearAttachedFile={() => setAttachedAudioFile(null)}
        onAttachClick={() => fileInputRef.current?.click()}
        hasProjectVocal={hasProjectVocal}
        attachProjectVocal={attachProjectVocal}
        onToggleAttachProjectVocal={() => setAttachProjectVocal((v) => !v)}
        isListeningVoice={isListeningVoice}
        onToggleVoice={handleVoiceToggle}
        placeholder={isStudioRoute ? `Hỏi ${activeModeSpec.label}...` : 'Hỏi bất kỳ điều gì...'}
      />
    </aside>
  );
}
