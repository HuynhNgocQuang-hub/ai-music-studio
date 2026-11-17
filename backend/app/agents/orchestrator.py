"""Multi-Agent Orchestrator implementing an async StateGraph with 60s timeout, cancel token, and QA loop."""

from __future__ import annotations

import asyncio
import copy
import time
import uuid
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .arranger_agent import ArrangerAgent
from .coach_lyricist_agent import CoachLyricistAgent
from .composer_agent import ComposerAgent
from .llm_adapter import LLMAdapter, get_llm_adapter
from .qa_agent import QAAgent, QAReport

EventCallback = Callable[[str, Dict[str, Any]], Any]
CancelCheck = Callable[[], bool]


class JobCancelledError(Exception):
    """Raised when a running multi-agent job is cancelled."""


class JobTimeoutError(Exception):
    """Raised when a multi-agent job exceeds its execution timeout."""


class Orchestrator:
    """Coordinates Composer, Arranger, Lyricist/Coach, and QA Reviewer with Maker-Checker loop."""

    DEFAULT_TIMEOUT_SECONDS = 60.0
    MAX_QA_ITERATIONS = 2

    def __init__(
        self,
        llm_adapter: Optional[LLMAdapter] = None,
        composer: Optional[ComposerAgent] = None,
        arranger: Optional[ArrangerAgent] = None,
        coach_lyricist: Optional[CoachLyricistAgent] = None,
        qa: Optional[QAAgent] = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_qa_iterations: int = MAX_QA_ITERATIONS,
    ) -> None:
        self.llm = llm_adapter or get_llm_adapter()
        self.composer = composer or ComposerAgent(self.llm)
        self.arranger = arranger or ArrangerAgent(self.llm)
        self.coach_lyricist = coach_lyricist or CoachLyricistAgent(self.llm)
        self.qa = qa or QAAgent(self.llm)
        self.timeout_seconds = timeout_seconds
        self.max_qa_iterations = max(1, int(max_qa_iterations))

    async def _emit(
        self,
        callback: Optional[EventCallback],
        event_name: str,
        payload: Dict[str, Any],
    ) -> None:
        if callback is None:
            return
        result = callback(event_name, payload)
        if asyncio.iscoroutine(result):
            await result

    @staticmethod
    def _is_cancelled(
        cancel_event: Optional[asyncio.Event],
        cancel_check: Optional[CancelCheck],
    ) -> bool:
        if cancel_event is not None and cancel_event.is_set():
            return True
        if cancel_check is not None and cancel_check():
            return True
        return False

    async def _run_cancellable(
        self,
        coro: Awaitable[Any],
        cancel_event: Optional[asyncio.Event],
        cancel_check: Optional[CancelCheck],
    ) -> Any:
        if self._is_cancelled(cancel_event, cancel_check):
            raise JobCancelledError("Job cancelled before step execution.")

        task = asyncio.ensure_future(coro)
        if cancel_event is None and cancel_check is None:
            return await task

        while not task.done():
            if self._is_cancelled(cancel_event, cancel_check):
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                raise JobCancelledError("Job cancelled during execution.")

            if cancel_event is not None:
                wait_cancel = asyncio.create_task(cancel_event.wait())
                done, pending = await asyncio.wait(
                    {task, wait_cancel},
                    timeout=0.05,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if wait_cancel in pending:
                    wait_cancel.cancel()
                    try:
                        await wait_cancel
                    except asyncio.CancelledError:
                        pass
                if cancel_event.is_set() and not task.done():
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                    raise JobCancelledError("Job cancelled by cancel token.")
            else:
                await asyncio.wait({task}, timeout=0.05)

        return await task

    async def run_generate(
        self,
        project_state: Dict[str, Any],
        config_override: Optional[Dict[str, Any]] = None,
        job_id: Optional[str] = None,
        event_callback: Optional[EventCallback] = None,
        cancel_event: Optional[asyncio.Event] = None,
        cancel_check: Optional[CancelCheck] = None,
        timeout_seconds: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Full generation state machine: Composer -> Arranger -> QA loop (max 2) -> Fallback."""
        jid = job_id or f"job_{uuid.uuid4().hex[:10]}"
        timeout = self.timeout_seconds if timeout_seconds is None else timeout_seconds
        state = copy.deepcopy(project_state)
        if config_override:
            merged_cfg = dict(state.get("config") or {})
            merged_cfg.update({k: v for k, v in config_override.items() if v is not None})
            state["config"] = merged_cfg

        async def _execute() -> Dict[str, Any]:
            started = time.monotonic()
            best_state: Optional[Dict[str, Any]] = None
            best_report: Optional[QAReport] = None
            qa_feedback: Optional[str] = None
            next_stage = "composer"

            for iteration in range(1, self.max_qa_iterations + 1):
                if next_stage == "composer":
                    await self._emit(
                        event_callback,
                        "agent_step",
                        {
                            "job_id": jid,
                            "agent": "composer",
                            "step": "compose",
                            "iteration": iteration,
                            "message": "Composer designing harmony & structure",
                            "progress": 20 if iteration == 1 else 55,
                        },
                    )
                    comp_out = await self._run_cancellable(
                        self.composer.compose(state, qa_feedback=qa_feedback),
                        cancel_event,
                        cancel_check,
                    )
                    state["song_structure"] = comp_out["song_structure"]
                    state["melody_notes"] = comp_out["melody_notes"]
                    cfg = dict(state.get("config") or {})
                    cfg["user_prompt"] = comp_out.get("sanitized_prompt", cfg.get("user_prompt", ""))
                    if cfg.get("motif_position") == "auto":
                        cfg["motif_position"] = comp_out.get("motif_position", "chorus")
                    state["config"] = cfg

                await self._emit(
                    event_callback,
                    "agent_step",
                    {
                        "job_id": jid,
                        "agent": "arranger",
                        "step": "arrange",
                        "iteration": iteration,
                        "message": "Arranger generating MIDI tracks (drums, bass, harmony)",
                        "progress": 50 if iteration == 1 else 72,
                    },
                )
                tracks = await self._run_cancellable(
                    self.arranger.arrange(
                        state,
                        melody_notes=state.get("melody_notes"),
                        qa_feedback=qa_feedback,
                    ),
                    cancel_event,
                    cancel_check,
                )
                state["tracks"] = tracks

                # Optional lyrics generation in full_song mode
                cfg = state.get("config") or {}
                if (
                    iteration == 1
                    and str(cfg.get("output_mode", "")).lower() == "full_song"
                    and cfg.get("include_lyrics", True)
                ):
                    await self._emit(
                        event_callback,
                        "agent_step",
                        {
                            "job_id": jid,
                            "agent": "lyricist",
                            "step": "suggest_lyrics",
                            "iteration": iteration,
                            "message": "Lyricist aligning lyrics to sections",
                            "progress": 65,
                        },
                    )
                    lyrics = await self._run_cancellable(
                        self.coach_lyricist.suggest_lyrics(
                            state,
                            language=str(cfg.get("language", "vi")),
                            topic=str(cfg.get("mood", "")),
                        ),
                        cancel_event,
                        cancel_check,
                    )
                    state["lyrics"] = lyrics

                await self._emit(
                    event_callback,
                    "agent_step",
                    {
                        "job_id": jid,
                        "agent": "qa",
                        "step": "review",
                        "iteration": iteration,
                        "message": f"QA reviewing harmony & mastering (iteration {iteration}/{self.max_qa_iterations})",
                        "progress": 82,
                    },
                )
                report = await self._run_cancellable(
                    self.qa.review(state),
                    cancel_event,
                    cancel_check,
                )

                if best_report is None or report.score >= best_report.score:
                    best_report = report
                    best_state = copy.deepcopy(state)

                if report.approved:
                    self._apply_qa_and_mastering(state, report, iterations=iteration, fallback_used=False)
                    await self._emit(
                        event_callback,
                        "progress",
                        {
                            "job_id": jid,
                            "progress": 100,
                            "stage": "done",
                            "elapsed_sec": round(time.monotonic() - started, 3),
                        },
                    )
                    await self._emit(
                        event_callback,
                        "completed",
                        {
                            "job_id": jid,
                            "project_id": state.get("project_id", ""),
                            "status": "completed",
                            "fallback_used": False,
                            "qa_status": state["qa_status"],
                            "project_state": state,
                        },
                    )
                    return state

                qa_feedback = report.feedback
                next_stage = report.fix_target or "arranger"
                if iteration < self.max_qa_iterations:
                    await self._emit(
                        event_callback,
                        "qa_retry",
                        {
                            "job_id": jid,
                            "iteration": iteration,
                            "max_iterations": self.max_qa_iterations,
                            "issues": report.issues,
                            "feedback": report.feedback,
                            "fix_target": next_stage,
                        },
                    )

            # Best-effort Fallback after max QA iterations
            assert best_state is not None and best_report is not None
            self._apply_qa_and_mastering(
                best_state,
                best_report,
                iterations=self.max_qa_iterations,
                fallback_used=True,
            )
            await self._emit(
                event_callback,
                "fallback_warning",
                {
                    "job_id": jid,
                    "message": "QA reached max iterations; returning best-effort arrangement for Studio refinement.",
                    "issues": best_report.issues,
                    "iterations": self.max_qa_iterations,
                },
            )
            await self._emit(
                event_callback,
                "progress",
                {
                    "job_id": jid,
                    "progress": 100,
                    "stage": "done_fallback",
                    "elapsed_sec": round(time.monotonic() - started, 3),
                },
            )
            await self._emit(
                event_callback,
                "completed",
                {
                    "job_id": jid,
                    "project_id": best_state.get("project_id", ""),
                    "status": "completed",
                    "fallback_used": True,
                    "qa_status": best_state["qa_status"],
                    "project_state": best_state,
                },
            )
            return best_state

        return await self._run_with_guards(jid, _execute(), timeout, event_callback)

    async def run_regenerate_track(
        self,
        project_state: Dict[str, Any],
        target_track: str,
        instrument: Optional[str] = None,
        job_id: Optional[str] = None,
        event_callback: Optional[EventCallback] = None,
        cancel_event: Optional[asyncio.Event] = None,
        cancel_check: Optional[CancelCheck] = None,
        timeout_seconds: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Regenerate a single MIDI track while keeping all other tracks & sections locked."""
        jid = job_id or f"job_{uuid.uuid4().hex[:10]}"
        timeout = self.timeout_seconds if timeout_seconds is None else timeout_seconds
        state = copy.deepcopy(project_state)
        track_key = target_track.lower().strip()

        async def _execute() -> Dict[str, Any]:
            started = time.monotonic()
            best_state: Optional[Dict[str, Any]] = None
            best_report: Optional[QAReport] = None
            qa_feedback: Optional[str] = None

            for iteration in range(1, self.max_qa_iterations + 1):
                await self._emit(
                    event_callback,
                    "agent_step",
                    {
                        "job_id": jid,
                        "agent": "arranger",
                        "step": "regenerate_track",
                        "target_track": track_key,
                        "iteration": iteration,
                        "message": f"Regenerating track '{track_key}'",
                        "progress": 40,
                    },
                )
                tracks = await self._run_cancellable(
                    self.arranger.arrange(
                        state,
                        melody_notes=state.get("melody_notes"),
                        target_track=track_key,
                        instrument_override=instrument,
                        qa_feedback=qa_feedback,
                    ),
                    cancel_event,
                    cancel_check,
                )
                state["tracks"] = tracks

                await self._emit(
                    event_callback,
                    "agent_step",
                    {
                        "job_id": jid,
                        "agent": "qa",
                        "step": "review_track",
                        "target_track": track_key,
                        "iteration": iteration,
                        "message": f"QA verifying regenerated '{track_key}'",
                        "progress": 80,
                    },
                )
                report = await self._run_cancellable(
                    self.qa.review(state, target_track=track_key),
                    cancel_event,
                    cancel_check,
                )

                if best_report is None or report.score >= best_report.score:
                    best_report = report
                    best_state = copy.deepcopy(state)

                if report.approved:
                    self._apply_qa_and_mastering(state, report, iterations=iteration, fallback_used=False)
                    await self._emit(
                        event_callback,
                        "progress",
                        {"job_id": jid, "progress": 100, "stage": "done", "elapsed_sec": round(time.monotonic() - started, 3)},
                    )
                    await self._emit(
                        event_callback,
                        "completed",
                        {
                            "job_id": jid,
                            "project_id": state.get("project_id", ""),
                            "status": "completed",
                            "fallback_used": False,
                            "qa_status": state["qa_status"],
                            "project_state": state,
                        },
                    )
                    return state

                qa_feedback = report.feedback
                if iteration < self.max_qa_iterations:
                    await self._emit(
                        event_callback,
                        "qa_retry",
                        {
                            "job_id": jid,
                            "iteration": iteration,
                            "max_iterations": self.max_qa_iterations,
                            "issues": report.issues,
                            "feedback": report.feedback,
                            "fix_target": "arranger",
                        },
                    )

            assert best_state is not None and best_report is not None
            self._apply_qa_and_mastering(best_state, best_report, iterations=self.max_qa_iterations, fallback_used=True)
            await self._emit(
                event_callback,
                "fallback_warning",
                {
                    "job_id": jid,
                    "message": f"Track '{track_key}' QA reached max iterations; returning best-effort track.",
                    "issues": best_report.issues,
                    "iterations": self.max_qa_iterations,
                },
            )
            await self._emit(
                event_callback,
                "completed",
                {
                    "job_id": jid,
                    "project_id": best_state.get("project_id", ""),
                    "status": "completed",
                    "fallback_used": True,
                    "qa_status": best_state["qa_status"],
                    "project_state": best_state,
                },
            )
            return best_state

        return await self._run_with_guards(jid, _execute(), timeout, event_callback)

    async def run_rearrange(
        self,
        project_state: Dict[str, Any],
        chords: List[Dict[str, Any]],
        locked_tracks: Optional[List[str]] = None,
        job_id: Optional[str] = None,
        event_callback: Optional[EventCallback] = None,
        cancel_event: Optional[asyncio.Event] = None,
        cancel_check: Optional[CancelCheck] = None,
        timeout_seconds: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Re-arrange unlocked accompaniment tracks to follow edited Chord Timeline."""
        jid = job_id or f"job_{uuid.uuid4().hex[:10]}"
        timeout = self.timeout_seconds if timeout_seconds is None else timeout_seconds
        state = copy.deepcopy(project_state)
        song_structure = dict(state.get("song_structure") or {})
        song_structure["chords"] = copy.deepcopy(chords)
        if not song_structure.get("total_bars") and chords:
            song_structure["total_bars"] = max(int(c.get("bar", 1)) for c in chords)
        state["song_structure"] = song_structure

        async def _execute() -> Dict[str, Any]:
            started = time.monotonic()
            best_state: Optional[Dict[str, Any]] = None
            best_report: Optional[QAReport] = None
            qa_feedback: Optional[str] = None

            for iteration in range(1, self.max_qa_iterations + 1):
                await self._emit(
                    event_callback,
                    "agent_step",
                    {
                        "job_id": jid,
                        "agent": "arranger",
                        "step": "rearrange",
                        "iteration": iteration,
                        "message": "Re-arranging unlocked tracks to match updated chords",
                        "progress": 45,
                    },
                )
                tracks = await self._run_cancellable(
                    self.arranger.arrange(
                        state,
                        melody_notes=state.get("melody_notes"),
                        locked_tracks=locked_tracks or [],
                        qa_feedback=qa_feedback,
                    ),
                    cancel_event,
                    cancel_check,
                )
                state["tracks"] = tracks

                await self._emit(
                    event_callback,
                    "agent_step",
                    {
                        "job_id": jid,
                        "agent": "qa",
                        "step": "review_rearrange",
                        "iteration": iteration,
                        "message": "QA checking re-arranged harmony",
                        "progress": 82,
                    },
                )
                report = await self._run_cancellable(
                    self.qa.review(state),
                    cancel_event,
                    cancel_check,
                )

                if best_report is None or report.score >= best_report.score:
                    best_report = report
                    best_state = copy.deepcopy(state)

                if report.approved:
                    self._apply_qa_and_mastering(state, report, iterations=iteration, fallback_used=False)
                    await self._emit(
                        event_callback,
                        "progress",
                        {"job_id": jid, "progress": 100, "stage": "done", "elapsed_sec": round(time.monotonic() - started, 3)},
                    )
                    await self._emit(
                        event_callback,
                        "completed",
                        {
                            "job_id": jid,
                            "project_id": state.get("project_id", ""),
                            "status": "completed",
                            "fallback_used": False,
                            "qa_status": state["qa_status"],
                            "project_state": state,
                        },
                    )
                    return state

                qa_feedback = report.feedback
                if iteration < self.max_qa_iterations:
                    await self._emit(
                        event_callback,
                        "qa_retry",
                        {
                            "job_id": jid,
                            "iteration": iteration,
                            "max_iterations": self.max_qa_iterations,
                            "issues": report.issues,
                            "feedback": report.feedback,
                            "fix_target": "arranger",
                        },
                    )

            assert best_state is not None and best_report is not None
            self._apply_qa_and_mastering(best_state, best_report, iterations=self.max_qa_iterations, fallback_used=True)
            await self._emit(
                event_callback,
                "fallback_warning",
                {
                    "job_id": jid,
                    "message": "Rearrange QA reached max iterations; returning best-effort arrangement.",
                    "issues": best_report.issues,
                    "iterations": self.max_qa_iterations,
                },
            )
            await self._emit(
                event_callback,
                "completed",
                {
                    "job_id": jid,
                    "project_id": best_state.get("project_id", ""),
                    "status": "completed",
                    "fallback_used": True,
                    "qa_status": best_state["qa_status"],
                    "project_state": best_state,
                },
            )
            return best_state

        return await self._run_with_guards(jid, _execute(), timeout, event_callback)

    async def _run_with_guards(
        self,
        job_id: str,
        coro: Awaitable[Dict[str, Any]],
        timeout: float,
        event_callback: Optional[EventCallback],
    ) -> Dict[str, Any]:
        try:
            return await asyncio.wait_for(coro, timeout=timeout)
        except asyncio.TimeoutError as exc:
            await self._emit(
                event_callback,
                "error",
                {
                    "job_id": job_id,
                    "code": "timeout",
                    "message": f"Multi-agent job timed out after {timeout}s.",
                },
            )
            raise JobTimeoutError(f"Job {job_id} timed out after {timeout}s") from exc
        except JobCancelledError:
            await self._emit(
                event_callback,
                "error",
                {
                    "job_id": job_id,
                    "code": "cancelled",
                    "message": "Job cancelled by user.",
                },
            )
            raise
        except Exception as exc:
            await self._emit(
                event_callback,
                "error",
                {
                    "job_id": job_id,
                    "code": "internal_error",
                    "message": str(exc),
                },
            )
            raise

    @staticmethod
    def _apply_qa_and_mastering(
        state: Dict[str, Any],
        report: QAReport,
        iterations: int,
        fallback_used: bool,
    ) -> None:
        state["qa_status"] = {
            "approved": bool(report.approved),
            "iterations": iterations,
            "fallback_used": fallback_used,
            "feedback": report.feedback,
        }
        mastering = dict(state.get("mastering") or {})
        mastering.update(report.recommended_mastering)
        if float(mastering.get("limiter_ceiling_db", -1.0)) > -1.0:
            mastering["limiter_ceiling_db"] = -1.0
        state["mastering"] = mastering
        state["version"] = int(state.get("version") or 1) + 1


orchestrator = Orchestrator()
