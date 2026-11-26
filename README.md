# Better-redraw-and-translate-tool
use this tool for redrawing and translating comic, manga,...

## Khung Thoại

Trình biên tập trang truyện chạy trong trình duyệt, kết hợp nhập lời thoại, đặt khung trên ảnh và xuất tệp để tiếp tục chỉnh sửa. Dự án được viết độc lập sau khi khảo sát giao diện công khai của Lilyzono. Xem [ghi chép phân tích](ANALYSIS.md) và [tài liệu giao diện](DESIGN.md).

## Chạy tại máy

Dùng Node.js 22.12+ hoặc 24 LTS.

```sh
npm ci
npm run dev
```

Mở địa chỉ mà Vite in ra. Dùng `npm run build` để tạo thư mục `dist/` và `npm run preview` để kiểm tra bản build.

## App Electron

Để mở bản desktop từ mã nguồn, cài Node.js 22.12+ và chạy `npm ci` rồi `npm run desktop`. Biên dịch lõi C# bằng .NET 10 SDK trước khi mở app để bật phục hồi nền chấm lặp và nền chuyển sắc.

```sh
npm run desktop:native
npm run desktop
```

Để đóng gói app kèm lõi C#, chọn nền tảng đích. Bản đóng gói chứa runtime .NET cần thiết.

```sh
npm run desktop:package -- linux-x64
npm run desktop:package -- win-x64
```

Kết quả nằm trong `desktop-dist/`. Mở `Khung-Thoai` trên Linux hoặc `Khung-Thoai.exe` trên Windows. Các lệnh đóng gói cần kết nối mạng khi chưa có Electron và runtime .NET cho nền tảng đích trong bộ nhớ đệm.

## Xử lý C# trên desktop

Sau khi build worker, app bật **OCR trên máy**, tiền xử lý ảnh, mặt nạ cọ C#, xuất PNG/ZIP bằng C# và ghi dự án trực tiếp. **Lưu dự án** và **Mở dự án** dùng hộp chọn tệp của hệ điều hành. App tự lưu sau chỉnh sửa mỗi 20 giây và ghi thêm lần cuối khi đóng cửa sổ đang rảnh. **Khôi phục tự lưu** và **Bản tự lưu trước** mở các bản phục hồi sau khi khởi động lại. Tệp đã có được giữ thêm một bản `.bak` trước khi thay thế.

OCR cục bộ cần Tesseract cùng gói ngôn ngữ. Giao diện chỉ liệt kê những ngôn ngữ đã cài. Chọn bố cục, phóng lớn và giảm nhiễu, xem ảnh tiền xử lý rồi bấm **Nhận dạng chữ**. Có thể giới hạn OCR trong khung đang chọn. Dòng chồng lên khung có sẵn được giữ trong **Chưa đặt** để bạn đối chiếu.

Worker phục hồi screentone có chu kỳ đến 32 pixel và bảo vệ nét mực nối qua biên vùng xóa. **Nới / thu mặt nạ** chỉnh phần bảo vệ bằng cọ trong vùng đã khoanh. Bộ xuất C# ghép ảnh, redraw và lớp chữ theo thứ tự của bản xem trước, sau đó xuất PNG hoặc ZIP từng trang. Lớp chữ PSD chỉnh sửa được tiếp tục được tạo bằng ag-psd.

Xem [hướng dẫn lõi native](native/README.md) để cài OCR, đóng gói engine, đọc giao thức và thêm tác vụ mới.

## Biên tập và xuất tệp

1. Thêm tối đa 50 ảnh PNG, JPEG hoặc WebP. Dùng các nút lên và xuống để sắp xếp trang.
2. Dán kịch bản hoặc nhập TXT UTF-8, DOCX, XLSX tối đa 2 MB. Mỗi câu nằm trên một dòng. Dùng tiêu đề như `Trang 1` hoặc `[anh-01.png]` để chỉ trang. Với XLSX, hàng đầu có thể dùng cột `Page` và `Translation`.
3. Bấm **Dàn thoại lên ảnh**. Ứng dụng xếp các câu thành lưới theo hướng đọc đã chọn. Câu có chỉ dẫn trang không khớp hoặc vượt số ô tự động xuất hiện trong **Chưa đặt**.
4. Bấm **+ Khung chữ** rồi kéo hoặc bấm trên ảnh. Khi ảnh được lấy tiêu điểm, Enter đặt một khung ở giữa. Kéo khung đã có để di chuyển. Chọn khung để chỉnh nội dung, font, cỡ chữ, màu, canh, góc xoay và nền.
5. Xuất PNG, PSD chứa lớp chữ chỉnh sửa được, PSD tách các khung thành lớp ảnh, hoặc ZIP chứa cả lượt. PSD có thể chứa riêng ảnh gốc, phần nền đã xóa chữ và nhóm thoại. Photoshop có thể hỏi cập nhật lớp chữ khi mở PSD. [Tài liệu ag-psd](https://github.com/Agamnentzar/ag-psd#updating-text-layers)

Bấm **Lưu dự án** để tải tệp `.khungthoai` chứa ảnh gốc, thứ tự trang, kịch bản, khung thoại, câu chưa đặt và thiết lập dịch. Dùng **Mở dự án** trên web hoặc Electron để tiếp tục từ trang đang làm. Tệp v2 lưu thêm mẫu chữ, vùng xóa, nét cọ, bảng thuật ngữ và tiến độ dịch. Ứng dụng tiếp tục đọc tệp v1. Khóa API Gemini chỉ giữ trong phiên. Các chỉnh sửa sau lần lưu gần nhất cần được lưu lại trước khi đóng app hoặc tải lại trang.

## Hoàn tác, dàn chữ nâng cao và mẫu kiểu

Dùng **Hoàn tác** / **Làm lại** hoặc Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z (Ctrl+Y cũng được). Lịch sử giữ tối đa 40 thao tác trong phiên, gồm thêm/bỏ trang, sắp xếp, dàn thoại, sửa/kéo/co giãn/xoay/xóa khung, đặt câu chờ, áp dụng mẫu, vẽ cọ che/sao chép nền, thay thế hàng loạt và dịch. Trong ô nhập, phím tắt dùng lịch sử nhập văn bản của trình duyệt. Mở dự án khác sẽ bắt đầu lịch sử mới.

Trên bàn vẽ, chọn khung để **kéo 8 tay cầm co giãn** hoặc **kéo tay cầm tròn phía trên để xoay** (giữ `Shift` để xoay theo nấc 15°). Dùng nút `−`/`+` hoặc `Ctrl + cuộn chuột` để thu phóng (25%–400%), giữ `Space` (hoặc công cụ **Kéo bàn vẽ**) để di chuyển vùng nhìn, và bấm **So sánh gốc** (phím `\`) để đối chiếu nhanh với ảnh gốc. Nhấn `Ctrl/Cmd+D` để nhân bản khung, `Ctrl/Cmd+H` để **Tìm & thay thế** toàn chương, `?` để xem bảng phím tắt, hoặc xuất kịch bản ra **TXT / CSV / JSON**.

Bảng chỉnh khung hỗ trợ **xem trước trực tiếp**, **khớp cỡ chữ tự động** (từng khung hoặc cả trang), **nạp font cục bộ** (`.ttf`, `.otf`, `.woff`, `.woff2`), chữ **Đậm / Nghiêng / IN HOA / Chữ dọc**, **giãn dòng**, **viền chữ (stroke)**, và **hình nền** (`Chữ nhật`, `Bầu dục`, `Bo góc`) kèm màu nền tùy chỉnh. Trên trình duyệt web, ứng dụng còn tự lưu phiên vào IndexedDB để khôi phục nhanh nếu lỡ tải lại tab.

Chọn và lưu một khung, nhập tên trong **Mẫu dàn chữ** rồi bấm **Lưu kiểu khung đang chọn**. Mẫu chứa đầy đủ thuộc tính kiểu chữ, viền và nền. Áp dụng mẫu cho khung đang chọn, mọi khung trên trang hoặc cả chương. Lưu cùng tên sẽ cập nhật mẫu đó. Mẫu được giữ trong tệp dự án.

## Chỉnh vùng xóa chữ và vẽ che thủ công

Chọn khung thoại rồi chọn **Khoanh vùng xóa** và kéo trên ảnh. Vùng này giữ nguyên khi di chuyển chữ. **Cọ giữ nền gốc** loại phần nét vẽ cần giữ khỏi vùng xóa, **Cọ thêm vùng xóa** đưa phần đã loại trở lại. Cỡ cọ tính theo pixel ảnh gốc và chỉ tác động trong vùng đã khoanh. **Đặt lại vùng xóa** bỏ các nét cọ và dùng vùng OCR nếu có, hoặc khung chữ hiện tại.

Ngoài xóa chữ tự động, thanh công cụ còn có **Hút màu** (lấy mã màu pixel trực tiếp từ ảnh), **Cọ vẽ che chữ** (tô màu tùy chọn và độ đục lên lớp redraw) và **Cọ sao chép nền** (`Alt + bấm` vào vùng nền/screentone sạch để đặt điểm nguồn, rồi kéo tô che chữ). Các nét vẽ tay được lưu trong `.khungthoai` và gộp vào lớp `Nền đã xóa chữ` khi xuất PNG/PSD/ZIP.

Bật/tắt **Hiện redraw** và **Hiện chữ** để so sánh với ảnh gốc. Các nút này chỉ điều khiển xem trước. PNG và PSD luôn xuất đầy đủ lớp đang biên tập, bao gồm mặt nạ cọ. Redraw tiếp tục phục hồi các pixel đủ tin cậy bằng thuật toán nền sáng trên web hoặc lõi C# trên desktop.

## Rà trước khi xuất

**Rà trước khi xuất** liệt kê câu chưa đặt, chữ tràn khung, trang dịch lỗi, lượt dịch chưa xong và thiết lập dịch đã đổi. Bấm vào một mục để đến trang hoặc khung tương ứng. Khi xuất PNG, PSD hoặc ZIP có các mục này, ứng dụng mở bảng kiểm tra và cho phép **Vẫn xuất** sau khi xem lại.

## Dịch bằng Gemini

Mở **Dịch ảnh bằng Gemini**, nhập khóa API, chọn ngôn ngữ rồi bấm **Dịch trang đang mở** hoặc **Dịch cả lượt**. Gemini đọc chữ và khung trước, sau đó dịch theo mã thoại. Khi dịch nhiều trang, câu dịch gần nhất được dùng làm ngữ cảnh cho trang sau. Nhập bảng thuật ngữ theo dạng `từ gốc = từ dịch`, mỗi mục một dòng, để Gemini dùng nhất quán trong chương. Ghi chú và bảng thuật ngữ được lưu theo dự án.

Trạng thái từng trang hiện dưới tên ảnh. Nếu một trang lỗi, các trang đã dịch vẫn giữ kết quả. **Tiếp tục dịch chương** bắt đầu từ trang đầu chưa hoàn tất theo thiết lập hiện tại và xử lý các trang phía sau với ngữ cảnh nối tiếp. Nút **Dừng dịch** hủy yêu cầu đang chạy, giữ các trang đã xong. Có thể lưu dự án rồi mở lại để tiếp tục. Đổi model, ngôn ngữ, hướng đọc, ghi chú hoặc bảng thuật ngữ sẽ yêu cầu xử lý lại các trang theo thiết lập mới. Trình duyệt gửi ảnh và ghi chú trực tiếp đến Google Generative Language API. Ứng dụng giữ khóa trong trường nhập của phiên hiện tại. [Tài liệu Gemini](https://ai.google.dev/api/generate-content)

Nếu đã có bản dịch, nhập kịch bản rồi bấm **Ghép nghĩa kịch bản trang này**. Dịch và ghép nghĩa đều ưu tiên khung có sẵn trên trang. Khi trang trống, chúng dùng khung OCR. Các câu không có tọa độ đáng tin cậy hoặc xung đột được giữ trong **Chưa đặt** để xử lý thủ công.

Tùy chọn **Xóa chữ gốc trong khung** lấy mẫu màu giấy quanh khung. Lõi C# của app Electron xử lý nền trơn, nền chuyển sắc và screentone lặp, kể cả screentone đổi độ sáng theo nền. Với nền chuyển sắc, app giữ nguyên nét đậm nối từ trong ra ngoài khung. Vùng ảnh thiếu mẫu đủ tin cậy được giữ nguyên. Kiểm tra ảnh xem trước khi xuất.

## Kiểm thử

Chạy `npm test` để kiểm tra tọa độ OCR và quy tắc ghép khung. Sau khi chạy `npm run desktop:native`, bộ test còn kiểm tra phục hồi texture, dữ liệu sai và thứ tự phản hồi từ tiến trình C#. Xem [kết quả kiểm thử đối chứng](ANALYSIS.md#kiểm-thử-đối-chứng) để biết các hành vi đã được kiểm tra với Lilyzono.

## Thư viện chương

Nhập tệp JSON trỏ đến kho ảnh của bạn. Mỗi truyện có thể có nhiều chương và tên thay thế để tìm kiếm.

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

Chọn truyện và chương để đọc, chuyển ảnh vào trình biên tập hoặc tải ảnh thành ZIP. Máy chủ ảnh cần cho phép CORS đối với thao tác tải ZIP và chuyển vào trình biên tập khi chạy khác nguồn.
