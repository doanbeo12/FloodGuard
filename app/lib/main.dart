import 'package:flutter/material.dart';
import 'screens/home_screen.dart';

void main() {
  runApp(const FloodWarningApp());
}

class FloodWarningApp extends StatelessWidget {
  const FloodWarningApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'FloodGuard',
      theme: ThemeData(
        useMaterial3: true,
        fontFamily: 'Roboto',
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF1769AA),
          brightness: Brightness.light,
        ),
      ),
      home: const HomeScreen(),
    );
  }
}
