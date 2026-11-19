import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  FolderPlus,
  Lock,
  Mic,
  Plus,
  RefreshCw,
  Scissors,
  Sparkles,
  Trash2,
  Unlock,
} from 'lucide-react';
import { validateAudioFileClient } from '@/lib/api/client';
import type { TransportSnapshot } from '@/lib/audio/player';
import type {
  AudioClip,
  AudioTrackState,
  ChordEvent,
  MidiNote,
  ProjectState,
  SongSection,
} from '@/types/project';

const SECTION_PRESETS = ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'];
const PX_PER_BAR = 76;
const TRACK_COL_WIDTH = 224; // w-56

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

  const [selectedClipRef, setSelectedClipRef] = useState<{
    trackId: 'vocal' | 'texture';
    clipId: string;
  } | null>(null);
  const [editingChordBar, setEditingChordBar] = useState<number | null>(null);
  const [chordInput, setChordInput] = useState('');
  const [editingSectionIdx, setEditingSectionIdx] = useState<number | null>(null);
  const [sectionDraft, setSectionDraft] = useState<SongSection | null>(null);

  const totalBars = Math.max(4, project.song_structure.total_bars || 8);
  const beatsPerBar = project.analysis.time_signature === '3/4' ? 3 : 4;
  const bpm = Math.max(40, project.analysis.bpm || 100);
  const secPerBar = (beatsPerBar * 60) / bpm;
  const laneWidthPx = totalBars * PX_PER_BAR;

  const currentBarFloat = 1 + transport.currentTimeSec / secPerBar;
  const playheadLeftPx = Math.max(0, Math.min(laneWidthPx, (currentBarFloat - 1) * PX_PER_BAR));

  const trackIds = useMemo(() => {
    const base: Array<'vocal' | 'texture' | 'drums' | 'bass' | 'harmony' | 'lead'> = ['vocal'];
    if (project.tracks.texture) {
      base.push('texture');
    }
    base.push('drums', 'bass', 'harmony', 'lead');
    return base;
  }, [project.tracks.texture]);

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
    const rawClickBar = 1 + clickX / PX_PER_BAR;
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
    const rawBar = 1 + clickX / PX_PER_BAR;
    const stepBars = getSnapStepBars(snapGrid, beatsPerBar);
    const snappedBar = Math.max(
      1,
      Math.min(totalBars + 0.99, 1 + Math.round((rawBar - 1) / stepBars) * stepBars)
    );
    onSeekBar(snappedBar);
  };

  const handleAddSection = () => {
    const last = project.song_structure.sections[project.song_structure.sections.length - 1];
    const startBar = last ? Math.min(totalBars, last.start_bar + last.bars) : 1;
    const newSec: SongSection = {
      name: 'Bridge',
      start_bar: startBar,
      bars: Math.max(1, Math.min(4, totalBars - startBar + 1)),
      energy: 0.75,
    };
    onMutateWithUndo((prev) => ({
      ...prev,
      song_structure: {
        ...prev.song_structure,
        sections: [...prev.song_structure.sections, newSec],
      },
    }));
  };

  const handleSaveSectionEdit = () => {
    if (editingSectionIdx === null || !sectionDraft) return;
    onMutateWithUndo((prev) => {
      const nextSections = [...prev.song_structure.sections];
      nextSections[editingSectionIdx] = {
        ...sectionDraft,
        start_bar: Math.max(1, Math.min(totalBars, Math.round(sectionDraft.start_bar))),
        bars: Math.max(1, Math.round(sectionDraft.bars)),
      };
      return {
        ...prev,
        song_structure: { ...prev.song_structure, sections: nextSections },
      };
    });
    setEditingSectionIdx(null);
    setSectionDraft(null);
  };

  const handleDeleteSection = (idx: number) => {
    onMutateWithUndo((prev) => ({
      ...prev,
      song_structure: {
        ...prev.song_structure,
        sections: prev.song_structure.sections.filter((_, i) => i !== idx),
      },
    }));
    setEditingSectionIdx(null);
    setSectionDraft(null);
  };

  const handleSaveChordForBar = (barNum: number) => {
    const sym = chordInput.trim();
    if (sym) {
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
    }
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
    <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-slate-800 bg-[#121622]">
      {/* Hidden input for importing external audio sample to texture track */}
      <input
        ref={textureInputRef}
        type="file"
        accept=".wav,.mp3,.m4a,.ogg,.flac,audio/*"
        className="hidden"
        onChange={handleTextureFileSelected}
      />

      {/* Top Timeline Utility Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-[#151a28] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-slate-300">Timeline ({totalBars} bars)</span>
          <span className="text-slate-600">|</span>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-300">
            <span className="text-slate-400">Loop Region:</span>
            <label className="flex items-center gap-1">
              <span>Bar</span>
              <input
                type="number"
                min={1}
                max={Math.max(1, loopEndBar - 1)}
                value={loopStartBar}
                onChange={(e) => {
                  const s = Math.max(1, Math.min(totalBars - 1, Number(e.target.value) || 1));
                  onLoopRegionChange(s, Math.max(s + 1, loopEndBar));
                }}
                className="w-11 rounded border border-slate-700 bg-[#0b0d14] px-1.5 py-0.5 text-center font-mono text-white"
              />
            </label>
            <span>→</span>
            <label className="flex items-center gap-1">
              <span>Bar</span>
              <input
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
                className="w-11 rounded border border-slate-700 bg-[#0b0d14] px-1.5 py-0.5 text-center font-mono text-white"
              />
            </label>
          </div>
          {tool === 'split' && (
            <span className="flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-200">
              <Scissors className="h-3 w-3" /> Dao cắt: Bấm lên Audio Clip để tách đôi (Snap {snapGrid})
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {chordsDirty && (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-[11px] text-amber-300">
                <AlertTriangle className="h-3 w-3" /> Hòa âm chưa đồng bộ
              </span>
              <button
                type="button"
                disabled={busyJobTrack === 'rearrange'}
                onClick={onRearrangeChords}
                className="rounded-md bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {busyJobTrack === 'rearrange' ? 'Đang cập nhật...' : 'Cập nhật nhạc đệm'}
              </button>
            </div>
          )}

          <button
            type="button"
            disabled={autoTrimBusy || !baseVocalRef}
            onClick={onAutoTrimVocal}
            title="AI cắt khoảng lặng & căn nhịp Vocal Clip"
            className="flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-40"
          >
            <Sparkles className="h-3 w-3" />
            <span>{autoTrimBusy ? 'Đang Auto-Trim...' : 'AI Auto-Trim Vocal'}</span>
          </button>

          <button
            type="button"
            disabled={clipUploadBusy}
            onClick={() => textureInputRef.current?.click()}
            title="Import audio sample vào track Texture"
            className="flex items-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-2.5 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-40"
          >
            <FolderPlus className="h-3 w-3" />
            <span>{clipUploadBusy ? 'Đang tải...' : 'Import Sample (Texture)'}</span>
          </button>
        </div>
      </div>

      {/* Inline Section Editor Popover Bar */}
      {editingSectionIdx !== null && sectionDraft && (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-indigo-950/40 px-3 py-2 text-xs">
          <span className="font-semibold text-indigo-200">Sửa Section:</span>
          <select
            value={SECTION_PRESETS.includes(sectionDraft.name) ? sectionDraft.name : 'Custom'}
            onChange={(e) => {
              if (e.target.value !== 'Custom') {
                setSectionDraft({ ...sectionDraft, name: e.target.value });
              }
            }}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white"
          >
            {SECTION_PRESETS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            {!SECTION_PRESETS.includes(sectionDraft.name) && <option value="Custom">Custom</option>}
          </select>
          <input
            type="text"
            value={sectionDraft.name}
            onChange={(e) => setSectionDraft({ ...sectionDraft, name: e.target.value })}
            placeholder="Tên đoạn"
            className="w-28 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white"
          />
          <label className="flex items-center gap-1 text-slate-300">
            Start Bar:
            <input
              type="number"
              min={1}
              max={totalBars}
              value={sectionDraft.start_bar}
              onChange={(e) =>
                setSectionDraft({ ...sectionDraft, start_bar: Number(e.target.value) || 1 })
              }
              className="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-center text-white"
            />
          </label>
          <label className="flex items-center gap-1 text-slate-300">
            Bars:
            <input
              type="number"
              min={1}
              max={totalBars}
              value={sectionDraft.bars}
              onChange={(e) =>
                setSectionDraft({ ...sectionDraft, bars: Number(e.target.value) || 1 })
              }
              className="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-center text-white"
            />
          </label>
          <button
            type="button"
            onClick={handleSaveSectionEdit}
            className="rounded bg-indigo-600 px-2.5 py-1 font-semibold text-white hover:bg-indigo-500"
          >
            Lưu
          </button>
          <button
            type="button"
            onClick={() => handleDeleteSection(editingSectionIdx)}
            className="rounded bg-rose-600/20 px-2 py-1 text-rose-300 hover:bg-rose-600/30"
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

      {/* Selected Audio Clip Inspector (Select Tool) */}
      {selectedClip && selectedClipRef && (
        <div className="flex flex-wrap items-center gap-2.5 border-b border-slate-800 bg-[#171d2f] px-3 py-2 text-[11px]">
          <span className="font-bold text-emerald-300">
            Clip: {selectedClipRef.trackId.toUpperCase()} ({selectedClip.id.slice(0, 14)})
          </span>

          <label className="flex items-center gap-1 text-slate-300">
            <span>Start Bar</span>
            <button
              type="button"
              onClick={() =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  start_bar: Math.max(1, Number((selectedClip.start_bar - 0.25).toFixed(2))),
                })
              }
              className="rounded bg-slate-800 px-1.5 py-0.5 hover:bg-slate-700"
            >
              -0.25
            </button>
            <input
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
              className="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-center font-mono text-white"
            />
            <button
              type="button"
              onClick={() =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  start_bar: Math.min(totalBars, Number((selectedClip.start_bar + 0.25).toFixed(2))),
                })
              }
              className="rounded bg-slate-800 px-1.5 py-0.5 hover:bg-slate-700"
            >
              +0.25
            </button>
          </label>

          <label className="flex items-center gap-1 text-slate-300">
            <span>Offset (ms)</span>
            <button
              type="button"
              onClick={() =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  offset_ms: Math.round((selectedClip.offset_ms ?? 0) - 25),
                })
              }
              className="rounded bg-slate-800 px-1.5 py-0.5 hover:bg-slate-700"
            >
              -25
            </button>
            <input
              type="number"
              step={5}
              value={selectedClip.offset_ms ?? 0}
              onChange={(e) =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  offset_ms: Number(e.target.value) || 0,
                })
              }
              className="w-16 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-center font-mono text-white"
            />
            <button
              type="button"
              onClick={() =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  offset_ms: Math.round((selectedClip.offset_ms ?? 0) + 25),
                })
              }
              className="rounded bg-slate-800 px-1.5 py-0.5 hover:bg-slate-700"
            >
              +25
            </button>
          </label>

          <label className="flex items-center gap-1 text-slate-300">
            <span>Trim Start (s)</span>
            <input
              type="number"
              step={0.05}
              min={0}
              value={selectedClip.trim_start_sec}
              onChange={(e) =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  trim_start_sec: Math.max(0, Number(e.target.value) || 0),
                })
              }
              className="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-center font-mono text-white"
            />
          </label>

          <label className="flex items-center gap-1 text-slate-300">
            <span>Trim End (s)</span>
            <input
              type="number"
              step={0.05}
              min={0}
              placeholder="auto"
              value={selectedClip.trim_end_sec ?? ''}
              onChange={(e) =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  trim_end_sec: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)),
                })
              }
              className="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-center font-mono text-white"
            />
          </label>

          <label className="flex items-center gap-1 text-slate-300">
            <span>Fade In/Out (ms)</span>
            <input
              type="number"
              step={10}
              min={0}
              value={selectedClip.fade_in_ms}
              onChange={(e) =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  fade_in_ms: Math.max(0, Number(e.target.value) || 0),
                })
              }
              className="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-center font-mono text-white"
            />
            <input
              type="number"
              step={10}
              min={0}
              value={selectedClip.fade_out_ms ?? 20}
              onChange={(e) =>
                updateAudioClip(selectedClipRef.trackId, selectedClip.id, {
                  fade_out_ms: Math.max(0, Number(e.target.value) || 0),
                })
              }
              className="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-center font-mono text-white"
            />
          </label>

          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => handleDuplicateClip(selectedClipRef.trackId, selectedClip)}
              className="flex items-center gap-1 rounded bg-indigo-600/25 px-2 py-1 text-indigo-200 hover:bg-indigo-600/40"
            >
              <Copy className="h-3 w-3" /> Duplicate
            </button>
            <button
              type="button"
              onClick={() => handleDeleteClip(selectedClipRef.trackId, selectedClip.id)}
              className="flex items-center gap-1 rounded bg-rose-600/25 px-2 py-1 text-rose-200 hover:bg-rose-600/40"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          </div>
        </div>
      )}

      {/* Scrollable Multi-Track Grid */}
      <div className="flex-1 overflow-auto">
        <div className="relative" style={{ minWidth: `${TRACK_COL_WIDTH + laneWidthPx + 24}px` }}>
          {/* Row 0: Bar Ruler (Click-to-seek Playhead + Loop Region highlight) */}
          <div className="sticky top-0 z-20 flex border-b border-slate-800 bg-[#0e121d]">
            <div
              className="sticky left-0 z-30 flex shrink-0 items-center justify-between border-r border-slate-800 bg-[#0e121d] px-3 py-1.5 text-[11px] font-semibold text-slate-400"
              style={{ width: `${TRACK_COL_WIDTH}px` }}
            >
              <span>BAR RULER</span>
              <span className="font-mono text-indigo-300">
                {bpm} BPM • {project.analysis.time_signature}
              </span>
            </div>

            <div
              onClick={handleRulerClick}
              title="Bấm để nhảy Playhead tới ô nhịp"
              className="relative h-8 cursor-pointer select-none"
              style={{ width: `${laneWidthPx}px` }}
            >
              {/* Loop Region Band */}
              {loopEndBar > loopStartBar && (
                <div
                  className={`pointer-events-none absolute top-0 bottom-0 border-x ${
                    transport.loopEnabled
                      ? 'border-emerald-400/70 bg-emerald-500/15'
                      : 'border-slate-600/40 bg-slate-700/15'
                  }`}
                  style={{
                    left: `${(loopStartBar - 1) * PX_PER_BAR}px`,
                    width: `${(loopEndBar - loopStartBar) * PX_PER_BAR}px`,
                  }}
                />
              )}

              {Array.from({ length: totalBars }, (_, idx) => {
                const barNum = idx + 1;
                return (
                  <div
                    key={barNum}
                    className="absolute top-0 bottom-0 border-l border-slate-700/80 pl-1.5 pt-1 font-mono text-[10px] font-semibold text-slate-300"
                    style={{ left: `${idx * PX_PER_BAR}px`, width: `${PX_PER_BAR}px` }}
                  >
                    {barNum}
                    <div className="mt-1 flex justify-between pr-2 opacity-40">
                      {Array.from({ length: beatsPerBar }, (_, b) => (
                        <span key={b} className="h-1.5 w-px bg-slate-500" />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Row 1: Interactive Section Bar */}
          <div className="flex border-b border-slate-800 bg-[#121725]">
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center justify-between border-r border-slate-800 bg-[#121725] px-3 py-1.5"
              style={{ width: `${TRACK_COL_WIDTH}px` }}
            >
              <span className="text-[11px] font-semibold uppercase text-slate-400">Sections</span>
              <button
                type="button"
                onClick={handleAddSection}
                className="flex items-center gap-0.5 rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-200 hover:bg-slate-700"
              >
                <Plus className="h-3 w-3" /> Section
              </button>
            </div>
            <div className="relative h-8" style={{ width: `${laneWidthPx}px` }}>
              {project.song_structure.sections.map((sec, idx) => {
                const left = Math.max(0, (sec.start_bar - 1) * PX_PER_BAR);
                const width = Math.max(36, sec.bars * PX_PER_BAR - 2);
                return (
                  <button
                    key={`${sec.name}_${idx}`}
                    type="button"
                    onClick={() => {
                      setEditingSectionIdx(idx);
                      setSectionDraft({ ...sec });
                    }}
                    title="Bấm để sửa/đổi tên Section"
                    style={{ left: `${left}px`, width: `${width}px` }}
                    className={`absolute top-1 bottom-1 truncate rounded px-2 text-left text-[11px] font-semibold transition ${
                      sec.has_user_motif
                        ? 'bg-indigo-600/35 text-indigo-100 ring-1 ring-indigo-400/50 hover:bg-indigo-600/50'
                        : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                    }`}
                  >
                    {sec.name} ({sec.bars}b)
                  </button>
                );
              })}
            </div>
          </div>

          {/* Row 2: Interactive Chord Track */}
          <div className="flex border-b border-slate-800 bg-[#101420]">
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center justify-between border-r border-slate-800 bg-[#101420] px-3 py-1.5"
              style={{ width: `${TRACK_COL_WIDTH}px` }}
            >
              <span className="text-[11px] font-semibold uppercase text-slate-400">Chord Track</span>
              <span className="text-[10px] text-slate-500">Bấm ô để sửa</span>
            </div>
            <div className="relative h-9" style={{ width: `${laneWidthPx}px` }}>
              {Array.from({ length: totalBars }, (_, idx) => {
                const barNum = idx + 1;
                const ch = project.song_structure.chords.find((c) => c.bar === barNum);
                const isEditing = editingChordBar === barNum;
                return (
                  <div
                    key={barNum}
                    className="absolute top-1 bottom-1 px-0.5"
                    style={{ left: `${idx * PX_PER_BAR}px`, width: `${PX_PER_BAR}px` }}
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        value={chordInput}
                        onChange={(e) => setChordInput(e.target.value)}
                        onBlur={() => handleSaveChordForBar(barNum)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') setEditingChordBar(null);
                        }}
                        className="h-full w-full rounded border border-indigo-500 bg-slate-900 px-1 text-center text-xs font-bold text-white"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingChordBar(barNum);
                          setChordInput(ch?.symbol || '');
                        }}
                        className={`h-full w-full rounded border text-center text-xs font-semibold transition ${
                          ch
                            ? 'border-slate-700 bg-[#171c2b] text-emerald-300 hover:border-indigo-500'
                            : 'border-dashed border-slate-800 text-slate-600 hover:border-slate-600 hover:text-slate-400'
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

          {/* Track Rows */}
          <div className="relative divide-y divide-slate-800/80">
            {/* Live Playhead Vertical Line across all track lanes */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]"
              style={{ left: `${TRACK_COL_WIDTH + playheadLeftPx}px` }}
            />

            {trackIds.map((trackId) => {
              const track = project.tracks[trackId];
              if (!track) return null;

              const isAudio = track.type === 'audio';
              const audioClips: AudioClip[] = isAudio ? track.clips || [] : [];

              return (
                <div key={trackId} className="flex bg-[#121622]">
                  {/* Sticky Track Header */}
                  <div
                    className="sticky left-0 z-10 shrink-0 space-y-1.5 border-r border-slate-800 bg-[#161b29] p-2.5"
                    style={{ width: `${TRACK_COL_WIDTH}px` }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold uppercase tracking-wide text-white">
                        {trackId}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {isAudio ? `${audioClips.length} clip` : track.instrument || 'midi'}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onToggleTrackFlag(trackId, 'mute')}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          track.mute ? 'bg-rose-600 text-white' : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        M
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggleTrackFlag(trackId, 'solo')}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          track.solo ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        S
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggleTrackFlag(trackId, 'locked')}
                        title={track.locked ? 'Đã khóa' : 'Khóa track'}
                        className={`rounded p-1 ${
                          track.locked ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {track.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                      </button>

                      {trackId === 'vocal' ? (
                        <button
                          type="button"
                          onClick={onStartOverdub}
                          className={`ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold ${
                            isOverdubbing
                              ? 'animate-pulse bg-rose-600 text-white'
                              : 'bg-rose-600/20 text-rose-300 hover:bg-rose-600/30'
                          }`}
                        >
                          <Mic className="h-3 w-3" />
                          <span>{isOverdubbing ? 'Dừng' : 'Overdub'}</span>
                        </button>
                      ) : trackId === 'texture' ? (
                        <button
                          type="button"
                          onClick={() => textureInputRef.current?.click()}
                          className="ml-auto flex items-center gap-1 rounded bg-cyan-600/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-200 hover:bg-cyan-600/30"
                        >
                          <Plus className="h-3 w-3" />
                          <span>Sample</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={track.locked || busyJobTrack === trackId}
                          onClick={() => onRegenerateTrack(trackId)}
                          className="ml-auto flex items-center gap-1 rounded bg-indigo-600/20 px-2 py-0.5 text-[10px] font-semibold text-indigo-300 hover:bg-indigo-600/30 disabled:opacity-40"
                        >
                          <RefreshCw
                            className={`h-3 w-3 ${busyJobTrack === trackId ? 'animate-spin' : ''}`}
                          />
                          <span>Regen</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Timeline Clip Lane */}
                  <div
                    className={`relative h-16 bg-[#0d111a] ${
                      tool === 'split' && isAudio ? 'cursor-crosshair' : 'cursor-pointer'
                    }`}
                    style={{ width: `${laneWidthPx}px` }}
                    onClick={(e) => {
                      if (!isAudio) {
                        onSelectMidiTrack(trackId as 'drums' | 'bass' | 'harmony' | 'lead');
                        return;
                      }
                      // If vocal clips are empty and user clicks with Split tool while baseVocalRef exists, materialize & split
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
                        onMutateWithUndo((prev) => ({
                          ...prev,
                          tracks: {
                            ...prev.tracks,
                            vocal: { ...prev.tracks.vocal, clips: [defaultClip] },
                          },
                        }));
                        // Split immediately using the same click coords
                        handleSplitClipAtClientX(e, 'vocal', defaultClip, laneEl);
                      }
                    }}
                  >
                    {/* Bar grid lines */}
                    {Array.from({ length: totalBars }, (_, idx) => (
                      <div
                        key={idx}
                        className="pointer-events-none absolute top-0 bottom-0 border-l border-slate-800/70"
                        style={{ left: `${idx * PX_PER_BAR}px` }}
                      />
                    ))}

                    {isAudio ? (
                      audioClips.length > 0 ? (
                        audioClips.map((clip) => {
                          const offsetBars = (clip.offset_ms ?? 0) / 1000 / secPerBar;
                          const leftPx = Math.max(0, (clip.start_bar - 1 + offsetBars) * PX_PER_BAR);
                          const clipDurSec = getClipDurationSec(clip, trackId);
                          const widthPx = Math.max(36, (clipDurSec / secPerBar) * PX_PER_BAR);
                          const isSelected =
                            selectedClipRef?.trackId === trackId &&
                            selectedClipRef?.clipId === clip.id;
                          const isOverdub =
                            clip.id.startsWith('clip_overdub_') || clip.source.includes('overdub');

                          return (
                            <div
                              key={clip.id}
                              onClick={(e) => {
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
                              className={`absolute top-1.5 bottom-1.5 flex flex-col justify-between overflow-hidden rounded-md border px-2 py-1 text-[10px] transition ${
                                isSelected
                                  ? 'border-amber-400 bg-emerald-500/30 text-white ring-1 ring-amber-400'
                                  : isOverdub
                                  ? 'border-rose-400/50 bg-rose-500/20 text-rose-100 hover:border-rose-300'
                                  : trackId === 'texture'
                                  ? 'border-cyan-400/50 bg-cyan-500/20 text-cyan-100 hover:border-cyan-300'
                                  : 'border-emerald-500/50 bg-emerald-500/20 text-emerald-100 hover:border-emerald-300'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-1 truncate font-semibold">
                                <span className="truncate">
                                  {isOverdub
                                    ? 'Overdub'
                                    : trackId === 'texture'
                                    ? 'Sample'
                                    : 'Vocal'}{' '}
                                  • b{clip.start_bar}
                                </span>
                                {clip.offset_ms ? (
                                  <span className="shrink-0 font-mono text-[9px] opacity-80">
                                    {clip.offset_ms > 0 ? `+${clip.offset_ms}` : clip.offset_ms}ms
                                  </span>
                                ) : null}
                              </div>
                              <div className="flex items-center justify-between text-[9px] opacity-75">
                                <span>
                                  {clip.trim_start_sec.toFixed(1)}s–
                                  {clip.trim_end_sec !== undefined
                                    ? `${clip.trim_end_sec.toFixed(1)}s`
                                    : 'end'}
                                </span>
                                <span>
                                  F:{clip.fade_in_ms}/{clip.fade_out_ms ?? 20}ms
                                </span>
                              </div>
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
                          className="absolute top-1.5 right-2 bottom-1.5 left-0 flex items-center justify-between rounded-md border border-dashed border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-200 hover:bg-emerald-500/15"
                        >
                          <span>Vocal Base Audio (bấm để tạo Clip chỉnh sửa / Split)</span>
                          <span className="text-[10px] text-emerald-300">Auto-Tune / Dry Ready</span>
                        </div>
                      ) : (
                        <div className="flex h-full items-center px-3 text-xs text-slate-500">
                          {trackId === 'vocal'
                            ? 'Chưa có Vocal Clip — Record Overdub hoặc tạo nhạc từ Wizard'
                            : 'Chưa có Audio Sample'}
                        </div>
                      )
                    ) : (
                      /* MIDI Pattern Visual Clip */
                      <MidiLanePreview
                        notes={(track as { notes: MidiNote[] }).notes || []}
                        totalBars={totalBars}
                        beatsPerBar={beatsPerBar}
                        laneWidthPx={laneWidthPx}
                        instrument={(track as { instrument?: string | null }).instrument}
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

function MidiLanePreview({
  notes,
  totalBars,
  beatsPerBar,
  laneWidthPx,
  instrument,
}: {
  notes: MidiNote[];
  totalBars: number;
  beatsPerBar: number;
  laneWidthPx: number;
  instrument?: string | null;
}) {
  const totalBeats = totalBars * beatsPerBar;
  const pitches = notes.map((n) => n.pitch);
  const minP = pitches.length ? Math.min(...pitches) : 48;
  const maxP = pitches.length ? Math.max(...pitches) : 72;
  const span = Math.max(12, maxP - minP);

  return (
    <div
      className="relative m-1.5 h-13 overflow-hidden rounded-md border border-indigo-500/35 bg-indigo-500/15"
      style={{ width: `${Math.max(80, laneWidthPx - 12)}px` }}
    >
      {/* Mini piano roll preview notes */}
      {notes.slice(0, 240).map((n, idx) => {
        const leftPct = Math.max(0, Math.min(99, (n.start_beat / totalBeats) * 100));
        const widthPct = Math.max(0.8, Math.min(20, (n.duration / totalBeats) * 100));
        const topPct = 10 + (1 - (n.pitch - minP) / span) * 76;
        return (
          <span
            key={idx}
            className="absolute h-1 rounded-xs bg-indigo-300/80"
            style={{ left: `${leftPct}%`, width: `${widthPct}%`, top: `${topPct}%` }}
          />
        );
      })}
      <div className="relative z-10 flex h-full items-center justify-between px-2.5 text-[11px] text-indigo-100">
        <span className="rounded bg-[#0d111a]/75 px-1.5 py-0.5 font-medium">
          {notes.length} notes • {instrument || 'default'}
        </span>
        <span className="rounded bg-[#0d111a]/75 px-1.5 py-0.5 text-[10px] text-indigo-300">
          Bấm để mở Piano Roll
        </span>
      </div>
    </div>
  );
}
