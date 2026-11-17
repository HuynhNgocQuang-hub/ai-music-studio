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

### 2. Chạy Backend + Audio Worker + Redis bằng Docker Compose
```bash
docker compose up --build
```
- `backend` (Spring Boot): `http://localhost:8000`
- `audio-worker` (Python FastAPI DSP): `http://localhost:8001`
- `redis`: `localhost:6379`

*(Tùy chọn chạy Backend Java trực tiếp trên máy khi đã cài Java 21 & Maven 3.9+):*
```bash
cd backend
mvn spring-boot:run
```
> Khi `audio-worker` chưa chạy, Spring Boot tự động kích hoạt `JavaAudioFallbackService` cho các luồng WAV/MIDI/Limiter cơ bản.

### 3. Chạy Frontend (React + Vite)
Yêu cầu **Node.js v24+**:
```bash
cd frontend
npm install
npm run dev
```
Mở trình duyệt tại `http://localhost:3000` (mọi request `/api/*` được `vite.config.ts` proxy sang `http://localhost:8000`).

## Kiểm tra & Build (Verification)

```bash
# Kiểm tra cấu hình Docker Compose
docker compose config -q

# Chạy unit & MockMvc integration tests cho Spring Boot Backend
cd backend && mvn test

# Kiểm tra TypeScript & build production cho React Vite Frontend
cd frontend && npx tsc --noEmit && npm run build
```
