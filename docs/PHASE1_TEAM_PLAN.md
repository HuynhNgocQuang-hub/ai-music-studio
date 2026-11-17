# Kế hoạch Triển khai Phase 1 (MVP) theo Nhóm Multi-Agent
## Dự án: AI Music Studio (`D:\Music`) — Kiến trúc Option B

- **Tài liệu chuẩn:** [SRS.md](./SRS.md) | [MULTI_AGENT_ARCHITECTURE.md](./MULTI_AGENT_ARCHITECTURE.md) | [API_AND_UI_SPEC.md](./API_AND_UI_SPEC.md)
- **Mục tiêu Phase 1 (MVP):** Chạy được trọn vẹn luồng cốt lõi trên máy cá nhân (**Node v24** + **Java 21 / Maven 3.9+** + **Docker Compose**):
  1. Ghi âm Mic (`.wav`) / Upload Audio $\rightarrow$ **AI Denoise** + Nghe **Giọng mộc (Dry Check)**.
  2. **Audio Analyzer** (BPM, Key/Scale, Pitch-to-MIDI) + **Auto-Tune Quick Presets** (`Off / Nhẹ / Vừa / Mạnh`).
  3. **Multi-Agent Core** trong Spring Boot (Dual LLM: **Gemini** + **OpenAI** + Mock fallback) chạy luồng `Preserve` + `Accompaniment Only` (Drums, Bass, Harmony MIDI $\rightarrow$ Audio Worker / Java Fallback).
  4. **Quick Preview** (so sánh Giọng mộc + Beat / Auto-Tune / AI Mix) + Master Limiter (`<= -1.0 dBFS`) + Export `MP3/WAV/MIDI/.aimusic` + **Auto-Save `IndexedDB` & `Redis`**.

---

## Phân chia Vai trò & Phạm vi File (Zero-Conflict File Ownership)

Để nhiều AI Agent code song song không xung đột, mỗi Agent chỉ sở hữu thư mục riêng:

### Agent 1 — `spring-backend` (Java 21 + Spring Boot 3.x Core Backend & Multi-Agent)
* **Phạm vi sở hữu:** Toàn bộ thư mục `backend/`
  * `backend/pom.xml`, `backend/Dockerfile`, `backend/src/main/resources/application.yml`
  * `config/` & `store/`: `AppProperties`, `CorsConfig`, `ProjectStateStore` (`Spring Data Redis` + In-Memory TTL fallback, undo stack 20 bước, phân trang & `/sync`)
  * `model/`: POJOs/Records chuẩn `Shared Project State` và toàn bộ DTO khớp 1:1 với Frontend
  * `audio/`: `AudioWorkerClient` (gọi `AUDIO_WORKER_URL` cổng `8001`) + `JavaAudioFallbackService` (WAV validation/parsing, denoise/BPM/key/pitch fallback, pitch-shift fallback, synth WAV + Master Limiter `<= -1.0 dBFS`, `.mid` via `javax.sound.midi`, `.aimusic` ZIP export/import)
  * `agents/`: `LlmAdapter` (Gemini + OpenAI + Mock, đọc `X-Gemini-Api-Key`, `X-OpenAI-Api-Key`, `X-LLM-Provider`), `ComposerAgent`, `ArrangerAgent`, `CoachLyricistAgent`, `QaReviewerAgent` (max 2 vòng + Best-effort Fallback), `AgentOrchestrator` (60s timeout, cancel token, SSE events)
  * `controller/`: Toàn bộ routes `/api/*` (`health`, `audio/*`, `jobs/*` với `SseEmitter`, `lyrics/suggest`, `coach/chat`, `studio/overdub-fit-check`, `projects/*`)
  * `backend/src/test/java/com/aimusic/studio/...`: MockMvc API tests, Multi-Agent QA loop/fallback tests, Limiter/MIDI/aimusic tests
* **Đầu ra hoàn thành:** `mvn test` trong `backend/` pass 100% (0 failures).

### Agent 2 — `audio-worker` (Python FastAPI Audio DSP Microservice & Docker Compose)
* **Phạm vi sở hữu:**
  * `audio-worker/` (`Dockerfile`, `requirements.txt` gọn nhẹ không PyTorch/TensorFlow, `app/main.py`, `app/services/{denoise.py,analyzer.py,autotune.py,renderer.py,exporter.py}`, `tests/test_worker.py`)
  * `docker-compose.yml` (3 services: `redis` `redis:7-alpine` maxmemory 256MB `allkeys-lru`, `audio-worker` cổng `8001`, `backend` Spring Boot cổng `8000` kết nối `AUDIO_WORKER_URL=http://audio-worker:8001`)
  * `.env.example` (`REDIS_URL`, `AUDIO_WORKER_URL`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `DEFAULT_LLM_PROVIDER`, `SPRING_PROFILES_ACTIVE`)
* **Đầu ra hoàn thành:** `docker compose config -q` exit 0; các endpoint `/health` và `/internal/audio/*` đúng hợp đồng.

### Agent 3 — `react-vite` (Frontend React 19 + Vite + TypeScript + Tailwind CSS)
* **Phạm vi sở hữu:** Toàn bộ thư mục `frontend/`
  * `frontend/index.html`, `frontend/vite.config.ts` (proxy `/api` $\rightarrow$ `http://localhost:8000`), `frontend/package.json` (`react-router-dom`, không còn Next.js), `frontend/.gitignore`
  * `frontend/src/main.tsx`, `frontend/src/App.tsx` (`BrowserRouter`, `Routes`, `Route`)
  * `frontend/src/pages/` (`HomePage.tsx`, `CreatePage.tsx`, `StudioPage.tsx`, `LibraryPage.tsx`, `SettingsPage.tsx`)
  * `frontend/src/lib/storage/indexeddb.ts`: Auto-Save ngầm mỗi 5–10s (rolling cap 5 dự án), khôi phục khi quên lưu
  * `frontend/src/lib/audio/player.ts`: Web Audio đồng bộ đa track, `encodeBlobToWav()`, A/B Raw/Dry/Auto-Tune/AI Mix
  * `frontend/src/lib/api/client.ts`: Kết nối Spring Boot qua `import.meta.env.VITE_API_BASE_URL ?? ""` & lắng nghe SSE `/api/jobs/{id}/events`
  * `frontend/src/components/layout/AppShell.tsx` & `src/components/providers/ProjectProvider.tsx` (`Link`/`useLocation`/`useNavigate`)
* **Đầu ra hoàn thành:** `npm install`, `npx tsc --noEmit` và `npm run build` trong `frontend/` exit 0 (0 lỗi TypeScript/Vite).

### Agent 4 — `docs-qa` (Tài liệu, Kiểm thử Tích hợp, Cross-Review & Nghiệm thu)
* **Phạm vi sở hữu:** `README.md`, `docs/*.md` (trừ `SRS.md` chỉ sửa nếu cần), `tests/e2e/`.
* **Nhiệm vụ:**
  * Cập nhật tài liệu phản ánh kiến trúc Option B (`Java 21 Spring Boot + React Vite + Docker Python audio-worker + Redis`).
  * Cross-review 1:1 giữa `frontend/src/lib/api/client.ts` + `frontend/src/types/project.ts`, Spring Boot controllers/DTOs trong `backend/src/main/java/...`, và `audio-worker/app/main.py`.
  * Chạy `mvn test` (`backend/`), `npx tsc --noEmit && npm run build` (`frontend/`), `docker compose config -q`, và đối chiếu các ràng buộc SRS (Master Limiter `<= -1.0 dBFS`, validation upload, QA max 2 vòng + fallback).

---

## Quy trình Làm việc & Cross-Review 3 Tầng (Chống Xung đột & Tự Bắt Bug)

1. **Luật Sở hữu File (Strict File Ownership):**
   * Mỗi Agent chỉ được tạo/sửa file trong phạm vi sở hữu của mình.
   * Trước khi hoàn tất, kiểm tra `git status` / `git diff --name-only` để xác nhận không sửa lấn sang thư mục của Agent khác.
2. **Tầng 1 — Tự kiểm tra tại chỗ (Self-Check):**
   * `spring-backend`: Chạy `mvn test` (pass 100% MockMvc, Multi-Agent & DSP/Export fallback tests).
   * `audio-worker`: Chạy `docker compose config -q` + kiểm tra syntax Python / unit tests.
   * `react-vite`: Chạy `npx tsc --noEmit && npm run build` (0 lỗi TypeScript/Vite).
3. **Tầng 2 — Cross-Review chéo (Maker–Checker):**
   * `docs-qa` đọc chéo code giữa `frontend/`, `backend/` và `audio-worker/` đối chiếu 1:1 với [API_AND_UI_SPEC.md](./API_AND_UI_SPEC.md).
   * Nếu phát hiện bug hoặc lệch schema, ghi vào mục **Bug Tracker** trong [TASK_BOARD.md](./TASK_BOARD.md) kèm `File:Line` để đúng Agent sở hữu sửa lại.
4. **Tầng 3 — Nghiệm thu E2E:**
   * Chạy bộ kiểm thử/xác minh và ghi kết quả thực tế (build/test output) vào cột **Bằng chứng** trên [TASK_BOARD.md](./TASK_BOARD.md).
