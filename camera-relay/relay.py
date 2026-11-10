"""FloodGuard camera relay: ESP32-S3 MJPEG -> backend WebSocket (JPEG frames).
Run: pip install opencv-python websocket-client
Set CAMERA_URL, RELAY_URL and CAMERA_STREAM_KEY as environment variables.
No images are saved; AI will be integrated separately.
"""
import os
import time
import ssl
import cv2
import websocket

CAMERA_URL = os.getenv("CAMERA_URL", "http://192.168.102.9/stream")
RELAY_URL = os.getenv("RELAY_URL", "wss://floodguard-backend-4dua.onrender.com/camera/uplink")
STREAM_KEY = os.getenv("CAMERA_STREAM_KEY", "")
FPS_LIMIT = max(1, min(10, float(os.getenv("CAMERA_RELAY_FPS", "4"))))
JPEG_QUALITY = 65
MAX_FRAME_BYTES = 180 * 1024

def run():
    if not STREAM_KEY:
        raise SystemExit("Set CAMERA_STREAM_KEY first; do not put it in public code.")
    while True:
        source = None
        ws = None
        try:
            print("Opening local camera:", CAMERA_URL, flush=True)
            source = cv2.VideoCapture(CAMERA_URL, cv2.CAP_FFMPEG)
            if not source.isOpened():
                raise RuntimeError("Cannot open ESP32 camera stream")
            ws = websocket.create_connection(
                RELAY_URL, timeout=12,
                header=["X-Camera-Key: " + STREAM_KEY],
                enable_multithread=True,
            )
            print("Connected to relay:", RELAY_URL, flush=True)
            last_sent = 0.0
            failure_count = 0
            while True:
                ok, frame = source.read()
                if not ok or frame is None:
                    failure_count += 1
                    if failure_count >= 10:
                        raise RuntimeError("Camera stopped producing frames")
                    time.sleep(0.1)
                    continue
                failure_count = 0
                now = time.monotonic()
                if now - last_sent < 1.0 / FPS_LIMIT:
                    continue
                # Resize to keep upload data/bandwidth and backend memory bounded.
                height, width = frame.shape[:2]
                if width > 640:
                    frame = cv2.resize(frame, (640, round(height * 640 / width)))
                encoded_ok, encoded = cv2.imencode(
                    ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY]
                )
                if not encoded_ok:
                    continue
                data = encoded.tobytes()
                if len(data) > MAX_FRAME_BYTES:
                    print("Skipping oversized frame", len(data), flush=True)
                    continue
                ws.send(data, opcode=websocket.ABNF.OPCODE_BINARY)
                last_sent = now
        except (Exception, KeyboardInterrupt) as exc:
            if isinstance(exc, KeyboardInterrupt):
                print("Stopped.")
                break
            print("Relay error:", exc, "- reconnecting in 3s", flush=True)
            time.sleep(3)
        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
            if source is not None:
                source.release()

if __name__ == "__main__":
    run()
