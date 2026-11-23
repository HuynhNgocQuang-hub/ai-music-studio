# Tài liệu Thiết kế Kiến trúc & Giao diện Hệ thống (`DESIGN_SPEC`)
## Dự án: AI Music Studio (Hybrid Multi-Agent DAW)

- **Phiên bản:** 2.0 (Option B Production + FL Playlist Clip Architecture + AI Chatbot 4 Modes)
- **Cập nhật lần cuối:** 2026-11-23
- **Liên kết tài liệu:** [REQUIREMENTS.md](./REQUIREMENTS.md) | [SRS.md](./SRS.md) | [API_AND_UI_SPEC.md](./API_AND_UI_SPEC.md) | [MULTI_AGENT_ARCHITECTURE.md](./MULTI_AGENT_ARCHITECTURE.md)

---

## 1. Kiến trúc Hệ thống Tổng thể (Option B — 4 Tiers)

```mermaid
flowchart LR
    subgraph Browser["Browser Client (:3000 React 19 + Vite)"]
        UI["Pages: Home / Create / Studio / Library / Settings"]
        WA["Web Audio Engine (player.ts: Multi-Track + EQ + FX Bus)"]
        IDB[("IndexedDB Draft & Audio Blob Store")]
    end

    subgraph Core["Core Backend (:8000 Java 21 Spring Boot 3.4)"]
        SEC["SecurityHeadersFilter + CorsConfig"]
        CTRL["REST & SSE Controllers (/api/*)"]
        ORCH["AgentOrchestrator (60s timeout, QA <= 2, 15m Eviction)"]
        LLM["LlmAdapter (Gemini 3.8 Flash + OpenAI + Mock)"]
        FB["JavaAudioFallbackService (WAV/MIDI/EQ/Limiter/.aimusic)"]
    end

    subgraph Worker["Audio DSP Service (:8001 Docker Python FastAPI)"]
        DSP["Denoise / Pitch Analyzer / Cepstral Auto-Tune"]
        REN["FluidSynth + Pedalboard Renderer & MP3/WAV/Stems Exporter"]
    end

    subgraph Cache["State Store (:16379 Docker Redis 7)"]
        RED[("Redis 7-alpine (256MB LRU, Project/Audio TTL, Undo x20)")]
    end

    subgraph Cloud["External Cloud LLM APIs"]
        GEM["Google Gemini API"]
        OAI["OpenAI API"]
    end

    UI <-->|"REST + SSE (/api proxy)"| SEC --> CTRL
    UI <--> IDB
    UI --> WA
    CTRL --> ORCH
    ORCH --> LLM
    LLM -.-> GEM
    LLM -.-> OAI
    CTRL <--> RED
    CTRL -->|"HTTP/1.1 Internal DSP"| DSP
    CTRL -->|"Render / Export"| REN
    CTRL -.->|"Worker offline fallback"| FB
```

---

## 2. Thiết kế Luồng Dữ liệu & Phục hồi (`Sequence Diagrams`)

### 2.1. Luồng Phối khí, Auto-Rehydrate TTL & Studio Loop

```mermaid
sequenceDiagram
    participant U as User / Browser
    participant IDB as IndexedDB
    participant BE as Spring Boot (:8000)
    participant RED as Redis (:16379)
    participant WRK as Audio Worker (:8001)

    U->>BE: POST /api/audio/upload (WAV <= 50MB)
    BE->>RED: Save ProjectState (24h TTL) & Audio (12h TTL)
    U->>IDB: Save local draft & raw Blob (every 7s / edits)
    U->>BE: POST /api/jobs/generate + GET /events (SSE)
    BE->>WRK: /internal/audio/analyze & autotune
    WRK-->>BE: BPM, Key, raw_melody_midi, tuned WAV
    BE-->>U: SSE (agent_step, qa_retry, completed + ProjectState)

    Note over U,RED: Neu mo lai Studio sau khi Redis Audio TTL het han:
    U->>BE: GET /api/audio/asset (404 / missing buffer)
    U->>IDB: Load raw & overdub Blobs
    U->>BE: Re-upload -> Denoise -> Autotune -> PUT /sync
    BE->>RED: Khoi phuc lai hot cache trong Redis
```

---

## 3. Thiết kế Mô hình Dữ liệu (`Shared Project State`)

```mermaid
erDiagram
    PROJECT_STATE ||--|| PROJECT_CONFIG : contains
    PROJECT_STATE ||--|| AUDIO_ASSETS : references
    PROJECT_STATE ||--|| PROJECT_ANALYSIS : has
    PROJECT_STATE ||--|| AUTOTUNE_SETTINGS : configures
    PROJECT_STATE ||--|| SONG_STRUCTURE : defines
    PROJECT_STATE ||--|| PROJECT_LYRICS : contains
    PROJECT_STATE ||--|| MASTERING_SETTINGS : applies
    PROJECT_STATE ||--o{ TRACK_STATE : owns

    SONG_STRUCTURE ||--o{ SONG_SECTION : splits
    SONG_STRUCTURE ||--o{ CHORD_EVENT : schedules
    PROJECT_LYRICS ||--o{ LYRIC_LINE : lines
    TRACK_STATE ||--o{ AUDIO_CLIP : audio_clips
    TRACK_STATE ||--o{ MIDI_NOTE : midi_notes
```

*Quy ước chính của Schema:*
- **`TrackState`** hỗ trợ cả `"audio"` (`clips[]`) và `"midi"` (`instrument`, `notes[]`), cùng dùng chung bộ Mixer + DSP (`volume`, `pan`, `low_db`, `mid_db`, `high_db`, `reverb_send`, `delay_send`, `mute`, `solo`, `locked`).
- **`SongSection`** (`name`, `start_bar`, `bars`, `energy`, `has_user_motif`) điều khiển cả bố cục phối khí của `ArrangerAgent`, phân khúc khung Pattern MIDI, lẫn làn **Dynamics Automation Envelope** kéo chỉnh trực tiếp trên Playlist.

---

## 4. Thiết kế Giao diện & Hệ thống Component Frontend

### 4.1. Code-Splitting & Cấu trúc Module React
- **`App.tsx`:** Nạp lười (`React.lazy` + `Suspense`) toàn bộ 5 route (`HomePage`, `CreatePage`, `StudioPage`, `LibraryPage`, `SettingsPage`), giữ main chunk `index` gọn quanh ~304 kB.
- **`ProjectProvider.tsx`:** Quản lý trạng thái dự án thống nhất, bộ bảo vệ bất đồng bộ **`saveSeqRef`** (chống stale save ghi đè), và đồng bộ 2 tầng `IndexedDB` + `/api/projects/{id}/sync`.
- **`StudioPage.tsx` & các Module con:**
  - `QuickStudioView.tsx`: Chế độ nghe thử gọn, đổi Genre/Mood/BPM và Regenerate 1 chạm.
  - `TimelineEditor.tsx` + `WaveformClipCanvas.tsx`: Playlist đa làn chuẩn **FL Studio 12 Clip Frame**.
  - `StepSequencer.tsx`: Lưới trống hỗ trợ `4/4` (16 bước) và `3/4` / `6/8` (12 bước).
  - `PianoRollEditor.tsx`: Bộ soạn nốt C1–C7, Scale highlight, Quantize, Velocity lane, Copy/Paste nốt.
  - `ConsoleMixerPanel.tsx`: Kênh trộn dọc 3-Band EQ, FX Send (`BUS A Reverb` + `BUS B Delay`), LED Meter và Master Bus.
  - `AiCoachChatDrawer.tsx`: Ngăn kéo **AI Music Chatbot** 4 chế độ kèm Quick Prompts, Provider badge, Overdub Fit Check và nút áp dụng 1 chạm.

### 4.2. Quy chuẩn Thẩm mỹ DAW & Khung Clip FL Studio 12
- **Bảng màu nền Hardware Dark:**
  - Studio Shell `#111317`, Sidebar `#16191f`, Panel `#1b1e25`, Lane nền phân cụm 4 ô nhịp `#1c2331` / `#131822`, đường chia Beat `rgba(255,255,255,0.045)`, Playhead xanh lá `#4ade80`.
- **Cấu trúc 3 loại Khung Clip trên Playlist (`17px Header + Thân bán trong suốt thấy lưới nhịp`):**
  1. **Audio Waveform (`Vocal`, `Overdub`, `Texture`):** Header màu đặc (`#3c9678` / `#aa4562` / `#4f679e`) + biểu tượng sóng `∿`; thân vẽ **đa giác sóng đối xứng liên tục** (`WaveformClipCanvas`) tối đa `480` mẫu kèm Fade-In/Out chéo và progress xanh khi phát.
  2. **Automation Envelope (`Dynamics`):** Header xanh thép (`#4a6592`) + icon spline `⟋`; thân vẽ đường cong SVG gradient thể hiện `section.energy` cùng chấm neo kéo trực tiếp (lưu qua Undo/Redo).
  3. **MIDI Pattern (`Drums`, `Bass`, `Harmony`, `Lead`):** Tự động cắt khung theo từng `SongSection` hoặc cụm 4 ô nhịp (tự gắn biến thể `#2`, `#3` khi họa tiết nốt đổi); header đặc (`#9d6f2c` / `#6e56a4` / `#4c76a8` / `#388680`) + icon Pattern + Piano Roll thu gọn bên trong.

---

## 5. Thiết kế AI Chatbot Đa Chế Độ & An Toàn Hệ Thống

### 5.1. Kiến trúc AI Music Chatbot (`4 Assistant Modes`)
- **4 chế độ chuyên biệt (`CoachAssistantMode`):**
  1. `producer`: Đánh giá cấu trúc tổng thể, BPM, đặt mô-típ Chorus, Overdub.
  2. `arrangement`: Gợi ý tiến trình hợp âm (`vi - IV - I - V`, ...), tái tạo track trống/bass/đệm.
  3. `lyricist`: Gợi ý lời Việt/Anh/Song ngữ khớp mật độ nốt/âm tiết, vần điệu Chorus/Verse.
  4. `mix`: Tư vấn EQ 3 băng tần, Auto-Tune preset, Send FX, Audio-Trim & Auto-Mix `-1.0 dBFS`.
- **Cơ chế An toàn (`Human-in-the-loop`):**
  - Chatbot chỉ trả về văn bản phân tích và mảng `suggested_actions[]` (`update_config`, `rearrange_chords`, `apply_autotune`, `auto_mix`, `auto_trim_vocal`, `suggest_lyrics`, `regenerate_track`).
  - Không bao giờ tự ý ghi đè `ProjectState` khi người dùng chưa bấm nút xác nhận trên bong bóng chat.
- **Model & Fallback Resilience (`LlmAdapter.java`):**
  - Mặc định gọi **`gemini-3.8-flash`** qua header `x-goog-api-key` (hỗ trợ cả key `AQ...` lẫn `AIza...`); nếu model cấu hình trả `404` sẽ tự fallback sang `gemini-3.8-flash`, và nếu chưa cấu hình API Key sẽ chạy bộ phân tích ngữ cảnh + Heuristic Intent Engine cục bộ.

### 5.2. Kiến trúc Phòng thủ Bảo mật (Local Hardening Layers)
- **Transport & Headers:** Cổng Docker `audio-worker` & `backend` bind về `127.0.0.1`; mọi HTTP response gắn `SecurityHeadersFilter` (`nosniff`, `DENY`, `no-referrer`, `Permissions-Policy`); `CorsConfig` giới hạn local origins.
- **Upload & DoS Bounds:** Kiểm tra `file.getSize()` trước khi đọc vào RAM (`<= 55 MB` Servlet, `_read_upload_bounded` `413` trên Python worker); kiểm soát Zip Bomb (`<= 64 entries`, `<= 60 MB/entry`, `<= 120 MB` tổng); chặn `total_bars > 256` (`HTTP 400`) trước khi cấp phát mảng render và lazy-allocate Reverb/Delay FX bus.
- **Bảo vệ Dữ liệu & Key:** Che toàn bộ key dạng `AIza...` / `sk-...` / `AQ...` / `key=...` trong thông báo lỗi HTTP ở `LlmAdapter`; import `.aimusic` mặc định `overwrite=false` tránh đè mất bài trùng ID.
