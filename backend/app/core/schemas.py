"""Pydantic schemas matching Shared Project State and API contracts."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional
from uuid import uuid4

from pydantic import AliasChoices, BaseModel, Field, field_validator


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class MidiNote(BaseModel):
    """Single symbolic MIDI note event."""

    pitch: int = Field(..., ge=0, le=127)
    start_beat: float = Field(..., ge=0.0)
    duration: float = Field(..., gt=0.0, validation_alias=AliasChoices("duration", "duration_beats"))
    velocity: int = Field(default=85, ge=1, le=127)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class ProjectConfig(BaseModel):
    """High-level generation & project metadata."""

    title: str = Field(default="Untitled Project", max_length=120)
    melody_mode: Literal["preserve", "enhance"] = "preserve"
    output_mode: Literal["accompaniment", "full_song"] = "accompaniment"
    motif_position: Literal["chorus", "verse", "auto"] = "chorus"
    genre: str = Field(default="Pop", max_length=64)
    mood: str = Field(default="Warm", max_length=64)
    user_prompt: str = Field(default="", max_length=500)


class AudioAssets(BaseModel):
    """References to transient audio assets stored in Redis / memory."""

    raw_input_ref: Optional[str] = None
    dry_denoised_ref: Optional[str] = None
    tuned_vocal_ref: Optional[str] = None


class AnalysisResult(BaseModel):
    """Audio analyzer output (FR-ANA)."""

    bpm: float = Field(default=120.0, ge=40.0, le=220.0)
    time_signature: str = Field(default="4/4")
    detected_key: str = Field(default="C")
    detected_scale: str = Field(default="major")
    key_confidence: float = Field(default=0.8, ge=0.0, le=1.0)
    low_confidence_warning: bool = False
    bars: int = Field(default=4, ge=1)
    duration_sec: float = Field(default=0.0, ge=0.0)
    bpm_locked: bool = False
    key_locked: bool = False
    raw_melody_midi: list[MidiNote] = Field(default_factory=list)


class AutotuneSettings(BaseModel):
    """Auto-Tune DSP configuration (FR-AUTOTUNE)."""

    enabled: bool = False
    preset: Literal["off", "natural", "balanced", "modern"] = "off"
    key: str = Field(default="C")
    scale: Literal["major", "minor", "pentatonic_major", "pentatonic_minor", "chromatic"] = "major"
    retune_speed_ms: float = Field(default=35.0, ge=0.0, le=200.0)
    humanize: float = Field(default=0.6, ge=0.0, le=1.0)
    mix_percent: float = Field(default=100.0, ge=0.0, le=100.0)
    auto_follow_project_key: bool = True


class SectionItem(BaseModel):
    """Song arrangement section."""

    name: str
    start_bar: int = Field(..., ge=1)
    bars: int = Field(..., ge=1)
    energy: float = Field(default=0.5, ge=0.0, le=1.0)
    has_user_motif: bool = False


class ChordItem(BaseModel):
    """Chord event on timeline."""

    bar: int = Field(..., ge=1)
    beat: float = Field(default=1.0, ge=1.0)
    symbol: str
    duration_beats: float = Field(default=4.0, gt=0.0)


class SongStructure(BaseModel):
    """Song sections and chord timeline."""

    total_bars: int = Field(default=4, ge=1)
    sections: list[SectionItem] = Field(default_factory=list)
    chords: list[ChordItem] = Field(default_factory=list)


class LyricLine(BaseModel):
    """Single lyric line aligned to a section and bar."""

    section: str
    bar: int = Field(..., ge=1)
    text: str


class LyricsState(BaseModel):
    """Lyrics state for Lyricist & Karaoke Guide."""

    language: str = "vi"
    lines: list[LyricLine] = Field(default_factory=list)


class AudioClip(BaseModel):
    """Audio clip on an audio track timeline."""

    id: str
    source: str
    start_bar: float = Field(default=1.0, ge=1.0)
    trim_start_sec: float = Field(default=0.0, ge=0.0)
    trim_end_sec: Optional[float] = None
    fade_in_ms: float = Field(default=20.0, ge=0.0)
    fade_out_ms: float = Field(default=20.0, ge=0.0)
    offset_ms: float = 0.0


class TrackState(BaseModel):
    """Single track in Hybrid Multi-Track Studio."""

    type: Literal["audio", "midi"]
    locked: bool = False
    mute: bool = False
    solo: bool = False
    volume: float = Field(default=0.9, ge=0.0, le=1.2)
    pan: float = Field(default=0.0, ge=-1.0, le=1.0)
    instrument: Optional[str] = None
    clips: list[AudioClip] = Field(default_factory=list)
    notes: list[MidiNote] = Field(default_factory=list)


class MasteringSettings(BaseModel):
    """Auto-mix and limiter mastering settings."""

    auto_mix_enabled: bool = True
    limiter_ceiling_db: float = Field(default=-1.0, le=-1.0)
    target_lufs: float = -14.0

    @field_validator("limiter_ceiling_db")
    @classmethod
    def enforce_ceiling(cls, value: float) -> float:
        return min(value, -1.0)


class QAStatus(BaseModel):
    """Producer / QA verification status."""

    approved: bool = True
    iterations: int = Field(default=0, ge=0)
    fallback_used: bool = False
    feedback: str = ""


def default_tracks() -> dict[str, TrackState]:
    """Return default 5-track Hybrid Studio layout."""
    return {
        "vocal": TrackState(type="audio", volume=0.95, pan=0.0, clips=[]),
        "drums": TrackState(type="midi", instrument="acoustic_kit", volume=0.85, pan=0.0, notes=[]),
        "bass": TrackState(type="midi", instrument="finger_bass", volume=0.85, pan=0.0, notes=[]),
        "harmony": TrackState(type="midi", instrument="grand_piano", volume=0.8, pan=-0.1, notes=[]),
        "lead": TrackState(type="midi", instrument="electric_piano", volume=0.8, pan=0.1, notes=[]),
    }


class ProjectState(BaseModel):
    """Canonical Shared Project State across API, DSP, Multi-Agent, and Frontend."""

    project_id: str
    version: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=_utc_now_iso)
    updated_at: str = Field(default_factory=_utc_now_iso)
    config: ProjectConfig = Field(default_factory=ProjectConfig)
    audio_assets: AudioAssets = Field(default_factory=AudioAssets)
    analysis: AnalysisResult = Field(default_factory=AnalysisResult)
    autotune_settings: AutotuneSettings = Field(default_factory=AutotuneSettings)
    song_structure: SongStructure = Field(default_factory=SongStructure)
    lyrics: LyricsState = Field(default_factory=LyricsState)
    tracks: dict[str, TrackState] = Field(default_factory=default_tracks)
    mastering: MasteringSettings = Field(default_factory=MasteringSettings)
    qa_status: QAStatus = Field(default_factory=QAStatus)


def create_default_project(
    project_id: Optional[str] = None,
    title: str = "Untitled Project",
) -> ProjectState:
    """Create a fresh ProjectState with default tracks."""
    pid = project_id or f"proj_{datetime.now(timezone.utc).strftime('%Y%m%d')}_{uuid4().hex[:8]}"
    return ProjectState(
        project_id=pid,
        config=ProjectConfig(title=title),
    )


# --- API Request & Response Schemas ---


class AudioUploadResponse(BaseModel):
    project_id: str
    raw_input_ref: str
    filename: str
    duration_sec: float
    sample_rate: int
    channels: int
    size_bytes: int
    format: str
    warnings: list[str] = Field(default_factory=list)


class DenoiseRequest(BaseModel):
    project_id: str
    enable_denoise: bool = True
    auto_trim: bool = True


class DenoiseResponse(BaseModel):
    project_id: str
    raw_input_ref: str
    dry_denoised_ref: str
    trimmed_start_sec: float
    trimmed_end_sec: float
    duration_sec: float
    snr_db_estimate: float
    warnings: list[str] = Field(default_factory=list)


class AnalyzeRequest(BaseModel):
    project_id: str
    source_ref: Optional[str] = None
    bpm_override: Optional[float] = Field(default=None, ge=40.0, le=220.0)
    key_override: Optional[str] = None
    scale_override: Optional[str] = None


class AnalyzeResponse(BaseModel):
    project_id: str
    bpm: float
    time_signature: str
    key: str
    scale: str
    key_confidence: float
    low_confidence_warning: bool
    bars: int
    duration_sec: float
    raw_melody_midi: list[MidiNote]


class AutotuneRequest(BaseModel):
    project_id: str
    autotune_settings: Optional[AutotuneSettings] = None
    preset: Optional[Literal["off", "natural", "balanced", "modern"]] = None


class AutotuneResponse(BaseModel):
    project_id: str
    tuned_vocal_ref: str
    autotune_settings: AutotuneSettings
    duration_sec: float


class ProjectSummary(BaseModel):
    project_id: str
    title: str
    genre: str
    mood: str
    bpm: float
    key: str
    scale: str
    total_bars: int
    version: int
    updated_at: str
    has_audio: bool


class PaginatedProjectsResponse(BaseModel):
    items: list[ProjectSummary]
    total: int
    page: int
    limit: int
    total_pages: int


class ExportAudioRequest(BaseModel):
    format: Literal["wav", "mp3", "stems"] = "wav"
    apply_mastering: bool = True
    mode: Literal["ai_mix", "dry_beat", "autotune_beat", "preserve", "enhance"] = "ai_mix"
