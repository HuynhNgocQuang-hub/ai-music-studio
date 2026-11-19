import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Magnet, Minus, Plus, Trash2 } from 'lucide-react';
import type { TransportSnapshot } from '@/lib/audio/player';
import type { MidiNote, ProjectState } from '@/types/project';

const MIN_PITCH = 24; // C1
const MAX_PITCH = 96; // C7
const ROW_HEIGHT = 18;
const KEYBOARD_WIDTH = 64;
const PX_PER_BEAT = 64;

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

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

const SCALE_INTERVALS: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic_major: [0, 2, 4, 7, 9],
  pentatonic_minor: [0, 3, 5, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

const SCALES = ['major', 'minor', 'pentatonic_major', 'pentatonic_minor', 'chromatic'] as const;

function formatMidiPitch(pitch: number): string {
  const octave = Math.floor(pitch / 12) - 1;
  const name = NOTE_NAMES[((pitch % 12) + 12) % 12];
  return `${name}${octave}`;
}

interface PianoRollEditorProps {
  project: ProjectState;
  transport: TransportSnapshot;
  selectedTrack: 'drums' | 'bass' | 'harmony' | 'lead';
  snapGrid: '1/4' | '1/8' | '1/16';
  onSelectTrack: (trackId: 'drums' | 'bass' | 'harmony' | 'lead') => void;
  onMutateWithUndo: (updater: (prev: ProjectState) => ProjectState) => void;
  onAuditionNote: (pitch: number, trackId: string) => void;
  onNotice: (msg: string) => void;
}

export default function PianoRollEditor({
  project,
  transport,
  selectedTrack,
  snapGrid,
  onSelectTrack,
  onMutateWithUndo,
  onAuditionNote,
  onNotice,
}: PianoRollEditorProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [selectedNoteIdx, setSelectedNoteIdx] = useState<number | null>(null);
  const [activeKeyPitch, setActiveKeyPitch] = useState<number | null>(null);

  const notes = project.tracks[selectedTrack]?.notes || [];
  const totalBars = Math.max(4, project.song_structure.total_bars || 8);
  const beatsPerBar = project.analysis.time_signature === '3/4' ? 3 : 4;
  const totalBeats = totalBars * beatsPerBar;
  const snapStep = snapGrid === '1/4' ? 1 : snapGrid === '1/8' ? 0.5 : 0.25;
  const gridWidthPx = totalBeats * PX_PER_BEAT;
  const bpm = Math.max(40, project.analysis.bpm || 100);
  const currentBeatFloat = (transport.currentTimeSec * bpm) / 60;
  const playheadLeftPx = Math.max(0, Math.min(gridWidthPx, currentBeatFloat * PX_PER_BEAT));

  const pitches = useMemo(() => {
    const arr: number[] = [];
    for (let p = MAX_PITCH; p >= MIN_PITCH; p--) {
      arr.push(p);
    }
    return arr;
  }, []);

  const scalePitchClasses = useMemo(() => {
    const rootPc = KEY_TO_PC[project.analysis.detected_key] ?? 0;
    const intervals = SCALE_INTERVALS[project.analysis.detected_scale] || SCALE_INTERVALS.major;
    return new Set(intervals.map((iv) => (rootPc + iv) % 12));
  }, [project.analysis.detected_key, project.analysis.detected_scale]);

  // Center scroll viewport around track's notes when switching track
  useEffect(() => {
    setSelectedNoteIdx(null);
    const el = scrollRef.current;
    if (!el) return;
    const trackNotes = project.tracks[selectedTrack]?.notes || [];
    const defaultPitch = selectedTrack === 'bass' || selectedTrack === 'drums' ? 40 : 62;
    const targetPitch = trackNotes.length
      ? Math.round(trackNotes.reduce((sum, n) => sum + n.pitch, 0) / trackNotes.length)
      : defaultPitch;
    const rowIdx = MAX_PITCH - Math.max(MIN_PITCH, Math.min(MAX_PITCH, targetPitch));
    const targetScrollTop = Math.max(0, rowIdx * ROW_HEIGHT - el.clientHeight / 2);
    el.scrollTop = targetScrollTop;
  }, [selectedTrack]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedNote =
    selectedNoteIdx !== null && selectedNoteIdx >= 0 && selectedNoteIdx < notes.length
      ? notes[selectedNoteIdx]
      : null;

  const updateTrackNotes = (nextNotes: MidiNote[]) => {
    onMutateWithUndo((prev) => ({
      ...prev,
      tracks: {
        ...prev.tracks,
        [selectedTrack]: {
          ...prev.tracks[selectedTrack],
          notes: nextNotes,
        },
      },
    }));
  };

  const handleKeyClick = (pitch: number) => {
    setActiveKeyPitch(pitch);
    onAuditionNote(pitch, selectedTrack);
    window.setTimeout(() => {
      setActiveKeyPitch((curr) => (curr === pitch ? null : curr));
    }, 180);
  };

  const handleGridClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(gridWidthPx - 1, e.clientX - rect.left));
    const clickY = Math.max(0, Math.min(pitches.length * ROW_HEIGHT - 1, e.clientY - rect.top));

    const rowIdx = Math.floor(clickY / ROW_HEIGHT);
    const pitch = MAX_PITCH - rowIdx;
    const rawBeat = clickX / PX_PER_BEAT;
    const snappedBeat = Number(
      Math.max(0, Math.min(totalBeats - snapStep, Math.floor(rawBeat / snapStep) * snapStep)).toFixed(3)
    );

    const newNote: MidiNote = {
      pitch,
      start_beat: snappedBeat,
      duration: snapStep,
      velocity: 92,
    };

    const nextNotes = [...notes, newNote];
    updateTrackNotes(nextNotes);
    setSelectedNoteIdx(nextNotes.length - 1);
    onAuditionNote(pitch, selectedTrack);
  };

  const handleUpdateSelectedNote = (patch: Partial<MidiNote>, audition = false) => {
    if (selectedNoteIdx === null || !selectedNote) return;
    const nextNotes = notes.map((n, idx) => (idx === selectedNoteIdx ? { ...n, ...patch } : n));
    updateTrackNotes(nextNotes);
    if (audition) {
      onAuditionNote(patch.pitch ?? selectedNote.pitch, selectedTrack);
    }
  };

  const handleDeleteSelectedNote = () => {
    if (selectedNoteIdx === null) return;
    const nextNotes = notes.filter((_, idx) => idx !== selectedNoteIdx);
    updateTrackNotes(nextNotes);
    setSelectedNoteIdx(null);
  };

  const handleQuantizeTrack = () => {
    if (!notes.length) {
      onNotice(`Track ${selectedTrack} chưa có nốt MIDI để Quantize.`);
      return;
    }
    const quantized = notes.map((n) => {
      const qBeat = Number(
        Math.max(
          0,
          Math.min(totalBeats - snapStep, Math.round(n.start_beat / snapStep) * snapStep)
        ).toFixed(3)
      );
      const qDur = Number(Math.max(snapStep, Math.round(n.duration / snapStep) * snapStep).toFixed(3));
      return { ...n, start_beat: qBeat, duration: qDur };
    });
    updateTrackNotes(quantized);
    onNotice(`Đã Quantize ${quantized.length} nốt track ${selectedTrack} theo lưới ${snapGrid}.`);
  };

  return (
    <div className="space-y-2">
      {/* Piano Roll Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-400">Track:</span>
          {(['drums', 'bass', 'harmony', 'lead'] as const).map((tid) => (
            <button
              key={tid}
              type="button"
              onClick={() => onSelectTrack(tid)}
              className={`rounded px-2.5 py-1 text-xs font-medium capitalize ${
                selectedTrack === tid
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {tid}
            </button>
          ))}
          <div className="flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">
            <span>Scale: {project.analysis.detected_key}</span>
            <select
              aria-label="Piano Roll Scale"
              value={project.analysis.detected_scale}
              onChange={(e) => {
                const nextScale = e.target.value;
                onMutateWithUndo((prev) => ({
                  ...prev,
                  analysis: { ...prev.analysis, detected_scale: nextScale, key_locked: true },
                  autotune_settings: prev.autotune_settings.auto_follow_project_key
                    ? { ...prev.autotune_settings, scale: nextScale }
                    : prev.autotune_settings,
                }));
              }}
              className="bg-transparent font-semibold text-emerald-200 focus:outline-none"
            >
              {SCALES.map((sc) => (
                <option key={sc} value={sc} className="bg-slate-900 text-white">
                  {sc}
                </option>
              ))}
            </select>
          </div>
          <span className="text-[11px] text-slate-400">
            Snap: <strong className="text-slate-200">{snapGrid}</strong> • {notes.length} nốt
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selectedNote && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2 py-1 text-[11px]">
              <span className="font-mono font-bold text-indigo-200">
                {formatMidiPitch(selectedNote.pitch)} (b{selectedNote.start_beat})
              </span>
              <button
                type="button"
                title="Giảm 1 semitone"
                onClick={() =>
                  handleUpdateSelectedNote(
                    { pitch: Math.max(MIN_PITCH, selectedNote.pitch - 1) },
                    true
                  )
                }
                className="rounded bg-slate-800 p-1 text-slate-200 hover:bg-slate-700"
              >
                <ArrowDown className="h-3 w-3" />
              </button>
              <button
                type="button"
                title="Tăng 1 semitone"
                onClick={() =>
                  handleUpdateSelectedNote(
                    { pitch: Math.min(MAX_PITCH, selectedNote.pitch + 1) },
                    true
                  )
                }
                className="rounded bg-slate-800 p-1 text-slate-200 hover:bg-slate-700"
              >
                <ArrowUp className="h-3 w-3" />
              </button>
              <span className="text-slate-500">|</span>
              <span className="text-slate-300">Dur:</span>
              <button
                type="button"
                onClick={() =>
                  handleUpdateSelectedNote({
                    duration: Number(Math.max(snapStep, selectedNote.duration - snapStep).toFixed(3)),
                  })
                }
                className="rounded bg-slate-800 p-1 text-slate-200 hover:bg-slate-700"
              >
                <Minus className="h-3 w-3" />
              </button>
              <span className="font-mono text-white">{selectedNote.duration}b</span>
              <button
                type="button"
                onClick={() =>
                  handleUpdateSelectedNote({
                    duration: Number((selectedNote.duration + snapStep).toFixed(3)),
                  })
                }
                className="rounded bg-slate-800 p-1 text-slate-200 hover:bg-slate-700"
              >
                <Plus className="h-3 w-3" />
              </button>
              <span className="text-slate-500">|</span>
              <label className="flex items-center gap-1 text-slate-300">
                <span>Vel</span>
                <input
                  type="range"
                  min={1}
                  max={127}
                  value={selectedNote.velocity}
                  onChange={(e) =>
                    handleUpdateSelectedNote({ velocity: Number(e.target.value) || 80 })
                  }
                  className="w-14 accent-indigo-500"
                />
                <span className="w-6 font-mono text-white">{selectedNote.velocity}</span>
              </label>
              <button
                type="button"
                onClick={handleDeleteSelectedNote}
                title="Xóa nốt"
                className="rounded bg-rose-600/30 p-1 text-rose-200 hover:bg-rose-600/50"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={handleQuantizeTrack}
            className="flex items-center gap-1 rounded-lg border border-indigo-500/40 bg-indigo-600/20 px-2.5 py-1 text-xs font-semibold text-indigo-200 hover:bg-indigo-600/35"
          >
            <Magnet className="h-3.5 w-3.5" />
            <span>Quantize Track</span>
          </button>
        </div>
      </div>

      {/* Interactive Piano Roll Grid */}
      <div
        ref={scrollRef}
        className="h-64 overflow-auto rounded-lg border border-slate-800 bg-[#090c14]"
      >
        <div className="relative" style={{ width: `${KEYBOARD_WIDTH + gridWidthPx}px` }}>
          {/* Sticky Top Beat/Bar Header */}
          <div className="sticky top-0 z-20 flex border-b border-slate-800 bg-[#101420]">
            <div
              className="sticky left-0 z-30 shrink-0 border-r border-slate-800 bg-[#101420] px-2 py-1 text-[10px] font-semibold text-slate-400"
              style={{ width: `${KEYBOARD_WIDTH}px` }}
            >
              PITCH
            </div>
            <div className="relative h-6" style={{ width: `${gridWidthPx}px` }}>
              {Array.from({ length: totalBars }, (_, barIdx) => (
                <div
                  key={barIdx}
                  className="absolute top-0 bottom-0 border-l border-slate-600/80 pl-1.5 pt-0.5 font-mono text-[10px] font-semibold text-slate-300"
                  style={{
                    left: `${barIdx * beatsPerBar * PX_PER_BEAT}px`,
                    width: `${beatsPerBar * PX_PER_BEAT}px`,
                  }}
                >
                  Bar {barIdx + 1}
                </div>
              ))}
            </div>
          </div>

          {/* Body: Sticky Left Keyboard + Note Grid */}
          <div className="relative flex">
            {/* Left Clickable Piano Keyboard */}
            <div
              className="sticky left-0 z-10 shrink-0 border-r border-slate-800 bg-[#0d111b]"
              style={{ width: `${KEYBOARD_WIDTH}px` }}
            >
              {pitches.map((pitch) => {
                const pc = ((pitch % 12) + 12) % 12;
                const isBlack = BLACK_PITCH_CLASSES.has(pc);
                const inScale = scalePitchClasses.has(pc);
                const isC = pc === 0;
                const isActive = activeKeyPitch === pitch;
                return (
                  <button
                    key={pitch}
                    type="button"
                    onClick={() => handleKeyClick(pitch)}
                    style={{ height: `${ROW_HEIGHT}px` }}
                    className={`flex w-full items-center justify-between border-b border-slate-800/70 px-1.5 text-[10px] font-mono transition ${
                      isActive
                        ? 'bg-indigo-500 text-white'
                        : isBlack
                        ? 'bg-slate-950 text-slate-400 hover:bg-slate-800'
                        : 'bg-slate-800/80 text-slate-200 hover:bg-slate-700'
                    }`}
                  >
                    <span className={isC ? 'font-bold text-indigo-300' : ''}>
                      {isC || inScale ? formatMidiPitch(pitch) : ''}
                    </span>
                    {inScale && (
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-emerald-400"
                        title="Thuộc âm giai dự án"
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Interactive Note Grid Canvas */}
            <div
              onClick={handleGridClick}
              className="relative cursor-crosshair select-none"
              style={{ width: `${gridWidthPx}px`, height: `${pitches.length * ROW_HEIGHT}px` }}
            >
              {/* Pitch Rows (highlighting in-scale rows) */}
              {pitches.map((pitch, rowIdx) => {
                const pc = ((pitch % 12) + 12) % 12;
                const isBlack = BLACK_PITCH_CLASSES.has(pc);
                const inScale = scalePitchClasses.has(pc);
                return (
                  <div
                    key={pitch}
                    className={`absolute right-0 left-0 border-b border-slate-800/50 ${
                      inScale
                        ? 'bg-emerald-500/[0.045]'
                        : isBlack
                        ? 'bg-[#07090f]'
                        : 'bg-[#0b0e17]'
                    }`}
                    style={{ top: `${rowIdx * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px` }}
                  />
                );
              })}

              {/* Vertical Snap / Beat / Bar Lines */}
              {Array.from({ length: Math.round(totalBeats / snapStep) }, (_, stepIdx) => {
                const beatPos = stepIdx * snapStep;
                const isBar = Math.abs(beatPos % beatsPerBar) < 0.001;
                const isBeat = Math.abs(beatPos % 1) < 0.001;
                return (
                  <div
                    key={stepIdx}
                    className={`pointer-events-none absolute top-0 bottom-0 border-l ${
                      isBar
                        ? 'border-slate-600/80'
                        : isBeat
                        ? 'border-slate-700/60'
                        : 'border-slate-800/40'
                    }`}
                    style={{ left: `${beatPos * PX_PER_BEAT}px` }}
                  />
                );
              })}

              {/* Live Playhead Indicator */}
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.85)]"
                style={{ left: `${playheadLeftPx}px` }}
              />

              {/* Rendered MIDI Notes */}
              {notes.map((note, idx) => {
                if (note.pitch < MIN_PITCH || note.pitch > MAX_PITCH) return null;
                const rowIdx = MAX_PITCH - note.pitch;
                const leftPx = Math.max(0, note.start_beat * PX_PER_BEAT);
                const widthPx = Math.max(10, note.duration * PX_PER_BEAT - 1);
                const isSel = selectedNoteIdx === idx;
                const velAlpha = Math.max(0.45, Math.min(1, (note.velocity || 80) / 127));
                return (
                  <div
                    key={`${note.pitch}_${note.start_beat}_${idx}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedNoteIdx(idx);
                      onAuditionNote(note.pitch, selectedTrack);
                    }}
                    title={`${formatMidiPitch(note.pitch)} • Beat ${note.start_beat} • Dur ${note.duration}b • Vel ${note.velocity}`}
                    style={{
                      top: `${rowIdx * ROW_HEIGHT + 1}px`,
                      left: `${leftPx}px`,
                      width: `${widthPx}px`,
                      height: `${ROW_HEIGHT - 2}px`,
                      opacity: velAlpha,
                    }}
                    className={`absolute z-10 flex items-center overflow-hidden rounded-xs border px-1 text-[9px] font-semibold transition ${
                      isSel
                        ? 'border-amber-300 bg-amber-400 text-slate-950 ring-1 ring-amber-200'
                        : 'border-indigo-300/70 bg-indigo-500 text-white hover:bg-indigo-400'
                    }`}
                  >
                    <span className="truncate">{formatMidiPitch(note.pitch)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
