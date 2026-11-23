export type MelodyMode = 'preserve' | 'enhance';
export type OutputMode = 'accompaniment' | 'full_song';
export type MotifPosition = 'chorus' | 'verse' | 'auto';
export type StructurePreset = 'short' | 'standard';
export type AutoTunePreset = 'off' | 'natural' | 'balanced' | 'modern';
export type LLMProvider = 'gemini' | 'openai' | 'mock';

export interface MidiNote {
  pitch: number;
  start_beat: number;
  duration: number;
  velocity: number;
  confidence?: number;
}

export interface ProjectConfig {
  title?: string;
  melody_mode: MelodyMode;
  output_mode: OutputMode;
  motif_position: MotifPosition;
  structure_preset?: StructurePreset;
  genre: string;
  mood: string;
  user_prompt: string;
  enable_lead_karaoke?: boolean;
  add_count_in_tail?: boolean;
}

export interface AudioAssets {
  raw_input_ref: string | null;
  dry_denoised_ref: string | null;
  tuned_vocal_ref: string | null;
  rendered_mix_ref?: string | null;
  accompaniment_ref?: string | null;
  preserve_mix_ref?: string | null;
  enhance_mix_ref?: string | null;
}

export interface ProjectAnalysis {
  bpm: number;
  time_signature: string;
  detected_key: string;
  detected_scale: string;
  key_confidence?: number;
  low_confidence_warning?: boolean;
  bars?: number;
  duration_sec?: number;
  bpm_locked?: boolean;
  key_locked?: boolean;
  raw_melody_midi: MidiNote[];
}

export interface AutotuneSettings {
  enabled: boolean;
  preset: AutoTunePreset;
  key: string;
  scale: string;
  retune_speed_ms: number;
  humanize: number;
  mix_percent: number;
  auto_follow_project_key: boolean;
}

export interface SongSection {
  name: string;
  start_bar: number;
  bars: number;
  energy: number;
  has_user_motif?: boolean;
}

export interface ChordEvent {
  bar: number;
  beat: number;
  symbol: string;
  duration_beats: number;
}

export interface SongStructure {
  total_bars: number;
  sections: SongSection[];
  chords: ChordEvent[];
}

export interface LyricLine {
  section: string;
  bar: number;
  text: string;
}

export interface ProjectLyrics {
  language: string;
  lines: LyricLine[];
}

export interface AudioClip {
  id: string;
  source: string;
  start_bar: number;
  trim_start_sec: number;
  trim_end_sec?: number;
  fade_in_ms: number;
  fade_out_ms?: number;
  offset_ms?: number;
}

export interface AudioTrackState {
  type: 'audio';
  locked: boolean;
  mute: boolean;
  solo: boolean;
  volume: number;
  pan: number;
  low_db?: number;
  mid_db?: number;
  high_db?: number;
  reverb_send?: number;
  delay_send?: number;
  clips: AudioClip[];
}

export interface MidiTrackState {
  type: 'midi';
  locked: boolean;
  mute?: boolean;
  solo?: boolean;
  volume?: number;
  pan?: number;
  low_db?: number;
  mid_db?: number;
  high_db?: number;
  reverb_send?: number;
  delay_send?: number;
  instrument?: string | null;
  notes: MidiNote[];
}

export interface ProjectTracks {
  vocal: AudioTrackState;
  texture?: AudioTrackState;
  drums: MidiTrackState;
  bass: MidiTrackState;
  harmony: MidiTrackState;
  lead: MidiTrackState;
  [key: string]: AudioTrackState | MidiTrackState | undefined;
}

export interface MasteringSettings {
  auto_mix_enabled: boolean;
  limiter_ceiling_db: number;
  target_lufs: number;
}

export interface QAStatus {
  approved: boolean;
  iterations: number;
  fallback_used: boolean;
  feedback: string;
}

export interface ProjectState {
  project_id: string;
  title?: string;
  version: number;
  created_at?: string;
  updated_at?: string;
  source?: 'draft' | 'saved';
  config: ProjectConfig;
  audio_assets: AudioAssets;
  analysis: ProjectAnalysis;
  autotune_settings: AutotuneSettings;
  song_structure: SongStructure;
  lyrics: ProjectLyrics;
  tracks: ProjectTracks;
  mastering: MasteringSettings;
  qa_status: QAStatus;
}

// API DTOs matching docs/API_AND_UI_SPEC.md & Spring Boot backend DTOs
export interface UploadAudioResponse {
  project_id: string;
  raw_input_ref: string;
  filename: string;
  duration_sec: number;
  sample_rate: number;
  channels: number;
  size_bytes: number;
  format: string;
  warnings: string[];
}

export interface DenoiseRequest {
  project_id: string;
  enable_denoise: boolean;
  auto_trim: boolean;
}

export interface DenoiseResponse {
  project_id: string;
  raw_input_ref: string;
  dry_denoised_ref: string;
  trimmed_start_sec: number;
  trimmed_end_sec: number;
  duration_sec: number;
  snr_db_estimate: number;
  warnings: string[];
}

export interface AnalyzeRequest {
  project_id: string;
  source_ref: string;
  bpm_override?: number;
  key_override?: string;
  scale_override?: string;
}

export interface AnalyzeResponse {
  project_id: string;
  bpm: number;
  time_signature?: string;
  key: string;
  scale: string;
  key_confidence?: number;
  low_confidence_warning?: boolean;
  bars?: number;
  duration_sec?: number;
  raw_melody_midi: MidiNote[];
}

export interface AutotuneRequest {
  project_id: string;
  autotune_settings: AutotuneSettings;
}

export interface AutotuneResponse {
  project_id: string;
  tuned_vocal_ref: string;
  autotune_settings?: AutotuneSettings;
  duration_sec?: number;
}

export interface JobGenerateRequest {
  project_id: string;
  config: ProjectConfig;
}

export interface JobRegenerateTrackRequest {
  project_id: string;
  target_track: string;
  instrument: string;
}

export interface JobRearrangeRequest {
  project_id: string;
  chords: ChordEvent[];
  locked_tracks: string[];
  sections?: SongSection[];
  total_bars?: number;
}

export interface JobCreatedResponse {
  job_id: string;
}

export type JobSSEEventType =
  | 'agent_step'
  | 'qa_retry'
  | 'progress'
  | 'completed'
  | 'fallback_warning'
  | 'error';

export interface JobSSEEvent {
  type: JobSSEEventType;
  job_id?: string;
  code?: string;
  agent?: string;
  step?: string;
  stage?: string;
  progress?: number;
  iteration?: number;
  max_iterations?: number;
  feedback?: string;
  issues?: string[];
  message?: string;
  project_state?: ProjectState;
  warning?: string;
  error?: string;
}

export interface OneClickFix {
  id: string;
  label: string;
  action_type: 'shift_timing' | 'apply_autotune' | 'adjust_gain';
  value: number | string;
}

export interface OverdubFitCheckResponse {
  timing_offset_ms: number;
  pitch_issues: Array<{ bar?: number; note?: string; cents_off?: number; description?: string }>;
  gain_suggestion: string;
  one_click_fixes: OneClickFix[];
}

export interface AutoTrimVocalResponse {
  project_id?: string;
  project_state: ProjectState;
  trim_start_sec?: number;
  trim_end_sec?: number;
  offset_ms?: number;
  trimmed_clips?: number;
  summary?: string;
}

export interface AutoMixResponse {
  project_state: ProjectState;
  mix_notes?: string[];
  summary?: string;
}

export interface ClipUploadResponse {
  project_state: ProjectState;
  clip: AudioClip;
  audio_ref: string;
}

export interface LyricsSuggestRequest {
  project_id: string;
  language: string;
  topic: string;
  section: string;
}

export interface LyricsSuggestResponse {
  language?: string;
  lines: LyricLine[];
}

export type CoachAssistantMode = 'producer' | 'arrangement' | 'lyricist' | 'mix';

export interface CoachMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  provider?: string;
  suggested_actions?: CoachSuggestedAction[];
}

export interface CoachSuggestedAction {
  id: string;
  label: string;
  action: string;
  payload?: Record<string, unknown>;
}

export interface CoachChatRequest {
  project_id: string;
  message: string;
  mode?: CoachAssistantMode;
  route?: string;
  context?: Record<string, unknown>;
  project_state?: ProjectState;
  history: CoachMessage[];
}

export interface CoachChatResponse {
  reply: string;
  provider?: string;
  suggested_actions: CoachSuggestedAction[];
}

export interface ProjectSummary {
  project_id: string;
  title?: string;
  genre?: string;
  mood?: string;
  bpm?: number;
  key?: string;
  scale?: string;
  source?: 'draft' | 'saved';
  updated_at?: string;
  total_bars?: number;
  version?: number;
  has_audio?: boolean;
}

export interface PaginatedProjectsResponse {
  items: ProjectSummary[];
  total: number;
  page: number;
  limit?: number;
  total_pages: number;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  app?: string;
  version?: string;
  redis?: { connected: boolean; backend?: string; used_memory_human?: string };
  engines?: {
    audio_worker_available?: boolean;
    ffmpeg_available?: boolean;
    fluidsynth_available?: boolean;
    soundfont_available?: boolean;
    java_fallback_available?: boolean;
  };
  llm_providers?: {
    gemini_configured?: boolean;
    openai_configured?: boolean;
    default?: string;
  };
}

export interface LlmTestResponse {
  ok: boolean;
  is_mock?: boolean;
  provider: string;
  model?: string;
  latency_ms?: number;
  message: string;
}

export interface StudioLLMSettings {
  geminiApiKey: string;
  openaiApiKey: string;
  defaultProvider: LLMProvider;
  agentProviders: {
    composer: LLMProvider;
    arranger: LLMProvider;
    lyricist: LLMProvider;
    coach: LLMProvider;
    qa: LLMProvider;
  };
  backendUrl: string;
}

export function createDefaultProjectState(projectId?: string): ProjectState {
  const id = projectId || `proj_${Date.now()}`;
  const now = new Date().toISOString();
  return {
    project_id: id,
    title: 'Untitled Session',
    version: 1,
    created_at: now,
    updated_at: now,
    source: 'draft',
    config: {
      title: 'Untitled Session',
      melody_mode: 'preserve',
      output_mode: 'accompaniment',
      motif_position: 'chorus',
      structure_preset: 'standard',
      genre: 'Pop',
      mood: 'Uplifting',
      user_prompt: '',
      enable_lead_karaoke: false,
    },
    audio_assets: {
      raw_input_ref: null,
      dry_denoised_ref: null,
      tuned_vocal_ref: null,
      rendered_mix_ref: null,
    },
    analysis: {
      bpm: 100,
      time_signature: '4/4',
      detected_key: 'C',
      detected_scale: 'major',
      key_confidence: 0.85,
      bars: 8,
      raw_melody_midi: [],
    },
    autotune_settings: {
      enabled: false,
      preset: 'off',
      key: 'C',
      scale: 'major',
      retune_speed_ms: 50,
      humanize: 0.6,
      mix_percent: 100,
      auto_follow_project_key: true,
    },
    song_structure: {
      total_bars: 8,
      sections: [{ name: 'Chorus', start_bar: 1, bars: 8, energy: 0.8, has_user_motif: true }],
      chords: [
        { bar: 1, beat: 1, symbol: 'C', duration_beats: 4 },
        { bar: 2, beat: 1, symbol: 'G', duration_beats: 4 },
        { bar: 3, beat: 1, symbol: 'Am', duration_beats: 4 },
        { bar: 4, beat: 1, symbol: 'F', duration_beats: 4 },
        { bar: 5, beat: 1, symbol: 'C', duration_beats: 4 },
        { bar: 6, beat: 1, symbol: 'G', duration_beats: 4 },
        { bar: 7, beat: 1, symbol: 'F', duration_beats: 4 },
        { bar: 8, beat: 1, symbol: 'G', duration_beats: 4 },
      ],
    },
    lyrics: {
      language: 'vi',
      lines: [],
    },
    tracks: {
      vocal: {
        type: 'audio',
        locked: false,
        mute: false,
        solo: false,
        volume: 0.95,
        pan: 0.0,
        low_db: 0,
        mid_db: 0,
        high_db: 0,
        reverb_send: 0,
        delay_send: 0,
        clips: [],
      },
      drums: {
        type: 'midi',
        locked: false,
        mute: false,
        solo: false,
        volume: 0.85,
        pan: 0.0,
        low_db: 0,
        mid_db: 0,
        high_db: 0,
        reverb_send: 0,
        delay_send: 0,
        instrument: 'acoustic_kit',
        notes: [],
      },
      bass: {
        type: 'midi',
        locked: false,
        mute: false,
        solo: false,
        volume: 0.85,
        pan: 0.0,
        low_db: 0,
        mid_db: 0,
        high_db: 0,
        reverb_send: 0,
        delay_send: 0,
        instrument: 'finger_bass',
        notes: [],
      },
      harmony: {
        type: 'midi',
        locked: false,
        mute: false,
        solo: false,
        volume: 0.8,
        pan: -0.1,
        low_db: 0,
        mid_db: 0,
        high_db: 0,
        reverb_send: 0,
        delay_send: 0,
        instrument: 'grand_piano',
        notes: [],
      },
      lead: {
        type: 'midi',
        locked: false,
        mute: false,
        solo: false,
        volume: 0.75,
        pan: 0.1,
        low_db: 0,
        mid_db: 0,
        high_db: 0,
        reverb_send: 0,
        delay_send: 0,
        instrument: 'electric_piano',
        notes: [],
      },
    },
    mastering: {
      auto_mix_enabled: true,
      limiter_ceiling_db: -1.0,
      target_lufs: -14.0,
    },
    qa_status: {
      approved: false,
      iterations: 0,
      fallback_used: false,
      feedback: '',
    },
  };
}
