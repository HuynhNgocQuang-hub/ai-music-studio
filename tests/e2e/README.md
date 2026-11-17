# Phase 1 E2E & Contract Verification (`tests/e2e/`)

Automated integration and contract verification suite for **AI Music Studio — Phase 1 (MVP)**, aligned with:
- [`docs/SRS.md`](../../docs/SRS.md)
- [`docs/MULTI_AGENT_ARCHITECTURE.md`](../../docs/MULTI_AGENT_ARCHITECTURE.md)
- [`docs/API_AND_UI_SPEC.md`](../../docs/API_AND_UI_SPEC.md)

## What is Covered

| Test | Contract / Requirement Verified |
| :--- | :--- |
| `test_health_endpoint` | `GET /api/health` returns `200` with service status |
| `test_upload_rejects_unsupported_extension` | `POST /api/audio/upload` rejects non-audio formats (`.txt`) |
| `test_upload_rejects_short_audio_under_3s` | `POST /api/audio/upload` rejects clips shorter than `3.0s` (`FR-INP`) |
| `test_upload_rejects_oversized_file_over_50mb` | `POST /api/audio/upload` rejects files larger than `50 MB` (`FR-INP`) |
| `test_audio_pipeline_denoise_analyze_autotune_presets` | `denoise` -> `analyze` (BPM `40–220`, key/scale, `raw_melody_midi`) -> `autotune` presets (`off`, `natural`, `balanced`, `modern`) |
| `test_job_generate_and_sse_events` | `POST /api/jobs/generate` (`preserve` + `accompaniment`) + `GET /api/jobs/{job_id}/events` SSE stream |
| `test_job_cancel_endpoint` | `POST /api/jobs/{job_id}/cancel` returns `{"status": "cancelled"}` |
| `test_export_wav_respects_master_limiter_minus_1_dbfs` | `POST /api/projects/{id}/export/audio` (`wav` & `mp3`, `apply_mastering=true`) enforces Master Limiter peak `<= -1.0 dBFS` |
| `test_projects_sync_and_pagination` | `PUT /api/projects/{id}/sync` + `GET /api/projects?page=&limit=&search=&genre=` returns `{items, total, page, total_pages}` |
| `test_frontend_backend_api_contract_parity` | Static parity check between `frontend/src/lib/api/client.ts` and `backend/app/api/*.py` against `docs/API_AND_UI_SPEC.md` |

## Running the Suite

### Option 1 — Inside Docker / Backend Container (In-Process `TestClient`)

```bash
docker compose run --rm backend pytest /app/../tests/e2e/test_phase1_e2e.py -v
```

Or when running inside the repo root with Python + backend dependencies installed:

```bash
pytest tests/e2e/test_phase1_e2e.py -v
```

### Option 2 — Against a Running `docker compose up` Stack

```bash
E2E_BASE_URL=http://localhost:8000 pytest tests/e2e/test_phase1_e2e.py -v
```
