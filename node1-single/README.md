# FloodGuard – Node 1 (ESP32 + A7680C)

Node 2, Central và ESP-NOW đã loại bỏ. Node 1 đọc cảm biến, nhận kết quả OpenCV/YOLO từ laptop qua Wi-Fi nội bộ và đẩy trạng thái qua SIM A7680C tới Backend Render.

## GPIO

| Tín hiệu | GPIO |
|---|---:|
| A7680C TX -> ESP RX | 18 |
| A7680C RX <- ESP TX | 19 |
| AHT20 / BMP180 SDA, SCL | 21, 22 |
| Gàu lật reed | 27 |
| Cảm biến gió reed | 26 |
| Mưa tấm DO | 25 |
| JSN TRIG / ECHO | 33 / 34 |
| MOSFET bơm cấp / hồi | 23 / 32 |

JSN ECHO 5 V **phải qua chuyển mức** trước khi vào ESP32. Bơm dùng nguồn 5 V riêng đủ dòng và diode flyback nếu module MOSFET chưa có. Đấu chung mass điều khiển. GPIO MOSFET cần điện trở kéo về trạng thái tắt trong lúc khởi động. UART A7680C và mức cấp nguồn **phụ thuộc board**, không đấu trực tiếp UART lõi module nếu chưa có level shifter.

## Cấu hình

1. Mở thư mục này bằng VS Code + PlatformIO.
2. Sửa \`include/config.h\`: hai SSID, mật khẩu, \`NODE_AI_KEY\`, \`NODE_UPLOAD_KEY\`, APN SIM, chiều kích MOSFET. Không commit khóa riêng tư.
3. Trên Render backend, đặt biến bí mật \`NODE1_UPLOAD_KEY\` bằng đúng khóa \`NODE_UPLOAD_KEY\` trong firmware.
4. Laptop trong \`camera-relay\`: \`NODE1_AI_KEY\` bằng \`NODE_AI_KEY\` (khóa khác với \`CAMERA_STREAM_KEY\`), \`NODE1_URL\` tùy chọn (ví dụ \`http://192.168.1.50\`). Nếu không thiết lập URL, relay sẽ tìm \`floodguard-node1.local\` bằng mDNS/Zeroconf.
5. Nạp firmware và kiểm tra Serial Monitor 115200. Khi Wi-Fi đã kết nối, in IP Node.
6. **Thử không có bơm:** Mặc định \`ENABLE_PUMPS 0\` và \`ENABLE_4G_UPLOAD 0\`. Kiểm tra JSON \`http://<node-ip>/status\` và gửi AI với header \`X-Node-Key\` từ laptop.
7. Khi đã kiểm tra nguồn và modem bằng lệnh AT, bật \`ENABLE_4G_UPLOAD 1\`. Sau khi kiểm tra bơm, ngưỡng, ngắt dòng và interlock, mới bật \`ENABLE_PUMPS 1\`.

## Mạch hoạt động

- Gàu có xung -> bật bơm cấp nếu AI hợp lệ và dưới 8,8 cm.
- Không có xung gàu >30 giây -> bơm hồi nếu mực nước trên 1 cm.
- AI mất quá 10 giây, confidence <0,60, JSN quá cao hay hai phép đo lệch >3 cm -> tắt cả hai bơm.
- Không bật đồng thời; trễ đổi bơm 1,5 giây.
- Quá thời gian cấp 60s/hồi 90s -> khóa lỗi, cần yêu cầu POST \`/reset\` kèm \`X-Node-Key\` sau khi kiểm tra phần cứng.
- AI không hợp lệ **không bị biến thành 0 cm**.

## Backend và Web

- Backend \`POST /api/node1/telemetry\` bảo vệ bằng header \`X-Node-Key\` và biến \`NODE1_UPLOAD_KEY\`.
- Web đọc \`GET /api/node1/status\` mỗi 5 giây, camera từ \`/camera/status\`.
- Backend mới giữ telemetry mới nhất **trong RAM**, chưa ghi vào bảng lịch sử; service restart sẽ mất giá trị cuối.
- Chỉ bật Render và deploy Backend + Web bản mới khi cần.

## Giới hạn cần kiểm thử

- A7680C sử dụng tập lệnh HTTP(S) \`AT+HTTPINIT\`, \`AT+HTTPPARA\`, \`AT+HTTPDATA\`, \`AT+HTTPACTION\`. Lệnh và chứng chỉ TLS có thể cần sửa theo firmware/board thực tế; kiểm tra \`AT+GMR\` và trả HTTP 2xx trước khi coi đường 4G đã hoạt động.
- Chương trình **chưa build và chưa kiểm thử điện thật**. Không cho phép điều khiển bơm tự động nếu chưa kiểm tra nguồn, khả năng đọc AI ở 0–3cm, rơ-le/MOSFET và biện pháp chống tràn vật lý.
- \`/ai\` chạy HTTP trong Wi-Fi nội bộ với khóa bí mật; không mở cổng này ra Internet hoặc Wi-Fi công cộng. Nếu cần bảo mật cao hơn, dùng mạng nội bộ riêng và TLS/proxy xác thực.
- Mô hình nhận diện trên laptop hiện là OpenCV hiệu chuẩn, **chưa tự động biến thành YOLO**; YOLO cần dữ liệu gán nhãn và model đã huấn luyện.
