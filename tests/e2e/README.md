# Phase 1 E2E & Contract Verification (`tests/e2e/`)

Automated integration and contract verification suite for **AI Music Studio — Phase 1 (Option B)**, aligned with:
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
| `test_frontend_backend_api_contract_parity` | Static parity check across `frontend/src/lib/api/client.ts`, Spring Boot `controller/*.java`, `AudioWorkerClient.java`, and `audio-worker/app/main.py` |

## Running the Suite

### 1. Component Test Suites (No Running Server Required)

```bash
# Spring Boot Backend (MockMvc, Multi-Agent QA loop/fallback, Audio fallback & Master Limiter)
cd backend && mvn test

# Python Audio Worker (inside Docker image)
docker build -t ai-music-audio-worker-test ./audio-worker
docker run --rm ai-music-audio-worker-test pytest -v tests/test_worker.py

# React Vite Frontend (TypeScript + Production Bundle)
cd frontend && npm install && npx tsc --noEmit && npm run build

# Static Contract Parity Test via audio-worker container
docker run --rm -v "${PWD}:/workspace" ai-music-audio-worker-test pytest /workspace/tests/e2e/test_phase1_e2e.py -k test_frontend_backend_api_contract_parity -v
```

### 2. Live E2E Against a Running `docker compose up` Stack

```bash
docker compose up --build -d
E2E_BASE_URL=http://localhost:8000 pytest tests/e2e/test_phase1_e2e.py -v
```
