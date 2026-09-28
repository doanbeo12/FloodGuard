import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../services/api_service.dart';
import '../widgets/forecast_card.dart';
import '../widgets/history_chart.dart';

class SiteDetailScreen extends StatefulWidget {
  final int siteId;
  final String siteName;

  const SiteDetailScreen({
    super.key,
    required this.siteId,
    required this.siteName,
  });

  @override
  State<SiteDetailScreen> createState() => _SiteDetailScreenState();
}

class _SiteDetailScreenState extends State<SiteDetailScreen> {
  bool loading = true;
  bool historyLoading = true;
  bool weatherLoading = true;
  String? error;

  Map<String, dynamic>? statusResult;
  Map<String, dynamic>? weatherResult;
  List<Map<String, dynamic>> weatherHours = [];
  List<HistoryPoint> historyPoints = [];

  Timer? _statusTimer;
  Timer? _historyTimer;
  Timer? _weatherTimer;
  bool _statusRequestInFlight = false;
  bool _historyRequestInFlight = false;
  bool _weatherRequestInFlight = false;

  @override
  void initState() {
    super.initState();
    loadData();

    // Trạng thái realtime: cập nhật ngầm mỗi 5 giây.
    _statusTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => _refreshStatus(),
    );

    // Biểu đồ lịch sử cập nhật theo chu kỳ ghi database 10 giây.
    _historyTimer = Timer.periodic(
      const Duration(seconds: 10),
      (_) {
        // Khi Central offline, giữ nguyên biểu đồ lịch sử thay vì tiếp tục
        // polling như thể dữ liệu realtime vẫn đang chạy.
        if (_centralOnline) {
          _refreshHistory();
        }
      },
    );

    // Dự báo thời tiết thay đổi chậm hơn dữ liệu cảm biến.
    _weatherTimer = Timer.periodic(
      const Duration(minutes: 10),
      (_) => _refreshWeather(),
    );
  }

  bool get _centralOnline =>
      statusResult?['connection_status'] == 'ONLINE';

  @override
  void dispose() {
    _statusTimer?.cancel();
    _historyTimer?.cancel();
    _weatherTimer?.cancel();
    super.dispose();
  }

  Future<void> loadData() async {
    if (!mounted) return;

    setState(() {
      loading = true;
      historyLoading = true;
      weatherLoading = weatherHours.isEmpty;
      error = null;
    });

    // Thời tiết tải riêng để không làm chậm dữ liệu cảm biến nếu nguồn dự báo lỗi/chậm.
    unawaited(_refreshWeather());

    try {
      await Future.wait([
        _refreshStatus(keepCurrentOnError: false),
        _refreshHistory(keepCurrentOnError: false),
      ]);

      if (!mounted) return;
      setState(() {
        loading = false;
        historyLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        error = e.toString();
        loading = false;
        historyLoading = false;
        weatherLoading = false;
      });
    }
  }

  Future<void> _refreshStatus({
    bool keepCurrentOnError = true,
  }) async {
    if (_statusRequestInFlight) return;
    _statusRequestInFlight = true;

    try {
      final raw = await ApiService.getSiteStatus(widget.siteId);
      final status = Map<String, dynamic>.from(raw);

      if (!mounted) return;
      setState(() {
        statusResult = status;
        error = null;
      });
    } catch (e) {
      if (!keepCurrentOnError) rethrow;
      // Nếu một lần polling lỗi mạng, giữ dữ liệu hiện tại và thử lại ở vòng sau.
    } finally {
      _statusRequestInFlight = false;
    }
  }

  Future<void> _refreshHistory({
    bool keepCurrentOnError = true,
  }) async {
    if (_historyRequestInFlight) return;
    _historyRequestInFlight = true;

    try {
      final raw = await ApiService.getSiteHistory(
        widget.siteId,
        hours: 6,
      );
      final history = Map<String, dynamic>.from(raw);
      final rawHistory = history['data'];
      final parsedPoints = <HistoryPoint>[];

      if (rawHistory is List) {
        for (final item in rawHistory) {
          if (item is! Map) continue;

          final recordedAt = item['recorded_at']?.toString();
          if (recordedAt == null) continue;

          final time = DateTime.tryParse(recordedAt);
          if (time == null) continue;

          parsedPoints.add(
            HistoryPoint(
              time: time.toLocal(),
              node1: _toDouble(item['node1_water_level']),
              node2: _toDouble(item['node2_water_level']),
              max: _toDouble(item['max_water_level']),
            ),
          );
        }
      }

      parsedPoints.sort((a, b) => a.time.compareTo(b.time));

      if (!mounted) return;
      setState(() {
        historyPoints = parsedPoints;
        historyLoading = false;
      });
    } catch (e) {
      if (!keepCurrentOnError) rethrow;
      // Giữ biểu đồ cũ nếu một lần polling thất bại.
    } finally {
      _historyRequestInFlight = false;
    }
  }

  Future<void> _refreshWeather() async {
    if (_weatherRequestInFlight) return;
    _weatherRequestInFlight = true;

    try {
      final raw = await ApiService.getSiteHourlyWeather(
        widget.siteId,
        hours: 24,
      );
      final result = Map<String, dynamic>.from(raw);
      final rawHourly = result['hourly'];
      final parsed = <Map<String, dynamic>>[];

      if (rawHourly is List) {
        for (final item in rawHourly) {
          if (item is Map) {
            parsed.add(Map<String, dynamic>.from(item));
          }
        }
      }

      if (!mounted) return;
      setState(() {
        weatherResult = result;
        weatherHours = parsed;
        weatherLoading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        weatherLoading = false;
      });
      // Giữ dữ liệu dự báo cũ nếu một lần cập nhật thất bại.
    } finally {
      _weatherRequestInFlight = false;
    }
  }

  double? _toDouble(dynamic value) {
    if (value == null) return null;
    return double.tryParse(value.toString());
  }

  double number(dynamic value) {
    return _toDouble(value) ?? 0;
  }

  int alertLevel(dynamic value) {
    return int.tryParse(value?.toString() ?? '0') ?? 0;
  }

  String alertText(dynamic value) {
    switch (alertLevel(value)) {
      case 0:
        return 'Bình thường';
      case 1:
        return 'Cảnh báo';
      case 2:
        return 'Nguy cơ cao';
      default:
        return 'Cảnh báo ngập';
    }
  }

  Color alertColor(dynamic value) {
    final level = alertLevel(value);

    if (level >= 3) return const Color(0xFFDC2626);
    if (level >= 2) return const Color(0xFFF97316);
    if (level >= 1) return const Color(0xFFEAB308);

    return const Color(0xFF16A34A);
  }

  String trendText(dynamic value) {
    switch (value?.toString()) {
      case 'RISING':
        return 'Đang tăng';
      case 'FALLING':
        return 'Đang giảm';
      case 'STABLE':
        return 'Ổn định';
      default:
        return 'Chưa xác định';
    }
  }

  String floodCauseText(dynamic value) {
    switch (value?.toString()) {
      case 'RAIN':
        return 'Mưa';
      case 'TIDE':
        return 'Triều';
      case 'RAIN_TIDE':
        return 'Mưa + triều';
      case 'UNKNOWN':
        return 'Chưa xác định';
      case 'NONE':
      default:
        return 'Chưa ghi nhận ngập';
    }
  }

  Color floodCauseColor(dynamic value) {
    switch (value?.toString()) {
      case 'RAIN':
        return const Color(0xFF2563EB);
      case 'TIDE':
        return const Color(0xFF7C3AED);
      case 'RAIN_TIDE':
        return const Color(0xFFDC2626);
      case 'UNKNOWN':
        return const Color(0xFFF97316);
      case 'NONE':
      default:
        return const Color(0xFF16A34A);
    }
  }

  Color combinedWarningColor(dynamic severity) {
    switch (severity?.toString()) {
      case 'DANGER':
        return const Color(0xFFDC2626);
      case 'WARNING':
        return const Color(0xFFF97316);
      case 'WATCH':
        return const Color(0xFFEAB308);
      case 'NORMAL':
      default:
        return const Color(0xFF16A34A);
    }
  }

  Widget _buildCombinedWarningCard(
    Map<String, dynamic> warning,
  ) {
    final severity = warning['severity']?.toString() ?? 'NORMAL';
    final color = combinedWarningColor(severity);
    final label = warning['label']?.toString() ?? 'Chưa có phân tích';
    final message = warning['message']?.toString() ?? '';
    final active = warning['active'] == true;

    final tideRaw = warning['tide'];
    final tide = tideRaw is Map
        ? Map<String, dynamic>.from(tideRaw)
        : <String, dynamic>{};
    final tideLevel = _toDouble(tide['level_m']);
    final riskRaw = tide['risk_band'];
    final risk = riskRaw is Map
        ? Map<String, dynamic>.from(riskRaw)
        : <String, dynamic>{};
    final riskLabel = risk['label']?.toString();

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(17),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: color.withValues(alpha: 0.28),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                active
                    ? Icons.warning_amber_rounded
                    : Icons.verified_outlined,
                color: color,
              ),
              const SizedBox(width: 9),
              const Expanded(
                child: Text(
                  'Cảnh báo tổng hợp cảm biến + triều',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 9,
                  vertical: 4,
                ),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.13),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Text(
                  warning['severity_label']?.toString() ?? severity,
                  style: TextStyle(
                    color: color,
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
          if (message.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              message,
              style: const TextStyle(
                color: Color(0xFF4B5563),
                fontSize: 13,
                height: 1.4,
              ),
            ),
          ],
          if (tideLevel != null) ...[
            const SizedBox(height: 10),
            Text(
              'Triều dùng trong phân tích: '
              '${tideLevel.toStringAsFixed(2)} m'
              '${riskLabel == null ? '' : ' • $riskLabel'}',
              style: const TextStyle(
                color: Color(0xFF374151),
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ],
      ),
    );
  }

  DateTime? _weatherDateTime(dynamic value) {
    final parsed = DateTime.tryParse(value?.toString() ?? '');
    return parsed?.toLocal();
  }

  String _twoDigits(int value) => value.toString().padLeft(2, '0');

  String _weatherHour(dynamic value) {
    final time = _weatherDateTime(value);
    if (time == null) return '--:--';
    return '${_twoDigits(time.hour)}:${_twoDigits(time.minute)}';
  }

  String _weatherDate(dynamic value) {
    final time = _weatherDateTime(value);
    if (time == null) return '--/--';
    return '${_twoDigits(time.day)}/${_twoDigits(time.month)}';
  }

  IconData _weatherIcon(dynamic condition) {
    switch (condition?.toString()) {
      case 'CLEAR':
        return Icons.wb_sunny_outlined;
      case 'PARTLY_CLOUDY':
      case 'CLOUDY':
        return Icons.cloud_outlined;
      case 'DRIZZLE':
      case 'RAIN':
      case 'HEAVY_RAIN':
        return Icons.water_drop_outlined;
      case 'THUNDERSTORM':
        return Icons.flash_on;
      case 'FOG':
        return Icons.blur_on;
      default:
        return Icons.cloud_queue;
    }
  }

  Color _weatherColor(dynamic condition) {
    switch (condition?.toString()) {
      case 'CLEAR':
        return const Color(0xFFF59E0B);
      case 'THUNDERSTORM':
        return const Color(0xFF7C3AED);
      case 'HEAVY_RAIN':
        return const Color(0xFF1D4ED8);
      case 'DRIZZLE':
      case 'RAIN':
        return const Color(0xFF2563EB);
      default:
        return const Color(0xFF64748B);
    }
  }

  String _weatherNumber(
    dynamic value, {
    int decimals = 0,
    String suffix = '',
  }) {
    final n = _toDouble(value);
    if (n == null) return '--';
    return '${n.toStringAsFixed(decimals)}$suffix';
  }

  void _showWeatherDetail(Map<String, dynamic> item) {
    final condition = item['condition'];
    final color = _weatherColor(condition);

    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      _weatherIcon(condition),
                      color: color,
                      size: 34,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            "${_weatherHour(item['time'])} - ${_weatherDate(item['time'])}",
                            style: const TextStyle(
                              fontSize: 20,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          Text(
                            item['condition_label']?.toString() ??
                                'Chưa xác định',
                            style: TextStyle(
                              color: color,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                _weatherDetailRow(
                  'Nhiệt độ',
                  _weatherNumber(
                    item['temperature_c'],
                    decimals: 1,
                    suffix: ' °C',
                  ),
                ),
                _weatherDetailRow(
                  'Khả năng mưa',
                  _weatherNumber(
                    item['rain_probability'],
                    suffix: '%',
                  ),
                ),
                _weatherDetailRow(
                  'Lượng mưa dự báo',
                  _weatherNumber(
                    item['rain_mm'],
                    decimals: 1,
                    suffix: ' mm',
                  ),
                ),
                _weatherDetailRow(
                  'Độ ẩm',
                  _weatherNumber(
                    item['humidity_percent'],
                    suffix: '%',
                  ),
                ),
                _weatherDetailRow(
                  'Tốc độ gió',
                  _weatherNumber(
                    item['wind_kmh'],
                    decimals: 1,
                    suffix: ' km/h',
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _weatherDetailRow(String title, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: [
          Expanded(
            child: Text(
              title,
              style: const TextStyle(
                color: Color(0xFF6B7280),
              ),
            ),
          ),
          Text(
            value,
            style: const TextStyle(
              fontWeight: FontWeight.bold,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildHourlyWeather() {
    if (weatherLoading && weatherHours.isEmpty) {
      return const SizedBox(
        height: 145,
        child: Center(
          child: CircularProgressIndicator(),
        ),
      );
    }

    final available = weatherResult?['available'] == true;

    if (!available || weatherHours.isEmpty) {
      final message = weatherResult?['message']?.toString() ??
          'Chưa lấy được dự báo thời tiết theo giờ.';

      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: const Color(0xFFE5E7EB),
          ),
        ),
        child: Row(
          children: [
            const Icon(
              Icons.cloud_off_outlined,
              color: Color(0xFF6B7280),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                message,
                style: const TextStyle(
                  color: Color(0xFF6B7280),
                ),
              ),
            ),
          ],
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.symmetric(vertical: 14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: const Color(0xFFE5E7EB),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 14),
            child: Text(
              'Chạm vào một khung giờ để xem chi tiết.',
              style: TextStyle(
                color: Color(0xFF6B7280),
                fontSize: 12,
              ),
            ),
          ),
          const SizedBox(height: 12),
          SizedBox(
            height: 142,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              itemCount: weatherHours.length,
              separatorBuilder: (_, __) => const SizedBox(width: 9),
              itemBuilder: (context, index) {
                final item = weatherHours[index];
                final condition = item['condition'];
                final color = _weatherColor(condition);

                return InkWell(
                  borderRadius: BorderRadius.circular(14),
                  onTap: () => _showWeatherDetail(item),
                  child: Container(
                    width: 88,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 10,
                    ),
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: 0.07),
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(
                        color: color.withValues(alpha: 0.18),
                      ),
                    ),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Column(
                          children: [
                            Text(
                              _weatherHour(item['time']),
                              style: const TextStyle(
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                            Text(
                              _weatherDate(item['time']),
                              style: const TextStyle(
                                color: Color(0xFF6B7280),
                                fontSize: 10,
                              ),
                            ),
                          ],
                        ),
                        Icon(
                          _weatherIcon(condition),
                          color: color,
                          size: 27,
                        ),
                        Text(
                          _weatherNumber(
                            item['temperature_c'],
                            suffix: '°',
                          ),
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(
                              Icons.water_drop_outlined,
                              size: 12,
                              color: Color(0xFF2563EB),
                            ),
                            const SizedBox(width: 2),
                            Text(
                              _weatherNumber(
                                item['rain_probability'],
                                suffix: '%',
                              ),
                              style: const TextStyle(
                                fontSize: 11,
                                color: Color(0xFF2563EB),
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
          const SizedBox(height: 10),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Text(
              "Nguồn: ${weatherResult?['provider'] ?? 'Open-Meteo'} • Dự báo tham khảo",
              style: const TextStyle(
                color: Color(0xFF9CA3AF),
                fontSize: 11,
              ),
            ),
          ),
        ],
      ),
    );
  }

  // Ước lượng tốc độ thay đổi bằng hồi quy tuyến tính
  // trên các điểm max_water_level trong 60 phút gần nhất.
  // Nếu thiếu dữ liệu, dùng rate_cm_min từ backend.
  double _forecastRate(double backendRate) {
    final valid = historyPoints
        .where((p) => p.max != null)
        .toList();

    if (valid.length < 3) {
      return backendRate;
    }

    final endTime = valid.last.time;
    final windowStart = endTime.subtract(
      const Duration(minutes: 60),
    );

    final recent = valid
        .where((p) => !p.time.isBefore(windowStart))
        .toList();

    if (recent.length < 3) {
      return backendRate;
    }

    final xValues = recent.map(
      (p) => p.time
          .difference(recent.first.time)
          .inSeconds
          .toDouble() / 60.0,
    );

    final yValues = recent
        .map((p) => p.max!)
        .toList();

    final xMean =
        xValues.reduce((a, b) => a + b) / xValues.length;

    final yMean =
        yValues.reduce((a, b) => a + b) / yValues.length;

    double numerator = 0;
    double denominator = 0;

    for (int i = 0; i < xValues.length; i++) {
      final dx = xValues.elementAt(i) - xMean;
      final dy = yValues[i] - yMean;
      numerator += dx * dy;
      denominator += dx * dx;
    }

    if (denominator == 0) {
      return backendRate;
    }

    final slope = numerator / denominator;

    // Không dùng slope cực đoan do một điểm lỗi để dự báo demo.
    if (!slope.isFinite || slope.abs() > 5) {
      return backendRate;
    }

    return slope;
  }

  int _forecastAlertLevel(double level) {
    if (level >= 15) return 3;
    if (level >= 10) return 2;
    if (level >= 7) return 1;
    return 0;
  }

  String _forecastStatus(double level) {
    if (level >= 15) return 'Ngập';
    if (level >= 10) return 'Nguy cơ cao';
    if (level >= 7) return 'Cảnh báo';
    if (level >= 3) return 'Theo dõi';
    return 'Bình thường';
  }

  String _buildForecastSummary(
    double current,
    double rate,
  ) {
    if (rate.abs() < 0.01) {
      return 'Mực nước hiện tại khoảng '
          '${current.toStringAsFixed(1)} cm và xu hướng gần như ổn định. '
          'Trong 1 giờ tới chưa dự kiến có thay đổi đáng kể nếu xu hướng này tiếp tục.';
    }

    if (rate < 0) {
      return 'Mực nước đang có xu hướng giảm khoảng '
          '${rate.abs().toStringAsFixed(3)} cm/phút. '
          'Trong 1 giờ tới mực nước dự kiến tiếp tục giảm nếu điều kiện hiện tại không thay đổi.';
    }

    final candidates = <Map<String, dynamic>>[];

    for (final threshold in [3.0, 7.0, 10.0, 15.0]) {
      if (threshold <= current) continue;

      final minutes =
          (threshold - current) / rate;

      if (minutes >= 0 && minutes <= 60) {
        candidates.add({
          'threshold': threshold,
          'minutes': minutes,
        });
      }
    }

    if (candidates.isNotEmpty) {
      final first = candidates.first;

      return 'Mực nước đang tăng khoảng '
          '${rate.toStringAsFixed(3)} cm/phút. '
          'Theo xu hướng hiện tại, có thể đạt '
          '${(first['threshold'] as double).toStringAsFixed(0)} cm '
          'sau khoảng '
          '${(first['minutes'] as double).round()} phút.';
    }

    final levelIn60 = math.max(
      0,
      current + rate * 60,
    );

    if (levelIn60 >= 15) {
      return 'Mực nước có xu hướng tăng. '
          'Nếu xu hướng tiếp tục trong 1 giờ, '
          'mực nước có thể tiến đến khoảng '
          '${levelIn60.toStringAsFixed(1)} cm, '
          'vượt ngưỡng 15 cm.';
    }

    return 'Mực nước đang tăng khoảng '
        '${rate.toStringAsFixed(3)} cm/phút. '
        'Trong 1 giờ tới có thể đạt khoảng '
        '${levelIn60.toStringAsFixed(1)} cm nếu xu hướng tiếp tục.';
  }

  List<ForecastPoint> _buildForecastPoints(
  double current,
  double rate,
) {
  const minutesList = [15, 30, 45, 60];

  return minutesList.map((minutes) {
    final double level = math.max(
      0.0,
      current + rate * minutes,
    ).toDouble();

    final alert = _forecastAlertLevel(level);

    return ForecastPoint(
      minutes: minutes,
      waterLevel: level,
      alertLevel: alert,
      status: _forecastStatus(level),
    );
  }).toList();
}

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FB),
      appBar: AppBar(
        title: Text(widget.siteName),
        backgroundColor: Colors.white,
      ),
      body: loading
          ? const Center(
              child: CircularProgressIndicator(),
            )
          : error != null
              ? _buildError()
              : RefreshIndicator(
                  onRefresh: loadData,
                  child: _buildContent(),
                ),
    );
  }

  Widget _buildContent() {
    final data = Map<String, dynamic>.from(
      statusResult?['data'] ?? {},
    );

    final connectionStatus =
        statusResult?['connection_status']?.toString() ?? 'UNKNOWN';
    final centralOnline = connectionStatus == 'ONLINE';

    final color = centralOnline
        ? alertColor(data['alert_level'])
        : const Color(0xFF6B7280);

    final maxLevel = number(data['max_water_level']);
    final node1 = number(data['node1_water_level']);
    final node2 = number(data['node2_water_level']);
    final backendRate = number(data['rate_cm_min']);

    final forecastRate = _forecastRate(backendRate);

    final raining = data['raining'] == true;
    final earlyWarning = data['early_warning'] == true;

    final combinedRaw = statusResult?['combined_warning'];
    final combinedWarning = combinedRaw is Map
        ? Map<String, dynamic>.from(combinedRaw)
        : <String, dynamic>{};
    final warningTideRaw = combinedWarning['tide'];
    final warningTide = warningTideRaw is Map
        ? Map<String, dynamic>.from(warningTideRaw)
        : <String, dynamic>{};
    final tideLevelForWarning = _toDouble(warningTide['level_m']);
    final tideRiskRaw = warningTide['risk_band'];
    final tideRisk = tideRiskRaw is Map
        ? Map<String, dynamic>.from(tideRiskRaw)
        : <String, dynamic>{};
    final tideRiskCode =
        tideRisk['code']?.toString() ?? 'UNKNOWN';

    // flood_cause được Backend trả ở cấp ngoài cùng của /status.
    // Có fallback sang data để app vẫn tương thích nếu backend thay đổi vị trí field.
    final floodCauseCode =
        statusResult?['flood_cause']?.toString() ??
        data['flood_cause']?.toString() ??
        'NONE';

    final floodCauseLabel =
        statusResult?['flood_cause_label']?.toString() ??
        data['flood_cause_label']?.toString() ??
        floodCauseText(floodCauseCode);

    final hasHistoryForForecast =
        historyPoints.where((p) => p.max != null).length >= 3;

    final forecastPoints = centralOnline && hasHistoryForForecast
        ? _buildForecastPoints(maxLevel, forecastRate)
        : <ForecastPoint>[];

    final methodText = !centralOnline
        ? 'Central đang offline nên dự báo realtime tạm dừng.'
        : hasHistoryForForecast
            ? 'Dựa trên xu hướng dữ liệu mực nước trong 60 phút gần nhất.'
            : 'Chưa đủ dữ liệu lịch sử; cần thêm dữ liệu để tạo dự báo.';

    final forecastSummary = !centralOnline
        ? 'Không sử dụng lần đo cuối để tiếp tục dự báo. '
            'Dữ liệu realtime sẽ tự cập nhật khi Central online trở lại.'
        : hasHistoryForForecast
            ? _buildForecastSummary(maxLevel, forecastRate)
            : 'Hiện chưa có đủ dữ liệu lịch sử để dự báo đáng tin cậy. '
                'Hãy để hệ thống tiếp tục ghi nhận dữ liệu của Đường số 1.';

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(16),
      children: [
        Container(
          padding: const EdgeInsets.all(22),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.10),
            borderRadius: BorderRadius.circular(22),
            border: Border.all(
              color: color.withValues(alpha: 0.25),
            ),
          ),
          child: Column(
            children: [
              Text(
                centralOnline
                    ? alertText(data['alert_level'])
                    : 'Central đang offline',
                style: TextStyle(
                  color: color,
                  fontSize: 21,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 7),
              Text(
                centralOnline
                    ? '${maxLevel.toStringAsFixed(1)} cm'
                    : '--',
                style: const TextStyle(
                  fontSize: 38,
                  fontWeight: FontWeight.bold,
                ),
              ),
              Text(
                centralOnline
                    ? 'Mực nước lớn nhất hiện tại'
                    : 'Không có dữ liệu realtime',
                style: const TextStyle(
                  color: Color(0xFF6B7280),
                  fontSize: 13,
                ),
              ),
            ],
          ),
        ),

        const SizedBox(height: 14),

        _buildCombinedWarningCard(combinedWarning),

        const SizedBox(height: 18),

        const Text(
          'Tình trạng hiện tại',
          style: TextStyle(
            fontSize: 19,
            fontWeight: FontWeight.bold,
          ),
        ),

        const SizedBox(height: 12),

        Row(
          children: [
            Expanded(
              child: _metricCard(
                title: 'Node 1',
                value: centralOnline
                    ? '${node1.toStringAsFixed(1)} cm'
                    : '--',
                icon: Icons.sensors,
                color: const Color(0xFF2563EB),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _metricCard(
                title: 'Node 2',
                value: centralOnline
                    ? '${node2.toStringAsFixed(1)} cm'
                    : '--',
                icon: Icons.sensors,
                color: const Color(0xFF7C3AED),
              ),
            ),
          ],
        ),

        const SizedBox(height: 12),

        Row(
          children: [
            Expanded(
              child: _metricCard(
                title: 'Mưa',
                value: !centralOnline
                    ? 'Không xác định'
                    : raining
                        ? 'Đang có mưa'
                        : 'Không có mưa',
                icon: !centralOnline
                    ? Icons.cloud_off_outlined
                    : raining
                        ? Icons.water_drop
                        : Icons.wb_sunny_outlined,
                color: !centralOnline
                    ? const Color(0xFF6B7280)
                    : raining
                        ? const Color(0xFF2563EB)
                        : const Color(0xFFF59E0B),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _metricCard(
                title: 'Xu hướng',
                value: centralOnline
                    ? trendText(data['trend'])
                    : 'Không xác định',
                icon: centralOnline
                    ? Icons.trending_up
                    : Icons.pause_circle_outline,
                color: !centralOnline
                    ? const Color(0xFF6B7280)
                    : forecastRate > 0
                        ? const Color(0xFFF97316)
                        : const Color(0xFF16A34A),
              ),
            ),
          ],
        ),

        const SizedBox(height: 12),

        _infoRow(
          icon: Icons.speed,
          title: 'Tốc độ thay đổi',
          value: centralOnline
              ? '${backendRate.toStringAsFixed(3)} cm/phút'
              : '--',
        ),

        _infoRow(
          icon: Icons.warning_amber_rounded,
          title: 'Cảnh báo cảm biến',
          value: !centralOnline
              ? 'Tạm dừng khi Central offline'
              : earlyWarning
                  ? 'Đang có cảnh báo sớm'
                  : 'Chưa có cảnh báo sớm',
          valueColor: !centralOnline
              ? Colors.grey
              : earlyWarning
                  ? Colors.red
                  : Colors.green,
        ),

        _infoRow(
          icon: Icons.water_drop_outlined,
          title: 'Nguyên nhân ngập',
          value: centralOnline
              ? floodCauseLabel
              : 'Không xác định khi Central offline',
          valueColor: centralOnline
              ? floodCauseColor(floodCauseCode)
              : Colors.grey,
        ),

        _infoRow(
          icon: Icons.waves_outlined,
          title: 'Triều trong phân tích',
          value: tideLevelForWarning == null
              ? 'Chưa có dữ liệu'
              : '${tideLevelForWarning.toStringAsFixed(2)} m • '
                  '$tideRiskCode',
          valueColor: warningTide['contributing'] == true
              ? const Color(0xFF7C3AED)
              : Colors.grey,
        ),

        _infoRow(
          icon: Icons.cloud,
          title: 'Kết nối Central',
          value: connectionStatus,
          valueColor:
              centralOnline ? Colors.green : Colors.grey,
        ),

        const SizedBox(height: 22),

        Row(
          children: [
            const Expanded(
              child: Text(
                'Dự báo thời tiết 24 giờ',
                style: TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: 9,
                vertical: 4,
              ),
              decoration: BoxDecoration(
                color: const Color(0xFFEFF6FF),
                borderRadius: BorderRadius.circular(9),
              ),
              child: const Text(
                'Theo giờ',
                style: TextStyle(
                  color: Color(0xFF2563EB),
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ],
        ),

        const SizedBox(height: 12),

        _buildHourlyWeather(),

        const SizedBox(height: 22),

        const Text(
          'Dự báo 1 giờ tới',
          style: TextStyle(
            fontSize: 19,
            fontWeight: FontWeight.bold,
          ),
        ),

        const SizedBox(height: 12),

        centralOnline
            ? ForecastCard(
                points: forecastPoints,
                rateCmMin: forecastRate,
                methodText: methodText,
                summary: forecastSummary,
              )
            : Container(
                width: double.infinity,
                padding: const EdgeInsets.all(18),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(17),
                  border: Border.all(
                    color: const Color(0xFFE5E7EB),
                  ),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      Icons.pause_circle_outline,
                      color: Color(0xFF6B7280),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        forecastSummary,
                        style: const TextStyle(
                          color: Color(0xFF6B7280),
                          fontSize: 13,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ],
                ),
              ),

        const SizedBox(height: 22),

        Row(
          children: [
            const Expanded(
              child: Text(
                'Lịch sử mực nước',
                style: TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: 10,
                vertical: 5,
              ),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Text(
                '6 giờ qua',
                style: TextStyle(
                  fontSize: 12,
                  color: Color(0xFF6B7280),
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),

        const SizedBox(height: 12),

        historyLoading
            ? const SizedBox(
                height: 280,
                child: Center(
                  child: CircularProgressIndicator(),
                ),
              )
            : HistoryChart(
                points: historyPoints,
              ),

        const SizedBox(height: 12),

        const Text(
          'Biểu đồ gồm dữ liệu Node 1, Node 2 và mực nước lớn nhất được backend lưu lại trong 6 giờ gần nhất.',
          style: TextStyle(
            color: Color(0xFF6B7280),
            fontSize: 12,
          ),
        ),

        const SizedBox(height: 24),
      ],
    );
  }

  Widget _metricCard({
    required String title,
    required String value,
    required IconData icon,
    required Color color,
  }) {
    return Container(
      padding: const EdgeInsets.all(15),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(17),
        border: Border.all(
          color: const Color(0xFFE5E7EB),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            icon,
            color: color,
            size: 26,
          ),
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
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
        ],
      ),
    );
  }

  Widget _infoRow({
    required IconData icon,
    required String title,
    required String value,
    Color? valueColor,
  }) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(15),
        child: Row(
          children: [
            Icon(
              icon,
              color: const Color(0xFF1769AA),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                title,
                style: const TextStyle(
                  color: Color(0xFF6B7280),
                ),
              ),
            ),
            Text(
              value,
              style: TextStyle(
                color:
                    valueColor ?? const Color(0xFF111827),
                fontWeight: FontWeight.bold,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildError() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(25),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.cloud_off,
              color: Colors.red,
              size: 60,
            ),
            const SizedBox(height: 15),
            const Text(
              'Không lấy được dữ liệu',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 14),
            ElevatedButton.icon(
              onPressed: loadData,
              icon: const Icon(Icons.refresh),
              label: const Text('Thử lại'),
            ),
          ],
        ),
      ),
    );
  }
}
