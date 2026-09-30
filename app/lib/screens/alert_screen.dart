import 'package:flutter/material.dart';

class AlertScreen extends StatelessWidget {
  const AlertScreen({
    super.key,
    required this.sites,
    required this.onRefresh,
  });

  final List<dynamic> sites;
  final Future<void> Function() onRefresh;

  Map<String, dynamic> _site(dynamic value) =>
      Map<String, dynamic>.from(value as Map);

  Map<String, dynamic> _warning(Map<String, dynamic> site) {
    final raw = site['combined_warning'];
    return raw is Map
        ? Map<String, dynamic>.from(raw)
        : <String, dynamic>{};
  }

  bool _deployed(Map<String, dynamic> site) =>
      site['deployment_status'] == 'DEPLOYED';

  bool _active(Map<String, dynamic> site) =>
      _deployed(site) && _warning(site)['active'] == true;

  Color _color(String severity) {
    switch (severity) {
      case 'DANGER':
        return const Color(0xFFDC2626);
      case 'WARNING':
        return const Color(0xFFF97316);
      case 'WATCH':
        return const Color(0xFFEAB308);
      case 'NORMAL':
        return const Color(0xFF16A34A);
      default:
        return const Color(0xFF6B7280);
    }
  }

  IconData _icon(String severity) {
    switch (severity) {
      case 'DANGER':
        return Icons.dangerous_outlined;
      case 'WARNING':
        return Icons.warning_amber_rounded;
      case 'WATCH':
        return Icons.visibility_outlined;
      case 'NORMAL':
        return Icons.check_circle_outline;
      default:
        return Icons.info_outline;
    }
  }

  String _tideText(Map<String, dynamic> warning) {
    final raw = warning['tide'];
    if (raw is! Map) return 'Không có dữ liệu triều';
    final tide = Map<String, dynamic>.from(raw);
    final level = double.tryParse(tide['level_m']?.toString() ?? '');
    if (level == null) return 'Không có dữ liệu triều';

    final riskRaw = tide['risk_band'];
    final risk = riskRaw is Map
        ? Map<String, dynamic>.from(riskRaw)
        : <String, dynamic>{};
    final code = risk['code']?.toString();

    if (code == null || code == 'UNKNOWN') {
      return 'Triều ${level.toStringAsFixed(2)} m';
    }
    return 'Triều ${level.toStringAsFixed(2)} m • $code';
  }

  @override
  Widget build(BuildContext context) {
    final deployed = sites.map(_site).where(_deployed).toList();
    final active = deployed.where(_active).toList();

    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 30),
        children: [
          _header(active.length),
          const SizedBox(height: 18),
          if (active.isEmpty)
            _noAlert()
          else ...[
            const Text(
              'Cảnh báo đang hoạt động',
              style: TextStyle(
                fontSize: 19,
                fontWeight: FontWeight.bold,
                color: Color(0xFF111827),
              ),
            ),
            const SizedBox(height: 11),
            ...active.map(_alertCard),
          ],
          const SizedBox(height: 24),
          const Text(
            'Trạng thái các khu vực',
            style: TextStyle(
              fontSize: 19,
              fontWeight: FontWeight.bold,
              color: Color(0xFF111827),
            ),
          ),
          const SizedBox(height: 11),
          if (deployed.isEmpty)
            _empty('Chưa có khu vực nào được triển khai.')
          else
            ...deployed.map(_siteCard),
        ],
      ),
    );
  }

  Widget _header(int count) {
    return Row(
      children: [
        Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            color: count > 0
                ? const Color(0xFFFFF3E0)
                : const Color(0xFFE8F5E9),
            borderRadius: BorderRadius.circular(15),
          ),
          child: Icon(
            count > 0
                ? Icons.notifications_active_outlined
                : Icons.notifications_none_rounded,
            color: count > 0
                ? const Color(0xFFF97316)
                : const Color(0xFF16A34A),
          ),
        ),
        const SizedBox(width: 13),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Cảnh báo',
                style: TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF111827),
                ),
              ),
              const SizedBox(height: 2),
              Text(
                count > 0
                    ? '$count khu vực cần chú ý'
                    : 'Chưa có cảnh báo đang hoạt động',
                style: const TextStyle(
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

  Widget _noAlert() {
    return Container(
      padding: const EdgeInsets.all(19),
      decoration: BoxDecoration(
        color: const Color(0xFFEAF7EE),
        borderRadius: BorderRadius.circular(19),
        border: Border.all(color: const Color(0xFFBBE2C4)),
      ),
      child: const Row(
        children: [
          Icon(
            Icons.verified_outlined,
            color: Color(0xFF16A34A),
            size: 32,
          ),
          SizedBox(width: 13),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Hệ thống chưa ghi nhận nguy cơ đáng kể',
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    color: Color(0xFF166534),
                  ),
                ),
                SizedBox(height: 4),
                Text(
                  'Trang này tự cập nhật theo kết quả phân tích tổng hợp từ cảm biến và dữ liệu triều.',
                  style: TextStyle(
                    fontSize: 12,
                    color: Color(0xFF4B5563),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _alertCard(Map<String, dynamic> site) {
    final warning = _warning(site);
    final severity = warning['severity']?.toString() ?? 'UNKNOWN';
    final color = _color(severity);

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: color.withValues(alpha: 0.30)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.05),
            blurRadius: 9,
            offset: const Offset(0, 3),
          ),
        ],
      ),
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(_icon(severity), color: color),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  site['site_name']?.toString() ?? 'Không xác định',
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  warning['label']?.toString() ?? 'Cảnh báo',
                  style: TextStyle(
                    color: color,
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: 8,
              vertical: 4,
            ),
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(9),
            ),
            child: Text(
              warning['severity_label']?.toString() ?? severity,
              style: TextStyle(
                color: color,
                fontSize: 10,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _siteCard(Map<String, dynamic> site) {
    final warning = _warning(site);
    final online = site['connection_status'] == 'ONLINE';
    final active = warning['active'] == true;
    final severity = warning['severity']?.toString() ?? 'NORMAL';
    final color = !online
        ? const Color(0xFF6B7280)
        : active
            ? _color(severity)
            : const Color(0xFF16A34A);

    final latestRaw = site['latest'];
    final latest = latestRaw is Map
        ? Map<String, dynamic>.from(latestRaw)
        : <String, dynamic>{};
    final water = double.tryParse(
      latest['max_water_level']?.toString() ?? '',
    );

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE5E7EB)),
      ),
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.11),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(
              online ? Icons.location_on_outlined : Icons.cloud_off,
              color: color,
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  site['site_name']?.toString() ?? 'Không xác định',
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 3),
                Text(
                  !online
                      ? 'Central offline'
                      : active
                          ? warning['label']?.toString() ?? 'Có cảnh báo'
                          : 'Đang theo dõi bình thường',
                  style: TextStyle(color: color, fontSize: 12),
                ),
              ],
            ),
          ),
          Text(
            online && water != null
                ? '${water.toStringAsFixed(1)} cm'
                : '--',
            style: const TextStyle(fontWeight: FontWeight.bold),
          ),
        ],
      ),
    );
  }


  Widget _empty(String text) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Text(
        text,
        style: const TextStyle(color: Color(0xFF6B7280)),
      ),
    );
  }
}
