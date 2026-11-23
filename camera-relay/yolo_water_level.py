"""FloodGuard YOLO11 segmentation preview and calibrated 0..10 cm measurement.

Experimental only. Uses camera-ai.json anchors measured on the SAME fixed
camera frame. Never infers centimeters from mask area or class confidence.
"""
import json
import os
from pathlib import Path

import cv2
import numpy as np

from water_level_ai import CONFIG_PATH


class YoloWaterLevelDetector:
    def __init__(self, config_path=CONFIG_PATH):
        from ultralytics import YOLO
        self.config = json.loads(Path(config_path).read_text(encoding="utf-8"))
        model_path = Path(os.getenv("CAMERA_YOLO_MODEL", str(Path(__file__).parent / "models" / "best.pt"))).expanduser()
        if not model_path.is_file():
            raise FileNotFoundError(f"YOLO weights missing: {model_path}")
        self.model = YOLO(str(model_path))
        self.conf = max(0.05, min(0.95, float(os.getenv("CAMERA_YOLO_CONF", "0.35"))))
        self.last_result = {"status": "uncalibrated", "levelCm": None, "confidence": None, "method": "yolo"}
        self.history = []

    def _reply(self, image, status, caption, level=None, confidence=None):
        self.last_result = {"status": status, "levelCm": level, "confidence": confidence, "method": "yolo"}
        cv2.rectangle(image, (3, 3), (min(image.shape[1]-1, 620), 38), (0, 0, 0), -1)
        cv2.putText(image, caption, (9, 27), cv2.FONT_HERSHEY_SIMPLEX,
                    0.58, (0, 215, 70) if status == "ok" else (0, 190, 255), 2, cv2.LINE_AA)
        return image, level

    def _anchors(self):
        anchors = self.config.get("anchors", [])
        if not self.config.get("calibrated") or len(anchors) != 3:
            return None
        try:
            if [float(a["cm"]) for a in anchors] != [0, 5, 10]:
                return None
            ys = [float(a["y"]) for a in anchors]
            if not (0 <= ys[2] < ys[1] < ys[0] <= 1):
                return None
            return ys
        except (KeyError, ValueError, TypeError):
            return None

    def process(self, image):
        height, width = image.shape[:2]
        out = image.copy()
        try:
            results = self.model.predict(image, conf=self.conf, imgsz=640, verbose=False,
                                         device="cpu", max_det=5)
            result = results[0]
            if result.masks is None or result.boxes is None or len(result.boxes) == 0:
                self.history.clear()
                return self._reply(out, "not_detected", "YOLO: WATER NOT DETECTED")
            names = result.names
            items = []
            for i in range(len(result.boxes)):
                cls = int(result.boxes.cls[i].item())
                if str(names[cls]).lower() != "water":
                    continue
                prob = float(result.boxes.conf[i].item())
                raw_mask = result.masks.data[i].cpu().numpy()
                mask = cv2.resize(raw_mask, (width, height),
                                  interpolation=cv2.INTER_NEAREST) >= 0.5
                if mask.sum() < 100:
                    continue
                items.append((prob, mask))
            if not items:
                self.history.clear()
                return self._reply(out, "not_detected", "YOLO: WATER NOT DETECTED")
            items.sort(key=lambda item: item[1].sum(), reverse=True)
            prob, mask = items[0]
            if len(items) > 1 and items[1][1].sum() > mask.sum() * 0.2:
                self.history.clear()
                return self._reply(out, "low_confidence", "YOLO: MULTIPLE WATER MASKS")
            shade = np.zeros_like(out)
            shade[:, :, 2] = 240
            out[mask] = cv2.addWeighted(out[mask], 0.65, shade[mask], 0.35, 0)
            cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(out, cnts, -1, (0, 145, 255), 2)

            anchors = self._anchors()
            if anchors is None:
                return self._reply(out, "uncalibrated", "YOLO MASK: CALIBRATE 0/5/10 CM")
            roi = self.config.get("roi", {})
            try:
                x1, x2 = round(float(roi["x1"]) * width), round(float(roi["x2"]) * width)
                y1, y2 = round(float(roi["y1"]) * height), round(float(roi["y2"]) * height)
            except (KeyError, ValueError, TypeError):
                return self._reply(out, "uncalibrated", "YOLO: INVALID RULER ROI")
            if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height) or x2-x1 < 12:
                return self._reply(out, "uncalibrated", "YOLO: INVALID RULER ROI")

            cv2.rectangle(out, (x1, y1), (x2, y2), (255, 205, 0), 2)
            # The observation strip must track the waterline beside the ruler;
            # never use the polygon area as a proxy for centimeters.
            strip = mask[y1:y2, x1:x2]
            coverage = np.mean(strip, axis=1)
            stable = 5
            threshold = 0.50
            candidates = []
            for i in range(max(0, len(coverage)-stable+1)):
                if np.all(coverage[i:i+stable] >= threshold):
                    if np.mean(coverage[i:] >= threshold) >= 0.70:
                        candidates.append(i)
                        break
            if not candidates:
                self.history.clear()
                return self._reply(out, "low_confidence", "YOLO: WATERLINE OCCLUDED")
            line_y = y1+candidates[0]
            y_norm = line_y/height
            y0,y5,y10 = anchors
            if not (y10 <= y_norm <= y0):
                self.history.clear()
                return self._reply(out, "out_of_range", "YOLO: OUTSIDE 0-10 CM")
            level = (5*(y0-y_norm)/(y0-y5)) if y_norm >= y5 else (5+5*(y5-y_norm)/(y5-y10))
            if not 0 <= level <= 10:
                self.history.clear()
                return self._reply(out, "out_of_range", "YOLO: OUTSIDE 0-10 CM")
            self.history.append(float(level))
            self.history = self.history[-5:]
            level = round(float(np.median(self.history)), 2)
            cv2.line(out, (x1,line_y), (x2,line_y), (0,255,70), 2)
            return self._reply(out, "ok", f"YOLO EXPERIMENT: {level:.2f} cm", level,
                               round(prob, 3))
        except Exception:
            self.history.clear()
            raise
