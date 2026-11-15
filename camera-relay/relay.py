"""FloodGuard: HTTP JPEG snapshots -> backend WebSocket (JPEG frames).
Run: pip install -r requirements.txt
Set CAMERA_URL, RELAY_URL and CAMERA_STREAM_KEY as environment variables.
No images are saved. Optional experimental AI overlay requires calibration.
"""
import os
import json
import time
import socket
from urllib.parse import urlsplit, urlunsplit
from zeroconf import ServiceBrowser, ServiceListener, Zeroconf
import cv2
import websocket
from water_level_ai import WaterLevelDetector
from snapshot_reader import SnapshotCamera, fetch_snapshot

CAMERA_URL = os.getenv("CAMERA_URL", "")
CAMERA_SNAPSHOT_URL = os.getenv("CAMERA_SNAPSHOT_URL", "")
CAMERA_SNAPSHOT_PORT = int(os.getenv("CAMERA_SNAPSHOT_PORT", "81"))
CAMERA_FALLBACK_URL = os.getenv("CAMERA_FALLBACK_URL", "")
CAMERA_MDNS_NAME = os.getenv("CAMERA_MDNS_NAME", "floodguard-cam").removesuffix(".local")
RELAY_URL = os.getenv("RELAY_URL", "wss://floodguard-backend-4dua.onrender.com/camera/uplink")
STREAM_KEY = os.getenv("CAMERA_STREAM_KEY", "")
FPS_LIMIT = max(0.1, min(10, float(os.getenv("CAMERA_RELAY_FPS", "2"))))
JPEG_QUALITY = max(40, min(95, int(os.getenv("CAMERA_JPEG_QUALITY", "85"))))
MAX_WIDTH = max(320, min(1280, int(os.getenv("CAMERA_MAX_WIDTH", "1024"))))
MAX_FRAME_BYTES = 180 * 1024  # Must match backend/camera-relay.js
AI_ENABLED = os.getenv("CAMERA_AI_ENABLED", "0") == "1"


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


def snapshot_url(candidate):
    """Use camera v1.2 snapshot endpoint on port 81, not /stream on 80."""
    parts = urlsplit(candidate)
    if parts.scheme != "http" or not parts.hostname:
        raise ValueError("Camera URL must be http://host[:port]/...")
    # An explicit /capture URL is accepted as-is, including its port.
    if parts.path.rstrip("/") == "/capture":
        return urlunsplit((parts.scheme, parts.netloc, "/capture", "", ""))
    host = parts.hostname
    if ":" in host:
        host = f"[{host}]"
    return f"http://{host}:{CAMERA_SNAPSHOT_PORT}/capture"


def discover_camera_url():
    # Explicit snapshot URL wins; legacy CAMERA_URL=/stream is converted to :81/capture.
    if CAMERA_SNAPSHOT_URL:
        return snapshot_url(CAMERA_SNAPSHOT_URL)
    if CAMERA_URL:
        return snapshot_url(CAMERA_URL)

    candidates = []
    try:
        address = socket.gethostbyname(CAMERA_MDNS_NAME + ".local")
        candidates.append(f"http://{address}:{CAMERA_SNAPSHOT_PORT}/capture")
    except OSError:
        pass

    # Always do Zeroconf discovery even if Windows cached a stale .local IP.
    try:
        with Zeroconf() as zc:
            listener = CameraListener(zc)
            browser = ServiceBrowser(zc, "_http._tcp.local.", listener)
            end = time.monotonic() + 6
            while time.monotonic() < end:
                if listener.url:
                    url = snapshot_url(listener.url)
                    if url not in candidates:
                        candidates.append(url)
                    break
                time.sleep(0.15)
            browser.cancel()
    except Exception as exc:
        print("mDNS discovery error:", exc, flush=True)

    if CAMERA_FALLBACK_URL:
        candidates.append(snapshot_url(CAMERA_FALLBACK_URL))

    for url in dict.fromkeys(candidates):
        try:
            # Validate by requesting a real image, not just resolving the name.
            fetch_snapshot(url, timeout=2)
            return url
        except Exception as exc:
            print(f"Camera candidate unavailable: {url}: {exc}", flush=True)
    raise RuntimeError("No responsive ESP32 snapshot endpoint; check Wi-Fi and :81/capture")


def run():
    detector = WaterLevelDetector() if AI_ENABLED else None
    if detector:
        print("Experimental AI overlay enabled. No database writes.", flush=True)
    if not STREAM_KEY:
        raise SystemExit("Set CAMERA_STREAM_KEY first; do not put it in public code.")
    while True:
        source = None
        ws = None
        try:
            snapshot_url_current = discover_camera_url()
            print("Camera snapshot endpoint:", snapshot_url_current, flush=True)
            source = SnapshotCamera(snapshot_url_current, timeout=10)
            print("Camera HTTP Snapshot reader ready", flush=True)
            ws = websocket.create_connection(
                RELAY_URL, timeout=12,
                header=["X-Camera-Key: " + STREAM_KEY],
                enable_multithread=True,
            )
            print("Connected to relay:", RELAY_URL, flush=True)
            last_sent = 0.0
            failure_count = 0
            last_ai_log = 0.0
            while True:
                # Do not request more snapshots than we plan to send.
                elapsed = time.monotonic() - last_sent
                if elapsed < 1.0 / FPS_LIMIT:
                    time.sleep(1.0 / FPS_LIMIT - elapsed)
                ok, frame = source.read()
                if not ok or frame is None:
                    failure_count += 1
                    if failure_count >= 10:
                        raise RuntimeError("Camera stopped producing frames")
                    time.sleep(0.1)
                    continue
                failure_count = 0
                now = time.monotonic()
                # Preserve camera detail while staying within Render's 180 KB cap.
                height, width = frame.shape[:2]
                if width > MAX_WIDTH:
                    frame = cv2.resize(
                        frame, (MAX_WIDTH, round(height * MAX_WIDTH / width)),
                        interpolation=cv2.INTER_AREA
                    )
                ai_result = None
                if detector:
                    try:
                        frame, level_cm = detector.process(frame)
                        ai_result = detector.last_result
                        if now - last_ai_log >= 5:
                            print(f"AI optical level: {ai_result['status']} / {level_cm}", flush=True)
                            last_ai_log = now
                    except Exception as exc:
                        print("AI failed:", exc, flush=True)
                        ai_result = {"status": "error", "levelCm": None, "confidence": None}
                data = None
                # Retry with lower JPEG quality only when necessary.
                for quality in (JPEG_QUALITY, 75, 65, 50):
                    if quality > JPEG_QUALITY:
                        continue
                    encoded_ok, encoded = cv2.imencode(
                        ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality]
                    )
                    if encoded_ok and encoded.nbytes <= MAX_FRAME_BYTES:
                        data = encoded.tobytes()
                        break
                # For unusually detailed scenes, reduce size before giving up.
                if data is None:
                    small = cv2.resize(
                        frame, None, fx=0.75, fy=0.75,
                        interpolation=cv2.INTER_AREA
                    )
                    encoded_ok, encoded = cv2.imencode(
                        ".jpg", small, [int(cv2.IMWRITE_JPEG_QUALITY), 65]
                    )
                    if encoded_ok and encoded.nbytes <= MAX_FRAME_BYTES:
                        data = encoded.tobytes()
                if data is None:
                    print("Skipping oversized camera frame", flush=True)
                    continue
                ws.send(data, opcode=websocket.ABNF.OPCODE_BINARY)
                if ai_result is not None:
                    ws.send(json.dumps({"type": "ai", **ai_result},
                                       separators=(",", ":")),
                            opcode=websocket.ABNF.OPCODE_TEXT)
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
