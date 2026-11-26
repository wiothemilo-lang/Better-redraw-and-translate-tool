# Nixio (Khung Thoại)

Công cụ biên tập, xóa chữ (redraw), OCR, dịch thuật và dàn thoại truyện tranh/manga chạy trên **trình duyệt Web** và **ứng dụng Desktop (Electron + lõi xử lý ảnh C#/.NET 10 tự chứa)**.

Dự án được xây dựng độc lập sau khi khảo sát luồng công khai của Lilyzono, kết hợp kỹ thuật phục hồi kết cấu Multi-Scale PatchMatch Inpaint (tham khảo kiến trúc PhotoCraft) và kiến trúc Trợ lý AI Agent Harness v2 (học hỏi & tối ưu từ DeepSeek Harness). Xem thêm [ANALYSIS.md](ANALYSIS.md), [DESIGN.md](DESIGN.md) và [native/README.md](native/README.md).

---

## Tính năng chính

| Nhóm | Bản Web | Bản Desktop (Electron + C#/.NET 10) |
|---|---|---|
| Biên tập khung thoại, co giãn 8 tay cầm (kể cả khung xoay), xoay theo nấc 15°, chọn nhiều khung & căn hàng 6 hướng / chia đều khoảng cách, hút lưới tự động, **Chấm bong bóng thoại tự động** (`bubble`), zoom 25%–400%, kéo bàn vẽ, so sánh ảnh gốc | Có | Có |
| Dàn chữ nâng cao (viền chữ `stroke`, đổ bóng `shadow`, đậm/nghiêng/IN HOA/chữ dọc, **dàn chữ ôm bong bóng bầu dục**, **uốn chữ SFX** vòng cung/lượn sóng, giãn dòng `0.8–2.2`, hình nền chữ nhật/bầu dục/bo góc, tự khớp cỡ chữ cho khung/trang, nạp & tự lưu font `.ttf`/`.otf`/`.woff`/`.woff2` vào IndexedDB) | Có | Có |
| Cọ retouch thủ công (Hút màu, Cọ vẽ che chữ, Cọ sao chép nền Clone Stamp, **Cọ tẩy chữ thông minh Inpaint**, **Cọ tẩy nét redraw**, **Làm sạch ảnh Raw tự động**, hoàn tác nét cọ gần nhất, cache offscreen) & mặt nạ vùng xóa | Có (Inpaint JS Fast-Marching + Làm sạch raw JS) | Có (**Inpaint C# Multi-Scale PatchMatch + Poisson Seamless Blending**, **Làm sạch ảnh raw C#** & mặt nạ C# tăng tốc) |
| Xóa chữ tự động (Redraw) | Nền giấy sáng trơn trên Canvas + Cọ Inpaint JS | Nền trơn, nền chuyển sắc, screentone lặp (chu kỳ ≤ 32 px, kể cả screentone chuyển sáng), bảo vệ nét vẽ cắt biên + Cọ Inpaint C# |
| Dịch & ghép kịch bản bằng **Gemini API** hoặc **OpenAI-compatible / Local LLM** (Ollama, LM Studio, Hy-MT2, OpenRouter) + **Dịch các khung chữ đang có** (không cần model Vision) | Có | Có (cho phép kết nối HTTPS và HTTP loopback `localhost`/`127.0.0.1`) |
| **Trợ lý AI · Agent Harness v2.5** (ngữ cảnh trực tiếp `<system-reminder>`, quy chuẩn biên tập, **Hồ sơ kỹ năng theo thể loại**, **thẻ hỏi trắc nghiệm `ask_user`**, **duyệt thao tác hàng loạt**, Todo tiến độ, **Plan Mode**, **lệnh nhanh `/qc`, `/plan`, `/autofit`, `/compact ai`**, chống lặp công cụ & tự thử lại 429/503, lưu lịch sử chat theo dự án, **Web Search** & 19 công cụ) | Có (Wikipedia CORS / Tavily / SearXNG) | Có (DuckDuckGo + Jisho + Wikipedia không cần key qua IPC chống SSRF, hoặc Tavily / SearXNG) |
| **Kiểm tra cập nhật & Trung tâm Thông báo** (kiểm tra GitHub Releases theo SemVer 2.0, ghi chú phát hành, bỏ qua phiên bản; toast có nút 1 chạm cho tràn chữ / nhắc lưu / hoàn tác AI / trạng thái mạng) | Có | Có (qua Electron IPC bảo mật & mở liên kết HTTPS ngoài) |
| OCR cục bộ offline (Tesseract, tiền xử lý phóng lớn/giảm nhiễu/xoay 0–270°, chữ dọc Nhật `jpn_vert`, gom dòng & cửa sổ duyệt kết quả có độ tin cậy) | — | Có |
| Tìm & thay thế toàn chương, xuất kịch bản (`TXT` / `CSV` / `JSON`), rà trước khi xuất (Preflight) | Có | Có |
| Lưu / mở dự án `.khungthoai` v2 (tương thích ngược v1) & tự lưu phục hồi | Tự lưu IndexedDB mỗi 20 giây & khi ẩn tab | Dự án gần đây + tối đa 10 mốc tự lưu theo từng dự án, giữ bản `.bak`, tự lưu khi đóng app |
| Xuất tệp | PNG, PSD lớp chữ (kèm Photoshop Layer Style `stroke`/`dropShadow`), PSD lớp ảnh, ZIP | Như Web + ghép & xuất PNG/ZIP trực tiếp bằng C# kèm bảng Tác vụ tiến độ & Hủy |

---

## Cài đặt bản phát hành chính thức (Windows & Linux)

Tải bộ cài tích hợp sẵn runtime **.NET 10** tự chứa tại trang [GitHub Releases](https://github.com/wiothemilo-lang/Nixio/releases):

| Hệ điều hành | Tệp phát hành | Cách cài đặt |
|---|---|---|
| **Windows 10 / 11 (x64)** | `Khung-Thoai-*-win-x64-setup.exe` | Chạy trình cài đặt Inno Setup (không cần quyền Admin mặc định, tự liên kết tệp `.khungthoai`) |
| **Windows 10 / 11 (Portable)** | `Khung-Thoai-*-win-x64-portable.zip` | Giải nén và mở `Khung-Thoai.exe` |
| **Ubuntu / Debian / Mint / Pop!_OS (x64)** | `khung-thoai_*_amd64.deb` | `sudo apt install ./khung-thoai_*_amd64.deb` *(tương thích cả Debian 11/12 và Ubuntu 22.04/24.04 `t64`)* |
| **Fedora Linux (x64)** | `khung-thoai-*-1.x86_64.rpm` | `sudo dnf install ./khung-thoai-*-1.x86_64.rpm` |
| **Linux khác (Portable x64)** | `khung-thoai-*-linux-x64.tar.gz` | Giải nén và chạy `./Khung-Thoai` |

> **OCR cục bộ offline (tùy chọn)**: cài thêm Tesseract cho hệ điều hành của bạn:
> - **Ubuntu / Debian**: `sudo apt install tesseract-ocr tesseract-ocr-eng tesseract-ocr-jpn tesseract-ocr-jpn-vert`
> - **Fedora**: `sudo dnf install tesseract tesseract-langpack-eng tesseract-langpack-jpn tesseract-langpack-jpn_vert`
> - **Windows 10 / 11**: `winget install UB-Mannheim.TesseractOCR` (hoặc tải từ [UB-Mannheim Tesseract](https://github.com/UB-Mannheim/tesseract/wiki))

Kiểm tra toàn vẹn tệp tải về bằng `SHA256SUMS.txt` đi kèm bản phát hành (`sha256sum -c SHA256SUMS.txt`).

---

## Yêu cầu & Chạy từ mã nguồn

Yêu cầu **Node.js 22.12+** (CI chạy **Node.js 24 LTS**). Để biên dịch lõi xử lý ảnh C# trên desktop cần thêm **.NET 10 SDK** (và **Tesseract** nếu dùng OCR cục bộ).

```sh
git clone https://github.com/wiothemilo-lang/Nixio.git
cd Nixio
npm ci
```

### Chạy bản Web

```sh
npm run dev       # Chạy máy chủ phát triển Vite
npm run build     # Build bản production vào dist/
npm run preview   # Xem trước bản production
```

### Chạy & đóng gói App Desktop (Electron + C#)

```sh
npm run desktop:native                  # Biên dịch lõi C# (.NET 10 SDK) vào native/out/
npm run desktop                         # Build web và mở app Electron
npm run desktop:package -- linux-x64    # Đóng gói Electron + runtime .NET vào desktop-dist/
npm run desktop:package -- win-x64      # Tương tự cho Windows x64
```

Tạo gói cài đặt phát hành (`.deb`, `.rpm`, `.tar.gz` trên Linux; `.exe` Inno Setup 6 & `.zip` trên Windows — kết quả nằm trong `release-dist/`):

```sh
npm run desktop:release -- linux-x64    # Yêu cầu dpkg-deb, rpmbuild, tar
npm run desktop:release -- win-x64      # Yêu cầu Inno Setup 6 (ISCC.exe)
```

---

## Cấu trúc mã nguồn

```text
Nixio/
├── index.html                  # Giao diện chính, hộp thoại, khung Trợ lý AI & Trung tâm Thông báo
├── src/
│   ├── main.js                 # Điểm khởi chạy trình biên tập, phím tắt, cập nhật & thông báo ngữ cảnh
│   ├── style.css               # Hệ thống giao diện
│   ├── canvas.js, tools.js     # Render khung thoại, viền/bóng/dọc, auto-fit, căn hàng, xuất PSD Layer Style
│   ├── bubble.js               # Flood-fill chấm bong bóng thoại tự động
│   ├── cleanup.js, redraw.js   # Mặt nạ vùng xóa chữ và hàng đợi redraw ưu tiên
│   ├── retouch.js, inpaint.js  # Hút màu, cọ vẽ/sao chép nền, cache retouch & Inpaint JS fallback
│   ├── gemini.js, openai-compat.js, translation.js  # Dịch ảnh/khung thoại Gemini & Local/OpenAI LLM
│   ├── agent-context.js, agent-harness.js, agent-pipeline.js, agent-tools.js  # Agent Harness v2 (18 công cụ)
│   ├── web-search.js           # Client tìm kiếm web & chuẩn hóa nội dung an toàn
│   ├── notifications.js        # NotificationStore & Trung tâm Thông báo + Toast có nút hành động
│   ├── updater.js              # Kiểm tra cập nhật SemVer 2.0 (Web & Desktop)
│   ├── project.js, history.js, web-storage.js, fonts.js, io.js, library.js, ocr.js, placement.js, native.js
│   └── controllers/            # chat, dialogs, export, gestures, ocr, project, tasks, translation
├── desktop/
│   ├── main.cjs, preload.cjs   # Tiến trình chính Electron, CSP, IPC bảo mật & mở liên kết HTTPS ngoài
│   ├── native-worker.cjs, worker.cjs, task-queue.cjs, project-files.cjs, recovery-catalog.cjs
│   ├── web-search.cjs          # DuckDuckGo + Jisho + Wikipedia + Tavily/SearXNG (chống SSRF & HTML ẩn)
│   ├── updater.cjs             # Kiểm tra GitHub Releases API phía tiến trình chính
│   └── assets/icon.svg         # Icon vector ứng dụng
├── native/                     # Lõi xử lý ảnh & lưu trữ C#/.NET 10 (KhungThoai.Redraw.csproj)
│   ├── PatchMatchInpaint.cs    # Multi-Scale PatchMatch + EM Voting + Colour Adaptation
│   ├── TextureRedraw.cs, GradientRedraw.cs, NativeImaging.cs, LocalOcr.cs, ProjectStorage.cs, NativeRpc.cs
├── scripts/
│   ├── desktop-build.mjs       # Build native C# + Vite + @electron/packager
│   ├── package-release.mjs     # Đóng gói .deb / .rpm / .tar.gz / .zip / Inno Setup .exe
│   ├── desktop-smoke.mjs       # Kiểm thử E2E Playwright cho bản Electron đóng gói
│   └── benchmark.mjs           # Đối chứng chất lượng redraw/OCR
├── test/                       # 23 bộ unit test & integration test (Node.js test runner)
└── .github/workflows/
    ├── verify.yml              # CI build, test C#/Node, benchmark & smoke test trên Linux + Windows
    └── release.yml             # CD tự động đóng gói & xuất bản GitHub Release khi gắn tag v*.*.*
```

---

## Hướng dẫn sử dụng công cụ

### 1. Trang truyện, kịch bản và dàn thoại
1. Thêm tối đa **50 ảnh** `PNG`, `JPEG` hoặc `WebP` (≤ 28 MP/ảnh). Kéo thả hoặc dùng nút `↑` / `↓` để sắp xếp thứ tự trang.
2. Dán lời thoại hoặc nhập tệp `TXT` (UTF-8), `DOCX` hoặc `XLSX` tối đa 2 MB (hỗ trợ ngắt dòng/tab trong DOCX, bỏ qua chú âm `<rPh>` trong XLSX). Dùng tiêu đề như `Trang 1`, `[ Trang 1 ]` hoặc `[anh-01.png]` để chỉ định trang; với XLSX hàng đầu có thể dùng cột `Page` và `Translation`.
3. Chọn hướng đọc (`Phải sang trái` / `Trái sang phải`) và bấm **Dàn thoại lên ảnh**. Câu không khớp trang hoặc vượt giới hạn tự động đưa vào mục **Chưa đặt**.
4. Dùng **Xuất kịch bản** để xuất toàn bộ thoại của chương ra **TXT** (nhập lại được ngay), **CSV (UTF-8 BOM cho Excel)** hoặc **JSON**.

### 2. Dàn chữ nâng cao, điều hướng và chỉnh khung trực tiếp
- **Thao tác trực tiếp trên ảnh**:
  - Bấm **+ Khung chữ** rồi bấm/kéo trên ảnh (hoặc nhấn `Enter` khi ảnh đang lấy tiêu điểm), hoặc dùng công cụ **Chấm bong bóng tự động** (`bubble`) để bấm 1 chạm vào bên trong bong bóng thoại sáng và tự động tạo khung vừa khít viền bong bóng.
  - Chọn khung để kéo di chuyển (có **hút lưới tự động** vào tâm trang và cạnh/tâm các khung lân cận; giữ `Alt` để tạm tắt), kéo **8 tay cầm co giãn** (hỗ trợ chuẩn cả khung đang xoay), hoặc kéo **tay cầm xoay** phía trên (giữ `Shift` để xoay theo nấc 15°).
  - **Chọn nhiều khung (`Shift + bấm`)**: Kéo di chuyển cả nhóm, căn hàng 6 hướng (`Trái`, `Giữa ngang`, `Phải`, `Trên`, `Giữa dọc`, `Dưới`), chia đều khoảng cách (`Chia ngang`, `Chia dọc`), **Khớp cỡ chọn**, áp dụng mẫu hoặc xóa hàng loạt.
  - **Thu phóng 25%–400%** bằng nút `−`/`+`, `Ctrl + cuộn chuột` hoặc chuyển nhanh `Vừa trang` / `Kích thước gốc`.
  - **Kéo bàn vẽ (Pan)** bằng công cụ `Kéo bàn vẽ (Hand)`, giữ `Space + kéo` hoặc kéo chuột giữa.
  - Bấm **So sánh gốc** (phím `\`) để ẩn nhanh lớp redraw và chữ nhằm đối chiếu bản raw.
- **Tùy biến kiểu chữ & xem trước trực tiếp**:
  - Chỉnh **Nội dung**, **Font** (hỗ trợ **+ Nạp font** `.ttf`, `.otf`, `.woff`, `.woff2` từ máy và tự động lưu/khôi phục từ IndexedDB ở các lần mở sau), **Đậm / Nghiêng / IN HOA / Chữ dọc**, **Cỡ chữ**, **Giãn dòng (`0.8–2.2`)**, **Màu chữ**, **Canh chữ**, **Góc xoay**, **Viền chữ (stroke)**, **Đổ bóng (shadow)** và **Hình nền** (`Chữ nhật`, `Bầu dục`, `Bo góc`) kèm **Màu nền**. Mọi thay đổi đều xem trước trực tiếp trên ảnh.
  - Bấm **Khớp cỡ** hoặc **Khớp cỡ chữ cả trang** để tự chọn cỡ chữ lớn nhất không tràn khung.
  - Dùng **Nhân bản** (`Ctrl/Cmd+D`), **↑ / ↓ Lớp** (đổi thứ tự Z-index) và **Mẫu dàn chữ** để lưu/áp dụng nhanh bộ kiểu cho khung, trang hoặc cả chương.

### 3. Xóa chữ tự động & công cụ Retouch thủ công
- **Xóa chữ tự động**: Bật **Xóa chữ gốc trong khung**. Dùng **Khoanh vùng xóa** để tách vùng xóa khỏi vị trí khung chữ; dùng **Cọ giữ nền gốc** và **Cọ thêm vùng xóa** để tô mặt nạ bảo vệ nét vẽ; chỉnh **Nới / thu mặt nạ (`-8..8 px`)** trên desktop; bấm **Đặt lại vùng xóa** để quay về mặc định.
- **Vẽ che & sao chép nền thủ công**:
  - **Hút màu (`eyedropper`)**: Bấm vào ảnh để lấy mã màu RGB chính xác cho cọ vẽ (`Shift + bấm` để đổi màu chữ khung đang chọn).
  - **Cọ vẽ che chữ (`paint`)**: Tô màu và độ đục tùy chỉnh trực tiếp lên lớp redraw.
  - **Cọ sao chép nền (`clone`)**: Giữ `Alt + bấm` vào vùng nền/screentone sạch để đặt điểm nguồn, sau đó kéo tô lên chữ cần che.
  - **Cọ tẩy chữ thông minh (`inpaint`)**: Tô trực tiếp lên chữ nằm trên nền tranh phức tạp không lặp (áo, kính màu, tóc, phong cảnh). Trên **Desktop**, lõi **C# Multi-Scale PatchMatch + EM Voting + Colour Adaptation** ([native/PatchMatchInpaint.cs](native/PatchMatchInpaint.cs)) tái tạo kết cấu và chuyển sắc sắc nét theo từng tầng kim tự tháp; trên **Web**, tự động dùng fallback JS Fast-Marching + exemplar ([src/inpaint.js](src/inpaint.js)) — hoàn toàn không chạm bất kỳ điểm ảnh nào ngoài nét cọ.
  - Bấm **Hoàn tác nét cọ** để bỏ nét cọ gần nhất hoặc **Xóa nét vẽ tay** để xóa toàn bộ nét retouch của trang hiện tại. Lớp nét retouch được cache offscreen để kéo khung mượt mà, lưu gọn dạng vector trong `.khungthoai` v2 và gộp tự động vào lớp `Nền đã xóa chữ` khi xuất PNG/PSD/ZIP.
- Dùng checkbox **Hiện redraw** / **Hiện chữ** để kiểm tra từng lớp (không làm mất lớp khi xuất).

### 4. Tìm & thay thế, hoàn tác và phím tắt
- Mở **Tìm & thay** (`Ctrl/Cmd+H` hoặc `Ctrl/Cmd+F`) để tìm kiếm/thay thế xuyên suốt chương (hỗ trợ phân biệt hoa/thường, khớp nguyên từ Unicode, gồm cả câu chưa đặt, tự bảo vệ không làm rỗng hoàn toàn nội dung khung).
- Lịch sử **Hoàn tác / Làm lại** giữ tối đa 40 thao tác trong phiên.

| Phím tắt | Tác dụng |
|---|---|
| `Ctrl / Cmd + Z` | Hoàn tác |
| `Ctrl / Cmd + Shift + Z` hoặc `Ctrl + Y` | Làm lại |
| `Ctrl / Cmd + D` | Nhân bản khung đang chọn |
| `Ctrl / Cmd + H` (hoặc `F`) | Mở hộp thoại Tìm & thay thế |
| `Ctrl + Cuộn chuột` | Thu phóng bàn vẽ (25%–400%) |
| Giữ `Space` + Kéo / Chuột giữa | Kéo bàn vẽ (Pan) |
| `\` | Bật / tắt so sánh ảnh gốc |
| `Shift` + Kéo tay cầm xoay | Xoay khung theo nấc 15° |
| `Shift` + Bấm khung | Chọn nhiều khung để kéo nhóm / căn hàng |
| `Alt` + Kéo khung | Tạm tắt hút lưới tự động |
| `Alt` + Bấm (khi chọn Cọ sao chép nền) | Đặt điểm nguồn sao chép |
| Phím mũi tên (khi chọn khung) | Dịch khung 1 px (giữ `Shift`: 10 px) |
| `Delete` / `Backspace` | Xóa khung (hoặc nhóm khung) đang chọn |
| `Enter` (khi focus bàn vẽ) | Đặt khung chữ ở giữa trang |
| `?` | Mở bảng phím tắt |

### 5. Dịch ảnh & khung thoại bằng Gemini / Local LLM, OCR cục bộ & Trợ lý AI Harness v2
- **Gemini API & OpenAI-compatible / Local LLM**: Mở **Dịch ảnh & LLM (Gemini / Local)**, chọn **Gemini API** hoặc **OpenAI-compatible / Local LLM** (có cấu hình sẵn cho **Ollama** `http://localhost:11434/v1`, **LM Studio** `http://localhost:1234/v1`, **OpenRouter**, **OpenAI** hoặc server **Hy-MT2 Manga / vLLM** cục bộ; chỉ cho phép HTTPS hoặc HTTP loopback `localhost`/`127.0.0.1` và không bao giờ lưu API key vào `.khungthoai`).
  - **Dịch các khung chữ đang có**: Dịch trực tiếp các khung đã OCR cục bộ bằng Tesseract (hoặc tạo thủ công) mà **không cần model Vision** — tương thích hoàn toàn với các model dịch chữ thuần như Hy-MT2 Manga, Qwen2.5, Llama, Gemma.
  - **Dịch trang đang mở / Dịch cả lượt / Tiếp tục dịch chương / Ghép nghĩa kịch bản**: Hỗ trợ ngữ cảnh qua trang và **Bảng thuật ngữ** (`từ gốc = từ dịch`). [Tài liệu Gemini](https://ai.google.dev/api/generate-content)
- **OCR trên máy (Desktop)**: Sau khi cài Tesseract cùng gói ngôn ngữ, dùng mục **OCR trên máy** để tiền xử lý (phóng lớn bilinear 1×–3×, giảm nhiễu, xoay 0/90/180/270°), chọn chế độ chữ dọc Nhật (`jpn_vert`), gom dòng gần nhau và kiểm tra/chỉnh sửa trong cửa sổ duyệt kết quả kèm ảnh cắt và độ tin cậy trước khi **Đặt lên trang**. Xem chi tiết cấu hình trong [native/README.md](native/README.md).
- **Trợ lý AI · Agent Harness v2 & Web Search**: Bấm nút **Trợ lý AI** trên thanh tiêu đề để mở khung chat agent đa bước (dùng chung cấu hình **Gemini** hoặc **Local/OpenAI LLM** ở cột trái):
  - **Bộ công cụ Web Search & Tra cứu (`web_search`, `fetch_url`)**: Trên Desktop tự động tra miễn phí qua **DuckDuckGo + Jisho.org (từ điển Nhật) + Wikipedia** qua tiến trình chính an toàn (chống SSRF/chỉ HTTPS công khai); trên Web dùng Wikipedia CORS hoặc tùy chọn **Tavily API / SearXNG** tự host.
  - **Kiến trúc Context, Quy chuẩn làm việc & Bộ công cụ Harness v2** (học hỏi và tối ưu từ DeepSeek Harness cho biên tập truyện tranh):
    - *Ngữ cảnh trực tiếp (`<system-reminder>`)*: Tự động bơm thời gian cục bộ có múi giờ, trạng thái dự án, trang đang mở, kích thước ảnh, số khung tràn chữ, câu chưa đặt, danh sách mẫu dàn chữ và số mục thuật ngữ vào đầu lượt (có chống prompt injection thoát thẻ).
    - *Quy chuẩn làm việc tích hợp*: Yêu cầu AI kiểm tra dữ liệu thật trước khi kết luận, chia bước bằng todo cho việc phức tạp, giữ nhất quán thuật ngữ/xưng hô, tránh khung rỗng/tràn chữ và cô lập dữ liệu web không đáng tin.
    - *Tiến độ công việc (`todo_write`) & Chế độ Kế hoạch (**Plan Mode** + `submit_plan`)*: Hiển thị thanh tiến độ bước trực tiếp trong khung chat; khi bật Plan Mode, mọi công cụ sửa đều bị khóa để AI khảo sát và trình kế hoạch có nút **Thực thi kế hoạch** 1 chạm.
    - *Tự nén ngữ cảnh & giữ đầu-cuối (`retainHeadTailText`, `pruneOldToolResults`, `compactChatHistory`)*: Tự động rút gọn kết quả công cụ cũ theo chuẩn Unicode không cắt vỡ surrogate pair, có nút **Nén** thủ công để tiết kiệm token cho cả Gemini và Local LLM.
    - *18 công cụ biên tập & kiểm tra*: `web_search` (hỗ trợ đa truy vấn song song), `fetch_url`, `get_project_state`, `list_boxes`, `search_chapter_text`, `check_export_preflight`, `navigate_page`, `todo_write`, `submit_plan`, `update_box`, `create_box`, `delete_box`, `replace_chapter_text`, `update_glossary`, `autofit_page`, `align_boxes`, `distribute_boxes`, `apply_style_preset`. Các công cụ đọc chạy song song trong pool có giới hạn, còn công cụ sửa đổi luôn tạo hàng rào tuần tự (exclusive barrier) và mốc **Hoàn tác (`Ctrl+Z`)**.
- **Kiểm tra cập nhật & Trung tâm Thông báo**:
  - Bấm **Cập nhật** trên thanh tiêu đề (hoặc để app tự kiểm tra âm thầm 24 giờ/lần khi khởi động) để so sánh SemVer 2.0 với GitHub Releases (`wiothemilo-lang/Nixio`), xem ghi chú phát hành, danh sách tệp tải và tùy chọn **Bỏ qua bản này**.
  - **Trung tâm Thông báo** (nút **Thông báo** có huy hiệu chưa đọc + toast góc dưới phải tự ẩn, tạm dừng khi rê chuột): Tự động cảnh báo **khung tràn chữ** kèm nút 1 chạm **Khớp cỡ cả trang**, **nhắc lưu dự án** khi có nhiều chỉnh sửa chưa lưu ra tệp `.khungthoai`, báo hoàn tất xuất/dịch hàng loạt, báo chỉnh sửa của Trợ lý AI kèm nút **Hoàn tác**, phát hiện mất/có lại kết nối mạng và nhắc bản tự lưu phục hồi.

### 6. Dự án `.khungthoai`, tự lưu và xuất tệp
- **Lưu / Mở dự án**: Tệp `.khungthoai` v2 lưu ảnh gốc, mã dự án phục hồi, thứ tự trang, kịch bản, khung thoại (kể cả kiểu chữ nâng cao, viền, đổ bóng, font tùy chỉnh, vùng xóa, nét cọ), nét retouch (`paint`, `clone`, `inpaint`), mẫu dàn chữ, bảng thuật ngữ và tiến độ dịch (vẫn đọc tương thích ngược tệp v1).
- **Tự lưu phục hồi**:
  - *Bản Web*: Tự lưu phiên hiện tại vào IndexedDB mỗi 20 giây khi có thay đổi và khi ẩn/rời tab; hiển thị nút **Khôi phục phiên web** khi mở lại.
  - *Bản Desktop*: **Dự án gần đây và phục hồi** liệt kê từng dự án cùng tối đa 10 mốc tự lưu gần nhất, hỗ trợ mở lại bản tự lưu cũ và giữ bản `.bak` trước khi ghi đè. Trạng thái **Còn thay đổi chưa lưu** phản ánh việc lưu tệp thủ công.
- **Rà trước khi xuất & Xuất tệp**: Kiểm tra câu chưa đặt, chữ tràn khung, trang lỗi/chưa dịch xong trước khi xuất **PNG**, **PSD chữ** (tách `Ảnh gốc`, `Nền đã xóa chữ`, nhóm `Thoại` chỉnh sửa được kèm Photoshop Layer Style `stroke`/`dropShadow` — xem [ag-psd](https://github.com/Agamnentzar/ag-psd#updating-text-layers)), **PSD ảnh**, hoặc **ZIP cả lượt**. Các tác vụ OCR, tiền xử lý và mã hóa PNG hiển thị tiến độ trong bảng **Tác vụ** kèm nút **Hủy** trên worker ảnh tách biệt.

---

## Thư viện chương

Nhập tệp JSON trỏ đến kho ảnh HTTPS hoặc cùng nguồn (hỗ trợ tìm kiếm tiếng Việt không dấu theo tên và tên khác):

```json
{
  "series": [
    {
      "title": "Truyện mẫu",
      "aliases": ["Sample comic"],
      "chapters": [
        {
          "title": "Chương 1",
          "pages": ["https://example.com/comic/01.png", "https://example.com/comic/02.png"]
        }
      ]
    }
  ]
}
```

Chọn truyện và chương để đọc, chuyển ảnh vào trình biên tập hoặc tải ảnh thành ZIP. Máy chủ ảnh cần bật CORS cho thao tác **Đưa vào biên tập** và **Tải ảnh ZIP** khi khác nguồn.

---

## Kiểm thử & CI/CD

Chạy toàn bộ bộ test bằng Node.js 22.12+:

```sh
npm test
```

- **CI (`.github/workflows/verify.yml`)**: Tự động build và kiểm thử trên **Ubuntu và Windows**, chạy 100 unit/integration test (Node + C#), bộ đối chứng chất lượng ảnh/OCR (`npm run benchmark -- --output artifacts/benchmark.json`) và kiểm thử luồng Electron đóng gói bằng Playwright (`npm run test:desktop -- --packaged`). Xem [nguồn và cách bổ sung mẫu](test/fixtures/comic/README.md).
- **CD (`.github/workflows/release.yml`)**: Khi đẩy tag `v*.*.*` (hoặc chạy tay qua `workflow_dispatch`), tự động build, smoke-test trên Linux & Windows, đóng gói `.deb`, `.rpm`, `.tar.gz`, `.exe` (Inno Setup 6), `.zip`, tạo `SHA256SUMS.txt` và xuất bản GitHub Release.

25 bộ test trong `test/`:
- `placement.test.js` & `ocr.test.js`: Chuẩn hóa tọa độ OCR, gom dòng dọc/ngang và quy tắc ghép khung.
- `io.test.js`: Nhận diện MIME, đọc DOCX/XLSX và gom nhóm thoại.
- `gemini.test.js` & `openai-compat.test.js`: Suy luận MIME ảnh, lọc `<think>`/JSON, dịch ảnh/khung chữ cho Gemini và OpenAI-compatible/Local LLM, xác thực endpoint chống HTTP từ xa không an toàn.
- `canvas.test.js`, `tools.test.js` & `photocraft-pro.test.js`: Dàn chữ (stroke, đổ bóng, dọc, hình nền, ôm bong bóng bầu dục, uốn chữ SFX, auto-fit, PSD Layer Style), làm sạch ảnh raw, cọ tẩy nét redraw, co giãn 8 tay cầm, hút lưới, căn hàng/chia đều, xoay, nhân bản, lớp Z-index, tìm & thay thế, xuất kịch bản.
- `bubble.test.js`: Tự nhận diện bong bóng thoại sáng bằng flood-fill.
- `retouch.test.js`, `inpaint.test.js` & `cleanup.test.js`: Hút màu, cọ paint/clone/erase, Inpaint JS fallback không chạm ngoài mặt nạ, cache lớp retouch và thuật toán nới/thu mặt nạ tách trục 1D.
- `project.test.js`, `recovery-catalog.test.js`, `task-queue.test.js` & `workflow.test.js`: Lưu/mở `.khungthoai` v1/v2, danh mục phục hồi theo dự án, hàng đợi tác vụ có hủy, lịch sử Undo/Redo và tiếp tục dịch chương.
- `redraw.test.js`, `native-redraw.test.js`, `native-processing.test.js` & `benchmark.test.js`: Hàng đợi redraw, phục hồi screentone/gradient, PatchMatch + Poisson seamless inpaint C#, làm sạch raw C#, mặt nạ, PNG/ZIP, lưu tệp nguyên tử và benchmark chất lượng từ worker C# (tự động kích hoạt sau khi chạy `npm run desktop:native`).
- `agent-harness.test.js`, `agent-context.test.js`, `harness-pro.test.js`, `web-search.test.js`, `updater.test.js`, `notifications.test.js` & `release-packaging.test.js`: Pipeline Harness song song/tuần tự, context runtime & quy chuẩn, nén lịch sử (tức thì & bằng LLM), chống lặp công cụ, tự thử lại LLM, hồ sơ kỹ năng theo thể loại, lệnh nhanh slash, thẻ hỏi `ask_user`, duyệt thao tác hàng loạt, lưu lịch sử chat theo dự án, Plan Mode, Todo list, Web Search chống SSRF, kiểm tra cập nhật SemVer, Trung tâm Thông báo và sinh cấu hình đóng gói `.deb`/`.rpm`/Inno Setup `.exe`.
