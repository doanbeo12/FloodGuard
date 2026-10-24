import 'dart:async';

import 'package:flutter/material.dart';

import '../services/api_service.dart';
import 'info_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Map<String, dynamic> latest = {};
  Map<String, dynamic> forecast = {};
  bool loading = true;
  bool refreshing = false;
  bool clearingFault = false;
  bool demoBusy = false;
  String? error;
  int tab = 0;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    loadData();
    timer = Timer.periodic(const Duration(seconds: 5), (_) => loadData());
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  Map<String, dynamic> m(dynamic v) =>
      v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};

  double? n(dynamic v) => v == null ? null : double.tryParse(v.toString());

  String f(dynamic v, [int digits = 1]) {
    final value = n(v);
    return value == null ? '--' : value.toStringAsFixed(digits);
  }

  String time(dynamic v) {
    if (v == null) return '--';
    final dt = DateTime.tryParse(v.toString())?.toLocal();
    if (dt == null) return '--';
    String two(int x) => x.toString().padLeft(2, '0');
    return two(dt.hour) + ':' + two(dt.minute) + ':' + two(dt.second);
  }

  bool freshWithin(dynamic v, int seconds) {
    if (v == null) return false;
    final dt = DateTime.tryParse(v.toString())?.toUtc();
    if (dt == null) return false;
    final age = DateTime.now().toUtc().difference(dt).inSeconds;
    return age >= -5 && age <= seconds;
  }

  bool fresh(dynamic v) => freshWithin(v, 30);

  bool centralOnline(bool n1Fresh, bool n2Fresh) {
    if (n1Fresh || n2Fresh) return true;

    final status = (collector['centralStatus']?.toString() ?? '')
        .trim()
        .toLowerCase();
    final heartbeatFresh = freshWithin(
      collector['lastCentralStatusAt'],
      45,
    );

    return heartbeatFresh &&
        (status == 'online' ||
            status == 'connected' ||
            status == '1' ||
            status == 'true');
  }

  Map<String, dynamic> get node1 => m(latest['node1']);
  Map<String, dynamic> get node2 => m(latest['node2']);
  Map<String, dynamic> get collector => m(latest['collector']);
  Map<String, dynamic> get node2Live => m(collector['node2Live']);
  Map<String, dynamic> get rain => m(forecast['rain']);
  Map<String, dynamic> get tide => m(forecast['tide']);
  Map<String, dynamic> get flood => m(forecast['flood']);
  Map<String, dynamic> get demo => m(latest['demo']);
  Map<String, dynamic> get rainDemo => m(demo['rain_favorable']);

  bool get rainDemoEnabled {
    final value = rainDemo['enabled'];
    return value == true ||
        value == 1 ||
        value?.toString() == '1' ||
        value?.toString().toLowerCase() == 'true';
  }

  bool get node2FaultActive {
    final value = node2Live['fault'];
    return value == true || value == 1 || value?.toString() == '1' || value?.toString().toLowerCase() == 'true';
  }

  Future<void> toggleRainDemo() async {
    if (demoBusy) return;
    final target = !rainDemoEnabled;
    setState(() => demoBusy = true);
    try {
      final result = await ApiService.setRainFavorableDemo(target);
      if (!mounted) return;
      setState(() {
        latest['demo'] = {
          'rain_favorable': m(result['rain_favorable']),
        };
      });
      await loadData();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Không đổi được chế độ demo: ' + e.toString())),
      );
    } finally {
      if (mounted) setState(() => demoBusy = false);
    }
  }

  Future<void> clearNode2Fault() async {
    if (clearingFault) return;
    setState(() => clearingFault = true);
    try {
      await ApiService.clearNode2Fault();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Đã gửi lệnh xóa FAULT đến trạm triều.')),
      );
      await Future.delayed(const Duration(seconds: 2));
      await loadData();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Không gửi được lệnh: ' + e.toString())),
      );
    } finally {
      if (mounted) setState(() => clearingFault = false);
    }
  }

  Future<void> loadData() async {
    if (refreshing) return;
    refreshing = true;

    Map<String, dynamic>? latestResult;
    Map<String, dynamic>? forecastResult;
    Object? latestError;

    try {
      latestResult = await ApiService.getLatest();
    } catch (e) {
      latestError = e;
    }

    try {
      forecastResult = await ApiService.getForecast();
    } catch (_) {
      // Dữ liệu hiện tại vẫn được cập nhật khi phần dự báo tạm lỗi.
    }

    if (!mounted) {
      refreshing = false;
      return;
    }

    setState(() {
      if (latestResult != null) latest = latestResult;
      forecast = forecastResult ?? <String, dynamic>{};
      loading = false;

      if (latestResult != null || latest.isNotEmpty) {
        error = null;
      } else {
        error = latestError?.toString() ?? 'Không lấy được dữ liệu hiện tại';
      }
    });

    refreshing = false;
  }

  String alertText(String code) {
    switch (code) {
      case 'NORMAL':
        return 'Bình thường';
      case 'WATCH':
        return 'Theo dõi';
      case 'WARNING':
        return 'Cảnh báo';
      case 'DANGER':
        return 'Nguy hiểm';
      default:
        return code == 'UNKNOWN' ? 'Chờ dữ liệu' : (code.isEmpty ? '--' : code);
    }
  }

  String riskText(String code) {
    switch (code) {
      case 'LOW':
        return 'Thấp';
      case 'MEDIUM':
        return 'Trung bình';
      case 'HIGH':
        return 'Cao';
      case 'VERY_HIGH':
        return 'Rất cao';
      case 'RAIN_ACTIVE':
        return 'Đang mưa';
      default:
        return '--';
    }
  }

  String trendText(String code) {
    switch (code) {
      case 'RISING':
        return 'Đang tăng';
      case 'FALLING':
        return 'Đang giảm';
      case 'STABLE':
        return 'Ổn định';
      default:
        return '--';
    }
  }

  String onsetText(Map<String, dynamic> onset) {
    switch (onset['label']?.toString()) {
      case 'NOW':
        return 'Đang mưa';
      case 'WITHIN_1H':
        return 'Trong 1 giờ tới';
      case 'WITHIN_1_TO_2H':
        return 'Trong 1–2 giờ tới';
      case 'WITHIN_2_TO_3H':
        return 'Trong 2–3 giờ tới';
      default:
        return 'Chưa xác định';
    }
  }

  Color levelColor(String code) {
    switch (code) {
      case 'DANGER':
        return const Color(0xFFD73535);
      case 'WARNING':
        return const Color(0xFFEF7D17);
      case 'WATCH':
        return const Color(0xFFD9A400);
      default:
        return const Color(0xFF159447);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF4F7FB),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(child: page()),
            rainDemoControl(),
            NavigationBar(
              selectedIndex: tab,
              onDestinationSelected: (value) => setState(() => tab = value),
              destinations: const [
                NavigationDestination(
                  icon: Icon(Icons.dashboard_outlined),
                  selectedIcon: Icon(Icons.dashboard),
                  label: 'Tổng quan',
                ),
                NavigationDestination(
                  icon: Icon(Icons.timeline_outlined),
                  selectedIcon: Icon(Icons.timeline),
                  label: 'Dự báo',
                ),
                NavigationDestination(
                  icon: Icon(Icons.info_outline),
                  selectedIcon: Icon(Icons.info),
                  label: 'Thông tin',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget rainDemoControl() {
    final active = rainDemoEnabled;
    return Container(
      width: double.infinity,
      color: Colors.white,
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
      child: FilledButton.icon(
        onPressed: demoBusy ? null : toggleRainDemo,
        style: FilledButton.styleFrom(
          backgroundColor:
              active ? const Color(0xFFEF9A2D) : const Color(0xFF1769AA),
          foregroundColor: Colors.white,
          minimumSize: const Size.fromHeight(44),
        ),
        icon: demoBusy
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Colors.white,
                ),
              )
            : const Icon(Icons.cloud_outlined),
        label: Text(
          'Điều kiện có lợi cho mưa: ' + (active ? 'BẬT' : 'TẮT'),
          style: const TextStyle(fontWeight: FontWeight.bold),
        ),
      ),
    );
  }

  Widget page() {
    if (tab == 2) return const InfoScreen();
    if (loading && latest.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (error != null && latest.isEmpty) return errorPage();

    return RefreshIndicator(
      onRefresh: loadData,
      child: tab == 0 ? overview() : forecastPage(),
    );
  }

  Widget header(String title) {
    return Row(
      children: [
        Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            color: const Color(0xFF1769AA),
            borderRadius: BorderRadius.circular(15),
          ),
          child: const Icon(Icons.water_drop, color: Colors.white),
        ),
        const SizedBox(width: 13),
        Expanded(
          child: Text(
            title,
            style: const TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.bold,
            ),
          ),
        ),
        IconButton(onPressed: loadData, icon: const Icon(Icons.refresh)),
      ],
    );
  }

  Widget overview() {
    final n1Fresh = fresh(
      collector['node1LastReceivedAt'] ?? node1['recorded_at'],
    );
    final n2Fresh = fresh(
      collector['node2LastReceivedAt'] ?? node2['recorded_at'],
    );
    final centralFresh = centralOnline(n1Fresh, n2Fresh);
    final alert = flood['available'] == true
        ? (flood['overall_alert_level']?.toString() ?? 'NORMAL')
        : 'UNKNOWN';

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 30),
      children: [
        header('FloodGuard'),
        const SizedBox(height: 18),
        systemCard(n1Fresh, n2Fresh),
        const SizedBox(height: 13),
        warningCard(alert),
        const SizedBox(height: 22),
        sectionTitle('Mực nước hiện tại'),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: valueCard(
                'Mực nước đường',
                n1Fresh ? f(node1['water_level_cm']) + ' cm' : '--',
                Icons.water,
                const Color(0xFF1769AA),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: valueCard(
                'Mực triều',
                n2Fresh ? f(node2['tide_level_cm']) + ' cm' : '--',
                Icons.waves,
                const Color(0xFF0F8B8D),
              ),
            ),
          ],
        ),
        const SizedBox(height: 22),
        sectionTitle('Mưa và môi trường'),
        const SizedBox(height: 10),
        environmentGrid(n1Fresh),
        const SizedBox(height: 10),
        rainStateCard(n1Fresh),
        const SizedBox(height: 22),
        sectionTitle('Trạng thái dữ liệu'),
        const SizedBox(height: 10),
        statusCard(n1Fresh, n2Fresh, centralFresh),
      ],
    );
  }

  Widget systemCard(bool n1Fresh, bool n2Fresh) {
    final online = n1Fresh || n2Fresh;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: online
              ? const [Color(0xFF1769AA), Color(0xFF2787C7)]
              : const [Color(0xFF52616B), Color(0xFF74828A)],
        ),
        borderRadius: BorderRadius.circular(21),
      ),
      child: Row(
        children: [
          Icon(
            online ? Icons.cloud_done_outlined : Icons.cloud_off_outlined,
            color: Colors.white,
            size: 34,
          ),
          const SizedBox(width: 14),
          const Expanded(
            child: Text(
              'TRẠNG THÁI HỆ THỐNG',
              style: TextStyle(
                color: Colors.white,
                fontSize: 17,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget warningCard(String alert) {
    final color = levelColor(alert);
    final cause = m(flood['predicted_cause'])['label']?.toString() ?? '--';
    final horizon = m(flood['warning_horizon']);
    final early = flood['early_warning'] == true;

    String message;
    if (flood['available'] != true) {
      message =
          flood['message']?.toString() ?? 'Chưa đủ dữ liệu để dự báo ngập.';
    } else if (early && horizon.isNotEmpty) {
      message =
          'Có thể đạt ' +
          f(horizon['predicted_road_level_cm']) +
          ' cm sau khoảng ' +
          (horizon['sim_hours']?.toString() ?? '--') +
          ' giờ mô phỏng.';
    } else {
      message = 'Chưa dự báo vượt ngưỡng trong 3 giờ mô phỏng tới.';
    }

    return Container(
      padding: const EdgeInsets.all(17),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(19),
        border: Border.all(color: color.withOpacity(0.35)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: color.withOpacity(0.12),
              borderRadius: BorderRadius.circular(13),
            ),
            child: Icon(Icons.warning_amber_rounded, color: color),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  alertText(alert),
                  style: TextStyle(
                    color: color,
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  message,
                  style: const TextStyle(fontSize: 12, height: 1.4),
                ),
                const SizedBox(height: 7),
                Text(
                  'Nguyên nhân dự kiến: ' + cause,
                  style: const TextStyle(
                    color: Color(0xFF6B7280),
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget sectionTitle(String text) => Text(
        text,
        style: const TextStyle(
          fontSize: 18,
          fontWeight: FontWeight.bold,
        ),
      );

  Widget valueCard(
    String title,
    String value,
    IconData icon,
    Color color,
  ) {
    return Container(
      padding: const EdgeInsets.all(15),
      decoration: decoration(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color),
          const SizedBox(height: 10),
          Text(
            title,
            style: const TextStyle(
              fontSize: 12,
              color: Color(0xFF6B7280),
            ),
          ),
          const SizedBox(height: 4),
          Text(
            value,
            style: const TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.bold,
            ),
          ),
        ],
      ),
    );
  }

  Widget environmentGrid(bool n1Fresh) {
    String live(dynamic value, String unit, [int digits = 1]) =>
        n1Fresh ? f(value, digits) + unit : '--';

    final items = [
      ('Nhiệt độ', live(node1['temperature_c'], ' °C'), Icons.thermostat),
      ('Độ ẩm', live(node1['humidity_pct'], ' %'), Icons.water_drop_outlined),
      ('Áp suất', live(node1['pressure_hpa'], ' hPa'), Icons.speed),
      ('Điểm sương', live(node1['dew_spread_c'], ' °C'), Icons.cloud_outlined),
      ('Cốc gió', live(node1['wind_rpm'], ' RPM', 0), Icons.air),
      ('Khoảng cách', live(node1['distance_cm'], ' cm'), Icons.straighten),
    ];

    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      crossAxisSpacing: 10,
      mainAxisSpacing: 10,
      childAspectRatio: 1.7,
      children: items.map((item) {
        return Container(
          padding: const EdgeInsets.all(12),
          decoration: decoration(),
          child: Row(
            children: [
              Icon(item.$3, color: const Color(0xFF1769AA)),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.$1,
                      style: const TextStyle(
                        fontSize: 11,
                        color: Color(0xFF6B7280),
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      item.$2,
                      style: const TextStyle(fontWeight: FontWeight.bold),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      }).toList(),
    );
  }

  Widget rainStateCard(bool n1Fresh) {
    final raining = n1Fresh &&
        (node1['rain_detected'] == 1 || node1['rain_detected'] == true);
    final tips = n1Fresh
        ? (node1['rain_tips_interval'] ?? node1['rain_tips_10s'] ?? '--')
        : '--';
    final total = n1Fresh ? (node1['rain_tips_total'] ?? '--') : '--';
    final flow = n1Fresh ? f(node1['rain_flow_ml_s'], 2) : '--';
    final volume = n1Fresh
        ? f(node1['rain_volume_ml_interval'] ?? node1['rain_ml_interval'], 1)
        : '--';

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: decoration(),
      child: Row(
        children: [
          Icon(
            !n1Fresh
                ? Icons.cloud_off_outlined
                : (raining ? Icons.cloudy_snowing : Icons.wb_sunny_outlined),
            color: !n1Fresh
                ? const Color(0xFF6B7280)
                : (raining
                    ? const Color(0xFF1769AA)
                    : const Color(0xFF159447)),
            size: 29,
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Text(
              !n1Fresh ? 'Mất kết nối' : (raining ? 'ĐANG MƯA' : 'KHÔ'),
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
          ),
          Text(
            flow + ' ml/s\n' +
                volume + ' ml / mẫu\n' +
                tips.toString() + ' gàu • Tổng ' + total.toString(),
            textAlign: TextAlign.right,
            style: const TextStyle(
              fontSize: 10,
              color: Color(0xFF6B7280),
            ),
          ),
        ],
      ),
    );
  }

  Widget statusCard(bool n1Fresh, bool n2Fresh, bool centralFresh) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: decoration(),
      child: Column(
        children: [
          statusRow(
            'Trạm mưa - ngập đường',
            n1Fresh ? 'Trực tuyến' : 'Mất kết nối',
          ),
          const Divider(),
          statusRow('Trạm triều', n2Fresh ? 'Trực tuyến' : 'Mất kết nối'),
          const Divider(),
          statusRow(
            'Trạm trung tâm',
            centralFresh ? 'Trực tuyến' : 'Mất kết nối',
          ),
          const Divider(),
          statusRow('Lần lưu gần nhất', time(collector['lastSaveAt'])),
          const Divider(),
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Trạng thái bảo vệ trạm triều',
                      style: TextStyle(color: Color(0xFF6B7280)),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      !n2Fresh
                          ? '--'
                          : (node2FaultActive ? 'FAULT đang bật' : 'Bình thường'),
                      style: TextStyle(
                        fontWeight: FontWeight.bold,
                        color: !n2Fresh
                            ? const Color(0xFF6B7280)
                            : (node2FaultActive
                                ? const Color(0xFFD73535)
                                : const Color(0xFF159447)),
                      ),
                    ),
                  ],
                ),
              ),
              FilledButton.tonalIcon(
                onPressed: n2Fresh && node2FaultActive && !clearingFault
                    ? clearNode2Fault
                    : null,
                icon: clearingFault
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.restart_alt),
                label: const Text('Xóa FAULT'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget statusRow(String title, String value) {
    return Row(
      children: [
        Expanded(
          child: Text(
            title,
            style: const TextStyle(color: Color(0xFF6B7280)),
          ),
        ),
        Text(value, style: const TextStyle(fontWeight: FontWeight.bold)),
      ],
    );
  }

  Widget forecastPage() {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 30),
      children: [
        header('Dự báo'),
        const SizedBox(height: 18),
        rainCard(),
        const SizedBox(height: 13),
        tideCard(),
        const SizedBox(height: 13),
        floodCard(),

      ],
    );
  }

  Widget rainCard() {
    if (rain['available'] != true) {
      return emptyCard(
        'Dự báo mưa',
        'Chưa đủ dữ liệu môi trường để dự báo.',
      );
    }

    final risk = rain['rain_risk_label']?.toString() ?? '';
    final trends = m(rain['trends_per_real_minute']);

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: decoration(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          cardHeader('Dự báo mưa', riskText(risk), const Color(0xFF1769AA)),
          const SizedBox(height: 12),
          Row(
            children: [
              Text(
                f(rain['rain_risk_score'], 0),
                style: const TextStyle(
                  fontSize: 42,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF1769AA),
                ),
              ),
              const SizedBox(width: 8),
              const Text(
                '/ 100\nđiểm nguy cơ',
                style: TextStyle(
                  fontSize: 11,
                  color: Color(0xFF6B7280),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          statusRow(
            'Thời điểm dự kiến',
            onsetText(m(rain['expected_onset'])),
          ),
          const Divider(),
          statusRow(
            'Độ tin cậy',
            rain['confidence_label']?.toString() ?? '--',
          ),
          const Divider(),
          statusRow('Độ ẩm', trendValue(trends['humidity_pct'], '%/phút')),
          statusRow(
            'Áp suất',
            trendValue(trends['pressure_hpa'], 'hPa/phút'),
          ),
          statusRow(
            'Điểm sương',
            trendValue(trends['dew_spread_c'], '°C/phút'),
          ),
          statusRow('Cốc gió', trendValue(trends['wind_rpm'], 'RPM/phút')),
        ],
      ),
    );
  }

  String trendValue(dynamic value, String unit) {
    final x = n(value);
    if (x == null) return '--';
    final arrow = x > 0 ? '↑' : x < 0 ? '↓' : '→';
    final sign = x > 0 ? '+' : '';
    return arrow + ' ' + sign + x.toStringAsFixed(3) + ' ' + unit;
  }

  Widget tideCard() {
    if (tide['available'] != true) {
      return emptyCard(
        'Dự báo triều',
        'Chưa đủ lịch sử mực triều để tạo dự báo.',
      );
    }

    final current = m(tide['current']);
    final rows =
        tide['forecast'] is List ? List<dynamic>.from(tide['forecast']) : [];

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: decoration(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          cardHeader(
            'Dự báo triều',
            tide['confidence_label']?.toString() ?? '--',
            const Color(0xFF0F8B8D),
          ),
          const SizedBox(height: 10),
          statusRow(
            'Hiện tại',
            f(current['tide_level_cm']) +
                ' cm • ' +
                trendText(current['trend']?.toString() ?? ''),
          ),
          const Divider(),
          ...rows.map((raw) {
            final row = m(raw);
            return forecastRow(
              (row['horizon_sim_hours']?.toString() ?? '--') + ' giờ',
              f(row['level_cm']) + ' cm',
              row['method'] == 'SEASONAL_HISTORY'
                  ? 'Theo chu kỳ'
                  : 'Theo xu hướng',
            );
          }),
        ],
      ),
    );
  }

  Widget floodCard() {
    if (flood['available'] != true) {
      return emptyCard(
        'Dự báo ngập',
        flood['message']?.toString() ?? 'Chưa đủ dữ liệu mực nước đường.',
      );
    }

    final rows =
        flood['forecast'] is List ? List<dynamic>.from(flood['forecast']) : [];
    final alert = flood['overall_alert_level']?.toString() ?? 'NORMAL';
    final cause = m(flood['predicted_cause'])['label']?.toString() ?? '--';

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: decoration(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          cardHeader('Dự báo ngập', alertText(alert), levelColor(alert)),
          const SizedBox(height: 10),
          ...rows.map((raw) {
            final row = m(raw);
            return forecastRow(
              (row['horizon_sim_hours']?.toString() ?? '--') + ' giờ',
              f(row['road_level_cm']) + ' cm',
              alertText(row['alert_level']?.toString() ?? ''),
            );
          }),
          const Divider(),
          statusRow('Nguyên nhân dự kiến', cause),
          statusRow(
            'Cảnh báo sớm',
            flood['early_warning'] == true
                ? 'Đang hoạt động'
                : 'Chưa kích hoạt',
          ),
          statusRow(
            'Độ tin cậy',
            flood['confidence_label']?.toString() ?? '--',
          ),
        ],
      ),
    );
  }

  Widget cardHeader(String title, String tag, Color color) {
    return Row(
      children: [
        Expanded(
          child: Text(
            title,
            style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.bold,
            ),
          ),
        ),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
          decoration: BoxDecoration(
            color: color.withOpacity(0.12),
            borderRadius: BorderRadius.circular(999),
          ),
          child: Text(
            tag,
            style: TextStyle(
              color: color,
              fontSize: 11,
              fontWeight: FontWeight.bold,
            ),
          ),
        ),
      ],
    );
  }

  Widget forecastRow(String horizon, String value, String state) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
      decoration: BoxDecoration(
        color: const Color(0xFFF7F9FC),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              horizon,
              style: const TextStyle(color: Color(0xFF6B7280)),
            ),
          ),
          Text(value, style: const TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(width: 10),
          SizedBox(
            width: 82,
            child: Text(
              state,
              textAlign: TextAlign.right,
              style: const TextStyle(
                fontSize: 10,
                color: Color(0xFF6B7280),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget emptyCard(String title, String message) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: decoration(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 7),
          Text(
            message,
            style: const TextStyle(
              color: Color(0xFF6B7280),
              height: 1.4,
            ),
          ),
        ],
      ),
    );
  }

  BoxDecoration decoration() {
    return BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(17),
      border: Border.all(color: const Color(0xFFE1E8F0)),
    );
  }

  Widget errorPage() {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(24),
      children: [
        const SizedBox(height: 100),
        const Icon(Icons.cloud_off, size: 64, color: Color(0xFFD73535)),
        const SizedBox(height: 15),
        const Text(
          'Không lấy được dữ liệu',
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 19,
            fontWeight: FontWeight.bold,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          error ?? '',
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: Color(0xFF6B7280),
            fontSize: 12,
          ),
        ),
        const SizedBox(height: 15),
        FilledButton.icon(
          onPressed: loadData,
          icon: const Icon(Icons.refresh),
          label: const Text('Thử lại'),
        ),
      ],
    );
  }
}
