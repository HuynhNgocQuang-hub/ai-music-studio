import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  Drum,
  FolderPlus,
  Guitar,
  Lock,
  Mic,
  Music2,
  Piano,
  Plus,
  RefreshCw,
  Scissors,
  Sparkles,
  Trash2,
  Unlock,
  Waves,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { validateAudioFileClient } from '@/lib/api/client';
import { getAudioEngine, type TransportSnapshot } from '@/lib/audio/player';
import { getBeatsPerBar } from '@/lib/music/presets';
import WaveformClipCanvas from '@/components/studio/WaveformClipCanvas';
import type {
  AudioClip,
  AudioTrackState,
  AutomationPoint,
  ChordEvent,
  MidiNote,
  ProjectState,
  SongSection,
  TrackAutomationParam,
} from '@/types/project';

const SECTION_PRESETS = ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'];
const TRACK_COL_WIDTH = 228;

const TRACK_DEFAULTS: Record<
  'texture' | 'drums' | 'bass' | 'harmony' | 'lead',
  { label: string; type: 'audio' | 'midi'; instrument?: string; volume: number; pan: number }
> = {
  texture: { label: 'Texture (Audio Sample)', type: 'audio', volume: 0.85, pan: 0 },
  drums: { label: 'Drums (MIDI)', type: 'midi', instrument: 'acoustic_kit', volume: 0.85, pan: 0 },
  bass: { label: 'Bass (MIDI)', type: 'midi', instrument: 'finger_bass', volume: 0.85, pan: 0 },
  harmony: { label: 'Harmony (MIDI)', type: 'midi', instrument: 'grand_piano', volume: 0.8, pan: -0.1 },
  lead: { label: 'Lead Synth (MIDI)', type: 'midi', instrument: 'electric_piano', volume: 0.75, pan: 0.1 },
};

const TRACK_STYLE: Record<
  string,
  {
    accentBar: string;
    badge: string;
    noteColor: string;
    waveColor: string;
    waveStroke: string;
    clipBorder: string;
    clipBg: string;
    headerBg: string;
    headerText: string;
  }
> = {
  vocal: {
    accentBar: 'bg-emerald-400',
    badge: 'text-emerald-200',
    noteColor: 'bg-emerald-100',
    waveColor: 'rgba(209, 250, 229, 0.88)',
    waveStroke: 'rgba(236, 253, 245, 0.98)',
    clipBorder: 'border-[#57c7a0]/80 hover:border-emerald-300',
    clipBg: 'bg-[#1a493c]/48',
    headerBg: 'bg-[#3c9678]/90',
    headerText: 'text-white',
  },
  overdub: {
    accentBar: 'bg-rose-400',
    badge: 'text-rose-200',
    noteColor: 'bg-rose-100',
    waveColor: 'rgba(255, 228, 230, 0.88)',
    waveStroke: 'rgba(255, 241, 242, 0.98)',
    clipBorder: 'border-[#f47292]/80 hover:border-rose-300',
    clipBg: 'bg-[#562030]/50',
    headerBg: 'bg-[#aa4562]/90',
    headerText: 'text-white',
  },
  texture: {
    accentBar: 'bg-indigo-400',
    badge: 'text-indigo-200',
    noteColor: 'bg-indigo-100',
    waveColor: 'rgba(224, 231, 255, 0.90)',
    waveStroke: 'rgba(238, 242, 255, 0.98)',
    clipBorder: 'border-[#7c97e8]/80 hover:border-indigo-300',
    clipBg: 'bg-[#26375f]/55',
    headerBg: 'bg-[#4f679e]/90',
    headerText: 'text-white',
  },
  drums: {
    accentBar: 'bg-amber-400',
    badge: 'text-amber-200',
    noteColor: 'bg-[#fef3c7]',
    waveColor: 'rgba(254, 243, 199, 0.88)',
    waveStroke: 'rgba(255, 251, 235, 0.98)',
    clipBorder: 'border-[#e4a64a]/75 hover:border-amber-300',
    clipBg: 'bg-[#493418]/48',
    headerBg: 'bg-[#9d6f2c]/90',
    headerText: 'text-white',
  },
  bass: {
    accentBar: 'bg-violet-400',
    badge: 'text-violet-200',
    noteColor: 'bg-[#f3e8ff]',
    waveColor: 'rgba(243, 232, 255, 0.88)',
    waveStroke: 'rgba(250, 245, 255, 0.98)',
    clipBorder: 'border-[#9e82e8]/80 hover:border-violet-300',
    clipBg: 'bg-[#36285c]/54',
    headerBg: 'bg-[#6e56a4]/92',
    headerText: 'text-white',
  },
  harmony: {
    accentBar: 'bg-sky-400',
    badge: 'text-sky-200',
    noteColor: 'bg-[#dbeafe]',
    waveColor: 'rgba(219, 234, 254, 0.88)',
    waveStroke: 'rgba(239, 246, 255, 0.98)',
    clipBorder: 'border-[#6da8e8]/80 hover:border-sky-300',
    clipBg: 'bg-[#21385b]/54',
    headerBg: 'bg-[#4c76a8]/92',
    headerText: 'text-white',
  },
  lead: {
    accentBar: 'bg-teal-400',
    badge: 'text-teal-200',
    noteColor: 'bg-[#ccfbf1]',
    waveColor: 'rgba(204, 251, 241, 0.88)',
    waveStroke: 'rgba(240, 253, 250, 0.98)',
    clipBorder: 'border-[#56cfc0]/75 hover:border-teal-300',
    clipBg: 'bg-[#194341]/48',
    headerBg: 'bg-[#388680]/90',
    headerText: 'text-white',
  },
};

function ClipTypeGlyph({ kind }: { kind: 'midi' | 'audio' | 'envelope' }) {
  if (kind === 'audio') {
    return (
      <svg className="h-2.5 w-3 shrink-0 opacity-90" viewBox="0 0 14 10" fill="none" aria-hidden="true">
        <path
          d="M1 5C2.3 1.5 3.7 1.5 5 5C6.3 8.5 7.7 8.5 9 5C10.3 1.5 11.7 1.5 13 5"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === 'envelope') {
    return (
      <svg className="h-2.5 w-3 shrink-0 opacity-90" viewBox="0 0 14 10" fill="none" aria-hidden="true">
        <path d="M2 8L7 3L12 5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="2" cy="8" r="1.2" fill="currentColor" />
        <circle cx="7" cy="3" r="1.2" fill="currentColor" />
        <circle cx="12" cy="5" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className="h-2.5 w-3 shrink-0 opacity-90" viewBox="0 0 14 10" fill="currentColor" aria-hidden="true">
      <rect x="1" y="1.5" width="4.5" height="1.8" rx="0.6" />
      <rect x="5" y="4.2" width="5" height="1.8" rx="0.6" />
      <rect x="8" y="6.9" width="4.5" height="1.8" rx="0.6" />
    </svg>
  );
}

function renderTrackIcon(trackId: string) {
  switch (trackId) {
    case 'vocal':
      return <Mic className="h-3.5 w-3.5 text-emerald-400" />;
    case 'texture':
      return <Waves className="h-3.5 w-3.5 text-cyan-400" />;
    case 'drums':
      return <Drum className="h-3.5 w-3.5 text-amber-400" />;
    case 'bass':
      return <Guitar className="h-3.5 w-3.5 text-violet-400" />;
    case 'harmony':
      return <Piano className="h-3.5 w-3.5 text-sky-400" />;
    default:
      return <Music2 className="h-3.5 w-3.5 text-emerald-300" />;
  }
}

interface ClipDragPreview {
  trackId: 'vocal' | 'texture';
  clipId: string;
  mode: 'move' | 'trim_left' | 'trim_right';
  startClientX: number;
  origStartBar: number;
  origTrimStartSec: number;
  origTrimEndSec?: number;
  bufferDurSec: number;
  previewStartBar: number;
  previewTrimStartSec: number;
  previewTrimEndSec?: number;
  didDrag: boolean;
}

interface TimelineEditorProps {
  project: ProjectState;
  transport: TransportSnapshot;
  tool: 'select' | 'split';
  snapGrid: '1/4' | '1/8' | '1/16';
  chordsDirty: boolean;
  busyJobTrack: string | null;
  isOverdubbing: boolean;
  autoTrimBusy: boolean;
  clipUploadBusy: boolean;
  loopStartBar: number;
  loopEndBar: number;
  selectedTrackId?: string;
  onSelectTrackHeader?: (trackId: string) => void;
  onSeekBar: (bar: number) => void;
  onLoopRegionChange: (startBar: number, endBar: number) => void;
  onMutateWithUndo: (updater: (prev: ProjectState) => ProjectState) => void;
  onMarkChordsDirty: () => void;
  onRearrangeChords: () => void;
  onToggleTrackFlag: (trackId: string, flag: 'mute' | 'solo' | 'locked') => void;
  onRegenerateTrack: (trackId: string) => void;
  onStartOverdub: () => void;
  onAutoTrimVocal: () => void;
  onUploadTextureClip: (file: File) => void;
  onSelectMidiTrack: (trackId: 'drums' | 'bass' | 'harmony' | 'lead') => void;
  getClipDurationSec: (clip: AudioClip, trackId: string) => number;
  onNotice: (msg: string) => void;
}

function getSnapStepBars(snapGrid: '1/4' | '1/8' | '1/16', beatsPerBar: number): number {
  const beatStep = snapGrid === '1/4' ? 1 : snapGrid === '1/8' ? 0.5 : 0.25;
  return beatStep / beatsPerBar;
}

export default function TimelineEditor({
  project,
  transport,
  tool,
  snapGrid,
  chordsDirty,
  busyJobTrack,
  isOverdubbing,
  autoTrimBusy,
  clipUploadBusy,
  loopStartBar,
  loopEndBar,
  selectedTrackId,
  onSelectTrackHeader,
  onSeekBar,
  onLoopRegionChange,
  onMutateWithUndo,
  onMarkChordsDirty,
  onRearrangeChords,
  onToggleTrackFlag,
  onRegenerateTrack,
  onStartOverdub,
  onAutoTrimVocal,
  onUploadTextureClip,
  onSelectMidiTrack,
  getClipDurationSec,
  onNotice,
}: TimelineEditorProps) {
  const textureInputRef = useRef<HTMLInputElement | null>(null);
  const suppressClickUntilRef = useRef<number>(0);
  const engine = useMemo(() => getAudioEngine(), []);

  const [pxPerBar, setPxPerBar] = useState<number>(92);
  const [compactLanes, setCompactLanes] = useState<boolean>(false);
  const [showEnvelopeLane, setShowEnvelopeLane] = useState<boolean>(true);
  const [selectedClipRef, setSelectedClipRef] = useState<{
    trackId: 'vocal' | 'texture';
    clipId: string;
  } | null>(null);
  const [editingChordBar, setEditingChordBar] = useState<number | null>(null);
  const [chordInput, setChordInput] = useState('');
  const [editingSectionIdx, setEditingSectionIdx] = useState<number | null>(null);
  const [sectionDraft, setSectionDraft] = useState<SongSection | null>(null);
  const [addTrackMenuOpen, setAddTrackMenuOpen] = useState(false);
  const [dragPreview, setDragPreview] = useState<ClipDragPreview | null>(null);
  const dragPreviewRef = useRef<ClipDragPreview | null>(null);
  dragPreviewRef.current = dragPreview;

  const totalBars = Math.max(4, project.song_structure.total_bars || 8);
  const beatsPerBar = getBeatsPerBar(project.analysis.time_signature);
  const bpm = Math.max(40, project.analysis.bpm || 100);
  const secPerBar = (beatsPerBar * 60) / bpm;
  const laneWidthPx = totalBars * pxPerBar;

  const currentBarFloat = 1 + transport.currentTimeSec / secPerBar;
  const playheadLeftPx = Math.max(0, Math.min(laneWidthPx, (currentBarFloat - 1) * pxPerBar));

  const trackIds = useMemo(() => {
    const base: Array<'vocal' | 'texture' | 'drums' | 'bass' | 'harmony' | 'lead'> = ['vocal'];
    if (project.tracks.texture) {
      base.push('texture');
    }
    base.push('drums', 'bass', 'harmony', 'lead');
    return base;
  }, [project.tracks.texture]);

  const missingTracks = useMemo(
    () =>
      (Object.keys(TRACK_DEFAULTS) as Array<keyof typeof TRACK_DEFAULTS>).filter(
        (key) => !project.tracks[key]
      ),
    [project.tracks]
  );

  const handleAddTrack = (trackKey: keyof typeof TRACK_DEFAULTS) => {
    const spec = TRACK_DEFAULTS[trackKey];
    setAddTrackMenuOpen(false);
    onMutateWithUndo((prev) => {
      if (prev.tracks[trackKey]) return prev;
      const nextTrack =
        spec.type === 'audio'
          ? {
              type: 'audio' as const,
              locked: false,
              mute: false,
              solo: false,
              volume: spec.volume,
              pan: spec.pan,
              low_db: 0,
              mid_db: 0,
              high_db: 0,
              reverb_send: 0,
              delay_send: 0,
              clips: [],
            }
          : {
              type: 'midi' as const,
              locked: false,
              mute: false,
              solo: false,
              volume: spec.volume,
              pan: spec.pan,
              low_db: 0,
              mid_db: 0,
              high_db: 0,
              reverb_send: 0,
              delay_send: 0,
              instrument: spec.instrument || 'grand_piano',
              notes: [],
            };
      return {
        ...prev,
        tracks: {
          ...prev.tracks,
          [trackKey]: nextTrack,
        },
      };
    });
    onSelectTrackHeader?.(trackKey);
    onNotice(`Đã tạo track ${spec.label}.`);
  };

  const handleClearOrDeleteTrack = (
    trackId: 'vocal' | 'texture' | 'drums' | 'bass' | 'harmony' | 'lead'
  ) => {
    const tr = project.tracks[trackId];
    if (!tr || tr.locked) return;
    if (trackId === 'texture') {
      onMutateWithUndo((prev) => {
        const nextTracks = { ...prev.tracks };
        delete nextTracks.texture;
        return { ...prev, tracks: nextTracks };
      });
      if (selectedClipRef?.trackId === 'texture') setSelectedClipRef(null);
      onNotice('Đã xóa track Texture (Ctrl+Z để hoàn tác).');
      return;
    }
    if (tr.type === 'audio') {
      if (!tr.clips.length) return;
      onMutateWithUndo((prev) => ({
        ...prev,
        tracks: {
          ...prev.tracks,
          [trackId]: { ...tr, clips: [] },
        },
      }));
      if (selectedClipRef?.trackId === trackId) setSelectedClipRef(null);
      onNotice(`Đã xóa toàn bộ clip trên track ${trackId}.`);
      return;
    }
    if (!tr.notes.length) return;
    onMutateWithUndo((prev) => ({
      ...prev,
      tracks: {
        ...prev.tracks,
        [trackId]: { ...tr, notes: [] },
      },
    }));
    onNotice(`Đã xóa toàn bộ nốt MIDI trên track ${trackId}.`);
  };

  const selectedClip: AudioClip | null = useMemo(() => {
    if (!selectedClipRef) return null;
    const tr = project.tracks[selectedClipRef.trackId] as AudioTrackState | undefined;
    if (!tr || tr.type !== 'audio') return null;
    return tr.clips.find((c) => c.id === selectedClipRef.clipId) || null;
  }, [project.tracks, selectedClipRef]);

  const updateAudioClip = (
    trackId: 'vocal' | 'texture',
    clipId: string,
    patch: Partial<AudioClip>
  ) => {
    onMutateWithUndo((prev) => {
      const tr = prev.tracks[trackId] as AudioTrackState | undefined;
      if (!tr || tr.type !== 'audio') return prev;
      return {
        ...prev,
        tracks: {
          ...prev.tracks,
          [trackId]: {
            ...tr,
            clips: tr.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
          },
        },
      };
    });
  };

  useEffect(() => {
    if (!dragPreview) return;

    const handlePointerMove = (e: PointerEvent) => {
      const curr = dragPreviewRef.current;
      if (!curr) return;
      const dxPx = e.clientX - curr.startClientX;
      const didDrag = curr.didDrag || Math.abs(dxPx) >= 4;
      const deltaBars = dxPx / pxPerBar;
      const deltaSec = deltaBars * secPerBar;

      if (curr.mode === 'move') {
        const stepBars = getSnapStepBars(snapGrid, beatsPerBar);
        const rawBar = curr.origStartBar + deltaBars;
        const snapped = Math.max(
          1,
          Math.min(totalBars + 0.5, 1 + Math.round((rawBar - 1) / stepBars) * stepBars)
        );
        setDragPreview({
          ...curr,
          didDrag,
          previewStartBar: Number(snapped.toFixed(3)),
        });
      } else if (curr.mode === 'trim_left') {
        const effectiveEnd = curr.origTrimEndSec ?? curr.bufferDurSec;
        const maxTrimStart = Math.max(0, effectiveEnd - 0.15);
        const minDeltaFromStart = -curr.origTrimStartSec;
        const minDeltaFromBar = -(curr.origStartBar - 1) * secPerBar;
        const clampedDeltaSec = Math.max(
          Math.max(minDeltaFromStart, minDeltaFromBar),
          Math.min(maxTrimStart - curr.origTrimStartSec, deltaSec)
        );
        setDragPreview({
          ...curr,
          didDrag,
          previewTrimStartSec: Number((curr.origTrimStartSec + clampedDeltaSec).toFixed(2)),
          previewStartBar: Number(
            Math.max(1, curr.origStartBar + clampedDeltaSec / secPerBar).toFixed(3)
          ),
        });
      } else if (curr.mode === 'trim_right') {
        const baseEnd = curr.origTrimEndSec ?? curr.bufferDurSec;
        const minEnd = curr.origTrimStartSec + 0.15;
        const maxEnd = Math.max(baseEnd, curr.bufferDurSec);
        setDragPreview({
          ...curr,
          didDrag,
          previewTrimEndSec: Number(Math.max(minEnd, Math.min(maxEnd, baseEnd + deltaSec)).toFixed(2)),
        });
      }
    };

    const handlePointerUp = () => {
      const curr = dragPreviewRef.current;
      setDragPreview(null);
      if (!curr || !curr.didDrag) return;
      suppressClickUntilRef.current = performance.now() + 140;

      if (curr.mode === 'move') {
        if (curr.previewStartBar !== curr.origStartBar) {
          updateAudioClip(curr.trackId, curr.clipId, {
            start_bar: curr.previewStartBar,
          });
          setSelectedClipRef({ trackId: curr.trackId, clipId: curr.clipId });
          onNotice(`Đã di chuyển clip sang Bar ${curr.previewStartBar}.`);
        }
      } else if (curr.mode === 'trim_left') {
        if (
          curr.previewTrimStartSec !== curr.origTrimStartSec ||
          curr.previewStartBar !== curr.origStartBar
        ) {
          updateAudioClip(curr.trackId, curr.clipId, {
            start_bar: curr.previewStartBar,
            trim_start_sec: curr.previewTrimStartSec,
          });
          setSelectedClipRef({ trackId: curr.trackId, clipId: curr.clipId });
          onNotice(`Đã cắt đầu clip tại ${curr.previewTrimStartSec.toFixed(2)}s.`);
        }
      } else if (curr.mode === 'trim_right') {
        if (curr.previewTrimEndSec !== curr.origTrimEndSec) {
          updateAudioClip(curr.trackId, curr.clipId, {
            trim_end_sec: curr.previewTrimEndSec,
          });
          setSelectedClipRef({ trackId: curr.trackId, clipId: curr.clipId });
          onNotice(`Đã cắt cuối clip tại ${(curr.previewTrimEndSec ?? 0).toFixed(2)}s.`);
        }
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [Boolean(dragPreview), snapGrid, beatsPerBar, secPerBar, totalBars, pxPerBar]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDuplicateClip = (trackId: 'vocal' | 'texture', clip: AudioClip) => {
    const rawDurSec = getClipDurationSec(clip, trackId);
    const clipLenBars = Math.max(0.5, rawDurSec / secPerBar);
    const nextStartBar = Number(Math.min(totalBars, clip.start_bar + clipLenBars).toFixed(2));
    const dup: AudioClip = {
      ...clip,
      id: `clip_${trackId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      start_bar: nextStartBar,
    };
    onMutateWithUndo((prev) => {
      const tr = prev.tracks[trackId] as AudioTrackState | undefined;
      if (!tr || tr.type !== 'audio') return prev;
      return {
        ...prev,
        tracks: {
          ...prev.tracks,
          [trackId]: { ...tr, clips: [...tr.clips, dup] },
        },
      };
    });
    setSelectedClipRef({ trackId, clipId: dup.id });
    onNotice(`Đã nhân bản clip tại Bar ${nextStartBar}.`);
  };

  const handleDeleteClip = (trackId: 'vocal' | 'texture', clipId: string) => {
    onMutateWithUndo((prev) => {
      const tr = prev.tracks[trackId] as AudioTrackState | undefined;
      if (!tr || tr.type !== 'audio') return prev;
      return {
        ...prev,
        tracks: {
          ...prev.tracks,
          [trackId]: { ...tr, clips: tr.clips.filter((c) => c.id !== clipId) },
        },
      };
    });
    if (selectedClipRef?.clipId === clipId) {
      setSelectedClipRef(null);
    }
  };

  useEffect(() => {
    if (!selectedClipRef) return;
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
      handleDeleteClip(selectedClipRef.trackId, selectedClipRef.clipId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedClipRef]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSplitClipAtClientX = (
    e: React.MouseEvent<HTMLDivElement>,
    trackId: 'vocal' | 'texture',
    clip: AudioClip,
    laneElement: HTMLDivElement | null
  ) => {
    e.stopPropagation();
    if (!laneElement) return;
    const rect = laneElement.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(laneWidthPx, e.clientX - rect.left));
    const rawClickBar = 1 + clickX / pxPerBar;
    const stepBars = getSnapStepBars(snapGrid, beatsPerBar);
    const snappedBar = Number(
      (1 + Math.round((rawClickBar - 1) / stepBars) * stepBars).toFixed(3)
    );

    const clipStartSec = (clip.start_bar - 1) * secPerBar + (clip.offset_ms ?? 0) / 1000;
    const durSec = getClipDurationSec(clip, trackId);
    const splitTimeSec = (snappedBar - 1) * secPerBar;
    const deltaSec = splitTimeSec - clipStartSec;

    if (deltaSec <= 0.05 || deltaSec >= durSec - 0.05) {
      onNotice('Vị trí cắt quá sát mép clip (cần tối thiểu 0.05s mỗi phần).');
      return;
    }

    const splitSourceSec = Number(((clip.trim_start_sec || 0) + deltaSec).toFixed(3));
    const suffix = `${Date.now().toString(36)}`;
    const clipA: AudioClip = {
      ...clip,
      id: `${clip.id}_a_${suffix}`,
      trim_end_sec: splitSourceSec,
      fade_out_ms: clip.fade_out_ms ?? 20,
    };
    const clipB: AudioClip = {
      ...clip,
      id: `${clip.id}_b_${suffix}`,
      start_bar: snappedBar,
      offset_ms: 0,
      trim_start_sec: splitSourceSec,
      trim_end_sec: clip.trim_end_sec,
      fade_in_ms: clip.fade_in_ms ?? 20,
    };

    onMutateWithUndo((prev) => {
      const tr = prev.tracks[trackId] as AudioTrackState | undefined;
      if (!tr || tr.type !== 'audio') return prev;
      const idx = tr.clips.findIndex((c) => c.id === clip.id);
      const nextClips =
        idx >= 0
          ? [...tr.clips.slice(0, idx), clipA, clipB, ...tr.clips.slice(idx + 1)]
          : [...tr.clips, clipA, clipB];
      return {
        ...prev,
        tracks: {
          ...prev.tracks,
          [trackId]: { ...tr, clips: nextClips },
        },
      };
    });
    setSelectedClipRef({ trackId, clipId: clipB.id });
    onNotice(`Đã cắt clip thành 2 đoạn tại Bar ${snappedBar.toFixed(2)}.`);
  };

  const handleRulerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(laneWidthPx, e.clientX - rect.left));
    const rawBar = 1 + clickX / pxPerBar;
    const stepBars = getSnapStepBars(snapGrid, beatsPerBar);
    const snappedBar = Math.max(
      1,
      Math.min(totalBars + 0.99, 1 + Math.round((rawBar - 1) / stepBars) * stepBars)
    );
    onSeekBar(snappedBar);
  };

  const handleAddSection = () => {
    const last = project.song_structure.sections[project.song_structure.sections.length - 1];
    const startBar = last ? last.start_bar + last.bars : 1;
    const newSec: SongSection = {
      name: 'Bridge',
      start_bar: startBar,
      bars: 4,
      energy: 0.75,
    };
    onMutateWithUndo((prev) => {
      const nextSections = [...prev.song_structure.sections, newSec];
      const maxEnd = Math.max(
        4,
        prev.song_structure.total_bars,
        ...nextSections.map((s) => s.start_bar + s.bars - 1)
      );
      return {
        ...prev,
        song_structure: {
          ...prev.song_structure,
          total_bars: maxEnd,
          sections: nextSections,
        },
      };
    });
    onMarkChordsDirty();
  };

  const handleSaveSectionEdit = () => {
    if (editingSectionIdx === null || !sectionDraft) return;
    onMutateWithUndo((prev) => {
      const nextSections = [...prev.song_structure.sections];
      nextSections[editingSectionIdx] = {
        ...sectionDraft,
        start_bar: Math.max(1, Math.round(sectionDraft.start_bar)),
        bars: Math.max(1, Math.round(sectionDraft.bars)),
      };
      const maxEnd = nextSections.length
        ? Math.max(4, ...nextSections.map((s) => s.start_bar + s.bars - 1))
        : prev.song_structure.total_bars;
      return {
        ...prev,
        song_structure: {
          ...prev.song_structure,
          total_bars: maxEnd,
          sections: nextSections,
        },
      };
    });
    onMarkChordsDirty();
    setEditingSectionIdx(null);
    setSectionDraft(null);
  };

  const handleDeleteSection = (idx: number) => {
    onMutateWithUndo((prev) => {
      const nextSections = prev.song_structure.sections.filter((_, i) => i !== idx);
      const maxEnd = nextSections.length
        ? Math.max(4, ...nextSections.map((s) => s.start_bar + s.bars - 1))
        : prev.song_structure.total_bars;
      return {
        ...prev,
        song_structure: {
          ...prev.song_structure,
          total_bars: maxEnd,
          sections: nextSections,
        },
      };
    });
    onMarkChordsDirty();
    setEditingSectionIdx(null);
    setSectionDraft(null);
  };

  const handleDeleteChordForBar = (barNum: number) => {
    const hadChord = project.song_structure.chords.some((c) => c.bar === barNum);
    if (hadChord) {
      onMutateWithUndo((prev) => ({
        ...prev,
        song_structure: {
          ...prev.song_structure,
          chords: prev.song_structure.chords.filter((c) => c.bar !== barNum),
        },
      }));
      onMarkChordsDirty();
      onNotice(`Đã xóa hợp âm tại Bar ${barNum}.`);
    }
    setEditingChordBar(null);
  };

  const handleSaveChordForBar = (barNum: number) => {
    const sym = chordInput.trim();
    if (!sym) {
      handleDeleteChordForBar(barNum);
      return;
    }
    onMutateWithUndo((prev) => {
      const existingIdx = prev.song_structure.chords.findIndex((c) => c.bar === barNum);
      const nextChords: ChordEvent[] = [...prev.song_structure.chords];
      if (existingIdx >= 0) {
        nextChords[existingIdx] = { ...nextChords[existingIdx], symbol: sym };
      } else {
        nextChords.push({ bar: barNum, beat: 1, symbol: sym, duration_beats: beatsPerBar });
        nextChords.sort((a, b) => a.bar - b.bar);
      }
      return {
        ...prev,
        song_structure: { ...prev.song_structure, chords: nextChords },
      };
    });
    onMarkChordsDirty();
    setEditingChordBar(null);
  };

  const handleTextureFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const err = validateAudioFileClient(file);
    if (err) {
      onNotice(err);
      return;
    }
    onUploadTextureClip(file);
  };

  const baseVocalRef =
    project.audio_assets.tuned_vocal_ref ||
    project.audio_assets.dry_denoised_ref ||
    project.audio_assets.raw_input_ref;

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-white/10 bg-[#16191f]">
      <label htmlFor="timeline-texture-upload" className="sr-only">
        Tải lên mẫu âm thanh Texture
      </label>
      <input
        id="timeline-texture-upload"
        name="textureSample"
        ref={textureInputRef}
        type="file"
        accept=".wav,.mp3,.m4a,.ogg,.flac,audio/*"
        className="sr-only"
        onChange={handleTextureFileSelected}
      />

      {/* DAW Arrangement Header Toolbar */}
      <div className="flex items-center justify-between gap-2 overflow-x-auto border-b border-white/10 bg-[#1b1e25] px-2.5 py-1">
        <div className="flex shrink-0 items-center gap-2 text-xs">
          <span className="font-display text-[11px] font-bold uppercase tracking-wider text-slate-200">
            Arrangement ({totalBars}b)
          </span>
          <span className="text-slate-600">|</span>

          <div className="flex items-center gap-1 text-[11px] text-slate-300">
            <span className="text-slate-400">Loop:</span>
            <label htmlFor="timeline-loop-start" className="flex items-center gap-0.5">
              <span>B</span>
              <input
                id="timeline-loop-start"
                name="loopStartBar"
                type="number"
                min={1}
                max={Math.max(1, loopEndBar - 1)}
                value={loopStartBar}
                onChange={(e) => {
                  const s = Math.max(1, Math.min(totalBars - 1, Number(e.target.value) || 1));
                  onLoopRegionChange(s, Math.max(s + 1, loopEndBar));
                }}
                className="w-9 rounded border border-white/15 bg-[#0b0d11] px-1 py-0.5 text-center font-mono tabular-nums text-white"
              />
            </label>
            <span>–</span>
            <label htmlFor="timeline-loop-end" className="flex items-center gap-0.5">
              <input
                id="timeline-loop-end"
                name="loopEndBar"
                aria-label="Loop End Bar"
                type="number"
                min={loopStartBar + 1}
                max={totalBars + 1}
                value={loopEndBar}
                onChange={(e) => {
                  const endVal = Math.max(
                    loopStartBar + 1,
                    Math.min(totalBars + 1, Number(e.target.value) || totalBars + 1)
                  );
                  onLoopRegionChange(loopStartBar, endVal);
                }}
                className="w-9 rounded border border-white/15 bg-[#0b0d11] px-1 py-0.5 text-center font-mono tabular-nums text-white"
              />
            </label>
          </div>

          {/* Horizontal Timeline Zoom Control */}
          <div className="flex items-center gap-1 rounded border border-white/10 bg-[#111317] px-1.5 py-0.5">
            <button
              type="button"
              aria-label="Thu nhỏ Timeline"
              onClick={() => setPxPerBar((z) => Math.max(48, z - 16))}
              className="rounded p-0.5 text-slate-300 hover:bg-white/10"
            >
              <ZoomOut className="h-3 w-3" />
            </button>
            <input
              id="timeline-zoom-range"
              name="timelineZoom"
              aria-label="Phóng to thu nhỏ Timeline"
              type="range"
              min={48}
              max={164}
              value={pxPerBar}
              onChange={(e) => setPxPerBar(Number(e.target.value))}
              className="w-14 accent-amber-400"
            />
            <button
              type="button"
              aria-label="Phóng to Timeline"
              onClick={() => setPxPerBar((z) => Math.min(164, z + 16))}
              className="rounded p-0.5 text-slate-300 hover:bg-white/10"
            >
              <ZoomIn className="h-3 w-3" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setCompactLanes((c) => !c)}
            title="Chuyển độ cao làn Track (Gọn / Cao)"
            className={`rounded border px-2 py-0.5 text-[10px] font-semibold transition ${
              !compactLanes
                ? 'border-amber-400/40 bg-amber-500/15 text-amber-200'
                : 'border-white/10 bg-[#111317] text-slate-300 hover:bg-white/10'
            }`}
          >
            {compactLanes ? 'Track Gọn' : 'Track Cao'}
          </button>

          <button
            type="button"
            onClick={() => setShowEnvelopeLane((s) => !s)}
            title="Bật/tắt đường cong Dynamics Automation Envelope theo từng Section"
            className={`rounded border px-2 py-0.5 text-[10px] font-semibold transition ${
              showEnvelopeLane
                ? 'border-sky-400/50 bg-sky-500/15 text-sky-200'
                : 'border-white/10 bg-[#111317] text-slate-400 hover:bg-white/10'
            }`}
          >
            Envelope
          </button>

          {tool === 'split' && (
            <span className="flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-200">
              <Scissors className="h-3 w-3" /> Cắt ({snapGrid})
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {chordsDirty && (
            <div className="flex items-center gap-1.5">
              <span className="flex items-center gap-1 text-[10px] text-amber-300">
                <AlertTriangle className="h-3 w-3" /> Hòa âm đổi
              </span>
              <button
                type="button"
                disabled={busyJobTrack === 'rearrange'}
                onClick={onRearrangeChords}
                className="rounded bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {busyJobTrack === 'rearrange' ? 'Đang tạo...' : 'Cập nhật đệm'}
              </button>
            </div>
          )}

          <button
            type="button"
            disabled={autoTrimBusy || !baseVocalRef}
            onClick={onAutoTrimVocal}
            title="AI cắt khoảng lặng & căn nhịp Vocal Clip"
            className="flex items-center gap-1 rounded border border-emerald-500/35 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-200 transition hover:bg-emerald-500/25 disabled:opacity-40"
          >
            <Sparkles className="h-3 w-3" />
            <span>{autoTrimBusy ? 'Auto-Trim...' : 'Auto-Trim'}</span>
          </button>

          {missingTracks.length > 0 && (
            <button
              type="button"
              onClick={() => setAddTrackMenuOpen((o) => !o)}
              title="Thêm Track mới vào Arrangement"
              className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-semibold transition ${
                addTrackMenuOpen
                  ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                  : 'border-white/15 bg-[#111317] text-slate-200 hover:bg-white/10'
              }`}
            >
              <Plus className="h-3 w-3" />
              <span>Track</span>
            </button>
          )}

          <button
            type="button"
            disabled={clipUploadBusy}
            onClick={() => textureInputRef.current?.click()}
            title="Import audio sample vào track Texture"
            className="flex items-center gap-1 rounded border border-cyan-500/35 bg-cyan-500/15 px-2 py-0.5 text-[10px] font-semibold text-cyan-200 transition hover:bg-cyan-500/25 disabled:opacity-40"
          >
            <FolderPlus className="h-3 w-3" />
            <span>{clipUploadBusy ? 'Đang tải...' : '+ Sample'}</span>
          </button>
        </div>
      </div>

      {/* Add Track Inline Bar */}
      {addTrackMenuOpen && missingTracks.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-[#1e222b] px-3 py-1.5 text-xs">
          <span className="font-semibold text-amber-300">Thêm Track:</span>
          {missingTracks.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => handleAddTrack(k)}
              className="flex items-center gap-1 rounded border border-white/15 bg-[#111317] px-2.5 py-0.5 text-[11px] font-medium text-slate-100 hover:border-amber-400/60 hover:text-amber-200"
            >
              <Plus className="h-3 w-3 text-amber-400" />
              <span>{TRACK_DEFAULTS[k].label}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setAddTrackMenuOpen(false)}
            className="ml-auto text-slate-400 hover:text-white"
          >
            Đóng
          </button>
        </div>
      )}

      {/* Inline Section Editor Popover */}
      {editingSectionIdx !== null && sectionDraft && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-[#21252e] px-3 py-1.5 text-xs">
          <span className="font-semibold text-amber-300">Section:</span>
          <select
            aria-label="Chọn mẫu tên Section"
            value={SECTION_PRESETS.includes(sectionDraft.name) ? sectionDraft.name : 'Custom'}
            onChange={(e) => {
              if (e.target.value !== 'Custom') {
                setSectionDraft({ ...sectionDraft, name: e.target.value });
              }
            }}
            className="rounded border border-white/15 bg-[#0b0d11] px-2 py-0.5 text-xs text-white"
          >
            {SECTION_PRESETS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            {!SECTION_PRESETS.includes(sectionDraft.name) && <option value="Custom">Custom</option>}
          </select>
          <input
            aria-label="Tên Section"
            type="text"
            value={sectionDraft.name}
            onChange={(e) => setSectionDraft({ ...sectionDraft, name: e.target.value })}
            placeholder="Tên đoạn"
            className="w-24 rounded border border-white/15 bg-[#0b0d11] px-2 py-0.5 text-xs text-white"
          />
          <label htmlFor="section-start-bar" className="flex items-center gap-1 text-slate-300">
            Start:
            <input
              id="section-start-bar"
              name="sectionStartBar"
              type="number"
              min={1}
              max={totalBars}
              value={sectionDraft.start_bar}
              onChange={(e) =>
                setSectionDraft({ ...sectionDraft, start_bar: Number(e.target.value) || 1 })
              }
              className="w-12 rounded border border-white/15 bg-[#0b0d11] px-1 py-0.5 text-center font-mono text-white"
            />
          </label>
          <label htmlFor="section-length-bars" className="flex items-center gap-1 text-slate-300">
            Bars:
            <input
              id="section-length-bars"
              name="sectionLengthBars"
              type="number"
              min={1}
              max={totalBars}
              value={sectionDraft.bars}
              onChange={(e) =>
                setSectionDraft({ ...sectionDraft, bars: Number(e.target.value) || 1 })
              }
              className="w-12 rounded border border-white/15 bg-[#0b0d11] px-1 py-0.5 text-center font-mono text-white"
            />
          </label>
          <label htmlFor="section-energy-pct" className="flex items-center gap-1 text-slate-300">
            Energy%:
            <input
              id="section-energy-pct"
              name="sectionEnergyPct"
              type="number"
              min={10}
              max={100}
              step={5}
              value={Math.round((sectionDraft.energy ?? 0.75) * 100)}
              onChange={(e) =>
                setSectionDraft({
                  ...sectionDraft,
                  energy: Math.max(0.1, Math.min(1, (Number(e.target.value) || 75) / 100)),
                })
              }
              className="w-14 rounded border border-white/15 bg-[#0b0d11] px-1 py-0.5 text-center font-mono text-white"
            />
          </label>
          <button
            type="button"
            onClick={handleSaveSectionEdit}
            className="rounded bg-amber-500 px-2.5 py-0.5 font-bold text-slate-950 hover:bg-amber-400"
          >
            Lưu
          </button>
          <button
            type="button"
            onClick={() => handleDeleteSection(editingSectionIdx)}
            className="rounded bg-rose-500/20 px-2 py-0.5 text-rose-300 hover:bg-rose-500/35"
          >
            Xóa
          </button>
          <button
            type="button"
            onClick={() => {
              setEditingSectionIdx(null);
              setSectionDraft(null);
            }}
            className="text-slate-400 hover:text-white"
          >
            Hủy
          </button>
        </div>
      )}

      {/* Selected Audio Clip Inspector */}
      {selectedClip && selectedClipRef && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-[#1f232c] px-3 py-1.5 text-[11px]">
          <span className="font-mono font-bold text-emerald-300">
            CLIP: {selectedClipRef.trackId.toUpperCase()}
          </span>

          <div className="flex items-center gap-1 text-slate-300">
            <label htmlFor="clip-start-bar-input">Bar</label>
            <button
              type="button"
              onClick={() =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  start_bar: Math.max(1, Number((selectedClip.start_bar - 0.25).toFixed(2))),
                })
              }
              className="rounded bg-white/10 px-1.5 py-0.5 hover:bg-white/20"
            >
              -0.25
            </button>
            <input
              id="clip-start-bar-input"
              name="clipStartBar"
              type="number"
              step={0.25}
              min={1}
              max={totalBars}
              value={selectedClip.start_bar}
              onChange={(e) =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  start_bar: Math.max(1, Number(e.target.value) || 1),
                })
              }
              className="w-14 rounded border border-white/15 bg-[#0b0d11] px-1 py-0.5 text-center font-mono text-white"
            />
            <button
              type="button"
              onClick={() =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  start_bar: Math.min(totalBars, Number((selectedClip.start_bar + 0.25).toFixed(2))),
                })
              }
              className="rounded bg-white/10 px-1.5 py-0.5 hover:bg-white/20"
            >
              +0.25
            </button>
          </div>

          <div className="flex items-center gap-1 text-slate-300">
            <label htmlFor="clip-offset-ms-input">Offset(ms)</label>
            <button
              type="button"
              onClick={() =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  offset_ms: Math.round((selectedClip.offset_ms ?? 0) - 25),
                })
              }
              className="rounded bg-white/10 px-1.5 py-0.5 hover:bg-white/20"
            >
              -25
            </button>
            <input
              id="clip-offset-ms-input"
              name="clipOffsetMs"
              type="number"
              step={5}
              value={selectedClip.offset_ms ?? 0}
              onChange={(e) =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  offset_ms: Number(e.target.value) || 0,
                })
              }
              className="w-14 rounded border border-white/15 bg-[#0b0d11] px-1 py-0.5 text-center font-mono text-white"
            />
            <button
              type="button"
              onClick={() =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  offset_ms: Math.round((selectedClip.offset_ms ?? 0) + 25),
                })
              }
              className="rounded bg-white/10 px-1.5 py-0.5 hover:bg-white/20"
            >
              +25
            </button>
          </div>

          <label htmlFor="clip-trim-start-input" className="flex items-center gap-1 text-slate-300">
            <span>Trim(s)</span>
            <input
              id="clip-trim-start-input"
              name="clipTrimStart"
              type="number"
              step={0.05}
              min={0}
              value={selectedClip.trim_start_sec}
              onChange={(e) =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  trim_start_sec: Math.max(0, Number(e.target.value) || 0),
                })
              }
              className="w-12 rounded border border-white/15 bg-[#0b0d11] px-1 py-0.5 text-center font-mono text-white"
            />
          </label>
          <input
            id="clip-trim-end-input"
            aria-label="Trim End (seconds)"
            name="clipTrimEnd"
            type="number"
            step={0.05}
            min={0}
            placeholder="end"
            value={selectedClip.trim_end_sec ?? ''}
            onChange={(e) =>
              updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                trim_end_sec: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)),
              })
            }
            className="w-12 rounded border border-white/15 bg-[#0b0d11] px-1 py-0.5 text-center font-mono text-white"
          />

          <div className="flex items-center gap-1 text-slate-300">
            <label htmlFor="clip-fade-in-input">Fade</label>
            <input
              id="clip-fade-in-input"
              name="clipFadeIn"
              type="number"
              step={10}
              min={0}
              value={selectedClip.fade_in_ms}
              onChange={(e) =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  fade_in_ms: Math.max(0, Number(e.target.value) || 0),
                })
              }
              className="w-12 rounded border border-white/15 bg-[#0b0d11] px-1 py-0.5 text-center font-mono text-white"
            />
            <input
              id="clip-fade-out-input"
              aria-label="Fade Out (milliseconds)"
              name="clipFadeOut"
              type="number"
              step={10}
              min={0}
              value={selectedClip.fade_out_ms ?? 20}
              onChange={(e) =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  fade_out_ms: Math.max(0, Number(e.target.value) || 0),
                })
              }
              className="w-12 rounded border border-white/15 bg-[#0b0d11] px-1 py-0.5 text-center font-mono text-white"
            />
          </div>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => handleDuplicateClip(selectedClipRef.trackId, selectedClip)}
              className="flex items-center gap-1 rounded bg-sky-500/20 px-2 py-0.5 text-sky-200 hover:bg-sky-500/35"
            >
              <Copy className="h-3 w-3" /> Nhân bản
            </button>
            <button
              type="button"
              onClick={() => handleDeleteClip(selectedClipRef.trackId, selectedClip.id)}
              className="flex items-center gap-1 rounded bg-rose-500/20 px-2 py-0.5 text-rose-200 hover:bg-rose-500/35"
            >
              <Trash2 className="h-3 w-3" /> Xóa
            </button>
          </div>
        </div>
      )}

      {/* Scrollable Multi-Track DAW Grid */}
      <div className="flex-1 overflow-auto bg-[#111317]">
        <div className="relative" style={{ minWidth: `${TRACK_COL_WIDTH + laneWidthPx + 24}px` }}>
          {/* Bar Ruler */}
          <div className="sticky top-0 z-20 flex border-b border-white/10 bg-[#171a20]">
            <div
              className="sticky left-0 z-30 flex shrink-0 items-center justify-between border-r border-white/10 bg-[#171a20] px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400"
              style={{ width: `${TRACK_COL_WIDTH}px` }}
            >
              <span>Timebase</span>
              <span className="font-mono tabular-nums text-amber-300">
                {bpm} BPM • {project.analysis.time_signature}
              </span>
            </div>

            <div
              onClick={handleRulerClick}
              title="Bấm để di chuyển Playhead"
              className="relative h-7 cursor-pointer select-none"
              style={{ width: `${laneWidthPx}px` }}
            >
              {loopEndBar > loopStartBar && (
                <div
                  className={`pointer-events-none absolute top-0 bottom-0 border-x-2 ${
                    transport.loopEnabled
                      ? 'border-amber-400 bg-amber-400/15'
                      : 'border-slate-500/40 bg-slate-700/15'
                  }`}
                  style={{
                    left: `${(loopStartBar - 1) * pxPerBar}px`,
                    width: `${(loopEndBar - loopStartBar) * pxPerBar}px`,
                  }}
                />
              )}

              {Array.from({ length: totalBars }, (_, idx) => {
                const barNum = idx + 1;
                return (
                  <div
                    key={barNum}
                    className="absolute top-0 bottom-0 border-l border-white/20 pl-1.5 pt-0.5 font-mono text-[10px] font-bold tabular-nums text-slate-300"
                    style={{ left: `${idx * pxPerBar}px`, width: `${pxPerBar}px` }}
                  >
                    {barNum}
                    <div className="mt-0.5 flex justify-between pr-2 opacity-35">
                      {Array.from({ length: beatsPerBar }, (_, b) => (
                        <span key={b} className="h-1.5 w-px bg-slate-400" />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Row 1: Sections */}
          <div className="flex border-b border-white/[0.06] bg-[#15181e]">
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center justify-between border-r border-white/10 bg-[#191c23] px-3 py-1"
              style={{ width: `${TRACK_COL_WIDTH}px` }}
            >
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Sections
              </span>
              <button
                type="button"
                onClick={handleAddSection}
                className="flex items-center gap-0.5 rounded border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-slate-200 hover:bg-white/15"
              >
                <Plus className="h-3 w-3" /> Section
              </button>
            </div>
            <div className="relative h-7" style={{ width: `${laneWidthPx}px` }}>
              {project.song_structure.sections.map((sec, idx) => {
                const left = Math.max(0, (sec.start_bar - 1) * pxPerBar);
                const width = Math.max(36, sec.bars * pxPerBar - 2);
                const isChorus = sec.name.toLowerCase().includes('chorus');
                return (
                  <button
                    key={`${sec.name}_${idx}`}
                    type="button"
                    onClick={() => {
                      setEditingSectionIdx(idx);
                      setSectionDraft({ ...sec });
                    }}
                    title="Bấm để chỉnh sửa Section"
                    style={{ left: `${left}px`, width: `${width}px` }}
                    className={`absolute top-1 bottom-1 truncate rounded px-2 text-left text-[10px] font-bold transition ${
                      sec.has_user_motif
                        ? 'bg-amber-500/30 text-amber-100 ring-1 ring-amber-400/60'
                        : isChorus
                        ? 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40'
                        : 'bg-white/[0.08] text-slate-200 hover:bg-white/15'
                    }`}
                  >
                    {sec.name} ({sec.bars}b)
                  </button>
                );
              })}
            </div>
          </div>

          {/* Row 2: Chord Track */}
          <div className="flex border-b border-white/10 bg-[#13151a]">
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center justify-between border-r border-white/10 bg-[#171a20] px-3 py-1"
              style={{ width: `${TRACK_COL_WIDTH}px` }}
            >
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Chord Track
              </span>
              <span className="text-[10px] text-slate-400">Bấm ô để sửa</span>
            </div>
            <div className="relative h-7" style={{ width: `${laneWidthPx}px` }}>
              {Array.from({ length: totalBars }, (_, idx) => {
                const barNum = idx + 1;
                const ch = project.song_structure.chords.find((c) => c.bar === barNum);
                const isEditing = editingChordBar === barNum;
                return (
                  <div
                    key={barNum}
                    className="absolute top-1 bottom-1 px-0.5"
                    style={{ left: `${idx * pxPerBar}px`, width: `${pxPerBar}px` }}
                  >
                    {isEditing ? (
                      <div className="flex h-full items-center gap-0.5">
                        <input
                          autoFocus
                          aria-label={`Hợp âm ô nhịp ${barNum}`}
                          value={chordInput}
                          onChange={(e) => setChordInput(e.target.value)}
                          onBlur={() => handleSaveChordForBar(barNum)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                            if (e.key === 'Escape') setEditingChordBar(null);
                          }}
                          className="h-full min-w-0 flex-1 rounded border border-amber-400 bg-[#0b0d11] px-1 text-center font-mono text-xs font-bold text-white"
                        />
                        {ch && (
                          <button
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              handleDeleteChordForBar(barNum);
                            }}
                            aria-label={`Xóa hợp âm Bar ${barNum}`}
                            title="Xóa hợp âm ô này"
                            className="flex h-full shrink-0 items-center justify-center rounded border border-rose-500/40 bg-rose-500/20 px-1 text-[10px] font-bold text-rose-200 hover:bg-rose-500/40"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingChordBar(barNum);
                          setChordInput(ch?.symbol || '');
                        }}
                        className={`h-full w-full rounded border text-center font-mono text-[11px] font-bold transition ${
                          ch
                            ? 'border-white/10 bg-[#1d2129] text-sky-300 hover:border-amber-400/60'
                            : 'border-dashed border-white/10 text-slate-600 hover:border-white/25 hover:text-slate-300'
                        }`}
                      >
                        {ch ? ch.symbol : '+'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Track Rows + Vertical Playhead */}
          <div className="relative divide-y divide-white/[0.08]">
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-[2px] bg-emerald-400 shadow-[0_0_8px_rgba(74,222,128,0.85)]"
              style={{ left: `${TRACK_COL_WIDTH + playheadLeftPx}px` }}
            >
              <span className="absolute -top-1 -left-[5px] h-0 w-0 border-x-[6px] border-t-[7px] border-x-transparent border-t-emerald-400" />
            </div>

            {showEnvelopeLane && project.song_structure.sections.length > 0 && (
              <AutomationEnvelopeLane
                sections={project.song_structure.sections}
                vocalAutomation={project.tracks.vocal?.automation}
                totalBars={totalBars}
                beatsPerBar={beatsPerBar}
                pxPerBar={pxPerBar}
                laneWidthPx={laneWidthPx}
                compact={compactLanes}
                onUpdateSectionEnergy={(idx, nextEnergy, commit) => {
                  if (commit) {
                    onMutateWithUndo((prev) => ({
                      ...prev,
                      song_structure: {
                        ...prev.song_structure,
                        sections: prev.song_structure.sections.map((s, i) =>
                          i === idx ? { ...s, energy: nextEnergy } : s
                        ),
                      },
                    }));
                    onNotice(
                      `Cập nhật Dynamics ${project.song_structure.sections[idx]?.name || 'Section'}: ${Math.round(nextEnergy * 100)}%`
                    );
                  }
                }}
                onUpdateTrackAutomation={(param, points) => {
                  onMutateWithUndo((prev) => ({
                    ...prev,
                    tracks: {
                      ...prev.tracks,
                      vocal: {
                        ...prev.tracks.vocal,
                        automation: {
                          ...(prev.tracks.vocal?.automation || {}),
                          [param]: points,
                        },
                      },
                    },
                  }));
                  onNotice(`Đã cập nhật đường cong Automation Vocal (${param.toUpperCase()}).`);
                }}
              />
            )}

            {trackIds.map((trackId) => {
              const track = project.tracks[trackId];
              if (!track) return null;

              const isAudio = track.type === 'audio';
              const audioClips: AudioClip[] = isAudio ? track.clips || [] : [];
              const style = TRACK_STYLE[trackId] || TRACK_STYLE.harmony;
              const peakDb = transport.channelPeakDb?.[trackId] ?? -60;
              const meterPct =
                track.mute || !transport.isPlaying
                  ? 0
                  : Math.max(0, Math.min(100, ((peakDb + 54) / 54) * 100));
              const isSelectedRow = selectedTrackId === trackId;

              return (
                <div key={trackId} className="flex bg-[#121419]">
                  {/* DAW Track Control Strip */}
                  <div
                    onClick={() => onSelectTrackHeader?.(trackId)}
                    className={`sticky left-0 z-10 relative flex shrink-0 cursor-pointer flex-col justify-between border-r border-white/10 pl-3.5 pr-2 transition ${
                      compactLanes ? 'py-1' : 'py-2'
                    } ${isSelectedRow ? 'bg-[#232732]' : 'bg-[#191c23] hover:bg-[#1f232c]'}`}
                    style={{ width: `${TRACK_COL_WIDTH}px` }}
                  >
                    <span className={`absolute top-1 bottom-1 left-1 w-1 rounded-sm ${style.accentBar}`} />

                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {renderTrackIcon(trackId)}
                        <span className="truncate text-[11px] font-bold uppercase tracking-wide text-white">
                          {trackId}
                        </span>
                      </div>
                      <span className="truncate text-[10px] font-medium text-slate-400">
                        {isAudio ? `${audioClips.length} clip` : track.instrument || 'midi'}
                      </span>
                    </div>

                    {/* Mini Live Signal Meter inside Track Header */}
                    <div className="my-0.5 h-1 w-full overflow-hidden rounded-full bg-black/50">
                      <div
                        className="h-full bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500 transition-[width] duration-75"
                        style={{ width: `${meterPct}%` }}
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleTrackFlag(trackId, 'mute');
                        }}
                        title="Mute track"
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold transition ${
                          track.mute
                            ? 'bg-rose-500 text-white'
                            : 'bg-white/[0.08] text-slate-400 hover:text-white'
                        }`}
                      >
                        M
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleTrackFlag(trackId, 'solo');
                        }}
                        title="Solo track"
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold transition ${
                          track.solo
                            ? 'bg-amber-400 text-slate-950'
                            : 'bg-white/[0.08] text-slate-400 hover:text-white'
                        }`}
                      >
                        S
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleTrackFlag(trackId, 'locked');
                        }}
                        title={track.locked ? 'Đã khóa track' : 'Khóa track'}
                        aria-label={track.locked ? `Mở khóa track ${trackId}` : `Khóa track ${trackId}`}
                        className={`rounded p-0.5 transition ${
                          track.locked
                            ? 'bg-sky-500 text-slate-950'
                            : 'bg-white/[0.08] text-slate-400 hover:text-white'
                        }`}
                      >
                        {track.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                      </button>

                      {(trackId === 'texture' ||
                        (isAudio ? audioClips.length > 0 : (track as { notes: MidiNote[] }).notes.length > 0)) && (
                        <button
                          type="button"
                          disabled={track.locked}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleClearOrDeleteTrack(trackId);
                          }}
                          title={
                            trackId === 'texture'
                              ? 'Xóa track Texture'
                              : isAudio
                              ? `Xóa tất cả clip track ${trackId}`
                              : `Xóa tất cả nốt MIDI track ${trackId}`
                          }
                          aria-label={
                            trackId === 'texture'
                              ? 'Xóa track texture'
                              : `Làm trống track ${trackId}`
                          }
                          className="rounded p-0.5 text-slate-400 transition hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-35"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}

                      {trackId === 'vocal' ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onStartOverdub();
                          }}
                          className={`ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold transition ${
                            isOverdubbing
                              ? 'animate-pulse bg-rose-600 text-white'
                              : 'bg-rose-500/20 text-rose-300 hover:bg-rose-500/35'
                          }`}
                        >
                          <Mic className="h-3 w-3" />
                          <span>{isOverdubbing ? 'Dừng' : 'Rec Mic'}</span>
                        </button>
                      ) : trackId === 'texture' ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            textureInputRef.current?.click();
                          }}
                          className="ml-auto flex items-center gap-1 rounded bg-cyan-500/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-200 hover:bg-cyan-500/35"
                        >
                          <Plus className="h-3 w-3" />
                          <span>Sample</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={track.locked || busyJobTrack === trackId}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRegenerateTrack(trackId);
                          }}
                          className="ml-auto flex items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-slate-200 hover:bg-amber-500 hover:text-slate-950 disabled:opacity-40"
                        >
                          <RefreshCw
                            className={`h-3 w-3 ${busyJobTrack === trackId ? 'animate-spin' : ''}`}
                          />
                          <span>AI Gen</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Arrangement Track Lane */}
                  <div
                    className={`relative bg-[#171c26] ${
                      compactLanes ? 'h-[64px]' : 'h-[84px]'
                    } ${tool === 'split' && isAudio ? 'cursor-crosshair' : 'cursor-pointer'}`}
                    style={{ width: `${laneWidthPx}px` }}
                    onDoubleClick={() => {
                      if (!isAudio) {
                        onSelectMidiTrack(trackId as 'drums' | 'bass' | 'harmony' | 'lead');
                      }
                    }}
                    onClick={(e) => {
                      onSelectTrackHeader?.(trackId);
                      if (!isAudio) return;
                      if (
                        tool === 'split' &&
                        trackId === 'vocal' &&
                        audioClips.length === 0 &&
                        baseVocalRef
                      ) {
                        const laneEl = e.currentTarget;
                        const defaultClip: AudioClip = {
                          id: `clip_vocal_${Date.now()}`,
                          source: baseVocalRef,
                          start_bar: 1,
                          trim_start_sec: 0,
                          fade_in_ms: 20,
                          fade_out_ms: 20,
                          offset_ms: 0,
                        };
                        handleSplitClipAtClientX(e, 'vocal', defaultClip, laneEl);
                      }
                    }}
                  >
                    {Array.from({ length: totalBars }, (_, idx) => (
                      <div
                        key={idx}
                        className={`pointer-events-none absolute top-0 bottom-0 flex border-l border-white/[0.15] ${
                          Math.floor(idx / 4) % 2 === 1 ? 'bg-[#131822]/85' : 'bg-[#1c2331]/80'
                        }`}
                        style={{ left: `${idx * pxPerBar}px`, width: `${pxPerBar}px` }}
                      >
                        {Array.from({ length: beatsPerBar }, (_, bIdx) => (
                          <div
                            key={bIdx}
                            className={`flex-1 ${bIdx > 0 ? 'border-l border-white/[0.045]' : ''}`}
                          />
                        ))}
                      </div>
                    ))}

                    {isAudio ? (
                      audioClips.length > 0 ? (
                        audioClips.map((clip) => {
                          const activeDrag =
                            dragPreview &&
                            dragPreview.trackId === trackId &&
                            dragPreview.clipId === clip.id
                              ? dragPreview
                              : null;

                          const effectiveClip: AudioClip = activeDrag
                            ? {
                                ...clip,
                                start_bar: activeDrag.previewStartBar,
                                trim_start_sec: activeDrag.previewTrimStartSec,
                                trim_end_sec: activeDrag.previewTrimEndSec,
                              }
                            : clip;

                          const offsetBars = (effectiveClip.offset_ms ?? 0) / 1000 / secPerBar;
                          const leftPx = Math.max(
                            0,
                            (effectiveClip.start_bar - 1 + offsetBars) * pxPerBar
                          );
                          const clipDurSec = getClipDurationSec(effectiveClip, trackId);
                          const widthPx = Math.max(40, (clipDurSec / secPerBar) * pxPerBar);
                          const isSelected =
                            selectedClipRef?.trackId === trackId &&
                            selectedClipRef?.clipId === clip.id;
                          const isOverdub =
                            trackId === 'vocal' &&
                            (clip.id.startsWith('clip_overdub_') ||
                              clip.source.includes('overdub') ||
                              clip.source.startsWith('mem://clips/'));

                          const cStyle = isOverdub
                            ? TRACK_STYLE.overdub
                            : trackId === 'texture'
                            ? TRACK_STYLE.texture
                            : TRACK_STYLE.vocal;

                          const bucketCount = Math.max(
                            72,
                            Math.min(480, Math.round(widthPx * 1.1))
                          );
                          const peaks = engine.getWaveformPeaksForClip(
                            effectiveClip,
                            trackId,
                            bucketCount
                          );
                          const bufDurSec =
                            engine.getClipBufferDuration(clip, trackId) ?? clipDurSec;

                          const clipStartTimelineSec =
                            (effectiveClip.start_bar - 1) * secPerBar +
                            (effectiveClip.offset_ms ?? 0) / 1000;
                          const playProgress =
                            transport.isPlaying &&
                            transport.currentTimeSec >= clipStartTimelineSec &&
                            transport.currentTimeSec <= clipStartTimelineSec + clipDurSec
                              ? (transport.currentTimeSec - clipStartTimelineSec) /
                                Math.max(0.1, clipDurSec)
                              : undefined;

                          const fadeInRatio = Math.min(
                            0.45,
                            Math.max(0, (effectiveClip.fade_in_ms ?? 0) / 1000 / Math.max(0.1, clipDurSec))
                          );
                          const fadeOutRatio = Math.min(
                            0.45,
                            Math.max(0, (effectiveClip.fade_out_ms ?? 20) / 1000 / Math.max(0.1, clipDurSec))
                          );

                          const startTrimDrag = (
                            mode: 'trim_left' | 'trim_right',
                            e: React.PointerEvent<HTMLDivElement>
                          ) => {
                            if (tool !== 'select') return;
                            e.stopPropagation();
                            setDragPreview({
                              trackId: trackId as 'vocal' | 'texture',
                              clipId: clip.id,
                              mode,
                              startClientX: e.clientX,
                              origStartBar: clip.start_bar,
                              origTrimStartSec: clip.trim_start_sec || 0,
                              origTrimEndSec: clip.trim_end_sec,
                              bufferDurSec: Math.max(0.5, bufDurSec),
                              previewStartBar: clip.start_bar,
                              previewTrimStartSec: clip.trim_start_sec || 0,
                              previewTrimEndSec: clip.trim_end_sec,
                              didDrag: false,
                            });
                          };

                          return (
                            <div
                              key={clip.id}
                              onPointerDown={(e) => {
                                if (tool !== 'select' || e.button !== 0) return;
                                setDragPreview({
                                  trackId: trackId as 'vocal' | 'texture',
                                  clipId: clip.id,
                                  mode: 'move',
                                  startClientX: e.clientX,
                                  origStartBar: clip.start_bar,
                                  origTrimStartSec: clip.trim_start_sec || 0,
                                  origTrimEndSec: clip.trim_end_sec,
                                  bufferDurSec: Math.max(0.5, bufDurSec),
                                  previewStartBar: clip.start_bar,
                                  previewTrimStartSec: clip.trim_start_sec || 0,
                                  previewTrimEndSec: clip.trim_end_sec,
                                  didDrag: false,
                                });
                              }}
                              onClick={(e) => {
                                if (performance.now() < suppressClickUntilRef.current) {
                                  e.stopPropagation();
                                  return;
                                }
                                const laneEl = e.currentTarget.parentElement as HTMLDivElement | null;
                                if (tool === 'split') {
                                  handleSplitClipAtClientX(
                                    e,
                                    trackId as 'vocal' | 'texture',
                                    clip,
                                    laneEl
                                  );
                                } else {
                                  e.stopPropagation();
                                  setSelectedClipRef({
                                    trackId: trackId as 'vocal' | 'texture',
                                    clipId: clip.id,
                                  });
                                }
                              }}
                              style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                              className={`group/clip absolute top-1 bottom-1 flex flex-col overflow-hidden rounded-[3px] border shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] select-none transition-[border-color,box-shadow] ${
                                isSelected
                                  ? 'border-amber-300 ring-1 ring-amber-400/80 ' + cStyle.clipBg
                                  : `${cStyle.clipBorder} ${cStyle.clipBg}`
                              } ${tool === 'select' ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'}`}
                            >
                              {tool === 'select' && (
                                <>
                                  <div
                                    onPointerDown={(e) => startTrimDrag('trim_left', e)}
                                    title="Kéo để cắt đầu Clip"
                                    className="absolute top-[17px] bottom-0 left-0 z-20 flex w-2 cursor-ew-resize items-center justify-center bg-black/20 opacity-0 transition group-hover/clip:opacity-100 hover:bg-amber-400/80"
                                  >
                                    <span className="h-4 w-0.5 rounded-full bg-white/85" />
                                  </div>
                                  <div
                                    onPointerDown={(e) => startTrimDrag('trim_right', e)}
                                    title="Kéo để cắt cuối Clip"
                                    className="absolute top-[17px] right-0 bottom-0 z-20 flex w-2 cursor-ew-resize items-center justify-center bg-black/20 opacity-0 transition group-hover/clip:opacity-100 hover:bg-amber-400/80"
                                  >
                                    <span className="h-4 w-0.5 rounded-full bg-white/85" />
                                  </div>
                                </>
                              )}

                              <div
                                className={`relative z-10 flex h-[17px] shrink-0 items-center justify-between gap-1 border-b border-white/15 px-1.5 text-[10px] font-bold tracking-tight ${cStyle.headerBg} ${cStyle.headerText}`}
                              >
                                <span className="flex min-w-0 items-center gap-1 truncate">
                                  <ClipTypeGlyph kind="audio" />
                                  <span className="truncate">
                                    {isOverdub
                                      ? 'Overdub'
                                      : trackId === 'texture'
                                      ? 'Audio Sample'
                                      : 'Vocal Take'}{' '}
                                    • b{Number(effectiveClip.start_bar.toFixed(2))}
                                  </span>
                                </span>
                                <span className="shrink-0 font-mono text-[9px] font-medium opacity-85 tabular-nums">
                                  {(effectiveClip.trim_start_sec ?? 0).toFixed(1)}s–
                                  {effectiveClip.trim_end_sec != null
                                    ? `${Number(effectiveClip.trim_end_sec).toFixed(1)}s`
                                    : 'end'}
                                </span>
                              </div>

                              <div className="relative min-h-0 flex-1 overflow-hidden py-0.5">
                                <WaveformClipCanvas
                                  peaks={peaks}
                                  seed={`${trackId}:${clip.id}`}
                                  color={cStyle.waveColor}
                                  strokeColor={cStyle.waveStroke}
                                  playedColor="rgba(74, 222, 128, 0.92)"
                                  playProgress={playProgress}
                                  fadeInRatio={fadeInRatio}
                                  fadeOutRatio={fadeOutRatio}
                                />
                              </div>

                              {activeDrag?.didDrag && (
                                <span className="pointer-events-none absolute right-2 bottom-1 z-30 rounded bg-black/90 px-1.5 py-0.5 font-mono text-[9px] font-bold text-amber-300 ring-1 ring-amber-400/60">
                                  {activeDrag.mode === 'move'
                                    ? `Bar ${effectiveClip.start_bar}`
                                    : `${(effectiveClip.trim_start_sec ?? 0).toFixed(2)}s–${
                                        effectiveClip.trim_end_sec != null
                                          ? effectiveClip.trim_end_sec.toFixed(2)
                                          : 'end'
                                      }s`}
                                </span>
                              )}
                            </div>
                          );
                        })
                      ) : trackId === 'vocal' && baseVocalRef ? (
                        <div
                          onClick={(e) => {
                            if (tool === 'split') return;
                            e.stopPropagation();
                            const created: AudioClip = {
                              id: `clip_vocal_${Date.now()}`,
                              source: baseVocalRef,
                              start_bar: 1,
                              trim_start_sec: 0,
                              fade_in_ms: 20,
                              fade_out_ms: 20,
                              offset_ms: 0,
                            };
                            onMutateWithUndo((prev) => ({
                              ...prev,
                              tracks: {
                                ...prev.tracks,
                                vocal: { ...prev.tracks.vocal, clips: [created] },
                              },
                            }));
                            setSelectedClipRef({ trackId: 'vocal', clipId: created.id });
                          }}
                          className="absolute top-1 right-2 bottom-1 left-0 flex flex-col justify-between overflow-hidden rounded-[3px] border border-dashed border-[#57c7a0]/70 bg-[#1a493c]/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.16)] hover:bg-[#1a493c]/55"
                        >
                          <div className="flex h-[17px] shrink-0 items-center gap-1.5 border-b border-white/10 bg-[#3c9678]/75 px-2 text-[10px] font-bold text-white">
                            <ClipTypeGlyph kind="audio" />
                            <span>Vocal Master Audio (bấm để tách thành Clip chỉnh sửa)</span>
                          </div>
                          <div className="relative min-h-0 flex-1 overflow-hidden py-0.5">
                            <WaveformClipCanvas
                              peaks={engine.getWaveformPeaksForSlot(
                                project.audio_assets.tuned_vocal_ref ? 'autotune' : 'dry',
                                240
                              )}
                              seed={project.project_id}
                              color="rgba(209, 250, 229, 0.72)"
                              strokeColor="rgba(236, 253, 245, 0.90)"
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="flex h-full items-center px-3 text-xs text-slate-400/80">
                          {trackId === 'vocal'
                            ? 'Bấm Rec Mic ở bên trái để thu đè hoặc Import Vocal Sample'
                            : 'Chưa có Audio Sample'}
                        </div>
                      )
                    ) : (
                      <MidiLanePreview
                        trackId={trackId}
                        notes={(track as { notes: MidiNote[] }).notes || []}
                        sections={project.song_structure.sections}
                        totalBars={totalBars}
                        beatsPerBar={beatsPerBar}
                        pxPerBar={pxPerBar}
                        instrument={(track as { instrument?: string | null }).instrument}
                        onOpenEditor={() =>
                          onSelectMidiTrack(trackId as 'drums' | 'bass' | 'harmony' | 'lead')
                        }
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function AutomationEnvelopeLane({
  sections,
  vocalAutomation,
  totalBars,
  beatsPerBar,
  pxPerBar,
  laneWidthPx,
  compact,
  onUpdateSectionEnergy,
  onUpdateTrackAutomation,
}: {
  sections: SongSection[];
  vocalAutomation?: Partial<Record<TrackAutomationParam, AutomationPoint[]>>;
  totalBars: number;
  beatsPerBar: number;
  pxPerBar: number;
  laneWidthPx: number;
  compact: boolean;
  onUpdateSectionEnergy: (sectionIdx: number, nextEnergy: number, commit: boolean) => void;
  onUpdateTrackAutomation: (param: TrackAutomationParam, points: AutomationPoint[]) => void;
}) {
  const [autoMode, setAutoMode] = useState<'dynamics' | TrackAutomationParam>('dynamics');
  const [draggingNode, setDraggingNode] = useState<{
    idx: number;
    laneEl: HTMLElement;
    energy: number;
  } | null>(null);
  const draggingRef = useRef(draggingNode);
  draggingRef.current = draggingNode;
  const commitEnergyRef = useRef(onUpdateSectionEnergy);
  commitEnergyRef.current = onUpdateSectionEnergy;
  const commitAutoRef = useRef(onUpdateTrackAutomation);
  commitAutoRef.current = onUpdateTrackAutomation;

  const defaultAutoPoints = useMemo<AutomationPoint[]>(() => {
    const defVal = autoMode === 'pan' ? 0.5 : autoMode === 'filter' ? 0.92 : autoMode === 'reverb' ? 0.2 : 0.85;
    const mid1 = Math.max(2, Math.round(totalBars * 0.35));
    const mid2 = Math.max(mid1 + 1, Math.round(totalBars * 0.7));
    return [
      { bar: 1, value: defVal },
      { bar: mid1, value: defVal },
      { bar: Math.min(totalBars, mid2), value: defVal },
      { bar: Math.max(2, totalBars), value: defVal },
    ];
  }, [autoMode, totalBars]);

  const activeAutoPoints = useMemo<AutomationPoint[]>(() => {
    if (autoMode === 'dynamics') return [];
    const saved = vocalAutomation?.[autoMode];
    if (saved && saved.length >= 2) {
      return [...saved].sort((a, b) => a.bar - b.bar);
    }
    return defaultAutoPoints;
  }, [autoMode, defaultAutoPoints, vocalAutomation]);

  useEffect(() => {
    if (!draggingNode) return;
    const onMove = (e: PointerEvent) => {
      const curr = draggingRef.current;
      if (!curr) return;
      const rect = curr.laneEl.getBoundingClientRect();
      const pad = 4;
      const usableH = Math.max(16, rect.height - pad * 2);
      const relY = e.clientY - rect.top - pad;
      const minV = autoMode === 'dynamics' ? 0.1 : 0.0;
      const nextEnergy = Number(Math.max(minV, Math.min(1, 1 - relY / usableH)).toFixed(2));
      setDraggingNode({ ...curr, energy: nextEnergy });
    };
    const onUp = () => {
      const curr = draggingRef.current;
      setDraggingNode(null);
      if (!curr) return;
      if (autoMode === 'dynamics') {
        commitEnergyRef.current(curr.idx, curr.energy, true);
      } else {
        const nextPts = activeAutoPoints.map((pt, i) =>
          i === curr.idx ? { ...pt, value: curr.energy } : pt
        );
        commitAutoRef.current(autoMode, nextPts);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [Boolean(draggingNode), autoMode, activeAutoPoints]);

  const sortedSections = sections
    .map((sec, origIdx) => ({ sec, origIdx }))
    .sort((a, b) => a.sec.start_bar - b.sec.start_bar);

  const avgPct =
    autoMode === 'dynamics'
      ? sections.length
        ? Math.round((sections.reduce((acc, s) => acc + (s.energy ?? 0.75), 0) / sections.length) * 100)
        : 75
      : Math.round((activeAutoPoints.reduce((acc, p) => acc + p.value, 0) / Math.max(1, activeAutoPoints.length)) * 100);

  return (
    <div className="flex bg-[#131823]">
      <div
        className={`sticky left-0 z-10 relative flex shrink-0 flex-col justify-between border-r border-white/10 bg-[#1a202c] pl-3.5 pr-2 ${
          compact ? 'py-1.5' : 'py-2'
        }`}
        style={{ width: `${TRACK_COL_WIDTH}px` }}
      >
        <span className="absolute top-1 bottom-1 left-1 w-1 rounded-sm bg-[#6b8fd4]" />
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 text-[#9bc0ff]">
            <ClipTypeGlyph kind="envelope" />
            <span className="truncate text-[11px] font-bold uppercase tracking-wide text-slate-100">
              {autoMode === 'dynamics' ? 'Dynamics' : `Auto ${autoMode}`}
            </span>
          </div>
          <span className="truncate font-mono text-[10px] font-semibold text-sky-300">
            Avg {avgPct}%
          </span>
        </div>
        <div className="flex flex-wrap gap-0.5 pt-0.5">
          {(['dynamics', 'volume', 'pan', 'filter', 'reverb'] as const).map((param) => (
            <button
              key={param}
              type="button"
              onClick={() => setAutoMode(param)}
              className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase transition ${
                autoMode === param
                  ? 'bg-sky-500 text-slate-950'
                  : 'bg-white/[0.06] text-slate-400 hover:text-white'
              }`}
            >
              {param === 'dynamics' ? 'Dyn' : param === 'volume' ? 'Vol' : param === 'filter' ? 'Filt' : param}
            </button>
          ))}
        </div>
      </div>

      <div
        className={`relative bg-[#171c26] ${compact ? 'h-[64px]' : 'h-[84px]'}`}
        style={{ width: `${laneWidthPx}px` }}
      >
        {Array.from({ length: totalBars }, (_, idx) => (
          <div
            key={idx}
            className={`pointer-events-none absolute top-0 bottom-0 flex border-l border-white/[0.15] ${
              Math.floor(idx / 4) % 2 === 1 ? 'bg-[#131822]/85' : 'bg-[#1c2331]/80'
            }`}
            style={{ left: `${idx * pxPerBar}px`, width: `${pxPerBar}px` }}
          >
            {Array.from({ length: beatsPerBar }, (_, bIdx) => (
              <div
                key={bIdx}
                className={`flex-1 ${bIdx > 0 ? 'border-l border-white/[0.045]' : ''}`}
              />
            ))}
          </div>
        ))}

        {autoMode === 'dynamics' ? (
          sortedSections.map(({ sec, origIdx }, orderIdx) => {
            const leftPx = Math.max(0, (sec.start_bar - 1) * pxPerBar);
            const widthPx = Math.max(40, sec.bars * pxPerBar - 2);
            const prevEnergy =
              orderIdx > 0
                ? draggingNode?.idx === sortedSections[orderIdx - 1].origIdx
                  ? draggingNode.energy
                  : sortedSections[orderIdx - 1].sec.energy ?? 0.65
                : 0.22;
            const targetEnergy =
              draggingNode?.idx === origIdx ? draggingNode.energy : sec.energy ?? 0.75;
            const yStart = 88 - prevEnergy * 72;
            const yEnd = 88 - targetEnergy * 72;
            const midY = (yStart + yEnd) / 2 + (yEnd < yStart ? 10 : -8);
            const pathD = `M 0 ${yStart.toFixed(1)} Q 45 ${midY.toFixed(1)}, 100 ${yEnd.toFixed(1)}`;
            const areaD = `${pathD} L 100 100 L 0 100 Z`;
            const gradId = `env_grad_${origIdx}`;

            return (
              <div
                key={`${sec.name}_${origIdx}`}
                style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                className="group/env absolute top-1 bottom-1 flex flex-col overflow-hidden rounded-[3px] border border-[#7498dc]/80 bg-[#23324f]/52 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] select-none"
              >
                <div className="flex h-[17px] shrink-0 items-center justify-between gap-1 border-b border-white/15 bg-[#4a6592]/90 px-1.5 text-[10px] font-bold text-white">
                  <span className="flex min-w-0 items-center gap-1 truncate">
                    <ClipTypeGlyph kind="envelope" />
                    <span className="truncate">{sec.name} envelope</span>
                  </span>
                  <span className="shrink-0 font-mono text-[9px] text-sky-100 tabular-nums">
                    {Math.round(targetEnergy * 100)}%
                  </span>
                </div>

                <div className="relative flex-1 overflow-hidden">
                  <svg className="h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#93c5fd" stopOpacity="0.44" />
                        <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.08" />
                      </linearGradient>
                    </defs>
                    <path d={areaD} fill={`url(#${gradId})`} />
                    <path
                      d={pathD}
                      fill="none"
                      stroke="#e0f2fe"
                      strokeWidth="2.2"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>

                  <span
                    className="pointer-events-none absolute -left-[3px] h-2 w-2 -translate-y-1/2 rounded-full border border-[#1e293b] bg-sky-200"
                    style={{ top: `${yStart}%` }}
                  />

                  <button
                    type="button"
                    title={`Kéo lên/xuống để chỉnh Energy của ${sec.name} (${Math.round(targetEnergy * 100)}%)`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      const container = e.currentTarget.parentElement;
                      if (!container) return;
                      setDraggingNode({ idx: origIdx, laneEl: container, energy: targetEnergy });
                    }}
                    style={{ top: `${yEnd}%` }}
                    className="absolute right-1 z-20 h-3 w-3 -translate-y-1/2 cursor-ns-resize rounded-full border-2 border-[#1e293b] bg-[#dbeafe] shadow transition hover:scale-125 hover:bg-amber-300"
                  />
                </div>
              </div>
            );
          })
        ) : (
          <div className="relative h-full w-full select-none">
            <svg className="pointer-events-none h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polyline
                fill="none"
                stroke="#38bdf8"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                points={activeAutoPoints
                  .map((pt, idx) => {
                    const v = draggingNode?.idx === idx ? draggingNode.energy : pt.value;
                    const x = Math.max(1, Math.min(99, ((pt.bar - 1) / Math.max(1, totalBars - 1)) * 100));
                    const y = 90 - v * 78;
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                  })
                  .join(' ')}
              />
            </svg>
            {activeAutoPoints.map((pt, idx) => {
              const v = draggingNode?.idx === idx ? draggingNode.energy : pt.value;
              const leftPx = Math.max(8, Math.min(laneWidthPx - 12, (pt.bar - 1) * pxPerBar));
              const topPct = 90 - v * 78;
              return (
                <button
                  key={`${autoMode}_${idx}`}
                  type="button"
                  title={`Vocal ${autoMode.toUpperCase()} Bar ${pt.bar}: ${Math.round(v * 100)}%`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    const container = e.currentTarget.parentElement;
                    if (!container) return;
                    setDraggingNode({ idx, laneEl: container, energy: v });
                  }}
                  style={{ left: `${leftPx}px`, top: `${topPct}%` }}
                  className="absolute z-20 h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize rounded-full border-2 border-[#0f172a] bg-amber-300 shadow hover:scale-125"
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface MidiPatternSegment {
  startBar: number;
  bars: number;
  label: string;
  notes: MidiNote[];
}

function buildPatternSegments(
  trackId: string,
  notes: MidiNote[],
  sections: SongSection[],
  totalBars: number,
  beatsPerBar: number
): MidiPatternSegment[] {
  if (notes.length === 0) return [];

  const baseName =
    trackId === 'drums'
      ? 'Drums'
      : trackId === 'bass'
      ? 'Bass'
      : trackId === 'harmony'
      ? 'Harmony'
      : 'Lead';

  const windows: Array<{ startBar: number; bars: number; sectionName?: string }> = [];
  if (sections.length > 0) {
    const sorted = [...sections].sort((a, b) => a.start_bar - b.start_bar);
    let cursor = 1;
    for (const s of sorted) {
      if (s.start_bar > cursor) {
        windows.push({ startBar: cursor, bars: s.start_bar - cursor });
      }
      windows.push({
        startBar: Math.max(1, s.start_bar),
        bars: Math.max(1, s.bars),
        sectionName: s.name,
      });
      cursor = Math.max(cursor, s.start_bar + s.bars);
    }
    if (cursor <= totalBars) {
      windows.push({ startBar: cursor, bars: totalBars - cursor + 1 });
    }
  } else {
    const chunkBars = 4;
    for (let b = 1; b <= totalBars; b += chunkBars) {
      windows.push({ startBar: b, bars: Math.min(chunkBars, totalBars - b + 1) });
    }
  }

  const seenFingerprints = new Map<string, number>();
  let nextVariantNum = 1;
  const segments: MidiPatternSegment[] = [];

  for (const w of windows) {
    const segStartBeat = (w.startBar - 1) * beatsPerBar;
    const segEndBeat = segStartBeat + w.bars * beatsPerBar;
    const segNotes = notes.filter(
      (n) => n.start_beat < segEndBeat - 0.001 && n.start_beat + n.duration > segStartBeat + 0.001
    );
    if (segNotes.length === 0) continue;

    // Fingerprint relative pitch + beat positions so identical recurring sections keep same label
    const fp = segNotes
      .slice(0, 16)
      .map((n) => `${n.pitch}@${(n.start_beat - segStartBeat).toFixed(2)}`)
      .join('|');
    let variantIdx = seenFingerprints.get(fp);
    if (!variantIdx) {
      variantIdx = nextVariantNum++;
      seenFingerprints.set(fp, variantIdx);
    }

    const suffix = variantIdx > 1 ? ` #${variantIdx}` : '';
    const title = w.sectionName ? `${baseName}${suffix} • ${w.sectionName}` : `${baseName}${suffix}`;
    segments.push({
      startBar: w.startBar,
      bars: w.bars,
      label: title,
      notes: segNotes,
    });
  }

  return segments;
}

function MidiLanePreview({
  trackId,
  notes,
  sections,
  totalBars,
  beatsPerBar,
  pxPerBar,
  instrument,
  onOpenEditor,
}: {
  trackId: string;
  notes: MidiNote[];
  sections: SongSection[];
  totalBars: number;
  beatsPerBar: number;
  pxPerBar: number;
  instrument?: string | null;
  onOpenEditor: () => void;
}) {
  const style = TRACK_STYLE[trackId] || TRACK_STYLE.harmony;
  const segments = useMemo(
    () => buildPatternSegments(trackId, notes, sections, totalBars, beatsPerBar),
    [trackId, notes, sections, totalBars, beatsPerBar]
  );

  if (segments.length === 0) {
    return (
      <div className="flex h-full items-center justify-between px-3 text-xs text-slate-400/80">
        <span>Chưa có MIDI Pattern ({instrument || 'synth'}) — Double-click hoặc bấm AI Gen</span>
      </div>
    );
  }

  return (
    <>
      {segments.map((seg, segIdx) => {
        const leftPx = Math.max(0, (seg.startBar - 1) * pxPerBar);
        const widthPx = Math.max(44, seg.bars * pxPerBar - 2);
        const segStartBeat = (seg.startBar - 1) * beatsPerBar;
        const segTotalBeats = Math.max(1, seg.bars * beatsPerBar);
        const pitches = seg.notes.map((n) => n.pitch);
        const minP = pitches.length ? Math.min(...pitches) : 48;
        const maxP = pitches.length ? Math.max(...pitches) : 72;
        const span = Math.max(10, maxP - minP);

        return (
          <div
            key={`${seg.startBar}_${segIdx}`}
            onClick={(e) => {
              e.stopPropagation();
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onOpenEditor();
            }}
            style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
            className={`group/midi absolute top-1 bottom-1 flex flex-col overflow-hidden rounded-[3px] border shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] transition hover:brightness-110 ${style.clipBorder} ${style.clipBg}`}
          >
            <div
              className={`relative z-10 flex h-[17px] shrink-0 items-center justify-between gap-1 border-b border-white/15 px-1.5 text-[10px] font-bold tracking-tight ${style.headerBg} ${style.headerText}`}
            >
              <span className="flex min-w-0 items-center gap-1 truncate">
                <ClipTypeGlyph kind="midi" />
                <span className="truncate">{seg.label}</span>
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenEditor();
                }}
                title="Mở bộ soạn thảo MIDI cho track này"
                className="shrink-0 rounded bg-black/30 px-1 py-px text-[8px] font-bold uppercase tracking-wider text-amber-200 opacity-0 transition group-hover/midi:opacity-100 hover:bg-amber-400 hover:text-slate-950"
              >
                Edit
              </button>
            </div>

            <div className="relative flex-1 overflow-hidden">
              {seg.notes.slice(0, 180).map((n, idx) => {
                const clippedStart = Math.max(0, n.start_beat - segStartBeat);
                const clippedDur = Math.max(
                  0.12,
                  Math.min(segTotalBeats - clippedStart, n.duration)
                );
                const leftPct = Math.max(0, Math.min(99, (clippedStart / segTotalBeats) * 100));
                const widthPct = Math.max(1.2, Math.min(35, (clippedDur / segTotalBeats) * 100));
                const topPct = 10 + (1 - (n.pitch - minP) / span) * 76;
                return (
                  <span
                    key={idx}
                    className={`absolute h-[3.5px] rounded-[1px] shadow-[0_0_2px_rgba(0,0,0,0.45)] ${style.noteColor}`}
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      top: `${topPct}%`,
                      opacity: Math.max(0.68, Math.min(1, (n.velocity || 95) / 127)),
                    }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}
