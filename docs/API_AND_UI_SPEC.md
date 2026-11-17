# Tài liệu Thiết kế Giao diện, Điều hướng & API Contract
## Dự án: AI Music Studio (Hybrid Multi-Agent)

- **Phiên bản:** 1.1 (Option B: React Vite + Java 21 Spring Boot + Python Audio-Worker)
- **Liên kết:** [SRS.md](./SRS.md) | [MULTI_AGENT_ARCHITECTURE.md](./MULTI_AGENT_ARCHITECTURE.md)
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

### 2.1. Thanh Menu Chính & Khung Ứng dụng (App Shell)
Giao diện dùng `react-router-dom` (`BrowserRouter`, `Routes`, `Route`) với **Sidebar Menu bên trái** (có thể thu gọn thành icon khi mở Studio để tăng diện tích làm nhạc) + **Thanh Trạng thái Auto-Save** ở góc trên:

| Menu Item | Route | Chức năng chính |
| :--- | :--- | :--- |
| **Trang chủ** | `/` | Điểm khởi đầu nhanh & tổng quan dự án. |
| **1. Tạo nhạc mới** | `/create` | Luồng từng bước (Wizard 4 bước) tối ưu cho người mới bắt đầu nhanh. |
| **2. Phòng thu (Studio)** | `/studio/:id` | Không gian DAW-lite đầy đủ (Timeline cắt ghép, Mixer, Piano Roll, Auto-Tune Pro, Overdub, AI Coach). |
| **3. Thư viện & Bản nháp** | `/library` | Quản lý dự án đang làm, bản tự lưu khi quên Save (`IndexedDB`), mở file `.aimusic` — có **tìm kiếm & phân trang**. |
| **4. Cài đặt & API** | `/settings` | Cấu hình Gemini/OpenAI API Key, chọn model cho từng Agent, kiểm tra sức khỏe Spring Boot / Audio Worker / Redis. |

> **Chuyển trang thông minh (Seamless Handoff):** Từ trang `/create` sau khi AI tạo xong bản nghe thử (Bước 4), người dùng bấm **"Mở trong Studio"** $\rightarrow$ điều hướng sang `/studio/:id` bằng `useNavigate()` mà giữ nguyên toàn bộ State trong `ProjectProvider`.

---

### 2.2. Thiết kế Chi tiết Từng Trang

#### Trang A: `/create` (`CreatePage.tsx`) — Quy trình Tạo nhạc Tối ưu (4-Step Wizard)
Chia thành **4 bước có thanh Stepper** cho phép quay lại bước trước bất kỳ lúc nào:
* **Bước 1 — Nhập & Làm sạch (`Input & Dry Check`):**
  * Tab chuyển giữa **Ghi âm Mic** (mã hóa thành `.wav` PCM chuẩn trước khi upload, kèm Count-in Metronome, Waveform) và **Upload File** (`.wav/.mp3/.m4a/.ogg/.flac`, tối thiểu `3s`, tối đa `50 MB`).
  * Nút bật/tắt **AI Denoise** + trình phát đối chiếu **Giọng mộc gốc** vs **Giọng mộc đã lọc ồn**.
  * Công cụ cắt ngắn đầu/cuối nhanh hoặc **AI Auto-Trim**.
* **Bước 2 — Phân tích & Auto-Tune nhanh (`Analyze & Tune`):**
  * Hiển thị thẻ kết quả: `BPM` (có Tap Tempo & nghe Metronome), `Key / Scale` (cho chỉnh tay nếu cần), số ô nhịp.
  * Thanh **Auto-Tune Quick Bar**: `Off` | `Nhẹ (Natural)` | `Vừa (Balanced)` | `Mạnh (Modern)` + nút nghe thử A/B ngay.
* **Bước 3 — Cấu hình AI & Phối khí (`Style & Generate`):**
  * Chọn **Chế độ giai điệu**: `Preserve Original` | `AI Enhance`.
  * Chọn **Đầu ra**: `Accompaniment Only` | `Full Song` (nếu chọn Full Song $\rightarrow$ chọn vị trí mô-típ: *Mặc định Chorus* / *Verse* / *AI đề xuất*, và bật/tắt *Lead Karaoke Guide + Gợi ý lời*).
  * Chọn **Genre**, **Mood**, nhập **Prompt** ngắn (tối đa 500 ký tự).
  * Khi bấm **Tạo nhạc**: Hiển thị tiến trình từng Agent đang chạy (`Analyzer -> Composer -> Arranger -> QA`) qua SSE kèm đồng hồ đếm ngược timeout `60s` và nút **Hủy (Cancel)**.
* **Bước 4 — Nghe thử nhanh (`Quick Preview`):**
  * Nút chuyển tức thì để nghe so sánh 4 lớp: **Giọng mộc + Beat** | **Auto-Tune + Beat** | **Bản Preserve** | **Bản Enhance**.
  * 2 hành động chính: **Tải nhanh (`MP3 / WAV`)** hoặc **Mở vào Hybrid Studio (`/studio/:id`)**.

#### Trang B: `/studio/:id` (`StudioPage.tsx`) — Hybrid AI Music Studio
Bố cục chia **4 vùng chuẩn DAW**:
1. **Top Transport Bar (Cố định trên cùng):**
   * `Play / Pause / Stop / Loop`, đồng hồ `Bar:Beat` & `mm:ss`, chỉnh `BPM` & `Key`, `Undo / Redo`.
   * Công cụ Timeline: `Con trỏ (Select)` | `Dao cắt (Split)` | `Snap Grid (1/4, 1/8, 1/16)`.
   * Chỉ báo **Auto-Save**, nút **Auto-Mix/Master**, nút **Save `.aimusic`**, nút **Export**.
2. **Vùng Trung tâm (Multi-Track Timeline & Chord Track):**
   * Hàng trên cùng: **Section Bar** (`Intro`, `Verse`, `Chorus`...) + **Chord Timeline** (bấm vào ô nhịp để sửa hợp âm).
   * Danh sách Track bên trái + Vùng **Clips** bên phải (cả **Audio Clips** và **MIDI Clips**).
   * Mỗi track có `Mute (M)`, `Solo (S)`, `Lock`, `Regenerate Track` (hoặc `Record Overdub` trên track Vocal để hát đè lên beat).
3. **Vùng Dưới (Tabbed Dock):**
   * **Tab 1 — `Mixer`:** Fader Volume (0–120%), Pan (L/R), Peak Meter từng track và Master Limiter (`<= -1.0 dBFS`).
   * **Tab 2 — `Piano Roll`:** Lưới chỉnh nốt MIDI cho track đang chọn.
   * **Tab 3 — `Auto-Tune Pro`:** Root, Scale, Retune Speed (`0–200ms`), Humanize, Mix %, Auto-Follow Project Key.
   * **Tab 4 — `Lyrics & Karaoke`:** Khung soạn lời chạy chữ theo nền beat + nút AI gợi ý lời theo đoạn.
4. **Panel Phải (`AI Music Coach & Fit Check`):**
   * Hiển thị phân tích tự động mỗi khi thu đè (`Overdub`) lên beat (lệch nhịp `±ms`, chênh tông, mức Gain) kèm nút **1-Click Apply**.
   * Khung chat hỏi đáp với **AI Coach** để xin gợi ý sửa lời, đổi hợp âm hoặc đặt mô-típ.

#### Trang C: `/library` (`LibraryPage.tsx`) — Thư viện Dự án & Phân trang (`Pagination`)
* **Thanh Bộ lọc & Tìm kiếm:** Tìm theo tên dự án, lọc theo **Genre**, **Key**, hoặc nguồn (**Bản nháp Auto-Save** | **Đã lưu**).
* **Phân trang (Pagination):**
  * Hiển thị **12 dự án / trang** (chọn nhanh `12 / 24 / 48` mục/trang), có nút `Trước / Sau`, số trang.
  * Khung **"Khôi phục phiên làm việc gần nhất"** nếu phát hiện bản nháp `IndexedDB` chưa lưu ra file.
* **Nút Import `.aimusic`:** Mở lại file dự án nhẹ đã xuất trước đó, kèm cảnh báo dung lượng `IndexedDB`.

#### Trang D: `/settings` (`SettingsPage.tsx`) — Cài đặt & Quản trị Hệ thống Cá nhân
* **Cấu hình Dual LLM:** Nhập/kiểm tra `Gemini API Key` và `OpenAI API Key`, chọn Provider mặc định và phân vai cho từng Agent (`Composer`, `Arranger`, `Lyricist`, `Coach`, `QA`) — gửi qua các header `X-Gemini-Api-Key`, `X-OpenAI-Api-Key`, `X-LLM-Provider`.
* **Trạng thái Hạ tầng (`/api/health`):** Đèn báo kết nối `Spring Boot Backend`, `Audio Worker (Python DSP)`, `Redis (backend mode)`, `FFmpeg / FluidSynth / SoundFont` và `LLM Providers`.

---

## 3. Hợp đồng API Public (`Spring Boot` `/api/*`) & Internal Worker (`/internal/audio/*`)

### 3.1. Nhóm Health, Audio Input, Denoise & Auto-Tune
| Method & Endpoint | Mục đích | Payload / Output chính |
| :--- | :--- | :--- |
| `GET /api/health` | Kiểm tra sức khỏe Backend, Redis, Audio Worker, Engines, LLM | `{ status, redis: { backend, connected }, audio_worker, engines, llm_providers }` |
| `POST /api/audio/upload` | Tải hoặc gửi bản thu Mic WAV lên Backend | Form-data audio $\rightarrow$ `project_id`, `raw_input_ref`, `filename`, `duration_sec`, `warnings` |
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
| `POST /api/jobs/rearrange` | Cập nhật nhạc đệm theo Chord Timeline mới | `{ project_id, chords, locked_tracks }` $\rightarrow$ `job_id` |
| `GET /api/jobs/{jobId}/events` | **SSE Stream** (`SseEmitter`) đẩy tiến trình từng Agent | Event: `agent_step`, `qa_retry`, `progress`, `completed`, `fallback_warning`, `error` |
| `POST /api/jobs/{jobId}/cancel` | Hủy job đang chạy ngay lập tức | `{ status: "cancelled" }` |

### 3.3. Nhóm Studio, Overdub Fit Check, Lyrics & Coach
| Method & Endpoint | Mục đích | Payload / Output chính |
| :--- | :--- | :--- |
| `POST /api/studio/overdub-fit-check` | Upload clip thu đè lên beat & chạy AI Fit Check | Trả về `timing_offset_ms`, `pitch_issues[]`, `gain_suggestion`, danh sách **1-Click Fixes** |
| `POST /api/lyrics/suggest` | Sinh/gợi ý lời bài hát khớp đoạn & tiết tấu | `{ project_id, language, topic, section }` $\rightarrow$ `lines[]` |
| `POST /api/coach/chat` | Hỏi đáp AI Music Coach (kèm ngữ cảnh State) | `{ project_id, message, history }` $\rightarrow$ `reply`, `suggested_actions[]` |

### 3.4. Nhóm Persistence, Sync & Export
| Method & Endpoint | Mục đích | Payload / Output chính |
| :--- | :--- | :--- |
| `GET /api/projects` | Lấy danh sách dự án từ Redis có **phân trang & lọc** | Query: `?page=1&limit=12&search=&genre=` $\rightarrow$ `{ items, total, page, total_pages }` |
| `GET /api/projects/{id}` | Lấy chi tiết 1 `ProjectState` theo ID | `ProjectState JSON` |
| `PUT /api/projects/{id}/sync` | Đồng bộ `ProjectState` từ `IndexedDB` lên Redis | Body: `ProjectState JSON` |
| `POST /api/projects/{id}/export/aimusic` | Đóng gói dự án thành file nhẹ `.aimusic` | Trả về binary stream `.aimusic` |
| `POST /api/projects/import` | Nạp lại file `.aimusic` vào Redis & Studio | Form-data `.aimusic` $\rightarrow$ `ProjectState` |
| `POST /api/projects/{id}/export/audio` | Render & Auto-Master xuất `wav` / `mp3` / `stems` (`.zip`) | `{ format: "wav" | "mp3" | "stems", apply_mastering: true, mode }` |
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
    └── overdub_take1.wav  # Các clip thu đè (nếu có) — KHÔNG lưu WAV stems MIDI để tiết kiệm dung lượng
```
