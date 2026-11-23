# FloodGuard — YOLO Segmentation trial (0–10 cm)

The camera relay now supports `CAMERA_AI_ENGINE=yolo` (opt-in). The default is still `opencv`.

## Setup (Windows PowerShell)

1. Update the local repository: `git pull origin main`.
2. Copy the **NEW** `floodguard_0_10_pseudo/weights/best.pt` into
   `camera-relay/models/best.pt` on the laptop. Do not commit it.
3. From `camera-relay`: `python -m pip install -r requirements-yolo.txt`.
4. Keep a matching secret `CAMERA_STREAM_KEY` in the same PowerShell session.
5. Set environment variables:

```powershell
$env:CAMERA_SOURCE="snapshot"
$env:CAMERA_SNAPSHOT_URL="http://192.168.102.9:81/capture"
$env:CAMERA_TRANSPORT="http"
$env:CAMERA_AI_ENABLED="1"
$env:CAMERA_AI_ENGINE="yolo"
$env:CAMERA_YOLO_MODEL="models/best.pt"
$env:CAMERA_RELAY_FPS="0.3"
python relay.py
```

The camera address is an example from the last demo; update it if DHCP changed.
The snapshot request interval is at least 3 seconds to avoid overloading the ESP32.

## Calibration

YOLO segmentation masks are visible immediately on the Web camera card.
**Numeric centimeters are withheld until `camera-ai.json` has real calibrated
0/5/10 cm anchors and a ruler-adjacent vertical ROI.**

Stop relay and run `python calibrate_water.py` with the camera connected.
Set actual 0 cm, 5 cm and 10 cm heights and click measured waterline positions.
At the 5 cm step choose a narrow vertical ROI **beside the ruler that intersects
the visible water boundary and continues down into the water across levels**.
Keep the camera and ruler fixed throughout; changing pose requires recalibration.

Test 2, 4, 6, 8, 10 cm and intermediate values against ruler measurements.
Segmentation confidence is NOT confidence in cm accuracy. Occluded or invalid
measurement returns no value (never a fabricated zero). A visible water mask
alone is NOT proof that the waterline has been measured correctly.

To return to prior OpenCV:
```powershell
$env:CAMERA_AI_ENGINE="opencv"
python relay.py
```

## Safety & scope

- YOLO `/camera/frame` and `/camera/ai` use existing HTTPS Backend endpoints.
- **YOLO is intentionally NOT forwarded to Node 1**, even when NODE1_AI_KEY exists.
- No pump control changes. No new PostgreSQL/MySQL schema.
- Model runs **locally on laptop CPU**, not in Render, ESP32 or browser.
- Before demonstrating safety decisions, quantify cm MAE/RMSE on independent
  camera trials (including occlusion) and calibrate rejection thresholds.
