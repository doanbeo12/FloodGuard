import 'package:flutter/material.dart';

class ForecastPoint {
  final int minutes;
  final double waterLevel;
  final int alertLevel;
  final String status;

  const ForecastPoint({
    required this.minutes,
    required this.waterLevel,
    required this.alertLevel,
    required this.status,
  });
}

class ForecastCard extends StatelessWidget {
  final List<ForecastPoint> points;
  final double rateCmMin;
  final String methodText;
  final String summary;

  const ForecastCard({
    super.key,
    required this.points,
    required this.rateCmMin,
    required this.methodText,
    required this.summary,
  });

  Color _statusColor(int level) {
    if (level >= 3) return const Color(0xFFDC2626);
    if (level >= 2) return const Color(0xFFF97316);
    if (level >= 1) return const Color(0xFFEAB308);
    return const Color(0xFF16A34A);
  }

  @override
  Widget build(BuildContext context) {
    if (points.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(17),
          border: Border.all(
            color: const Color(0xFFE5E7EB),
          ),
        ),
        child: const Text(
          'Chưa đủ dữ liệu để dự báo 1 giờ tiếp theo.',
          style: TextStyle(
            color: Color(0xFF6B7280),
            fontSize: 13,
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(17),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: const Color(0xFFE5E7EB),
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.04),
            blurRadius: 8,
            offset: const Offset(0, 3),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: const Color(0xFF2563EB)
                      .withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Icon(
                  Icons.query_stats,
                  color: Color(0xFF2563EB),
                ),
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Text(
                  'Dự báo 1 giờ tiếp theo',
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),

          const SizedBox(height: 10),

          Text(
            methodText,
            style: const TextStyle(
              fontSize: 12,
              color: Color(0xFF6B7280),
            ),
          ),

          const SizedBox(height: 14),

          for (final point in points)
            _ForecastRow(
              point: point,
              color: _statusColor(point.alertLevel),
            ),

          const SizedBox(height: 10),

          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(13),
            decoration: BoxDecoration(
              color: const Color(0xFFF8FAFC),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(
              summary,
              style: const TextStyle(
                fontSize: 13,
                height: 1.4,
                color: Color(0xFF374151),
              ),
            ),
          ),

          const SizedBox(height: 8),

          Text(
            'Tốc độ dùng để dự báo: ${rateCmMin.toStringAsFixed(3)} cm/phút',
            style: const TextStyle(
              fontSize: 11,
              color: Color(0xFF9CA3AF),
            ),
          ),
        ],
      ),
    );
  }
}

class _ForecastRow extends StatelessWidget {
  final ForecastPoint point;
  final Color color;

  const _ForecastRow({
    required this.point,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 9),
      child: Row(
        children: [
          SizedBox(
            width: 68,
            child: Text(
              '+${point.minutes} phút',
              style: const TextStyle(
                fontSize: 12,
                color: Color(0xFF6B7280),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: LinearProgressIndicator(
                minHeight: 8,
                value: (point.waterLevel / 15).clamp(0.04, 1.0),
                backgroundColor: const Color(0xFFE5E7EB),
                valueColor: AlwaysStoppedAnimation<Color>(color),
              ),
            ),
          ),
          const SizedBox(width: 10),
          SizedBox(
            width: 55,
            child: Text(
              '${point.waterLevel.toStringAsFixed(1)} cm',
              textAlign: TextAlign.right,
              style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
