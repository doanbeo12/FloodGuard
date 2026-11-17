# FloodGuard – Node 1 MQTT (SIM7680C / Wintel)

**Current transport (Nov 17, 2026):** Node 1 publishes telemetry every ~10s over SIM7680C MQTT/TCP to broker.hivemq.com:1883. Render subscribes on a dedicated topic using MQTT_NODE1_ENABLED. Old Central, Node2, ESP-NOW and HTTPS-on-SIM upload are not used.

## Setup

1. Open `node1-single` with PlatformIO. Configure Wi-Fi, local `NODE_AI_KEY` and `SIM_BAUD 9600`, APN `m9-wintel`. The pins remain GPIO18 RX / GPIO19 TX, connected to module TX / RX.
2. Confirm `MQTT_TOPIC_NODE1` in `include/config.h` equals Render `MQTT_NODE1_TOPIC` exactly: `flood-monitoring/floodguard-doanbeo12/node1-telemetry-v3`.
3. Set `ENABLE_4G_UPLOAD 1` to enable MQTT (the variable name is retained for firmware compatibility). **Keep `ENABLE_PUMPS 0` for commissioning**.
4. Render Backend Environment: `MQTT_NODE1_ENABLED=true`; `MQTT_NODE1_URL=mqtt://broker.hivemq.com:1883`; `MQTT_NODE1_TOPIC=flood-monitoring/floodguard-doanbeo12/node1-telemetry-v3`. The legacy `MQTT_ENABLED=false` and `MQTT_V2_ENABLED=false` to prevent old collectors handling incorrect data.
5. Set `NODE1_STORE_MYSQL=false` until current MySQL connectivity is repaired; change to `true` to write `node1_telemetry` after database confirmation. Current dashboard reads latest telemetry from Backend memory regardless of DB status.
6. Run the firmware, watch for `[MQTT] Connected` and `Node1 -> MQTT: OK`. Confirm Backend logs `[NODE1 MQTT] Listening` and `[NODE1] received mqtt`, then open `/api/node1/status`.

## Safety and limitations

- HiveMQ public port 1883 has **no authentication or encryption**: do not transmit secrets, GPS, phone numbers, or private data; topic secrecy does not offer security. Use a private TLS/authenticated broker before real deployment. Never control pumps based on broker messages; pump safety remains local ESP32.
- No broker or modem was physically tested in this update; logs may reveal additional AT syntax/firmware issues.
- Do **not** overwrite a locally customized `include/config.h` with placeholder Wi-Fi/keys during `git pull`. Keep a private backup.
- Camera remains MJPEG /stream -> laptop relay -> Render independently; laptop AI -> Node 1 Wi-Fi uses `NODE_AI_KEY`.

---

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
- Backend hiển thị telemetry mới nhất từ RAM. Có thể bật `NODE1_STORE_MYSQL=true` sau khi MySQL hoạt động để lưu bảng `node1_telemetry`; restart vẫn làm trạng thái realtime trở về Offline cho tới khi có lần POST mới.
- Chỉ bật Render và deploy Backend + Web bản mới khi cần.

## Giới hạn cần kiểm thử

- A7680C sử dụng tập lệnh HTTP(S) \`AT+HTTPINIT\`, \`AT+HTTPPARA\`, \`AT+HTTPDATA\`, \`AT+HTTPACTION\`. Lệnh và chứng chỉ TLS có thể cần sửa theo firmware/board thực tế; kiểm tra \`AT+GMR\` và trả HTTP 2xx trước khi coi đường 4G đã hoạt động.
- Chương trình **chưa build và chưa kiểm thử điện thật**. Không cho phép điều khiển bơm tự động nếu chưa kiểm tra nguồn, khả năng đọc AI ở 0–3cm, rơ-le/MOSFET và biện pháp chống tràn vật lý.
- \`/ai\` chạy HTTP trong Wi-Fi nội bộ với khóa bí mật; không mở cổng này ra Internet hoặc Wi-Fi công cộng. Nếu cần bảo mật cao hơn, dùng mạng nội bộ riêng và TLS/proxy xác thực.
- Mô hình nhận diện trên laptop hiện là OpenCV hiệu chuẩn, **chưa tự động biến thành YOLO**; YOLO cần dữ liệu gán nhãn và model đã huấn luyện.

## SIM7680C MKE-M21 / Wintel (cập nhật 17-11-2026)

- Dựa vào Central v1.6.2 đã hoạt động: UART ESP32 RX=18/TX=19, **9600 bps**, APN `m9-wintel`. Serial Monitor USB vẫn **115200 bps**.
- Đã bổ sung `AT` retry, `ATE0`, `AT+CPIN?`, `AT+CGDCONT=1,"IP","m9-wintel"`, `AT+CGATT=1`, và `AT+CEREG?` chờ đăng ký tối đa 20 giây; kiểm tra lại LTE định kỳ 30 giây.
- HTTPS tới Render sử dụng SSL context 0, `AT+CSSLCFG="sslversion",0,3` (TLS 1.2), `AT+CSSLCFG="enableSNI",0,1`, `AT+HTTPPARA="SSLCFG",0`, `AT+HTTPPARA="CID",1`, rồi POST JSON với `X-Node-Key`. Lệnh nào bị từ chối sẽ được báo rõ trên serial (không in khóa bí mật).
- `+HTTPACTION: 1,715,0` là **lỗi modem khi bắt tay TLS**, không phải HTTP 715 từ Backend. Bật SNI/TLS 1.2 là một biện pháp thử; nếu vẫn 715, phải kiểm tra modem firmware `AT+GMR`, thời gian TLS, và khả năng tương thích chứng chỉ/cipher.
- **Không tự động thay HTTPS bằng HTTP hoặc tắt bảo mật chứng chỉ** khi gặp lỗi TLS. Kiểm tra AT command compatibility trên phiên bản modem đang dùng.
- Luôn giữ `ENABLE_PUMPS 0` khi thử mạng. Sau khi đã điền khóa cục bộ và Render, mới đổi `ENABLE_4G_UPLOAD 1`. Không gửi giá trị các khóa trong ảnh log.
- Kiểm tra `GET https://floodguard-backend-4dua.onrender.com/api/node1/status` khi nhận `[LTE] HTTPACTION status=200`.
- Mã nguồn cập nhật trên GitHub chưa được biên dịch bằng PlatformIO và chưa thử nghiệm thực tế trên modem của người dùng. Nếu lệnh SSL bị báo ERROR, gửi log bao gồm dòng `[SIM]` (che các khóa).
