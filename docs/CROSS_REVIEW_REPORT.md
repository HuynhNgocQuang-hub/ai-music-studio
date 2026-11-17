# Báo cáo Kiểm lỗi Chéo & Live E2E Verification (`Option B`)
## Dự án: AI Music Studio — Phase 1 MVP (React 19 Vite + Java 21 Spring Boot + Python Audio Worker + Redis)

- **Ngày kiểm tra:** 2026-11-17 (Cập nhật Post-Fix Verification)
- **Người tổng hợp:** `live-e2e-runner` + `verify-e2e` (tổng hợp từ Live E2E Docker/Host + báo cáo `@review-be-by-fe` `#38`, `@review-fe-by-be` `#36`, và xác nhận sau merge `#46`–`#48`)
- **Tài liệu đối chiếu:** [SRS.md](./SRS.md) | [API_AND_UI_SPEC.md](./API_AND_UI_SPEC.md) | [MULTI_AGENT_ARCHITECTURE.md](./MULTI_AGENT_ARCHITECTURE.md) | [TASK_BOARD.md](./TASK_BOARD.md)

---

## 1. Tóm tắt Điều hành & Kết quả Chạy Test / Build Thực tế

Hệ thống Option B sau khi merge 3 nhánh sửa lỗi (`fix-worker-hygiene` `919fb3a`, `fix-spring` `4500977`, `fix-react` `fc46128`) đã vượt qua **toàn bộ** build, unit test, và Live E2E:
- **Docker Engine:** Version `29.5.3` (`desktop-linux`, WSL2) — **Đang chạy**.
- **Redis Container (`ai-music-redis`):** `redis:7-alpine` cổng `6379` — **Up (healthy)**.
- **Audio Worker Container (`ai-music-audio-worker`):** `music-audio-worker` (rebuilt via `docker compose up -d --build redis audio-worker`) cổng `8001` — **Up (healthy)** (`ffmpeg`, `fluidsynth`, `soundfont`, `noisereduce`, `librosa`, `pedalboard` khả dụng).
- **Spring Boot Backend (Host Java 21.0.9):** khởi động sạch phiên bản đã merge trên cổng `8000` khi chạy Live E2E (`/api/health` trả `200 OK` với `redis.connected=true`, `audio_worker_available=true`, `ffmpeg_available=true`, `fluidsynth_available=true`, `soundfont_available=true`) và đã dừng gọn tiến trình test tạm thời sau khi xác nhận xong.

### Bảng Tổng hợp Kết quả Kiểm thử (Post-Fix)

| Hạng mục | Lệnh thực thi | Kết quả | Chi tiết |
| :--- | :--- | :--- | :--- |
| **Audio Worker Unit/DSP Tests (Docker)** | `docker build -t ai-music-audio-worker-test ./audio-worker` & `docker run --rm ai-music-audio-worker-test pytest -v tests/test_worker.py` | **PASS (`8/8`)** | `8 passed, 2 warnings in 54.28s` (`test_health`, `test_denoise_analyze_autotune_pipeline`, `test_autotune_enharmonic_keys`, `test_master_limiter_ceiling`, `test_render_and_export_endpoints`, `test_overdub_fit_check`, `test_overdub_fit_check_real_cents_off`, `test_render_mode_differentiation`). |
| **Spring Boot Test Suite** | `cd backend && mvn test` | **PASS (`19/19`)** | `BUILD SUCCESS` (`02:12 min`): `AgentPipelineTests` (`8/8`), `ApiMockMvcTests` (`2/2`), `AudioAndLimiterTests` (`9/9`), `0` skipped. |
| **Frontend TypeScript & Vite Build** | `cd frontend && npx.cmd tsc --noEmit && npm.cmd run build` | **PASS** | Exit `0` (`vite v6.4.6`, `2155 modules transformed`, `dist/index.html` 0.63 kB, `dist/assets/index-BnG-zvNs.css` 39.88 kB, `dist/assets/index-C1s2ZMGX.js` 419.12 kB, `built in 13.68s`). |
| **Docker Compose Config** | `docker compose config -q` | **PASS** | Exit `0`. |
| **Live E2E Suite (`tests/e2e/test_phase1_e2e.py`)** | `docker run --rm --add-host=host.docker.internal:host-gateway -v D:/Music:/workspace -e E2E_BASE_URL=http://host.docker.internal:8000 ai-music-audio-worker-test pytest -v /workspace/tests/e2e/test_phase1_e2e.py` | **PASS (`10/10`)** | `10 passed in 12.09s` — **toàn bộ** test đều pass, bao gồm `test_export_wav_respects_master_limiter_minus_1_dbfs` (WAV `<= -1.0 dBFS` & MP3 `200 OK`). |
| **Live Probe Preview Modes, Auto-Tune Pro & Worker Logs** | Probe `/api/audio/preview/{id}?mode=...`, `/api/audio/autotune`, `/api/studio/overdub-fit-check` & `docker logs ai-music-audio-worker --tail 60` | **PASS (`200 OK`)** | 7 preview modes (`raw`, `dry`, `dry_beat`, `autotune`, `preserve`, `enhance`, `ai_mix`) đều `200 OK` với **7 SHA-256 hash khác nhau**; Auto-Tune Pro (`preset="off"`, `enabled=true`, `scale="pentatonic_minor"`, `auto_follow_project_key=false`) trả `200 OK` giữ nguyên cấu hình; `docker logs` **0 lỗi `422` / `Unsupported upgrade request`**, mọi lệnh `/internal/audio/*` đều `200 OK`. |

---

## 2. Kết quả Live E2E & Xác nhận Khắc phục `P0 Blocker` (`OPTB-BUG-01` — `FIXED`)

### `OPTB-BUG-01` [P0 - BLOCKER -> `FIXED`] — `AudioWorkerClient` gửi `HTTP/2 h2c` Upgrade khiến `audio-worker` (`uvicorn`) trả `422` trên mọi lệnh DSP & gây `503` khi Export MP3

- **Trạng thái xác nhận:** **`FIXED`** (đã sửa tại `4500977` và xác nhận qua Live E2E `10/10` pass + `docker logs ai-music-audio-worker`).
- **Vị trí lỗi ban đầu:** `backend/src/main/java/com/aimusic/studio/audio/AudioWorkerClient.java:38-40, 141-147, 177-183`
- **Triệu chứng ban đầu:** `test_export_wav_respects_master_limiter_minus_1_dbfs` pass bước WAV nhưng fail bước Export MP3 (`503`) vì `HttpClient` mặc định `HTTP_2` gửi `Upgrade: h2c` khiến Uvicorn từ chối body (`422`) và mọi lệnh DSP rơi xuống Java fallback.
- **Kết quả sau sửa (`HttpClient.Version.HTTP_1_1` + log `WARN` khi non-2xx):**
  - Live E2E `test_export_wav_respects_master_limiter_minus_1_dbfs` **PASS** (WAV `<= -1.0 dBFS` + MP3 `200 OK`).
  - `docker logs ai-music-audio-worker --tail 60` ghi nhận `POST /internal/audio/denoise`, `/analyze`, `/autotune`, `/render`, `/export`, `/overdub-fit-check` đều trả **`200 OK`**, không còn bất kỳ `422 Unprocessable Entity` hay `Unsupported upgrade request` nào.

### Kết quả chi tiết 10 test trong `tests/e2e/test_phase1_e2e.py` & Live Probe bổ sung (Post-Fix)

| Test / Endpoint | Kết quả Live (Post-Fix) | Ghi chú quan sát thực tế |
| :--- | :--- | :--- |
| `test_health_endpoint` | **PASS** | `200 OK`, `redis.backend="redis"`, `audio_worker_available=true`, `ffmpeg_available=true`, `fluidsynth_available=true` |
| `test_upload_rejects_unsupported_extension` | **PASS** | Reject `.txt` (`400/415/422`) |
| `test_upload_rejects_short_audio_under_3s` | **PASS** | Reject WAV 1.2s (`400/422`) |
| `test_upload_rejects_oversized_file_over_50mb` | **PASS** | Reject >50MB (`400/413/422`) |
| `test_audio_pipeline_denoise_analyze_autotune_presets` | **PASS** *(via `audio-worker` HTTP/1.1)* | `denoise`/`analyze`/`autotune` đều chạy thẳng qua `audio-worker` (`200 OK` trong `docker logs`) |
| `test_job_generate_and_sse_events` | **PASS** | `POST /api/jobs/generate` + SSE `text/event-stream` phát đủ event tới `completed` |
| `test_job_cancel_endpoint` | **PASS** | `POST /api/jobs/{id}/cancel` trả `{"status":"cancelled"}` |
| `test_export_wav_respects_master_limiter_minus_1_dbfs` | **PASS** | WAV pass (`<= -1.0 dBFS`) & MP3 pass (`200 OK` via `audio-worker` `/internal/audio/export`) |
| `test_projects_sync_and_pagination` | **PASS** | Sync 14 project + phân trang `limit=12/24` + lọc `genre` chính xác |
| `test_frontend_backend_api_contract_parity` | **PASS** | 22/22 public routes & 6/6 internal worker routes khớp |
| Live probe `/api/audio/preview/{id}`, Auto-Tune Pro & `overdub-fit-check` | **PASS (`200 OK`)** | 7 preview modes (`raw`, `dry`, `dry_beat`, `autotune`, `preserve`, `enhance`, `ai_mix`) đều `200 OK` với 7 SHA-256 hash phân biệt (`cfe246bc1bfe`, `971515e5fa67`, `e3628fefc664`, `49bcb5920231`, `8cff17a17816`, `ea7c4cf35d92`, `397f0a086ff7`); Auto-Tune Pro (`preset="off"`, `enabled=true`, `pentatonic_minor`, `auto_follow_project_key=false`) trả `200 OK`. |

---

## 3. Danh sách Bug (`BUG`) Tổng hợp từ Cross-Review (`#36`, `#38`) & Live E2E — **12/12 Đã `FIXED`**

### Nhóm Backend (`Spring Boot` — Commit `4500977` / `8ba429b`)

1. **`OPTB-BUG-01` [P0 - Blocker -> `FIXED`] — `AudioWorkerClient` gửi `h2c` Upgrade làm fail 422 toàn bộ `audio-worker` DSP**
   - *File:* `backend/src/main/java/com/aimusic/studio/audio/AudioWorkerClient.java`
   - *Xác nhận:* Thêm `HttpClient.Version.HTTP_1_1` + `WARN` log khi non-2xx. Live E2E `10/10` pass (bao gồm MP3 export `200 OK`), `docker logs ai-music-audio-worker` không còn `422` / `Unsupported upgrade request`.

2. **`OPTB-BUG-02` [P1 - High -> `FIXED`] — `LlmAdapter` bỏ qua `X-LLM-Provider: mock` / override và chưa nối cấu hình theo vai trò Agent**
   - *File:* `backend/src/main/java/com/aimusic/studio/agents/LlmAdapter.java`, `LlmContextHolder.java`, `frontend/src/lib/api/client.ts`
   - *Xác nhận:* Ưu tiên `X-Agent-Providers` & `X-LLM-Provider` (bao gồm `mock`) trước `roleProviders` mặc định; `AgentPipelineTests` (`8/8` pass) + Live probe `X-LLM-Provider: mock` pass.

3. **`OPTB-BUG-03` [P1 - High -> `FIXED`] — Auto-Tune Pro trên Studio bị khóa bởi `preset="off"` và bị `auto_follow_project_key` ghi đè**
   - *File:* `backend/src/main/java/com/aimusic/studio/audio/JavaAudioFallbackService.java`, `AudioController.java`, `AudioWorkerClient.java`, `AutotuneSettings.java`, `frontend/src/pages/StudioPage.tsx`
   - *Xác nhận:* Hỗ trợ `enabled=true` + `mix_percent > 0` khi `preset="off"`, chỉ `auto_follow_project_key` khi key/scale rỗng hoặc quick preset, hỗ trợ `pentatonic_major`/`pentatonic_minor`. Live probe (`preset="off"`, `enabled=true`, `key="D"`, `scale="pentatonic_minor"`, `auto_follow_project_key=false`) trả `200 OK` giữ nguyên cấu hình.

4. **`OPTB-BUG-04` [P1 - High -> `FIXED`] — `GET /api/audio/preview` bỏ qua `audio-worker` (FluidSynth) và không phân biệt `mode`**
   - *File:* `backend/src/main/java/com/aimusic/studio/controller/AudioController.java`, `AudioWorkerClient.java`, `JavaAudioFallbackService.java`, `audio-worker/app/{main.py,schemas.py,services/renderer.py}`
   - *Xác nhận:* `AudioWorkerClient.renderProjectMix()` gọi `POST /internal/audio/render`; `test_render_mode_differentiation` pass (`8/8` worker tests) và Live probe 7 modes (`raw`, `dry`, `dry_beat`, `autotune`, `preserve`, `enhance`, `ai_mix`) đều `200 OK` với 7 SHA-256 hash khác nhau.

5. **`OPTB-BUG-05` [P2 - Medium -> `FIXED`] — `ProjectsController.collectAudioAssets` thiếu clip `source` refs ngoài 3 ref mặc định**
   - *File:* `backend/src/main/java/com/aimusic/studio/controller/ProjectsController.java`
   - *Xác nhận:* Thu thập đầy đủ `clip.getSource()` từ tất cả tracks khi gọi `audio-worker` export; `mvn test` (`19/19` pass).

6. **`OPTB-BUG-06` [P2 - Medium -> `FIXED`] — Lệch trường SSE `error` giữa Spring Boot và `StudioPage.tsx`**
   - *File:* `frontend/src/pages/StudioPage.tsx`
   - *Xác nhận:* Đọc `evt.message || evt.error` trên SSE `error` và dọn listener khi unmount; `tsc --noEmit && vite build` exit `0`.

---

### Nhóm Frontend (`React Vite` — Commit `fc46128` / `7231ca6`)

7. **`OPTB-BUG-07` [P1 - High -> `FIXED`] — `MultiTrackAudioEngine.syncFromProject` cache cũ không reload khi re-Denoise / re-Auto-Tune**
   - *File:* `frontend/src/lib/audio/player.ts`, `frontend/src/pages/CreatePage.tsx`, `frontend/src/pages/StudioPage.tsx`
   - *Xác nhận:* Theo dõi `bufferSources` URL/revision + project-change invalidation, fetch `cache: 'no-store'`, hỗ trợ `forceSlots`/`invalidateSlots()`, gọi reload trên re-Denoise, re-Auto-Tune, và `handleApplyAutotunePro`.

8. **`OPTB-BUG-08` [P1 - High -> `FIXED`] — Bước 4 `CreatePage` không phân biệt bản nghe thử `Preserve` vs `Enhance` & bỏ trống `getQuickPreviewUrl`**
   - *File:* `frontend/src/lib/audio/player.ts`, `frontend/src/lib/api/client.ts`, `frontend/src/pages/CreatePage.tsx`
   - *Xác nhận:* Bổ sung mode `'preserve'` & `'enhance'` trong `VocalABMode` và nối Step 4 preview + quick export qua `getQuickPreviewUrl(project_id, 'preserve' | 'enhance')`; Live probe xác nhận `/api/audio/preview/{id}?mode=preserve` vs `enhance` trả 2 bản mix khác nhau (`8cff17a17816` vs `ea7c4cf35d92`).

9. **`OPTB-BUG-09` [P1 - High -> `FIXED`] — `StudioPage` đồng bộ lại toàn bộ audio engine trên mỗi thao tác & không sync state lên Redis trước khi gọi API Studio**
   - *File:* `frontend/src/pages/StudioPage.tsx`, `frontend/src/components/providers/ProjectProvider.tsx`
   - *Xác nhận:* Tách route-loading `useEffect` khỏi narrowed `audioSignature` sync và gọi `await saveNow(true)` trước `regenerateTrack`, `rearrange`, `handleApplyAutotunePro`, `saveAimusic`, và `export`.

10. **`OPTB-BUG-10` [P1 - High -> `FIXED`] — Overdub `1-Click Fix` chỉ là stub UI & `wavBlob` thu đè bị vứt bỏ**
    - *File:* `frontend/src/pages/StudioPage.tsx`, `frontend/src/lib/audio/player.ts`
    - *Xác nhận:* Lưu overdub `wavBlob` vào IndexedDB (`'overdub'`), nạp & phát trên vocal channel, chèn `AudioClip` (`clip_overdub_*`) vào `tracks.vocal.clips`, và thực thi thật `shift_timing`, `apply_autotune`, `adjust_gain`.

11. **`OPTB-BUG-11` [P2 - Medium -> `FIXED`] — SSE listener trên `StudioPage` rò rỉ khi unmount / thiếu `onTransportError` & `CreatePage` đọc stale `project` closure**
    - *File:* `frontend/src/pages/StudioPage.tsx`, `frontend/src/pages/CreatePage.tsx`
    - *Xác nhận:* Lưu và dọn SSE listeners khi unmount + truyền `onTransportError` giải phóng `busyJobTrack`; dùng `latestProjectRef` + `evt.project_state` tránh stale closure.

12. **`OPTB-BUG-12` [P2 - Medium -> `FIXED`] — Web Audio loop/MIDI sync giới hạn & `ProjectProvider` nuốt lỗi sync Redis**
    - *File:* `frontend/src/lib/audio/player.ts`, `frontend/src/components/providers/ProjectProvider.tsx`, `AppShell.tsx`
    - *Xác nhận:* Đặt `loopEnd = this.durationSec` + re-trigger `scheduleMidiTracks` khi `loopEnabled=true`, bỏ cap 128 nốt MIDI, và hiển thị `syncError` / `autoSaveStatus='error'` khi Redis sync lỗi.

---

## 4. Trạng thái Các Cảnh báo (`WARN`) Sau Merge

| Trạng thái | Thành phần | Nội dung & Kiểm chứng |
| :--- | :--- | :--- |
| `FIXED` | `backend/.../AgentOrchestrator.java`, `LlmAdapter.java` | `cancelJob` interrupt virtual thread + phát SSE `error`; `runRegenerateTrack`/`runRearrange` phát `progress (100)` ở nhánh QA fallback; `LlmAdapter` khôi phục interrupt flag (`mvn test`: `19/19` pass). |
| `FIXED` | `backend/.../HealthController.java`, `ProjectStateStore.java` | `HealthController` dùng `audioWorkerClient.healthDetails()`; `ProjectStateStore` tự phục hồi `redisAvailable=true` khi Redis phản hồi lại. |
| `FIXED` | `audio-worker/app/services/analyzer.py:375` | Tính `cents_off` thực tế (`100 * |midi_float - nearest_scale_midi|`) trong `overdub-fit-check`, xác nhận bởi `test_overdub_fit_check_real_cents_off` (`8/8` pass). |
| `FIXED` | `frontend/src/pages/SettingsPage.tsx`, `HomePage.tsx`, `CreatePage.tsx`, `types/project.ts` | Đổi nhãn `"Backend FastAPI"` -> `"Spring Boot"`, nối `Clear Cache` -> `POST /api/settings/cache/clear`, gửi `X-Agent-Providers`, đồng bộ đầy đủ field tùy chọn trong `types/project.ts`. |
| `FIXED` | `.gitignore` | Xóa `frontend/.next/`, `frontend/out/`, `backend/.venv/`; bổ sung `backend/target/` và `frontend/dist/`. |
| `DEFERRED (Phase 2)` | `backend/.../AudioController.java`, `frontend/src/pages/StudioPage.tsx` | (1) Java fallback khi `audio-worker` offline chưa decode non-WAV; (2) DAW `Select`/`Split`/`Snap Grid` + `Piano Roll` kéo/sửa nốt chi tiết thuộc phạm vi nâng cấp Phase 2 (`StudioPage` hiện giữ Undo cục bộ và tương tác cơ bản). |

---

## 5. Các Hạng mục Đạt (`PASS`)

- **API Contract Parity (`22/22` public routes & `6/6` internal worker routes):** URL, HTTP method, query params, multipart fields, và DTO JSON khớp giữa `frontend/src/lib/api/client.ts`, Spring Boot controllers, và `audio-worker/app/main.py` (kèm `/internal/audio/render`).
- **Header Override & Security:** `X-Gemini-Api-Key`, `X-OpenAI-Api-Key`, `X-LLM-Provider`, `X-Agent-Providers` đi qua `LlmContextHolder` tới `HealthController`, `StudioController`, và virtual threads của `AgentOrchestrator`. Không có API key hardcode trong repo; `.env` không bị track; `audio-worker` xử lý trong `io.BytesIO()` và `TemporaryDirectory()`.
- **Master Limiter (`<= -1.0 dBFS`) & Exporters:** Cả `audio-worker/app/services/exporter.py` và `JavaAudioFallbackService.java` đều giữ peak `<= -1.0 dBFS` (đã chứng minh qua `test_master_limiter_ceiling`, `AudioAndLimiterTests` `9/9`, và live E2E WAV + MP3 export `200 OK`), xuất Stems ZIP đồng độ dài từ `t=0`, MIDI có `0x51`/`0x58`/`0x59` Meta Events, và `.aimusic` ZIP bundle export/import trọn vẹn.
- **IndexedDB Rolling Cap & Routing:** `frontend/src/lib/storage/indexeddb.ts` giới hạn tối đa 5 bản nháp gần nhất kèm cascade xóa `audio_blobs`; `react-router-dom` routes (`/`, `/create`, `/studio/:id`, `/library`, `/settings`) và Vite proxy `/api -> :8000` hoạt động sạch sẽ.

---

## 6. Trạng thái Kết thúc Phase C (Post-Fix Verification)

- **Tất cả 12/12 bug (`OPTB-BUG-01`..`OPTB-BUG-12`) và toàn bộ các cảnh báo sửa được trong Phase 1 đã được xử lý và xác nhận lại sau merge.**
- **Kết quả cuối cùng sau bản sửa cuối:**
  - `cd backend && mvn test`: **19/19 PASS** (`BUILD SUCCESS`)
  - `cd frontend && npx.cmd tsc --noEmit && npm.cmd run build`: **Exit 0** (`vite v6.4.6`, `2155 modules`)
  - `audio-worker` Docker pytest (`tests/test_worker.py`): **8/8 PASS** (`54.28s`)
  - Live E2E (`tests/e2e/test_phase1_e2e.py`): **10/10 PASS** (`12.09s`)
  - `docker compose config -q`: **Exit 0**
  - `docker logs ai-music-audio-worker`: **0 lỗi `422` / `Unsupported upgrade request`**; 7 preview modes & MP3 export đều `200 OK`.
