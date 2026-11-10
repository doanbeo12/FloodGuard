# FloodGuard – camera video relay (giai đoạn 1)

ESP32-S3-CAM OV3660 giữ nguyên chương trình MJPEG `/stream` đang chạy. Laptop cùng Wi-Fi/hotspot với camera đọc stream rồi đẩy JPEG (tối đa 4 FPS mặc định) qua WebSocket lên Render. Backend phát khung hình tới thẻ Camera trên Web.

## Cấu hình bắt buộc
1. Render **Backend**: đặt biến môi trường bí mật `CAMERA_STREAM_KEY` thành một chuỗi ngẫu nhiên dài (không commit GitHub). Relay chỉ cho phép laptop gửi ảnh khi có đúng key.
2. Laptop Windows PowerShell:
   ```powershell
   cd camera-relay
   py -m pip install -r requirements.txt
   $env:CAMERA_URL="http://192.168.102.9/stream"
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
