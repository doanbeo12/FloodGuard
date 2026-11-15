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

## Bản sửa ổn định MJPEG (2026-11-15)

`relay.py` hiện dùng `mjpeg_reader.py` đọc MJPEG bằng HTTP thay vì OpenCV/FFmpeg `VideoCapture`. Bộ đọc kiểm tra marker JPEG, giới hạn buffer 1 MB, timeout 8 giây khi camera không gửi thêm dữ liệu; khi stream ngắt, relay tự đóng và kết nối lại sau 3 giây. Phần gửi WebSocket tới Render và chế độ AI tùy chọn không thay đổi.

Trên laptop Windows, dừng relay bằng Ctrl+C, cập nhật mã nguồn rồi chạy lại:
```powershell
cd "C:\Users\doanb\Desktop\FloodGuard"
git pull origin main
cd camera-relay
$env:CAMERA_RELAY_FPS="2"
$env:CAMERA_AI_ENABLED="0"
# CAMERA_STREAM_KEY phải được cấu hình trong PowerShell này (không ghi khóa lên GitHub).
& "C:\Users\doanb\AppData\Local\Programs\Python\Python313\python.exe" relay.py
```

Nếu DNS .local trên Windows không hoạt động, `relay.py` vẫn thử tìm camera bằng Zeroconf. Hãy đảm bảo không đặt `CAMERA_URL` cố định cũ: `Remove-Item Env:CAMERA_URL -ErrorAction SilentlyContinue`. Bộ đọc mới không chữa được lỗi camera bị khóa cứng, Wi-Fi mất kết nối hoặc nguồn yếu. Nếu hiện `ESP32 MJPEG stream ended` / `timed out`, xem thêm `/health` trên firmware camera để chẩn đoán.


## Snapshot mode (2026-11-15) — mặc định từ commit 03be42c

**Yêu cầu firmware ESP32-S3-CAM v1.2 Diagnostics** với endpoint \`http://IP_CAMERA:81/capture\`. Endpoint \`/stream\` cổng 80 không còn được relay sử dụng. Không cần sửa Backend Render.

- Relay lấy 1 ảnh JPEG qua HTTP GET mỗi chu kỳ, mặc định **2 FPS**; sau đó vẫn mã hóa và truyền JPEG lên Render qua WebSocket.
- Mỗi lần GET có timeout 4 giây và giới hạn kích thước JPEG 512 KB; nếu camera trả ảnh không hợp lệ sẽ tự thử lại sau 3 giây.
- Tự tìm IP bằng mDNS/Zeroconf. Relay thử tải ảnh từ từng IP trước khi chấp nhận, tránh IP .local bị cache cũ (nếu Zeroconf vẫn tìm thấy camera).
- \`CAMERA_SNAPSHOT_URL\` cho phép chỉ định URL chụp nếu cần gỡ lỗi, ví dụ \`http://192.168.1.20:81/capture\`; hãy **xóa biến này** khi cần tự tìm IP.
- Biến \`CAMERA_URL\` cũ vẫn được nhận; nếu là URL \`/stream\`, relay tự đổi sang cổng 81 và \`/capture\`, nhưng nếu IP cũ thì không tự tìm được. Cần xóa \`CAMERA_URL\` và \`CAMERA_FALLBACK_URL\` để hoàn toàn tự động.

Cách chạy trên laptop Windows:
\`\`\`powershell
cd "C:\Users\doanb\Desktop\FloodGuard"
git pull origin main
cd camera-relay
Remove-Item Env:CAMERA_URL -ErrorAction SilentlyContinue
Remove-Item Env:CAMERA_SNAPSHOT_URL -ErrorAction SilentlyContinue
Remove-Item Env:CAMERA_FALLBACK_URL -ErrorAction SilentlyContinue
$env:CAMERA_MDNS_NAME="floodguard-cam"
$env:CAMERA_RELAY_FPS="2"
$env:CAMERA_AI_ENABLED="0"
# Đặt CAMERA_STREAM_KEY trong PowerShell, bằng khóa của Backend Render (không commit lên GitHub)
& "C:\Users\doanb\AppData\Local\Programs\Python\Python313\python.exe" relay.py
\`\`\`

Khi ổn định, xuất hiện \`Camera snapshot endpoint: http://IP:81/capture\` và \`Connected to relay\`. Nếu lỗi \`The write operation timed out\` vẫn còn, đó là lỗi gửi từ laptop đến Render chứ không được giải quyết hoàn toàn bằng đổi MJPEG sang snapshot. Nếu /capture bị kẹt ngay trên ESP32, cần xem /health và nguồn cấp.

**Giới hạn:** snapshot 2 FPS không phải video mượt; mỗi ảnh tạo một request HTTP mới, có thể tăng overhead. Không đoán IP khi mDNS/hotspot bị chặn. Chế độ AI thử nghiệm vẫn chưa hiệu chuẩn/không ghi database.


## Giai đoạn camera AI 0–10 cm + Web (2026-11-15)

Web có ô riêng "Mực nước camera AI" ngay dưới video. Backend WebSocket \`/camera/uplink\` nhận thêm bản tin JSON từ laptop theo định dạng \`{"type":"ai","status":"ok","levelCm":5.2,"confidence":0.7}\`, rồi phát cho client \`/camera/view\`. Dữ liệu **chỉ hiển thị**, chưa lưu DB và không tác động cảnh báo hiện tại. Số đo hợp lệ bắt buộc trong khoảng 0–10 cm; kết quả bị mất/không hiệu chuẩn phải hiển thị "--".

Đây là thuật toán OpenCV **thử nghiệm**, không phải mô hình AI học sâu đã huấn luyện. Ảnh ChatGPT tại 0,5,10 cm dùng để đánh giá bố trí camera, không thể coi tọa độ pixel đã hiệu chuẩn chính xác vì ảnh chụp màn hình bị cắt/kéo khung khác nhau. Thao tác hiệu chuẩn cần thực hiện **một lần trên laptop với camera và thước cố định**, bằng ảnh JPEG gốc của chính ESP32:

1. Dừng \`relay.py\`. Giữ ESP32 v1.3 hoạt động, không đổi vị trí camera và thước, tránh chiếu sáng phản xạ quá mạnh.
2. Mở PowerShell tại \`camera-relay\` và chạy:
   \`\`\`powershell
   & "C:\Users\doanb\AppData\Local\Programs\Python\Python313\python.exe" calibrate_water.py
   \`\`\`
3. Khi chương trình yêu cầu, đưa nước về **0 cm** (theo mốc thước), đợi ổn định, nhấn Enter. Trên cửa sổ ảnh, nhấp đúng mốc 0 trên thước và nhấn Enter.
4. Đưa nước đến **5 cm**, đợi ổn định. Chương trình sẽ cho chọn ROI: **kéo một hình chữ nhật dọc, hẹp, nằm cạnh mép thước và phủ cả vùng ranh giới nước 0–10 cm**, nơi màu nước xanh tăng từ dưới lên khi nước dâng. Xác nhận ROI bằng Enter/Space. Sau đó nhấp đường mặt nước tại thước và nhấn Enter.
5. Đưa nước đến **10 cm** và nhấp đường mặt nước tại thước; nhấn Enter. \`camera-ai.json\` sẽ cập nhật ba mốc chuẩn và \`calibrated: true\`.
6. Chạy thử relay với AI:
   \`\`\`powershell
   $env:CAMERA_AI_ENABLED="1"
   $env:CAMERA_RELAY_FPS="0.5"
   & "C:\Users\doanb\AppData\Local\Programs\Python\Python313\python.exe" relay.py
   \`\`\`
   Cần có \`CAMERA_STREAM_KEY\` đúng với Backend Render trong phiên PowerShell. Chạy \`git pull origin main\` trước khi hiệu chuẩn, **không** pull ghi đè \`camera-ai.json\` sau khi đã hiệu chuẩn.
7. Kiểm tra thực tế thêm ở **2,4,6,8 cm**; tính MAE = trung bình trị tuyệt đối của (AI - thước). Nếu thuật toán báo \`not_detected\` hoặc \`low_confidence\`, xem lại ROI, ánh sáng và màu nước. Không sử dụng số đo chưa kiểm chứng cho quyết định an toàn.

Nếu camera trả ảnh lỗi hoặc không còn nhìn thấy ranh giới nước, Web hiển thị "Chưa xác định", không hiển thị số đo suy đoán. Nếu thước/camera bị di chuyển, phải hiệu chuẩn lại.

**Lưu ý về firmware v1.3:** Relay không còn chụp ảnh thử lúc tìm IP để tránh lỗi HTTP 429 do hai lần chụp liên tiếp. Chế độ snapshot hiện đặt timeout 10 giây cho việc lấy ảnh, và một luồng video vẫn phụ thuộc vào tốc độ đáp ứng của ESP32 và Internet. Nếu có thể, chỉ mở Web FloodGuard thay vì thêm tab /capture hoặc /stream trực tiếp.

**Triển khai Web:** Các thay đổi Backend và Web cần được Render deploy từ nhánh main; nếu auto-deploy đang tắt, thực hiện deploy theo cấu hình dịch vụ của bạn. Không thể xác nhận đang chạy production chỉ từ việc push GitHub.


## Camera ổn định qua HTTPS (2026-11-15): Web cập nhật mục tiêu 2 giây/ảnh

**Bản mới thay đổi đường truyền mặc định** vì một số mạng laptop gặp \`The write operation timed out\` / \`10053\` khi gửi JPEG qua WebSocket liên tục. Không cần nạp lại firmware ESP32.

Đường truyền: \`ESP32 :81/capture -> Python OpenCV + AI -> HTTPS POST /camera/ai và /camera/frame -> Render -> HTTPS GET /camera/status, /camera/latest.jpg -> Web\`. Camera AI, ảnh và việc gửi qua Internet vẫn chạy độc lập. Server chỉ giữ ảnh mới nhất trong RAM, không ghi DB; khi không có ảnh mới trong 15 giây sẽ báo offline. Web vẫn hiện **ảnh cuối** nhưng ghi rõ "Đang kết nối lại", không giả vờ đang live.

Cần deploy cả **backend** lẫn **web** từ GitHub main sau khi push mã. Nếu Render Auto Deploy bật, theo dõi deploy mới nhất; nếu Auto Deploy tắt, deploy thủ công từ Render Dashboard.

Trên laptop:
\`\`\`powershell
cd "C:\Users\doanb\Desktop\FloodGuard"
git pull origin main
cd camera-relay
& "C:\Users\doanb\AppData\Local\Programs\Python\Python313\python.exe" -m pip install -r requirements.txt
$env:CAMERA_TRANSPORT="http"
$env:CAMERA_AI_ENABLED="1"
$env:CAMERA_RELAY_FPS="0.5"
$env:CAMERA_JPEG_QUALITY="85"
$env:CAMERA_MAX_WIDTH="1024"
Remove-Item Env:CAMERA_URL -ErrorAction SilentlyContinue
Remove-Item Env:CAMERA_SNAPSHOT_URL -ErrorAction SilentlyContinue
Remove-Item Env:CAMERA_FALLBACK_URL -ErrorAction SilentlyContinue
# CAMERA_STREAM_KEY vẫn lấy từ biến bí mật Render; tuyệt đối không commit.
& "C:\Users\doanb\AppData\Local\Programs\Python\Python313\python.exe" relay.py
\`\`\`

Nếu mDNS bị chặn nhưng IP hiện tại dùng được, bạn có thể tạm đặt \`CAMERA_SNAPSHOT_URL="http://IP:81/capture"\`. Xóa biến này khi muốn tự động tìm IP theo DHCP.

**Kiểm tra:** Mở \`https://floodguard-backend-4dua.onrender.com/camera/status\`. Sau khi deploy Backend, cần trả JSON (trước khi chạy relay có thể \`online:false\`). Khi laptop chạy bản HTTP sẽ in \`HTTPS camera uploaded frame #...\`; Web nhận ảnh mới mỗi ~2 giây nếu camera và Internet đáp ứng. Nếu xuất hiện HTTP 404 tại \`/camera/frame\`, Backend chưa được deploy bản mới. HTTP 401 là sai \`CAMERA_STREAM_KEY\`. Nếu timeout ở HTTPS POST dù ảnh chụp trực tiếp ổn, cần xem mạng upload/Render; phần mềm không thể bảo đảm video live liên tục khi mất Internet.

Để tạm trở về WebSocket upload cũ trong khi điều tra, \`$env:CAMERA_TRANSPORT="websocket"\`, nhưng Web mới đọc khung qua HTTP endpoints nên hai bên phải dùng cùng phiên bản đường truyền; chỉ bật chế độ này khi đồng thời dùng Web phiên bản cũ hoặc đã cấu hình cầu nối phù hợp.
