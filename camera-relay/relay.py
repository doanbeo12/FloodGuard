"""FloodGuard camera relay: ESP32-S3 MJPEG -> backend WebSocket (JPEG frames).
Run: pip install opencv-python websocket-client
Set CAMERA_URL, RELAY_URL and CAMERA_STREAM_KEY as environment variables.
No images are saved; AI will be integrated separately.
"""
import os
import time
import socket
from zeroconf import ServiceBrowser, ServiceListener, Zeroconf
import cv2
import websocket

CAMERA_URL = os.getenv("CAMERA_URL", "")
CAMERA_FALLBACK_URL = os.getenv("CAMERA_FALLBACK_URL", "")
CAMERA_MDNS_NAME = os.getenv("CAMERA_MDNS_NAME", "floodguard-cam").removesuffix(".local")
RELAY_URL = os.getenv("RELAY_URL", "wss://floodguard-backend-4dua.onrender.com/camera/uplink")
STREAM_KEY = os.getenv("CAMERA_STREAM_KEY", "")
FPS_LIMIT = max(1, min(10, float(os.getenv("CAMERA_RELAY_FPS", "4"))))
JPEG_QUALITY = 65
MAX_FRAME_BYTES = 180 * 1024


class CameraListener(ServiceListener):
    def __init__(self, zc):
        self.url = None

    def add_service(self, zc, service_type, name):
        info = zc.get_service_info(service_type, name, timeout=1200)
        if not info or (info.server or "").rstrip(".").lower() != (CAMERA_MDNS_NAME.lower() + ".local"):
            return
        for address in info.parsed_addresses():
            try:
                socket.inet_pton(socket.AF_INET, address)
                self.url = f"http://{address}:{info.port}/stream"
                break
            except OSError:
                pass

    def update_service(self, zc, service_type, name):
        self.add_service(zc, service_type, name)

    def remove_service(self, zc, service_type, name):
        pass


def discover_camera_url():
    if CAMERA_URL:
        return CAMERA_URL
    try:
        address = socket.gethostbyname(CAMERA_MDNS_NAME + ".local")
        return f"http://{address}/stream"
    except OSError:
        pass
    try:
        with Zeroconf() as zc:
            listener = CameraListener(zc)
            browser = ServiceBrowser(zc, "_http._tcp.local.", listener)
            end = time.monotonic() + 6
            while time.monotonic() < end and not listener.url:
                time.sleep(0.15)
            browser.cancel()
            if listener.url:
                return listener.url
    except Exception as exc:
        print("mDNS discovery error:", exc, flush=True)
    if CAMERA_FALLBACK_URL:
        print("Using configured fallback camera URL", flush=True)
        return CAMERA_FALLBACK_URL
    raise RuntimeError("Camera not found: check mDNS on ESP32 and local Wi-Fi connectivity")


def run():
    if not STREAM_KEY:
        raise SystemExit("Set CAMERA_STREAM_KEY first; do not put it in public code.")
    while True:
        source = None
        ws = None
        try:
            stream_url = discover_camera_url()
            print("Opening local camera:", stream_url, flush=True)
            source = cv2.VideoCapture(stream_url, cv2.CAP_FFMPEG)
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
