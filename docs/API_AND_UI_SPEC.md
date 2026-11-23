# Tài liệu Thiết kế Giao diện, Điều hướng & API Contract
## Dự án: AI Music Studio (Hybrid Multi-Agent)

- **Phiên bản:** 1.6 (Pro DAW Workstation + SRS Full Compliance + Phase 5 Production Optimization & Security Hardening)
- **Liên kết:** [SRS.md](./SRS.md) | [MULTI_AGENT_ARCHITECTURE.md](./MULTI_AGENT_ARCHITECTURE.md) | [TASK_BOARD.md](./TASK_BOARD.md)
- **Mục tiêu:** Đặc tả kiến trúc điều hướng (Menu, Chuyển trang, Phân trang), bố cục tối ưu cho từng màn hình, hợp đồng API giữa Frontend (`React + Vite`) – Core Backend (`Java 21 + Spring Boot 3.x`) – Audio DSP Microservice (`audio-worker`) – Redis, và cấu trúc file dự án `.aimusic`.

---

## 1. Kiến trúc Hạ tầng Tối ưu cho Máy Cá nhân (Node + Java 21 + Docker)

Dựa trên cấu hình thực tế (**Node.js v24**, **Java 21 + Maven 3.9+**, **Docker**):

* **Frontend (`React 19 + Vite`):** Chạy bằng **Node.js v24** (cổng `3000`, hot-reload tức thì), cấu hình `vite.config.ts` proxy `/api` $\rightarrow$ `http://localhost:8000` (hoặc cấu hình `VITE_API_BASE_URL`); sử dụng `IndexedDB` trình duyệt để tự động lưu ngầm.
* **Core Backend (`Java 21 + Spring Boot 3.x`, cổng `8000`):** Xử lý toàn bộ API `/api/*`, SSE (`SseEmitter`), `Spring Data Redis` (kèm In-Memory TTL fallback), Multi-Agent Orchestrator, Dual LLM Adapter (`Gemini` + `OpenAI` + Mock), xuất/nhập `.mid` & `.aimusic`, và cung cấp `JavaAudioFallbackService` khi `audio-worker` không chạy.
* **Audio DSP Microservice (`audio-worker/`, Python FastAPI cổng `8001`) & `Redis` (`redis:7-alpine`):** Đóng gói gọn trong **Docker Compose** (chứa `redis:7-alpine` giới hạn `maxmemory 256mb` + `allkeys-lru`, `audio-worker` xử lý DSP với `FFmpeg`, `FluidSynth`, `noisereduce`, `librosa`, `pedalboard` — không cài PyTorch/TensorFlow nặng máy, và container `backend` kết nối qua `AUDIO_WORKER_URL=http://audio-worker:8001`).
* **SoundFont gọn nhẹ:** Nhúng 1 bộ SoundFont General MIDI nhẹ (`GeneralUser-GS.sf2` hoặc tương đương) bên trong `audio-worker` thay vì các thư viện VST hàng GB.
* **LLM Cloud API:** Toàn bộ Agent trí tuệ gọi qua **Gemini API** hoặc **OpenAI API** (0 GB trọng số model trên đĩa).

---

## 2. Kiến trúc Điều hướng, Menu & Bố cục Màn hình (UI/UX Navigation)

### 2.1. Thanh Activity Rail & Khung Ứng dụng (App Shell)
Giao diện dùng `react-router-dom` (`BrowserRouter`, `Routes`, `Route`) với **Pro DAW Activity Rail** gọn bên trái (ẩn bớt header phụ khi vào `/studio/:id` để nhường trọn 100% chiều cao cho Timeline + Production Dock), kèm nút tạo nhanh **Blank DAW** (`+`) và banner khôi phục bản nháp `IndexedDB`:

| Menu Item | Route | Chức năng chính |
| :--- | :--- | :--- |
| **Trang chủ (Project Hub)** | `/` | Khởi tạo 1-click từ Starter DAW Templates (`Pop`, `Lo-fi`, `Trap 808`, `House`, `Ballad`, `Blank Studio`) & Recent Sessions (mở/xóa). |
| **1. AI Hum-to-Music** | `/create` | Luồng từng bước (Wizard 4 bước) ghi âm/upload vocal để AI phối khí & tạo bài hoàn chỉnh. |
| **2. Phòng thu DAW** | `/studio/:id` | Không gian Pro DAW đầy đủ (Arrangement, Step Sequencer, Piano Roll, Console Mixer EQ/FX Bus, Auto-Tune DSP, Lyrics CRUD, AI Coach). |
| **3. Kho Session (`.aimusic`)** | `/library` | Quản lý Local Draft (`IndexedDB`) & Server Saved Sessions (tạo mới, nhân bản, xóa máy chủ, tìm kiếm, phân trang `12/24/48`, import `.aimusic`). |
| **4. Audio Engine & API** | `/settings` | Cấu hình Gemini (`AQ...`/`AIza...`) / OpenAI API Key, phân vai Agent, nút **Test API Key**, kiểm tra trạng thái Spring Boot / Redis / FluidSynth & dọn cache. |

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

#### Trang B: `/studio/:id` (`StudioPage.tsx` + `QuickStudioView.tsx` + `ConsoleMixerPanel.tsx`) — Pro DAW Workstation & Quick/Pro Switcher
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
4. **Panel Phải (`AI Music Coach & Fit Check`):**
   * Hiển thị phân tích tự động mỗi khi thu đè (`Overdub`) lên beat (lệch nhịp `±ms`, chênh tông, mức Gain) kèm nút **1-Click Apply**.
   * Khung chat hỏi đáp với **AI Coach** kèm Quick Actions áp dụng ngay vào DAW State.

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
| `GET /api/health` | Kiểm tra sức khỏe Backend, Redis, Audio Worker, Engines, LLM | `{ status, redis: { backend, connected }, audio_worker, engines, llm_providers }` |
| `POST /api/health/llm-test` | Kiểm tra kết nối API Key Gemini/OpenAI theo header hiện tại | `{ ok, is_mock, provider, model, latency_ms, message }` |
| `POST /api/settings/cache/clear` | Dọn cache tạm trong Backend State Store | `{ status: "cleared", cleared_assets }` |
| `POST /api/audio/upload` | Tải hoặc gửi bản thu Mic WAV lên Backend | Form-data audio $\rightarrow$ `project_id`, `raw_input_ref`, `filename`, `duration_sec`, `warnings` |
| `POST /api/audio/clip-upload` | Tải clip overdub / sample phụ lên track `vocal` hoặc `texture` | Form-data audio + `project_id`, `track_id`, `start_bar` $\rightarrow$ `project_state`, `clip`, `audio_ref` |
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
| `POST /api/studio/overdub-fit-check` | Upload clip thu đè lên beat & chạy AI Fit Check | Trả về `timing_offset_ms`, `pitch_issues[]`, `gain_suggestion`, danh sách **1-Click Fixes** |
| `POST /api/lyrics/suggest` | Sinh/gợi ý lời bài hát khớp đoạn & tiết tấu | `{ project_id, language, topic, section }` $\rightarrow$ `lines[]` |
| `POST /api/coach/chat` | Hỏi đáp AI Music Coach (kèm ngữ cảnh State) | `{ project_id, message, history }` $\rightarrow$ `reply`, `suggested_actions[]` |

### 3.4. Nhóm Persistence, CRUD, Sync & Export
| Method & Endpoint | Mục đích | Payload / Output chính |
| :--- | :--- | :--- |
| `GET /api/projects` | Lấy danh sách dự án từ Redis có **phân trang & lọc** | Query: `?page=1&limit=12&search=&genre=` $\rightarrow$ `{ items, total, page, total_pages }` |
| `GET /api/projects/{id}` | Lấy chi tiết 1 `ProjectState` theo ID | `ProjectState JSON` |
| `PUT /api/projects/{id}/sync` | Đồng bộ `ProjectState` (gồm `low_db`, `mid_db`, `high_db`, `reverb_send`, `delay_send` trên từng track) | Body: `ProjectState JSON` |
| `POST /api/projects/{id}/undo` | Khôi phục snapshot trước đó từ Undo stack (20 bước) | `ProjectState JSON` |
| `DELETE /api/projects/{id}` | Xóa hẳn Project khỏi Redis/In-Memory Store | `{ status: "deleted", project_id }` |
| `POST /api/projects/{id}/export/aimusic` | Đóng gói dự án thành file nhẹ `.aimusic` | Trả về binary stream `.aimusic` |
| `POST /api/projects/import` | Nạp file `.aimusic` vào Redis & Studio (mặc định UI `overwrite=false` chống ghi đè, kiểm tra Zip Bomb & path traversal) | Form-data `.aimusic` + `overwrite` $\rightarrow$ `ProjectState` |
| `POST /api/projects/{id}/export/audio` | Render & Auto-Master (áp dụng EQ + Vocal Carve 2.2 kHz + Send FX Bus + Limiter; chặn `total_bars > 256` -> `400`) xuất `wav` / `mp3` (`192k` \| `320k`) / `stems` (`.zip`) | `{ format: "wav" | "mp3" | "stems", bitrate: "320k" | "192k", apply_mastering: true, mode }` |
| `POST /api/projects/{id}/export/midi` | Xuất file `.mid` đa track kèm Meta Events | Trả về binary `.mid` |

### 3.5. Hợp đồng Nội bộ Spring Boot $\leftrightarrow$ `audio-worker` (Cổng `8001`)
Spring Boot (`AudioWorkerClient.java`) gọi các endpoint nội bộ sau trên `AUDIO_WORKER_URL` (tự fallback sang `JavaAudioFallbackService` nếu worker offline):

| Method & Endpoint | Chức năng DSP nội bộ |
| :--- | :--- |
| `GET /health` | Trả trạng thái `audio-worker`, `ffmpeg_available`, `fluidsynth_available`, `soundfont_available` |
| `POST /internal/audio/denoise` | Lọc ồn (`noisereduce`), auto-trim khoảng lặng, kiểm tra ngưỡng ồn/clipping |
| `POST /internal/audio/analyze` | Trích xuất BPM (`40–220`), Key/Scale, chuỗi `raw_melody_midi` |
| `POST /internal/audio/autotune` | Chỉnh phô theo `key`, `scale`, `retune_speed_ms`, `humanize`, `mix_percent` |
| `POST /internal/audio/render` | Tổng hợp MIDI + Vocal thành audio mix qua `FluidSynth` / built-in synth |
| `POST /internal/audio/export` | Render `wav` / `mp3` / `stems` (`.zip`) với **Master Limiter $\le -1.0\text{ dBFS}$** |
| `POST /internal/audio/overdub-fit-check` | Phân tích `timing_offset_ms`, `pitch_issues`, `gain_suggestion` cho clip thu đè |

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
