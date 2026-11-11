"""Experimental optical water-level estimator for a fixed FloodGuard demo tank.

Works best for blue-dyed water seen from a stationary camera. This is
classical computer vision, not a trained deep-learning model. Invalid
or uncalibrated measurements are never reported as centimeters.
"""
import json
from pathlib import Path

import cv2
import numpy as np

CONFIG_PATH = Path(__file__).with_name("camera-ai.json")


class WaterLevelDetector:
    def __init__(self, config_path=CONFIG_PATH):
        self.path = Path(config_path)
        self.config = json.loads(self.path.read_text(encoding="utf-8"))
        self.level_history = []

    def process(self, frame):
        out = frame.copy()
        h, w = frame.shape[:2]
        cfg = self.config
        roi = cfg.get("roi", {})
        x1 = max(0, min(w - 1, int(float(roi.get("x1", 0.25)) * w)))
        x2 = max(x1 + 1, min(w, int(float(roi.get("x2", 0.75)) * w)))
        y1 = max(0, min(h - 1, int(float(roi.get("y1", 0.15)) * h)))
        y2 = max(y1 + 1, min(h, int(float(roi.get("y2", 0.9)) * h)))
        cv2.rectangle(out, (x1, y1), (x2 - 1, y2 - 1), (0, 255, 255), 2)

        # Both anchors are mandatory and must be measured on this camera view.
        zero_y = cfg.get("zero_y")
        full_y = cfg.get("full_y")
        full_cm = float(cfg.get("full_cm", 0))
        valid_calibration = (
            cfg.get("calibrated") is True and
            isinstance(zero_y, (int, float)) and
            isinstance(full_y, (int, float)) and
            full_cm > 0 and 0 <= full_y < zero_y <= 1
        )
        if not valid_calibration:
            self._label(out, "AI: NEED CALIBRATION", (0, 180, 255))
            return out, None

        hsv = cv2.cvtColor(frame[y1:y2, x1:x2], cv2.COLOR_BGR2HSV)
        lower = np.array(cfg.get("hsv_lower", [85, 65, 40]), dtype=np.uint8)
        upper = np.array(cfg.get("hsv_upper", [135, 255, 255]), dtype=np.uint8)
        mask = cv2.inRange(hsv, lower, upper)
        width = mask.shape[1]
        if width < 12 or mask.shape[0] < 12:
            self._label(out, "AI: ROI TOO SMALL", (0, 180, 255))
            return out, None
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        # A waterline must have wide, consistent blue coverage below it.
        coverage = np.count_nonzero(mask, axis=1) / width
        threshold = float(cfg.get("min_row_coverage", 0.5))
        stable_rows = max(3, int(cfg.get("stable_rows", 6)))
        candidate = None
        for index in range(0, len(coverage) - stable_rows + 1):
            if np.all(coverage[index:index + stable_rows] >= threshold):
                tail = coverage[index:]
                if np.mean(tail >= threshold) >= 0.65:
                    candidate = index
                    break
        if candidate is None:
            self.level_history.clear()
            self._label(out, "AI: WATER NOT DETECTED", (0, 180, 255))
            return out, None

        water_y = (y1 + candidate) / h
        level = (float(zero_y) - water_y) * full_cm / (float(zero_y) - float(full_y))
        if level < -0.5 or level > full_cm + 0.5:
            self.level_history.clear()
            self._label(out, "AI: OUT OF RANGE", (0, 180, 255))
            return out, None

        self.level_history.append(max(0.0, min(full_cm, level)))
        self.level_history = self.level_history[-5:]
        smoothed = float(np.median(self.level_history))
        line_y = y1 + candidate
        cv2.line(out, (x1, line_y), (x2 - 1, line_y), (0, 255, 0), 2)
        self._label(out, f"AI DEMO: {smoothed:.1f} cm", (0, 220, 0))
        return out, round(smoothed, 2)

    @staticmethod
    def _label(image, label, color):
        cv2.rectangle(image, (5, 5), (min(image.shape[1] - 1, 380), 38), (0, 0, 0), -1)
        cv2.putText(image, label, (12, 28), cv2.FONT_HERSHEY_SIMPLEX,
                    0.65, color, 2, cv2.LINE_AA)
