# Giao diện Nixio

Nixio dùng giao diện **Pro Workstation** trung tính: thanh tiêu đề tối, thanh công cụ dọc 44 px với icon SVG nét mảnh, bàn vẽ lưới chấm tối đa diện tích và Inspector thu gọn dạng Accordion. Bố cục ưu tiên thao tác trên trang truyện, không dùng hình nền trang trí hay hiệu ứng che nội dung.

## Bảng màu

| Vai trò | Light | Dark |
|---|---|---|
| Nền ứng dụng | `#EEF0F3` | `#121417` |
| Bàn vẽ | `#E4E7EC` | `#101215` |
| Bề mặt panel | `#FFFFFF` | `#191C21` |
| Thanh tiêu đề | `#111418` | `#0E1013` |
| Chữ chính | `#111827` | `#E7EBF0` |
| Chữ phụ | `#5C6675` | `#8F99A8` |
| Nhấn | `#0F9D76` | `#14B88A` |
| Viền | `#E2E5EC` | `#282E38` |

Màu nhấn chỉ dùng cho hành động chính, trạng thái đang chọn và tiêu điểm bàn phím. Màu cảnh báo và lỗi tách riêng khỏi màu nhấn để không làm nhiễu trạng thái.

## Kiểu chữ và bố cục

- Font: Inter nếu hệ thống đã cài, sau đó dùng font hệ thống; cỡ gốc 14 px, tiêu đề giảm letter-spacing nhẹ.
- Từ 950 px trở lên: danh sách trang và kịch bản bên trái, bàn vẽ ở giữa, Inspector bên phải.
- Dưới 950 px: Inspector chuyển xuống dưới bàn vẽ. Dưới 610 px: các bảng xếp dọc, thanh công cụ thu gọn.
- Thư viện chương và các hộp thoại lớn mở thành màn hình riêng, không ép vào panel hẹp.
- Mọi điều khiển đều có trạng thái `:focus-visible`, nhãn cho trình đọc màn hình, live region cho thông báo động và vùng chạm tối thiểu 32 px.

Nguồn triển khai nằm trong [index.html](index.html) và [src/style.css](src/style.css). Kiến trúc tiến trình, giao thức RPC và ranh giới tin cậy giữa renderer, Electron và worker C# được mô tả trong [docs/architecture.md](docs/architecture.md).
