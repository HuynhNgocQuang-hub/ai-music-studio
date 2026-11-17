# Báo cáo Kiểm lỗi Chéo & Live E2E Verification (`Option B`)
## Dự án: AI Music Studio — Phase 1 MVP (React 19 Vite + Java 21 Spring Boot + Python Audio Worker + Redis)

- **Ngày kiểm tra:** 2026-11-17
- **Người tổng hợp:** `live-e2e-runner` (tổng hợp từ Live E2E Docker/Host + báo cáo `@review-be-by-fe` `#38` và `@review-fe-by-be` `#36`)
- **Tài liệu đối chiếu:** [SRS.md](./SRS.md) | [API_AND_UI_SPEC.md](./API_AND_UI_SPEC.md) | [MULTI_AGENT_ARCHITECTURE.md](./MULTI_AGENT_ARCHITECTURE.md) | [TASK_BOARD.md](./TASK_BOARD.md)

---

## 1. Tóm tắt Điều hành & Kết quả Chạy Test / Build Thực tế

Hệ thống Option B hiện có đầy đủ 3 thành phần backend đang chạy đồng thời khi kiểm thử:
- **Docker Engine:** Version `29.5.3` (`desktop-linux`, WSL2) — **Đang chạy**.
- **Redis Container (`ai-music-redis`):** `redis:7-alpine` cổng `6379` — **Up (healthy)**.
- **Audio Worker Container (`ai-music-audio-worker`):** `music-audio-worker` cổng `8001` — **Up (healthy)** (`ffmpeg`, `fluidsynth`, `soundfont`, `noisereduce`, `librosa`, `pedalboard` khả dụng).
- **Spring Boot Backend (Host Java 21.0.9):** tiến trình `java.exe` (PID `23884`) cổng `8000` — **Up**, `/api/health` trả `200 OK` (`redis.connected=true`, `audio_worker_available=true`).

### Bảng Tổng hợp Kết quả Kiểm thử

| Hạng mục | Lệnh thực thi | Kết quả | Chi tiết |
| :--- | :--- | :--- | :--- |
| **Audio Worker Unit/DSP Tests (Docker)** | `docker build -t ai-music-audio-worker-test ./audio-worker` & `docker run --rm ai-music-audio-worker-test pytest -v tests/test_worker.py` | **PASS (`6/6`)** | `6 passed, 2 warnings in 30.10s` (`test_health`, `test_denoise_analyze_autotune_pipeline`, `test_autotune_enharmonic_keys`, `test_master_limiter_ceiling`, `test_render_and_export_endpoints`, `test_overdub_fit_check`). |
| **Spring Boot Test Suite** | `cd backend && mvn test` *(bởi `@review-be-by-fe`)* | **PASS (`14/14`)** | `BUILD SUCCESS` (`32.858s`): `AgentPipelineTests` (`7/7`), `ApiMockMvcTests` (`2/2`), `AudioAndLimiterTests` (`5/5`), `0` skipped. |
| **Frontend TypeScript & Vite Build** | `cd frontend && npx.cmd tsc --noEmit && npm.cmd run build` *(bởi `@review-fe-by-be`)* | **PASS** | Exit `0` (`vite v6.4.6`, `2155 modules`, `dist/index.html` 0.63 kB, CSS 39.29 kB, JS 409.20 kB). |
| **Docker Compose Config** | `docker compose config -q` *(bởi `@review-fe-by-be`)* | **PASS** | Exit `0`. |
| **Live E2E Suite (`tests/e2e/test_phase1_e2e.py`)** | `docker run --rm --add-host=host.docker.internal:host-gateway -v D:/Music:/workspace -e E2E_BASE_URL=http://host.docker.internal:8000 music-audio-worker pytest -v /workspace/tests/e2e/test_phase1_e2e.py` | **FAIL (`9/10` pass, `1/10` fail)** | `9 passed, 1 failed in 16.39s`. Fail tại `test_export_wav_respects_master_limiter_minus_1_dbfs` (`tests/e2e/test_phase1_e2e.py:451`): `POST /api/projects/{id}/export/audio` với `format="mp3"` trả **HTTP 503** dù `audio-worker` đang healthy! |
| **Live Probe Các Endpoint Còn lại (`httpx`)** | Probe trực tiếp `http://host.docker.internal:8000` qua Python `httpx` | **PASS (HTTP 200) với lưu ý Fallback** | Tất cả route còn lại trả `200`, nhưng xem mục 2 để thấy toàn bộ DSP call từ Spring Boot sang `audio-worker` thực chất bị `422` và rớt xuống Java fallback. |

---

## 2. Kết quả Live E2E & Phát hiện Nghiêm trọng Nhất (`P0 Blocker`)

### `OPTB-BUG-01` [P0 - BLOCKER] — `AudioWorkerClient` gửi `HTTP/2 h2c` Upgrade khiến `audio-worker` (`uvicorn`) trả `422` trên mọi lệnh DSP & gây `503` khi Export MP3

- **Vị trí lỗi:** `backend/src/main/java/com/aimusic/studio/audio/AudioWorkerClient.java:38-40, 141-147, 177-183`
- **Triệu chứng Live E2E:**
  - `test_export_wav_respects_master_limiter_minus_1_dbfs` (`tests/e2e/test_phase1_e2e.py:451`) pass bước Export WAV (Master Limiter đạt `<= -1.0 dBFS`), nhưng bước Export MP3 (`POST /api/projects/{id}/export/audio`, `{"format":"mp3","apply_mastering":true}`) trả về:
    ```json
    503 {"detail":"MP3 export requires audio-worker or ffmpeg to be available.","message":"MP3 export requires audio-worker or ffmpeg to be available.","status":503}
    ```
  - Điều này xảy ra **ngay cả khi** `/api/health` báo `"audio_worker_available": true` và `"ffmpeg_available": true`.
- **Bằng chứng Log & Tái hiện Root Cause:**
  1. `docker logs ai-music-audio-worker` ghi nhận mọi request từ Spring Boot đều bị từ chối:
     ```text
     WARNING:  Unsupported upgrade request.
     INFO:     172.18.0.1:60360 - "POST /internal/audio/denoise HTTP/1.1" 422 Unprocessable Entity
     WARNING:  Invalid HTTP request received.
     INFO:     172.18.0.1:60366 - "POST /internal/audio/analyze HTTP/1.1" 422 Unprocessable Entity
     INFO:     172.18.0.1:60368 - "POST /internal/audio/autotune HTTP/1.1" 422 Unprocessable Entity
     INFO:     172.18.0.1:60384 - "POST /internal/audio/overdub-fit-check HTTP/1.1" 422 Unprocessable Entity
     INFO:     172.18.0.1:60400 - "POST /internal/audio/export HTTP/1.1" 422 Unprocessable Entity
     ```
  2. Nguyên nhân gốc: `AudioWorkerClient.java:38-40` khởi tạo `HttpClient.newBuilder().connectTimeout(Duration.ofMillis(1200)).build()` mà **không chỉ định `.version(HttpClient.Version.HTTP_1_1)`**. Mặc định của Java 21 `HttpClient` là `HTTP_2`, nên khi gọi `POST` qua HTTP thường (`http://localhost:8001` hoặc `http://audio-worker:8001`), Java tự đính kèm header `Connection: Upgrade, HTTP2-Settings` và `Upgrade: h2c`. Máy chủ `uvicorn` không hỗ trợ `h2c` trên request có body, làm hỏng quá trình parse body và FastAPI trả `422`.
  3. Kiểm chứng tái hiện bằng Python `httpx` trực tiếp tới `http://host.docker.internal:8001/internal/audio/denoise`:
     - Request HTTP/1.1 bình thường -> **`200 OK`**.
     - Request kèm header `Connection: Upgrade, HTTP2-Settings`, `Upgrade: h2c`, `HTTP2-Settings: AAEAAABkAAQCAAAAAAIAAAAA` -> **`422 {"detail":[{"type":"missing","loc":["body","file"],"msg":"Field required","input":null}]}`**.
  4. Hậu quả kép: `AudioWorkerClient` (`lines 141-147, 177-183`) nuốt im HTTP `422` và trả `Optional.empty()`, khiến **100% pipeline DSP (`denoise`, `analyze`, `autotune`, `overdub-fit-check`, `export`) âm thầm rớt về `JavaAudioFallbackService`**. Riêng `format="mp3"` không có fallback trên host Windows thiếu `ffmpeg` (`ProjectsController.java:142`) nên ném `503`.
- **Hướng sửa:** Thêm `.version(HttpClient.Version.HTTP_1_1)` vào `HttpClient.newBuilder()` trong `AudioWorkerClient.java:38-40`, đồng thời log mức `WARN` kèm `resp.statusCode()` khi `audio-worker` trả về status khác 2xx để không che giấu lỗi tích hợp.

### Kết quả chi tiết 10 test trong `tests/e2e/test_phase1_e2e.py` & Live Probe bổ sung

| Test / Endpoint | Kết quả Live | Ghi chú quan sát thực tế |
| :--- | :--- | :--- |
| `test_health_endpoint` | **PASS** | `200 OK`, `redis.backend="redis"`, `audio_worker_available=true` |
| `test_upload_rejects_unsupported_extension` | **PASS** | Reject `.txt` (`400/415/422`) |
| `test_upload_rejects_short_audio_under_3s` | **PASS** | Reject WAV 1.2s (`400/422`) |
| `test_upload_rejects_oversized_file_over_50mb` | **PASS** | Reject >50MB (`400/413/422`) |
| `test_audio_pipeline_denoise_analyze_autotune_presets` | **PASS** *(via Java fallback)* | `denoise`/`analyze`/`autotune` đều `200`, nhưng thực tế chạy qua `JavaAudioFallbackService` do `OPTB-BUG-01` |
| `test_job_generate_and_sse_events` | **PASS** | `POST /api/jobs/generate` + SSE `text/event-stream` phát đủ event tới `completed` |
| `test_job_cancel_endpoint` | **PASS** | `POST /api/jobs/{id}/cancel` trả `{"status":"cancelled"}` |
| `test_export_wav_respects_master_limiter_minus_1_dbfs` | **FAIL** | WAV pass (`<= -1.0 dBFS`); MP3 fail `503` do `OPTB-BUG-01` |
| `test_projects_sync_and_pagination` | **PASS** | Sync 14 project + phân trang `limit=12/24` + lọc `genre` chính xác |
| `test_frontend_backend_api_contract_parity` | **PASS** | 22/22 public routes & 6/6 internal worker routes khớp |
| Live probe bổ sung (`asset`, `preview`, `regenerate-track`, `rearrange`, `lyrics/suggest`, `coach/chat`, `overdub-fit-check`, `export/midi`, `export/stems`, `export/aimusic`, `import`) | **PASS (HTTP 200)** | `export/midi` (`2207 B`, header `MThd`), `export/stems` (ZIP 5 stem), `export/aimusic` (ZIP `manifest.json` + `project.json` + 3 WAV) & `import` đều thành công; tuy nhiên `preview` với `raw`/`dry`/`autotune`/`mix` đều trả kích thước y hệt (`846764 B` — xác nhận `OPTB-BUG-04`). |

---

## 3. Danh sách Bug (`BUG`) Tổng hợp từ Cross-Review (`#36`, `#38`) & Live E2E

### Nhóm Backend (`Spring Boot` — Phát hiện bởi `@review-be-by-fe` & Live E2E)

1. **`OPTB-BUG-01` [P0 - Blocker] — `AudioWorkerClient` gửi `h2c` Upgrade làm fail 422 toàn bộ `audio-worker` DSP**
   - *File:* `backend/src/main/java/com/aimusic/studio/audio/AudioWorkerClient.java:38-40, 141-147, 177-183`
   - *Chi tiết:* Đã nêu tại Mục 2.

2. **`OPTB-BUG-02` [P1 - High] — `LlmAdapter` bỏ qua `X-LLM-Provider: mock` / override và chưa nối cấu hình theo vai trò Agent**
   - *File:* `backend/src/main/java/com/aimusic/studio/agents/LlmAdapter.java:71-77, 99-108, 154-175`; `frontend/src/pages/SettingsPage.tsx:265-297`; `frontend/src/lib/api/client.ts:74-81`
   - *Chi tiết:*
     - `resolveProvider(role, explicitProvider)` (`LlmAdapter.java:161-174`) kiểm tra `roleProviders` cố định (`composer/lyricist/coach -> GEMINI`, `arranger/qa -> OPENAI`) **trước** `effectiveDefaultProvider()`, và vòng lặp dòng `171` bỏ qua `Provider.MOCK`. Do đó nếu server `.env` đã có Gemini/OpenAI key thì header `X-LLM-Provider: mock` (hoặc `X-LLM-Provider: openai` cho composer) bị ghi đè.
     - Ngoài ra, `SettingsPage` lưu `agentProviders` theo từng vai trò trong `localStorage`, nhưng `buildLLMHeaders()` không gửi thông tin này lên backend và `LlmAdapter.configure()` (`line 99`) không có controller nào gọi.

3. **`OPTB-BUG-03` [P1 - High] — Auto-Tune Pro trên Studio bị khóa bởi `preset="off"` và bị `auto_follow_project_key` ghi đè**
   - *File:* `backend/src/main/java/com/aimusic/studio/audio/JavaAudioFallbackService.java:710-717`; `backend/src/main/java/com/aimusic/studio/controller/AudioController.java:328-335`; `frontend/src/pages/StudioPage.tsx:1058-1112`
   - *Chi tiết:*
     - `resolveAutotuneSettings` ép `enabled=false, mixPercent=0.0` bất cứ khi nào `preset` là `"off"`. Trong `StudioPage.tsx:1097-1112`, kéo thanh `Retune Speed` chỉ set `enabled: true` mà giữ `preset: 'off'`, nên backend trả về giọng chưa tune.
     - `AudioController.java:328-335`: Khi `auto_follow_project_key=true` (mặc định), backend ghi đè `key` (và `scale` nếu là `major`/`minor`) bằng `detected_key` lưu trong Redis, bỏ qua lựa chọn thủ công của người dùng trong Auto-Tune Pro và bỏ qua `pentatonic_major`/`pentatonic_minor`.

4. **`OPTB-BUG-04` [P1 - High] — `GET /api/audio/preview` bỏ qua `audio-worker` (FluidSynth) và không phân biệt `mode`**
   - *File:* `backend/src/main/java/com/aimusic/studio/controller/AudioController.java:385-395`; `backend/src/main/java/com/aimusic/studio/audio/AudioWorkerClient.java` (thiếu method `/internal/audio/render`); `backend/src/main/java/com/aimusic/studio/audio/JavaAudioFallbackService.java:969-978`
   - *Chi tiết:*
     - `renderPreviewWav` gọi thẳng `audioFallback.renderProjectMix` dù `audio-worker/app/main.py:205` đã cài sẵn `POST /internal/audio/render` (FluidSynth + SoundFont).
     - `resolvePreferredAudioRef` chỉ phân biệt `mode="dry_beat"`; các mode `raw`, `dry`, `autotune`, `preserve`, `enhance` đều rơi chung về `tunedVocalRef ?? dryDenoisedRef ?? rawInputRef` (Live probe xác nhận cả 4 mode `raw|dry|autotune|mix` đều trả về đúng `846764` bytes giống hệt nhau).

5. **`OPTB-BUG-05` [P2 - Medium] — `ProjectsController.collectAudioAssets` thiếu clip `source` refs ngoài 3 ref mặc định**
   - *File:* `backend/src/main/java/com/aimusic/studio/controller/ProjectsController.java:195-202`
   - *Chi tiết:* Khi gọi `/internal/audio/export`, backend chỉ đóng gói `raw_input_ref`, `dry_denoised_ref`, `tuned_vocal_ref`, bỏ sót các `source` ref khác trên `tracks.vocal.clips` (ví dụ clip overdub hoặc clip tách riêng).

6. **`OPTB-BUG-06` [P2 - Medium] — Lệch trường SSE `error` giữa Spring Boot và `StudioPage.tsx`**
   - *File:* `backend/src/main/java/com/aimusic/studio/agents/AgentOrchestrator.java:680-725`; `frontend/src/pages/StudioPage.tsx:249, 281`
   - *Chi tiết:* Backend phát SSE `error` payload `{ job_id, code, message }`, nhưng `StudioPage.tsx` đọc `evt.error || '...'` (bỏ qua `evt.message`), làm mất chi tiết thông báo lỗi khi regenerate track hoặc rearrange trên Studio (`CreatePage.tsx:536` đã xử lý đúng `evt.error || evt.message`).

---

### Nhóm Frontend (`React Vite` — Phát hiện bởi `@review-fe-by-be`)

7. **`OPTB-BUG-07` [P1 - High] — `MultiTrackAudioEngine.syncFromProject` cache cũ không reload khi re-Denoise / re-Auto-Tune**
   - *File:* `frontend/src/lib/audio/player.ts:224`; `frontend/src/pages/CreatePage.tsx:370-396, 484-499`; `frontend/src/pages/StudioPage.tsx:331-347`
   - *Chi tiết:* `syncFromProject` bỏ qua tải lại nếu `this.buffers.has(slot)` đã tồn tại (`player.ts:224`). Khi người dùng chạy lại Denoise hoặc đổi preset Auto-Tune, buffer `'dry'` / `'autotune'` cũ vẫn nằm trong bộ nhớ (lưu ý `mem://processed/...` giữ nguyên URL ref). Ngoài ra `StudioPage.tsx:331-347` (`handleApplyAutotunePro`) không gọi `engine.syncFromProject` sau khi áp dụng Auto-Tune Pro.

8. **`OPTB-BUG-08` [P1 - High] — Bước 4 `CreatePage` không phân biệt bản nghe thử `Preserve` vs `Enhance` & bỏ trống `getQuickPreviewUrl`**
   - *File:* `frontend/src/pages/CreatePage.tsx:576-585, 1356-1379`; `frontend/src/lib/api/client.ts:161-167`
   - *Chi tiết:* Cả nút nghe thử `'preserve'` và `'enhance'` đều gọi `engine.setABMode('ai_mix')`; backend `AudioAssets` không sinh/gán `rendered_mix_ref`, `accompaniment_ref`, `preserve_mix_ref`, `enhance_mix_ref`; hàm `getQuickPreviewUrl()` (`/api/audio/preview/{id}?mode=...`) không được gọi ở đâu.

9. **`OPTB-BUG-09` [P1 - High] — `StudioPage` đồng bộ lại toàn bộ audio engine trên mỗi thao tác & không sync state lên Redis trước khi gọi API Studio**
   - *File:* `frontend/src/pages/StudioPage.tsx:121-147, 228-288, 331-435`; `frontend/src/components/providers/ProjectProvider.tsx:85-89`
   - *Chi tiết:*
     - `useEffect` (`StudioPage.tsx:147`) đưa nguyên `project` vào dependency array, kích hoạt `engine.syncFromProject(project)` mỗi lần kéo slider Mixer, sửa BPM hoặc gõ lời.
     - Auto-save định kỳ trong `ProjectProvider.tsx:85-89` chỉ lưu vào `IndexedDB` (`persistDraft(..., false)`). Khi `StudioPage` gọi `/api/jobs/regenerate-track`, `/api/jobs/rearrange`, `/api/audio/autotune`, hoặc `/api/projects/{id}/export/*`, frontend không gọi `saveNow(true)` trước, khiến backend đọc state cũ (stale BPM, chords, mute/volume/pan) từ Redis.

10. **`OPTB-BUG-10` [P1 - High] — Overdub `1-Click Fix` chỉ là stub UI & `wavBlob` thu đè bị vứt bỏ**
    - *File:* `frontend/src/pages/StudioPage.tsx:307-321, 1280-1289`
    - *Chi tiết:* Bấm các nút trong `fitCheck.one_click_fixes` chỉ gọi `setStudioNotice(...)` mà không thực thi `shift_timing`, `apply_autotune` hay `adjust_gain`. Sau khi gọi `overdubFitCheck`, `handleStartOverdub` không lưu `wavBlob` vào `IndexedDB` (`'overdub'` slot không dùng) và không chèn clip mới vào `tracks.vocal.clips`.

11. **`OPTB-BUG-11` [P2 - Medium] — SSE listener trên `StudioPage` rò rỉ khi unmount / thiếu `onTransportError` & `CreatePage` đọc stale `project` closure**
    - *File:* `frontend/src/pages/StudioPage.tsx:239-251, 270-283`; `frontend/src/pages/CreatePage.tsx:256, 387, 488, 546`
    - *Chi tiết:* `StudioPage` gọi `subscribeJobEvents` không lưu hàm cleanup để hủy khi unmount và thiếu `onTransportError`, có thể kẹt `busyJobTrack` nếu mất mạng. `CreatePage` đọc `project` ngay sau `updateProject(...)` (stale closure) và trong callback `completed` của SSE (`line 546`) thay vì dùng `evt.project_state`.

12. **`OPTB-BUG-12` [P2 - Medium] — Web Audio loop/MIDI sync giới hạn & `ProjectProvider` nuốt lỗi sync Redis**
    - *File:* `frontend/src/lib/audio/player.ts:342, 355, 388-431`; `frontend/src/components/providers/ProjectProvider.tsx:68-75`
    - *Chi tiết:* `AudioBufferSourceNode.loop` lặp theo `vocalBuf.duration` thay vì `this.durationSec`, còn `scheduleMidiTracks` không lặp khi `loopEnabled=true` và giới hạn tối đa `128` nốt/track. `persistDraft(state, true)` bắt lỗi `syncProject` nhưng vẫn chuyển `autoSaveStatus` thành `'saved'`.

---

## 4. Các Cảnh báo (`WARN`) Cần Lưu ý

| Mức độ | Thành phần & `file:line` | Nội dung |
| :--- | :--- | :--- |
| `WARN` | `backend/.../agents/AgentOrchestrator.java:268-292`, `LlmAdapter.java:197,214` | `cancelJob` set `status="cancelled"` nhưng không interrupt virtual thread hay phát SSE `error` ngay; nếu đang chờ LLM HTTP 25s, subscriber mới mở SSE thấy `!"running"` và nhận completion không có event lỗi. `LlmAdapter` bắt `Exception` chung gồm `InterruptedException` mà không gọi `Thread.currentThread().interrupt()`. |
| `WARN` | `backend/.../agents/AgentOrchestrator.java:534-549, 638-653` | `runRegenerateTrack` và `runRearrange` thiếu SSE event `progress (100)` ở nhánh QA fallback (trong khi `runGenerate` dòng `438` có phát). |
| `WARN` | `backend/.../controller/AudioController.java:101-117` | Khi `audio-worker` offline, upload file non-WAV (`.mp3`, `.m4a`, `.ogg`, `.flac`) sẽ thất bại trong `JavaAudioFallbackService.decodeWavBytes` vì Java fallback chưa có decoder non-WAV. |
| `WARN` | `backend/.../controller/HealthController.java:52-59` | Dùng `audioWorkerClient.isHealthy()` thay vì `healthDetails()`, nên luôn báo `ffmpeg_available=true` và `soundfont_available=true` mỗi khi worker `/health` trả `200`, kể cả khi thiếu binary bên trong worker. |
| `WARN` | `backend/.../store/ProjectStateStore.java:78-100, 485-502` | Nếu Redis rớt rồi hồi phục lại, cờ `redisAvailable` chỉ tự bật lại `true` khi có người gọi `/api/health`. Ngoài ra `StudioPage.tsx` dùng Undo stack cục bộ của React, chưa gọi `POST /api/projects/{id}/undo`. |
| `WARN` | `audio-worker/app/services/analyzer.py:375` | `overdub-fit-check` gán cứng `cents_off: 50.0` cho nốt lệch tông thay vì tính độ lệch cents thực tế. |
| `WARN` | `frontend/src/pages/StudioPage.tsx:548-577, 840-868, 1010-1049` | Công cụ DAW `Select`/`Split`/`Snap Grid` và `Piano Roll` (chỉ render 32 nốt dạng badge) chưa có tương tác kéo/cắt/sửa nốt thực sự. |
| `WARN` | `frontend/src/pages/SettingsPage.tsx:45,84,118,188,263-298`; `HomePage.tsx:105`; `CreatePage.tsx:270`; `types/project.ts:161` | Còn nhãn UI cũ `"Backend FastAPI"` / `"FastAPI"` thay vì `"Spring Boot"`; nút `Clear Cache` chưa gọi backend endpoint xóa cache; một số field TypeScript tùy chọn (`MidiTrackState.instrument` có thể `null`, `AudioClip.offset_ms`, `ProjectAnalysis.low_confidence_warning`, `HealthResponse.engines.audio_worker_available`) chưa đồng bộ đầy đủ vào `types/project.ts`. |
| `WARN` | `.gitignore:10-18` | Root `.gitignore` vẫn giữ `frontend/.next/`, `frontend/out/`, `backend/.venv/` và thiếu `backend/target/`. |

---

## 5. Các Hạng mục Đạt (`PASS`)

- **API Contract Parity (`22/22` public routes & `6/6` internal worker routes):** URL, HTTP method, query params, multipart fields, và DTO JSON khớp giữa `frontend/src/lib/api/client.ts`, Spring Boot controllers, và `audio-worker/app/main.py`.
- **Header Override & Security:** `X-Gemini-Api-Key`, `X-OpenAI-Api-Key`, `X-LLM-Provider` đi qua `LlmContextHolder` tới `HealthController`, `StudioController`, và virtual threads của `AgentOrchestrator`. Không có API key hardcode trong repo; `.env` không bị track; `audio-worker` xử lý trong `io.BytesIO()` và `TemporaryDirectory()`.
- **Master Limiter (`<= -1.0 dBFS`) & Exporters:** Cả `audio-worker/app/services/exporter.py` và `JavaAudioFallbackService.java` đều giữ peak `<= -1.0 dBFS` (đã chứng minh qua cả `test_master_limiter_ceiling`, `AudioAndLimiterTests`, và live E2E WAV export), xuất Stems ZIP đồng độ dài từ `t=0`, MIDI có `0x51`/`0x58`/`0x59` Meta Events, và `.aimusic` ZIP bundle export/import trọn vẹn.
- **IndexedDB Rolling Cap & Routing:** `frontend/src/lib/storage/indexeddb.ts` giới hạn tối đa 5 bản nháp gần nhất kèm cascade xóa `audio_blobs`; `react-router-dom` routes (`/`, `/create`, `/studio/:id`, `/library`, `/settings`) và Vite proxy `/api -> :8000` hoạt động sạch sẽ.

---

## 6. Kế hoạch Hành động Khắc phục (Ưu tiên)

1. **`spring-backend` (Ưu tiên P0 & P1):**
   - **[P0]** Sửa `AudioWorkerClient.java:38-40` thêm `.version(HttpClient.Version.HTTP_1_1)` + log warning khi worker trả `>= 400`, sau đó chạy lại live `tests/e2e/test_phase1_e2e.py` để xác nhận MP3 export (`200 OK`) và `audio-worker` thực sự chạy `denoise`/`analyze`/`autotune`/`export`.
   - **[P1]** Cập nhật `AudioController.renderPreviewWav` gọi `audio-worker` `/internal/audio/render` (thêm method trong `AudioWorkerClient`) và xử lý đúng từng preview `mode` (`raw`, `dry`, `autotune`, `preserve`, `enhance`).
   - **[P1]** Sửa `LlmAdapter.resolveProvider` để tôn trọng `X-LLM-Provider: mock` / provider override theo request và hỗ trợ cấu hình theo role qua header/endpoint.
   - **[P1]** Sửa `AudioController.autotuneAudio` & `JavaAudioFallbackService.resolveAutotuneSettings` để Auto-Tune Pro không bị `preset="off"` hay `auto_follow_project_key` chặn chỉnh tay.
   - **[P2]** Mở rộng `ProjectsController.collectAudioAssets` thu thập mọi `clip.source` trên tracks.

2. **`react-vite` (Ưu tiên P1 & P2):**
   - **[P1]** Invalidate cache `this.buffers` trong `MultiTrackAudioEngine.syncFromProject` theo ref/version/revision khi re-denoise hoặc re-autotune, và gọi `engine.syncFromProject` sau `handleApplyAutotunePro`.
   - **[P1]** Sửa `StudioPage.tsx` `useEffect` dependencies (tránh re-sync trên mọi edit) và gọi `saveNow(true)` trước các API Studio (`regenerate-track`, `rearrange`, `autotune`, `export/*`).
   - **[P1]** Kết nối thật các nút `1-Click Fix` & lưu overdub `wavBlob` vào `IndexedDB` + `tracks.vocal.clips`; sửa Step 4 `CreatePage` phân biệt preview `Preserve` vs `Enhance` (hoặc gọi `/api/audio/preview?mode=...`).
   - **[P2]** Dọn SSE listener khi unmount + đọc `evt.message || evt.error` trong `StudioPage`, sửa stale closure trong `CreatePage`, sửa UI label `"Backend FastAPI"` -> `"Spring Boot"`, đồng bộ `types/project.ts`, và hiển thị lỗi khi Redis sync fail.

3. **`audio-worker` & Repo Hygiene (Ưu tiên P2/Low):**
   - Tính `cents_off` thực tế trong `overdub-fit-check` (`audio-worker/app/services/analyzer.py:375`) và bổ sung `backend/target/` vào `.gitignore`.
