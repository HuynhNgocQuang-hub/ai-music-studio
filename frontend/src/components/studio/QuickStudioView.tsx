import { Download, Save, Sliders, Wand2, XCircle } from 'lucide-react';
import { TrackArtwork } from '@/components/shared/TrackArtwork';
import WaveformClipCanvas from '@/components/studio/WaveformClipCanvas';
import type { TransportSnapshot, VocalABMode } from '@/lib/audio/player';
import { GENRES, MOODS } from '@/lib/music/presets';
import type { MelodyMode, OutputMode, ProjectState } from '@/types/project';

interface QuickStudioViewProps {
  project: ProjectState;
  transport: TransportSnapshot;
  waveformPeaks: number[] | null;
  regenFullBusy: boolean;
  regenProgress: number;
  onSwitchToPro: () => void;
  onSetABMode: (mode: VocalABMode) => void;
  onSeek: (sec: number) => void;
  onMutateWithUndo: (updater: (prev: ProjectState) => ProjectState) => void;
  onRegenerateFullSong: () => void;
  onCancelRegenJob: () => void;
  onExport: (format: 'wav' | 'mp3', bitrate?: '192k' | '320k') => void;
  onSaveAimusic: () => void;
}

export default function QuickStudioView({
  project,
  transport,
  waveformPeaks,
  regenFullBusy,
  regenProgress,
  onSwitchToPro,
  onSetABMode,
  onSeek,
  onMutateWithUndo,
  onRegenerateFullSong,
  onCancelRegenJob,
  onExport,
  onSaveAimusic,
}: QuickStudioViewProps) {
  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-[#16191f] p-5">
          <div className="flex items-center gap-4">
            <TrackArtwork
              title={project.title}
              genre={project.config.genre}
              seed={project.project_id}
              size="md"
              isPlaying={transport.isPlaying}
            />
            <div>
              <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                QUICK MODE • Dữ liệu đồng bộ trực tiếp với Studio Pro
              </span>
              <h2 className="mt-1 font-display text-xl font-bold text-white">
                {project.title || 'Untitled Session'}
              </h2>
              <p className="text-xs text-slate-400">
                {project.config.genre} • {project.config.mood} • {project.analysis.bpm} BPM •{' '}
                {project.analysis.detected_key} {project.analysis.detected_scale} (
                {project.analysis.time_signature})
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onSwitchToPro}
            className="flex items-center gap-1.5 rounded-lg border border-amber-400/50 bg-amber-500/15 px-4 py-2 text-xs font-bold text-amber-200 hover:bg-amber-500/25"
          >
            <Sliders className="h-4 w-4" />
            <span>Mở Studio Pro DAW</span>
          </button>
        </div>

        <div className="space-y-3 rounded-2xl border border-white/10 bg-[#16191f] p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
              Nghe thử nhanh A/B &amp; Tua đoạn
            </span>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ['raw', 'Giọng gốc'],
                  ['dry', 'Đã lọc ồn'],
                  ['autotune', 'Auto-Tune'],
                  ['ai_mix', 'AI Mix hoàn chỉnh'],
                ] as Array<[VocalABMode, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSetABMode(id)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                    transport.abMode === id
                      ? 'bg-sky-500 text-slate-950'
                      : 'border border-white/10 bg-[#0b0d11] text-slate-300 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="relative h-14 overflow-hidden rounded-xl border border-white/10 bg-[#0b0d11] px-2 py-1">
            <WaveformClipCanvas
              peaks={waveformPeaks}
              seed={`${project.project_id}:quick:${transport.abMode}`}
              color="rgba(245, 158, 11, 0.72)"
              playedColor="rgba(56, 189, 248, 0.95)"
              playProgress={
                transport.durationSec > 0 ? transport.currentTimeSec / transport.durationSec : 0
              }
            />
            <input
              type="range"
              aria-label="Tua nhanh Quick Mode"
              min={0}
              max={Math.max(0.1, transport.durationSec)}
              step={0.05}
              value={Math.min(Math.max(0.1, transport.durationSec), transport.currentTimeSec)}
              onChange={(e) => onSeek(Number(e.target.value))}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </div>
        </div>

        <div className="grid gap-4 rounded-2xl border border-white/10 bg-[#16191f] p-5 md:grid-cols-2">
          <div className="space-y-3">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-400">
              Đổi Thể loại (Genre) &amp; Cảm xúc (Mood)
            </label>
            <div className="flex flex-wrap gap-1.5">
              {GENRES.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() =>
                    onMutateWithUndo((p) => ({ ...p, config: { ...p.config, genre: g } }))
                  }
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    project.config.genre === g
                      ? 'bg-amber-500 text-slate-950'
                      : 'border border-white/10 bg-[#0b0d11] text-slate-300 hover:text-white'
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {MOODS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() =>
                    onMutateWithUndo((p) => ({ ...p, config: { ...p.config, mood: m } }))
                  }
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    project.config.mood === m
                      ? 'bg-emerald-500 text-slate-950'
                      : 'border border-white/10 bg-[#0b0d11] text-slate-300 hover:text-white'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col justify-between space-y-3">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <label htmlFor="quick-melody-mode" className="mb-1 block text-[11px] text-slate-400">
                  Chế độ giai điệu
                </label>
                <select
                  id="quick-melody-mode"
                  value={project.config.melody_mode}
                  onChange={(e) =>
                    onMutateWithUndo((p) => ({
                      ...p,
                      config: { ...p.config, melody_mode: e.target.value as MelodyMode },
                    }))
                  }
                  className="w-full rounded-lg border border-white/15 bg-[#0b0d11] px-2.5 py-1.5 text-xs text-white"
                >
                  <option value="preserve">Preserve Original</option>
                  <option value="enhance">AI Enhance</option>
                </select>
              </div>
              <div>
                <label htmlFor="quick-output-mode" className="mb-1 block text-[11px] text-slate-400">
                  Cấu trúc bài
                </label>
                <select
                  id="quick-output-mode"
                  value={project.config.output_mode}
                  onChange={(e) =>
                    onMutateWithUndo((p) => ({
                      ...p,
                      config: { ...p.config, output_mode: e.target.value as OutputMode },
                    }))
                  }
                  className="w-full rounded-lg border border-white/15 bg-[#0b0d11] px-2.5 py-1.5 text-xs text-white"
                >
                  <option value="accompaniment">Accompaniment Only</option>
                  <option value="full_song">Full Song (Có cấu trúc)</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-2">
              <button
                type="button"
                disabled={regenFullBusy}
                onClick={onRegenerateFullSong}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2 text-xs font-bold text-white hover:brightness-110 disabled:opacity-50"
              >
                <Wand2 className="h-4 w-4" />
                <span>
                  {regenFullBusy ? `Đang phối lại (${regenProgress}%)...` : 'Regenerate toàn bài'}
                </span>
              </button>
              {regenFullBusy && (
                <button
                  type="button"
                  onClick={onCancelRegenJob}
                  className="flex items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/20 px-3 py-2 text-xs font-bold text-rose-200"
                >
                  <XCircle className="h-4 w-4" /> Hủy
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-2 border-t border-white/10 pt-3">
              <button
                type="button"
                onClick={() => onExport('mp3', '320k')}
                className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#0b0d11] px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-white/10"
              >
                <Download className="h-3.5 w-3.5" /> MP3 (320kbps)
              </button>
              <button
                type="button"
                onClick={() => onExport('wav')}
                className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#0b0d11] px-3 py-1.5 text-xs font-semibold text-sky-300 hover:bg-white/10"
              >
                <Download className="h-3.5 w-3.5" /> WAV (44.1kHz)
              </button>
              <button
                type="button"
                onClick={onSaveAimusic}
                className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#0b0d11] px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-white/10"
              >
                <Save className="h-3.5 w-3.5" /> Lưu .aimusic
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
