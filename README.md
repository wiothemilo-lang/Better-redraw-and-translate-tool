# Better-redraw-and-translate-tool (Khung Thoại)

Công cụ biên tập, xóa chữ (redraw), dịch thuật và dàn thoại truyện tranh/manga chạy trên **trình duyệt Web** và **ứng dụng Desktop (Electron + lõi xử lý ảnh C#/.NET 10)**. Dự án được xây dựng độc lập sau khi khảo sát luồng công khai của Lilyzono. Xem thêm [ANALYSIS.md](ANALYSIS.md), [DESIGN.md](DESIGN.md) và [native/README.md](native/README.md).

---

## Tính năng chính

| Nhóm | Bản Web | Bản Desktop (Electron + C#) |
|---|---|---|
| Biên tập khung thoại, co giãn 8 tay cầm (kể cả khung xoay), xoay 15°, chọn nhiều khung & căn hàng/chia đều, hút lưới tự động, chấm bong bóng tự động, zoom 25%–400%, kéo bàn vẽ, so sánh ảnh gốc | Có | Có |
| Dàn chữ nâng cao (viền chữ, đổ bóng, đậm/nghiêng/IN HOA/chữ dọc, giãn dòng, hình nền bầu dục/bo góc, tự khớp cỡ chữ, nạp & tự lưu font cục bộ IndexedDB) | Có | Có |
| Cọ retouch thủ công (Hút màu, Cọ vẽ che chữ, Cọ sao chép nền Clone Stamp, **Cọ tẩy chữ thông minh Inpaint**, hoàn tác nét cọ gần nhất, cache lớp retouch) & mặt nạ vùng xóa | Có | Có (mặt nạ C# tăng tốc) |
| Xóa chữ tự động (Redraw) | Nền giấy sáng trơn trên Canvas + Cọ Inpaint tái tạo nền phức tạp | Nền trơn, nền chuyển sắc, screentone lặp (chu kỳ ≤ 32 px, kể cả screentone chuyển sáng), bảo vệ nét vẽ cắt biên + Cọ Inpaint |
| Dịch & ghép kịch bản bằng **Gemini API** hoặc **OpenAI-compatible / Local LLM** (Ollama, LM Studio, Hy-MT2, OpenRouter) + **Dịch các khung chữ đang có** | Có | Có (cho phép kết nối localhost) |
| **Trợ lý AI · Agent Harness** (khung chat đa bước gọi công cụ + **Web Search** + đọc trang + tự sửa khung/thuật ngữ kèm Hoàn tác) | Có (Wiki/Tavily/SearXNG) | Có (DuckDuckGo + Jisho + Wiki không cần key, hoặc Tavily/SearXNG) |
| OCR cục bộ offline (Tesseract, xoay 0/90/180/270°, chữ dọc Nhật `jpn_vert`, gom dòng & cửa sổ duyệt kết quả có độ tin cậy) | — | Có |
| Tìm & thay thế toàn chương, xuất kịch bản (`TXT` / `CSV` / `JSON`), rà trước khi xuất | Có | Có |
| Lưu / mở dự án `.khungthoai` & tự lưu phục hồi | Tự lưu IndexedDB trên trình duyệt | Dự án gần đây + tối đa 10 mốc tự lưu theo từng dự án, giữ bản `.bak`, báo trạng thái chưa lưu |
| Xuất tệp | PNG, PSD lớp chữ (gồm hiệu ứng Layer Style viền/bóng), PSD lớp ảnh, ZIP | Như Web + ghép & xuất PNG/ZIP trực tiếp bằng C# kèm bảng Tác vụ tiến độ & Hủy |

---

## Yêu cầu & Chạy tại máy

Yêu cầu **Node.js 22.12+** (hoặc 24 LTS). Để bật lõi xử lý C# trên desktop cần thêm **.NET 10 SDK** (và **Tesseract** nếu dùng OCR cục bộ).

### Chạy bản Web

```sh
npm ci
npm run dev
```

Mở địa chỉ mà Vite in ra. Dùng `npm run build` để tạo bản production trong `dist/` và `npm run preview` để kiểm tra.

### Chạy & đóng gói App Electron

```sh
npm run desktop:native   # Biên dịch lõi C# (.NET 10 SDK)
npm run desktop          # Build web và mở app Electron
```

Đóng gói bản phát hành kèm runtime .NET tự chứa (kết quả nằm trong `desktop-dist/`):

```sh
npm run desktop:package -- linux-x64
npm run desktop:package -- win-x64
```

Mở `Khung-Thoai` (Linux) hoặc `Khung-Thoai.exe` (Windows). Các lệnh đóng gói cần kết nối mạng nếu Electron và runtime .NET cho nền tảng đích chưa có trong cache.

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
  - **Thu phóng 25%–400%** bằng nút `−`/`+`, `Ctrl + cuộn chuột` hoặc chuyển nhanh `Vừa trang` / `100%`.
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
  - **Cọ tẩy chữ thông minh (`inpaint`)**: Tô trực tiếp lên chữ nằm trên nền tranh phức tạp không lặp (áo, kính màu, tóc, phong cảnh); công cụ tự động tái tạo nền bằng Fast-Marching directional diffusion kết hợp khớp mẫu cục bộ (exemplar) mà không chạm bất kỳ điểm ảnh nào ngoài nét cọ.
  - Bấm **Hoàn tác nét cọ** để bỏ nét cọ gần nhất hoặc **Xóa nét vẽ tay** để xóa toàn bộ nét retouch của trang hiện tại. Lớp nét retouch được cache offscreen để kéo khung mượt mà, lưu gọn dạng vector trong `.khungthoai` và gộp tự động vào lớp `Nền đã xóa chữ` khi xuất PNG/PSD/ZIP.
- Dùng checkbox **Hiện redraw** / **Hiện chữ** để kiểm tra từng lớp (không làm mất lớp khi xuất).

### 4. Tìm & thay thế, hoàn tác và phím tắt
- Mở **Tìm & thay** (`Ctrl/Cmd+H`) để tìm kiếm/thay thế xuyên suốt chương (hỗ trợ phân biệt hoa/thường, khớp nguyên từ Unicode, gồm cả câu chưa đặt, tự bảo vệ không làm rỗng hoàn toàn nội dung khung).
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

### 5. Dịch ảnh & khung thoại bằng Gemini / Local LLM (Ollama, LM Studio, Hy-MT2) & OCR cục bộ
- **Gemini API & OpenAI-compatible / Local LLM**: Mở **Dịch ảnh & LLM (Gemini / Local)**, chọn **Gemini API** hoặc **OpenAI-compatible / Local LLM** (có cấu hình sẵn cho **Ollama** `http://localhost:11434/v1`, **LM Studio** `http://localhost:1234/v1`, **OpenRouter**, **OpenAI** hoặc server **Hy-MT2 Manga / vLLM** cục bộ; chỉ cho phép HTTPS hoặc HTTP loopback `localhost`/`127.0.0.1` và không bao giờ lưu API key vào `.khungthoai`).
  - **Dịch các khung chữ đang có**: Dịch trực tiếp các khung đã OCR cục bộ bằng Tesseract (hoặc tạo thủ công) mà **không cần model Vision** — tương thích hoàn toàn với các model dịch chữ thuần như Hy-MT2 Manga, Qwen2.5, Llama, Gemma.
  - **Dịch trang đang mở / Dịch cả lượt / Tiếp tục dịch chương / Ghép nghĩa kịch bản**: Hỗ trợ ngữ cảnh qua trang và **Bảng thuật ngữ** (`từ gốc = từ dịch`). [Tài liệu Gemini](https://ai.google.dev/api/generate-content)
- **OCR trên máy (Desktop)**: Sau khi build lõi C# và cài Tesseract cùng gói ngôn ngữ, dùng mục **OCR trên máy** để tiền xử lý (phóng lớn bilinear 1×–3×, giảm nhiễu, xoay 0/90/180/270°), chọn chế độ chữ dọc Nhật (`jpn_vert`), gom dòng gần nhau và kiểm tra/chỉnh sửa trong cửa sổ duyệt kết quả kèm ảnh cắt và độ tin cậy trước khi **Đặt lên trang**. Xem chi tiết cấu hình trong [native/README.md](native/README.md).
- **Trợ lý AI · Agent Harness & Web Search**: Bấm nút **Trợ lý AI** trên thanh tiêu đề để mở khung chat agent đa bước (dùng chung cấu hình **Gemini** hoặc **Local/OpenAI LLM** ở cột trái):
  - **Bộ công cụ Web Search & Tra cứu (`web_search`, `fetch_url`)**: Trên Desktop tự động tra miễn phí qua **DuckDuckGo + Jisho.org (từ điển Nhật) + Wikipedia** qua tiến trình chính an toàn (chống SSRF/chỉ HTTPS công khai); trên Web dùng Wikipedia CORS hoặc tùy chọn **Tavily API / SearXNG** tự host.
  - **Bộ công cụ biên tập & quyền kiểm soát**: AI có thể tự gọi `get_project_state`, `list_boxes`, `search_chapter_text`, `update_box`, `create_box`, `delete_box`, `replace_chapter_text`, `update_glossary` và `autofit_page`. Mọi bước gọi công cụ đều hiện thẻ trace (tham số, thời gian, kết quả, link nguồn), hỗ trợ nút **Dừng**, công tắc bật/tắt **Web Search** và **Cho phép sửa khung & thuật ngữ**, và mọi thay đổi của AI đều tạo mốc **Hoàn tác (`Ctrl+Z`)**.

### 6. Dự án `.khungthoai`, tự lưu và xuất tệp
- **Lưu / Mở dự án**: Tệp `.khungthoai` v2 lưu ảnh gốc, mã dự án phục hồi, thứ tự trang, kịch bản, khung thoại (kể cả kiểu chữ nâng cao, viền, đổ bóng, font tùy chỉnh, vùng xóa, nét cọ), nét retouch paint/clone, mẫu dàn chữ, bảng thuật ngữ và tiến độ dịch (vẫn đọc tương thích ngược tệp v1).
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

## Kiểm thử & CI chất lượng ảnh

Chạy toàn bộ bộ test bằng Node.js 22.12+:

```sh
npm test
```

Workflow **Verify desktop and image quality** (`.github/workflows/verify.yml`) tự động build và kiểm thử trên **Windows và Linux**, chạy test C#, bộ đối chứng chất lượng ảnh/OCR (`npm run benchmark -- --output artifacts/benchmark.json`) và kiểm thử luồng Electron đóng gói (`npm run test:desktop -- --packaged`). Xem [nguồn và cách bổ sung mẫu](test/fixtures/comic/README.md).

Bộ test bao gồm:
- `test/placement.test.js` & `test/ocr.test.js`: Chuẩn hóa tọa độ OCR, gom dòng dọc/ngang và quy tắc ghép khung.
- `test/io.test.js`: Nhận diện MIME, đọc DOCX/XLSX và gom nhóm thoại.
- `test/gemini.test.js`: Suy luận MIME ảnh, xử lý lỗi JSON và hủy yêu cầu Gemini.
- `test/canvas.test.js` & `test/tools.test.js`: Dàn chữ (stroke, đổ bóng, dọc, hình nền, auto-fit, PSD Layer Style), co giãn 8 tay cầm (gồm khung xoay), hút lưới, căn hàng/chia đều, xoay, nhân bản, lớp Z-index, tìm & thay thế, xuất kịch bản.
- `test/bubble.test.js`: Tự nhận diện bong bóng thoại sáng bằng flood-fill.
- `test/retouch.test.js` & `test/cleanup.test.js`: Hút màu, cọ paint/clone, cache lớp retouch và thuật toán nới/thu mặt nạ tách trục 1D.
- `test/project.test.js`, `test/recovery-catalog.test.js`, `test/task-queue.test.js` & `test/workflow.test.js`: Lưu/mở `.khungthoai` v1/v2, danh mục phục hồi theo dự án, hàng đợi tác vụ có hủy, lịch sử Undo/Redo và tiếp tục dịch chương.
- `test/redraw.test.js`, `test/native-redraw.test.js`, `test/native-processing.test.js` & `test/benchmark.test.js`: Hàng đợi redraw, phục hồi screentone/gradient, mặt nạ, PNG/ZIP, lưu tệp nguyên tử và benchmark chất lượng từ worker C# (tự động kích hoạt sau khi chạy `npm run desktop:native`).
