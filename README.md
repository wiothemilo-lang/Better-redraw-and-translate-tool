# Better-redraw-and-translate-tool (Khung Thoại)

Công cụ biên tập, xóa chữ (redraw), dịch thuật và dàn thoại truyện tranh/manga chạy trên **trình duyệt Web** và **ứng dụng Desktop (Electron + lõi xử lý ảnh C#/.NET 10)**. Dự án được xây dựng độc lập sau khi khảo sát luồng công khai của Lilyzono. Xem thêm [ANALYSIS.md](ANALYSIS.md), [DESIGN.md](DESIGN.md) và [native/README.md](native/README.md).

---

## Tính năng chính

| Nhóm | Bản Web | Bản Desktop (Electron + C#) |
|---|---|---|
| Biên tập khung thoại, co giãn 8 tay cầm, xoay, zoom 25%–400%, kéo bàn vẽ, so sánh ảnh gốc | Có | Có |
| Dàn chữ nâng cao (viền chữ, đậm/nghiêng/IN HOA/chữ dọc, giãn dòng, hình nền bầu dục/bo góc, tự khớp cỡ chữ, nạp font cục bộ) | Có | Có |
| Cọ retouch thủ công (Hút màu, Cọ vẽ che chữ, Cọ sao chép nền Clone Stamp) & mặt nạ vùng xóa | Có | Có (mặt nạ C# tăng tốc) |
| Xóa chữ tự động (Redraw) | Nền giấy sáng trơn trên Canvas | Nền trơn, nền chuyển sắc, screentone lặp (chu kỳ ≤ 32 px, kể cả screentone chuyển sáng) và bảo vệ nét vẽ cắt biên |
| Dịch & ghép kịch bản bằng Gemini API (OCR → dịch theo mã + ngữ cảnh + thuật ngữ) | Có | Có |
| OCR cục bộ offline (Tesseract, tiền xử lý ảnh phóng lớn bilinear + giảm nhiễu) | — | Có |
| Tìm & thay thế toàn chương, xuất kịch bản (`TXT` / `CSV` / `JSON`), rà trước khi xuất | Có | Có |
| Lưu / mở dự án `.khungthoai` & tự lưu phục hồi | Tự lưu IndexedDB trên trình duyệt | Ghi trực tiếp qua dialog OS, tự lưu mỗi 20 giây & khi đóng app, giữ bản `.bak` |
| Xuất tệp | PNG, PSD lớp chữ chỉnh sửa được, PSD lớp ảnh, ZIP | Như Web + ghép & xuất PNG/ZIP trực tiếp bằng C# |

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
  - Bấm **+ Khung chữ** rồi bấm/kéo trên ảnh (hoặc nhấn `Enter` khi ảnh đang lấy tiêu điểm).
  - Chọn khung để kéo di chuyển, kéo **8 tay cầm co giãn** ở cạnh/góc, hoặc kéo **tay cầm xoay** phía trên (giữ `Shift` để xoay theo nấc 15°).
  - **Thu phóng 25%–400%** bằng nút `−`/`+`, `Ctrl + cuộn chuột` hoặc chuyển nhanh `Vừa trang` / `100%`.
  - **Kéo bàn vẽ (Pan)** bằng công cụ `Kéo bàn vẽ (Hand)`, giữ `Space + kéo` hoặc kéo chuột giữa.
  - Bấm **So sánh gốc** (phím `\`) để ẩn nhanh lớp redraw và chữ nhằm đối chiếu bản raw.
- **Tùy biến kiểu chữ & xem trước trực tiếp**:
  - Chỉnh **Nội dung**, **Font** (hỗ trợ **+ Nạp font** `.ttf`, `.otf`, `.woff`, `.woff2` từ máy), **Đậm / Nghiêng / IN HOA / Chữ dọc**, **Cỡ chữ**, **Giãn dòng (`0.8–2.2`)**, **Màu chữ**, **Canh chữ**, **Góc xoay**, **Viền chữ (stroke)** và **Hình nền** (`Chữ nhật`, `Bầu dục`, `Bo góc`) kèm **Màu nền**. Mọi thay đổi đều xem trước trực tiếp trên ảnh.
  - Bấm **Khớp cỡ** hoặc **Khớp cỡ chữ cả trang** để tự chọn cỡ chữ lớn nhất không tràn khung.
  - Dùng **Nhân bản** (`Ctrl/Cmd+D`), **↑ / ↓ Lớp** (đổi thứ tự Z-index) và **Mẫu dàn chữ** để lưu/áp dụng nhanh bộ kiểu cho khung, trang hoặc cả chương.

### 3. Xóa chữ tự động & công cụ Retouch thủ công
- **Xóa chữ tự động**: Bật **Xóa chữ gốc trong khung**. Dùng **Khoanh vùng xóa** để tách vùng xóa khỏi vị trí khung chữ; dùng **Cọ giữ nền gốc** và **Cọ thêm vùng xóa** để tô mặt nạ bảo vệ nét vẽ; chỉnh **Nới / thu mặt nạ (`-8..8 px`)** trên desktop; bấm **Đặt lại vùng xóa** để quay về mặc định.
- **Vẽ che & sao chép nền thủ công**:
  - **Hút màu (`eyedropper`)**: Bấm vào ảnh để lấy mã màu RGB chính xác cho cọ vẽ.
  - **Cọ vẽ che chữ (`paint`)**: Tô màu và độ đục tùy chỉnh trực tiếp lên lớp redraw.
  - **Cọ sao chép nền (`clone`)**: Giữ `Alt + bấm` vào vùng nền/screentone sạch để đặt điểm nguồn, sau đó kéo tô lên chữ cần che.
  - Bấm **Xóa nét vẽ tay** để xóa toàn bộ nét paint/clone của trang hiện tại. Các nét vẽ tay được lưu trong `.khungthoai` và gộp tự động vào lớp `Nền đã xóa chữ` khi xuất PNG/PSD/ZIP.
- Dùng checkbox **Hiện redraw** / **Hiện chữ** để kiểm tra từng lớp (không làm mất lớp khi xuất).

### 4. Tìm & thay thế, hoàn tác và phím tắt
- Mở **Tìm & thay** (`Ctrl/Cmd+H`) để tìm kiếm/thay thế xuyên suốt chương (hỗ trợ phân biệt hoa/thường, khớp nguyên từ Unicode, gồm cả câu chưa đặt, tự bảo vệ không làm rỗng hoàn toàn nội dung khung).
- Lịch sử **Hoàn tác / Làm lại** giữ tối đa 40 thao tác trong phiên.

| Phím tắt | Tác dụng |
|---|---|
| `Ctrl / Cmd + Z` | Hoàn tác |
| `Ctrl / Cmd + Shift + Z` hoặc `Ctrl + Y` | Làm lại |
| `Ctrl / Cmd + D` | Nhân bản khung đang chọn |
| `Ctrl / Cmd + H` (hoặc `F` ngoài ô nhập) | Mở hộp thoại Tìm & thay thế |
| `Ctrl + Cuộn chuột` | Thu phóng bàn vẽ (25%–400%) |
| Giữ `Space` + Kéo / Chuột giữa | Kéo bàn vẽ (Pan) |
| `\` | Bật / tắt so sánh ảnh gốc |
| `Shift` + Kéo tay cầm xoay | Xoay khung theo nấc 15° |
| `Alt` + Bấm (khi chọn Cọ sao chép nền) | Đặt điểm nguồn sao chép |
| Phím mũi tên (khi chọn khung) | Dịch khung 1 px (giữ `Shift`: 10 px) |
| `Delete` / `Backspace` | Xóa khung đang chọn |
| `Enter` (khi focus bàn vẽ) | Đặt khung chữ ở giữa trang |
| `?` | Mở bảng phím tắt |

### 5. Dịch ảnh bằng Gemini & OCR cục bộ
- **Gemini API**: Mở **Dịch ảnh bằng Gemini**, nhập API key, chọn model/ngôn ngữ, thêm ghi chú xưng hô và **Bảng thuật ngữ** (`từ gốc = từ dịch`), sau đó bấm **Dịch trang đang mở**, **Dịch cả lượt**, **Tiếp tục dịch chương**, **Dừng dịch** hoặc **Ghép nghĩa kịch bản trang này**. Khóa API chỉ giữ trong bộ nhớ phiên hiện tại và không lưu vào tệp dự án. [Tài liệu Gemini](https://ai.google.dev/api/generate-content)
- **OCR trên máy (Desktop)**: Sau khi build lõi C# và cài Tesseract cùng gói ngôn ngữ, dùng mục **OCR trên máy** để tiền xử lý (phóng lớn bilinear 1×–3×, giảm nhiễu), xem trước ảnh và nhận dạng chữ (toàn trang hoặc trong khung đang chọn). Xem chi tiết cấu hình trong [native/README.md](native/README.md).

### 6. Dự án `.khungthoai`, tự lưu và xuất tệp
- **Lưu / Mở dự án**: Tệp `.khungthoai` v2 lưu ảnh gốc, thứ tự trang, kịch bản, khung thoại (kể cả kiểu chữ nâng cao, font tùy chỉnh, vùng xóa, nét cọ), nét retouch paint/clone, mẫu dàn chữ, bảng thuật ngữ và tiến độ dịch (vẫn đọc tương thích ngược tệp v1).
- **Tự lưu phục hồi**:
  - *Bản Web*: Tự lưu phiên hiện tại vào IndexedDB mỗi 25 giây khi có thay đổi; hiển thị nút **Khôi phục phiên web** khi mở lại tab.
  - *Bản Desktop*: Tự lưu mỗi 20 giây và khi đóng cửa sổ, giữ bản `.bak` trước khi ghi đè, hỗ trợ **Khôi phục tự lưu** và **Bản tự lưu trước**.
- **Rà trước khi xuất & Xuất tệp**: Kiểm tra câu chưa đặt, chữ tràn khung, trang lỗi/chưa dịch xong trước khi xuất **PNG**, **PSD chữ** (tách `Ảnh gốc`, `Nền đã xóa chữ`, nhóm `Thoại` chỉnh sửa được — xem [ag-psd](https://github.com/Agamnentzar/ag-psd#updating-text-layers)), **PSD ảnh**, hoặc **ZIP cả lượt**.

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

Máy chủ ảnh cần bật CORS cho thao tác **Đưa vào biên tập** và **Tải ảnh ZIP** khi khác nguồn.

---

## Kiểm thử

Chạy toàn bộ bộ test bằng Node.js 22.12+:

```sh
npm test
```

Bộ test bao gồm:
- `test/placement.test.js`: Chuẩn hóa tọa độ OCR và quy tắc ghép khung.
- `test/io.test.js`: Nhận diện MIME, đọc DOCX/XLSX và gom nhóm thoại.
- `test/gemini.test.js`: Suy luận MIME ảnh, xử lý lỗi JSON và hủy yêu cầu Gemini.
- `test/canvas.test.js` & `test/tools.test.js`: Dàn chữ (stroke, dọc, hình nền, auto-fit), co giãn 8 tay cầm, xoay, nhân bản, lớp Z-index, tìm & thay thế, xuất kịch bản.
- `test/retouch.test.js` & `test/cleanup.test.js`: Hút màu, cọ paint/clone và thuật toán nới/thu mặt nạ tách trục 1D.
- `test/project.test.js` & `test/workflow.test.js`: Lưu/mở `.khungthoai` v1/v2, lịch sử Undo/Redo và tiếp tục dịch chương.
- `test/redraw.test.js`, `test/native-redraw.test.js`, `test/native-processing.test.js`: Hàng đợi redraw, phục hồi screentone/gradient, mặt nạ, PNG/ZIP và lưu tệp nguyên tử từ worker C# (tự động kích hoạt sau khi chạy `npm run desktop:native`).
