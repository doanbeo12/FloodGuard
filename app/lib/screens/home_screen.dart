import 'dart:async';

import 'package:flutter/material.dart';

import '../services/api_service.dart';
import 'site_detail_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  bool loading = true;
  String? error;
  List<dynamic> sites = [];
  Timer? _refreshTimer;
  bool _isRefreshing = false;

  @override
  void initState() {
    super.initState();
    loadSites();
    _refreshTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => loadSites(),
    );
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }

  Future<void> loadSites() async {
    if (_isRefreshing) return;
    _isRefreshing = true;

    try {
      final data = await ApiService.getSites();

      if (!mounted) return;

      setState(() {
        sites = data;
        loading = false;
        error = null;
      });
    } catch (e) {
      if (!mounted) return;

      setState(() {
        loading = false;
        error = e.toString();
      });
    } finally {
      _isRefreshing = false;
    }
  }

  int get deployedCount {
    return sites
        .where(
          (site) =>
              site['deployment_status'] == 'DEPLOYED',
        )
        .length;
  }

  int get onlineCount {
    return sites
        .where(
          (site) =>
              site['deployment_status'] == 'DEPLOYED' &&
              site['connection_status'] == 'ONLINE',
        )
        .length;
  }

  bool get hasAlert {
    for (final site in sites) {
      final combined = site['combined_warning'];
      if (combined is Map && combined['active'] == true) {
        return true;
      }

      final latest = site['latest'];
      if (latest == null) continue;

      final level =
          int.tryParse(
            latest['alert_level']?.toString() ?? '0',
          ) ??
          0;

      if (level >= 1) return true;
    }

    return false;
  }

  Color siteColor(Map<String, dynamic> site) {
    if (site['deployment_status'] != 'DEPLOYED') {
      return const Color(0xFF9CA3AF);
    }

    if (site['connection_status'] == 'OFFLINE') {
      return const Color(0xFF6B7280);
    }

    final combined = site['combined_warning'];
    if (combined is Map) {
      final combinedLevel =
          int.tryParse(combined['level']?.toString() ?? '0') ?? 0;
      if (combinedLevel >= 3) return const Color(0xFFDC2626);
      if (combinedLevel >= 2) return const Color(0xFFF97316);
      if (combinedLevel >= 1) return const Color(0xFFEAB308);
    }

    final latest = site['latest'];

    if (latest == null) {
      return const Color(0xFF6B7280);
    }

    final level =
        int.tryParse(
          latest['alert_level']?.toString() ?? '0',
        ) ??
        0;

    if (level >= 3) return const Color(0xFFDC2626);
    if (level >= 2) return const Color(0xFFF97316);
    if (level >= 1) return const Color(0xFFEAB308);

    return const Color(0xFF16A34A);
  }

  String siteStatus(Map<String, dynamic> site) {
    if (site['deployment_status'] != 'DEPLOYED') {
      return 'Chưa triển khai cảm biến';
    }

    if (site['connection_status'] == 'OFFLINE') {
      return 'Thiết bị đang offline';
    }

    final combined = site['combined_warning'];
    if (combined is Map && combined['active'] == true) {
      final label = combined['label']?.toString();
      if (label != null && label.isNotEmpty) return label;
    }

    final latest = site['latest'];

    if (latest == null) {
      return 'Chưa có dữ liệu';
    }

    final level =
        int.tryParse(
          latest['alert_level']?.toString() ?? '0',
        ) ??
        0;

    if (level >= 3) return 'Cảnh báo ngập';
    if (level >= 2) return 'Nguy cơ cao';
    if (level >= 1) return 'Đang cảnh báo';

    return 'Đang theo dõi';
  }

  String waterLevel(Map<String, dynamic> site) {
    final latest = site['latest'];
    if (latest == null) return '--';

    final value = latest['max_water_level'];
    if (value == null) return '--';

    final number = double.tryParse(value.toString());
    if (number == null) return '--';

    return number.toStringAsFixed(1);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FB),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: RefreshIndicator(
                onRefresh: loadSites,
                child: loading
                    ? const Center(
                        child: CircularProgressIndicator(),
                      )
                    : error != null
                        ? _buildError()
                        : _buildHome(),
              ),
            ),
            _buildBottomNavigation(),
          ],
        ),
      ),
    );
  }

  Widget _buildHome() {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 30),
      children: [
        _buildHeader(),
        const SizedBox(height: 22),
        _buildSystemStatus(),
        const SizedBox(height: 24),
        _buildSectionTitle(
          'Khu vực giám sát',
          '$deployedCount khu vực đang triển khai',
        ),
        const SizedBox(height: 12),
        ...sites.map((siteData) {
          final site =
              Map<String, dynamic>.from(siteData);
          return _buildSiteCard(site);
        }),
        const SizedBox(height: 24),
        _buildQuickFeatures(),
        const SizedBox(height: 15),
        const Center(
          child: Text(
            'FloodGuard • Giám sát ngập đô thị',
            style: TextStyle(
              color: Color(0xFF9CA3AF),
              fontSize: 12,
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildHeader() {
    return Row(
      children: [
        Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            color: const Color(0xFF1769AA),
            borderRadius: BorderRadius.circular(15),
          ),
          child: const Icon(
            Icons.water_drop,
            color: Colors.white,
            size: 27,
          ),
        ),
        const SizedBox(width: 13),
        const Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'FloodGuard',
                style: TextStyle(
                  fontSize: 21,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF111827),
                ),
              ),
              SizedBox(height: 2),
              Text(
                'Giám sát ngập đô thị',
                style: TextStyle(
                  fontSize: 13,
                  color: Color(0xFF6B7280),
                ),
              ),
            ],
          ),
        ),
        Container(
          width: 43,
          height: 43,
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(14),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.06),
                blurRadius: 8,
                offset: const Offset(0, 3),
              ),
            ],
          ),
          child: Stack(
            children: [
              const Center(
                child: Icon(
                  Icons.notifications_none,
                  color: Color(0xFF374151),
                  size: 25,
                ),
              ),
              if (hasAlert)
                Positioned(
                  right: 9,
                  top: 8,
                  child: Container(
                    width: 8,
                    height: 8,
                    decoration: const BoxDecoration(
                      color: Colors.red,
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildSystemStatus() {
    final systemOnline = onlineCount > 0;

    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: systemOnline
              ? const [
                  Color(0xFF1769AA),
                  Color(0xFF2687C5),
                ]
              : const [
                  Color(0xFF52616B),
                  Color(0xFF6B7B86),
                ],
        ),
        borderRadius: BorderRadius.circular(22),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.12),
            blurRadius: 14,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: Row(
        children: [
          Container(
            width: 50,
            height: 50,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.18),
              shape: BoxShape.circle,
            ),
            child: Icon(
              systemOnline
                  ? Icons.cloud_done
                  : Icons.cloud_off,
              color: Colors.white,
              size: 27,
            ),
          ),
          const SizedBox(width: 15),
          Expanded(
            child: Column(
              crossAxisAlignment:
                  CrossAxisAlignment.start,
              children: [
                Text(
                  systemOnline
                      ? 'Hệ thống đang hoạt động'
                      : 'Hệ thống đang chờ dữ liệu',
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 17,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  '$onlineCount thiết bị online • '
                  '$deployedCount khu vực triển khai',
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.85),
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSectionTitle(
    String title,
    String subtitle,
  ) {
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment:
                CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF111827),
                ),
              ),
              const SizedBox(height: 3),
              Text(
                subtitle,
                style: const TextStyle(
                  fontSize: 12,
                  color: Color(0xFF6B7280),
                ),
              ),
            ],
          ),
        ),
        TextButton(
          onPressed: () {},
          child: const Text('Xem tất cả'),
        ),
      ],
    );
  }

  Widget _buildSiteCard(
    Map<String, dynamic> site,
  ) {
    final color = siteColor(site);
    final status = siteStatus(site);
    final level = waterLevel(site);

    final deployed =
        site['deployment_status'] == 'DEPLOYED';

    return Container(
      margin: const EdgeInsets.only(bottom: 13),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(19),
        border: Border.all(
          color: const Color(0xFFE5E7EB),
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.055),
            blurRadius: 9,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(19),
        onTap: () async {
          if (!deployed) {
            ScaffoldMessenger.of(context)
                .showSnackBar(
              const SnackBar(
                content: Text(
                  'Địa điểm này chưa triển khai cảm biến',
                ),
              ),
            );
            return;
          }

          await Navigator.push(
            context,
            MaterialPageRoute(
              builder: (context) => SiteDetailScreen(
                siteId: site['site_id'],
                siteName: site['site_name'],
              ),
            ),
          );

          // Khi quay lại Home, lấy trạng thái mới ngay thay vì chờ timer.
          if (mounted) {
            loadSites();
          }
        },
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Container(
                width: 55,
                height: 55,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Icon(
                  Icons.location_on,
                  color: color,
                  size: 29,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment:
                      CrossAxisAlignment.start,
                  children: [
                    Text(
                      site['site_name'] ??
                          'Không xác định',
                      style: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.bold,
                        color: Color(0xFF111827),
                      ),
                    ),
                    const SizedBox(height: 5),
                    Row(
                      children: [
                        Container(
                          width: 7,
                          height: 7,
                          decoration: BoxDecoration(
                            color: color,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          status,
                          style: TextStyle(
                            color: color,
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                    if (deployed) ...[
                      const SizedBox(height: 5),
                      Text(
                        'Mực nước: $level cm',
                        style: const TextStyle(
                          color: Color(0xFF6B7280),
                          fontSize: 13,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const Icon(
                Icons.chevron_right,
                color: Color(0xFF9CA3AF),
                size: 27,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildQuickFeatures() {
    return Column(
      crossAxisAlignment:
          CrossAxisAlignment.start,
      children: [
        const Text(
          'Tiện ích',
          style: TextStyle(
            fontSize: 19,
            fontWeight: FontWeight.bold,
            color: Color(0xFF111827),
          ),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: _featureCard(
                Icons.cloud_outlined,
                'Dự báo',
                'Thời tiết & ngập',
                const Color(0xFF2563EB),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _featureCard(
                Icons.warning_amber_rounded,
                'Cảnh báo',
                'Tình trạng hiện tại',
                const Color(0xFFF59E0B),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _featureCard(
    IconData icon,
    String title,
    String subtitle,
    Color color,
  ) {
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
        crossAxisAlignment:
            CrossAxisAlignment.start,
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(
              icon,
              color: color,
            ),
          ),
          const SizedBox(height: 11),
          Text(
            title,
            style: const TextStyle(
              fontWeight: FontWeight.bold,
              fontSize: 15,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            subtitle,
            style: const TextStyle(
              fontSize: 11,
              color: Color(0xFF6B7280),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildBottomNavigation() {
    return Container(
      height: 72,
      decoration: const BoxDecoration(
        color: Colors.white,
        border: Border(
          top: BorderSide(
            color: Color(0xFFE5E7EB),
          ),
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: _bottomItem(
              Icons.home_rounded,
              'Trang chủ',
              true,
            ),
          ),
          Expanded(
            child: _bottomItem(
              Icons.notifications_none_rounded,
              'Cảnh báo',
              false,
            ),
          ),
          Expanded(
            child: _bottomItem(
              Icons.info_outline_rounded,
              'Thông tin',
              false,
            ),
          ),
        ],
      ),
    );
  }

  Widget _bottomItem(
    IconData icon,
    String title,
    bool selected,
  ) {
    final color = selected
        ? const Color(0xFF1769AA)
        : const Color(0xFF9CA3AF);

    return Column(
      mainAxisAlignment:
          MainAxisAlignment.center,
      children: [
        Icon(
          icon,
          color: color,
          size: 25,
        ),
        const SizedBox(height: 3),
        Text(
          title,
          style: TextStyle(
            color: color,
            fontSize: 11,
            fontWeight: selected
                ? FontWeight.bold
                : FontWeight.normal,
          ),
        ),
      ],
    );
  }

  Widget _buildError() {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        const SizedBox(height: 150),
        const Icon(
          Icons.cloud_off,
          size: 65,
          color: Colors.red,
        ),
        const SizedBox(height: 18),
        const Center(
          child: Text(
            'Không kết nối được Backend',
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.bold,
            ),
          ),
        ),
        const SizedBox(height: 10),
        Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: 30,
          ),
          child: Text(
            error ?? '',
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: Colors.grey,
            ),
          ),
        ),
        const SizedBox(height: 20),
        Center(
          child: ElevatedButton.icon(
            onPressed: loadSites,
            icon: const Icon(Icons.refresh),
            label: const Text('Thử lại'),
          ),
        ),
      ],
    );
  }
}
