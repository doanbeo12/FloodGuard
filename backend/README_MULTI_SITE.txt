FLOOD MONITORING BACKEND v1.6.0 - MULTI-SITE
=============================================

Mô hình hiện tại:
- site_id = 1: Đường số 1 -> dữ liệu thật từ 2 Node.
- site_id = 2: Đường số 2 -> chưa triển khai.
- site_id = 3: Đường số 3 -> chưa triển khai.

API mới cho Flutter:
1) GET /api/sites
   Danh sách tất cả địa điểm và dữ liệu mới nhất nếu đã triển khai.

2) GET /api/sites/1/status
   Trạng thái mới nhất của Đường số 1, gồm Node 1 + Node 2 + mưa + trend + cảnh báo.

3) GET /api/sites/1/history?hours=6
   Lịch sử Đường số 1 trong 6 giờ gần nhất.

API cũ vẫn giữ:
- /api/history/sensors
- /api/history/events
- /api/history/devices
- /api/tide/hcmc
- /api/weather/hcmc
- /api/early-warning

/api/history/sensors hỗ trợ thêm ?site_id=1
/api/early-warning hỗ trợ thêm ?site_id=1

MQTT:
- Dữ liệu mới được lưu với DEFAULT_SITE_ID (mặc định = 1).
- Central hiện tại vì thế tự động thuộc Đường số 1.

CÀI / CHẠY
-----------
1. Copy file .env đang dùng ở backend cũ sang thư mục backend mới.
2. Trong .env nên thêm:
      DEFAULT_SITE_ID=1
      CENTRAL_TIMEOUT_MS=20000
3. Mở terminal trong thư mục backend:
      npm install
4. Có thể chạy an toàn:
      npm run db:init
   Script KHÔNG xóa sensor_readings. Nó bổ sung cấu trúc thiếu và seed 3 địa điểm.
5. Chạy:
      npm start

TEST TRÊN TRÌNH DUYỆT
---------------------
http://localhost:3001/api/sites
http://localhost:3001/api/sites/1/status
http://localhost:3001/api/sites/1/history?hours=6

Kết quả mong đợi:
- Đường số 1: ACTIVE/DEPLOYED, có latest data.
- Đường số 2: NOT_DEPLOYED.
- Đường số 3: NOT_DEPLOYED.

GHI CHÚ
-------
- latitude/longitude hiện để NULL cho tới khi bạn xác định vị trí muốn hiển thị trên bản đồ.
- Chưa làm Forecast API, Firebase notification hoặc phân loại nguyên nhân mưa/triều ở bản này.
  Nên xác nhận 3 API Multi-Site hoạt động trước rồi mới làm tiếp.


SITE-SPECIFIC TIDE (v1.6.1)
=============================
- monitoring_sites.tide_station maps a deployed site to one tide station.
- Site 1 / Đường số 1 -> THU_DAU_MOT.
- PHU_AN and NHA_BE remain in tide_forecasts for Dashboard/HCMC aggregate.
- /api/tide/hcmc is unchanged.
- New route: GET /api/sites/:id/tide
- /api/sites/:id/status now also returns `tide`.
- Tide summary provides previous/next HIGH/LOW event, next high/low, forecast coverage, and forecast-derived phase.
- It does not invent an instantaneous tide level because the source table stores forecast extrema (HIGH/LOW), not continuous real-time tide level.
- Tide summary is cached briefly to avoid repeated MySQL queries from mobile refreshes.

FLOOD CAUSE CLASSIFICATION (v1.7.0)
====================================
Mục tiêu:
- Phân loại nguyên nhân có khả năng đóng góp khi Đường số 1 đang ngập:
  + RAIN      = Mưa
  + TIDE      = Triều
  + RAIN_TIDE = Mưa + triều
- Trạng thái kỹ thuật bổ sung:
  + NONE      = Chưa ghi nhận ngập
  + UNKNOWN   = Có ngập nhưng chưa đủ bằng chứng để quy về mưa/triều

API:
- GET /api/sites/1/status trả thêm:
    flood_cause
    flood_cause_label
    flood_cause_detail

Nguyên tắc:
1. Xác nhận đang ngập khi scenario bắt đầu bằng FLOOD_* hoặc max_water_level >=
   FLOOD_CAUSE_WATER_THRESHOLD_CM (mặc định 3 cm).
2. Mưa lấy trực tiếp từ cảm biến raining của Central.
3. Triều được xem là có khả năng đóng góp khi thời điểm hiện tại nằm trong cửa sổ
   quanh mốc HIGH dự báo gần nhất của trạm site (mặc định ±180 phút).
4. Dữ liệu triều stale không được dùng để quy nguyên nhân.
5. Không nội suy / bịa ra mực triều tức thời. Backend chỉ sử dụng thời gian mốc HIGH
   đã có trong bản tin triều.
6. Phân loại này độc lập với Early Warning hiện tại; triều vẫn không làm thay đổi
   alert_level/scenario do ESP32 Central tính.

Cấu hình .env:
    FLOOD_CAUSE_WATER_THRESHOLD_CM=3
    FLOOD_CAUSE_TIDE_WINDOW_MINUTES=180

Ví dụ:
- Ngập + raining=true + gần HIGH  -> RAIN_TIDE
- Ngập + raining=true + không gần HIGH -> RAIN
- Ngập + raining=false + gần HIGH -> TIDE
- Không ngập -> NONE
- Ngập nhưng không có hai bằng chứng trên -> UNKNOWN

