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
    this.height = 280,
  });

  @override
  Widget build(BuildContext context) {
    if (points.isEmpty) {
      return Container(
        height: height,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: const Color(0xFFF8FAFC),
          borderRadius: BorderRadius.circular(16),
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
      padding: const EdgeInsets.fromLTRB(8, 16, 16, 8),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(16),
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
  static const Color maxColor = Color(0xFFF97316);
  static const Color gridColor = Color(0xFFE2E8F0);
  static const Color labelColor = Color(0xFF64748B);

  @override
  void paint(Canvas canvas, Size size) {
    const leftPad = 42.0;
    const rightPad = 8.0;
    const topPad = 18.0;
    const bottomPad = 36.0;

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
      if (point.max != null) values.add(point.max!);
    }

    if (values.isEmpty) return;

    final rawMin = values.reduce(math.min);
    final rawMax = values.reduce(math.max);

    double yMin = math.min(0, rawMin);
    double yMax = math.max(1, rawMax);

    if ((yMax - yMin) < 1) {
      yMax = yMin + 1;
    }

    final padding = (yMax - yMin) * 0.12;
    yMin = math.max(0, yMin - padding);
    yMax += padding;

    final gridPaint = Paint()
      ..color = gridColor
      ..strokeWidth = 1;

    final axisTextStyle = const TextStyle(
      color: labelColor,
      fontSize: 10,
    );

    // Grid + Y labels.
    const gridCount = 4;
    for (int i = 0; i <= gridCount; i++) {
      final ratio = i / gridCount;
      final y = chartRect.bottom -
          chartRect.height * ratio;

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
        width: leftPad - 6,
        align: TextAlign.right,
      );
    }

    // X labels.
    final timeMin = points.first.time;
    final timeMax = points.last.time;
    final totalSeconds =
        timeMax.difference(timeMin).inSeconds.toDouble();

    const labelCount = 4;
    for (int i = 0; i <= labelCount; i++) {
      final ratio = i / labelCount;
      final x = chartRect.left +
          chartRect.width * ratio;

      canvas.drawLine(
        Offset(x, chartRect.bottom),
        Offset(x, chartRect.bottom + 4),
        gridPaint,
      );

      final index = ((points.length - 1) * ratio)
          .round()
          .clamp(0, points.length - 1);

      final point = points[index];

      _drawText(
        canvas,
        _formatTime(point.time),
        Offset(x - 24, chartRect.bottom + 7),
        axisTextStyle,
        width: 48,
        align: TextAlign.center,
      );
    }

    // Plot series.
    _drawSeries(
      canvas,
      chartRect,
      yMin,
      yMax,
      (point) => point.node1,
      node1Color,
    );

    _drawSeries(
      canvas,
      chartRect,
      yMin,
      yMax,
      (point) => point.node2,
      node2Color,
    );

    _drawSeries(
      canvas,
      chartRect,
      yMin,
      yMax,
      (point) => point.max,
      maxColor,
    );

    // Legend.
    final legendY = 2.0;
    _drawLegend(canvas, Offset(chartRect.left, legendY), node1Color, 'Node 1');
    _drawLegend(canvas, Offset(chartRect.left + 80, legendY), node2Color, 'Node 2');
    _drawLegend(canvas, Offset(chartRect.left + 160, legendY), maxColor, 'Lớn nhất');

    // Avoid unused variable warning.
    if (totalSeconds < 0) {
      return;
    }
  }

  void _drawSeries(
    Canvas canvas,
    Rect rect,
    double yMin,
    double yMax,
    double? Function(HistoryPoint) valueOf,
    Color color,
  ) {
    final path = Path();
    bool started = false;
    final pointPaint = Paint()
      ..color = color
      ..style = PaintingStyle.fill;

    for (int i = 0; i < points.length; i++) {
      final value = valueOf(points[i]);
      if (value == null) {
        started = false;
        continue;
      }

      final x = points.length == 1
          ? rect.center.dx
          : rect.left +
              rect.width * (i / (points.length - 1));

      final y = rect.bottom -
          ((value - yMin) / (yMax - yMin)) *
              rect.height;

      final offset = Offset(x, y);

      if (!started) {
        path.moveTo(offset.dx, offset.dy);
        started = true;
      } else {
        path.lineTo(offset.dx, offset.dy);
      }

      canvas.drawCircle(offset, 2.5, pointPaint);
    }

    final linePaint = Paint()
      ..color = color
      ..strokeWidth = 2.2
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
      ..strokeWidth = 2.5
      ..strokeCap = StrokeCap.round;

    canvas.drawLine(
      offset,
      Offset(offset.dx + 14, offset.dy),
      paint,
    );

    _drawText(
      canvas,
      text,
      Offset(offset.dx + 18, offset.dy - 7),
      const TextStyle(
        fontSize: 10,
        color: labelColor,
        fontWeight: FontWeight.w500,
      ),
      width: 62,
      align: TextAlign.left,
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
    return '$hour:$minute';
  }

  @override
  bool shouldRepaint(covariant _HistoryChartPainter oldDelegate) {
    return oldDelegate.points != points;
  }
}
