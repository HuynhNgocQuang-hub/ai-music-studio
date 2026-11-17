# Bảng Theo dõi Tiến độ & Kiểm lỗi Chéo (`TASK_BOARD`)
## Dự án: AI Music Studio — Phase 1 (MVP — Option B)

- **Repository:** `https://github.com/HuynhNgocQuang-hub/ai-music-studio`
- **Kiến trúc hiện tại:** Option B — **React 19 + Vite (`frontend/`)** + **Java 21 Spring Boot 3.x (`backend/`)** + **Python FastAPI DSP (`audio-worker/`)** + **Redis (`redis:7-alpine`)**
- **Kế hoạch chi tiết:** [PHASE1_TEAM_PLAN.md](./PHASE1_TEAM_PLAN.md)
- **Quy ước trạng thái:** `TODO` (Chờ làm) | `IN_PROGRESS` (Đang làm) | `IN_REVIEW` (Chờ AI khác check) | `BLOCKED` (Kẹt/Lỗi) | `DONE` (Đã pass test + review)

---

## 1. Bảng Công việc Option B theo từng AI Agent

| Mã Task | Agent Phụ trách | Hạng mục Công việc | Phạm vi File Được phép | Trạng thái | Bằng chứng (Test / Build Output) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `OPTB-BE-01` | `spring-backend` | Khởi tạo Maven Java 21 + Spring Boot 3.4.2 (`pom.xml`, `Dockerfile`, `application.yml`), `config/`, `store/` (`Spring Data Redis` + In-Memory TTL fallback, Undo 20 bước) | `backend/pom.xml`, `backend/Dockerfile`, `backend/src/main/resources/application.yml`, `backend/src/main/java/.../{config,store}/*` | `DONE` | Merged (`52e92d1`); `cd backend && mvn test` pass (`Tests run: 14, Failures: 0, Errors: 0, Skipped: 0`) |
| `OPTB-BE-02` | `spring-backend` | Implement `model/` (Shared Project State & DTOs khớp Frontend), `audio/` (`AudioWorkerClient` + `JavaAudioFallbackService`: WAV validation, DSP fallback, Limiter `<= -1.0 dBFS`, `.mid`, `.aimusic`) | `backend/src/main/java/.../{model,audio}/*` | `DONE` | `AudioAndLimiterTests`: 5/5 pass (upload rules, enharmonic keys, Limiter `<= -1.0 dBFS`, Stems/MIDI/`.aimusic`, TTL + 20 undo) |
| `OPTB-BE-03` | `spring-backend` | Implement Multi-Agent Core (`LlmAdapter` Gemini/OpenAI/Mock + headers, `ComposerAgent`, `ArrangerAgent`, `CoachLyricistAgent`, `QaReviewerAgent` max 2 vòng, `AgentOrchestrator` 60s timeout + cancel + SSE) | `backend/src/main/java/.../agents/*` | `DONE` | `AgentPipelineTests`: 7/7 pass (Mock/Header overrides, prompt sanitize, Preserve/Enhance, QA max 2 + Fallback, timeout/cancel, locked track) |
| `OPTB-BE-04` | `spring-backend` | Implement REST & SSE Controllers (`/api/health`, `/api/audio/*`, `/api/jobs/*`, `/api/lyrics/suggest`, `/api/coach/chat`, `/api/studio/overdub-fit-check`, `/api/projects/*`) + `mvn test` suite | `backend/src/main/java/.../controller/*`, `backend/src/test/java/...` | `DONE` | `ApiMockMvcTests`: 2/2 pass (health headers, upload/denoise/analyze/autotune, SSE generate/cancel, lyrics/coach/overdub, preview/export/pagination) |
| `OPTB-WRK-01` | `audio-worker` | Tách Python Audio DSP thành slim FastAPI service cổng `8001` (`/health`, `/internal/audio/{denoise,analyze,autotune,render,export,overdub-fit-check}`), Master Limiter `<= -1.0 dBFS`, không PyTorch/TF | `audio-worker/*` | `DONE` | Merged (`8c78208`); Docker pytest `python -m compileall -q app tests && pytest -v tests/test_worker.py` -> `6 passed in 18.36s` |
| `OPTB-WRK-02` | `audio-worker` | Cập nhật `docker-compose.yml` (3 services: `redis`, `audio-worker`, `backend`) và `.env.example` | `docker-compose.yml`, `.env.example` | `DONE` | `docker compose config -q` exit `0` |
| `OPTB-FE-01` | `react-vite` | Chuyển `frontend/` từ Next.js sang React 19 + Vite 6 + TypeScript + Tailwind v4 + `react-router-dom` v7 (`vite.config.ts` proxy `/api` -> `:8000`, `App.tsx`, `src/pages/*`, xóa Next artifacts) | `frontend/*` | `DONE` | Merged (`358c4d8`); `npm install` (0 vulnerabilities), `npx tsc --noEmit` exit `0`, `npm run build` exit `0` (`vite v6.4.6`, 2155 modules, 3.99s) |
| `OPTB-FE-02` | `react-vite` | Cập nhật `client.ts` (`VITE_API_BASE_URL`), `AppShell.tsx` (`Link`/`useLocation`), `ProjectProvider.tsx` (`useNavigate`), giữ nguyên `IndexedDB` + Web Audio Player + `encodeBlobToWav` | `frontend/src/*` | `DONE` | Cross-review parity 22/22 routes & `tsc`/`vite build` exit `0` |
| `OPTB-QA-01` | `docs-qa` | Phase A: Cập nhật `README.md`, `MULTI_AGENT_ARCHITECTURE.md`, `API_AND_UI_SPEC.md`, `PHASE1_TEAM_PLAN.md`, `TASK_BOARD.md` theo kiến trúc Option B | `README.md`, `docs/*.md` | `DONE` | Toàn bộ 5 tài liệu cập nhật cho Java 21 Spring Boot + React Vite + Python audio-worker + Redis |
| `OPTB-QA-02` | `docs-qa` | Phase B: Cross-review 1:1 `frontend/src/lib/api/client.ts` + `types/project.ts` vs Spring Boot controllers/DTOs & `AudioWorkerClient.java` vs `audio-worker/app/main.py` | `docs/TASK_BOARD.md`, `tests/e2e/*` | `DONE` | Node & pytest contract parity pass: `22/22` public routes (`missFe=[]`, `missBe=[]`, `staleStream=false`), `6/6` internal worker routes (`missAwClient=[]`, `missAwMain=[]`); DTOs matched |
| `OPTB-QA-03` | `docs-qa` | Phase B: Chạy `mvn test` (`backend/`), `npm install && npx tsc --noEmit && npm run build` (`frontend/`), `docker compose config -q`, `pytest` (`audio-worker` & `tests/e2e` parity) | `docs/TASK_BOARD.md`, `tests/e2e/*` | `DONE` | `mvn test`: 14/14 pass; `tsc` + `vite build`: exit 0; `docker compose config -q`: exit 0; Docker `audio-worker` pytest: 6/6 pass; `test_phase1_e2e.py` parity test pass |

---

## 2. Nhật ký Phát hiện & Sửa Bug Chéo (Option B Cross-Review)

| Bug ID | Người phát hiện | Giao cho Agent sửa | File & Dòng lỗi | Mô tả Bug | Trạng thái | Xác nhận sửa lại |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| *(Không có bug chặn hoặc lệch contract giữa `frontend`, `backend` Spring Boot và `audio-worker`)* | - | - | - | Ghi chú nhẹ (non-blocking): `frontend/src/pages/SettingsPage.tsx:45,84,118,188` còn giữ nhãn UI "Backend FastAPI"; `AudioController.renderPreviewWav` (`AudioController.java:385-395`) dùng trực tiếp `JavaAudioFallbackService` thay vì gọi `POST /internal/audio/render` trên `audio-worker` (`exportProjectAudio` có gọi `/internal/audio/export`). | `NOTE` | Không ảnh hưởng API contract hoặc vận hành |

---

## 3. Lịch sử Bug Tracker — Phase 1 Baseline (Trước khi chuyển Option B — Đã `FIXED`)

| Bug ID | Người phát hiện | Giao cho Agent sửa | File & Dòng lỗi | Mô tả Bug | Trạng thái | Xác nhận sửa lại |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `BUG-01` | `integration-qa` | `frontend-studio` | `frontend/src/lib/api/client.ts:159` | `resolveAudioUrl` gọi `/api/audio/stream?ref=...` thay vì `/api/audio/asset?ref=...`. | `FIXED` | Đã đổi sang `/api/audio/asset` |
| `BUG-02` | `integration-qa` | `frontend-studio` | `frontend/src/app/create/page.tsx:327-328` | Mic recorder upload `.webm` bị backend từ chối HTTP 400. | `FIXED` | Đã encode sang `.wav` qua `encodeBlobToWav()` |
| `BUG-03` | `integration-qa` | `frontend-studio` | `frontend/src/types/project.ts:161-188,327-333` | Lệch DTO `AudioUploadResponse`, `DenoiseResponse`, `HealthResponse`. | `FIXED` | Đã khớp schema backend |
| `BUG-04` | `integration-qa` | `frontend-studio` | `frontend/src/types/project.ts:16-24,142-145` | Mất `title` khi sync (`/sync`) và đọc `evt.warning` khi SSE gửi `evt.message`. | `FIXED` | Đã mirror `config.title` & đọc `evt.warning \|\| evt.message` |
| `BUG-05` | `integration-qa` | `infra-backend-dsp` | `backend/app/services/audio/autotune.py:61` | `NOTE_NAMES` thiếu giáng (`Eb, Ab, Bb`) bị fallback về `C`. | `FIXED` | Đã thêm `key_to_pitch_class()` |
| `BUG-06` | `integration-qa` | `ai-multi-agent-core` / `infra-backend-dsp` | `backend/app/api/*`, `llm_adapter.py` | Thiếu routes `/api/lyrics/suggest`, `/api/coach/chat`, `/api/studio/overdub-fit-check` & chưa đọc header `X-*-Api-Key`/`X-LLM-Provider`. | `FIXED` | Đã mount đủ routes & đọc request headers |
