# FloodGuard – Random Forest dự báo cảm biến (không dùng weather API)

## Mục tiêu
- **3 giờ mô phỏng = 3 phút thực**: (1) dự báo bắt đầu mưa nếu chưa mưa; (2) dự báo đạt ngưỡng ngập 7 cm qua AI, tách biệt.
- **24 / 48 / 64 giờ mô phỏng = 24 / 48 / 64 phút thực**: dự báo có mưa trong khoảng **5 phút thực** quanh mốc đó.
- Dữ liệu: AHT20 nhiệt/ẩm, BMP180 áp suất, gió reed, gàu lật, bản mưa DO và mực nước AI.
- 14 features gồm số đo hiện tại và xu hướng 2 phút trước. Khả năng dự báo chỉ được hiển thị khi có mô hình được huấn luyện; không có model thì Web ghi "Chưa huấn luyện RF".

## 1. Cài thư viện trong Windows PowerShell

```powershell
cd "C:\Users\doanb\Desktop\FloodGuard"
git pull origin main
cd ml-random-forest
python -m pip install -r requirements.txt
```

## 2. Ghi dữ liệu thật từ MQTT

```powershell
python record_mqtt.py --session demo_kho_01
```

Mỗi buổi chạy ghi ra `data/demo_kho_01.csv`. Dừng bằng Ctrl+C.
Lần sau dùng tên `--session` **khác** (`demo_mua_01`, `demo_mua_02`, ...).

Cần ít nhất **4 buổi đo độc lập**, đặc biệt cần các đợt mưa, khô, mực nước vượt ngưỡng 7 cm và không vượt ngưỡng. Để huấn luyện mốc 64 giờ mô phỏng, phải thu **ít nhất ~67 phút thực trong mỗi buổi** tương ứng. Nhiều ảnh liên tiếp từ camera không thay thế được các chuỗi sensor có nhãn tương lai.

Giữ camera relay / MQTT Node 1 hoạt động. Giữ an toàn mô hình bơm khi tạo chu kỳ thử nghiệm.

## 3. Huấn luyện

```powershell
python train.py --data data --output ..\backend\models\node1-rf.json
```

- Script tự gán nhãn theo số đo **xảy ra sau** từng thời điểm, loại các khung dữ liệu thiếu hoặc mất gói dài.
- Train/test chia **theo session** (`GroupShuffleSplit`), không trộn các mẫu thời gian gần nhau.
- Mỗi bài toán `rain3`, `flood3`, `rain24`, `rain48`, `rain64` chỉ được huấn luyện nếu có cả lớp 0/1 và đủ mẫu; bài nào thiếu bị bỏ qua.
- In `accuracy`, `balancedAccuracy`, `precision`, `recall`, `F1`, `ROC AUC` trên session kiểm tra. Các giá trị chỉ thể hiện tập thử nghiệm, không thay thế đánh giá thực địa.
- Nếu thiếu dữ liệu, chương trình không tạo model giả.

## 4. Đưa model vào Web

Sau khi `node1-rf.json` được tạo:

```powershell
cd ..
git add backend/models/node1-rf.json
git commit -m "train: add real sensor Random Forest model"
git push origin main
```

Render tự triển khai Backend; file `backend/node1-rf.js` giải mã cây Random Forest bằng JavaScript, không cần cài Python/scikit-learn trên Render.

Kiểm tra: `https://floodguard-backend-4dua.onrender.com/api/node1/forecast` rồi Web.

**Lưu ý:** Bộ dữ liệu trên laptop là nguồn huấn luyện chính, không cần MySQL Render. Mô hình trên broker công khai chỉ dùng cho demo; không gửi khóa hoặc định danh cá nhân.
