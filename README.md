# AI Music Studio (Hybrid Multi-Agent)

Hệ thống sáng tác, chỉnh cao độ (**Auto-Tune**) và phối khí âm nhạc (**Hum-to-Music**) sử dụng kiến trúc **Multi-Agent (Hybrid LLM + DSP)** kết hợp giữa **MIDI (Piano Roll)** và **Audio Clips (DAW-lite)**.

## Tài liệu Đặc tả & Kiến trúc

- [PHASES_OVERVIEW.md](./docs/PHASES_OVERVIEW.md) — **Tổng hợp Toàn bộ Các Phase Phát triển (Phase 1–9)** — bảng tổng hợp, sơ đồ tiến hóa kiến trúc và chi tiết từng giai đoạn.
- [REQUIREMENTS.md](./docs/REQUIREMENTS.md) — **Tài liệu Yêu cầu Hệ thống & Nghiệp vụ** (Phạm vi In/Out-of-Scope, User Stories, Ma trận truy vết BR/FR -> Code -> Test).
- [DESIGN_SPEC.md](./docs/DESIGN_SPEC.md) — **Tài liệu Thiết kế Kiến trúc & UI/UX** (Sơ đồ 4 tầng, Sequence TTL Recovery, ER `ProjectState`, FL Playlist Clip Tokens & Security Architecture).
- [SRS.md](./docs/SRS.md) — Đặc tả yêu cầu chức năng chi tiết (`FR-INP`, `FR-ANA`, `FR-AUTOTUNE`, `FR-HUM`, `FR-LYRIC`, `FR-STUDIO`), ràng buộc và tiêu chí nghiệm thu.
- [MULTI_AGENT_ARCHITECTURE.md](./docs/MULTI_AGENT_ARCHITECTURE.md) — Kiến trúc 6 Agent, Dual LLM (**Gemini `gemini-3.8-flash` + OpenAI**), lưu trữ nhẹ đĩa (`IndexedDB` + `Redis` + PostgreSQL/H2 + MinIO S3), WebSocket Collab và lộ trình Phase 1–9.
- [API_AND_UI_SPEC.md](./docs/API_AND_UI_SPEC.md) — Kiến trúc điều hướng (`/`, `/create`, `/studio/:id`, `/library`, `/share`, `/share/:slug`, `/settings`), API Contract (**Spring Boot** + SSE + WebSocket `/ws/collab` + nội bộ `audio-worker`) và cấu trúc `.aimusic`.
- [PHASE1_TEAM_PLAN.md](./docs/PHASE1_TEAM_PLAN.md) — Kế hoạch phân chia vai trò Multi-Agent thực hiện Phase 1 (MVP) trên kiến trúc Option B.
- [TASK_BOARD.md](./docs/TASK_BOARD.md) — Bảng theo dõi tiến độ, kiểm lỗi chéo và bằng chứng kiểm thử Phase 1–9.

## Kiến trúc Hệ thống (Option B — Hybrid SaaS)

- **Frontend (`frontend/`):** React 19 + Vite + TypeScript + Tailwind CSS + `react-router-dom` + Web Audio API + WebMIDI + `IndexedDB` (chạy bằng **Node.js v24** trên cổng `3000`, proxy `/api` $\rightarrow$ `http://localhost:8000`).
- **Core Backend & Multi-Agent Orchestrator (`backend/`):** **Java 21 + Spring Boot 3.x** (Maven, cổng `8000`) — xử lý toàn bộ `/api/*` REST & SSE (`SseEmitter`), **Hybrid Guest + HS256 JWT Auth**, **Daily Quota Rate-Limiter (`429`)**, `Spring Data Redis` kèm In-Memory TTL fallback (**Undo 50 bước**), **PostgreSQL + H2 Local Fallback** (`CloudDatabaseService`), **MinIO S3 (AWS SigV4) + Local Fallback** (`ObjectStorageService`), Dual LLM Adapter (`Gemini` + `OpenAI` + Mock fallback), điều phối 6 Agent, xuất/nhập `.mid` & `.aimusic`, Public Demo Share `/api/share/*`, cùng pure-Java Audio Fallback (`WAV`, `MP3`, `FLAC`, `ID3` tags) khi không chạy Docker worker.
- **Audio DSP Microservice (`audio-worker/`):** Slim **Python FastAPI** trong **Docker** (cổng `8001`) — xử lý DSP chuyên sâu (`noisereduce`, `librosa`, `pedalboard`, `FluidSynth` + Custom `.sf2`, `FFmpeg`, `mido`) cho Denoise, Pitch/BPM/Key Analysis, Auto-Tune, Stem Separation (Vocal/Beat), Render MIDI $\rightarrow$ Audio, Master Limiter ($\le -1.0\text{ dBFS}$) và Export (`WAV`, `MP3` ID3, `FLAC`, `Stems`).
- **Cloud Data, Storage & HTTPS Edge (`docker-compose.yml`):** `redis:7-alpine` (`:16379`), `postgres:16-alpine` (`:15432`), `minio/minio` (`:19000`/`:19001`), và `caddy:2-alpine` HTTPS Reverse Proxy (`:8443` via `infra/Caddyfile`).
- **LLM Providers:** Google Gemini API + OpenAI API (qua Adapter thống nhất trong Spring Boot).

## Cấu trúc Thư mục

```text
ai-music-studio/
├── frontend/          # React 19 + Vite + TypeScript + Tailwind CSS (port 3000)
├── backend/           # Java 21 + Spring Boot 3.x Core API & Multi-Agent (port 8000)
├── audio-worker/      # Python FastAPI Audio DSP Microservice (port 8001, Docker)
├── docs/              # Tài liệu SRS, Kiến trúc, API/UI Spec, Team Plan, Task Board
├── tests/e2e/         # Bộ kiểm thử tích hợp & đối chiếu contract
├── docker-compose.yml # redis + audio-worker + backend
└── .env.example       # Biến môi trường mẫu (Gemini/OpenAI keys, Redis, Worker URL)
```

## Hướng dẫn Chạy Dự án

### 1. Cấu hình Biến môi trường
Sao chép `.env.example` thành `.env` ở thư mục gốc và điền key (có thể bỏ trống để chạy ở chế độ Mock LLM khi test):
```bash
cp .env.example .env
```
> **Lưu ý cổng & LLM:** Mặc định `.env` cấu hình `REDIS_HOST_PORT=16379`, `REDIS_URL=redis://127.0.0.1:16379/0` và `GEMINI_MODEL=gemini-3.8-flash` (tự fallback từ `gemini-2.5-flash` nếu gặp HTTP 404). Hỗ trợ cả Gemini API Key dạng mới (`AQ...`) và `AIza...` (gửi qua header `x-goog-api-key`).

### 2. Khởi chạy Nhanh Toàn Stack trên Windows (Khuyên dùng)
```powershell
./start-dev.ps1
```
Script tự động nạp `.env`, khởi động đúng 1 nhóm Docker Compose **`music`** (`ai-music-redis` trên `:16379` + `ai-music-audio-worker` trên `:8001`), build/chạy **Spring Boot Backend** (`:8000`) và mở **React + Vite Frontend** (`:3000`).

### 3. Hoặc Chạy Toàn bộ bằng Docker Compose (`music`)
```bash
docker compose -p music up --build -d
```
- `backend` (Spring Boot): `http://localhost:8000`
- `audio-worker` (Python FastAPI DSP): `http://localhost:8001`
- `redis`: `127.0.0.1:${REDIS_HOST_PORT:-6379}` (mặc định `.env` là `16379`)

*(Tùy chọn chạy Backend Java trực tiếp trên máy khi đã cài Java 21 & Maven 3.9+):*
```bash
cd backend
mvn spring-boot:run
```
> Khi `audio-worker` chưa chạy, Spring Boot tự động kích hoạt `JavaAudioFallbackService` cho các luồng WAV/MIDI/3-Band EQ/Send FX/Limiter cơ bản.

### 4. Chạy Frontend (React + Vite)
Yêu cầu **Node.js v24+**:
```bash
cd frontend
npm install
npm run dev
```
Mở trình duyệt tại `http://localhost:3000` (mọi request `/api/*` được `vite.config.ts` proxy sang `http://localhost:8000`).

## Tính năng Nổi bật (Pro DAW & Hybrid Cloud Multi-Agent — Phase 1–9)
- **Pro DAW Workstation & Khung Clip FL Studio 12 (`/studio/:id`):** Top Transport cố định (`Play/Pause/Stop/Rec`, `Loop`, `Metronome`, `BPM`, `Key/Scale/Time Signature 4/4|3/4|6/8`, **Undo/Redo 50 bước**, `Select/Split/Snap`, **`Quick | Pro DAW`**, **`Collab` WebSocket**, **`Publish` Demo**), Playlist chuẩn FL Studio (**Audio Waveform** polygon đối xứng, **Multi-Param Automation Envelope `DYN | VOL | PAN | FILT | REVERB`** phát qua Web Audio `linearRampToValueAtTime`, **MIDI Pattern** chia theo Section + biến thể `#2`), và Bottom Dock (`Step Sequencer`, `Piano Roll + Hardware WebMIDI`, `Console Mixer`, `Auto-Tune DSP + Visual Pitch Curve Editor`, `Lyrics & Karaoke`).
- **Realtime Studio Collaboration & Pinned Bar Notes (`Phase 9`):** WebSocket `/ws/collab` (`2 MB` buffer, Vite `/ws` proxy, Caddy `/ws/*`) xác thực JWT + link mời `?collab=col_...`, hiển thị peer đang online + vị trí Bar/Track/màu riêng, đồng bộ live `ProjectState` (`state_sync`), gửi **`Cue Bar`** (`transport_cue`), và **Ghi chú theo Ô nhịp** (`/api/studio/{id}/comments` qua REST + WS `bar_comment_event`).
- **AI Music Copilot Toàn cục & Toàn năng (`AiCoachChatDrawer.tsx`):** Hoạt động xuyên suốt các trang với **4 chế độ (`Producer` | `Hòa âm` | `Viết lời` | `Mix / Tune`)**, **Mini-RAG `DawPlaybook`**, **SSE Token Streaming** (`/api/coach/chat/stream`), **Multimodal Audio/Voice** (`/api/coach/chat/audio` `<= 10 MB`, `Gửi kèm Vocal`, Mic WAV/Web Speech), **A/B Nghe thử hợp âm**, **24 Native Tool Actions**, **Kiểm tra & Đề xuất tổng thể**, **Áp dụng tất cả**, **Hoàn tác 1 chạm**, và lưu lịch sử qua `IndexedDB chat_threads`.
- **Stem Separation, DSP Mixer, Custom `.sf2`, FLAC & ID3 Master Export:** Tách stem **Vocal + Beat** (`POST /api/studio/separate-stems`), nạp **Custom `.sf2` SoundFont** tùy chọn (`<= 50 MB`, kiểm tra `RIFF/sfbk`), Auto-Tune **Formant Cepstral + Visual Pitch Curve Editor**, **3-Band EQ (`low_db`, `mid_db`, `high_db`)**, **Vocal Carve 2.2 kHz**, và **Send FX Bus** — xuất `WAV`, `MP3 (320k / 192k + ID3 tags)`, **`FLAC Lossless`**, `Stems`, `.mid` và `.aimusic` với Master Limiter (`<= -1.0 dBFS`, `-14 LUFS`).
- **Hybrid Multi-User Cloud SaaS, Login/Logout & Community Demo Showcase (`Phase 8–9`):** Hỗ trợ dùng ngay ở chế độ **Guest** hoặc đăng ký/đăng nhập **JWT** trên `/login` & `/register` (`Authorization: Bearer`, Local OAuth Sandbox, nút **Đăng nhập/Đăng xuất** trên Top Bar & Studio, `POST /api/auth/logout` thu hồi `jti` chặn replay `401`), phân quyền `CloudProjectAccessService` `403` & đồng bộ audio bền vững qua **PostgreSQL / H2 Fallback** + **MinIO S3 / Local Fallback** (tự rehydrate audio khi Redis hết TTL), **Daily Quota Progress & Rate-Limit (`HTTP 429`)** trên `/settings`, Showcase công khai `/share` & `/share/:slug` (tìm kiếm, lọc thể loại, phân trang, **Thích `POST /api/share/{slug}/like`**, **Bình luận mốc thời gian `Timestamp Comments` kèm marker trên thanh audio**, **Thu hồi Publish**, **Remix trong Studio**), và **Caddy HTTPS + WS Reverse Proxy** (`:8443`).
- **Bảo mật & Ổn định TTL (`Phase 5`):** Bind Docker ports về `127.0.0.1`, `CorsConfig` + `SecurityHeadersFilter`, redact key trong `LlmAdapter`, giới hạn upload (`55MB` / `413` trên worker), chống Zip Bomb + collision-safe import (`.aimusic` `overwrite=false`), từ chối `total_bars > 256` (`HTTP 400`), và **Auto-Rehydrate audio từ `IndexedDB` / `CloudDB` / `S3`**.
- **Session Vault (`/library`) & Settings (`/settings`):** Tìm kiếm, lọc **Workspace Scope (`Tất cả | Của tôi | Công khai`)**, phân trang, badge **Cloud / Public**, nút **Ẩn Share**, xóa 2 bước nội tuyến (tự dọn release công khai), cấu hình Dual LLM, upload `.sf2` SoundFont, thanh tiến độ Cloud Quota, kiểm tra trạng thái Cloud DB/S3 & nút **Test API Key**.

## Kiểm tra & Build (Verification)

```bash
# Kiểm tra cấu hình Docker Compose nhóm music (redis, postgres, minio, audio-worker, backend, caddy)
docker compose -p music config -q

# Chạy unit, MockMvc, security, Phase 8 Auth & Phase 9 WebSocket/Collab/Showcase tests cho Spring Boot Backend (43/43 pass)
cd backend && mvn -B package

# Chạy unit & DSP/DoS/FLAC tests cho Python Audio DSP Worker trong Docker (17/17 pass ở Phase 7; 18 tests gồm FLAC export sẵn sàng khi Docker bật)
docker compose -p music exec -T audio-worker pytest -v tests/test_worker.py

# Kiểm tra TypeScript & build production cho React Vite Frontend (2173 modules)
cd frontend && npx tsc --noEmit && npm run build

# Chạy Live Full-Stack E2E (yêu cầu Redis :16379, audio-worker :8001, Backend :8000 đang chạy - Phase 1..7 21/21 pass + Phase 8–9 Live Checks)
docker run --rm --add-host=host.docker.internal:host-gateway -v "${PWD}:/workspace" -w /workspace -e "E2E_BASE_URL=http://host.docker.internal:8000" music-audio-worker pytest -v tests/e2e/test_phase1_e2e.py tests/e2e/test_phase2_3_e2e.py
```
