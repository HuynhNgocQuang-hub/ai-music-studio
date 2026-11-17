"""Standalone unit & integration tests for AI Music Studio Multi-Agent Core."""

from __future__ import annotations

import asyncio
import copy
import os
import sys
import unittest
from pathlib import Path
from typing import Any, Dict, List, Tuple

# Ensure `backend/` is importable regardless of working directory
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.agents.arranger_agent import ArrangerAgent
from app.agents.coach_lyricist_agent import CoachLyricistAgent
from app.agents.composer_agent import ComposerAgent, sanitize_user_prompt
from app.agents.llm_adapter import (
    LLMAdapter,
    LLMProvider,
    extract_llm_overrides_from_headers,
    reset_request_llm_overrides,
    set_request_llm_overrides,
)
from app.agents.orchestrator import JobCancelledError, JobTimeoutError, Orchestrator
from app.agents.qa_agent import QAAgent, QAReport


def _sample_project_state(
    melody_mode: str = "preserve",
    output_mode: str = "accompaniment",
) -> Dict[str, Any]:
    return {
        "project_id": "proj_test_001",
        "version": 1,
        "config": {
            "melody_mode": melody_mode,
            "output_mode": output_mode,
            "motif_position": "chorus",
            "genre": "Pop",
            "mood": "Emotional",
            "user_prompt": "Warm piano and clean groove",
        },
        "audio_assets": {
            "raw_input_ref": "mem://raw/input.wav",
            "dry_denoised_ref": "mem://processed/dry_denoised.wav",
            "tuned_vocal_ref": "mem://processed/vocal_autotuned.wav",
        },
        "analysis": {
            "bpm": 100,
            "time_signature": "4/4",
            "detected_key": "C",
            "detected_scale": "major",
            "raw_melody_midi": [
                {"pitch": 60, "start_beat": 0.0, "duration_beats": 1.0, "velocity": 85},
                {"pitch": 64, "start_beat": 1.0, "duration_beats": 1.0, "velocity": 88},
                {"pitch": 67, "start_beat": 2.0, "duration_beats": 2.0, "velocity": 90},
                {"pitch": 65, "start_beat": 4.0, "duration_beats": 1.0, "velocity": 84},
                {"pitch": 64, "start_beat": 5.0, "duration_beats": 1.0, "velocity": 82},
                {"pitch": 62, "start_beat": 6.0, "duration_beats": 2.0, "velocity": 80},
            ],
        },
        "mastering": {
            "auto_mix_enabled": True,
            "limiter_ceiling_db": -1.0,
            "target_lufs": -14.0,
        },
    }


class TestLLMAdapter(unittest.IsolatedAsyncioTestCase):
    async def test_mock_fallback_when_keys_unset_or_placeholder(self) -> None:
        adapter = LLMAdapter(
            gemini_api_key="your_gemini_api_key_here",
            openai_api_key="",
        )
        self.assertEqual(adapter.resolve_provider(role="composer"), LLMProvider.MOCK)
        self.assertEqual(adapter.resolve_provider(role="qa"), LLMProvider.MOCK)

        resp1 = await adapter.generate_json("Create chords in C major", role="composer")
        resp2 = await adapter.generate_json("Create chords in C major", role="composer")
        self.assertTrue(resp1.is_mock)
        self.assertEqual(resp1.provider, LLMProvider.MOCK)
        self.assertEqual(resp1.data, resp2.data)  # Deterministic

    async def test_provider_routing_and_runtime_configure(self) -> None:
        adapter = LLMAdapter()
        adapter.configure(
            gemini_api_key="AIzaDummyValidLookingKey12345",
            openai_api_key="sk-dummy-valid-looking-key-12345",
            role_providers={"composer": "gemini", "qa": "openai"},
        )
        self.assertEqual(adapter.resolve_provider(role="composer"), LLMProvider.GEMINI)
        self.assertEqual(adapter.resolve_provider(role="qa"), LLMProvider.OPENAI)

        # Force mock provider explicitly even when keys are configured
        text_resp = await adapter.generate_text("hello", provider="mock")
        self.assertTrue(text_resp.is_mock)
        self.assertEqual(text_resp.provider, LLMProvider.MOCK)

    async def test_request_header_overrides_context(self) -> None:
        adapter = LLMAdapter()
        overrides = extract_llm_overrides_from_headers(
            {
                "X-Gemini-Api-Key": "AIzaHeaderOverrideKey12345",
                "X-OpenAI-Api-Key": "sk-HeaderOverrideKey12345",
                "X-LLM-Provider": "openai",
            }
        )
        token = set_request_llm_overrides(**overrides)
        try:
            self.assertEqual(adapter.gemini_api_key, "AIzaHeaderOverrideKey12345")
            self.assertEqual(adapter.openai_api_key, "sk-HeaderOverrideKey12345")
            self.assertEqual(adapter.default_provider, LLMProvider.OPENAI)
        finally:
            reset_request_llm_overrides(token)
        self.assertIsNone(adapter._gemini_api_key)


class TestAgentsPipeline(unittest.IsolatedAsyncioTestCase):
    async def test_prompt_sanitization(self) -> None:
        long_prompt = "Make it sound like Taylor Swift! " + ("a" * 600)
        cleaned = sanitize_user_prompt(long_prompt)
        self.assertLessEqual(len(cleaned), 500)
        self.assertNotIn("Taylor Swift", cleaned)

    async def test_preserve_accompaniment_orchestration(self) -> None:
        adapter = LLMAdapter(gemini_api_key="", openai_api_key="")
        orch = Orchestrator(llm_adapter=adapter)
        state = _sample_project_state(melody_mode="preserve", output_mode="accompaniment")
        events: List[Tuple[str, Dict[str, Any]]] = []

        def _collect(ev: str, payload: Dict[str, Any]) -> None:
            events.append((ev, payload))

        result = await orch.run_generate(state, event_callback=_collect)

        # Preserve mode must keep raw melody pitches & start_beats unchanged
        self.assertEqual(len(result["melody_notes"]), 6)
        for orig, comp in zip(state["analysis"]["raw_melody_midi"], result["melody_notes"]):
            self.assertEqual(orig["pitch"], comp["pitch"])
            self.assertEqual(orig["start_beat"], comp["start_beat"])

        # Accompaniment length matches 2 bars of 4/4 input
        self.assertEqual(result["song_structure"]["total_bars"], 2)
        self.assertEqual(len(result["song_structure"]["chords"]), 2)

        # MIDI tracks generated & bass stays <= C4 (60)
        for track_name in ("drums", "bass", "harmony"):
            self.assertIn(track_name, result["tracks"])
            self.assertGreater(len(result["tracks"][track_name]["notes"]), 0)
        for n in result["tracks"]["bass"]["notes"]:
            self.assertLessEqual(n["pitch"], 60)

        # QA passed on 1st iteration & limiter <= -1.0 dBFS
        self.assertTrue(result["qa_status"]["approved"])
        self.assertEqual(result["qa_status"]["iterations"], 1)
        self.assertFalse(result["qa_status"]["fallback_used"])
        self.assertLessEqual(result["mastering"]["limiter_ceiling_db"], -1.0)

        event_names = [ev for ev, _ in events]
        self.assertIn("agent_step", event_names)
        self.assertIn("completed", event_names)

    async def test_enhance_full_song_with_lyrics_and_coach(self) -> None:
        adapter = LLMAdapter(gemini_api_key="", openai_api_key="")
        orch = Orchestrator(llm_adapter=adapter)
        state = _sample_project_state(melody_mode="enhance", output_mode="full_song")
        result = await orch.run_generate(state)

        sections = result["song_structure"]["sections"]
        self.assertGreaterEqual(len(sections), 3)
        chorus_sections = [s for s in sections if "chorus" in s["name"].lower()]
        self.assertTrue(chorus_sections and chorus_sections[0]["has_user_motif"])
        self.assertIn("lead", result["tracks"])
        self.assertGreater(len(result["lyrics"]["lines"]), 0)

        coach = CoachLyricistAgent(adapter)
        before_snapshot = copy.deepcopy(result)
        advice = await coach.chat_coach(result, "Nên đặt câu ngân nga ở Chorus hay Verse?")
        self.assertIn("reply", advice)
        self.assertTrue(advice["reply"])
        self.assertEqual(result, before_snapshot)  # Coach never mutates state

    async def test_qa_loop_max_2_iterations_and_best_effort_fallback(self) -> None:
        adapter = LLMAdapter(gemini_api_key="", openai_api_key="")

        class AlwaysFailQA(QAAgent):
            def __init__(self) -> None:
                super().__init__(adapter)
                self.calls = 0

            async def review(self, project_state: Dict[str, Any], target_track=None) -> QAReport:
                self.calls += 1
                return QAReport(
                    approved=False,
                    score=0.4 + 0.1 * self.calls,
                    issues=["Simulated harmony clash"],
                    feedback="Adjust harmony chord voicing.",
                    fix_target="arranger",
                    recommended_mastering={"limiter_ceiling_db": -1.0, "target_lufs": -14.0},
                )

        qa_stub = AlwaysFailQA()
        orch = Orchestrator(llm_adapter=adapter, qa=qa_stub, max_qa_iterations=2)
        events: List[Tuple[str, Dict[str, Any]]] = []
        result = await orch.run_generate(
            _sample_project_state(),
            event_callback=lambda ev, p: events.append((ev, p)),
        )

        self.assertEqual(qa_stub.calls, 2)
        self.assertFalse(result["qa_status"]["approved"])
        self.assertEqual(result["qa_status"]["iterations"], 2)
        self.assertTrue(result["qa_status"]["fallback_used"])
        event_names = [ev for ev, _ in events]
        self.assertEqual(event_names.count("qa_retry"), 1)
        self.assertIn("fallback_warning", event_names)
        self.assertIn("completed", event_names)

    async def test_timeout_and_cancel_token(self) -> None:
        adapter = LLMAdapter(gemini_api_key="", openai_api_key="")

        class SlowComposer(ComposerAgent):
            async def compose(self, project_state: Dict[str, Any], qa_feedback=None) -> Dict[str, Any]:
                await asyncio.sleep(0.5)
                return await super().compose(project_state, qa_feedback=qa_feedback)

        # Timeout test
        orch_timeout = Orchestrator(
            llm_adapter=adapter,
            composer=SlowComposer(adapter),
            timeout_seconds=0.05,
        )
        timeout_events: List[Tuple[str, Dict[str, Any]]] = []
        with self.assertRaises(JobTimeoutError):
            await orch_timeout.run_generate(
                _sample_project_state(),
                event_callback=lambda ev, p: timeout_events.append((ev, p)),
            )
        self.assertEqual(timeout_events[-1][0], "error")
        self.assertEqual(timeout_events[-1][1]["code"], "timeout")

        # Cancel token test
        orch_cancel = Orchestrator(
            llm_adapter=adapter,
            composer=SlowComposer(adapter),
            timeout_seconds=10.0,
        )
        cancel_event = asyncio.Event()
        cancel_events: List[Tuple[str, Dict[str, Any]]] = []

        async def _trigger_cancel() -> None:
            await asyncio.sleep(0.05)
            cancel_event.set()

        canceller = asyncio.create_task(_trigger_cancel())
        with self.assertRaises(JobCancelledError):
            await orch_cancel.run_generate(
                _sample_project_state(),
                cancel_event=cancel_event,
                event_callback=lambda ev, p: cancel_events.append((ev, p)),
            )
        await canceller
        self.assertEqual(cancel_events[-1][0], "error")
        self.assertEqual(cancel_events[-1][1]["code"], "cancelled")

    async def test_regenerate_single_track_and_rearrange_respects_locked(self) -> None:
        adapter = LLMAdapter(gemini_api_key="", openai_api_key="")
        orch = Orchestrator(llm_adapter=adapter)
        base = await orch.run_generate(_sample_project_state())

        orig_drums = copy.deepcopy(base["tracks"]["drums"])
        orig_harmony = copy.deepcopy(base["tracks"]["harmony"])

        regen = await orch.run_regenerate_track(base, target_track="bass", instrument="synth_bass")
        self.assertEqual(regen["tracks"]["bass"]["instrument"], "synth_bass")
        self.assertEqual(regen["tracks"]["drums"], orig_drums)
        self.assertEqual(regen["tracks"]["harmony"], orig_harmony)

        # Lock drums and rearrange chords
        regen["tracks"]["drums"]["locked"] = True
        new_chords = [
            {"bar": 1, "beat": 1, "symbol": "Am", "duration_beats": 4},
            {"bar": 2, "beat": 1, "symbol": "F", "duration_beats": 4},
        ]
        rearranged = await orch.run_rearrange(regen, chords=new_chords, locked_tracks=["drums"])
        self.assertEqual(rearranged["tracks"]["drums"]["notes"], orig_drums["notes"])
        self.assertEqual(rearranged["song_structure"]["chords"], new_chords)


class TestJobsRouter(unittest.IsolatedAsyncioTestCase):
    async def test_jobs_api_endpoints_if_fastapi_installed(self) -> None:
        try:
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
            from app.api.jobs import router as jobs_router
        except ImportError:
            self.skipTest("fastapi not installed in standalone environment")

        app = FastAPI()
        app.include_router(jobs_router)

        with TestClient(app) as client:
            resp = client.post(
                "/api/jobs/generate",
                json={
                    "project_id": "proj_api_001",
                    "config": {"melody_mode": "preserve", "output_mode": "accompaniment"},
                    "project_state": _sample_project_state(),
                },
            )
            self.assertEqual(resp.status_code, 200)
            job_id = resp.json()["job_id"]

            # Read SSE events stream until completion
            with client.stream("GET", f"/api/jobs/{job_id}/events") as sse_resp:
                self.assertEqual(sse_resp.status_code, 200)
                body = "".join(sse_resp.iter_text())
            self.assertIn("event: agent_step", body)
            self.assertIn("event: completed", body)

            # Invalid regenerate track returns 400
            bad_resp = client.post(
                "/api/jobs/regenerate-track",
                json={"project_id": "proj_api_001", "target_track": "vocal"},
            )
            self.assertEqual(bad_resp.status_code, 400)

            # Valid regenerate + cancel
            regen_resp = client.post(
                "/api/jobs/regenerate-track",
                json={"project_id": "proj_api_001", "target_track": "bass", "instrument": "finger_bass"},
            )
            self.assertEqual(regen_resp.status_code, 200)
            cancel_resp = client.post(f"/api/jobs/{regen_resp.json()['job_id']}/cancel")
            self.assertEqual(cancel_resp.status_code, 200)
            self.assertEqual(cancel_resp.json()["status"], "cancelled")

    async def test_studio_lyrics_coach_and_overdub_endpoints_if_fastapi_installed(self) -> None:
        try:
            import io
            import struct
            import wave
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
            from app.api.studio import router as studio_router
        except ImportError:
            self.skipTest("fastapi not installed in standalone environment")

        app = FastAPI()
        app.include_router(studio_router)

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(struct.pack("<" + "h" * 1600, *([0] * 400 + [8000] * 1200)))
        buf.seek(0)

        with TestClient(app) as client:
            lyr = client.post(
                "/api/lyrics/suggest",
                json={"project_id": "proj_api_001", "language": "vi", "topic": "kỷ niệm", "section": ""},
            )
            self.assertEqual(lyr.status_code, 200)
            self.assertGreater(len(lyr.json()["lines"]), 0)

            coach = client.post(
                "/api/coach/chat",
                json={"project_id": "proj_api_001", "message": "Nên đặt ở Chorus hay Verse?", "history": []},
            )
            self.assertEqual(coach.status_code, 200)
            self.assertIn("reply", coach.json())
            self.assertTrue(len(coach.json()["suggested_actions"]) >= 1)
            self.assertIn("action", coach.json()["suggested_actions"][0])

            fit = client.post(
                "/api/studio/overdub-fit-check",
                data={"project_id": "proj_api_001"},
                files={"file": ("overdub.wav", buf.getvalue(), "audio/wav")},
            )
            self.assertEqual(fit.status_code, 200)
            body = fit.json()
            self.assertIn("timing_offset_ms", body)
            self.assertIn("pitch_issues", body)
            self.assertIn("gain_suggestion", body)
            self.assertIn("one_click_fixes", body)


if __name__ == "__main__":
    unittest.main()
