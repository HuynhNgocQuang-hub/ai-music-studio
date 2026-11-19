# Báo cáo Xác minh & Kiểm lỗi Chéo — Phase 2 & 3 (DAW-lite & Full Song)
## Dự án: AI Music Studio (React 19 Vite + Java 21 Spring Boot + Python Audio Worker + Redis)

- **Ngày kiểm tra:** 2026-11-19
- **Người tổng hợp:** `p23-qa`
- **Tài liệu đối chiếu:** [SRS.md](./SRS.md) | [API_AND_UI_SPEC.md](./API_AND_UI_SPEC.md) | [TASK_BOARD.md](./TASK_BOARD.md) | [CROSS_REVIEW_REPORT.md](./CROSS_REVIEW_REPORT.md)
- **Commits đã merge trên `main`:**
  - Backend Phase 2 & 3 + `P23-BUG-03` fix: `53b4fdf`, `20b78f5` (`29f0dc7`)
  - Frontend Phase 2 & 3 + `P23-BUG-01`/`P23-BUG-02`/`P23-WARN-01` fix: `f2c76aa`, `d26f7f0` (`3d3bf2b`)
  - Audio-Worker `texture` empty-track fix (`P23-WARN-02`): `c5ea40a` (`aa324d9`)

---

## 1. Tóm tắt Kết quả Build & Test (Post-Merge Final Run)

| Hạng mục | Lệnh / Môi trường | Kết quả | Chi tiết quan sát |
| :--- | :--- | :--- | :--- |
| **Spring Boot Test Suite & JAR** | `cd backend && mvn package` (`mvn test`) | **PASS (`24/24`)** | `BUILD SUCCESS` (`56.560 s`): `AgentPipelineTests` (`11/11`), `ApiMockMvcTests` (`3/3`), `AudioAndLimiterTests` (`10/10`), `0` skipped. |
| **Frontend TypeScript & Vite Build** | `cd frontend && npx.cmd tsc --noEmit && npm.cmd run build` | **PASS (Exit `0`)** | `vite v6.4.6`, `2157 modules transformed`, `dist/index.html 0.63 kB`, `dist/assets/index-Cdp8w0oI.css 51.80 kB`, `dist/assets/index-OkrgwLjn.js 461.02 kB` (`built in 5.57s`). |
| **Docker Compose Config** | `docker compose config -q` | **PASS (Exit `0`)** | Cấu hình 3 services (`redis`, `audio-worker`, `backend`) hợp lệ. |
| **Live Spring Boot `:8000` E2E & Contract Parity** | `java -jar backend/target/ai-music-studio-backend-1.0.0.jar --server.port=8000` + Node.js v24 live HTTP harness (`tests/e2e/test_phase2_3_e2e.py` contracts) | **PASS (`8/8`)** | Toàn bộ 8 kịch bản live & static parity đều pass; tiến trình Spring Boot tạm thời (PID `11468`) đã được dừng gọn sau test. |
| **Docker / Python Runtime Status** | `docker info --format '{{.ServerVersion}}'` | **NOT RUNNING** *(Note)* | Docker Desktop daemon trên host đang tắt (`//./pipe/dockerDesktopLinuxEngine` unavailable) và host không cài sẵn Python, nên `pytest` cho `tests/e2e/test_phase2_3_e2e.py` và `audio-worker/tests/test_worker.py` chưa chạy trực tiếp trong container `audio-worker` ở phiên này; toàn bộ endpoint backend & Java fallback đã được kiểm chứng live trên `:8000`. |

---

## 2. Kết quả Chi tiết Live E2E & Contract Parity (Port `8000`)

| Test Case | Phạm vi SRS / API | Kết quả | Bằng chứng kiểm tra |
| :--- | :--- | :--- | :--- |
| `static_contract_parity_phase1_and_phase2_3` | `25/25` public routes, DTOs, Studio UI | **PASS (`12ms`)** | Khớp 100% route giữa `frontend/src/lib/api/client.ts` và `backend/.../controller/*.java` (bao gồm `/api/studio/auto-trim-vocal`, `/api/studio/auto-mix`, `/api/audio/clip-upload`); khớp `structure_preset`, `AutoTrimVocalResponse` (`trim_start_sec`, `trim_end_sec`, `trimmed_clips`), `JobRearrangeRequest` (`sections`, `total_bars`), `TimelineEditor.tsx`, `PianoRollEditor.tsx`, và `renderer.py` guard. |
| `phase1_health_and_validation_and_pipeline` | `GET /api/health`, `FR-INP`, `FR-ANA`, `FR-ATN` | **PASS (`2625ms`)** | `/api/health` trả `200 OK` (`java_fallback_available: true`, `redis.backend: "memory"`); reject `.txt` & audio `< 3s`; chạy `denoise`, `analyze`, và đủ 4 Auto-Tune presets (`off`, `natural`, `balanced`, `modern`). |
| `phase23_full_song_standard_bridge_vs_short` | `FR-HUM-05` (`structure_preset`) | **PASS (`1169ms`)** | `standard` sinh cấu trúc có `Bridge` (`>= 5` sections: `Intro -> Verse 1 -> Chorus -> Verse 2 -> Bridge -> Chorus -> Outro`); `short` sinh đúng `4` sections không có `Bridge`. Đọc ngay `GET /api/projects/{id}` sau SSE `completed` khớp 100%. |
| `phase23_auto_trim_vocal` | `POST /api/studio/auto-trim-vocal` (`FR-STU-06`) | **PASS (`427ms`)** | WAV có `0.8s` khoảng lặng đầu/cuối được trim chính xác (`trim_start_sec > 0.1`, `trim_end_sec > trim_start_sec`) trên `tracks.vocal.clips[0]`. |
| `phase23_auto_mix` | `POST /api/studio/auto-mix` (`FR-STU-12`) | **PASS (`502ms`)** | Đưa track volumes từ `1.2` / pan `0.9` về dải cân bằng `[0.0, 1.15]` / `[-0.5, 0.5]`, bật `mastering.auto_mix_enabled=true` và `limiter_ceiling_db=-1.0`. |
| `phase23_clip_upload_texture_and_multiclip_export` | `POST /api/audio/clip-upload`, `FR-STU-04`, `FR-STU-06`, `FR-STU-09` | **PASS (`1294ms`)** | Reject `.txt`; upload `.wav` tạo track `texture` (`type="audio"`), stream được qua `/api/audio/asset`; tách 2 vocal clips + 1 texture clip với `trim_*`/`fade_*`/`offset_ms`, export WAV giữ peak `<= -1.0 dBFS`, và export Stems `.zip` có stem `texture.wav` đồng độ dài (`< 0.05s` chênh lệch). |
| `phase23_piano_roll_update_and_midi_export` | `FR-STU-10`, `FR-STU-14` | **PASS (`478ms`)** | Cập nhật `tracks.lead.notes` (`pitch` `73`, `78`, `81`), sync lên backend, export `.mid` có `MThd` + `MTrk`, đủ Meta Events (`Tempo 0x51`, `Time Sig 0x58`, `Key Sig 0x59`) và chứa đủ 3 nốt vừa sửa. |
| `phase23_rearrange_sections_and_chords` | `POST /api/jobs/rearrange` (`FR-STU-11`) | **PASS (`605ms`)** | Cập nhật hợp âm bar 1 thành `Am` kèm `sections` + `total_bars` với `locked_tracks: ["drums"]`; SSE `completed` trả về hợp âm và bố cục mới. |

---

## 3. Nhật ký Cross-Review & Bug Đã Phát hiện / Sửa (`P23-BUG-01..03` & `P23-WARN-01..02`)

| ID | Mức độ | File & Dòng | Mô tả Lỗi / Cảnh báo | Trạng thái | Xác nhận sau Merge |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `P23-BUG-01` | `P1` | `frontend/src/pages/StudioPage.tsx:162-207`, `frontend/src/lib/audio/player.ts:261,713-760` | `audioSignature` chỉ hash `t!.notes.length` cho MIDI tracks; sửa `pitch`, `duration`, `velocity` hoặc `Quantize Track` trong `PianoRollEditor` không đổi `notes.length` nên Web Audio `engine.currentProject` phát nốt cũ bị stale. | `FIXED` (`d26f7f0` / `3d3bf2b`) | `audioSignature` đã fingerprint từng nốt (`pitch:start_beat:duration:velocity`) + `bpm` + `time_signature`; `tsc` + `vite build` exit `0`. |
| `P23-BUG-02` | `P2` | `frontend/src/types/project.ts:294-302` vs `backend/.../AutoTrimVocalResponse.java:17-27` | Frontend TS interface khai báo `trimmed_start_sec`/`trimmed_end_sec`, lệch với JSON backend `trim_start_sec`/`trim_end_sec`/`trimmed_clips`/`project_id`. | `FIXED` (`d26f7f0` / `3d3bf2b`) | Đã đồng bộ 1:1 trong `types/project.ts` & kiểm tra bởi `static_contract_parity`. |
| `P23-BUG-03` | `P1` | `backend/.../agents/AgentOrchestrator.java:244-274` | `runGenerate`/`runRegenerateTrack`/`runRearrange` phát SSE `"completed"` trước khi `launchJob` gọi `store.saveProject(updated)`, gây race condition khi client gọi `GET /api/projects/{id}` ngay lúc SSE xong (trả về `sections: []`). | `FIXED` (`20b78f5` / `29f0dc7`) | `launchJob` lưu `store.pushUndo` + `store.saveProject` trước khi phát SSE `"completed"`; `AgentPipelineTests` (`11/11`) & Live `:8000` (`8/8`) pass. |
| `P23-WARN-01` | `P2` | `frontend/src/components/studio/TimelineEditor.tsx:262-334`, `StudioPage.tsx:387-393`, `types/project.ts:242-248` | Thêm/sửa/xóa Section trên Timeline chưa gọi `onMarkChordsDirty()` / cập nhật `total_bars`, và `rearrangeChordsJob` chưa gửi `sections` + `total_bars`. | `FIXED` (`d26f7f0` / `3d3bf2b`) | Đã cập nhật `total_bars`, gọi `onMarkChordsDirty()`, và gửi `sections` + `total_bars` tới `/api/jobs/rearrange`. |
| `P23-WARN-02` | `P2` | `audio-worker/app/services/renderer.py:228-282,383-385` | `_render_audio_track` fallback về vocal audio khi `clips` rỗng cho mọi track `type == "audio"` (kể cả `texture` rỗng). | `FIXED` (`c5ea40a` / `aa324d9`) | Chỉ fallback vocal khi `track_name.lower() == "vocal"`; đã thêm `test_empty_non_vocal_audio_track_is_silent` trong `audio-worker/tests/test_worker.py` (chờ chạy lại khi Docker daemon bật). |

---

## 4. Artifact Bổ sung cho Phase 2 & 3

- Đã tạo bộ E2E & Contract Parity pytest tại [tests/e2e/test_phase2_3_e2e.py](../tests/e2e/test_phase2_3_e2e.py) (7 test cases bao phủ `standard` Bridge vs `short`, `auto-trim-vocal`, `auto-mix`, `clip-upload`, multi-clip WAV/Stems export, Piano Roll + `.mid` export, và static parity).
