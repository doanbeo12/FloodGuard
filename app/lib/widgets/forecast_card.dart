import 'package:flutter/material.dart';

class ForecastCard extends StatelessWidget {
  final double? predictedWaterCm;
  final int? rainProbability;
  final double? tideLevelM;
  final String tideRiskLabel;
  final bool rainTriggered;
  final bool tideTriggered;

  const ForecastCard({
    super.key,
    required this.predictedWaterCm,
    required this.rainProbability,
    required this.tideLevelM,
    required this.tideRiskLabel,
    required this.rainTriggered,
    required this.tideTriggered,
  });

  Color _levelColor(double? level) {
    if (level == null) return const Color(0xFF6B7280);
    if (level >= 15) return const Color(0xFFDC2626);
    if (level >= 10) return const Color(0xFFF97316);
    if (level >= 7) return const Color(0xFFEAB308);
    if (level >= 3) return const Color(0xFF2563EB);
    return const Color(0xFF16A34A);
  }

  @override
  Widget build(BuildContext context) {
    final color = _levelColor(predictedWaterCm);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(18),
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
          const Text(
            'Mực nước dự báo sau 1 giờ',
            style: TextStyle(
              fontSize: 15,
              color: Color(0xFF6B7280),
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            predictedWaterCm == null
                ? '--'
                : '${predictedWaterCm!.toStringAsFixed(1)} cm',
            style: TextStyle(
              color: color,
              fontSize: 34,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 16),
          _ForecastInputRow(
            icon: Icons.cloud_outlined,
            title: 'Khả năng mưa',
            value: rainProbability == null
                ? '--'
                : '$rainProbability%',
            active: rainTriggered,
          ),
          const SizedBox(height: 10),
          _ForecastInputRow(
            icon: Icons.waves_outlined,
            title: 'Triều cường',
            value: tideLevelM == null
                ? '--'
                : '${tideLevelM!.toStringAsFixed(2)} m • $tideRiskLabel',
            active: tideTriggered,
          ),
        ],
      ),
    );
  }
}

class _ForecastInputRow extends StatelessWidget {
  final IconData icon;
  final String title;
  final String value;
  final bool active;

  const _ForecastInputRow({
    required this.icon,
    required this.title,
    required this.value,
    required this.active,
  });

  @override
  Widget build(BuildContext context) {
    final color = active
        ? const Color(0xFFF97316)
        : const Color(0xFF64748B);

    return Row(
      children: [
        Icon(
          icon,
          size: 20,
          color: color,
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            title,
            style: const TextStyle(
              fontSize: 13,
              color: Color(0xFF6B7280),
            ),
          ),
        ),
        Text(
          value,
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.bold,
            color: color,
          ),
        ),
      ],
    );
  }
}
