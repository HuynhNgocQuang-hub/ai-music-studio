# Kế hoạch Triển khai Phase 1 (MVP) theo Nhóm Multi-Agent
## Dự án: AI Music Studio (`D:\Music`)

- **Tài liệu chuẩn:** [SRS.md](./SRS.md) | [MULTI_AGENT_ARCHITECTURE.md](./MULTI_AGENT_ARCHITECTURE.md) | [API_AND_UI_SPEC.md](./API_AND_UI_SPEC.md)
- **Mục tiêu Phase 1 (MVP):** Chạy được trọn vẹn luồng cốt lõi trên máy cá nhân (`Node v24` + `Docker Compose`):
  1. Ghi âm Mic / Upload Audio $\rightarrow$ **AI Denoise** + Nghe **Giọng mộc (Dry Check)**.
  2. **Audio Analyzer** (BPM, Key/Scale, Pitch-to-MIDI) + **Auto-Tune Quick Presets** (`Off / Nhẹ / Vừa / Mạnh`).
  3. **Multi-Agent Core** (Dual LLM: **Gemini** đề xuất sáng tác/Coach + **OpenAI** phối khí/QA, có chế độ Mock fallback khi chưa điền Key) chạy luồng `Preserve` + `Accompaniment Only` (Drums, Bass, Harmony MIDI $\rightarrow$ SoundFont Audio).
  4. **Quick Preview** (so sánh Giọng mộc + Beat / Auto-Tune / AI Mix) + Master Limiter (`<= -1.0 dBFS`) + Export `MP3/WAV` + **Auto-Save `IndexedDB` & `Redis`**.

---

## Phân chia Vai trò & Phạm vi File (Zero-Conflict File Ownership)

Để nhiều AI Agent code song song không xung đột, mỗi Agent chỉ sở hữu thư mục riêng:

### Agent 1 — `infra-backend-dsp` (Hạ tầng Docker, Redis & Audio DSP)
* **Phạm vi sở hữu:**
  * `docker-compose.yml` (`redis:7-alpine` maxmemory 256MB + `backend` service)
  * `.env.example`, `.gitignore`
  * `backend/Dockerfile`, `backend/requirements.txt`
  * `backend/app/main.py`, `backend/app/core/` (Config, Redis Client + In-Memory fallback, State Manager)
  * `backend/app/services/audio/` (`denoise.py`, `analyzer.py`, `autotune.py`, `renderer.py` với FluidSynth/SoundFont nhẹ + `pedalboard` Limiter, `exporter.py`)
  * `backend/app/api/` (Endpoints: `/api/audio/*`, `/api/projects/*`, `/api/jobs/*`, `/api/health`)
* **Đầu ra hoàn thành:** `docker compose up` chạy khỏe, API Health trả về OK, test pass luồng Upload $\rightarrow$ Denoise $\rightarrow$ Analyze $\rightarrow$ Auto-Tune $\rightarrow$ Render WAV/MP3.

### Agent 2 — `ai-multi-agent-core` (Hệ thống Multi-Agent bên trong App)
* **Phạm vi sở hữu:**
  * `backend/app/agents/`
    * `llm_adapter.py`: **Dual LLM Adapter** hỗ trợ **Gemini API** (`google-genai`), **OpenAI API** (`openai`), và Mock Provider (khi test chưa cần Key).
    * `orchestrator.py`: Điều phối StateGraph (LangGraph / State Machine), Timeout `60s`, Cancel token, Partial regeneration hooks.
    * `composer_agent.py`: (Mặc định **Gemini**) Phân tích mô-típ giai điệu, sinh tiến trình hợp âm & cấu trúc.
    * `arranger_agent.py`: (Mặc định **OpenAI** hoặc Gemini) Sinh MIDI JSON tách track (`drums`, `bass`, `harmony`) chuẩn Schema.
    * `coach_lyricist_agent.py`: (Mặc định **Gemini**) Gợi ý đặt mô-típ, viết lời, và AI Coach đề xuất sửa lỗi.
    * `qa_agent.py`: (Mặc định **OpenAI** phản biện độc lập) Kiểm tra Scale/Hợp âm/Range/Độ dài, tối đa 2 vòng + Best-effort Fallback.
  * `backend/tests/test_agents.py`
* **Đầu ra hoàn thành:** Unit test pass cho cả luồng `Preserve` + `Accompaniment` và vòng lặp QA (`max 2 iterations` + Fallback).

### Agent 3 — `frontend-studio` (Giao diện Next.js, Web Audio & IndexedDB)
* **Phạm vi sở hữu:**
  * `frontend/` (Next.js App Router + TypeScript + Tailwind CSS)
  * `frontend/src/lib/storage/indexeddb.ts`: Auto-Save ngầm mỗi 5–10s (rolling cap 5 dự án), khôi phục khi quên lưu.
  * `frontend/src/lib/audio/player.ts`: Web Audio / Tone.js đồng bộ đa track & chuyển tức thì Giọng mộc / Auto-Tune / AI Mix.
  * `frontend/src/lib/api/client.ts`: Kết nối FastAPI & lắng nghe SSE `/api/jobs/{id}/events`.
  * `frontend/src/app/` (Sidebar Menu + 4 trang chuẩn `API_AND_UI_SPEC.md`):
    * `/create` (4-Step Wizard)
    * `/studio/[id]` (Khung Studio cơ bản Phase 1: Transport Bar, Mixer, AI Coach Drawer)
    * `/library` (Danh sách dự án + Tìm kiếm + Phân trang 12 mục/trang + Khôi phục bản nháp)
    * `/settings` (Cấu hình Gemini/OpenAI Key & Kiểm tra Redis/Backend)
* **Đầu ra hoàn thành:** `npm run build` pass không lỗi TypeScript, chạy được trọn vẹn Wizard `/create` $\rightarrow$ Preview $\rightarrow$ `/library` phân trang.

### Agent 4 — `integration-qa` (Kiểm thử Tích hợp & Nghiệm thu)
* **Phạm vi sở hữu:** `tests/e2e/` và rà soát đối chiếu [SRS.md](./SRS.md) & [API_AND_UI_SPEC.md](./API_AND_UI_SPEC.md).
* **Nhiệm vụ:** Chạy thử end-to-end khi 3 Agent trên xong việc, đối chiếu Payload giữa `frontend` và `backend`, kiểm tra giới hạn Master Limiter (`<= -1.0 dBFS`) và báo lỗi nếu lệch contract.
