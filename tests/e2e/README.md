# E2E & Contract Verification (`tests/e2e/`)

Automated integration, security, and contract verification suite for **AI Music Studio (Phase 1–5)**, aligned with:
- [`docs/SRS.md`](../../docs/SRS.md)
- [`docs/MULTI_AGENT_ARCHITECTURE.md`](../../docs/MULTI_AGENT_ARCHITECTURE.md)
- [`docs/API_AND_UI_SPEC.md`](../../docs/API_AND_UI_SPEC.md)

## What is Covered

### `test_phase1_e2e.py` (10 Tests)
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

### `test_phase2_3_e2e.py` (10 Tests — Full Song, Pro DAW, CRUD, Security & Lifecycle)
- `test_full_song_standard_structure_includes_bridge_and_short_preset`
- `test_studio_auto_trim_vocal_trims_silence_and_updates_clips`
- `test_studio_auto_mix_balances_tracks_and_enables_limiter`
- `test_clip_upload_creates_texture_track_and_validates_format`
- `test_multiclip_trim_fade_export_and_stems`
- `test_piano_roll_note_update_and_midi_export`
- `test_phase2_3_frontend_backend_contract_parity`
- `test_phase4_crud_eq_send_fx_and_delete`
- `test_security_headers_validation_and_dos_guards` (`nosniff`/`DENY`/`no-referrer`, Zip Bomb/path traversal, collision-safe `.aimusic` import, `total_bars > 256` -> `400`)
- `test_end_to_end_full_lifecycle_workflow` (Upload -> Denoise -> Analyze -> AutoTune -> Generate SSE -> Overdub -> Export/Import)

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

### 2. Live E2E Against a Running Stack (`music` Compose + Backend `:8000`)

```bash
docker compose -p music up -d redis audio-worker
# Start Spring Boot backend on :8000 (or run ./start-dev.ps1 on Windows)
E2E_BASE_URL=http://localhost:8000 pytest tests/e2e/test_phase1_e2e.py tests/e2e/test_phase2_3_e2e.py -v
```
