"""FloodGuard: HTTP JPEG snapshots -> backend WebSocket (JPEG frames).
Run: pip install -r requirements.txt
Set CAMERA_URL, RELAY_URL and CAMERA_STREAM_KEY as environment variables.
No images are saved. Optional experimental AI overlay requires calibration.
"""
import os
import json
import time
import socket
import threading
from urllib.error import HTTPError
from urllib.parse import urlsplit, urlunsplit
from zeroconf import ServiceBrowser, ServiceListener, Zeroconf
import cv2
import websocket
from water_level_ai import WaterLevelDetector
from snapshot_reader import SnapshotCamera

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
            # Validate TCP only: a preflight snapshot immediately followed by
            # the real snapshot can trigger HTTP 429 on firmware v1.3.
            parts = urlsplit(url)
            with socket.create_connection((parts.hostname, parts.port or 80), timeout=3):
                pass
            return url
        except Exception as exc:
            print(f"Camera candidate unavailable: {url}: {exc}", flush=True)
    raise RuntimeError("No reachable camera at port 81; check Wi-Fi, mDNS and camera HTTP server")



def encode_frame(frame):
    """Encode one frame within the backend 180 KB cap."""
    h, w = frame.shape[:2]
    if w > MAX_WIDTH:
        frame = cv2.resize(frame, (MAX_WIDTH, round(h * MAX_WIDTH / w)),
                           interpolation=cv2.INTER_AREA)
    for quality in (JPEG_QUALITY, 75, 65, 50):
        if quality > JPEG_QUALITY:
            continue
        ok, encoded = cv2.imencode(".jpg", frame,
                         [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        if ok and encoded.nbytes <= MAX_FRAME_BYTES:
            return encoded.tobytes()
    small = cv2.resize(frame, None, fx=0.75, fy=0.75,
                       interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".jpg", small,
                     [int(cv2.IMWRITE_JPEG_QUALITY), 65])
    return encoded.tobytes() if ok and encoded.nbytes <= MAX_FRAME_BYTES else None


class LatestFrame:
    """One-slot handoff: never accumulate frames when Render is slow."""
    def __init__(self):
        self.cv = threading.Condition()
        self.seq = 0
        self.jpeg = None
        self.ai = None

    def publish(self, jpeg, ai):
        with self.cv:
            self.jpeg = jpeg
            self.ai = ai
            self.seq += 1
            self.cv.notify_all()

    def newer(self, last_seq, timeout=3):
        with self.cv:
            self.cv.wait_for(lambda: self.seq > last_seq, timeout=timeout)
            if self.seq <= last_seq:
                return None
            return self.seq, self.jpeg, self.ai


def capture_worker(latest, stop):
    """Camera + AI worker runs regardless of WebSocket connectivity."""
    detector = WaterLevelDetector() if AI_ENABLED else None
    interval = 1.0 / FPS_LIMIT
    last_ai_log = 0.0
    while not stop.is_set():
        try:
            url = discover_camera_url()
            print("Camera snapshot endpoint:", url, flush=True)
            source = SnapshotCamera(url, timeout=10)
            next_capture = time.monotonic()
            errors = 0
            try:
                while not stop.is_set():
                    delay = next_capture - time.monotonic()
                    if delay > 0 and stop.wait(delay):
                        return
                    next_capture = time.monotonic() + interval
                    try:
                        ok, frame = source.read()
                        if not ok or frame is None:
                            raise RuntimeError("Camera returned no image")
                    except HTTPError as exc:
                        if exc.code == 429:
                            # ESP32 v1.3 rate limiter: do not reset WebSocket.
                            print("Camera HTTP 429: waiting before next capture", flush=True)
                            if stop.wait(max(interval, 2.0)):
                                return
                            next_capture = time.monotonic() + interval
                            continue
                        raise
                    errors = 0
                    ai = None
                    if detector:
                        try:
                            frame, level = detector.process(frame)
                            ai = {"type": "ai", **detector.last_result}
                            now = time.monotonic()
                            if now - last_ai_log >= 5:
                                print("AI optical level:", ai["status"], "/",
                                      level, flush=True)
                                last_ai_log = now
                        except Exception as exc:
                            print("AI processing error:", exc, flush=True)
                            ai = {"type": "ai", "status": "error",
                                  "levelCm": None, "confidence": None}
                    jpeg = encode_frame(frame)
                    if jpeg is not None:
                        latest.publish(jpeg, ai)
                    else:
                        print("Skipping oversized JPEG", flush=True)
            finally:
                source.release()
        except Exception as exc:
            print("Camera worker error:", exc, "- rediscovering in 3s",
                  flush=True)
            if stop.wait(3):
                return


def run():
    if not STREAM_KEY:
        raise SystemExit("Set CAMERA_STREAM_KEY first; do not put it in public code.")
    print("FloodGuard relay: independent camera/AI and Render sender", flush=True)
    if AI_ENABLED:
        print("Experimental AI enabled; results require calibration.", flush=True)
    latest = LatestFrame()
    stop = threading.Event()
    camera_thread = threading.Thread(target=capture_worker,
                                      args=(latest, stop), daemon=True)
    camera_thread.start()
    last_seq = 0
    try:
        while not stop.is_set():
            ws = None
            try:
                ws = websocket.create_connection(
                    RELAY_URL, timeout=12,
                    header=["X-Camera-Key: " + STREAM_KEY],
                    enable_multithread=True,
                )
                # Sending should not block the camera worker; timeout only
                # affects this WebSocket and causes sender reconnection.
                ws.settimeout(8)
                print("Connected to relay:", RELAY_URL, flush=True)
                # New connection gets the most recent frame, but never
                # retransmits old frames after an interrupted send.
                last_seq = 0
                while not stop.is_set():
                    item = latest.newer(last_seq, timeout=3)
                    if item is None:
                        continue
                    seq, jpeg, ai = item
                    last_seq = seq
                    ws.send(jpeg, opcode=websocket.ABNF.OPCODE_BINARY)
                    if ai is not None:
                        ws.send(json.dumps(ai, separators=(",", ":")),
                                opcode=websocket.ABNF.OPCODE_TEXT)
            except Exception as exc:
                print("Render sender error:", exc,
                      "- reconnecting WebSocket only in 3s", flush=True)
                if stop.wait(3):
                    break
            finally:
                if ws is not None:
                    try:
                        ws.close(timeout=1)
                    except Exception:
                        pass
    except KeyboardInterrupt:
        print("Stopped.", flush=True)
    finally:
        stop.set()
        camera_thread.join(timeout=2)


if __name__ == "__main__":
    run()
