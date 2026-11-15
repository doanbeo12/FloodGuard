"""FloodGuard experimental optical water-level measurement (0..10 cm).

This is an OpenCV color/edge heuristic for fixed camera + ruler, not a
trained neural network. Calibration must be performed with real images.
A failed measurement is reported as missing, never replaced with 0 cm.
"""
import json
from pathlib import Path

import cv2
import numpy as np

CONFIG_PATH = Path(__file__).with_name("camera-ai.json")


class WaterLevelDetector:
    def __init__(self, config_path=CONFIG_PATH):
        self.config = json.loads(Path(config_path).read_text(encoding="utf-8"))
        self.history = []
        self.last_result = {"status": "uncalibrated", "levelCm": None, "confidence": None}

    @staticmethod
    def _caption(image, label, color):
        cv2.rectangle(image, (4, 4), (min(image.shape[1]-1, 470), 39), (0,0,0), -1)
        cv2.putText(image, label, (10, 28), cv2.FONT_HERSHEY_SIMPLEX,
                    0.62, color, 2, cv2.LINE_AA)

    def _result(self, out, status, label, level=None, confidence=None):
        self.last_result = {"status": status, "levelCm": level, "confidence": confidence}
        self._caption(out, label, (0, 210, 0) if status == "ok" else (0, 170, 255))
        return out, level

    def process(self, image):
        out = image.copy()
        h, w = image.shape[:2]
        cfg = self.config
        roi = cfg.get("roi", {})
        try:
            x1 = round(float(roi["x1"]) * w)
            x2 = round(float(roi["x2"]) * w)
            y1 = round(float(roi["y1"]) * h)
            y2 = round(float(roi["y2"]) * h)
        except (KeyError, ValueError, TypeError):
            return self._result(out, "uncalibrated", "AI: SET RULER ROI")
        if not (0 <= x1 < x2 <= w and 0 <= y1 < y2 <= h) or x2 - x1 < 12 or y2 - y1 < 20:
            return self._result(out, "uncalibrated", "AI: INVALID ROI")
        cv2.rectangle(out, (x1,y1), (x2,y2), (0,255,255), 2)

        anchors = cfg.get("anchors", [])
        if (not cfg.get("calibrated") or len(anchors) != 3
                or [a.get("cm") for a in anchors] != [0, 5, 10]
                or not all(isinstance(a.get("y"), (float, int)) for a in anchors)):
            return self._result(out, "uncalibrated", "AI: NEED 0/5/10 CALIBRATION")
        ys = [float(a["y"]) for a in anchors]
        if not (0 <= ys[2] < ys[1] < ys[0] <= 1):
            return self._result(out, "uncalibrated", "AI: BAD CALIBRATION MARKERS")

        # Detect cyan/blue water in a narrow vertical observation strip
        # aligned with the ruler. Avoid any colored background in the ROI.
        crop = image[y1:y2, x1:x2]
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        low = np.array(cfg.get("hsv_lower", [80, 50, 45]), dtype=np.uint8)
        high = np.array(cfg.get("hsv_upper", [135, 255, 255]), dtype=np.uint8)
        mask = cv2.inRange(hsv, low, high)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3,3),np.uint8))
        coverage = np.count_nonzero(mask, axis=1) / max(1, mask.shape[1])

        threshold = float(cfg.get("min_row_coverage", 0.45))
        stable = max(3, min(12, int(cfg.get("stable_rows", 5))))
        candidate = None
        confidence = 0.0
        for i in range(len(coverage) - stable):
            if np.all(coverage[i:i+stable] >= threshold):
                below = coverage[i:]
                fraction = float(np.mean(below >= threshold))
                if fraction >= 0.67:
                    candidate = i
                    confidence = min(1.0, fraction * float(np.mean(coverage[i:i+stable])))
                    break
        if candidate is None:
            self.history.clear()
            return self._result(out, "not_detected", "AI: WATERLINE NOT DETECTED")
        y_norm = (y1 + candidate) / h

        # Piecewise linear mapping accounts for perspective (three measured anchors).
        if not (ys[2] <= y_norm <= ys[0]):
            self.history.clear()
            return self._result(out, "out_of_range", "AI: OUTSIDE 0-10 CM RANGE")
        if confidence < float(cfg.get("min_confidence", 0.45)):
            self.history.clear()
            return self._result(out, "low_confidence", "AI: LOW CONFIDENCE")
        if y_norm >= ys[1]:
            raw_cm = 5.0 * (ys[0] - y_norm) / (ys[0] - ys[1])
        else:
            raw_cm = 5.0 + 5.0 * (ys[1] - y_norm) / (ys[1] - ys[2])
        self.history.append(raw_cm)
        self.history = self.history[-5:]
        cm = round(float(np.median(self.history)), 2)

        line_y = y1 + candidate
        cv2.line(out, (x1, line_y), (x2, line_y), (0, 255, 0), 2)
        return self._result(out, "ok", f"AI EXPERIMENT: {cm:.1f} cm", cm, round(confidence, 2))
