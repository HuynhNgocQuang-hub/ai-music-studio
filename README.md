# AI Music Studio (Hybrid Multi-Agent)

Hệ thống sáng tác, chỉnh cao độ (**Auto-Tune**) và phối khí âm nhạc (**Hum-to-Music**) sử dụng kiến trúc **Multi-Agent (Hybrid LLM + DSP)** kết hợp giữa **MIDI (Piano Roll)** và **Audio Clips (DAW-lite)**.

## Tài liệu Đặc tả & Kiến trúc

- [SRS.md](./docs/SRS.md) — Đặc tả yêu cầu chức năng (`FR-INP`, `FR-ANA`, `FR-AUTOTUNE`, `FR-HUM`, `FR-LYRIC`, `FR-STUDIO`), ràng buộc và tiêu chí nghiệm thu.
- [MULTI_AGENT_ARCHITECTURE.md](./docs/MULTI_AGENT_ARCHITECTURE.md) — Kiến trúc 6 Agent (Orchestrator, Denoise/Analyzer, Auto-Tune DSP, Composer, Arranger, Lyricist/Coach, Producer/QA & Mastering), `Shared Project State`, Dual LLM (**Gemini + OpenAI**) và lưu trữ nhẹ đĩa (`IndexedDB` + `Redis`).
- [API_AND_UI_SPEC.md](./docs/API_AND_UI_SPEC.md) — Kiến trúc điều hướng (`/create`, `/studio/:id`, `/library` phân trang, `/settings`), API Contract (**Spring Boot** + SSE + nội bộ `audio-worker`) và cấu trúc file `.aimusic`.
- [PHASE1_TEAM_PLAN.md](./docs/PHASE1_TEAM_PLAN.md) — Kế hoạch phân chia vai trò cho đội ngũ Multi-Agent thực hiện Phase 1 (MVP) trên kiến trúc Option B.
- [TASK_BOARD.md](./docs/TASK_BOARD.md) — Bảng theo dõi tiến độ, kiểm lỗi chéo và bằng chứng kiểm thử.

## Kiến trúc Hệ thống (Option B)

- **Frontend (`frontend/`):** React 19 + Vite + TypeScript + Tailwind CSS + `react-router-dom` + Web Audio API + `IndexedDB` (chạy bằng **Node.js v24** trên cổng `3000`, proxy `/api` $\rightarrow$ `http://localhost:8000`).
- **Core Backend & Multi-Agent Orchestrator (`backend/`):** **Java 21 + Spring Boot 3.x** (Maven, cổng `8000`) — xử lý toàn bộ `/api/*` REST & SSE (`SseEmitter`), `Spring Data Redis` kèm In-Memory TTL fallback, Dual LLM Adapter (`Gemini` + `OpenAI` + Mock fallback), điều phối 6 Agent, xuất/nhập `.mid` (`javax.sound.midi`) và `.aimusic` ZIP, cùng pure-Java Audio Fallback khi không chạy Docker worker.
- **Audio DSP Microservice (`audio-worker/`):** Slim **Python FastAPI** trong **Docker** (cổng `8001`) — xử lý DSP chuyên sâu (`noisereduce`, `librosa`, `pedalboard`, `FluidSynth`, `FFmpeg`, `mido`) cho Denoise, Pitch/BPM/Key Analysis, Auto-Tune, Render MIDI $\rightarrow$ Audio, Master Limiter ($\le -1.0\text{ dBFS}$) và Overdub Fit Check.
- **State, Undo & Cache (`redis`):** `redis:7-alpine` (`maxmemory 256mb`, `allkeys-lru`) trong Docker Compose.
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
> **Lưu ý cổng Redis:** Mặc định `.env` cấu hình `REDIS_HOST_PORT=16379` và `REDIS_URL=redis://127.0.0.1:16379/0` để tránh đụng cổng `6379` với các dự án Docker khác trên máy. Hỗ trợ cả Gemini API Key dạng mới (`AQ...`) và `AIza...` (gửi qua header `x-goog-api-key`).

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

## Tính năng Nổi bật (Pro DAW & Hybrid Multi-Agent — Phase 1–5)
- **Pro DAW Workstation (`/studio/:id`):** Top Transport cố định (`Play/Pause/Stop/Rec kèm bù trễ Lat ms/Loop/Metronome`, LCD `Bar:Beat` + `BPM` + `Key/Scale/Time Signature 4/4|3/4|6/8`, Undo/Redo, Tools `Select/Split/Snap`, chuyển chế độ **`Quick | Pro DAW`** & nút **Regenerate toàn bài**), Left Browser (`Patterns`, `Inspector`, `Presets`), Multi-Track Arrangement (`+ Track`, `+ Section` kèm `Energy%`, Chord Track CRUD, Multi-Clip Move/Split/Trim/Fade) và Bottom Production Dock (`Step Sequencer`, `Piano Roll`, `Console Mixer`, `Auto-Tune DSP`, `Lyrics & Karaoke` full CRUD). Giao diện được modular hóa (`QuickStudioView.tsx`, `ConsoleMixerPanel.tsx`) và code-split bằng `React.lazy`.
- **Web Audio + DSP Mixer, Formant Auto-Tune & Send FX Bus:** Tách route từng channel (`vocal`, `texture`, `drums`, `bass`, `harmony`, `lead`), tổng hợp nhạc cụ theo preset (`electronic_808`, `lofi_kit`, `synth_bass`, `warm_pad`, `flute`...), Auto-Tune **bảo toàn formant Cepstral** (precomputed lifter), **3-Band EQ (`low_db`, `mid_db`, `high_db`)**, **Vocal Carve 2.2 kHz (`-2.5 dB`)** và **Send FX Bus (Hall Reverb + Tempo-Synced Ping-Pong Delay)** đồng bộ Web Audio, Python Audio Worker và Java Fallback — xuất `WAV`, `MP3 (320kbps / 192kbps)`, `Stems`, `.mid` và gói `.aimusic` tối ưu dung lượng với Master Limiter (`<= -1.0 dBFS`).
- **Bảo mật, Ổn định TTL & Phòng chống DoS (Phase 5):** Bind Docker ports về `127.0.0.1`, siết `CorsConfig` + `SecurityHeadersFilter` (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`), che API key trong log/HTTP error của `LlmAdapter`, giới hạn upload (`55MB` multipart / `_read_upload_bounded` HTTP `413`), chặn Zip Bomb + path traversal + collision-safe import `.aimusic` (`overwrite=false`), từ chối `total_bars > 256` (`400 Bad Request`), và **Auto-Rehydrate audio từ `IndexedDB`** khi Redis TTL hết hạn.
- **Session Vault & Library (`/library`):** Tìm kiếm, lọc, phân trang, tạo Blank DAW, nhân bản, Import/Export `.aimusic`, và xóa có xác nhận nội tuyến cả Local Draft lẫn Server Saved Session (`DELETE /api/projects/{id}`).
- **Dual LLM & Test Kết nối (`/settings`):** Kiểm tra trực tiếp API Key Gemini/OpenAI (`POST /api/health/llm-test`), cấu hình từng vai Agent và theo dõi sức khỏe Backend / Redis / FluidSynth.

## Kiểm tra & Build (Verification)

```bash
# Kiểm tra cấu hình Docker Compose nhóm music
docker compose -p music config -q

# Chạy unit, MockMvc & security tests cho Spring Boot Backend (35/35 pass)
cd backend && mvn -B package

# Chạy unit & DSP/DoS tests cho Python Audio DSP Worker trong Docker (16/16 pass)
docker compose -p music exec -T audio-worker pytest -v tests/test_worker.py

# Kiểm tra TypeScript & build production cho React Vite Frontend (2164 modules)
cd frontend && npx tsc --noEmit && npm run build

# Chạy Live Full-Stack E2E (yêu cầu Redis :16379, audio-worker :8001, Backend :8000 đang chạy - 20/20 pass)
docker run --rm --add-host=host.docker.internal:host-gateway -v "${PWD}:/workspace" -w /workspace -e "E2E_BASE_URL=http://host.docker.internal:8000" music-audio-worker pytest -v tests/e2e/test_phase1_e2e.py tests/e2e/test_phase2_3_e2e.py
```
