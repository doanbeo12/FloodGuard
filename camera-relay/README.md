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
- Relay này **chỉ** chuyển tiếp video: chưa AI, chưa đo cm, chưa ghi MySQL mỗi 5 giây.
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
