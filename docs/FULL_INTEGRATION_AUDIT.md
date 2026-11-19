# Báo cáo Kiểm thử Tích hợp Toàn diện & Đối chiếu SRS (`FULL_INTEGRATION_AUDIT`)
## Dự án: AI Music Studio — Full Integration Audit (Phase 1 + Phase 2 + Phase 3)

- **Ngày kiểm tra:** 2026-11-19 (Đã cập nhật kết quả xác minh Post-Fix bởi `polish-qa`)
- **Người tổng hợp:** `audit-runner` + `audit-srs-fe-be` (`#72`) | **Post-Fix Verification:** `polish-qa` (trên `main` sau khi merge `polish-worker` `cfead24`, `polish-backend` `edde8e2` / `427db1e`, `polish-frontend` `22e7bb8` / `adc6e23`)
- **Tài liệu đối chiếu:** [SRS.md](./SRS.md) | [API_AND_UI_SPEC.md](./API_AND_UI_SPEC.md) | [CROSS_REVIEW_REPORT.md](./CROSS_REVIEW_REPORT.md) | [PHASE2_3_REPORT.md](./PHASE2_3_REPORT.md) | [TASK_BOARD.md](./TASK_BOARD.md)

---

## 1. Tóm tắt Môi trường Thực thi & Trạng thái Docker

| Thành phần | Lệnh / Trạng thái Quan sát | Ghi chú |
| :--- | :--- | :--- |
| **Docker Daemon (`docker info`)** | **NOT RUNNING** (`Command exited with code 1`: `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.`) | Docker Desktop đang tắt trên host Windows, do đó không khởi chạy được container `redis`, `audio-worker`, và không chạy được `pytest` trong container (`test_worker.py`, `test_phase1_e2e.py`, `test_phase2_3_e2e.py`). |
| **Host Python** | **NOT INSTALLED** (`Python was not found` — Microsoft Store alias) | Không thể chạy trực tiếp `pytest` trên host; đã thay thế bằng kịch bản kiểm thử Node.js toàn diện chạy qua **Vite dev proxy (`http://localhost:3000/api/*` -> Spring Boot `:8000`)**. |
| **Docker Compose Config** | `docker compose config -q` -> **PASS (Exit `0`)** | Cấu hình 3 services (`redis`, `audio-worker`, `backend`) hợp lệ. |
| **Port Cleanup (`:8000`, `:3000`)** | **CLEAN** | Tiến trình Spring Boot (`:8000`) và Vite (`:3000`) tạm thời đã được dừng gọn trong khối `finally`; `Get-NetTCPConnection -LocalPort 8000,3000 -State Listen` trả về `0` tiến trình lắng nghe sau khi test xong. |

---

## 2. Kết quả Build & Unit Test (Post-Fix trên `main`)

| Hạng mục | Lệnh Thực thi | Kết quả | Chi tiết Quan sát |
| :--- | :--- | :--- | :--- |
| **Spring Boot Test Suite** | `cd backend && mvn test` | **PASS (`31/31`)** | `BUILD SUCCESS` (`53.236 s`): `AgentPipelineTests` (`12/12`), `ApiMockMvcTests` (`6/6`), `AudioAndLimiterTests` (`13/13`), `0` failures, `0` errors, `0` skipped. |
| **Frontend TypeScript & Vite Build** | `cd frontend && npx.cmd tsc --noEmit && npm.cmd run build` | **PASS (Exit `0`)** | `TSC_EXIT=0`; `vite v6.4.6`, `2157 modules transformed`, `dist/index.html 0.63 kB`, `dist/assets/index-lHDujC4Z.css 52.47 kB`, `dist/assets/index-Dq9RAxI6.js 471.70 kB` (`built in 5.44s`, `BUILD_EXIT=0`). |
| **Docker Compose Validation** | `docker compose config -q` | **PASS (Exit `0`)** | Exit `0`. |
| **`audio-worker` Pytest (Docker)** | `pytest -v tests/test_worker.py` (chờ Docker) | **DEFERRED (Docker Off)** | Docker Desktop daemon tắt (`DOCKER_INFO_EXIT=1`) và host không có Python; `audio-worker/tests/test_worker.py` hiện có **13 unit tests** (9 baseline + 4 test mới trong `cfead24` cho `AUDIT-BUG-02`, `WARN-04`, `WARN-07`) chờ chạy khi Docker bật. |

---

## 3. Kết quả Live Integration qua Vite Proxy (`http://localhost:3000/api/*` $\rightarrow$ Spring Boot `:8000`) — Post-Fix Verification

Chạy lại đầy đủ **9 nhóm kịch bản E2E** đi xuyên qua Vite proxy (`/api` $\rightarrow$ `http://localhost:8000`, `frontend/vite.config.ts`) với Spring Boot Java 21 (`ai-music-studio-backend-1.0.0.jar` build từ `main` sau merge) chạy ở chế độ In-Memory TTL fallback + Java DSP fallback: **`9/9 PASS` (Exit `0`)**, ports `:8000` và `:3000` được dọn sạch (`PORTS_8000_3000_CLEAN`).

| # | Kịch bản Kiểm thử (qua Vite `:3000`) | Kết quả | Chi tiết Quan sát Thực tế |
| :--- | :--- | :--- | :--- |
| `01` | **Vite SPA `/` + `/api/health` (`WARN-08`) + Header Override + Cache Clear** | **PASS (`556ms`)** | `GET /` trả HTML `200 OK` (`<div id="root">`); `GET /api/health` với `X-LLM-Provider: mock` & `X-Agent-Providers` trả `status="ok"`, `redis.backend="memory"`, **`redis.connected=false`** (`WARN-08` fixed), `engines.audio_worker_available=false`, `engines.java_fallback_available=true`, `llm_providers.default="mock"`, `llm_providers.agent_providers.composer="mock"`; `POST /api/settings/cache/clear` trả `200 OK`. |
| `02` | **Upload Validation (`POST /api/audio/upload` + `mode='vocal'` `WARN-03`)** | **PASS (`1169ms`)** | Từ chối `.txt` (`400`), WAV `1.2s` `< 3s` (`400`), file `51 MB` `> 50MB` (`413`), `mode="hum"` `62s` (`400`), và **chấp nhận `mode="vocal"` `62s` (`200`)** (`WARN-03` fixed). |
| `03` | **Denoise, Analyze (`WARN-02`), Auto-Tune Presets + Pro + `AUDIT-BUG-02`** | **PASS (`3243ms`)** | Upload WAV (`200`), `/api/audio/asset` (`200`), `denoise` (`200`), `analyze` (`200`); khóa `bpm=138` (`bpm_locked=true`) & `F# minor` (`key_locked=true`) giữ nguyên sau re-analyze không override (`WARN-02`); `autotune` `natural`/`balanced`/`modern` (`enabled=true`) -> chuyển `enabled=false` xóa `tuned_vocal_ref=null` và `/api/audio/preview?mode=autotune` trùng hash với `mode=dry` (kể cả khi cố tình inject `tuned_vocal_ref` cũ qua `/sync`, `AUDIT-BUG-02` fixed); Pro mode `D pentatonic_minor` OK. |
| `04` | **Multi-Overdub `clip-upload` (`AUDIT-BUG-01`), `texture` & `auto-trim-vocal`** | **PASS (`162ms`)** | Từ chối `.txt` (`400`); upload `texture` (`mem://clips/...`) + upload **2 overdub liên tiếp trên `vocal`** (`clip_vocal_b5a4e9d0`, `clip_vocal_a95ee544`) đều giữ nguyên trong `tracks.vocal.clips` (`>= 3` clips) và stream `200 OK` qua `/api/audio/asset` (`AUDIT-BUG-01` fixed); `auto-trim-vocal` không ghi đè thông số trim của clip overdub uncached (`idb://overdub/...`). |
| `05` | **Generate Jobs (`standard`/`short`, `WARN-04` `enable_lead_karaoke=false`, `cancel`) & 7 Preview Modes** | **PASS (`12891ms`)** | SSE `text/event-stream` tới `completed`: `enhance+full_song` (`standard`) sinh đủ `Bridge` + `lead`; **`enable_lead_karaoke=false` (`short`) bỏ qua `lead` notes** (`WARN-04` fixed) và sinh `Intro->Verse 1->Chorus->Outro`; 7 preview modes (`raw`, `dry`, `dry_beat`, `autotune`, `preserve`, `enhance`, `ai_mix`) đều `200 OK`, peak `<= -1.0 dBFS`, **7/7 SHA-256 hash khác nhau**; `POST /api/jobs/{id}/cancel` trả `{"status":"cancelled"}`. |
| `06` | **`regenerate-track`, `rearrange`, `auto-mix` & `overdub-fit-check`** | **PASS (`454ms`)** | `regenerate-track` (`bass`, `synth_bass`) giữ nguyên notes của `drums` đang khóa `lock=true`; `POST /api/jobs/rearrange` cập nhật `total_bars=6`, `chords[0].symbol="Am"`; `auto-mix` đặt `mastering.auto_mix_enabled=true`, `limiter_ceiling_db=-1.0`, clamp volume `[0, 1.15]` & pan `[-0.5, 0.5]`; `overdub-fit-check` multipart trả `timing_offset_ms=-84.7` & `one_click_fixes` (`3` fixes). |
| `07` | **Lyrics Suggest & AI Coach Chat (`WARN-01` `suggested_actions`)** | **PASS (`29ms`)** | `POST /api/lyrics/suggest` (`vi`) trả `200 OK` (`1` line); `POST /api/coach/chat` (`X-LLM-Provider: mock`) trả `200 OK` kèm **`suggested_actions` (`2` actions)**. |
| `08` | **Projects Sync/Pagination/Undo, Export (`WAV`/Stems/MIDI `PROGRAM_CHANGE`/`.aimusic`) & Import** | **PASS (`1926ms`)** | Export MIDI (`POST /api/projects/{id}/export/midi`) chứa đủ Meta Events (`0x51`/`0x58`/`0x59`), 3 nốt Piano Roll (`73, 78, 81`), và **`5` `PROGRAM_CHANGE` events** (`WARN-04` fixed); `undo` khôi phục đúng `bpm`; Export WAV peak **`-3.18 dBFS`** (`<= -1.0 dBFS`); Export Stems (`format="stems"`) ZIP chứa 6 file đồng độ dài (`stems/{vocal,drums,bass,harmony,lead,texture}.wav`); Export `.aimusic` (`1,149,904 B`) + Import `.aimusic` giữ nguyên `texture` và multi-overdub `vocal` clips; All-muted `400`; MP3 `503` (Docker/host `ffmpeg` off); Pagination `page=1` (`12` items, `total=16`), `page=2` (`>= 2`). |
| `09` | **Static Source Parity (`AUDIT-BUG-03` & `WARN-01..07`)** | **PASS (`6ms`)** | Xác nhận `ProjectProvider.tsx` cập nhật đồng bộ `latestProjectRef.current` + hỗ trợ `overrideState`; `StudioPage.tsx` có `handleApplyCoachAction` & `'chromatic'`; `CreatePage.tsx` có `bpm_locked`/`key_locked`, `enumerateDevices`, `onDrop`, `'chromatic'`; `PianoRollEditor.tsx` có `'chromatic'`; `renderer.py` có `autotune_settings.enabled`, 35 `INSTRUMENT_PROGRAMS`, `_resample_mono`; `exporter.py` map sharp/enharmonic keys (`Eb`, `Bb`). |

---

## 4. Ma trận Truy vết SRS (`docs/SRS.md`) — Tổng hợp từ `@audit-srs-fe-be` (`#72`)

| Mã SRS | Yêu cầu Chức năng | Trạng thái | Vị trí Code Chính & Ghi chú Audit |
| :--- | :--- | :--- | :--- |
| `FR-INP-01` | Ghi âm trực tiếp (Mic) | **WARN** | `CreatePage.tsx:304-383, 747-804` — Thu âm, Count-in Metronome, VU meter, nghe lại hoạt động; thiếu chọn thiết bị mic, Pause/Resume và waveform canvas. |
| `FR-INP-02` | Tải file lên & Validation | **WARN** | `client.ts:181-190`, `AudioController.java:89-120`, `denoise.py:108-180` — Chặn đúng định dạng/size/thời lượng; thiếu `onDrop` drag-and-drop và toggle `mode='vocal'` (mặc định giới hạn 60s). File non-WAV trả `400` nếu Docker `audio-worker` tắt. |
| `FR-INP-03` | AI Denoise & Dry Check | **PASS** | `denoise.py:183-222`, `JavaAudioFallbackService.java:306-409`, `CreatePage.tsx:859-906`. |
| `FR-INP-04` | Chuẩn hóa & Trim đầu vào | **PASS** | `denoise.py:231-250`, `AudioController.java:113-120`, `StudioController.java:119-177`. |
| `FR-ANA-01` | Phát hiện Cao độ $\rightarrow$ MIDI | **PASS** | `analyzer.py:142-295`, `JavaAudioFallbackService.java:518-646`. |
| `FR-ANA-02` | Phát hiện Tempo & Time Sig | **PASS** | `analyzer.py:173-215, 365`, `CreatePage.tsx:455-481`. |
| `FR-ANA-03` | Phát hiện Key/Scale & Khóa | **WARN** | `analyzer.py:297-334`, `AudioController.java:318-323`, `CreatePage.tsx:951-1016` — Sửa tay BPM/Key ở Step 2 chưa set `bpm_locked`/`key_locked` nên quay lại Step 1 rồi vào Step 2 bị phân tích lại ghi đè. |
| `FR-ATN-01` | Bật/Tắt Auto-Tune & So sánh A/B | **BUG** | Xem **`AUDIT-BUG-02`**: tắt Auto-Tune về `'off'` ở `CreatePage.tsx:498-501` không xóa `tuned_vocal_ref`, khiến preview Step 4 và export vẫn dùng bản đã Auto-Tune. |
| `FR-ATN-02` | 4 Quick Presets | **PASS** | `CreatePage.tsx:63-75, 1068-1091`, `autotune.py:16-21` (đã xác nhận live 4 presets). |
| `FR-ATN-03` | Pro Controls & Formant | **WARN** | `StudioPage.tsx:1268-1432`, `autotune.py:56-105`, `JavaAudioFallbackService.java:774-820` — Scale `chromatic` có ở BE nhưng thiếu trong dropdown FE; OLA giữ duration/`t=0` nhưng chưa có formant-preserving PSOLA/LPC. |
| `FR-ATN-04` | Auto-Follow Project Key | **PASS** | `StudioPage.tsx:883-891`, `AudioController.java:378-383` (cập nhật key trên UI; cần bấm Apply để re-render WAV). |
| `FR-HUM-01` | Preserve Original Melody | **PASS** | `ComposerAgent.java:75-77`, `QaReviewerAgent.java:138-159`. |
| `FR-HUM-02` | AI Enhance Melody | **PASS** | `ComposerAgent.java:190-260`. |
| `FR-HUM-03` | Preview đối chiếu | **PASS** | `CreatePage.tsx:1460-1484` (lưu ý `WARN-07` khác biệt xử lý `lead` giữa `JavaAudioFallbackService` và `renderer.py`). |
| `FR-HUM-04` | Accompaniment Only | **PASS** | `ComposerAgent.java:127-131`. |
| `FR-HUM-05` | Full Song (`short`/`standard` + `Bridge`) | **PASS** | `ComposerAgent.java:90-126, 280-282`, `ArrangerAgent.java:278-455`, `QaReviewerAgent.java:162-190` (xác nhận live `standard` có `Bridge`; `WARN-04`: flag `enable_lead_karaoke` chưa điều khiển bỏ qua `lead`). |
| `FR-HUM-06` | Style & Prompt ($\le 500$ ký tự, lọc bản quyền) | **PASS** | `CreatePage.tsx:1344`, `MusicTheory.java:67-80`. |
| `FR-LYR-01` | AI Gợi ý Lời | **PASS** | `CoachLyricistAgent.java:29-121`. |
| `FR-LYR-02` | Lyric Pad + Karaoke Sync | **PASS** | `StudioPage.tsx:808-820, 1436-1552`. |
| `FR-LYR-03` | AI Music Coach | **WARN** | `CoachLyricistAgent.java:123-173`, `StudioPage.tsx:1606-1618` — BE trả `suggested_actions` nhưng FE chưa render nút xác nhận áp dụng nhanh (`WARN-01`). |
| `FR-STU-01..03` | Quick Preview / Quick Export | **WARN** | `StudioPage.tsx:777-798` — Play/Pause, Loop, Seek, Export MP3/WAV đủ; trong Studio chưa có nút đổi Genre/Mood hoặc Regenerate toàn bài trực tiếp (phải qua Create). |
| `FR-STU-04..05` | Hybrid Tracks & Mixer (M/S/Vol/Pan/Lock) | **PASS** | `TimelineEditor.tsx:877-966`, `StudioPage.tsx:1152-1214`. |
| `FR-STU-06` | Clip Edit & AI Auto-Trim | **WARN** | `TimelineEditor.tsx:145-248, 555-715, 979-1005`, `StudioController.java:119-177` (xem `WARN-06` về undo kép khi split lần đầu & xóa hết clip). |
| `FR-STU-07` | Vocal Overdub + AI Fit Check | **BUG** | Xem **`AUDIT-BUG-01`**: overdub lưu cục bộ trong `IndexedDB` (`idb://overdub/...`), không upload lên `/api/audio/clip-upload`, bị mất/nhầm khi export backend. |
| `FR-STU-08` | Per-Track AI Regeneration | **PASS** | `JobsController.java:53-67`, `ArrangerAgent.java:92-93, 141-189` (lưu ý `WARN-04`: một số instrument ID chưa có trong `renderer.py:20-29`). |
| `FR-STU-09` | Xuất Stems ZIP đồng độ dài | **PASS** | `exporter.py:100-112`, `JavaAudioFallbackService.java:1261-1277` (đã xác nhận live 6 stems gồm `texture.wav`). |
| `FR-STU-10` | Piano Roll & MIDI Editor | **PASS** | `PianoRollEditor.tsx:1-483`, `player.ts:713-789` (add/edit/delete, pitch +/-1, Quantize 1/4-1/8-1/16, audition, C1–C7 scale highlight). |
| `FR-STU-11` | Chord/Section Timeline & Rearrange | **PASS** | `TimelineEditor.tsx:262-356, 773-867`, `AgentOrchestrator.java:613-741`. |
| `FR-STU-12` | Auto-Mix & Master Limiter ($\le -1.0$ dBFS) | **PASS** | `StudioController.java:179-201`, `exporter.py:41-79`, `JavaAudioFallbackService.java:835-876, 1669-1765`, `player.ts:105-110` (live WAV peak `-2.96 dBFS`). |
| `FR-STU-13` | `.aimusic` Export/Import & Auto-Restore | **PASS** | `JavaAudioFallbackService.java:1389-1515`, `indexeddb.ts:11-194`, `AppShell.tsx:242-274` (`WARN-06`: reopen Studio chưa khôi phục `raw_input` từ IndexedDB nếu cache backend hết hạn). |
| `FR-STU-14` | MIDI Export (`.mid` + Meta Events) | **PASS** | `JavaAudioFallbackService.java:1299-1387`, `exporter.py:115-184` (`WARN-07`: sharp keys `D#`/`G#`/`A#` trong `exporter.py`). |
| `NFRs` | Dual LLM, 2-Tier Save, `<10ms` Sync, Limiter, 60s Timeout/Cancel | **PASS** | Header override, 7s IndexedDB + Redis TTL, Web Audio sync, Limiter, Cancel/QA đều hoạt động (`WARN-08`: `ProjectStateStore` trả `connected=true` cả khi `backend="memory"`). |

---

## 5. Danh sách Bug & Cảnh báo Đã Xử lý (`AUDIT-BUG-01..03` FIXED, `WARN-01..08` RESOLVED)

### Bug Đã Sửa & Xác nhận Post-Fix (`FIXED`)

| ID | Mức độ | Trạng thái | Vị trí (`file:line`) | Tóm tắt Fix & Bằng chứng Xác nhận (`polish-qa`) |
| :--- | :--- | :--- | :--- | :--- |
| `AUDIT-BUG-01` | `P1` | **`FIXED`** | `StudioPage.tsx`, `indexeddb.ts`, `player.ts`, `TimelineEditor.tsx`, `StudioController.java:155,215` | Overdub upload trực tiếp qua `POST /api/audio/clip-upload` (`track_id='vocal'`) tạo `mem://clips/...` riêng + backup IndexedDB theo từng `clip.source`; `autoTrimVocal` bỏ qua custom/overdub uncached refs. Live proxy test `04` & `08` xác nhận 2 overdub liên tiếp giữ nguyên và export `.aimusic`/import bảo toàn đủ clips. |
| `AUDIT-BUG-02` | `P1` | **`FIXED`** | `CreatePage.tsx`, `player.ts`, `AudioController.java:449-462`, `JavaAudioFallbackService.java:1122`, `renderer.py` | Chọn `'off'` gọi `/api/audio/autotune` (`enabled=false`, xóa `tuned_vocal_ref`); cả `player.ts`, `JavaAudioFallbackService`, `StudioController`, và `renderer.py` đều bỏ qua `tuned_vocal_ref` khi `autotune_settings.enabled=false`. Live proxy test `03` xác nhận preview `autotune` khi `enabled=false` (kể cả còn stale ref) khớp 100% `mode=dry`. |
| `AUDIT-BUG-03` | `P2` | **`FIXED`** | `ProjectProvider.tsx:42-43,102-127`, `StudioPage.tsx` | `updateProject` & `setProject` cập nhật đồng bộ `latestProjectRef.current`; `saveNow(syncToBackend, overrideState?)` nhận `overrideState` truyền thẳng từ `mutateWithUndo`. Xác nhận qua static check `09` + `tsc`/`vite build` exit `0`. |

### Cảnh báo & Khoảng hở SRS (`WARN-01..08`)

- **`WARN-01` (`FR-LYR-03`) — `FIXED`:** `StudioPage.tsx` render nút áp dụng cho `CoachMessage.suggested_actions` (`handleApplyCoachAction`); Live test `07` xác nhận `suggested_actions` (`2` actions).
- **`WARN-02` (`FR-ANA-03`) — `FIXED`:** Sửa tay BPM/Key/Scale ở Step 2 bật `bpm_locked` / `key_locked`; `AudioController.analyzeProjectAudio` bảo toàn `138 BPM` & `F# minor` khi re-analyze không override (Live test `03`).
- **`WARN-03` (`FR-INP-01/02`) — `FIXED` (trừ waveform canvas/ffmpeg non-WAV khi Docker off):** Thêm chọn mic (`enumerateDevices`), Pause/Resume ghi âm, drag-drop `onDrop`, và `mode: 'hum' | 'vocal'` (`<= 5 min`). Live test `02` xác nhận `vocal 62s` `200 OK` vs `hum 62s` `400`.
- **`WARN-04` (`FR-HUM-05` / `FR-STU-08`) — `FIXED`:** `enable_lead_karaoke=false` bỏ qua `lead` track notes (Live test `05`); `JavaAudioFallbackService.exportMidi` ghi `ShortMessage.PROGRAM_CHANGE` (`5` events trong Live test `08`); `renderer.py` mở rộng `INSTRUMENT_PROGRAMS` lên 35 GM mappings (`cfead24`).
- **`WARN-05` (`FR-ATN-03/04` / `FR-STU-10`) — `FIXED (UI/Scale)`:** Đã thêm `'chromatic'` vào dropdown Scale ở `CreatePage.tsx`, `StudioPage.tsx`, `PianoRollEditor.tsx` (ghi chú còn lại: DSP pitch-shift vẫn dùng OLA thay vì PSOLA/LPC).
- **`WARN-06` (`FR-STU-06` / `FR-STU-13`) — `FIXED`:** Bỏ duplicate undo frame khi split vocal trong `TimelineEditor.tsx`; Studio reopen khôi phục `'raw_input'` và custom clip blobs từ IndexedDB.
- **`WARN-07` (`FR-STU-14` / `FR-HUM-03` / `audio-worker`) — `FIXED (Code + Unit Tests)`:** `exporter.py` map sharp/enharmonic keys (`Eb`, `Ab`, `Bb`, `C#m`, `F#m`); `renderer.py` bỏ qua missing custom clip ref, resample `_resample_mono`, mute `lead` ở `preserve` (`mode_gain=0.0`). Chờ chạy `pytest` trong container khi Docker Desktop bật.
- **`WARN-08` (`NFR` Health Status) — `FIXED`:** `ProjectStateStore.ping()` trả `connected: false` khi `backend: "memory"` (xác nhận Live test `01`), kích hoạt đúng banner Redis fallback trên `SettingsPage.tsx`.
