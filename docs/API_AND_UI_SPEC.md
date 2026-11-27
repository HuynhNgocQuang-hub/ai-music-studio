# Tài liệu Thiết kế Giao diện, Điều hướng & API Contract
## Dự án: AI Music Studio (Hybrid Multi-Agent)

- **Phiên bản:** 2.2 (Pro DAW + Phase 6B–7 Pro DSP + Phase 8 Hybrid Cloud SaaS, Quota, FLAC/ID3 & Public Share)
- **Liên kết:** [REQUIREMENTS.md](./REQUIREMENTS.md) | [DESIGN_SPEC.md](./DESIGN_SPEC.md) | [SRS.md](./SRS.md) | [MULTI_AGENT_ARCHITECTURE.md](./MULTI_AGENT_ARCHITECTURE.md) | [TASK_BOARD.md](./TASK_BOARD.md) | [PHASES_OVERVIEW.md](./PHASES_OVERVIEW.md)
- **Mục tiêu:** Đặc tả kiến trúc điều hướng (Menu, Chuyển trang, Phân trang), bố cục tối ưu cho từng màn hình, hợp đồng API giữa Frontend (`React + Vite`) – Core Backend (`Java 21 + Spring Boot 3.x`) – Audio DSP Microservice (`audio-worker`) – Redis/PostgreSQL/MinIO/Caddy, và cấu trúc file dự án `.aimusic`.

---

## 1. Kiến trúc Hạ tầng Tối ưu cho Máy Cá nhân & Hybrid Cloud (Node + Java 21 + Docker)

Dựa trên cấu hình thực tế (**Node.js v24**, **Java 21 + Maven 3.9+**, **Docker Compose**):

* **Frontend (`React 19 + Vite`):** Chạy bằng **Node.js v24** (cổng `3000`, hot-reload tức thì), cấu hình `vite.config.ts` proxy `/api` $\rightarrow$ `http://localhost:8000` (hoặc cấu hình `VITE_API_BASE_URL`); sử dụng `IndexedDB` trình duyệt để tự động lưu ngầm và `localStorage` cho JWT token (tùy chọn).
* **Core Backend (`Java 21 + Spring Boot 3.x`, cổng `8000`):** Xử lý toàn bộ API `/api/*`, SSE (`SseEmitter`), **Hybrid JWT Auth + Daily Quota Rate-Limiter**, `Spring Data Redis` (kèm In-Memory TTL fallback), **PostgreSQL + H2 Local Fallback** (`CloudDatabaseService`), **MinIO S3 AWS SigV4 + Local Fallback** (`ObjectStorageService`), Multi-Agent Orchestrator, Dual LLM Adapter (`Gemini` + `OpenAI` + Mock), xuất/nhập `.mid` & `.aimusic`, Public Demo Share `/api/share/*`, và cung cấp `JavaAudioFallbackService` khi `audio-worker` không chạy.
* **Audio DSP Microservice (`audio-worker/`, Python FastAPI cổng `8001`), State & Cloud Stack:** Đóng gói gọn trong **Docker Compose** (`redis:7-alpine`, `postgres:16-alpine`, `minio/minio`, `audio-worker` xử lý DSP với `FFmpeg`, `FluidSynth`, `noisereduce`, `librosa`, `pedalboard`, `backend`, và `caddy:2-alpine` HTTPS reverse proxy `:8443`). Khi Docker tắt, Spring Boot vẫn chạy độc lập hoàn chỉnh trên Windows với H2 + Local S3 fallback.
* **SoundFont gọn nhẹ:** Nhúng 1 bộ SoundFont General MIDI nhẹ (`GeneralUser-GS.sf2` hoặc tương đương) bên trong `audio-worker` kèm khả năng nạp Custom `.sf2`.
* **LLM Cloud API:** Toàn bộ Agent trí tuệ gọi qua **Gemini API** hoặc **OpenAI API** (0 GB trọng số model trên đĩa).

---

## 2. Kiến trúc Điều hướng, Menu & Bố cục Màn hình (UI/UX Navigation)

### 2.1. Thanh Activity Rail & Khung Ứng dụng (App Shell)
Giao diện dùng `react-router-dom` (`BrowserRouter`, `Routes`, `Route`) với **Pro DAW Activity Rail** gọn bên trái (ẩn bớt header phụ khi vào `/studio/:id` để nhường trọn 100% chiều cao cho Timeline + Production Dock), nút tài khoản **Cloud Quota** (`AuthModal.tsx`), nút **Đăng nhập / Đăng xuất** 1 chạm trên thanh Activity Rail, Header chính và Studio Top Transport, nút tạo nhanh **Blank DAW** (`+`) và banner khôi phục bản nháp `IndexedDB`:

| Menu Item | Route | Chức năng chính |
| :--- | :--- | :--- |
| **Trang chủ (Project Hub)** | `/` | Khởi tạo 1-click từ Starter DAW Templates (`Pop`, `Lo-fi`, `Trap 808`, `House`, `Ballad`, `Blank Studio`) & Recent Sessions (tự đồng bộ lại khi Login/Logout). |
| **1. AI Hum-to-Music** | `/create` | Luồng từng bước (Wizard 4 bước) ghi âm/upload vocal để AI phối khí & tạo bài hoàn chỉnh. |
| **2. Phòng thu DAW** | `/studio/:id` | Không gian Pro DAW đầy đủ (Arrangement, Multi-Param Automation, Stem Separation, Pitch Curve, Step Sequencer, Piano Roll + WebMIDI, Console Mixer EQ/FX Bus, Lyrics CRUD, AI Coach, **Publish & FLAC Export**, nút **Đăng nhập/Đăng xuất** trên Top Transport). |
| **3. Kho Session (`.aimusic`)** | `/library` | Quản lý Local Draft (`IndexedDB`) & Server/Cloud Sessions (lọc theo **Workspace Scope `Tất cả \| Của tôi \| Công khai`**, tạo mới, nhân bản/remix sạch `owner_id`, xóa có cascade cleanup, badge `Cloud (Của bạn)` / `Public` + nút **Ẩn Share**, phân trang `12/24/48`, import `.aimusic`, tự reload khi đổi tài khoản). |
| **4. Cộng đồng Demo** | `/share` & `/share/:slug` | Trang Showcase & Trình phát **Master Release** công khai (`-14 LUFS`, MP3/FLAC/WAV) có **Tìm kiếm, Lọc thể loại & Phân trang**, hiển thị hợp âm, lời, lượt nghe, tải Master, nút **Thu hồi Publish** cho chính tác giả và nút **Remix trong Studio** (gán sạch quyền sở hữu cho người Remix). |
| **5. Audio Engine & API** | `/settings` | Cấu hình Gemini/OpenAI Key, phân vai Agent, Test API Key, nạp **Custom `.sf2` SoundFont**, kiểm tra Cloud DB/S3/Redis/FluidSynth, xem **trạng thái tài khoản & 3 thanh tiến độ Daily Quota (`AI Jobs`, `Export/Publish`, `Cloud Object Storage`)**. |
| **6. Tài khoản Cloud** | `/login` & `/register` | Trang Đăng nhập / Đăng ký riêng biệt (`LoginPage.tsx`), hỗ trợ `?redirect=...`, Local OAuth Sandbox (`Google`/`GitHub`), xem Quota & **Đăng xuất (thu hồi JWT)**. |

> **Chuyển trang thông minh (Seamless Handoff):** Từ trang `/create` sau khi AI tạo xong bản nghe thử (Bước 4), người dùng bấm **"Mở trong Studio"** $\rightarrow$ điều hướng sang `/studio/:id` bằng `useNavigate()` mà giữ nguyên toàn bộ State trong `ProjectProvider`.

---

### 2.2. Thiết kế Chi tiết Từng Trang

#### Trang A: `/create` (`CreatePage.tsx`) — Quy trình Tạo nhạc Tối ưu (4-Step Wizard)
Chia thành **4 bước có thanh Stepper** cho phép quay lại bước trước bất kỳ lúc nào:
* **Bước 1 — Nhập & Làm sạch (`Input & Dry Check`):**
  * Tab chuyển giữa **Ghi âm Mic** (mã hóa thành `.wav` PCM chuẩn trước khi upload, kèm Count-in Metronome, Oscilloscope Waveform trực tiếp theo thời gian thực & thanh tiến trình upload `%`) và **Upload File** (`.wav/.mp3/.m4a/.ogg/.flac`, tối thiểu `3s`, tối đa `50 MB`).
  * Nút bật/tắt **AI Denoise** + trình phát đối chiếu **Giọng mộc gốc** vs **Giọng mộc đã lọc ồn**.
  * Công cụ cắt ngắn đầu/cuối nhanh hoặc **AI Auto-Trim**.
* **Bước 2 — Phân tích & Auto-Tune nhanh (`Analyze & Tune`):**
  * Hiển thị thẻ kết quả: `BPM` (có Tap Tempo & nghe Metronome), `Key / Scale` (cho chỉnh tay nếu cần), **`Time Signature (4/4 | 3/4 | 6/8)`**, số ô nhịp.
  * Thanh **Auto-Tune Quick Bar**: `Off` | `Nhẹ (Natural)` | `Vừa (Balanced)` | `Mạnh (Modern)` + nút nghe thử A/B ngay.
* **Bước 3 — Cấu hình AI & Phối khí (`Style & Generate`):**
  * Chọn **Chế độ giai điệu**: `Preserve Original` | `AI Enhance`.
  * Chọn **Đầu ra**: `Accompaniment Only` (hỗ trợ tùy chọn **thêm ô nhịp Count-in đầu & Tail cuối `add_count_in_tail`**) | `Full Song` (nếu chọn Full Song $\rightarrow$ chọn vị trí mô-típ: *Mặc định Chorus* / *Verse* / *AI đề xuất*, và bật/tắt *Lead Karaoke Guide + Gợi ý lời*).
  * Chọn **Genre**, **Mood**, nhập **Prompt** ngắn (tối đa 500 ký tự).
  * Khi bấm **Tạo nhạc**: Hiển thị tiến trình từng Agent đang chạy (`Analyzer -> Composer -> Arranger -> QA`) qua SSE kèm đồng hồ đếm ngược timeout `60s` và nút **Hủy (Cancel)**.
* **Bước 4 — Nghe thử nhanh (`Quick Preview`):**
  * Nút chuyển tức thì để nghe so sánh 4 lớp: **Giọng mộc + Beat** | **Auto-Tune + Beat** | **Bản Preserve** | **Bản Enhance** (kèm nút **"Đặt làm chế độ chính & Tạo lại MIDI"** để đổi mode trực tiếp).
  * 2 hành động chính: **Tải nhanh (`MP3 320kbps / WAV`)** hoặc **Mở vào Hybrid Studio (`/studio/:id`)**.

#### Trang B: `/studio/:id` (`StudioPage.tsx` + `QuickStudioView.tsx` + `ConsoleMixerPanel.tsx` + `AiCoachChatDrawer.tsx`) — Pro DAW Workstation & Quick/Pro Switcher
Bố cục **4 vùng chuẩn DAW** được code-split qua `React.lazy` + `Suspense` (hỗ trợ chuyển tức thì **`[Quick | Pro DAW]`** mà không làm mất state, **tự động Rehydrate audio từ `IndexedDB`** khi Redis TTL hết hạn, nút **Regenerate toàn bài** kèm Cancel, và thanh Activity Rail gọn bên trái):
1. **Top Transport Bar (Cố định trên cùng):**
   * `Play / Pause / Stop / Rec Mic (kèm bù trễ Latency ms) / Loop / Metronome Click`, LCD `Bar:Beat` & `mm:ss`, chỉnh `BPM`, `Key`, `Scale`, **`Time Signature (4/4 | 3/4 | 6/8)`**, Master Peak meter, `Undo / Redo`.
   * Công cụ Timeline: `Select (V)` | `Split (C)` | `Snap Grid (1/4, 1/8, 1/16)`.
   * Chuyển A/B (`Dry / Tune / Mix`), nút **Auto-Save**, nút **Export** (bao gồm **`.aimusic`**, `WAV`, **`MP3 320kbps Studio`**, **`MP3 192kbps Nhẹ`**, `Stems`, `MIDI`) và **AI Coach**.
2. **Left DAW Browser (`Patterns | Inspector | Presets`) & Vùng Arrangement Trung tâm:**
   * **Section Bar** (`+ Section`, chỉnh tên / `Start` / `Bars` / `Energy%`, xóa) + **Chord Timeline** (bấm ô để sửa hoặc bấm `×`/nhập rỗng để xóa hợp âm; nút *Cập nhật đệm*).
   * Toolbar Arrangement: Loop `B1–B9`, Zoom, **`Track Gọn / Track Cao`**, **`Envelope`** (bật/tắt làn `Dynamics` Automation), **`+ Track`** (tạo/khôi phục `Texture` hoặc MIDI track), **`Auto-Trim`**, **`+ Sample`**.
   * Khung Clip Playlist kiểu FL Studio 12 (tiêu đề màu 17px + biểu tượng từng loại clip, thân trong suốt hiện lưới nhịp): **Audio Clip** (waveform polygon đối xứng từ `WaveformClipCanvas`), **Dynamics Automation Envelope** (đường cong `section.energy` kéo chỉnh trực tiếp với chấm tròn neo), và **MIDI Pattern Clips** (tự động chia theo từng Section/biến thể `#2`, preview Piano Roll thu gọn).
   * Track Controls: `M`, `S`, `Lock`, **`Trash2`** (xóa `Texture` hoặc làm trống clip/nốt), `Rec Mic`, `Sample`, `AI Gen`, kéo thả clip (`Move / Split / Trim / Duplicate / Delete`).
3. **Vùng Dưới (`Production Dock` có thể kéo giãn & phóng to toàn màn hình):**
   * **Tab 1 — `Step Sequencer`:** Lưới trống 16 bước (`4/4`) / 12 bước (`3/4` & `6/8`), Groove Presets, `Lặp cả bài`, `Xóa Bar`, `Xóa hết`.
   * **Tab 2 — `Piano Roll`:** C1–C7, Scale Highlight, kéo di chuyển/đổi độ dài, Velocity Lane kéo mượt, Quantize, `±Oct`, `Copy`/`Delete` nốt trên Floating HUD.
   * **Tab 3 — `Console Mixer`:** Đổi nhạc cụ trực tiếp, **3-Band EQ (`low_db`, `mid_db`, `high_db`)** lưu bền vững vào backend, **FX SEND (`reverb_send`, `delay_send`)** riêng cho `Vocal` & `Lead`, Pan, Vertical Fader `0–120%`, 12-LED Meter, **`FX BUS`** return strip (`Hall Reverb` + `1/8D Ping-Pong Delay` + `BYPASS`), và **MASTER Bus** (`Auto-Mix` với Vocal Frequency Carve 2.2 kHz `-2.5 dB` + Limiter `<= -1.0 dBFS`).
   * **Tab 4 — `Auto-Tune DSP`:** Root, Scale, Retune Speed (`0–200ms`), Humanize, Mix %, Auto-Follow Project Key (tự re-tune debounced khi đổi Project Key/Scale).
   * **Tab 5 — `Lyrics & Karaoke`:** Đầy đủ CRUD (`+ Thêm dòng`, sửa `section` / `bar` / nội dung, nhảy nhanh `▶ b{bar}`, `Xóa dòng`) + AI Gợi ý lời & Karaoke Sync live.
4. **Panel Phải (`AiCoachChatDrawer.tsx` — Global AI Music Copilot & Fit Check):**
   * Hoạt động đồng bộ trên **mọi màn hình** (`/`, `/create`, `/library`, `/settings`, `/studio/:id`) từ Activity Rail / Header với **4 chế độ chuyên sâu (`Producer | Hòa âm | Viết lời | Mix / Tune`)**, lưu bền vững hội thoại qua **IndexedDB `chat_threads`** (v2).
   * Truyền trực tiếp **Live SSE Streaming** (`/api/coach/chat/stream`), hỗ trợ **Multimodal Audio Input** (nhấn đính kèm file audio `<= 10 MB`, bật **`Gửi kèm Vocal để AI nghe`**, hoặc nút Mic dùng Web Speech `vi-VN` / ghi âm WAV).
   * Hỗ trợ **22 Native Tool Actions** (`set_track_mix`, `manage_track`, `apply_drum_groove`, `edit_structure_and_dynamics`, `update_lyrics_lines`, `suggest_lyrics`, `rearrange_chords`, `apply_autotune`, `auto_mix`, `auto_trim_vocal`, `set_mastering`, `regenerate_track`, `regenerate_song`, `update_config`, `transport_control`, `navigate_tab`, `navigate_route`, `switch_studio_mode`, `create_template`, `export_project`, `test_health`, `clear_cache`), **Holistic Project Audit** (*"AI làm được gì & Đề xuất mọi thứ"*), nút **`Áp dụng tất cả`**, và **`Hoàn tác` (1-Click Revert)** khôi phục snapshot trước khi bấm.
   * Hiển thị phân tích tự động mỗi khi thu đè (`Overdub`) lên beat (lệch nhịp `±ms`, chênh tông, mức Gain) kèm nút **1-Click Apply**.

#### Trang C: `/library` (`LibraryPage.tsx`) & Trang Chủ `/` (`HomePage.tsx`)
* **Trang chủ (`/`):** Starter DAW Templates 1-click (`Pop`, `Lo-fi`, `Trap 808`, `House`, `Piano Ballad`, `Blank Studio`) + danh sách Recent Sessions (mở vào DAW hoặc xóa nhanh).
* **Thanh Bộ lọc & Tìm kiếm (`/library`):** Tìm theo tên dự án, lọc theo **Genre** hoặc nguồn (`Tất cả | Nháp cục bộ | Đã lưu máy chủ`), nút **`+ Tạo Session mới`**, Import `.aimusic`.
* **Quản lý Session & Phân trang:** Hiển thị `12 / 24 / 48` mục/trang; mỗi Saved Session trên máy chủ đều có **Mở DAW**, **Nhân bản (`Copy`)**, và **Xóa (`DELETE /api/projects/{id}`)**.

#### Trang D: `/settings` (`SettingsPage.tsx`) — Cài đặt & Hệ thống
* **Cấu hình Dual LLM:** Nhập `Gemini API Key` (hỗ trợ cả `AQ...` lẫn `AIza...`) và `OpenAI API Key`, chọn Provider mặc định, phân vai cho 5 Agent, kèm nút **Test API Key** (`POST /api/health/llm-test`).
* **Trạng thái Hạ tầng (`/api/health`):** 4 thẻ kiểm tra trực tiếp `Backend Spring Boot`, `Redis State`, `FluidSynth / DSP`, và `LLM AI Provider`, kèm nút Dọn Cache IndexedDB & Backend.

---

## 3. Hợp đồng API Public (`Spring Boot` `/api/*`) & Internal Worker (`/internal/audio/*`)

### 3.1. Nhóm Health, Audio Input, Denoise & Auto-Tune
| Method & Endpoint | Mục đích | Payload / Output chính |
| :--- | :--- | :--- |
| `GET /api/health` | Kiểm tra sức khỏe Backend, Redis, Audio Worker (gồm `custom_soundfont_active`), Engines, LLM | `{ status, redis: { backend, connected }, audio_worker, engines, llm_providers }` |
| `POST /api/health/llm-test` | Kiểm tra kết nối API Key Gemini/OpenAI theo header hiện tại | `{ ok, is_mock, provider, model, latency_ms, message }` |
| `POST /api/settings/cache/clear` | Dọn cache tạm trong Backend State Store | `{ status: "cleared", cleared_assets }` |
| `POST /api/audio/upload` | Tải hoặc gửi bản thu Mic WAV lên Backend | Form-data audio $\rightarrow$ `project_id`, `raw_input_ref`, `filename`, `duration_sec`, `warnings` |
| `POST /api/audio/clip-upload` | Tải clip overdub / sample phụ lên track `vocal` hoặc `texture` | Form-data audio + `project_id`, `track_id`, `start_bar` $\rightarrow$ `project_state`, `clip`, `audio_ref` |
| `POST /api/audio/soundfont` | Nạp SoundFont `.sf2` tùy chọn (`<= 50 MB`, xác thực header `RIFF`/`sfbk`) vào `audio-worker` | Form-data `.sf2` $\rightarrow$ `{ status, filename, size_bytes, custom_soundfont_active }` |
| `POST /api/audio/denoise` | Chạy AI Denoise & Auto-Trim | `{ project_id, enable_denoise, auto_trim }` $\rightarrow$ `dry_denoised_ref`, `warnings` |
| `POST /api/audio/analyze` | Trích xuất BPM, Key/Scale, Pitch MIDI | `{ project_id, source_ref }` $\rightarrow$ `bpm`, `key`, `scale`, `raw_melody_midi` |
| `POST /api/audio/autotune` | Render giọng qua Auto-Tune DSP | `{ project_id, autotune_settings }` $\rightarrow$ `tuned_vocal_ref` |
| `GET /api/audio/asset?ref=...` | Stream/tải audio asset từ Redis/In-Memory | Binary audio stream (`audio/wav`) |
| `GET /api/audio/preview?project_id=...&mode=...` | Nghe thử nhanh theo lớp (`raw`, `dry`, `autotune`, `mix`) | Binary audio stream (`audio/wav`) |

### 3.2. Nhóm Multi-Agent Jobs & Realtime Progress
| Method & Endpoint | Mục đích | Payload / Output chính |
| :--- | :--- | :--- |
| `POST /api/jobs/generate` | Khởi chạy luồng tạo nhạc (`Preserve`/`Enhance`, `Accompaniment`/`Full Song`) | `{ project_id, config }` $\rightarrow$ trả về `job_id` |
| `POST /api/jobs/regenerate-track` | Tạo lại riêng 1 track trong Studio | `{ project_id, target_track, instrument }` $\rightarrow$ `job_id` |
| `POST /api/jobs/rearrange` | Cập nhật nhạc đệm theo Chord/Section Timeline mới | `{ project_id, chords, sections, total_bars, locked_tracks }` $\rightarrow$ `job_id` |
| `GET /api/jobs/{jobId}/events` | **SSE Stream** (`SseEmitter`) đẩy tiến trình từng Agent | Event: `agent_step`, `qa_retry`, `progress`, `completed`, `fallback_warning`, `error` |
| `POST /api/jobs/{jobId}/cancel` | Hủy job đang chạy ngay lập tức | `{ status: "cancelled" }` |

### 3.3. Nhóm Studio, Overdub Fit Check, Auto-Mix, Lyrics & Coach
| Method & Endpoint | Mục đích | Payload / Output chính |
| :--- | :--- | :--- |
| `POST /api/studio/auto-trim-vocal` | AI cắt khoảng lặng & căn nhịp clip Vocal trong Studio | `{ project_id }` $\rightarrow$ `project_state`, `trim_start_sec`, `trim_end_sec`, `trimmed_clips` |
| `POST /api/studio/auto-mix` | Cân bằng Gain, Pan từng track & bật Master Limiter (`<= -1.0 dBFS`) | `{ project_id }` $\rightarrow$ `project_state`, `mix_notes`, `summary` |
| `POST /api/studio/separate-stems` | Tách audio thành 2 stem riêng (`vocal` & `accompaniment`, librosa HPSS/Mid-Side + Java DSP fallback) | `{ project_id }` $\rightarrow$ `project_state`, `vocal_stem_ref`, `beat_stem_ref`, `engine` |
| `POST /api/studio/overdub-fit-check` | Upload clip thu đè lên beat & chạy AI Fit Check | Trả về `timing_offset_ms`, `pitch_issues[]`, `gain_suggestion`, danh sách **1-Click Fixes** |
| `POST /api/lyrics/suggest` | Sinh/gợi ý lời bài hát khớp đoạn & tiết tấu | `{ project_id, language, topic, section }` $\rightarrow$ `lines[]` |
| `POST /api/coach/chat` | Trợ lý AI Music Copilot (`producer`, `arrangement`, `lyricist`, `mix`) + Mini-RAG `DawPlaybook` + **24 Tool Declarations** | `{ project_id, route, mode, message, context, project_state, history }` $\rightarrow$ `reply`, `provider`, `suggested_actions[]` |
| `POST /api/coach/chat/stream` | **SSE Streaming** phản hồi Chatbot theo chunk từ trên mọi màn hình + push `suggested_actions` cuối luồng | `{ project_id, route, mode, message, context, project_state, history }` $\rightarrow$ `text/event-stream` (`chunk`, `actions`, `done`, `error`) |
| `POST /api/coach/chat/audio` | Tiếp nhận file/mic WAV đính kèm (`<= 10 MB`, > 10 MB trả `413`) cho Gemini Multimodal hoặc Java DSP Telemetry | Multipart (`project_id`, `message`, `mode`, `route`, `file`) $\rightarrow$ `reply`, `provider`, `suggested_actions[]` |

### 3.4. Nhóm Persistence, Auth, Cloud Quota, Share & Export
| Method & Endpoint | Mục đích | Payload / Output chính |
| :--- | :--- | :--- |
| `POST /api/auth/register` / `/login` | Đăng ký & đăng nhập tài khoản Cloud (PBKDF2 + HS256 JWT có `jti` claim) | `{ email, password, display_name }` $\rightarrow$ `{ authenticated, token, user, quota, cloud }` |
| `POST /api/auth/oauth/dev` / `GET /api/auth/me` | Đăng nhập Local OAuth Sandbox (`google`/`github`) & đọc thông tin phiên + Quota | `{ authenticated, user, quota, cloud }` (hoặc `Guest` nếu chưa đăng nhập) |
| `POST /api/auth/logout` | Đăng xuất server-side, thu hồi JWT `jti` vào bảng `revoked_tokens` + cache (`401` nếu replay token cũ, vẫn mở Guest khi không gửi token) | `{ status: "logged_out", authenticated: false, revoked, user, quota, cloud }` |
| `GET /api/projects` | Lấy danh sách dự án (Redis + `CloudDatabaseService`) có **phân trang, lọc & scope (`all\|mine\|public`)** | Query: `?page=1&limit=12&search=&genre=&scope=` $\rightarrow$ `{ items, total, page, total_pages }` |
| `GET /api/projects/{id}` | Lấy chi tiết 1 `ProjectState` theo ID (tự rehydrate từ CloudDB nếu hết TTL; `403` nếu private của user khác) | `ProjectState JSON` |
| `PUT /api/projects/{id}/sync` | Đồng bộ `ProjectState` (`owner_id`, `automation`, EQ, FX) lên Redis + CloudDB (`403` nếu không sở hữu) | Body: `ProjectState JSON` |
| `POST /api/projects/{id}/undo` | Khôi phục snapshot trước đó từ Undo stack (**50 bước**) | `ProjectState JSON` |
| `DELETE /api/projects/{id}` | Xóa Project khỏi Redis, CloudDB & Object Storage (`403` nếu không phải chủ sở hữu) | `{ status: "deleted", project_id }` |
| `POST/DELETE /api/projects/{id}/publish` | Xuất bản Master (`mp3`/`flac`/`wav` kèm ID3 tags, hỗ trợ `target_lufs` `-20..-8`) lên S3/MinIO + tạo/thu hồi link `/share/{slug}` | `{ share_slug, share_url, stream_url, format, lufs_target, object_storage_backend }` |
| `GET /api/share` / `/{slug}` / `/{slug}/audio` | Liệt kê Showcase cộng đồng (hỗ trợ `?sort=recent\|trending\|likes\|plays&scope=all\|following&creator=&search=&genre=`), đọc metadata + `comments[]` tăng `plays_count` & stream Master audio | JSON / Binary audio stream (`audio/mpeg`, `audio/flac`, `audio/wav`) |
| `GET /api/creators` / `/{id}` | Bảng xếp hạng Producer nổi bật & trang hồ sơ cá nhân (`/creators/:id`) gồm bio, tổng likes/plays, followers & danh sách bản phát hành | `{ items: CreatorProfile[] }` / `CreatorProfile` |
| `PATCH /api/creators/me` | Cập nhật nghệ danh (`display_name`) & tiểu sử (`bio`) của tài khoản Cloud đang đăng nhập (`401` nếu Guest) | `CreatorProfile` |
| `POST /api/creators/{id}/follow` | Bật/tắt theo dõi Producer (`creator_follows`, chặn tự follow `400`), dùng cho Feed `scope=following` | `{ creator_id, following, followers_count }` |
| `POST /api/share/{slug}/like` | Bật/tắt lượt thích (`release_likes`) trên trang Showcase công khai `/share/:slug` | `{ likes_count, liked_by_me }` |
| `GET / POST / DELETE /api/share/{slug}/comments` | Đọc, đăng bình luận gắn mốc thời gian (`timestamp_sec`, `bar_number`, sắp theo giây) & xóa bình luận (chủ comment hoặc chủ release, guard `403`) | `{ items: ReleaseComment[], comments_count }` |
| `GET / POST / DELETE /api/studio/{id}/collab/session` | Kiểm tra phòng cộng tác, tạo mã mời `?collab=col_...` (`POST`) hoặc thu hồi link & đóng phòng WS (`DELETE`) | `{ active, room_code, members[] }` |
| `GET / POST / PATCH / DELETE /api/studio/{id}/comments` | Đọc, ghim **Pinned Bar Notes** (`bar_number`, `track_id`, `text`), đánh dấu `resolved` & xóa ghi chú theo ô nhịp (đồng thời phát WS `bar_comment_event`) | `{ items: StudioBarComment[] }` / `StudioBarComment` |
| `GET / POST / DELETE /api/projects/{id}/versions` & `/{verId}/restore` | Lưu **Named Version Checkpoints** (`project_versions`), liệt kê, khôi phục snapshot (`restore` phát đồng thời WS `state_sync`) & xóa checkpoint | `{ items: ProjectVersionSummary[] }` / `project_state` |
| `WS /ws/collab` | WebSocket cộng tác Studio realtime (`?projectId=&room=&token=&clientId=`, buffer `2 MB`): `room_snapshot` (`track_locks`, `chat_history`), `presence`, `track_lock` (tự nhả khi rớt WS), `room_chat`, `state_sync`, `transport_cue`, `bar_comment_event`, `ping`/`pong` | Frame JSON realtime hai chiều giữa các peer cùng phòng |
| `POST /api/projects/{id}/export/aimusic` | Đóng gói dự án thành file nhẹ `.aimusic` | Trả về binary stream `.aimusic` |
| `POST /api/projects/import` | Nạp file `.aimusic` vào Redis, CloudDB & Studio (mặc định UI `overwrite=false`, kiểm tra Zip Bomb & path traversal) | Form-data `.aimusic` + `overwrite` $\rightarrow$ `ProjectState` |
| `POST /api/projects/{id}/export/audio` | Render & Auto-Master (hỗ trợ `target_lufs` `-20..-8`, tiêu thụ daily Quota `429`; chặn `total_bars > 256` -> `400`) xuất `wav` / `mp3` (`192k` \| `320k` + ID3) / `flac` / `stems` (`.zip`) | `{ format: "wav" \| "mp3" \| "flac" \| "stems", bitrate, target_lufs?, title?, artist?, genre?, apply_mastering, mode }` |
| `POST /api/projects/{id}/export/midi` | Xuất file `.mid` đa track kèm Meta Events | Trả về binary `.mid` |

### 3.5. Hợp đồng Nội bộ Spring Boot $\leftrightarrow$ `audio-worker` (Cổng `8001`)
Spring Boot (`AudioWorkerClient.java`) gọi các endpoint nội bộ sau trên `AUDIO_WORKER_URL` (tự fallback sang `JavaAudioFallbackService` nếu worker offline):

| Method & Endpoint | Chức năng DSP nội bộ |
| :--- | :--- |
| `GET /health` | Trả trạng thái `audio-worker`, `ffmpeg_available`, `fluidsynth_available`, `soundfont_available`, `custom_soundfont_active` |
| `POST /internal/audio/denoise` | Lọc ồn (`noisereduce`), auto-trim khoảng lặng, kiểm tra ngưỡng ồn/clipping |
| `POST /internal/audio/analyze` | Trích xuất BPM (`40–220`), Key/Scale, chuỗi `raw_melody_midi` |
| `POST /internal/audio/autotune` | Chỉnh phô theo `key`, `scale`, `retune_speed_ms`, `humanize`, `mix_percent` |
| `POST /internal/audio/render` | Tổng hợp MIDI + Vocal thành audio mix qua `FluidSynth` (Default / Custom `.sf2`) / built-in synth |
| `POST /internal/audio/export` | Render `wav` / `mp3` (ID3 tags) / `flac` (Vorbis/FFmpeg tags) / `stems` (`.zip`) với **Master Limiter $\le -1.0\text{ dBFS}$** |
| `POST /internal/audio/overdub-fit-check` | Phân tích `timing_offset_ms`, `pitch_issues`, `gain_suggestion` cho clip thu đè |
| `POST /internal/audio/separate-stems` | Tách stem `vocal.wav` + `beat.wav` qua `librosa` HPSS / Mid-Side / Bandpass |
| `POST /internal/audio/soundfont` | Nạp & xác thực SoundFont `.sf2` (`RIFF`/`sfbk`, `<= 50 MB`) cho `FluidSynth` |

---

## 4. Cấu trúc Chuẩn của File Dự án `.aimusic`

File `.aimusic` thực chất là một gói nén **ZIP** đổi phần mở rộng nhằm đảm bảo gọn nhẹ (`1–3 MB`), dễ sao lưu và mở lại độc lập trên mọi phiên bản:

```text
my-song.aimusic (ZIP container)
├── manifest.json          # { "schema_version": "1.0", "app": "ai-music-studio", "created_at": "..." }
├── project.json           # Toàn bộ Shared Project State (Config, BPM, Key, Chords, Lyrics, MIDI Tracks, Mixer)
└── audio/
    ├── raw_input.wav      # Giọng thu gốc (hoặc .flac/.opus)
    ├── dry_denoised.wav   # Giọng mộc đã lọc ồn
    └── overdub_take1.wav  # Các clip thu đè (nếu có) — KHÔNG lưu WAV stems MIDI để tiết kiệm dung lượng (hỗ trợ cờ dry_same_as_raw chống trùng lặp)
```

> **Bảo mật & Giới hạn Vận hành (Phase 5):** Mọi response từ Spring Boot đều đính kèm Security Headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`); `CorsConfig` giới hạn local origins (`localhost`/`127.0.0.1`); upload được kiểm tra dung lượng trước khi đọc vào RAM (`55 MB` Servlet / `50 MB` overdub / `_read_upload_bounded` HTTP `413` trên worker) và `.aimusic` import từ chối Zip Bomb/path traversal (`..`).
