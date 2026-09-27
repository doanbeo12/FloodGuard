import 'dart:convert';

import 'package:http/http.dart' as http;

class ApiService {
  // Development default: Android Emulator -> backend on the same PC.
  // Production build:
  // flutter build apk --release \
  //   --dart-define=API_BASE_URL=https://your-api-domain.example
  static const String _configuredBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:3001',
  );

  static String get baseUrl {
    if (_configuredBaseUrl.endsWith('/')) {
      return _configuredBaseUrl.substring(0, _configuredBaseUrl.length - 1);
    }
    return _configuredBaseUrl;
  }

  static Future<List<dynamic>> getSites() async {
    final response = await http
        .get(Uri.parse('$baseUrl/api/sites'))
        .timeout(const Duration(seconds: 10));

    if (response.statusCode != 200) {
      throw Exception(
        'Không thể tải danh sách địa điểm '
        '(HTTP ${response.statusCode})',
      );
    }

    final jsonData = jsonDecode(response.body);
    return jsonData['data'] ?? [];
  }

  static Future<Map<String, dynamic>> getSiteStatus(int siteId) async {
    final response = await http
        .get(Uri.parse('$baseUrl/api/sites/$siteId/status'))
        .timeout(const Duration(seconds: 10));

    if (response.statusCode != 200) {
      throw Exception(
        'Không thể tải trạng thái địa điểm '
        '(HTTP ${response.statusCode})',
      );
    }

    final jsonData = jsonDecode(response.body);
    return Map<String, dynamic>.from(jsonData);
  }

  static Future<Map<String, dynamic>> getSiteHourlyWeather(
    int siteId, {
    int hours = 24,
  }) async {
    final response = await http
        .get(
          Uri.parse(
            '$baseUrl/api/sites/$siteId/weather/hourly?hours=$hours',
          ),
        )
        .timeout(const Duration(seconds: 12));

    if (response.statusCode != 200) {
      throw Exception(
        'Không thể tải dự báo thời tiết '
        '(HTTP ${response.statusCode})',
      );
    }

    final jsonData = jsonDecode(response.body);
    return Map<String, dynamic>.from(jsonData);
  }

  static Future<Map<String, dynamic>> getSiteHistory(
    int siteId, {
    int hours = 6,
  }) async {
    final response = await http
        .get(
          Uri.parse(
            '$baseUrl/api/sites/$siteId/history?hours=$hours',
          ),
        )
        .timeout(const Duration(seconds: 10));

    if (response.statusCode != 200) {
      throw Exception(
        'Không thể tải lịch sử địa điểm '
        '(HTTP ${response.statusCode})',
      );
    }

    final jsonData = jsonDecode(response.body);
    return Map<String, dynamic>.from(jsonData);
  }
}
