# AI Music Studio (Hybrid Multi-Agent)

Hệ thống sáng tác, chỉnh cao độ (**Auto-Tune**) và phối khí âm nhạc (**Hum-to-Music**) sử dụng kiến trúc **Multi-Agent (Hybrid LLM + DSP)** kết hợp giữa **MIDI (Piano Roll)** và **Audio Clips (DAW-lite)**.

## Tài liệu Đặc tả & Kiến trúc

- [SRS.md](./docs/SRS.md) — Đặc tả yêu cầu chức năng (`FR-INP`, `FR-ANA`, `FR-AUTOTUNE`, `FR-HUM`, `FR-LYRIC`, `FR-STUDIO`), ràng buộc và tiêu chí nghiệm thu.
- [MULTI_AGENT_ARCHITECTURE.md](./docs/MULTI_AGENT_ARCHITECTURE.md) — Kiến trúc 6 Agent (Orchestrator, Denoise/Analyzer, Auto-Tune DSP, Composer, Arranger, Lyricist/Coach, Producer/QA & Mastering), `Shared Project State`, Dual LLM (**Gemini + OpenAI**) và lưu trữ nhẹ đĩa (`IndexedDB` + `Redis`).
- [API_AND_UI_SPEC.md](./docs/API_AND_UI_SPEC.md) — Kiến trúc điều hướng (`/create`, `/studio/[id]`, `/library` phân trang, `/settings`), API Contract (`FastAPI` + SSE) và cấu trúc file `.aimusic`.
- [PHASE1_TEAM_PLAN.md](./docs/PHASE1_TEAM_PLAN.md) — Kế hoạch phân chia vai trò cho đội ngũ Multi-Agent thực hiện Phase 1 (MVP).

## Kiến trúc Hạ tầng Dự kiến
- **Frontend:** Next.js + TypeScript + Web Audio API + `IndexedDB` (Node.js v24)
- **Backend & Cache:** Python FastAPI + Audio DSP (`FFmpeg`, `FluidSynth`, `pedalboard`) + `redis:7-alpine` (Docker Compose)
- **LLM Providers:** Google Gemini API + OpenAI API (qua Adapter thống nhất)
