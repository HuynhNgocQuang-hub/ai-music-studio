# Bảng Theo dõi Tiến độ & Kiểm lỗi Chéo (`TASK_BOARD`)
## Dự án: AI Music Studio — Phase 1 (MVP)

- **Repository:** `https://github.com/HuynhNgocQuang-hub/ai-music-studio`
- **Kế hoạch chi tiết:** [PHASE1_TEAM_PLAN.md](./PHASE1_TEAM_PLAN.md)
- **Quy ước trạng thái:** `TODO` (Chờ làm) | `IN_PROGRESS` (Đang làm) | `IN_REVIEW` (Chờ AI khác check) | `BLOCKED` (Kẹt/Lỗi) | `DONE` (Đã pass test + review)

---

## 1. Bảng Công việc theo từng AI Agent

| Mã Task | Agent Phụ trách | Hạng mục Công việc | Phạm vi File Được phép | Trạng thái | Bằng chứng (Test / Build Output) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `P1-INFRA-01` | `infra-backend-dsp` | Tạo `docker-compose.yml` (`redis:7-alpine` maxmemory 256MB + `backend`), `.env.example`, `backend/Dockerfile`, `requirements.txt` | `docker-compose.yml`, `.env.example`, `backend/Dockerfile`, `backend/requirements.txt` | `TODO` | _Chưa có_ |
| `P1-INFRA-02` | `infra-backend-dsp` | Tạo `backend/app/core/` (Config, Redis client + In-Memory fallback, State Manager có TTL) & `/api/health` | `backend/app/main.py`, `backend/app/core/*`, `backend/app/api/health.py` | `TODO` | _Chưa có_ |
| `P1-DSP-03` | `infra-backend-dsp` | Implement Audio Pipeline: Upload validation (`WAV/MP3/M4A/OGG/FLAC`, `<=50MB`), AI Denoise, Analyzer (BPM, Key, Pitch-to-MIDI), Auto-Tune Presets | `backend/app/services/audio/denoise.py`, `analyzer.py`, `autotune.py`, `backend/app/api/audio.py` | `TODO` | _Chưa có_ |
| `P1-DSP-04` | `infra-backend-dsp` | Implement FluidSynth SoundFont Renderer + `pedalboard` Master Limiter (`Peak <= -1.0 dBFS`) + Export `WAV/MP3` & `/api/projects/*` | `backend/app/services/audio/renderer.py`, `exporter.py`, `backend/app/api/projects.py` | `TODO` | _Chưa có_ |
| `P1-AGT-01` | `ai-multi-agent-core` | Implement **Dual LLM Adapter** (`Gemini` + `OpenAI` + `Mock` fallback) đọc key từ `.env`/settings | `backend/app/agents/llm_adapter.py` | `TODO` | _Chưa có_ |
| `P1-AGT-02` | `ai-multi-agent-core` | Implement `Composer`, `Arranger`, `Coach/Lyricist` & `QA Reviewer` (max 2 vòng + Best-effort Fallback) | `backend/app/agents/composer_agent.py`, `arranger_agent.py`, `coach_lyricist_agent.py`, `qa_agent.py` | `TODO` | _Chưa có_ |
| `P1-AGT-03` | `ai-multi-agent-core` | Implement `Orchestrator` (Timeout `60s`, Cancel token, SSE events) & unit tests `test_agents.py` | `backend/app/agents/orchestrator.py`, `backend/app/api/jobs.py`, `backend/tests/test_agents.py` | `TODO` | _Chưa có_ |
| `P1-FE-01` | `frontend-studio` | Khởi tạo Next.js (TypeScript + Tailwind), App Shell Sidebar Menu (`/create`, `/studio/[id]`, `/library`, `/settings`) | `frontend/package.json`, `frontend/src/app/*`, `frontend/src/components/layout/*` | `TODO` | _Chưa có_ |
| `P1-FE-02` | `frontend-studio` | Implement `IndexedDB` Auto-Save (mỗi 5–10s, giữ tối đa 5 bản nháp, khôi phục khi quên lưu) & API Client + SSE listener | `frontend/src/lib/storage/indexeddb.ts`, `frontend/src/lib/api/client.ts` | `TODO` | _Chưa có_ |
| `P1-FE-03` | `frontend-studio` | Implement Web Audio Player đồng bộ & 4-Step Wizard `/create` (Mic/Upload, Dry Check, Auto-Tune Quick Bar, Tiến trình Agent + Cancel, Preview) | `frontend/src/lib/audio/player.ts`, `frontend/src/app/create/*` | `TODO` | _Chưa có_ |
| `P1-FE-04` | `frontend-studio` | Implement `/studio/[id]` (cơ bản Phase 1), `/library` (tìm kiếm + phân trang 12 mục/trang + khôi phục nháp), `/settings` (API Key & Health) | `frontend/src/app/studio/[id]/*`, `frontend/src/app/library/*`, `frontend/src/app/settings/*` | `TODO` | _Chưa có_ |
| `P1-QA-01` | `integration-qa` | Cross-Review Contract: Đối chiếu API JSON giữa `frontend/src/lib/api/client.ts` và `backend/app/api/*` theo `API_AND_UI_SPEC.md` | `tests/e2e/*` (chỉ đọc code các bên khác, không tự sửa đè) | `TODO` | _Chưa có_ |
| `P1-QA-02` | `integration-qa` | Chạy kiểm thử E2E Phase 1: Upload audio mẫu $\rightarrow$ Denoise $\rightarrow$ Analyze $\rightarrow$ Auto-Tune $\rightarrow$ Generate $\rightarrow$ Limiter Check $\rightarrow$ Export | `tests/e2e/test_phase1_e2e.py` | `TODO` | _Chưa có_ |

---

## 2. Nhật ký Phát hiện & Sửa Bug Chéo (Cross-Review Bug Tracker)

| Bug ID | Người phát hiện | Giao cho Agent sửa | File & Dòng lỗi | Mô tả Bug | Trạng thái | Xác nhận sửa lại |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| _Chưa có_ | — | — | — | — | — | — |
