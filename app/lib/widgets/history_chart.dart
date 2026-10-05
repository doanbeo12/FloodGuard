import 'dart:math' as math;

import 'package:flutter/material.dart';

class HistoryPoint {
  final DateTime time;
  final double? node1;
  final double? node2;
  final double? max;

  const HistoryPoint({
    required this.time,
    this.node1,
    this.node2,
    this.max,
  });
}

class HistoryChart extends StatelessWidget {
  final List<HistoryPoint> points;
  final double height;

  const HistoryChart({
    super.key,
    required this.points,
    this.height = 320,
  });

  @override
  Widget build(BuildContext context) {
    if (points.isEmpty) {
      return Container(
        height: height,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: const Color(0xFFE5E7EB)),
        ),
        child: const Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.show_chart,
              size: 42,
              color: Color(0xFF9CA3AF),
            ),
            SizedBox(height: 10),
            Text(
              'Chưa có dữ liệu trong 6 giờ gần nhất',
              style: TextStyle(
                color: Color(0xFF6B7280),
                fontSize: 13,
              ),
            ),
          ],
        ),
      );
    }

    return Container(
      height: height,
      padding: const EdgeInsets.fromLTRB(8, 14, 12, 8),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE5E7EB)),
      ),
      child: CustomPaint(
        painter: _HistoryChartPainter(points),
        child: const SizedBox.expand(),
      ),
    );
  }
}

class _HistoryChartPainter extends CustomPainter {
  final List<HistoryPoint> points;

  _HistoryChartPainter(this.points);

  static const Color node1Color = Color(0xFF2563EB);
  static const Color node2Color = Color(0xFF7C3AED);
  static const Color gridColor = Color(0xFFE2E8F0);
  static const Color labelColor = Color(0xFF64748B);

  @override
  void paint(Canvas canvas, Size size) {
    const leftPad = 48.0;
    const rightPad = 10.0;
    const topPad = 34.0;
    const bottomPad = 42.0;

    final chartRect = Rect.fromLTWH(
      leftPad,
      topPad,
      math.max(1, size.width - leftPad - rightPad),
      math.max(1, size.height - topPad - bottomPad),
    );

    final values = <double>[];
    for (final point in points) {
      if (point.node1 != null) values.add(point.node1!);
      if (point.node2 != null) values.add(point.node2!);
    }

    if (values.isEmpty) return;

    final rawMin = values.reduce(math.min);
    final rawMax = values.reduce(math.max);

    double yMin = math.min(0, rawMin);
    double yMax = math.max(1, rawMax);

    if ((yMax - yMin) < 1) {
      yMax = yMin + 1;
    }

    final padding = (yMax - yMin) * 0.16;
    yMin = math.max(0, yMin - padding);
    yMax += padding;

    final gridPaint = Paint()
      ..color = gridColor
      ..strokeWidth = 1;

    final axisTextStyle = const TextStyle(
      color: labelColor,
      fontSize: 11,
    );

    _drawText(
      canvas,
      'cm',
      const Offset(4, 4),
      const TextStyle(
        color: labelColor,
        fontSize: 10,
        fontWeight: FontWeight.w600,
      ),
      width: 30,
    );

    const gridCount = 5;
    for (int i = 0; i <= gridCount; i++) {
      final ratio = i / gridCount;
      final y = chartRect.bottom - chartRect.height * ratio;

      canvas.drawLine(
        Offset(chartRect.left, y),
        Offset(chartRect.right, y),
        gridPaint,
      );

      final value = yMin + (yMax - yMin) * ratio;
      _drawText(
        canvas,
        value.toStringAsFixed(1),
        Offset(0, y - 7),
        axisTextStyle,
        width: leftPad - 7,
        align: TextAlign.right,
      );
    }

    final timeMin = points.first.time;
    final timeMax = points.last.time;
    final totalSeconds = math.max(
      1,
      timeMax.difference(timeMin).inSeconds,
    ).toDouble();

    const labelCount = 4;
    for (int i = 0; i <= labelCount; i++) {
      final ratio = i / labelCount;
      final x = chartRect.left + chartRect.width * ratio;

      canvas.drawLine(
        Offset(x, chartRect.bottom),
        Offset(x, chartRect.bottom + 4),
        gridPaint,
      );

      final targetSeconds = totalSeconds * ratio;
      HistoryPoint closest = points.first;
      double closestDelta = double.infinity;

      for (final point in points) {
        final seconds = point.time
            .difference(timeMin)
            .inSeconds
            .toDouble();
        final delta = (seconds - targetSeconds).abs();
        if (delta < closestDelta) {
          closestDelta = delta;
          closest = point;
        }
      }

      _drawText(
        canvas,
        _formatTime(closest.time),
        Offset(x - 28, chartRect.bottom + 8),
        axisTextStyle,
        width: 56,
        align: TextAlign.center,
      );
    }

    _drawSeries(
      canvas,
      chartRect,
      yMin,
      yMax,
      timeMin,
      totalSeconds,
      (point) => point.node1,
      node1Color,
    );

    _drawSeries(
      canvas,
      chartRect,
      yMin,
      yMax,
      timeMin,
      totalSeconds,
      (point) => point.node2,
      node2Color,
    );

    _drawLegend(
      canvas,
      Offset(chartRect.left, 14),
      node1Color,
      'Node 1',
    );
    _drawLegend(
      canvas,
      Offset(chartRect.left + 100, 14),
      node2Color,
      'Node 2',
    );
  }

  void _drawSeries(
    Canvas canvas,
    Rect rect,
    double yMin,
    double yMax,
    DateTime timeMin,
    double totalSeconds,
    double? Function(HistoryPoint) valueOf,
    Color color,
  ) {
    final path = Path();
    bool started = false;

    final pointPaint = Paint()
      ..color = color
      ..style = PaintingStyle.fill;

    for (final point in points) {
      final value = valueOf(point);
      if (value == null) {
        started = false;
        continue;
      }

      final seconds = point.time
          .difference(timeMin)
          .inSeconds
          .toDouble();
      final ratio = (seconds / totalSeconds).clamp(0.0, 1.0);

      final x = rect.left + rect.width * ratio;
      final y = rect.bottom -
          ((value - yMin) / (yMax - yMin)) * rect.height;

      final offset = Offset(x, y);

      if (!started) {
        path.moveTo(offset.dx, offset.dy);
        started = true;
      } else {
        path.lineTo(offset.dx, offset.dy);
      }

      canvas.drawCircle(offset, 3.2, pointPaint);
    }

    final linePaint = Paint()
      ..color = color
      ..strokeWidth = 3.0
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    canvas.drawPath(path, linePaint);
  }

  void _drawLegend(
    Canvas canvas,
    Offset offset,
    Color color,
    String text,
  ) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;

    canvas.drawLine(
      offset,
      Offset(offset.dx + 18, offset.dy),
      paint,
    );

    _drawText(
      canvas,
      text,
      Offset(offset.dx + 23, offset.dy - 8),
      const TextStyle(
        fontSize: 11,
        color: labelColor,
        fontWeight: FontWeight.w600,
      ),
      width: 70,
    );
  }

  void _drawText(
    Canvas canvas,
    String text,
    Offset offset,
    TextStyle style, {
    required double width,
    TextAlign align = TextAlign.left,
  }) {
    final painter = TextPainter(
      text: TextSpan(
        text: text,
        style: style,
      ),
      textAlign: align,
      textDirection: TextDirection.ltr,
    )..layout(maxWidth: width);

    painter.paint(canvas, offset);
  }

  String _formatTime(DateTime date) {
    final hour = date.hour.toString().padLeft(2, '0');
    final minute = date.minute.toString().padLeft(2, '0');
    return '${hour}:${minute}';
  }

  @override
  bool shouldRepaint(covariant _HistoryChartPainter oldDelegate) {
    return oldDelegate.points != points;
  }
}
