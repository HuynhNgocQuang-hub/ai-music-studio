import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eraser,
  Magnet,
  Minus,
  Pencil,
  Plus,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { TransportSnapshot } from '@/lib/audio/player';
import { getBeatsPerBar } from '@/lib/music/presets';
import type { MidiNote, ProjectState } from '@/types/project';

const MIN_PITCH = 24; // C1
const MAX_PITCH = 96; // C7
const ROW_HEIGHT = 18;
const KEYBOARD_WIDTH = 68;

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

const TRACK_NOTE_CLASS: Record<'drums' | 'bass' | 'harmony' | 'lead', string> = {
  drums: 'border-amber-200/80 bg-amber-400 text-slate-950 hover:bg-amber-300',
  bass: 'border-violet-300/80 bg-violet-500 text-white hover:bg-violet-400',
  harmony: 'border-sky-300/80 bg-sky-500 text-slate-950 hover:bg-sky-400',
  lead: 'border-emerald-300/80 bg-emerald-400 text-slate-950 hover:bg-emerald-300',
};

const TRACK_VEL_CLASS: Record<'drums' | 'bass' | 'harmony' | 'lead', string> = {
  drums: 'bg-amber-400',
  bass: 'bg-violet-400',
  harmony: 'bg-sky-400',
  lead: 'bg-emerald-400',
};

interface NoteDragPreview {
  noteIdx: number;
  mode: 'move' | 'resize';
  startClientX: number;
  startClientY: number;
  origPitch: number;
  origStartBeat: number;
  origDuration: number;
  previewPitch: number;
  previewStartBeat: number;
  previewDuration: number;
  didDrag: boolean;
}

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
  const velScrollRef = useRef<HTMLDivElement | null>(null);
  const suppressGridClickUntilRef = useRef<number>(0);
  const [selectedNoteIdx, setSelectedNoteIdx] = useState<number | null>(null);
  const [activeKeyPitch, setActiveKeyPitch] = useState<number | null>(null);
  const [editMode, setEditMode] = useState<'draw' | 'erase'>('draw');
  const [pxPerBeat, setPxPerBeat] = useState<number>(64);
  const [velDragActive, setVelDragActive] = useState(false);
  const [noteDrag, setNoteDrag] = useState<NoteDragPreview | null>(null);
  const noteDragRef = useRef<NoteDragPreview | null>(null);
  noteDragRef.current = noteDrag;

  useEffect(() => {
    if (!velDragActive) return;
    const stop = () => setVelDragActive(false);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [velDragActive]);

  useEffect(() => {
    if (selectedNoteIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      const currentNotes = project.tracks[selectedTrack]?.notes || [];
      if (selectedNoteIdx >= 0 && selectedNoteIdx < currentNotes.length) {
        onMutateWithUndo((prev) => ({
          ...prev,
          tracks: {
            ...prev.tracks,
            [selectedTrack]: {
              ...prev.tracks[selectedTrack],
              notes: (prev.tracks[selectedTrack]?.notes || []).filter((_, i) => i !== selectedNoteIdx),
            },
          },
        }));
        setSelectedNoteIdx(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedNoteIdx, selectedTrack, project.tracks, onMutateWithUndo]);

  const notes = project.tracks[selectedTrack]?.notes || [];
  const totalBars = Math.max(4, project.song_structure.total_bars || 8);
  const beatsPerBar = getBeatsPerBar(project.analysis.time_signature);
  const totalBeats = totalBars * beatsPerBar;
  const snapStep = snapGrid === '1/4' ? 1 : snapGrid === '1/8' ? 0.5 : 0.25;
  const gridWidthPx = totalBeats * pxPerBeat;
  const bpm = Math.max(40, project.analysis.bpm || 100);
  const currentBeatFloat = (transport.currentTimeSec * bpm) / 60;
  const playheadLeftPx = Math.max(0, Math.min(gridWidthPx, currentBeatFloat * pxPerBeat));

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

  // Drag-to-move / resize MIDI notes cleanly
  useEffect(() => {
    if (!noteDrag) return;

    const handleMove = (e: PointerEvent) => {
      const curr = noteDragRef.current;
      if (!curr) return;
      const dx = e.clientX - curr.startClientX;
      const dy = e.clientY - curr.startClientY;
      const didDrag = curr.didDrag || Math.hypot(dx, dy) >= 4;

      if (curr.mode === 'move') {
        const deltaBeats = dx / pxPerBeat;
        const deltaPitch = -Math.round(dy / ROW_HEIGHT);
        const rawBeat = curr.origStartBeat + deltaBeats;
        const nextBeat = Number(
          Math.max(
            0,
            Math.min(totalBeats - snapStep, Math.round(rawBeat / snapStep) * snapStep)
          ).toFixed(3)
        );
        const nextPitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, curr.origPitch + deltaPitch));
        if (nextPitch !== curr.previewPitch && didDrag) {
          onAuditionNote(nextPitch, selectedTrack);
        }
        setNoteDrag({
          ...curr,
          didDrag,
          previewStartBeat: nextBeat,
          previewPitch: nextPitch,
        });
      } else {
        const deltaBeats = dx / pxPerBeat;
        const rawDur = curr.origDuration + deltaBeats;
        const nextDur = Number(
          Math.max(snapStep, Math.round(rawDur / snapStep) * snapStep).toFixed(3)
        );
        setNoteDrag({
          ...curr,
          didDrag,
          previewDuration: nextDur,
        });
      }
    };

    const handleUp = () => {
      const curr = noteDragRef.current;
      setNoteDrag(null);
      if (!curr || !curr.didDrag) return;
      suppressGridClickUntilRef.current = performance.now() + 140;

      const changed =
        curr.previewPitch !== curr.origPitch ||
        curr.previewStartBeat !== curr.origStartBeat ||
        curr.previewDuration !== curr.origDuration;

      if (changed) {
        const targetIdx = curr.noteIdx;
        const currentNotes = project.tracks[selectedTrack]?.notes || [];
        if (targetIdx >= 0 && targetIdx < currentNotes.length) {
          const nextNotes = currentNotes.map((n, idx) =>
            idx === targetIdx
              ? {
                  ...n,
                  pitch: curr.previewPitch,
                  start_beat: curr.previewStartBeat,
                  duration: curr.previewDuration,
                }
              : n
          );
          updateTrackNotes(nextNotes);
          setSelectedNoteIdx(targetIdx);
        }
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [Boolean(noteDrag), snapStep, totalBeats, selectedTrack, project.tracks, pxPerBeat]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedNote =
    selectedNoteIdx !== null && selectedNoteIdx >= 0 && selectedNoteIdx < notes.length
      ? notes[selectedNoteIdx]
      : null;

  const handleKeyClick = (pitch: number) => {
    setActiveKeyPitch(pitch);
    onAuditionNote(pitch, selectedTrack);
    window.setTimeout(() => {
      setActiveKeyPitch((curr) => (curr === pitch ? null : curr));
    }, 180);
  };

  const handleGridClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (performance.now() < suppressGridClickUntilRef.current) return;
    if (editMode === 'erase') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(gridWidthPx - 1, e.clientX - rect.left));
    const clickY = Math.max(0, Math.min(pitches.length * ROW_HEIGHT - 1, e.clientY - rect.top));

    const rowIdx = Math.floor(clickY / ROW_HEIGHT);
    const pitch = MAX_PITCH - rowIdx;
    const rawBeat = clickX / pxPerBeat;
    const snappedBeat = Number(
      Math.max(0, Math.min(totalBeats - snapStep, Math.floor(rawBeat / snapStep) * snapStep)).toFixed(3)
    );

    const newNote: MidiNote = {
      pitch,
      start_beat: snappedBeat,
      duration: snapStep,
      velocity: 96,
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

  const handleDeleteNoteAtIdx = (idxToDelete: number) => {
    const nextNotes = notes.filter((_, idx) => idx !== idxToDelete);
    updateTrackNotes(nextNotes);
    setSelectedNoteIdx((curr) => (curr === idxToDelete ? null : curr));
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

  const handleTransposeTrackOctave = (semitones: number) => {
    if (!notes.length) return;
    const shifted = notes.map((n) => ({
      ...n,
      pitch: Math.max(MIN_PITCH, Math.min(MAX_PITCH, n.pitch + semitones)),
    }));
    updateTrackNotes(shifted);
    onNotice(`Đã dịch track ${selectedTrack} ${semitones > 0 ? `+${semitones}` : semitones} semitones.`);
  };

  const syncScrollLeft = (left: number) => {
    if (velScrollRef.current && Math.abs(velScrollRef.current.scrollLeft - left) > 1) {
      velScrollRef.current.scrollLeft = left;
    }
  };

  return (
    <div className="flex h-full flex-col gap-1.5">
      {/* Piano Roll Single-Row Hardware Toolbar */}
      <div className="flex items-center justify-between gap-2 overflow-x-auto pb-0.5">
        <div className="flex shrink-0 items-center gap-1">
          {(['drums', 'bass', 'harmony', 'lead'] as const).map((tid) => (
            <button
              key={tid}
              type="button"
              onClick={() => onSelectTrack(tid)}
              className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide transition ${
                selectedTrack === tid
                  ? 'bg-amber-500 text-slate-950'
                  : 'border border-white/10 bg-[#121419] text-slate-300 hover:bg-white/10'
              }`}
            >
              {tid}
            </button>
          ))}

          {/* Draw / Erase Mode Switch */}
          <div className="ml-1 flex items-center rounded border border-white/10 bg-[#121419] p-0.5">
            <button
              type="button"
              onClick={() => setEditMode('draw')}
              title="Vẽ / Chỉnh nốt (Click phải để xóa)"
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold ${
                editMode === 'draw' ? 'bg-sky-500 text-slate-950' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Pencil className="h-3 w-3" /> Vẽ
            </button>
            <button
              type="button"
              onClick={() => setEditMode('erase')}
              title="Chế độ Tẩy nốt"
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold ${
                editMode === 'erase' ? 'bg-rose-500 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Eraser className="h-3 w-3" /> Xóa
            </button>
          </div>

          <div className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
            <span>Scale: {project.analysis.detected_key}</span>
            <select
              id="pianoroll-scale-select"
              name="pianoRollScale"
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
              className="bg-transparent font-bold text-emerald-200 focus:outline-none"
            >
              {SCALES.map((sc) => (
                <option key={sc} value={sc} className="bg-slate-900 text-white">
                  {sc}
                </option>
              ))}
            </select>
          </div>

          <span className="text-[10px] text-slate-400 tabular-nums">
            Snap <strong className="text-slate-200">{snapGrid}</strong> • {notes.length} nốt
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* Horizontal Zoom Controls */}
          <div className="flex items-center gap-1 rounded border border-white/10 bg-[#121419] px-1.5 py-0.5">
            <button
              type="button"
              aria-label="Thu nhỏ Piano Roll"
              onClick={() => setPxPerBeat((z) => Math.max(36, z - 12))}
              className="rounded p-0.5 text-slate-300 hover:bg-white/10"
            >
              <ZoomOut className="h-3 w-3" />
            </button>
            <span className="font-mono text-[10px] text-slate-400 tabular-nums">
              {Math.round((pxPerBeat / 64) * 100)}%
            </span>
            <button
              type="button"
              aria-label="Phóng to Piano Roll"
              onClick={() => setPxPerBeat((z) => Math.min(120, z + 12))}
              className="rounded p-0.5 text-slate-300 hover:bg-white/10"
            >
              <ZoomIn className="h-3 w-3" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => handleTransposeTrackOctave(-12)}
            title="Dịch xuống 1 quãng tám (-12)"
            className="rounded border border-white/10 bg-[#121419] px-1.5 py-0.5 text-[10px] font-medium text-slate-300 hover:bg-white/10"
          >
            -Oct
          </button>
          <button
            type="button"
            onClick={() => handleTransposeTrackOctave(12)}
            title="Dịch lên 1 quãng tám (+12)"
            className="rounded border border-white/10 bg-[#121419] px-1.5 py-0.5 text-[10px] font-medium text-slate-300 hover:bg-white/10"
          >
            +Oct
          </button>

          <button
            type="button"
            onClick={handleQuantizeTrack}
            className="flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[11px] font-semibold text-sky-200 hover:bg-sky-500/25"
          >
            <Magnet className="h-3 w-3" />
            <span>Quantize</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (!notes.length) return;
              updateTrackNotes([]);
              setSelectedNoteIdx(null);
              onNotice(`Đã xóa toàn bộ nốt MIDI trên track ${selectedTrack}.`);
            }}
            title="Xóa hết nốt track này"
            className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-300 hover:bg-rose-500/20"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Main Scrollable Piano Grid + Floating Selected Note HUD + Synchronized Velocity Lane */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-white/10 bg-[#0d0f13]">
        {selectedNote && selectedNoteIdx !== null && (
          <div className="absolute top-7 right-3 z-30 flex items-center gap-1 rounded-md border border-amber-400/50 bg-[#16191f]/95 px-2 py-1 text-[10px] shadow-xl backdrop-blur">
            <span className="font-mono font-bold text-amber-300">
              {formatMidiPitch(selectedNote.pitch)} (b{selectedNote.start_beat})
            </span>
            <button
              type="button"
              aria-label="Giảm 1 semitone"
              onClick={() =>
                handleUpdateSelectedNote(
                  { pitch: Math.max(MIN_PITCH, selectedNote.pitch - 1) },
                  true
                )
              }
              className="rounded bg-white/10 p-0.5 text-slate-200 hover:bg-white/20"
            >
              <ArrowDown className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label="Tăng 1 semitone"
              onClick={() =>
                handleUpdateSelectedNote(
                  { pitch: Math.min(MAX_PITCH, selectedNote.pitch + 1) },
                  true
                )
              }
              className="rounded bg-white/10 p-0.5 text-slate-200 hover:bg-white/20"
            >
              <ArrowUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label="Giảm độ dài nốt"
              onClick={() =>
                handleUpdateSelectedNote({
                  duration: Number(Math.max(snapStep, selectedNote.duration - snapStep).toFixed(3)),
                })
              }
              className="rounded bg-white/10 p-0.5 text-slate-200 hover:bg-white/20"
            >
              <Minus className="h-3 w-3" />
            </button>
            <span className="font-mono text-white">{selectedNote.duration}b</span>
            <button
              type="button"
              aria-label="Tăng độ dài nốt"
              onClick={() =>
                handleUpdateSelectedNote({
                  duration: Number((selectedNote.duration + snapStep).toFixed(3)),
                })
              }
              className="rounded bg-white/10 p-0.5 text-slate-200 hover:bg-white/20"
            >
              <Plus className="h-3 w-3" />
            </button>
            <label htmlFor="pianoroll-velocity-input" className="flex items-center gap-1 text-slate-300">
              <span>Vel</span>
              <input
                id="pianoroll-velocity-input"
                name="noteVelocity"
                type="range"
                min={1}
                max={127}
                value={selectedNote.velocity}
                onChange={(e) =>
                  handleUpdateSelectedNote({ velocity: Number(e.target.value) || 80 })
                }
                className="w-12 accent-amber-400"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                const nextBeat = Number(
                  Math.min(totalBeats - snapStep, selectedNote.start_beat + selectedNote.duration).toFixed(3)
                );
                const dup: MidiNote = { ...selectedNote, start_beat: nextBeat };
                const nextNotes = [...notes, dup];
                updateTrackNotes(nextNotes);
                setSelectedNoteIdx(nextNotes.length - 1);
                onAuditionNote(dup.pitch, selectedTrack);
              }}
              aria-label="Nhân bản nốt đang chọn"
              title="Nhân bản nốt"
              className="rounded bg-sky-500/20 p-0.5 text-sky-200 hover:bg-sky-500/40"
            >
              <Copy className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => handleDeleteNoteAtIdx(selectedNoteIdx)}
              aria-label="Xóa nốt đang chọn"
              title="Xóa nốt (Delete)"
              className="rounded bg-rose-500/25 p-0.5 text-rose-200 hover:bg-rose-500/45"
            >
              <Trash2 className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label="Bỏ chọn nốt"
              onClick={() => setSelectedNoteIdx(null)}
              className="ml-0.5 rounded px-1 text-slate-400 hover:bg-white/10 hover:text-white"
            >
              ✕
            </button>
          </div>
        )}
        <div
          ref={scrollRef}
          onScroll={(e) => syncScrollLeft(e.currentTarget.scrollLeft)}
          className="min-h-0 flex-1 overflow-auto"
        >
          <div className="relative" style={{ width: `${KEYBOARD_WIDTH + gridWidthPx}px` }}>
            {/* Sticky Top Bar Header */}
            <div className="sticky top-0 z-20 flex border-b border-white/10 bg-[#16191f]">
              <div
                className="sticky left-0 z-30 shrink-0 border-r border-white/10 bg-[#16191f] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400"
                style={{ width: `${KEYBOARD_WIDTH}px` }}
              >
                Keys
              </div>
              <div className="relative h-6" style={{ width: `${gridWidthPx}px` }}>
                {Array.from({ length: totalBars }, (_, barIdx) => (
                  <div
                    key={barIdx}
                    className="absolute top-0 bottom-0 border-l border-white/20 pl-1.5 pt-0.5 font-mono text-[10px] font-bold tabular-nums text-slate-300"
                    style={{
                      left: `${barIdx * beatsPerBar * pxPerBeat}px`,
                      width: `${beatsPerBar * pxPerBeat}px`,
                    }}
                  >
                    Bar {barIdx + 1}
                  </div>
                ))}
              </div>
            </div>

            <div className="relative flex">
              {/* Left Piano Keyboard */}
              <div
                className="sticky left-0 z-10 shrink-0 border-r border-white/15 bg-[#111318]"
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
                      className={`flex w-full items-center justify-between border-b px-1.5 text-[10px] font-mono transition ${
                        isActive
                          ? 'border-amber-400 bg-amber-400 text-slate-950'
                          : isBlack
                          ? 'border-slate-900 bg-[#14161c] text-slate-400 hover:bg-slate-800'
                          : 'border-slate-400/20 bg-slate-200/95 text-slate-900 hover:bg-white'
                      }`}
                    >
                      <span className={isC ? 'font-extrabold text-sky-700' : ''}>
                        {isC || inScale ? formatMidiPitch(pitch) : ''}
                      </span>
                      {inScale && (
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                          title="Thuộc âm giai dự án"
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Interactive Note Grid */}
              <div
                onClick={handleGridClick}
                className={`relative select-none ${
                  editMode === 'erase' ? 'cursor-not-allowed' : 'cursor-crosshair'
                }`}
                style={{ width: `${gridWidthPx}px`, height: `${pitches.length * ROW_HEIGHT}px` }}
              >
                {pitches.map((pitch, rowIdx) => {
                  const pc = ((pitch % 12) + 12) % 12;
                  const isBlack = BLACK_PITCH_CLASSES.has(pc);
                  const inScale = scalePitchClasses.has(pc);
                  return (
                    <div
                      key={pitch}
                      className={`absolute right-0 left-0 border-b border-white/[0.04] ${
                        inScale
                          ? 'bg-emerald-500/[0.045]'
                          : isBlack
                          ? 'bg-[#0b0d11]'
                          : 'bg-[#12151c]'
                      }`}
                      style={{ top: `${rowIdx * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px` }}
                    />
                  );
                })}

                {Array.from({ length: Math.round(totalBeats / snapStep) }, (_, stepIdx) => {
                  const beatPos = stepIdx * snapStep;
                  const isBar = Math.abs(beatPos % beatsPerBar) < 0.001;
                  const isBeat = Math.abs(beatPos % 1) < 0.001;
                  return (
                    <div
                      key={stepIdx}
                      className={`pointer-events-none absolute top-0 bottom-0 border-l ${
                        isBar
                          ? 'border-white/25'
                          : isBeat
                          ? 'border-white/10'
                          : 'border-white/[0.04]'
                      }`}
                      style={{ left: `${beatPos * pxPerBeat}px` }}
                    />
                  );
                })}

                {/* Playhead */}
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-20 w-[2px] bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.85)]"
                  style={{ left: `${playheadLeftPx}px` }}
                />

                {/* Draggable / Resizable / Right-click-Deletable Notes */}
                {notes.map((note, idx) => {
                  const isDraggingThis = noteDrag?.noteIdx === idx;
                  const effPitch = isDraggingThis ? noteDrag.previewPitch : note.pitch;
                  const effStart = isDraggingThis ? noteDrag.previewStartBeat : note.start_beat;
                  const effDur = isDraggingThis ? noteDrag.previewDuration : note.duration;

                  if (effPitch < MIN_PITCH || effPitch > MAX_PITCH) return null;
                  const rowIdx = MAX_PITCH - effPitch;
                  const leftPx = Math.max(0, effStart * pxPerBeat);
                  const widthPx = Math.max(10, effDur * pxPerBeat - 1);
                  const isSel = selectedNoteIdx === idx;
                  const velAlpha = Math.max(0.5, Math.min(1, (note.velocity || 85) / 127));

                  return (
                    <div
                      key={`${note.pitch}_${note.start_beat}_${idx}`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleDeleteNoteAtIdx(idx);
                      }}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        if (editMode === 'erase') {
                          handleDeleteNoteAtIdx(idx);
                          return;
                        }
                        setSelectedNoteIdx(idx);
                        onAuditionNote(note.pitch, selectedTrack);
                        setNoteDrag({
                          noteIdx: idx,
                          mode: 'move',
                          startClientX: e.clientX,
                          startClientY: e.clientY,
                          origPitch: note.pitch,
                          origStartBeat: note.start_beat,
                          origDuration: note.duration,
                          previewPitch: note.pitch,
                          previewStartBeat: note.start_beat,
                          previewDuration: note.duration,
                          didDrag: false,
                        });
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (editMode !== 'erase') setSelectedNoteIdx(idx);
                      }}
                      title={`${formatMidiPitch(effPitch)} • Beat ${effStart} • Vel ${note.velocity} (Right-click để xóa)`}
                      style={{
                        top: `${rowIdx * ROW_HEIGHT + 1}px`,
                        left: `${leftPx}px`,
                        width: `${widthPx}px`,
                        height: `${ROW_HEIGHT - 2}px`,
                        opacity: velAlpha,
                      }}
                      className={`group/note absolute z-10 flex cursor-grab items-center overflow-hidden rounded-[2px] border px-1 text-[9px] font-bold active:cursor-grabbing ${
                        isSel
                          ? 'border-white bg-white text-slate-950 ring-1 ring-amber-400'
                          : TRACK_NOTE_CLASS[selectedTrack]
                      }`}
                    >
                      <span className="truncate">{formatMidiPitch(effPitch)}</span>
                      <div
                        onPointerDown={(e) => {
                          if (e.button !== 0 || editMode === 'erase') return;
                          e.stopPropagation();
                          setSelectedNoteIdx(idx);
                          setNoteDrag({
                            noteIdx: idx,
                            mode: 'resize',
                            startClientX: e.clientX,
                            startClientY: e.clientY,
                            origPitch: note.pitch,
                            origStartBeat: note.start_beat,
                            origDuration: note.duration,
                            previewPitch: note.pitch,
                            previewStartBeat: note.start_beat,
                            previewDuration: note.duration,
                            didDrag: false,
                          });
                        }}
                        title="Kéo mép để chỉnh độ dài nốt"
                        className="absolute top-0 right-0 bottom-0 w-1.5 cursor-ew-resize bg-black/25 opacity-0 transition group-hover/note:opacity-100 hover:bg-white"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Synchronized Velocity Lane (FL Studio / Ableton signature bottom bar) */}
        <div
          ref={velScrollRef}
          className="h-12 shrink-0 overflow-hidden border-t border-white/10 bg-[#101217]"
        >
          <div className="flex h-full" style={{ width: `${KEYBOARD_WIDTH + gridWidthPx}px` }}>
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center justify-between border-r border-white/10 bg-[#16191f] px-2 text-[9px] font-bold uppercase text-slate-400"
              style={{ width: `${KEYBOARD_WIDTH}px` }}
            >
              <span>Vel</span>
              <span className="font-mono text-slate-500">127</span>
            </div>
            <div className="relative h-full" style={{ width: `${gridWidthPx}px` }}>
              {notes.map((note, idx) => {
                const leftPx = Math.max(0, note.start_beat * pxPerBeat);
                const pct = Math.max(8, Math.min(100, ((note.velocity || 85) / 127) * 100));
                const isSel = selectedNoteIdx === idx;
                const setVelFromClientY = (clientY: number, containerEl: HTMLElement | null) => {
                  if (!containerEl) return;
                  const rect = containerEl.getBoundingClientRect();
                  const relY = clientY - rect.top;
                  const newVel = Math.max(
                    20,
                    Math.min(127, Math.round((1 - relY / Math.max(1, rect.height)) * 127))
                  );
                  const nextNotes = notes.map((n, i) => (i === idx ? { ...n, velocity: newVel } : n));
                  updateTrackNotes(nextNotes);
                  setSelectedNoteIdx(idx);
                };
                return (
                  <button
                    key={`vel_${idx}`}
                    type="button"
                    aria-label={`Velocity ${note.velocity}`}
                    title={`Velocity: ${note.velocity} (Bấm hoặc kéo lướt để chỉnh)`}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      setVelDragActive(true);
                      setVelFromClientY(e.clientY, e.currentTarget.parentElement);
                    }}
                    onPointerEnter={(e) => {
                      if (!velDragActive) return;
                      setVelFromClientY(e.clientY, e.currentTarget.parentElement);
                    }}
                    onClick={(e) => {
                      setVelFromClientY(e.clientY, e.currentTarget.parentElement);
                    }}
                    style={{ left: `${leftPx}px`, height: '100%' }}
                    className="group/vel absolute bottom-0 flex w-2.5 items-end justify-center hover:bg-white/10"
                  >
                    <span
                      style={{ height: `${pct}%` }}
                      className={`w-1.5 rounded-t-xs transition-all ${
                        isSel ? 'bg-white' : TRACK_VEL_CLASS[selectedTrack]
                      }`}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
