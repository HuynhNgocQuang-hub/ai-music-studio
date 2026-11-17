"""FastAPI router for Multi-Agent Jobs and realtime SSE progress streaming."""

from __future__ import annotations

import asyncio
import copy
import json
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.agents.llm_adapter import (
    extract_llm_overrides_from_headers,
    reset_request_llm_overrides,
    set_request_llm_overrides,
)
from app.agents.orchestrator import JobCancelledError, JobTimeoutError, orchestrator

router = APIRouter(prefix="/api/jobs", tags=["jobs"])

VALID_MIDI_TRACKS = {"drums", "bass", "harmony", "lead"}
TERMINAL_EVENTS = {"completed", "error"}


class GenerateJobRequest(BaseModel):
    project_id: str = Field(..., min_length=1)
    config: Optional[Dict[str, Any]] = None
    project_state: Optional[Dict[str, Any]] = None


class RegenerateTrackRequest(BaseModel):
    project_id: str = Field(..., min_length=1)
    target_track: str = Field(..., min_length=1)
    instrument: Optional[str] = None
    project_state: Optional[Dict[str, Any]] = None


class RearrangeRequest(BaseModel):
    project_id: str = Field(..., min_length=1)
    chords: List[Dict[str, Any]] = Field(default_factory=list)
    locked_tracks: List[str] = Field(default_factory=list)
    project_state: Optional[Dict[str, Any]] = None


@dataclass
class _JobRuntime:
    job_id: str
    project_id: str
    job_type: str
    status: str = "running"  # running | completed | cancelled | failed | timeout
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    history: List[Tuple[str, Dict[str, Any]]] = field(default_factory=list)
    subscribers: List[asyncio.Queue[Optional[Tuple[str, Dict[str, Any]]]]] = field(default_factory=list)
    task: Optional[asyncio.Task[Any]] = None
    result_state: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

    def publish(self, event_name: str, payload: Dict[str, Any]) -> None:
        item = (event_name, payload)
        self.history.append(item)
        for queue in list(self.subscribers):
            queue.put_nowait(item)
        if event_name in TERMINAL_EVENTS:
            for queue in list(self.subscribers):
                queue.put_nowait(None)


_JOBS: Dict[str, _JobRuntime] = {}
_FALLBACK_PROJECTS: Dict[str, Dict[str, Any]] = {}


def _get_store() -> Any:
    try:
        from app.core.redis_store import get_store  # type: ignore

        return get_store()
    except Exception:
        return None


def _default_project_dict(project_id: str) -> Dict[str, Any]:
    try:
        from app.core.schemas import create_default_project  # type: ignore

        proj = create_default_project(project_id=project_id)
        return proj.model_dump() if hasattr(proj, "model_dump") else proj.dict()
    except Exception:
        return {
            "project_id": project_id,
            "version": 1,
            "config": {
                "melody_mode": "preserve",
                "output_mode": "accompaniment",
                "motif_position": "chorus",
                "genre": "Pop",
                "mood": "Balanced",
                "user_prompt": "",
            },
            "audio_assets": {},
            "analysis": {
                "bpm": 100,
                "time_signature": "4/4",
                "detected_key": "C",
                "detected_scale": "major",
                "raw_melody_midi": [],
            },
            "autotune_settings": {
                "enabled": False,
                "preset": "off",
                "key": "C",
                "scale": "major",
                "retune_speed_ms": 50,
                "humanize": 0.5,
                "mix_percent": 100,
                "auto_follow_project_key": True,
            },
            "song_structure": {"total_bars": 4, "sections": [], "chords": []},
            "lyrics": {"language": "vi", "lines": []},
            "tracks": {},
            "mastering": {
                "auto_mix_enabled": True,
                "limiter_ceiling_db": -1.0,
                "target_lufs": -14.0,
            },
            "qa_status": {
                "approved": False,
                "iterations": 0,
                "fallback_used": False,
                "feedback": "",
            },
        }


def _to_dict(obj: Any) -> Dict[str, Any]:
    if isinstance(obj, dict):
        return copy.deepcopy(obj)
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if hasattr(obj, "dict"):
        return obj.dict()
    raise TypeError(f"Unsupported project state type: {type(obj)}")


def _load_project_state(project_id: str, inline_state: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if inline_state:
        state = copy.deepcopy(inline_state)
        state["project_id"] = project_id
        return state

    store = _get_store()
    if store is not None:
        existing = store.get_project(project_id)
        if existing is not None:
            return _to_dict(existing)

    if project_id in _FALLBACK_PROJECTS:
        return copy.deepcopy(_FALLBACK_PROJECTS[project_id])

    return _default_project_dict(project_id)


def _save_project_state(project_id: str, previous_state: Dict[str, Any], updated_state: Dict[str, Any]) -> None:
    store = _get_store()
    if store is not None:
        try:
            from app.core.schemas import ProjectState  # type: ignore

            prev_obj = ProjectState(**previous_state)
            next_obj = ProjectState(**updated_state)
            try:
                store.push_undo(project_id, prev_obj)
            except Exception:
                pass
            store.save_project(next_obj)
            return
        except Exception:
            pass
    _FALLBACK_PROJECTS[project_id] = copy.deepcopy(updated_state)


def _sync_job_to_store(job: _JobRuntime) -> None:
    store = _get_store()
    if store is None:
        return
    try:
        store.set_job(
            job.job_id,
            {
                "job_id": job.job_id,
                "project_id": job.project_id,
                "job_type": job.job_type,
                "status": job.status,
                "error": job.error,
            },
        )
    except Exception:
        pass


def _make_cancel_check(job: _JobRuntime) -> Any:
    def _check() -> bool:
        if job.cancel_event.is_set():
            return True
        store = _get_store()
        if store is not None:
            try:
                if store.is_cancelled(job.job_id):
                    job.cancel_event.set()
                    return True
            except Exception:
                pass
        return False

    return _check


def _launch_job(
    project_id: str,
    job_type: str,
    initial_state: Dict[str, Any],
    runner_coro_factory: Any,
    llm_overrides: Optional[Dict[str, Any]] = None,
) -> _JobRuntime:
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    job = _JobRuntime(job_id=job_id, project_id=project_id, job_type=job_type)
    _JOBS[job_id] = job
    _sync_job_to_store(job)

    async def _run() -> None:
        token = set_request_llm_overrides(**llm_overrides) if llm_overrides else None
        try:
            updated_state = await runner_coro_factory(job)
            job.result_state = updated_state
            job.status = "completed"
            _save_project_state(project_id, initial_state, updated_state)
        except JobCancelledError:
            job.status = "cancelled"
        except JobTimeoutError as exc:
            job.status = "timeout"
            job.error = str(exc)
        except Exception as exc:
            job.status = "failed"
            job.error = str(exc)
        finally:
            if token is not None:
                reset_request_llm_overrides(token)
            _sync_job_to_store(job)

    job.task = asyncio.create_task(_run())
    return job


@router.post("/generate")
async def start_generate_job(req: GenerateJobRequest, request: Request) -> Dict[str, Any]:
    state = _load_project_state(req.project_id, req.project_state)
    llm_overrides = extract_llm_overrides_from_headers(request.headers)

    async def _runner(job: _JobRuntime) -> Dict[str, Any]:
        return await orchestrator.run_generate(
            project_state=state,
            config_override=req.config,
            job_id=job.job_id,
            event_callback=job.publish,
            cancel_event=job.cancel_event,
            cancel_check=_make_cancel_check(job),
        )

    job = _launch_job(req.project_id, "generate", state, _runner, llm_overrides=llm_overrides)
    return {
        "job_id": job.job_id,
        "project_id": job.project_id,
        "status": job.status,
    }


@router.post("/regenerate-track")
async def start_regenerate_track_job(req: RegenerateTrackRequest, request: Request) -> Dict[str, Any]:
    target = req.target_track.strip().lower()
    if target not in VALID_MIDI_TRACKS:
        raise HTTPException(
            status_code=400,
            detail=f"target_track must be one of {sorted(VALID_MIDI_TRACKS)}",
        )
    state = _load_project_state(req.project_id, req.project_state)
    llm_overrides = extract_llm_overrides_from_headers(request.headers)

    async def _runner(job: _JobRuntime) -> Dict[str, Any]:
        return await orchestrator.run_regenerate_track(
            project_state=state,
            target_track=target,
            instrument=req.instrument,
            job_id=job.job_id,
            event_callback=job.publish,
            cancel_event=job.cancel_event,
            cancel_check=_make_cancel_check(job),
        )

    job = _launch_job(req.project_id, "regenerate_track", state, _runner, llm_overrides=llm_overrides)
    return {
        "job_id": job.job_id,
        "project_id": job.project_id,
        "target_track": target,
        "status": job.status,
    }


@router.post("/rearrange")
async def start_rearrange_job(req: RearrangeRequest, request: Request) -> Dict[str, Any]:
    state = _load_project_state(req.project_id, req.project_state)
    llm_overrides = extract_llm_overrides_from_headers(request.headers)

    async def _runner(job: _JobRuntime) -> Dict[str, Any]:
        return await orchestrator.run_rearrange(
            project_state=state,
            chords=req.chords,
            locked_tracks=req.locked_tracks,
            job_id=job.job_id,
            event_callback=job.publish,
            cancel_event=job.cancel_event,
            cancel_check=_make_cancel_check(job),
        )

    job = _launch_job(req.project_id, "rearrange", state, _runner, llm_overrides=llm_overrides)
    return {
        "job_id": job.job_id,
        "project_id": job.project_id,
        "status": job.status,
    }


@router.get("/{job_id}/events")
async def stream_job_events(job_id: str) -> StreamingResponse:
    job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")

    queue: asyncio.Queue[Optional[Tuple[str, Dict[str, Any]]]] = asyncio.Queue()
    backlog = list(job.history)
    is_finished = any(ev in TERMINAL_EVENTS for ev, _ in backlog) or job.status in {
        "completed",
        "cancelled",
        "failed",
        "timeout",
    }
    if not is_finished:
        job.subscribers.append(queue)

    async def _event_stream() -> AsyncIterator[str]:
        try:
            for event_name, payload in backlog:
                yield f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                if event_name in TERMINAL_EVENTS:
                    return

            if is_finished:
                return

            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue

                if item is None:
                    break
                event_name, payload = item
                yield f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                if event_name in TERMINAL_EVENTS:
                    break
        finally:
            if queue in job.subscribers:
                job.subscribers.remove(queue)

    return StreamingResponse(
        _event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: str) -> Dict[str, Any]:
    job = _JOBS.get(job_id)
    store = _get_store()

    if job is None:
        if store is not None:
            stored = store.get_job(job_id)
            if stored is not None:
                store.set_cancel_flag(job_id)
                stored["status"] = "cancelled"
                store.set_job(job_id, stored)
                return {"job_id": job_id, "status": "cancelled"}
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")

    job.cancel_event.set()
    if job.status == "running":
        job.status = "cancelled"
    if store is not None:
        try:
            store.set_cancel_flag(job_id)
        except Exception:
            pass
    _sync_job_to_store(job)
    return {"job_id": job_id, "status": "cancelled"}
