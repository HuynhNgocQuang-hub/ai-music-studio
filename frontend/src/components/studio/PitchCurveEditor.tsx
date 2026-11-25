import React from 'react';
import { ArrowDown, ArrowUp, Sparkles, Wand2 } from 'lucide-react';
import { getAudioEngine } from '@/lib/audio/player';
import type { MidiNote } from '@/types/project';

const NOTE_LABELS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const KEY_TO_PC: Record<string, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
};
const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic_major: [0, 2, 4, 7, 9],
  pentatonic_minor: [0, 3, 5, 7, 10],
};

function formatNoteName(pitch: number): string {
  const octave = Math.floor(pitch / 12) - 1;
  return `${NOTE_LABELS[((pitch % 12) + 12) % 12]}${octave}`;
}

function snapPitchToScale(pitch: number, key: string, scale: string): number {
  const offsets = SCALES[scale];
  if (!offsets) return pitch;
  const root = KEY_TO_PC[key] ?? 0;
  let best = pitch;
  let bestDist = 999;
  for (let candidate = pitch - 6; candidate <= pitch + 6; candidate++) {
    const pc = ((candidate - root) % 12 + 12) % 12;
    if (offsets.includes(pc)) {
      const dist = Math.abs(candidate - pitch);
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
  }
  return Math.max(36, Math.min(88, best));
}

export default function PitchCurveEditor({
  notes,
  musicalKey,
  scale,
  onUpdateNotes,
  onApplyResynth,
}: {
  notes: MidiNote[];
  musicalKey: string;
  scale: string;
  onUpdateNotes: (next: MidiNote[]) => void;
  onApplyResynth: () => void;
}) {
  const engine = getAudioEngine();

  if (!notes || notes.length === 0) {
    return (
      <div className="rounded-xl border border-white/[0.07] bg-[#0d1016] px-3 py-3 text-[11px] text-slate-400">
        Chưa có nốt cao độ `raw_melody_midi` được trích xuất để vẽ Visual Pitch Curve. Hãy chạy Analyze hoặc tạo từ audio trước.
      </div>
    );
  }

  const shown = notes.slice(0, 24);
  const pitches = shown.map((n) => n.pitch);
  const minPitch = Math.min(...pitches) - 2;
  const maxPitch = Math.max(...pitches) + 2;
  const span = Math.max(8, maxPitch - minPitch);

  const nudgePitch = (idx: number, delta: number) => {
    const nextPitch = Math.max(36, Math.min(90, notes[idx].pitch + delta));
    const next = notes.map((n, i) => (i === idx ? { ...n, pitch: nextPitch } : n));
    onUpdateNotes(next);
    engine.auditionMidiNote(nextPitch, 'lead');
  };

  const handleSnapAllToScale = () => {
    const snapped = notes.map((n) => ({
      ...n,
      pitch: snapPitchToScale(n.pitch, musicalKey, scale),
    }));
    onUpdateNotes(snapped);
  };

  return (
    <div className="space-y-2 rounded-xl border border-sky-500/25 bg-[#0e131b] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-sky-300">
            Visual Pitch Curve Editor (Melodyne-lite)
          </p>
          <p className="text-[10px] text-slate-400">
            Hiển thị {shown.length}/{notes.length} âm tiết cao độ theo {musicalKey} {scale} • Bấm lên/xuống ±1 bán cung để sửa nốt phô
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleSnapAllToScale}
            className="inline-flex items-center gap-1 rounded border border-sky-400/40 bg-sky-500/15 px-2.5 py-1 text-[10px] font-semibold text-sky-200 hover:bg-sky-500/30"
          >
            <Wand2 className="h-3 w-3" /> Snap theo {musicalKey} {scale}
          </button>
          <button
            type="button"
            onClick={onApplyResynth}
            className="inline-flex items-center gap-1 rounded bg-emerald-500 px-2.5 py-1 text-[10px] font-bold text-slate-950 hover:bg-emerald-400"
          >
            <Sparkles className="h-3 w-3" /> Re-Render Auto-Tune
          </button>
        </div>
      </div>

      {/* Pitch Contour Strip */}
      <div className="relative flex h-28 items-end gap-1.5 overflow-x-auto rounded-lg border border-white/[0.08] bg-[#090c11] p-2">
        {shown.map((note, idx) => {
          const pct = Math.max(8, Math.min(92, ((note.pitch - minPitch) / span) * 100));
          return (
            <div
              key={`${idx}_${note.start_beat}`}
              className="group relative flex h-full min-w-[38px] flex-1 flex-col items-center justify-end"
            >
              <div
                style={{ bottom: `${Math.max(18, Math.min(72, pct))}%` }}
                className="absolute inset-x-0.5 flex flex-col items-center gap-0.5 rounded border border-sky-300/60 bg-sky-500/25 px-0.5 py-0.5 shadow"
              >
                <button
                  type="button"
                  title="Tăng +1 bán cung"
                  onClick={() => nudgePitch(idx, 1)}
                  className="text-slate-300 hover:text-amber-300"
                >
                  <ArrowUp className="h-2.5 w-2.5" />
                </button>
                <span className="font-mono text-[9px] font-bold text-white">
                  {formatNoteName(note.pitch)}
                </span>
                <button
                  type="button"
                  title="Giảm -1 bán cung"
                  onClick={() => nudgePitch(idx, -1)}
                  className="text-slate-300 hover:text-amber-300"
                >
                  <ArrowDown className="h-2.5 w-2.5" />
                </button>
              </div>
              <span className="font-mono text-[8px] text-slate-600">b{Math.floor(note.start_beat) + 1}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
