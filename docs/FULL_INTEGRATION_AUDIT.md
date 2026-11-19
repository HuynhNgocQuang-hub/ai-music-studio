# Báo cáo Kiểm thử Tích hợp Toàn diện & Đối chiếu SRS (`FULL_INTEGRATION_AUDIT`)
## Dự án: AI Music Studio — Full Integration Audit (Phase 1 + Phase 2 + Phase 3)

- **Ngày kiểm tra:** 2026-11-19
- **Người tổng hợp:** `audit-runner` (Live Proxy Integration Runner & Report Author) + `audit-srs-fe-be` (Read-Only SRS & Cross-Layer Auditor, board `#72`)
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

## 2. Kết quả Build & Unit Test (Phiên Audit Hiện tại)

| Hạng mục | Lệnh Thực thi | Kết quả | Chi tiết Quan sát |
| :--- | :--- | :--- | :--- |
| **Spring Boot Test Suite** | `cd backend && mvn test` | **PASS (`24/24`)** | `BUILD SUCCESS` (`48.921 s`): `AgentPipelineTests` (`11/11`), `ApiMockMvcTests` (`3/3`), `AudioAndLimiterTests` (`10/10`), `0` failures, `0` errors, `0` skipped. |
| **Frontend TypeScript & Vite Build** | `cd frontend && npx.cmd tsc --noEmit && npm.cmd run build` | **PASS (Exit `0`)** | `tsc_exit=0`; `vite v6.4.6`, `2157 modules transformed`, `dist/index.html 0.63 kB`, `dist/assets/index-Cdp8w0oI.css 51.80 kB`, `dist/assets/index-OkrgwLjn.js 461.02 kB` (`built in 5.85s`). |
| **Docker Compose Validation** | `docker compose config -q` | **PASS (Exit `0`)** | Exit `0`. |
| **`audio-worker` Pytest (Docker)** | `pytest -v tests/test_worker.py` (chờ Docker) | **DEFERRED (Docker Off)** | Phiên Phase 1 trước đó đạt `8/8` (`CROSS_REVIEW_REPORT.md`); unit test mới `test_empty_non_vocal_audio_track_is_silent` (`P23-WRK-01`) cần chạy lại khi Docker Desktop được bật. |

---

## 3. Kết quả Live Integration qua Vite Proxy (`http://localhost:3000/api/*` $\rightarrow$ Spring Boot `:8000`)

Chạy đầy đủ **9 nhóm kịch bản E2E** đi xuyên qua Vite proxy (`/api` $\rightarrow$ `http://localhost:8000`, `frontend/vite.config.ts`) với Spring Boot Java 21 (`ai-music-studio-backend-1.0.0.jar`) chạy ở chế độ In-Memory TTL fallback + Java DSP fallback: **9/9 PASS (`AUDIT_EXIT=0`)**.

| # | Kịch bản Kiểm thử (qua Vite `:3000`) | Kết quả | Chi tiết Quan sát Thực tế |
| :--- | :--- | :--- | :--- |
| `01` | **Vite SPA `/` + `/api/health` + Header Override + Cache Clear** | **PASS (`1086ms`)** | `GET /` trả HTML `200 OK`; `GET /api/health` với `X-LLM-Provider: mock` & `X-Agent-Providers` trả `status="ok"`, `redis.backend="memory"`, `engines.audio_worker_available=false`, `engines.java_fallback_available=true`, `llm_providers.default="mock"`, `llm_providers.agent_providers.composer="mock"`; `POST /api/settings/cache/clear` trả `200 OK`. |
| `02` | **Upload Validation (`POST /api/audio/upload`)** | **PASS (`724ms`)** | Từ chối file `.txt` (`400`), WAV `1.2s` `< 3s` (`400`), và file `51 MB` `> 50MB` (`413`). |
| `03` | **Denoise, Analyze & Auto-Tune (4 Presets + Pro)** | **PASS (`2486ms`)** | Upload WAV `4.0s` (`200`), fetch `/api/audio/asset` (`200`), `denoise` (`200`), `analyze` (`bpm=200`, `key="C"`, `scale="major"`, `raw_melody_midi` hợp lệ); chạy đủ 4 presets (`off`, `natural`, `balanced`, `modern`) + Pro (`preset="off"`, `enabled=true`, `key="D"`, `scale="pentatonic_minor"`, `auto_follow_project_key=false`) giữ nguyên `D pentatonic_minor`. |
| `04` | **Clip Upload (`POST /api/audio/clip-upload` trên `texture`)** | **PASS (`64ms`)** | Từ chối `.txt` (`400`); upload WAV `2.0s` tạo `tracks.texture` (`type="audio"`) với clip `mem://clips/...` stream được qua `/api/audio/asset` (`200`). |
| `05` | **Generate Jobs (`preserve+accompaniment`, `enhance+full_song standard/short`) & 7 Preview Modes** | **PASS (`2338ms`)** | SSE `text/event-stream` hoàn tất tới `completed`: `preserve+accompaniment` sinh đủ MIDI tracks; `enhance+full_song` (`structure_preset="standard"`) sinh `Intro->Verse 1->Chorus->Verse 2->Bridge->Chorus->Outro` (có **Bridge**); `short` sinh đúng `Intro->Verse 1->Chorus->Outro`; 7 preview modes (`raw`, `dry`, `dry_beat`, `autotune`, `preserve`, `enhance`, `ai_mix`) đều `200 OK`, peak `<= -1.0 dBFS`, **7/7 SHA-256 hash khác nhau**. |
| `06` | **`regenerate-track`, `rearrange` Sections/Chords & `cancel`** | **PASS (`141ms`)** | `regenerate-track` (`target_track="bass"`, `instrument="synth_bass"`) giữ nguyên `drums` đang khóa `lock=true`; `rearrange` cập nhật custom `sections`, `total_bars=6`, `chords[0].symbol="Am"`; `POST /api/jobs/{id}/cancel` trả `{"status":"cancelled"}`. *(Lưu ý schema: `SongSection.energy` là số `double` và `ChordEvent` dùng field `symbol`, không phải string `energy` hay `chord`.)* |
| `07` | **Studio `auto-trim-vocal`, `auto-mix` & `overdub-fit-check`** | **PASS (`657ms`)** | `auto-trim-vocal` trên WAV có `0.8s` im lặng đầu/cuối cắt về `0.78s..4.02s`; `auto-mix` kéo toàn bộ volume từ `1.2` về `[0.0, 1.15]`, pan từ `0.9` về `[-0.5, 0.5]`, bật `auto_mix_enabled=true` & `limiter_ceiling_db=-1.0`; `overdub-fit-check` trả `timing_offset_ms=0.1` & `one_click_fixes`. |
| `08` | **Lyrics Suggest & AI Coach Chat** | **PASS (`48ms`)** | `POST /api/lyrics/suggest` (`vi`) và `POST /api/coach/chat` với `X-LLM-Provider: mock` đều `200 OK`. |
| `09` | **Projects Sync, Pagination, Undo, Export (WAV/Stems/MIDI/`.aimusic`) & Import** | **PASS (`1520ms`)** | Sync 14 project + phân trang `page=1/2, limit=12` chính xác; `POST /api/projects/{id}/undo` khôi phục đúng `bpm` trước sửa; Export WAV đạt peak **`-2.96 dBFS`** (`<= -1.0 dBFS`); Export Stems ZIP có 6 file đồng độ dài (`vocal.wav`, `drums.wav`, `bass.wav`, `harmony.wav`, `lead.wav`, `texture.wav`); Export MIDI 6 tracks có đủ Meta Events (`0x51` Tempo, `0x58` TimeSig, `0x59` KeySig) và giữ nguyên 3 nốt Piano Roll đã sửa (`73, 78, 81`); Export `.aimusic` (`998,811 B`) + Import `.aimusic` giữ nguyên `tracks.texture.clips`; All-muted export bị chặn `400`; MP3 export trả `503` khi Docker `audio-worker` tắt và host không có `ffmpeg` (đúng hành vi mong đợi khi thiếu `ffmpeg`). |

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

## 5. Danh sách Bug & Cảnh báo Mở Cần Theo dõi (`AUDIT-BUG-01..03`, `WARN-01..08`)

### Bug Mới Phát hiện qua Audit Toàn diện (`BUG`)

| ID | Mức độ | Vị trí (`file:line`) | Mô tả Bug & Tác động | Hướng Sửa Đề xuất |
| :--- | :--- | :--- | :--- | :--- |
| `AUDIT-BUG-01` | `P1` | `frontend/src/pages/StudioPage.tsx:447-459`, `indexeddb.ts:224`, `JavaAudioFallbackService.java:1157`, `audio-worker/app/services/renderer.py:263-271`, `StudioController.java:153-165` | **Overdub clips chỉ lưu cục bộ (`idb://overdub/...`) trong 1 slot duy nhất:** Overdub thứ 2 ghi đè overdub thứ 1 trong IndexedDB & `player.ts`; chưa upload qua `POST /api/audio/clip-upload`. Khi export WAV/MP3/Stems/`.aimusic`, `JavaAudioFallbackService` bỏ qua `idb://...` (mất tiếng overdub), còn `renderer.py` fallback về `_vocal_ref_candidates` (phát lặp giọng hum gốc thay cho overdub), và `autoTrimVocal` ghi đè thông số clip overdub bằng phân tích giọng chính. | Upload ngay `wavBlob` qua `uploadTrackClip(projectId, wavBlob, 'vocal')` sau `encodeBlobToWav` (dùng `mem://clips/...` thay cho `idb://overdub/...`), đồng thời tải từng clip `mem://clips/...` vào `MultiTrackAudioEngine` theo `clip.id` hoặc `clip.source`. |
| `AUDIT-BUG-02` | `P1` | `frontend/src/pages/CreatePage.tsx:498-501`, `JavaAudioFallbackService.java:1127`, `audio-worker/app/services/renderer.py:225`, `frontend/src/lib/audio/player.ts:688-691` | **Tắt Auto-Tune về `Off` trên `CreatePage` không xóa/vô hiệu hóa `tuned_vocal_ref`:** Nếu người dùng bật `Natural`/`Balanced`/`Modern` rồi chuyển lại `Off`, FE `return` sớm mà không gọi `/api/audio/autotune` (`enabled=false`) hoặc xóa `tuned_vocal_ref`. Do cả `JavaAudioFallbackService`, `renderer.py` và `player.ts` đều ưu tiên `tuned_vocal_ref` khi khác null mà không kiểm tra `autotune_settings.enabled`, bản nghe thử `Preserve`/`Enhance` và Export vẫn phát giọng đã Auto-Tune. | Gọi `/api/audio/autotune` với `enabled=false` (hoặc kiểm tra `autotune_settings.enabled` ở cả `player.ts`, `JavaAudioFallbackService`, và `renderer.py` trước khi ưu tiên `tuned_vocal_ref`). |
| `AUDIT-BUG-03` | `P2` | `frontend/src/components/providers/ProjectProvider.tsx:42-43, 102-118`, `frontend/src/pages/StudioPage.tsx:571-572` | **Gọi `mutateWithUndo(...); await saveNow(true);` trong cùng tick đọc `latestProjectRef.current` cũ:** `latestProjectRef.current` chỉ cập nhật sau React render nên `saveNow(true)` sync state trước khi mutate lên Redis/IndexedDB (hiện tại `fix_apply_autotune` ít bị lộ vì `autotuneAudio` gửi `nextSettings` trực tiếp). | Cập nhật `latestProjectRef.current = nextNormalized` đồng bộ ngay trong `setProject` / `updateProject` (hoặc hỗ trợ truyền `overrideState` vào `saveNow(true, nextState)`). |

### Cảnh báo & Khoảng hở SRS (`WARN`)

- **`WARN-01` (`FR-LYR-03`):** `CoachLyricistAgent.java:147-164` trả về `suggested_actions`, nhưng `StudioPage.tsx:1606-1618` chỉ hiển thị `m.content`, chưa có nút bấm xác nhận áp dụng đề xuất của Coach.
- **`WARN-02` (`FR-ANA-03`):** Sửa tay BPM/Key ở Bước 2 (`CreatePage.tsx:951-1016`) chưa bật cờ `bpm_locked` / `key_locked` (`AudioController.java:318-323, 370-375`), nên quay lại Bước 1 rồi tiến tới Bước 2 sẽ bị phân tích lại ghi đè.
- **`WARN-03` (`FR-INP-01/02`):** `CreatePage.tsx:747-821` thiếu chọn mic device, nút Pause/Resume ghi âm, waveform canvas (đã có VU meter), handler `onDrop` kéo-thả file, và tùy chọn `mode='vocal'` (5 phút) trong `client.ts:209-219`. Upload file non-WAV sẽ lỗi `400` khi Docker `audio-worker` tắt.
- **`WARN-04` (`FR-HUM-05` / `FR-STU-08`):** `enable_lead_karaoke` (`CreatePage.tsx:1221-1232`) chưa được `ArrangerAgent.java:100` / `AgentOrchestrator.java:410` dùng để tắt/bật tạo `lead` track; một số `instrument` ID trên `StudioPage.tsx:65-70` (`synth_lead`, `warm_pad`, `upright_bass`, `electronic_808`, `lofi_kit`) chưa map trong `renderer.py:20-29` `INSTRUMENT_PROGRAMS`, và `exportMidi` chưa ghi `PROGRAM_CHANGE`.
- **`WARN-05` (`FR-ATN-03/04` / `FR-STU-10`):** Scale `chromatic` có ở Backend nhưng thiếu ở dropdown Frontend (`CreatePage.tsx:61`, `StudioPage.tsx:64`, `PianoRollEditor.tsx:35-40`); pitch-shift OLA hiện tại giữ duration/`t=0` nhưng chưa phải formant-preserving DSP (PSOLA/LPC); đổi Key ở Studio cập nhật `autotune_settings.key` nhưng cần bấm Apply để render lại `tuned_vocal_ref`.
- **`WARN-06` (`FR-STU-06` / `FR-STU-13`):** `TimelineEditor.tsx:979-1005` khi split vocal chưa có clip đẩy 2 frame Undo; xóa sạch vocal clips sẽ fallback về phát toàn bộ vocal asset; mở lại Studio khi cache backend hết hạn chưa khôi phục `raw_input` từ IndexedDB (`StudioPage.tsx:205-212`).
- **`WARN-07` (`FR-STU-14` / `FR-HUM-03` / `audio-worker`):** `exporter.py:115-122` `_format_mido_key` chưa map sharp keys (`D#`, `G#`, `A#`) sang flat spellings (`Eb`, `Ab`, `Bb`); `renderer.py:267-271` fallback về vocal khi clip ref lạ bị thiếu, và không resample WAV khác `sr`; `preparePreviewProject` của Java mute `lead` ở `preserve` & tổng hợp `lead` ở `enhance`, trong khi `renderer.py:389-392` scale `lead` `0.40` ở `preserve`.
- **`WARN-08` (`NFR` Health Status):** `ProjectStateStore.java:590-596` đặt `connected: true` ngay cả khi `backend: "memory"`, làm banner cảnh báo Redis fallback ở `SettingsPage.tsx:152-164` không bao giờ kích hoạt.
