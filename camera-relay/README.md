# FloodGuard – camera video relay (giai đoạn 1)

ESP32-S3-CAM OV3660 phát MJPEG `/stream` và đăng ký mDNS `floodguard-cam.local` (HTTP service). Laptop cùng Wi-Fi/hotspot với camera đọc stream rồi đẩy JPEG (tối đa 4 FPS mặc định) qua WebSocket lên Render. Backend phát khung hình tới thẻ Camera trên Web.

## Cấu hình bắt buộc
1. Render **Backend**: đặt biến môi trường bí mật `CAMERA_STREAM_KEY` thành một chuỗi ngẫu nhiên dài (không commit GitHub). Relay chỉ cho phép laptop gửi ảnh khi có đúng key.
2. Laptop Windows PowerShell:
   ```powershell
   cd camera-relay
   py -m pip install -r requirements.txt
   $env:RELAY_URL="wss://floodguard-backend-4dua.onrender.com/camera/uplink"
   $env:CAMERA_STREAM_KEY="<khóa đã đặt trên Render>"
   py relay.py
   ```
3. Mở Web FloodGuard, vào Tổng quan, xem thẻ Camera giám sát ngập.
4. Đảm bảo laptop và ESP32-S3-CAM cùng hotspot 2.4 GHz. Chỉ laptop cần quyền truy cập địa chỉ IP camera; backend public không thể truy cập IP nội bộ.

## Giới hạn
- Relay mặc định chỉ chuyển tiếp video. Có **chế độ OpenCV đo mực nước thử nghiệm** (bật riêng), chưa huấn luyện mô hình học sâu và chưa ghi MySQL.
- Người mở URL xem Web có thể xem camera nếu Web được công khai; tránh quay thông tin riêng tư.
- WebSocket mất kết nối thì thẻ báo ngoại tuyến. Chất lượng/video phụ thuộc laptop, Wi-Fi, dữ liệu 4G và tài nguyên Render.
- Mỗi máy chủ backend có bộ nhớ khung hình riêng. Dùng **một instance** cho luồng video; nếu scale nhiều instance cần hạ tầng fanout chung.
- Truyền liên tục tốn dữ liệu di động. Có thể đặt `CAMERA_RELAY_FPS=2` khi demo.

## Tự tìm IP camera khi DHCP thay đổi
Firmware ESP32 (sau khi Wi-Fi kết nối):
```cpp
#include <ESPmDNS.h>
if (MDNS.begin("floodguard-cam")) {
  MDNS.addService("http", "tcp", 80); // đổi 80 nếu web server thực tế dùng cổng khác
}
```
Relay ưu tiên `CAMERA_URL` nếu được đặt; nếu không sẽ tự phân giải `floodguard-cam.local`, tiếp theo tìm dịch vụ `_http._tcp.local.` với hostname đúng `floodguard-cam.local`. Cần laptop và ESP32 cùng LAN, không bị chặn multicast/mDNS bởi hotspot. Nếu hotspot không hỗ trợ, có thể đặt `CAMERA_FALLBACK_URL=http://IP_HIEN_TAI/stream` trong PowerShell. Không cần thay đổi backend hoặc web.

Trên PowerShell, nếu trước đây từng đặt CAMERA_URL cố định, chạy `Remove-Item Env:CAMERA_URL -ErrorAction SilentlyContinue` trước `py relay.py`. Cài lại thư viện bằng `py -m pip install -r requirements.txt`.

## Giai đoạn 2 – nhận diện mực nước bằng OpenCV (thử nghiệm)

**Lưu ý:** Đây là thuật toán phân đoạn màu cho nước nhuộm xanh trong bể demo, **chưa phải AI học sâu** và không đáng tin với nước trong suốt, phản chiếu mạnh, người hoặc vật màu xanh. Không dùng làm căn cứ cảnh báo thực địa. Webcam phải đặt cố định; khi đổi góc quay phải hiệu chuẩn lại.

1. Đặt camera nhìn thấy thành bể và mặt nước; ưu tiên nước có màu xanh rõ, nền bể không xanh. Chỉ chọn một dải hẹp của bể không có chữ/vật màu xanh.
2. Trong `camera-relay/camera-ai.json`:
   - `roi`: vùng đo `x1,y1,x2,y2`, tọa độ **tỷ lệ 0..1** so với khung hình (x từ trái sang phải, y từ trên xuống).
   - `zero_y`: tọa độ y (0..1) tương ứng **mặt nước mức 0 cm** trong ảnh.
   - `full_y`: tọa độ y (0..1) tại **mức nước chuẩn trên**, ví dụ thành bể 17 cm; `full_y` phải **nhỏ hơn** `zero_y`.
   - `full_cm`: chiều cao thực đo giữa hai mốc, đơn vị cm. Mặc định ví dụ 17 cm; **hãy đo lại trên mô hình**.
   - Đổi `calibrated` thành `true` **chỉ sau khi đo đủ hai mốc**. Nếu `false`, màn hình hiện `AI: NEED CALIBRATION`, không có số đo giả.
3. Mở PowerShell trong thư mục `camera-relay` và chạy:
   ```powershell
   $env:CAMERA_AI_ENABLED="1"
   & "C:\Users\doanb\AppData\Local\Programs\Python\Python313\python.exe" relay.py
   ```
   Vẫn cần `CAMERA_STREAM_KEY` đã được đặt trong cùng phiên PowerShell như hướng dẫn giai đoạn 1.
4. Trên Web FloodGuard, thẻ Camera sẽ hiển thị đường ngang màu xanh lá và nhãn `AI DEMO: ... cm` **nếu nhận diện hợp lệ**; trường hợp không tìm thấy nước hoặc chưa hiệu chuẩn sẽ có nhãn lỗi thay vì số đo.
5. Muốn tắt thử nghiệm và trở lại video không xử lý: `$env:CAMERA_AI_ENABLED="0"`, rồi khởi động lại `relay.py`.

Chương trình hiện **không tự gửi cm về Backend và không ghi database**. Bước sau sẽ bổ sung dữ liệu có timestamp + trạng thái chất lượng đo, sau khi kiểm chứng với thước thật qua nhiều mực nước. Vùng đo HSV mặc định chỉ nhắm đến nước xanh, có thể cần điều chỉnh theo ánh sáng.
