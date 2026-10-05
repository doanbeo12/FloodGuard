import 'package:flutter/material.dart';

class ForecastLevelPoint {
  final int minutes;
  final double waterLevelCm;

  const ForecastLevelPoint({
    required this.minutes,
    required this.waterLevelCm,
  });
}

class ForecastCard extends StatelessWidget {
  final List<ForecastLevelPoint> points;
  final double? rateCmMin;
  final int? rainProbability;
  final double? rainMm;
  final String methodText;
  final String summary;

  const ForecastCard({
    super.key,
    required this.points,
    required this.rateCmMin,
    required this.rainProbability,
    required this.rainMm,
    required this.methodText,
    required this.summary,
  });

  String _rateText() {
    if (rateCmMin == null) return 'Đang cập nhật';
    final value = rateCmMin!;
    final sign = value > 0 ? '+' : '';
    return '${sign}${value.toStringAsFixed(2)} cm/phút';
  }

  String _rainText() {
    if (rainProbability == null && rainMm == null) {
      return 'Đang cập nhật';
    }

    final probability = rainProbability == null
        ? '--'
        : '${rainProbability}%';
    final amount = rainMm == null
        ? '--'
        : '${rainMm!.toStringAsFixed(1)} mm';

    return '$probability • $amount';
  }

  Color _levelColor(double level) {
    if (level >= 15) return const Color(0xFFDC2626);
    if (level >= 10) return const Color(0xFFF97316);
    if (level >= 7) return const Color(0xFFEAB308);
    return const Color(0xFF2563EB);
  }

  @override
  Widget build(BuildContext context) {
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
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: const Color(0xFF2563EB).withValues(alpha: 0.10),
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
                  'Mực nước dự báo trong 1 giờ tới',
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),

          if (points.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 10),
              child: Text(
                'Đang cập nhật các mốc dự báo.',
                style: TextStyle(
                  color: Color(0xFF6B7280),
                  fontSize: 13,
                ),
              ),
            )
          else
            for (final point in points) ...[
              _ForecastRow(
                point: point,
                color: _levelColor(point.waterLevelCm),
              ),
              if (point != points.last) const SizedBox(height: 9),
            ],

          const SizedBox(height: 15),

          Row(
            children: [
              Expanded(
                child: _InfoBox(
                  icon: Icons.speed,
                  title: 'Tốc độ hiện tại',
                  value: _rateText(),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _InfoBox(
                  icon: Icons.cloud_outlined,
                  title: 'Mưa giờ tới',
                  value: _rainText(),
                ),
              ),
            ],
          ),

          if (summary.isNotEmpty) ...[
            const SizedBox(height: 13),
            Text(
              summary,
              style: const TextStyle(
                fontSize: 13,
                height: 1.45,
                color: Color(0xFF374151),
              ),
            ),
          ],

          const SizedBox(height: 8),
          Text(
            methodText,
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
  final ForecastLevelPoint point;
  final Color color;

  const _ForecastRow({
    required this.point,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: 13,
        vertical: 11,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: color.withValues(alpha: 0.16),
        ),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 78,
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
                minHeight: 7,
                value: (point.waterLevelCm / 15).clamp(0.02, 1.0),
                backgroundColor: const Color(0xFFE5E7EB),
                valueColor: AlwaysStoppedAnimation<Color>(color),
              ),
            ),
          ),
          const SizedBox(width: 12),
          SizedBox(
            width: 62,
            child: Text(
              '${point.waterLevelCm.toStringAsFixed(1)} cm',
              textAlign: TextAlign.right,
              style: TextStyle(
                color: color,
                fontSize: 13,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _InfoBox extends StatelessWidget {
  final IconData icon;
  final String title;
  final String value;

  const _InfoBox({
    required this.icon,
    required this.title,
    required this.value,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            icon,
            size: 18,
            color: const Color(0xFF2563EB),
          ),
          const SizedBox(height: 7),
          Text(
            title,
            style: const TextStyle(
              fontSize: 10,
              color: Color(0xFF6B7280),
            ),
          ),
          const SizedBox(height: 2),
          Text(
            value,
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.bold,
            ),
          ),
        ],
      ),
    );
  }
}
