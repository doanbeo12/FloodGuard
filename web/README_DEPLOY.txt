FloodGuard Web 1.0

Mục đích: web cho người dùng cuối, đọc cùng FloodGuard Backend API.

Local:
  npm install
  API_BASE_URL=http://localhost:3001 npm start
  mở http://localhost:8080

Railway:
- Deploy thư mục này thành 1 service.
- Variable: API_BASE_URL=https://<public-backend-domain>
- Generate Domain cho service web.
- Healthcheck: /health

Web tự cập nhật:
- Site/status: 5 giây
- History: 15 giây
- Weather: 10 phút
