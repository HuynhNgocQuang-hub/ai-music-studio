"""Pydantic schemas for the stateless Audio DSP Worker microservice."""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


class _WorkerBaseModel(BaseModel):
    model_config = ConfigDict(extra="ignore")


class MidiNote(_WorkerBaseModel):
    """Single symbolic MIDI note event."""

    pitch: int = Field(..., ge=0, le=127)
    start_beat: float = Field(..., ge=0.0)
    duration: float = Field(..., gt=0.0, validation_alias=AliasChoices("duration", "duration_beats"))
    velocity: int = Field(default=85, ge=1, le=127)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class AudioAssets(_WorkerBaseModel):
    """Audio asset reference keys inside ProjectState."""

    raw_input_ref: Optional[str] = None
    dry_denoised_ref: Optional[str] = None
    tuned_vocal_ref: Optional[str] = None


class AnalysisResult(_WorkerBaseModel):
    """Audio analyzer result."""

    bpm: float = Field(default=120.0, ge=40.0, le=220.0)
    time_signature: str = Field(default="4/4")
    detected_key: str = Field(default="C")
    detected_scale: str = Field(default="major")
    key_confidence: float = Field(default=0.8, ge=0.0, le=1.0)
    low_confidence_warning: bool = False
    bars: int = Field(default=4, ge=1)
    duration_sec: float = Field(default=0.0, ge=0.0)
    raw_melody_midi: list[MidiNote] = Field(default_factory=list)


class AutotuneSettings(_WorkerBaseModel):
    """Auto-Tune DSP configuration."""

    enabled: bool = False
    preset: Literal["off", "natural", "balanced", "modern"] = "off"
    key: str = Field(default="C")
    scale: Literal["major", "minor", "pentatonic_major", "pentatonic_minor", "chromatic"] = "major"
    retune_speed_ms: float = Field(default=35.0, ge=0.0, le=200.0)
    humanize: float = Field(default=0.6, ge=0.0, le=1.0)
    mix_percent: float = Field(default=100.0, ge=0.0, le=100.0)
    auto_follow_project_key: bool = True


class SongStructure(_WorkerBaseModel):
    """Minimal song structure fields needed by audio renderer."""

    total_bars: int = Field(default=4, ge=1)


class AudioClip(_WorkerBaseModel):
    """Audio clip on an audio track timeline."""

    id: str = "clip_1"
    source: str
    start_bar: float = Field(default=1.0, ge=1.0)
    trim_start_sec: float = Field(default=0.0, ge=0.0)
    trim_end_sec: Optional[float] = None
    fade_in_ms: float = Field(default=20.0, ge=0.0)
    fade_out_ms: float = Field(default=20.0, ge=0.0)
    offset_ms: float = 0.0


class TrackState(_WorkerBaseModel):
    """Single track in Hybrid Multi-Track Studio."""

    type: Literal["audio", "midi"]
    locked: bool = False
    mute: bool = False
    solo: bool = False
    volume: float = Field(default=0.9, ge=0.0, le=1.2)
    pan: float = Field(default=0.0, ge=-1.0, le=1.0)
    low_db: float = Field(default=0.0, ge=-12.0, le=12.0)
    mid_db: float = Field(default=0.0, ge=-12.0, le=12.0)
    high_db: float = Field(default=0.0, ge=-12.0, le=12.0)
    reverb_send: float = Field(default=0.0, ge=0.0, le=1.0)
    delay_send: float = Field(default=0.0, ge=0.0, le=1.0)
    instrument: Optional[str] = None
    clips: list[AudioClip] = Field(default_factory=list)
    notes: list[MidiNote] = Field(default_factory=list)


class MasteringSettings(_WorkerBaseModel):
    """Auto-mix and limiter mastering settings."""

    auto_mix_enabled: bool = True
    limiter_ceiling_db: float = Field(default=-1.0, le=-1.0)
    target_lufs: float = -14.0

    @field_validator("limiter_ceiling_db")
    @classmethod
    def enforce_ceiling(cls, value: float) -> float:
        return min(value, -1.0)


class ProjectState(_WorkerBaseModel):
    """Subset of Shared Project State required for rendering & exporting."""

    project_id: str = "default"
    audio_assets: AudioAssets = Field(default_factory=AudioAssets)
    analysis: AnalysisResult = Field(default_factory=AnalysisResult)
    autotune_settings: AutotuneSettings = Field(default_factory=AutotuneSettings)
    song_structure: SongStructure = Field(default_factory=SongStructure)
    tracks: dict[str, TrackState] = Field(default_factory=dict)
    mastering: MasteringSettings = Field(default_factory=MasteringSettings)


PreviewMode = Literal[
    "raw",
    "dry",
    "dry_beat",
    "autotune",
    "autotune_beat",
    "preserve",
    "enhance",
    "ai_mix",
    "mix",
]


def _normalize_mode_value(value: Any) -> Any:
    if isinstance(value, str):
        cleaned = value.strip().lower()
        return cleaned or "ai_mix"
    return value


class RenderRequest(_WorkerBaseModel):
    """Request payload for POST /internal/audio/render."""

    project: ProjectState
    audio_assets_base64: dict[str, str] = Field(default_factory=dict)
    mode: PreviewMode = "ai_mix"
    apply_mastering: bool = True
    sample_rate: int = Field(default=44100, ge=8000, le=96000)

    @field_validator("mode", mode="before")
    @classmethod
    def normalize_mode(cls, value: Any) -> Any:
        return _normalize_mode_value(value)


class ExportRequest(_WorkerBaseModel):
    """Request payload for POST /internal/audio/export."""

    project: ProjectState
    audio_assets_base64: dict[str, str] = Field(default_factory=dict)
    format: Literal["wav", "mp3", "stems"] = "wav"
    mode: PreviewMode = "ai_mix"
    apply_mastering: bool = True
    sample_rate: int = Field(default=44100, ge=8000, le=96000)
    bitrate: Literal["192k", "320k"] = "320k"

    @field_validator("mode", mode="before")
    @classmethod
    def normalize_mode(cls, value: Any) -> Any:
        return _normalize_mode_value(value)

    @field_validator("bitrate", mode="before")
    @classmethod
    def normalize_bitrate(cls, value: Any) -> str:
        if isinstance(value, str) and value.strip().startswith("192"):
            return "192k"
        return "320k"


class DenoiseWorkerResponse(_WorkerBaseModel):
    wav_base64: str
    trimmed_start_sec: float
    trimmed_end_sec: float
    duration_sec: float
    snr_db_estimate: float
    sample_rate: int
    channels: int
    warnings: list[str] = Field(default_factory=list)


class AnalyzeWorkerResponse(_WorkerBaseModel):
    bpm: float
    time_signature: str
    detected_key: str
    detected_scale: str
    key_confidence: float
    low_confidence_warning: bool
    bars: int
    duration_sec: float
    raw_melody_midi: list[MidiNote] = Field(default_factory=list)


class AutotuneWorkerResponse(_WorkerBaseModel):
    wav_base64: str
    autotune_settings: AutotuneSettings
    duration_sec: float
    sample_rate: int


class PitchIssue(_WorkerBaseModel):
    bar: int
    note: str
    cents_off: float
    description: str


class OneClickFix(_WorkerBaseModel):
    id: str
    label: str
    action_type: str
    value: Any


class OverdubFitCheckResponse(_WorkerBaseModel):
    timing_offset_ms: float
    pitch_issues: list[PitchIssue] = Field(default_factory=list)
    gain_suggestion: str
    one_click_fixes: list[OneClickFix] = Field(default_factory=list)
