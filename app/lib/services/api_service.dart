import 'dart:convert';

import 'package:http/http.dart' as http;

class ApiService {
  static const String _configuredBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://floodguard-backend-4dua.onrender.com',
  );

  static String get baseUrl => _configuredBaseUrl.endsWith('/')
      ? _configuredBaseUrl.substring(0, _configuredBaseUrl.length - 1)
      : _configuredBaseUrl;

  static Future<Map<String, dynamic>> _decodeResponse(http.Response response) async {
    if (response.statusCode != 200 && response.statusCode != 202) {
      final decoded = jsonDecode(response.body);
      final message = decoded is Map ? decoded['error']?.toString() : null;
      throw Exception(message ?? ('Không thể tải dữ liệu (HTTP ' + response.statusCode.toString() + ')'));
    }
    final decoded = jsonDecode(response.body);
    if (decoded is! Map) {
      throw Exception('Dữ liệu máy chủ không hợp lệ');
    }
    return Map<String, dynamic>.from(decoded);
  }

  static Future<Map<String, dynamic>> _get(String path) async {
    final response = await http
        .get(Uri.parse(baseUrl + path))
        .timeout(const Duration(seconds: 15));

    return _decodeResponse(response);
  }

  static Future<Map<String, dynamic>> getHealth() =>
      _get('/api/v2/health');

  static Future<Map<String, dynamic>> getLatest() =>
      _get('/api/v2/latest');

  static Future<Map<String, dynamic>> getForecast() =>
      _get('/api/v2/forecast?sim_scale=60');

  static Future<Map<String, dynamic>> getRainHistory({int hours = 1}) =>
      _get('/api/v2/rain/history?hours=' + hours.toString() + '&limit=500');

  static Future<Map<String, dynamic>> getTideHistory({int hours = 1}) =>
      _get('/api/v2/tide/history?hours=' + hours.toString() + '&limit=500');

  static Future<Map<String, dynamic>> clearNode2Fault() async {
    final response = await http
        .post(
          Uri.parse(baseUrl + '/api/v2/node2/fault/reset'),
          headers: {'Content-Type': 'application/json'},
          body: '{}',
        )
        .timeout(const Duration(seconds: 15));
    return _decodeResponse(response);
  }
}
