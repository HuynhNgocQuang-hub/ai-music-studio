# Tài liệu Yêu cầu Hệ thống & Nghiệp vụ (`REQUIREMENTS`)
## Dự án: AI Music Studio (Hybrid Multi-Agent DAW)

- **Phiên bản:** 2.4 (Phase 1–9 Complete: Hybrid Multi-User Cloud Pro DAW, 24-Tool Copilot, Stem Separation, Automation, Pitch Curve, WebMIDI, Custom `.sf2`, Publishing & Realtime WebSocket Collab Showcase)
- **Cập nhật lần cuối:** 2026-11-27
- **Liên kết tài liệu:** [SRS.md](./SRS.md) | [DESIGN_SPEC.md](./DESIGN_SPEC.md) | [API_AND_UI_SPEC.md](./API_AND_UI_SPEC.md) | [MULTI_AGENT_ARCHITECTURE.md](./MULTI_AGENT_ARCHITECTURE.md) | [TASK_BOARD.md](./TASK_BOARD.md) | [PHASES_OVERVIEW.md](./PHASES_OVERVIEW.md)

---

## 1. Mục tiêu Sản phẩm & Phạm vi Nghiệp vụ

### 1.1. Tuyên bố bài toán
Người sáng tác không chuyên và bán chuyên thường có ý tưởng giai điệu bằng giọng ngân nga (humming) hoặc bản thu mộc ngắn, nhưng thiếu công cụ hợp nhất giúp:
1. Làm sạch tiếng ồn, nhận diện cao độ/BPM/tông và chỉnh phô tự nhiên (không méo giọng robot trừ khi chủ ý).
2. Chuyển ngay đoạn ngân nga thành beat đệm hoặc bài hát hoàn chỉnh nhiều phân đoạn có lời đi kèm.
3. Chỉnh sửa sâu cả **Audio Clips** lẫn **MIDI Notes / Chords / Mix** trong cùng một phòng thu trên trình duyệt mà không ngốn dung lượng ổ đĩa, đồng thời đồng bộ lên đám mây và chia sẻ bản Master công khai khi cần.

### 1.2. Phạm vi Hệ thống (`In-Scope` vs `Out-of-Scope`)

| Thuộc phạm vi hiện tại (Phase 1–9) | Ngoài phạm vi Hiện tại (Enterprise / Future) |
| :--- | :--- |
| **Hybrid Guest + Multi-User JWT SaaS** (`Authorization: Bearer`, Local OAuth Sandbox, phân quyền sở hữu project) | External OAuth2 Secrets sản xuất & SSO Doanh nghiệp (SAML/OIDC enterprise) |
| **Dual Persistence Tier:** **PostgreSQL 16 + H2 Embedded Fallback** + **MinIO S3 (AWS SigV4) + Local Fallback** + Redis/In-Memory | Hệ thống CDN toàn cầu đa vùng & đồng bộ CRDT cấp sub-note qua WebRTC |
| Hỗ trợ Dual Cloud LLM (**Gemini `gemini-3.8-flash`** + **OpenAI `gpt-4o-mini`** + **Mock Fallback**) kèm **Quota Rate-Limiter (`429`)** | Huấn luyện/nạp model AI audio hoặc LLM nặng trực tiếp trên máy người dùng |
| Chỉnh sửa Hybrid: **Audio Clips** (Split/Trim/Move/Fade/Overdub + **Stem Separation Vocal/Beat** + **Visual Pitch Curve Editor**) + **MIDI** (Piano Roll + **Hardware WebMIDI**, Step Sequencer, Chord Track, **Custom `.sf2` SoundFont**) | Plugin VST3/AU C++ native trong trình duyệt hoặc thu âm ASIO đa kênh đồng thời |
| Khung Playlist FL Studio, **Console Mixer 3-Band EQ + FX Bus**, **Undo 50 bước**, **AI Copilot 24 Tools**, **Public Demo Share `/share/:slug`** (**Likes + Timestamp Comments**, **FLAC/MP3 ID3/WAV**, **Caddy HTTPS `:8443`**) & **Realtime Studio Collaboration (`/ws/collab` + Pinned Bar Notes)** | Phát hành trực tiếp lên các nền tảng thương mại (Spotify/Apple Music DSP) & thanh toán Stripe nhiều khu vực |

---

## 2. Chân dung Người dùng & User Stories (Personas)

| Persona | Mục tiêu chính | Kịch bản sử dụng tiêu biểu |
| :--- | :--- | :--- |
| **Người ngân nga phổ thông (`Casual Creator`)** | Biến đoạn huýt sáo/ngân nga 10–30 giây thành bản nhạc nền hoặc demo hoàn chỉnh trong < 2 phút. | Dùng `/create` (4 bước): Thu Mic -> Bật **AI Denoise** -> Chọn Auto-Tune `Vừa` -> Chọn `Full Song` + `Chorus` -> Nghe so sánh **Quick Preview** & tải `MP3 320kbps`. |
| **Ca sĩ / Nhạc sĩ (`Singer-Songwriter`)** | Viết lời khớp nhịp, thu đè nhiều lần lên beat, chỉnh cao độ bảo toàn formant và thử các vòng hợp âm khác nhau. | Mở `/studio/:id` ở chế độ **`Pro DAW`**, hỏi **AI Music Chatbot** (chế độ *Viết lời* / *Hòa âm*), bấm **Rec Mic (Overdub)** -> áp dụng **1-Click Fit Check** -> điều chỉnh lời Karaoke & Auto-Tune Pro. |
| **Producer / Beatmaker (`DAW Power User`)** | Làm chủ cấu trúc bài, cắt ghép Audio/Sample, sửa từng nốt MIDI, trộn EQ 3 băng tần, Reverb/Delay và xuất Stems/MIDI qua phần mềm ngoài. | Chọn Starter Template trên `/`, chỉnh nhịp `4/4` / `3/4` / `6/8`, kéo chấm **Dynamics Envelope**, gõ nhịp trên **Step Sequencer**, tinh chỉnh **Piano Roll**, cân bằng **Console Mixer** & xuất **Stems `.zip` / `.mid` / `.aimusic`**. |

---

## 3. Yêu cầu Chức năng & Nghiệp vụ Cốt lõi (BR & Traceability Matrix)

| Nhóm Yêu cầu | Mô tả nghiệp vụ bắt buộc | Thành phần Hiện thực chính | Kiểm chứng (`Verification`) |
| :--- | :--- | :--- | :--- |
| **BR-01: Thu/Nạp & Lọc ồn (`FR-INP`)** | Nhận `.wav`, `.mp3`, `.m4a`, `.ogg`, `.flac`; dài `3s..300s` (hum `<= 60s`), `<= 50 MB` (`<= 55 MB` multipart); hỗ trợ Mic `.wav` + **AI Denoise** & so sánh `Raw` vs `Dry`. | `CreatePage.tsx`, `AudioController.java`, `audio-worker/services/denoise.py` | `test_upload_rejects_*`, `test_denoise_analyze_autotune_pipeline` |
| **BR-02: Phân tích & Auto-Tune (`FR-ANA`, `FR-AUTOTUNE`)** | Trích xuất BPM (`40–220`), Key/Scale, Time Signature (`4/4`, `3/4`, `6/8`), `raw_melody_midi`; Auto-Tune bảo toàn **Formant Cepstral**, 4 preset + Pro Controls + `Auto-Follow`. | `analyzer.py`, `autotune.py`, `JavaAudioFallbackService.java` | `test_autotune_enharmonic_keys`, `test_formant_preserving_autotune_and_6_8_vocal_carve` |
| **BR-03: Phối khí Multi-Agent & QA (`FR-HUM`)** | Hỗ trợ `Preserve` vs `Enhance`, `Accompaniment Only` vs `Full Song` (`short`/`standard`), tiến trình SSE realtime, hủy ngang `Cancel`, QA tối đa 2 vòng + Best-effort Fallback, timeout `60s`. | `AgentOrchestrator.java`, `ComposerAgent.java`, `ArrangerAgent.java`, `QaReviewerAgent.java` | `AgentPipelineTests` (`14/14`), `test_job_generate_and_sse_events`, `test_full_song_standard_structure_includes_bridge_and_short_preset` |
| **BR-04: Pro DAW Playlist & Editor (`FR-STUDIO`)** | Top Transport (**50-Step Undo**) + Left Browser + Arrangement Playlist (**FL Clip Frames**: Audio Waveform, **Multi-Param Automation Envelope `DYN/VOL/PAN/FILT/REVERB`** via `AudioParam.linearRampToValueAtTime`, MIDI Pattern theo Section) + **Stem Separation Vocal/Beat** + **A/B Chord Audition** + **Visual Pitch Curve Editor** + Step Sequencer (`4/4`, `3/4`, `6/8`) + Piano Roll (**Hardware WebMIDI**) + Console Mixer (`3-Band EQ`, `Send FX Bus`) + **Custom `.sf2` SoundFont** + Overdub Fit Check. | `StudioPage.tsx`, `TimelineEditor.tsx`, `WaveformClipCanvas.tsx`, `PitchCurveEditor.tsx`, `PianoRollEditor.tsx`, `webmidi.ts`, `StepSequencer.tsx`, `ConsoleMixerPanel.tsx`, `SettingsPage.tsx`, `player.ts`, `stems.py`, `renderer.py` | Live Chrome E2E (`recording_5.mp4`, `recording_12.mp4`), `test_stem_separation_and_custom_soundfont_validation`, `test_multiclip_trim_fade_export_and_stems`, `test_piano_roll_note_update_and_midi_export`, `test_phase4_crud_eq_send_fx_and_delete` |
| **BR-05: AI Copilot Toàn cục & Multimodal (`FR-LYRIC`)** | Trợ lý AI toàn ứng dụng 5 trang (`AppShell` + `ProjectProvider`), **4 chế độ** (`Producer`, `Hòa âm`, `Viết lời`, `Mix / Tune`), **Mini-RAG `DawPlaybook`**, Native Function Calling (**24 tool actions**: EQ/FX, Track/Groove, Stem Separation, Automation Curve, Structure/Dynamics, Lyrics CRUD, Mastering LUFS, Transport Play/Loop/Undo, Route/Mode Navigation, Template, Export), **A/B Nghe thử hợp âm**, **Holistic Project Audit** (*"đề xuất mọi thứ"*), **SSE Token Stream**, **Multimodal Audio/Voice** (`/chat/audio` `<= 10 MB`, `Gửi kèm Vocal`, Mic WAV/Speech), nhớ hội thoại **IndexedDB `chat_threads`**, **Áp dụng tất cả** & **Hoàn tác 1 chạm**. | `AiCoachChatDrawer.tsx`, `AppShell.tsx`, `ProjectProvider.tsx`, `indexeddb.ts`, `CoachLyricistAgent.java`, `DawPlaybook.java`, `StudioController.java`, `LlmAdapter.java` | `AgentPipelineTests` (`14/14`), `ApiMockMvcTests` (`8/8`), `test_full_spectrum_copilot_stream_and_audio`, Live Chrome E2E (`recording_8..12.mp4`) |
| **BR-06: Lưu trữ 2 tầng, CRUD & Export (`NFR`)** | Auto-Save `IndexedDB` (`7s`, tối đa 5 draft + `chat_threads` + **Auto-Rehydrate** khi Redis TTL hết hạn); Redis State + **Undo 50 bước** + Cloud DB bền vững; CRUD đầy đủ trên `/library` & `/`; Export `WAV`, `MP3 (320k/192k + ID3)`, **`FLAC Lossless`**, `Stems .zip` đồng độ dài, `.mid`, `.aimusic` collision-safe (`overwrite=false`). | `indexeddb.ts`, `ProjectProvider.tsx`, `ProjectStateStore.java`, `ProjectsController.java`, `CloudDatabaseService.java`, `exporter.py`, `LibraryPage.tsx` | `AudioAndLimiterTests` (`16/16`), `CloudPhase8Tests` (`2/2`), `test_end_to_end_full_lifecycle_workflow` |
| **BR-07: Bảo mật & Phòng chống DoS (`NFR-SEC`)** | Bind Compose về `127.0.0.1`; `SecurityHeadersFilter` (`nosniff`, `DENY`, `no-referrer`, `Permissions-Policy`); giới hạn `CorsConfig`; che key trong log LLM; giới hạn Zip Bomb (`64` entries / `60 MB` entry / `120 MB` tổng), Path Traversal (`..`), chunked worker & chat audio upload (`413`), và chặn `total_bars > 256` (`HTTP 400`). | `SecurityHeadersFilter.java`, `CorsConfig.java`, `LlmAdapter.java`, `AudioWorkerClient.java`, `renderer.py`, `main.py` | `ApiMockMvcTests` (`8/8`), `test_worker_dos_clamps_and_render_bounds`, `test_security_headers_validation_and_dos_guards` |
| **BR-08: Cloud Multi-User, Quota & Publishing (`Phase 8`)** | **Hybrid Guest + HS256 JWT Auth** (`/api/auth/*`, Local OAuth Sandbox, `POST /api/auth/logout` thu hồi `jti`), kiểm soát quyền sở hữu (`403`), **PostgreSQL + Embedded H2 Fallback**, **MinIO S3 (AWS SigV4) + Local Fallback**, **Daily Quota Rate-Limiter (`429`)**, **Caddy HTTPS (`Caddyfile`)**, và **Public Demo Showcase (`/share`, `/share/:slug`, `Remix`)**. | `JwtService.java`, `CloudProjectAccessService.java`, `CloudDatabaseService.java`, `ObjectStorageService.java`, `QuotaRateLimitService.java`, `AuthController.java`, `PublishShareController.java`, `AuthProvider.tsx`, `LoginPage.tsx`, `AuthModal.tsx`, `SharePage.tsx`, `infra/Caddyfile` | `CloudPhase8Tests` (`3/3`), Live HTTP Proxy (`16/16`), Chrome Live E2E (`100/100` a11y) |
| **BR-09: Realtime Studio Collaboration & Showcase Social (`Phase 9`)** | Cộng tác nhiều tab/người dùng trong Studio qua WebSocket `/ws/collab` (`2 MB` buffer, JWT + `?collab=room_code`), presence/cursor bar, `state_sync` chống echo, `transport_cue`, **Pinned Bar Notes** (`/api/studio/{id}/comments`); kèm **Thích (`release_likes`)** & **Bình luận mốc thời gian (`release_comments`)** trên `/share/:slug` (timeline markers, `403` delete guard & cascade cleanup). | `WebSocketConfig.java`, `CollabRoomService.java`, `CollabWebSocketHandler.java`, `CollabController.java`, `PublishShareController.java`, `CloudDatabaseService.java`, `useStudioCollab.ts`, `StudioCollabPanel.tsx`, `StudioPage.tsx`, `SharePage.tsx` | `CollabPhase9Tests` (`2/2`, `mvn 43/43`), Live WS+HTTP `live_phase9_test.mjs` (`8/8`), Chrome Live E2E (`4d7a9921`: 2-tab `LIVE` sync + Lighthouse **`100/100`** `/studio` & `/share/:slug`) |
| **BR-10: Creator Profiles, Follow Feed, Trending Showcase & Mastering LUFS (`Phase 10B`)** | Trang cá nhân Producer (`/creators/:id`), bảng xếp hạng `/creators`, tùy biến Bio (`PATCH /api/creators/me`, chặn Guest `401`), Follow Graph (`POST /api/creators/{id}/follow`, chặn self-follow `400`), Feed `Đang theo dõi` & sắp xếp Trending (`recent \| trending \| likes \| plays`), chọn Target LUFS (`-9 Club \| -14 Streaming \| -16 Apple`) ở Console Mixer, Publish & Export (`exporter.py` + `JavaAudioFallbackService`). | `CreatorController.java`, `CloudDatabaseService.java`, `{Auth,PublishShare,Projects}Controller.java`, `ExportAudioRequest.java`, `CreatorProfilePage.tsx`, `SharePage.tsx`, `ConsoleMixerPanel.tsx`, `StudioPage.tsx`, `AppShell.tsx` | `CreatorFollowAndLufsTests` (`1/1`, `mvn 44/44`), Live HTTP Proxy `live_phase10b_test.mjs` (`7/7`), Chrome E2E (`3fcb5d96` + `f77a4067`: `/creators/:id` & `/share` **`100/100`** a11y, `0` errors) |

---

## 4. Yêu cầu Phi chức năng & Ràng buộc Chất lượng (SLA / Constraints)

| Chỉ số | Ngưỡng yêu cầu |
| :--- | :--- |
| **Master Audio Safety** | Mọi bản Mix & Export bật Mastering đều giữ đỉnh **Peak `<= -1.0 dBFS`** và hướng tới **`-14.0 LUFS`**. |
| **Audio-MIDI Sync** | Đồng bộ cùng lưới thời gian neo tại `Bar 1, Beat 1 (t = 0.000s)` với sai số Web Audio `< 10 ms`. |
| **Dung lượng `.aimusic`** | Chỉ đóng gói JSON + Audio thô/Overdub (bật cờ `dry_same_as_raw` chống trùng lặp, tái tạo `vocal_autotuned.wav` khi mở lại), giữ kích thước nhẹ (`~1–3 MB` với câu ngân nga ngắn). |
| **Độ tin cậy khi thiếu mạng/API** | Hệ thống luôn chạy được offline một phần nhờ **Mock LLM thông minh**, `JavaAudioFallbackService`, và lưu nháp **`IndexedDB`**. |
| **Hiệu năng Bundle Web** | Route-level code splitting (`React.lazy`), main bundle `index` giữ quanh ~300 kB. |
