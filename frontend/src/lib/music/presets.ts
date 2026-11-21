import {
  createDefaultProjectState,
  type ChordEvent,
  type MidiNote,
  type ProjectState,
} from '@/types/project';

const NOTE_ROOT_MIDI: Record<string, number> = {
  C: 48,
  'C#': 49,
  Db: 49,
  D: 50,
  'D#': 51,
  Eb: 51,
  E: 52,
  F: 53,
  'F#': 54,
  Gb: 54,
  G: 55,
  'G#': 56,
  Ab: 56,
  A: 57,
  'A#': 58,
  Bb: 58,
  B: 59,
};

export interface ChordProgressionPreset {
  id: string;
  label: string;
  style: string;
  symbols: string[];
}

export const CHORD_PROGRESSIONS: ChordProgressionPreset[] = [
  { id: 'pop_classic', label: 'Pop Anthem (I - V - vi - IV)', style: 'Pop', symbols: ['C', 'G', 'Am', 'F'] },
  { id: 'emotional', label: 'Ballad Cảm xúc (vi - IV - I - V)', style: 'Ballad', symbols: ['Am', 'F', 'C', 'G'] },
  { id: 'lofi_chill', label: 'Lo-fi Chill (ii - V - I - vi)', style: 'Lo-fi', symbols: ['Dm', 'G', 'C', 'Am'] },
  { id: 'dark_trap', label: 'Trap / Drill (i - VI - VII - v)', style: 'Hip-hop', symbols: ['Cm', 'Ab', 'Bb', 'Gm'] },
  { id: 'edm_drive', label: 'EDM Uplifting (vi - IV - I - V)', style: 'EDM', symbols: ['Fm', 'Db', 'Ab', 'Eb'] },
];

function parseChordRootAndTriad(symbol: string): { bassMidi: number; triadOffsets: number[] } {
  const m = symbol.trim().match(/^([A-G][#b]?)(maj7|m7|min|dim|sus4|m|7)?/i);
  if (!m) return { bassMidi: 36, triadOffsets: [0, 4, 7, 12] };
  const rootName = m[1][0].toUpperCase() + (m[1].slice(1) || '');
  const quality = (m[2] || '').toLowerCase();
  const rootMidi = NOTE_ROOT_MIDI[rootName] ?? 48;
  const bassMidi = rootMidi - 12; // C2..B2 octave
  const triadOffsets =
    quality === 'm' || quality === 'min'
      ? [0, 3, 7, 12]
      : quality === 'm7'
      ? [0, 3, 7, 10]
      : quality === 'maj7'
      ? [0, 4, 7, 11]
      : quality === '7'
      ? [0, 4, 7, 10]
      : quality === 'dim'
      ? [0, 3, 6, 12]
      : quality === 'sus4'
      ? [0, 5, 7, 12]
      : [0, 4, 7, 12];
  return { bassMidi, triadOffsets };
}

export const GENRES = ['Pop', 'Ballad', 'Lo-fi', 'R&B', 'Hip-hop', 'EDM', 'Acoustic', 'Rock'] as const;
export const MOODS = ['Uplifting', 'Emotional', 'Chill', 'Energetic', 'Melancholic', 'Romantic'] as const;

export function getBeatsPerBar(timeSignature?: string | null): number {
  const cleaned = (timeSignature || '4/4').trim();
  if (cleaned === '3/4') return 3;
  if (cleaned === '6/8') return 6;
  if (cleaned === '2/4') return 2;
  const parsed = Number.parseInt(cleaned.split('/')[0] || '4', 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 12 ? parsed : 4;
}

export type DrumGrooveStyle = 'pop' | 'trap' | 'lofi' | 'edm' | 'clear';

export function generateDrumPattern(
  style: DrumGrooveStyle,
  totalBars = 8,
  beatsPerBar = 4
): MidiNote[] {
  if (style === 'clear') return [];
  const notes: MidiNote[] = [];

  for (let bar = 0; bar < totalBars; bar++) {
    const barBeat = bar * beatsPerBar;
    if (beatsPerBar === 6) {
      notes.push({ pitch: 36, start_beat: barBeat + 0, duration: 0.25, velocity: 112 });
      notes.push({ pitch: 36, start_beat: barBeat + 2.5, duration: 0.25, velocity: 90 });
      notes.push({ pitch: 38, start_beat: barBeat + 3, duration: 0.25, velocity: 106 });
      for (let b = 0; b < 6; b++) {
        notes.push({
          pitch: 42,
          start_beat: barBeat + b,
          duration: 0.25,
          velocity: b === 0 || b === 3 ? 90 : 66,
        });
      }
      continue;
    }
    if (beatsPerBar === 3) {
      notes.push({ pitch: 36, start_beat: barBeat + 0, duration: 0.25, velocity: 110 });
      notes.push({ pitch: 38, start_beat: barBeat + 1, duration: 0.25, velocity: 96 });
      notes.push({ pitch: 38, start_beat: barBeat + 2, duration: 0.25, velocity: 92 });
      for (let b = 0; b < 3; b += 0.5) {
        notes.push({
          pitch: 42,
          start_beat: barBeat + b,
          duration: 0.25,
          velocity: b % 1 === 0 ? 84 : 60,
        });
      }
      continue;
    }
    if (style === 'pop') {
      notes.push({ pitch: 36, start_beat: barBeat + 0, duration: 0.25, velocity: 112 });
      notes.push({ pitch: 36, start_beat: barBeat + 2, duration: 0.25, velocity: 108 });
      notes.push({ pitch: 36, start_beat: barBeat + 2.5, duration: 0.25, velocity: 92 });
      notes.push({ pitch: 38, start_beat: barBeat + 1, duration: 0.25, velocity: 104 });
      notes.push({ pitch: 38, start_beat: barBeat + 3, duration: 0.25, velocity: 108 });
      for (let b = 0; b < beatsPerBar; b += 0.5) {
        notes.push({
          pitch: 42,
          start_beat: barBeat + b,
          duration: 0.25,
          velocity: b % 1 === 0 ? 86 : 64,
        });
      }
    } else if (style === 'edm') {
      for (let b = 0; b < beatsPerBar; b++) {
        notes.push({ pitch: 36, start_beat: barBeat + b, duration: 0.25, velocity: 118 });
        notes.push({ pitch: 42, start_beat: barBeat + b + 0.5, duration: 0.25, velocity: 92 });
        if (b === 1 || b === 3) {
          notes.push({ pitch: 39, start_beat: barBeat + b, duration: 0.25, velocity: 108 });
        }
      }
    } else if (style === 'trap') {
      notes.push({ pitch: 36, start_beat: barBeat + 0, duration: 0.25, velocity: 120 });
      notes.push({ pitch: 36, start_beat: barBeat + 1.5, duration: 0.25, velocity: 105 });
      notes.push({ pitch: 36, start_beat: barBeat + 2.75, duration: 0.25, velocity: 100 });
      notes.push({ pitch: 39, start_beat: barBeat + 2, duration: 0.25, velocity: 114 });
      for (let step = 0; step < 16; step++) {
        if (step === 13 || step === 15) continue;
        notes.push({
          pitch: 42,
          start_beat: Number((barBeat + step * 0.25).toFixed(3)),
          duration: 0.2,
          velocity: step % 2 === 0 ? 88 : 68,
        });
      }
    } else if (style === 'lofi') {
      notes.push({ pitch: 36, start_beat: barBeat + 0, duration: 0.25, velocity: 98 });
      notes.push({ pitch: 36, start_beat: barBeat + 1.75, duration: 0.25, velocity: 84 });
      notes.push({ pitch: 36, start_beat: barBeat + 2.5, duration: 0.25, velocity: 92 });
      notes.push({ pitch: 38, start_beat: barBeat + 1, duration: 0.25, velocity: 90 });
      notes.push({ pitch: 38, start_beat: barBeat + 3, duration: 0.25, velocity: 94 });
      for (let b = 0; b < beatsPerBar; b += 0.5) {
        const swing = b % 1 !== 0 ? 0.05 : 0;
        notes.push({
          pitch: 42,
          start_beat: Number((barBeat + b + swing).toFixed(3)),
          duration: 0.25,
          velocity: 66,
        });
      }
    }
  }
  return notes;
}

export function generateBassFromChords(
  chords: ChordEvent[],
  totalBars = 8,
  beatsPerBar = 4
): MidiNote[] {
  const notes: MidiNote[] = [];
  for (let bar = 1; bar <= totalBars; bar++) {
    const ch = chords.find((c) => c.bar === bar) || chords[(bar - 1) % Math.max(1, chords.length)];
    if (!ch) continue;
    const { bassMidi } = parseChordRootAndTriad(ch.symbol);
    const barStartBeat = (bar - 1) * beatsPerBar;
    if (beatsPerBar === 6) {
      notes.push({ pitch: bassMidi, start_beat: barStartBeat, duration: 2.5, velocity: 102 });
      notes.push({ pitch: bassMidi, start_beat: barStartBeat + 3, duration: 1.5, velocity: 95 });
      notes.push({ pitch: bassMidi + 7, start_beat: barStartBeat + 5, duration: 1.0, velocity: 88 });
    } else if (beatsPerBar === 3) {
      notes.push({ pitch: bassMidi, start_beat: barStartBeat, duration: 1.5, velocity: 102 });
      notes.push({ pitch: bassMidi, start_beat: barStartBeat + 1.5, duration: 0.75, velocity: 94 });
      notes.push({ pitch: bassMidi + 7, start_beat: barStartBeat + 2.25, duration: 0.75, velocity: 88 });
    } else {
      notes.push({ pitch: bassMidi, start_beat: barStartBeat, duration: 1.5, velocity: 102 });
      notes.push({ pitch: bassMidi, start_beat: barStartBeat + 2, duration: 1.0, velocity: 95 });
      notes.push({ pitch: bassMidi + 7, start_beat: barStartBeat + 3.25, duration: 0.75, velocity: 88 });
    }
  }
  return notes;
}

export function generateHarmonyFromChords(
  chords: ChordEvent[],
  totalBars = 8,
  beatsPerBar = 4
): MidiNote[] {
  const notes: MidiNote[] = [];
  const chordDur = Math.max(1, beatsPerBar - 0.25);
  for (let bar = 1; bar <= totalBars; bar++) {
    const ch = chords.find((c) => c.bar === bar) || chords[(bar - 1) % Math.max(1, chords.length)];
    if (!ch) continue;
    const { bassMidi, triadOffsets } = parseChordRootAndTriad(ch.symbol);
    const basePitch = bassMidi + 24; // C4..B4 range
    const barStartBeat = (bar - 1) * beatsPerBar;
    for (const off of triadOffsets.slice(0, 3)) {
      notes.push({
        pitch: Math.min(84, basePitch + off),
        start_beat: barStartBeat,
        duration: chordDur,
        velocity: 84,
      });
    }
  }
  return notes;
}

export interface DAWStarterTemplate {
  id: string;
  name: string;
  subtitle: string;
  genre: string;
  mood: string;
  bpm: number;
  key: string;
  scale: string;
  groove: DrumGrooveStyle;
  chords: string[];
  accentColor: string;
  instruments: {
    drums: string;
    bass: string;
    harmony: string;
    lead: string;
  };
}

export const DAW_TEMPLATES: DAWStarterTemplate[] = [
  {
    id: 'pop_studio',
    name: 'Modern Pop Kit',
    subtitle: 'Beat Pop sáng, sẵn vòng hợp âm & Piano',
    genre: 'Pop',
    mood: 'Uplifting',
    bpm: 120,
    key: 'C',
    scale: 'major',
    groove: 'pop',
    chords: ['C', 'G', 'Am', 'F'],
    accentColor: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
    instruments: {
      drums: 'acoustic_kit',
      bass: 'finger_bass',
      harmony: 'grand_piano',
      lead: 'electric_piano',
    },
  },
  {
    id: 'lofi_chill',
    name: 'Lo-Fi Boom Bap',
    subtitle: 'Trống swung mộc mạc + Fender Rhodes',
    genre: 'Lo-fi',
    mood: 'Chill',
    bpm: 84,
    key: 'A',
    scale: 'minor',
    groove: 'lofi',
    chords: ['Am', 'F', 'C', 'G'],
    accentColor: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    instruments: {
      drums: 'lofi_kit',
      bass: 'upright_bass',
      harmony: 'warm_pad',
      lead: 'electric_piano',
    },
  },
  {
    id: 'trap_808',
    name: 'Trap / 808 Groove',
    subtitle: 'Hi-hat roll 1/16, Kick 808 mạnh mẽ',
    genre: 'Hip-hop',
    mood: 'Energetic',
    bpm: 140,
    key: 'C',
    scale: 'minor',
    groove: 'trap',
    chords: ['Cm', 'Ab', 'Bb', 'Gm'],
    accentColor: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
    instruments: {
      drums: 'electronic_808',
      bass: 'synth_bass',
      harmony: 'warm_pad',
      lead: 'synth_lead',
    },
  },
  {
    id: 'edm_house',
    name: 'Progressive House',
    subtitle: 'Four-on-the-floor 128 BPM + Synth Bass',
    genre: 'EDM',
    mood: 'Energetic',
    bpm: 128,
    key: 'F',
    scale: 'minor',
    groove: 'edm',
    chords: ['Fm', 'Db', 'Ab', 'Eb'],
    accentColor: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    instruments: {
      drums: 'electronic_808',
      bass: 'synth_bass',
      harmony: 'warm_pad',
      lead: 'synth_lead',
    },
  },
  {
    id: 'ballad_piano',
    name: 'Piano Ballad',
    subtitle: 'Nhịp 72 BPM lắng đọng cho Vocal Solo',
    genre: 'Ballad',
    mood: 'Emotional',
    bpm: 72,
    key: 'G',
    scale: 'major',
    groove: 'lofi',
    chords: ['G', 'D', 'Em', 'C'],
    accentColor: 'border-violet-500/40 bg-violet-500/10 text-violet-300',
    instruments: {
      drums: 'acoustic_kit',
      bass: 'upright_bass',
      harmony: 'grand_piano',
      lead: 'flute',
    },
  },
  {
    id: 'blank_session',
    name: 'Blank Studio Project',
    subtitle: 'Phiên trống hoàn toàn (8 Bars • 120 BPM)',
    genre: 'Pop',
    mood: 'Uplifting',
    bpm: 120,
    key: 'C',
    scale: 'major',
    groove: 'clear',
    chords: ['C', 'G', 'Am', 'F'],
    accentColor: 'border-slate-500/40 bg-slate-500/10 text-slate-300',
    instruments: {
      drums: 'acoustic_kit',
      bass: 'finger_bass',
      harmony: 'grand_piano',
      lead: 'electric_piano',
    },
  },
];

export function buildProjectFromTemplate(template: DAWStarterTemplate): ProjectState {
  const projectId = `proj_${Date.now()}`;
  const base = createDefaultProjectState(projectId);
  const totalBars = 8;
  const chords: ChordEvent[] = Array.from({ length: totalBars }, (_, idx) => ({
    bar: idx + 1,
    beat: 1,
    symbol: template.chords[idx % template.chords.length],
    duration_beats: 4,
  }));

  const drumNotes = generateDrumPattern(template.groove, totalBars, 4);
  const bassNotes =
    template.groove === 'clear' ? [] : generateBassFromChords(chords, totalBars);
  const harmonyNotes =
    template.groove === 'clear' ? [] : generateHarmonyFromChords(chords, totalBars);

  return {
    ...base,
    title: `${template.name}`,
    config: {
      ...base.config,
      title: template.name,
      genre: template.genre,
      mood: template.mood,
    },
    analysis: {
      ...base.analysis,
      bpm: template.bpm,
      bpm_locked: true,
      detected_key: template.key,
      detected_scale: template.scale,
      key_locked: true,
      bars: totalBars,
    },
    autotune_settings: {
      ...base.autotune_settings,
      key: template.key,
      scale: template.scale,
    },
    song_structure: {
      total_bars: totalBars,
      sections: [
        { name: 'Intro', start_bar: 1, bars: 4, energy: 0.6 },
        { name: 'Chorus', start_bar: 5, bars: 4, energy: 0.9, has_user_motif: true },
      ],
      chords,
    },
    tracks: {
      ...base.tracks,
      drums: {
        ...base.tracks.drums,
        instrument: template.instruments.drums,
        notes: drumNotes,
      },
      bass: {
        ...base.tracks.bass,
        instrument: template.instruments.bass,
        notes: bassNotes,
      },
      harmony: {
        ...base.tracks.harmony,
        instrument: template.instruments.harmony,
        notes: harmonyNotes,
      },
      lead: {
        ...base.tracks.lead,
        instrument: template.instruments.lead,
        notes: [],
      },
    },
  };
}
