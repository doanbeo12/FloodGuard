"""Interactive local calibration of FloodGuard camera (0, 5, 10 cm).

Camera/ruler MUST stay fixed. Run in a desktop Windows session with OpenCV GUI.
Uses live snapshots and asks the operator to select a narrow blue-water strip and
the waterline at each of the three known levels.
"""
import json
import time
from pathlib import Path

import cv2

from relay import discover_camera_url
from snapshot_reader import fetch_snapshot

CONFIG = Path(__file__).with_name("camera-ai.json")
WINDOW = "FloodGuard AI Calibration"


def click_point(frame, prompt):
    marked = frame.copy()
    cv2.putText(marked, prompt, (12, 30), cv2.FONT_HERSHEY_SIMPLEX,
                0.58, (20, 20, 20), 4, cv2.LINE_AA)
    cv2.putText(marked, prompt, (12, 30), cv2.FONT_HERSHEY_SIMPLEX,
                0.58, (255, 255, 255), 2, cv2.LINE_AA)
    selection = []

    def callback(event, x, y, flags, userdata):
        if event == cv2.EVENT_LBUTTONDOWN:
            selection.clear()
            selection.append((x, y))

    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
    cv2.setMouseCallback(WINDOW, callback)
    while True:
        shown = marked.copy()
        if selection:
            cv2.circle(shown, selection[0], 7, (0, 255, 255), 2)
        cv2.imshow(WINDOW, shown)
        key = cv2.waitKey(30) & 0xFF
        if key in (13, 32) and selection:
            return selection[0]
        if key in (27, ord("q")):
            raise KeyboardInterrupt


def main():
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    url = discover_camera_url()
    print("Camera:", url)
    print("Keep camera/ruler unchanged. Close relay.py during calibration.")
    points = {}
    frames = {}
    try:
        for cm in (0, 5, 10):
            input(f"Set actual water level to {cm} cm, let it settle, press ENTER...")
            last_error = None
            for attempt in range(4):
                try:
                    frames[cm] = fetch_snapshot(url, timeout=12)
                    break
                except Exception as exc:
                    last_error = exc
                    time.sleep(2)
            if cm not in frames:
                raise RuntimeError(f"Cannot capture {cm} cm image: {last_error}")
            h, w = frames[cm].shape[:2]
            if cm == 5:
                print("Select a narrow vertical strip near the ruler where BLUE water enters as level rises.")
                x, y, rw, rh = cv2.selectROI(WINDOW, frames[cm], showCrosshair=True, fromCenter=False)
                if rw < 12 or rh < 20:
                    raise RuntimeError("ROI too small or not selected")
                cfg["roi"] = {"x1": round(x/w, 5), "y1": round(y/h, 5),
                              "x2": round((x+rw)/w, 5), "y2": round((y+rh)/h, 5)}
            label = ("Click 0cm ruler bottom marker" if cm == 0
                     else f"Click visible waterline at {cm} cm")
            px, py = click_point(frames[cm], label + "  then ENTER")
            points[cm] = round(py / h, 5)
            print(f"{cm} cm calibration y={points[cm]}")
        if not (points[10] < points[5] < points[0]):
            raise RuntimeError("Invalid perspective anchors: expected y10 < y5 < y0")
        cfg["anchors"] = [{"cm": cm, "y": points[cm]} for cm in (0,5,10)]
        cfg["calibrated"] = True
        CONFIG.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("Saved:", CONFIG)
        print("Calibration is provisional. Validate at 2,4,6,8 cm before trusting values.")
    finally:
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
