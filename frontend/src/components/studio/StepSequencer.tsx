import React, { useEffect, useState } from 'react';
import { Copy, Eraser, Play, Sparkles } from 'lucide-react';
import { generateDrumPattern, getBeatsPerBar, type DrumGrooveStyle } from '@/lib/music/presets';
import type { TransportSnapshot } from '@/lib/audio/player';
import type { MidiNote, ProjectState } from '@/types/project';

const DRUM_ROWS = [
  { id: 'kick', label: 'Kick Drum', pitch: 36, color: 'bg-amber-400', ring: 'ring-amber-400/50', dot: 'bg-amber-400' },
  { id: 'snare', label: 'Snare', pitch: 38, color: 'bg-sky-400', ring: 'ring-sky-400/50', dot: 'bg-sky-400' },
  { id: 'clap', label: 'Clap', pitch: 39, color: 'bg-rose-400', ring: 'ring-rose-400/50', dot: 'bg-rose-400' },
  { id: 'chh', label: 'Closed Hat', pitch: 42, color: 'bg-emerald-400', ring: 'ring-emerald-400/50', dot: 'bg-emerald-400' },
  { id: 'ohh', label: 'Open Hat', pitch: 46, color: 'bg-violet-400', ring: 'ring-violet-400/50', dot: 'bg-violet-400' },
] as const;

interface StepSequencerProps {
  project: ProjectState;
  transport: TransportSnapshot;
  onMutateWithUndo: (updater: (prev: ProjectState) => ProjectState) => void;
  onAuditionNote: (pitch: number, trackId: string) => void;
  onNotice: (msg: string) => void;
}

export default function StepSequencer({
  project,
  transport,
  onMutateWithUndo,
  onAuditionNote,
  onNotice,
}: StepSequencerProps) {
  const totalBars = Math.max(4, project.song_structure.total_bars || 8);
  const beatsPerBar = getBeatsPerBar(project.analysis.time_signature);
  const stepBeatSize = beatsPerBar === 6 ? 0.5 : 0.25;
  const stepsPerBar = Math.round(beatsPerBar / stepBeatSize); // 16 for 4/4, 12 for 3/4 or 6/8
  const [activeBar, setActiveBar] = useState(1);

  useEffect(() => {
    if (activeBar > totalBars) setActiveBar(totalBars);
  }, [activeBar, totalBars]);

  const bpm = Math.max(40, project.analysis.bpm || 100);
  const currentBeat = (transport.currentTimeSec * bpm) / 60;
  const barStartBeat = (activeBar - 1) * beatsPerBar;
  const activePlayStepInBar =
    transport.isPlaying && currentBeat >= barStartBeat && currentBeat < barStartBeat + beatsPerBar
      ? Math.floor((currentBeat - barStartBeat) / stepBeatSize)
      : -1;

  const drumNotes = project.tracks.drums?.notes || [];

  const isStepLit = (pitch: number, stepIdx: number): boolean => {
    const targetBeat = barStartBeat + stepIdx * stepBeatSize;
    return drumNotes.some(
      (n) => n.pitch === pitch && Math.abs(n.start_beat - targetBeat) < 0.09
    );
  };

  const handleToggleStep = (pitch: number, stepIdx: number) => {
    const targetBeat = Number((barStartBeat + stepIdx * stepBeatSize).toFixed(3));
    const exists = isStepLit(pitch, stepIdx);
    onMutateWithUndo((prev) => {
      const curr = prev.tracks.drums?.notes || [];
      const nextNotes = (
        exists
          ? curr.filter((n) => !(n.pitch === pitch && Math.abs(n.start_beat - targetBeat) < 0.09))
          : [
              ...curr,
              {
                pitch,
                start_beat: targetBeat,
                duration: stepBeatSize,
                velocity: stepIdx % (beatsPerBar === 6 ? 6 : 4) === 0 ? 114 : 94,
              } satisfies MidiNote,
            ]
      ).sort((a, b) => a.start_beat - b.start_beat || a.pitch - b.pitch);
      return {
        ...prev,
        tracks: {
          ...prev.tracks,
          drums: { ...prev.tracks.drums, notes: nextNotes },
        },
      };
    });
    if (!exists) {
      onAuditionNote(pitch, 'drums');
    }
  };

  const handleApplyGroove = (style: DrumGrooveStyle, label: string) => {
    const generated = generateDrumPattern(style, totalBars, beatsPerBar);
    onMutateWithUndo((prev) => ({
      ...prev,
      tracks: {
        ...prev.tracks,
        drums: { ...prev.tracks.drums, notes: generated },
      },
    }));
    onNotice(`Đã nạp nhịp trống "${label}" cho ${totalBars} bars.`);
  };

  const handleCopyBarToAll = () => {
    const currentBarNotes = drumNotes.filter(
      (n) => n.start_beat >= barStartBeat - 0.01 && n.start_beat < barStartBeat + beatsPerBar - 0.01
    );
    const repeated: MidiNote[] = [];
    for (let bar = 0; bar < totalBars; bar++) {
      const offset = bar * beatsPerBar;
      for (const n of currentBarNotes) {
        repeated.push({
          ...n,
          start_beat: Number((offset + (n.start_beat - barStartBeat)).toFixed(3)),
        });
      }
    }
    onMutateWithUndo((prev) => ({
      ...prev,
      tracks: {
        ...prev.tracks,
        drums: { ...prev.tracks.drums, notes: repeated },
      },
    }));
    onNotice(`Đã nhân bản pattern từ Bar ${activeBar} ra toàn bộ ${totalBars} bars.`);
  };

  const handleClearBar = () => {
    onMutateWithUndo((prev) => {
      const curr = prev.tracks.drums?.notes || [];
      const filtered = curr.filter(
        (n) => n.start_beat < barStartBeat - 0.01 || n.start_beat >= barStartBeat + beatsPerBar - 0.01
      );
      return {
        ...prev,
        tracks: {
          ...prev.tracks,
          drums: { ...prev.tracks.drums, notes: filtered },
        },
      };
    });
    onNotice(`Đã xóa các bước trống trong Bar ${activeBar}.`);
  };

  const handleClearAllBars = () => {
    if (!drumNotes.length) return;
    onMutateWithUndo((prev) => ({
      ...prev,
      tracks: {
        ...prev.tracks,
        drums: { ...prev.tracks.drums, notes: [] },
      },
    }));
    onNotice('Đã xóa toàn bộ pattern trống trên cả bài.');
  };

  return (
    <div className="space-y-1.5">
      {/* Channel Rack Top Toolbar (Single-row adaptive without wrapping) */}
      <div className="flex items-center justify-between gap-2 overflow-x-auto pb-0.5">
        <div className="flex shrink-0 items-center gap-1">
          <span className="mr-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Bar:
          </span>
          {Array.from({ length: totalBars }, (_, idx) => {
            const barNum = idx + 1;
            const isPlayingBar =
              transport.isPlaying &&
              currentBeat >= idx * beatsPerBar &&
              currentBeat < (idx + 1) * beatsPerBar;
            return (
              <button
                key={barNum}
                type="button"
                onClick={() => setActiveBar(barNum)}
                className={`relative rounded px-1.5 py-0.5 font-mono text-[10px] font-bold transition ${
                  activeBar === barNum
                    ? 'bg-amber-500 text-slate-950'
                    : isPlayingBar
                    ? 'bg-cyan-500/25 text-cyan-200 ring-1 ring-cyan-400/50'
                    : 'bg-[#121419] text-slate-400 hover:bg-white/10 hover:text-white'
                }`}
              >
                B{barNum}
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <span className="flex items-center gap-1 text-[10px] text-slate-400">
            <Sparkles className="h-3 w-3 text-amber-400" /> Groove:
          </span>
          {(
            [
              ['pop', 'Pop 4/4'],
              ['trap', 'Trap 808'],
              ['lofi', 'Lo-fi Swing'],
              ['edm', 'House 4x4'],
            ] as Array<[DrumGrooveStyle, string]>
          ).map(([style, label]) => (
            <button
              key={style}
              type="button"
              onClick={() => handleApplyGroove(style, label)}
              className="rounded border border-white/10 bg-[#14171d] px-2 py-0.5 text-[10px] font-medium text-slate-200 transition hover:border-amber-400/50 hover:text-amber-200"
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={handleCopyBarToAll}
            title="Lặp pattern của Bar hiện tại ra tất cả các Bar"
            className="flex items-center gap-1 rounded border border-sky-500/35 bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-200 hover:bg-sky-500/25"
          >
            <Copy className="h-3 w-3" /> Lặp cả bài
          </button>
          <button
            type="button"
            onClick={handleClearBar}
            title="Xóa trống trong Bar đang chọn"
            className="flex items-center gap-1 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-300 hover:bg-rose-500/20"
          >
            <Eraser className="h-3 w-3" /> Xóa Bar
          </button>
          <button
            type="button"
            onClick={handleClearAllBars}
            title="Xóa toàn bộ trống trên cả bài"
            className="rounded border border-rose-500/25 bg-rose-950/30 px-2 py-0.5 text-[10px] font-medium text-rose-200 hover:bg-rose-500/20"
          >
            Xóa hết
          </button>
        </div>
      </div>

      {/* Classic 16-Step Hardware Drum Rack */}
      <div className="overflow-x-auto rounded-lg border border-white/[0.08] bg-[#121419] p-2">
        <div className="min-w-[660px] space-y-1">
          {DRUM_ROWS.map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              {/* Drum Channel Name + Preview Pad */}
              <button
                type="button"
                onClick={() => onAuditionNote(row.pitch, 'drums')}
                title={`Nghe thử ${row.label}`}
                className="flex h-7 w-32 shrink-0 items-center justify-between rounded border border-white/10 bg-[#1b1e25] px-2 text-left transition hover:border-white/25 hover:bg-[#242832]"
              >
                <span className="flex items-center gap-1.5 truncate text-[11px] font-semibold text-slate-100">
                  <span className={`h-2 w-2 rounded-full ${row.dot}`} />
                  {row.label}
                </span>
                <Play className="h-2.5 w-2.5 text-slate-400" />
              </button>

              {/* Steps grouped cleanly for 4/4 (16 steps) or 3/4 & 6/8 (12 steps) */}
              <div className={`grid flex-1 gap-1 ${stepsPerBar === 12 ? 'grid-cols-12' : 'grid-cols-16'}`}>
                {Array.from({ length: stepsPerBar }, (_, stepIdx) => {
                  const groupSize = beatsPerBar === 6 ? 3 : 4;
                  const beatGroup = Math.floor(stepIdx / groupSize);
                  const isAltBank = beatGroup % 2 === 1;
                  const lit = isStepLit(row.pitch, stepIdx);
                  const isPlayhead = activePlayStepInBar === stepIdx;

                  return (
                    <button
                      key={stepIdx}
                      type="button"
                      aria-label={`${row.label} step ${stepIdx + 1}`}
                      aria-pressed={lit}
                      onClick={() => handleToggleStep(row.pitch, stepIdx)}
                      className={`relative h-7 rounded-[4px] border transition ${
                        lit
                          ? `${row.color} border-white/50 shadow-sm ring-1 ${row.ring}`
                          : isAltBank
                          ? 'border-white/10 bg-[#242833] hover:bg-[#2d3240]'
                          : 'border-white/10 bg-[#181b22] hover:bg-[#21252e]'
                      } ${isPlayhead ? 'ring-2 ring-cyan-400' : ''}`}
                    >
                      {isPlayhead && (
                        <span className="absolute right-1 bottom-0.5 left-1 h-0.5 rounded-full bg-cyan-300" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
