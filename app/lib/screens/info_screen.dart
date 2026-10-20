import 'package:flutter/material.dart';

class InfoScreen extends StatelessWidget {
  const InfoScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 30),
      children: [
        const Text(
          'Thông tin hệ thống',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 4),
        const Text(
          'Cấu trúc và nguyên lý hoạt động của FloodGuard',
          style: TextStyle(color: Color(0xFF6B7280), fontSize: 12),
        ),
        const SizedBox(height: 18),
        _card(
          'Trạm mưa và ngập đường',
          'ESP32 đọc nhiệt độ, độ ẩm, áp suất, tốc độ quay cốc gió, gàu lật, cảm biến mưa và mực nước đường.',
          Icons.cloud_outlined,
        ),
        _card(
          'Trạm triều',
          'ESP32 đo mực nước triều bằng cảm biến siêu âm. Hai bơm nước tạo các chu kỳ triều trên mô hình để thu dữ liệu thử nghiệm.',
          Icons.waves_outlined,
        ),
        _card(
          'Trạm trung tâm',
          'Nhận dữ liệu từ hai trạm qua ESP-NOW, sau đó truyền lên máy chủ qua SIM 4G và giao thức MQTT.',
          Icons.hub_outlined,
        ),
        _card(
          'Máy chủ và cơ sở dữ liệu',
          'Dữ liệu được lưu vào MySQL khoảng 5 giây một lần. Máy chủ tạo dự báo mưa, dự báo triều và dự báo nguy cơ ngập.',
          Icons.dns_outlined,
        ),
        const SizedBox(height: 8),
        _section('Nguyên lý dự báo'),
        const SizedBox(height: 9),
        _logic(
          '1',
          'Dự báo mưa',
          'Dựa vào xu hướng độ ẩm, áp suất, chênh lệch điểm sương, nhiệt độ và tốc độ gió. Cảm biến mưa và gàu lật dùng để xác nhận mưa đã bắt đầu.',
        ),
        _logic(
          '2',
          'Dự báo triều',
          'Dựa vào lịch sử mực nước triều, xu hướng hiện tại và chu kỳ đã học. Trạng thái bơm không được dùng làm đầu vào dự báo.',
        ),
        _logic(
          '3',
          'Dự báo ngập',
          'Kết hợp mực nước đường hiện tại, xu hướng mực nước, dự báo mưa và dự báo triều để ước lượng nguy cơ trong 1–3 giờ mô phỏng.',
        ),
        const SizedBox(height: 18),
        _section('Ngưỡng cảnh báo mô hình'),
        const SizedBox(height: 9),
        _threshold('Bình thường', '< 4 cm', const Color(0xFF159447)),
        _threshold('Theo dõi', '4 – < 8 cm', const Color(0xFFD9A400)),
        _threshold('Cảnh báo', '8 – < 12 cm', const Color(0xFFEF7D17)),
        _threshold('Nguy hiểm', '≥ 12 cm', const Color(0xFFD73535)),
        const SizedBox(height: 18),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: const Color(0xFFFFF7ED),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: const Color(0xFFFED7AA)),
          ),
          child: const Text(
            'FloodGuard hiện được kiểm tra trên mô hình thực nghiệm. '
            'Các ngưỡng và hệ số dự báo cần tiếp tục hiệu chuẩn bằng dữ liệu đo thực tế.',
            style: TextStyle(
              fontSize: 12,
              color: Color(0xFF6B4F2A),
              height: 1.4,
            ),
          ),
        ),
      ],
    );
  }

  Widget _section(String title) {
    return Text(
      title,
      style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
    );
  }

  Widget _card(String title, String detail, IconData icon) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(15),
      decoration: _decoration(),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: const Color(0xFFEAF3FA),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(icon, color: const Color(0xFF1769AA)),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.bold)),
                const SizedBox(height: 4),
                Text(
                  detail,
                  style: const TextStyle(
                    fontSize: 12,
                    color: Color(0xFF6B7280),
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _logic(String number, String title, String detail) {
    return Container(
      margin: const EdgeInsets.only(bottom: 9),
      padding: const EdgeInsets.all(14),
      decoration: _decoration(),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 29,
            height: 29,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: Color(0xFF1769AA),
              shape: BoxShape.circle,
            ),
            child: Text(
              number,
              style: const TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.bold)),
                const SizedBox(height: 4),
                Text(
                  detail,
                  style: const TextStyle(
                    fontSize: 12,
                    color: Color(0xFF6B7280),
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _threshold(String name, String value, Color color) {
    return Container(
      margin: const EdgeInsets.only(bottom: 7),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      decoration: _decoration(),
      child: Row(
        children: [
          Container(
            width: 9,
            height: 9,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 9),
          Expanded(child: Text(name)),
          Text(value, style: const TextStyle(fontWeight: FontWeight.bold)),
        ],
      ),
    );
  }

  BoxDecoration _decoration() {
    return BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: const Color(0xFFE1E8F0)),
    );
  }
}
