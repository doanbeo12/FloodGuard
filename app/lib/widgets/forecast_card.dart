import 'package:flutter/material.dart';

class ForecastCard extends StatelessWidget {
  final String assessment;
  final double? rateCmMin;
  final int? rainProbability;
  final double? rainMm;
  final String methodText;
  final String summary;

  const ForecastCard({
    super.key,
    required this.assessment,
    required this.rateCmMin,
    required this.rainProbability,
    required this.rainMm,
    required this.methodText,
    required this.summary,
  });

  Color _assessmentColor() {
    final text = assessment.toLowerCase();
    if (text.contains('tăng')) return const Color(0xFFF97316);
    if (text.contains('giảm')) return const Color(0xFF16A34A);
    return const Color(0xFF2563EB);
  }

  IconData _assessmentIcon() {
    final text = assessment.toLowerCase();
    if (text.contains('tăng')) return Icons.trending_up;
    if (text.contains('giảm')) return Icons.trending_down;
    return Icons.trending_flat;
  }

  String _rateText() {
    if (rateCmMin == null) return 'Đang cập nhật';
    final value = rateCmMin!;
    final sign = value > 0 ? '+' : '';
    return '${sign}${value.toStringAsFixed(2)} cm/phút';
  }

  String _rainText() {
    if (rainProbability == null && rainMm == null) {
      return 'Đang cập nhật dự báo mưa';
    }

    final probability = rainProbability == null
        ? '--'
        : '${rainProbability}%';
    final amount = rainMm == null
        ? '--'
        : '${rainMm!.toStringAsFixed(1)} mm';

    return '${probability} • ${amount}';
  }

  @override
  Widget build(BuildContext context) {
    final color = _assessmentColor();

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
                  color: color.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(
                  _assessmentIcon(),
                  color: color,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Đánh giá 1 giờ tới',
                      style: TextStyle(
                        fontSize: 13,
                        color: Color(0xFF6B7280),
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      assessment,
                      style: TextStyle(
                        color: color,
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
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
          const SizedBox(height: 13),
          Text(
            summary,
            style: const TextStyle(
              fontSize: 13,
              height: 1.45,
              color: Color(0xFF374151),
            ),
          ),
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
