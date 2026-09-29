import 'package:flutter/material.dart';

class InfoScreen extends StatelessWidget {
  const InfoScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 30),
      children: [
        _buildHeader(),
        const SizedBox(height: 20),
        _heroCard(),
        const SizedBox(height: 20),
        _sectionTitle('Kiến trúc hệ thống'),
        const SizedBox(height: 11),
        _architectureCard(),
        const SizedBox(height: 20),
        _sectionTitle('Thiết bị chính'),
        const SizedBox(height: 11),
        _deviceCard(
          icon: Icons.sensors,
          title: 'Node 1',
          detail: 'ESP32 + cảm biến siêu âm + cảm biến mưa',
        ),
        _deviceCard(
          icon: Icons.sensors,
          title: 'Node 2',
          detail: 'ESP32 + cảm biến siêu âm',
        ),
        _deviceCard(
          icon: Icons.hub_outlined,
          title: 'ESP32 Central',
          detail: 'OLED, LED, buzzer, SIM 4G và bộ nguồn',
        ),
        const SizedBox(height: 20),
        _sectionTitle('Nguyên lý cảnh báo'),
        const SizedBox(height: 11),
        _logicCard(),
        const SizedBox(height: 20),
        _sectionTitle('Ngưỡng mô hình'),
        const SizedBox(height: 11),
        _thresholdCard(),
        const SizedBox(height: 20),
        _sectionTitle('Giới hạn sử dụng'),
        const SizedBox(height: 11),
        _noticeCard(),
        const SizedBox(height: 24),
        const Center(
          child: Column(
            children: [
              Text(
                'FloodGuard',
                style: TextStyle(
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF1769AA),
                ),
              ),
              SizedBox(height: 4),
              Text(
                'Hệ thống cảnh báo sớm ngập lụt triều cường đô thị',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 11,
                  color: Color(0xFF9CA3AF),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildHeader() {
    return const Row(
      children: [
        _HeaderIcon(),
        SizedBox(width: 13),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Thông tin',
                style: TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF111827),
                ),
              ),
              SizedBox(height: 2),
              Text(
                'Giới thiệu và nguyên lý hoạt động',
                style: TextStyle(
                  fontSize: 13,
                  color: Color(0xFF6B7280),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _heroCard() {
    return Container(
      padding: const EdgeInsets.all(19),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [
            Color(0xFF1769AA),
            Color(0xFF2687C5),
          ],
        ),
        borderRadius: BorderRadius.circular(21),
      ),
      child: const Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.water_drop_outlined,
            color: Colors.white,
            size: 32,
          ),
          SizedBox(height: 12),
          Text(
            'FloodGuard',
            style: TextStyle(
              color: Colors.white,
              fontSize: 21,
              fontWeight: FontWeight.bold,
            ),
          ),
          SizedBox(height: 6),
          Text(
            'Hệ thống giám sát mực nước và cảnh báo sớm nguy cơ ngập trên mô hình đường đô thị. '
            'Hai node cảm biến gửi dữ liệu về ESP32 Central, sau đó Central truyền dữ liệu lên hệ thống Cloud để lưu trữ, phân tích và hiển thị từ xa.',
            style: TextStyle(
              color: Colors.white,
              height: 1.45,
              fontSize: 12,
            ),
          ),
        ],
      ),
    );
  }

  Widget _sectionTitle(String title) {
    return Text(
      title,
      style: const TextStyle(
        fontSize: 18,
        fontWeight: FontWeight.bold,
        color: Color(0xFF111827),
      ),
    );
  }

  Widget _architectureCard() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: _cardDecoration(),
      child: Column(
        children: [
          _flowItem(
            Icons.sensors,
            'Node 1 + Node 2',
            'ESP-NOW',
          ),
          const _FlowArrow(),
          _flowItem(
            Icons.hub_outlined,
            'ESP32 Central',
            'Xử lý cục bộ + SIM 4G',
          ),
          const _FlowArrow(),
          _flowItem(
            Icons.cloud_outlined,
            'MQTT Broker (HiveMQ)',
            'Truyền dữ liệu qua Internet',
          ),
          const _FlowArrow(),
          _flowItem(
            Icons.dns_outlined,
            'Backend Node.js + MySQL',
            'Xử lý, lưu trữ và REST API',
          ),
          const _FlowArrow(),
          _flowItem(
            Icons.devices,
            'Web Dashboard + Flutter App',
            'Giám sát từ xa',
          ),
        ],
      ),
    );
  }

  Widget _flowItem(
    IconData icon,
    String title,
    String subtitle,
  ) {
    return Row(
      children: [
        Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(
            color: const Color(0xFFEAF3FA),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Icon(
            icon,
            color: const Color(0xFF1769AA),
          ),
        ),
        const SizedBox(width: 11),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                subtitle,
                style: const TextStyle(
                  color: Color(0xFF6B7280),
                  fontSize: 11,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _deviceCard({
    required IconData icon,
    required String title,
    required String detail,
  }) {
    return Container(
      margin: const EdgeInsets.only(bottom: 9),
      padding: const EdgeInsets.all(14),
      decoration: _cardDecoration(),
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: const Color(0xFFEAF3FA),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(
              icon,
              color: const Color(0xFF1769AA),
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  detail,
                  style: const TextStyle(
                    color: Color(0xFF6B7280),
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _logicCard() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: _cardDecoration(),
      child: const Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _LogicRow(
            number: '1',
            title: 'Đo và lọc dữ liệu',
            detail: 'Cảm biến siêu âm đo mực nước; dữ liệu được lọc bằng Median để giảm nhiễu.',
          ),
          _LogicDivider(),
          _LogicRow(
            number: '2',
            title: 'Xác định mức cảnh báo',
            detail: 'Central dùng ngưỡng và hysteresis để tránh cảnh báo bật/tắt liên tục.',
          ),
          _LogicDivider(),
          _LogicRow(
            number: '3',
            title: 'Phân tích xu hướng',
            detail: 'Trend, tốc độ thay đổi và ETA được dùng để phát hiện nguy cơ tăng sớm.',
          ),
          _LogicDivider(),
          _LogicRow(
            number: '4',
            title: 'Kết hợp dữ liệu triều',
            detail: 'Backend kết hợp cảm biến, mưa và triều để phân tích nguyên nhân và tạo cảnh báo tổng hợp.',
          ),
        ],
      ),
    );
  }

  Widget _thresholdCard() {
    final items = [
      ('< 3 cm', 'Bình thường', const Color(0xFF16A34A)),
      ('3 – < 7 cm', 'Cảnh báo mức 1', const Color(0xFFEAB308)),
      ('7 – < 10 cm', 'Vùng nguy cơ', const Color(0xFFF59E0B)),
      ('10 – < 15 cm', 'Cảnh báo mức 2', const Color(0xFFF97316)),
      ('≥ 15 cm', 'Cảnh báo mức 3', const Color(0xFFDC2626)),
    ];

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: _cardDecoration(),
      child: Column(
        children: items.map((item) {
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 7),
            child: Row(
              children: [
                Container(
                  width: 9,
                  height: 9,
                  decoration: BoxDecoration(
                    color: item.$3,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 9),
                Expanded(
                  child: Text(
                    item.$2,
                    style: const TextStyle(
                      color: Color(0xFF374151),
                    ),
                  ),
                ),
                Text(
                  item.$1,
                  style: const TextStyle(
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
          );
        }).toList(),
      ),
    );
  }

  Widget _noticeCard() {
    return Container(
      padding: const EdgeInsets.all(15),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF7ED),
        borderRadius: BorderRadius.circular(17),
        border: Border.all(
          color: const Color(0xFFFED7AA),
        ),
      ),
      child: const Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.info_outline,
            color: Color(0xFFF97316),
          ),
          SizedBox(width: 10),
          Expanded(
            child: Text(
              'Hệ thống hiện được xây dựng và đánh giá trên mô hình thực nghiệm. '
              'Các mức cảnh báo và kết quả phân tích phục vụ nghiên cứu, không thay thế thông tin cảnh báo thủy văn chính thức.',
              style: TextStyle(
                color: Color(0xFF6B4F2A),
                fontSize: 12,
                height: 1.45,
              ),
            ),
          ),
        ],
      ),
    );
  }

  BoxDecoration _cardDecoration() {
    return BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(17),
      border: Border.all(
        color: const Color(0xFFE5E7EB),
      ),
    );
  }
}

class _HeaderIcon extends StatelessWidget {
  const _HeaderIcon();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 48,
      height: 48,
      decoration: BoxDecoration(
        color: const Color(0xFFEAF3FA),
        borderRadius: BorderRadius.circular(15),
      ),
      child: const Icon(
        Icons.info_outline_rounded,
        color: Color(0xFF1769AA),
      ),
    );
  }
}

class _FlowArrow extends StatelessWidget {
  const _FlowArrow();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 5),
      child: Icon(
        Icons.keyboard_arrow_down_rounded,
        color: Color(0xFF9CA3AF),
      ),
    );
  }
}

class _LogicDivider extends StatelessWidget {
  const _LogicDivider();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 10),
      child: Divider(height: 1),
    );
  }
}

class _LogicRow extends StatelessWidget {
  const _LogicRow({
    required this.number,
    required this.title,
    required this.detail,
  });

  final String number;
  final String title;
  final String detail;

  @override
  Widget build(BuildContext context) {
    return Row(
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
              fontSize: 12,
            ),
          ),
        ),
        const SizedBox(width: 11),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                detail,
                style: const TextStyle(
                  color: Color(0xFF6B7280),
                  fontSize: 12,
                  height: 1.4,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
