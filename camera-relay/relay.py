"""FloodGuard: persistent MJPEG /stream -> Render HTTP/WebSocket frames.
Run: pip install -r requirements.txt
Set CAMERA_URL, RELAY_URL and CAMERA_STREAM_KEY as environment variables.
No images are saved. Optional experimental AI overlay requires calibration.
"""
import os
import json
import time
import socket
import threading
import numpy as np
from urllib.parse import urlsplit, urlunsplit
from zeroconf import ServiceBrowser, ServiceListener, Zeroconf
import cv2
import websocket
import requests
from water_level_ai import WaterLevelDetector
from mjpeg_reader import MjpegCamera

CAMERA_URL = os.getenv("CAMERA_URL", "")
CAMERA_STREAM_URL = os.getenv("CAMERA_STREAM_URL", "")
CAMERA_STREAM_PORT = int(os.getenv("CAMERA_STREAM_PORT", "80"))
CAMERA_SOURCE = os.getenv("CAMERA_SOURCE", "mjpeg").strip().lower()
CAMERA_SNAPSHOT_URL = os.getenv("CAMERA_SNAPSHOT_URL", "").strip()
CAMERA_FALLBACK_URL = os.getenv("CAMERA_FALLBACK_URL", "")
CAMERA_MDNS_NAME = os.getenv("CAMERA_MDNS_NAME", "floodguard-cam").removesuffix(".local")
RELAY_URL = os.getenv("RELAY_URL", "wss://floodguard-backend-4dua.onrender.com/camera/uplink")
STREAM_KEY = os.getenv("CAMERA_STREAM_KEY", "")
FPS_LIMIT = max(0.1, min(10, float(os.getenv("CAMERA_RELAY_FPS", "2"))))
JPEG_QUALITY = max(40, min(95, int(os.getenv("CAMERA_JPEG_QUALITY", "85"))))
MAX_WIDTH = max(320, min(1280, int(os.getenv("CAMERA_MAX_WIDTH", "1024"))))
MAX_FRAME_BYTES = 180 * 1024  # Must match backend/camera-relay.js
AI_ENABLED = os.getenv("CAMERA_AI_ENABLED", "0") == "1"
AI_ENGINE = os.getenv("CAMERA_AI_ENGINE", "opencv").strip().lower()
TRANSPORT = os.getenv("CAMERA_TRANSPORT", "http").lower()
HTTP_BASE = os.getenv("CAMERA_HTTP_BASE", RELAY_URL.replace("wss://", "https://").replace("ws://", "http://").split("/camera/")[0]).rstrip("/")
NODE1_URL = os.getenv("NODE1_URL", "").rstrip("/")
NODE1_AI_KEY = os.getenv("NODE1_AI_KEY", "")


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


def stream_url(candidate):
    """Normalize camera source to one persistent MJPEG /stream on port 80."""
    parts = urlsplit(candidate)
    if parts.scheme != "http" or not parts.hostname:
        raise ValueError("Camera URL must be http://host[:port]/...")
    host = parts.hostname
    if ":" in host:
        host = f"[{host}]"
    # The camera firmware serves video on 80, snapshots on 81.
    return f"http://{host}:{CAMERA_STREAM_PORT}/stream"


def discover_camera_url():
    if CAMERA_STREAM_URL:
        return stream_url(CAMERA_STREAM_URL)
    if CAMERA_URL:
        return stream_url(CAMERA_URL)

    candidates = []
    try:
        address = socket.gethostbyname(CAMERA_MDNS_NAME + ".local")
        candidates.append(stream_url(f"http://{address}/stream"))
    except OSError:
        pass

    try:
        with Zeroconf() as zc:
            listener = CameraListener(zc)
            browser = ServiceBrowser(zc, "_http._tcp.local.", listener)
            end = time.monotonic() + 6
            while time.monotonic() < end:
                if listener.url:
                    url = stream_url(listener.url)
                    if url not in candidates:
                        candidates.append(url)
                    break
                time.sleep(0.15)
            browser.cancel()
    except Exception as exc:
        print("mDNS discovery error:", exc, flush=True)

    if CAMERA_FALLBACK_URL:
        candidates.append(stream_url(CAMERA_FALLBACK_URL))

    for url in dict.fromkeys(candidates):
        try:
            parts = urlsplit(url)
            with socket.create_connection((parts.hostname, parts.port or 80), timeout=3):
                pass
            return url
        except Exception as exc:
            print(f"Camera candidate unavailable: {url}: {exc}", flush=True)
    raise RuntimeError("No reachable MJPEG camera at port 80; check Wi-Fi and /stream")



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


def snapshot_url(candidate):
    """Use the camera firmware's independent JPEG endpoint (port 81)."""
    parts = urlsplit(candidate)
    if parts.scheme != "http" or not parts.hostname:
        raise ValueError("Snapshot URL must be http://host[:port]/...")
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    return f"http://{host}:81/capture"


def read_snapshot(session, url):
    """Read until JPEG end marker without waiting for HTTP EOF or 512 KB."""
    with session.get(url, timeout=(3, 8), headers={"Connection": "close"},
                     stream=True) as response:
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "").lower()
        data = bytearray()
        # ESP32 sometimes streams without a reliable Content-Length; read
        # incrementally and finish at JPEG EOI rather than waiting for EOF.
        for chunk in response.iter_content(chunk_size=1024):
            if not chunk:
                continue
            data.extend(chunk)
            if len(data) > 512 * 1024:
                raise RuntimeError("Camera /capture JPEG exceeded 512 KB")
            start = data.find(b"\xff\xd8")
            if start >= 0:
                end = data.find(b"\xff\xd9", start + 2)
                if end >= 0:
                    jpeg = bytes(data[start:end + 2])
                    frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8),
                                         cv2.IMREAD_COLOR)
                    if frame is None:
                        raise RuntimeError("Camera /capture JPEG decode failed")
                    return frame
            if len(data) >= 8192 and b"\xff\xd8" not in data:
                raise RuntimeError(
                    f"Camera /capture is not JPEG (type={content_type}, "
                    f"first_bytes={bytes(data[:80])!r})")
        raise RuntimeError(
            f"Camera /capture ended without complete JPEG "
            f"(type={content_type}, bytes={len(data)}, "
            f"first_bytes={bytes(data[:80])!r})")


def capture_worker(latest, stop):
    """Read one frame at a time; AI and upload run in independent threads."""
    if not AI_ENABLED:
        detector = None
    elif AI_ENGINE == "yolo":
        from yolo_water_level import YoloWaterLevelDetector
        detector = YoloWaterLevelDetector()
        print("Camera AI engine: YOLO segmentation (experimental; Node 1 forwarding disabled)", flush=True)
    else:
        detector = WaterLevelDetector()
        print("Camera AI engine: OpenCV", flush=True)
    interval = 1.0 / FPS_LIMIT
    last_ai_log = 0.0
    snapshot_delay = max(interval, 3.0) if CAMERA_SOURCE == "snapshot" else interval
    while not stop.is_set():
        source = None
        session = None
        try:
            if CAMERA_SOURCE == "snapshot":
                url = snapshot_url(CAMERA_SNAPSHOT_URL) if CAMERA_SNAPSHOT_URL else snapshot_url(discover_camera_url())
                print("Camera JPEG snapshot endpoint:", url, flush=True)
                session = requests.Session()
                session.trust_env = False
            else:
                url = discover_camera_url()
                print("Camera MJPEG stream endpoint:", url, flush=True)
                source = MjpegCamera(url, timeout=8)
            next_capture = time.monotonic()
            while not stop.is_set():
                delay = next_capture - time.monotonic()
                if delay > 0 and stop.wait(delay):
                    return
                next_capture = time.monotonic() + (snapshot_delay if CAMERA_SOURCE == "snapshot" else interval)
                if CAMERA_SOURCE == "snapshot":
                    try:
                        frame = read_snapshot(session, url)
                    except requests.HTTPError as exc:
                        status = exc.response.status_code if exc.response is not None else None
                        if status in (429, 503):
                            retry_after = exc.response.headers.get("Retry-After", "")
                            try:
                                wait_seconds = max(3.0, min(60.0, float(retry_after)))
                            except (ValueError, TypeError):
                                wait_seconds = min(30.0, max(6.0, snapshot_delay * 2))
                            snapshot_delay = max(snapshot_delay, wait_seconds)
                            print(f"Camera HTTP {status}: pausing {wait_seconds:.0f}s; snapshot interval now {snapshot_delay:.1f}s", flush=True)
                            if stop.wait(wait_seconds):
                                return
                            next_capture = time.monotonic()
                            continue
                        raise
                else:
                    ok, frame = source.read()
                    if not ok or frame is None:
                        raise RuntimeError("Camera returned no image")
                ai = None
                if detector:
                    try:
                        frame, level = detector.process(frame)
                        ai = {"type": "ai", **detector.last_result}
                        now = time.monotonic()
                        if now - last_ai_log >= 5:
                            print("AI "+AI_ENGINE+" level:", ai["status"], "/",
                                  level, flush=True)
                            last_ai_log = now
                    except Exception as exc:
                        print("AI processing error:", exc, flush=True)
                        ai = {"type": "ai", "status": "error", "method": AI_ENGINE,
                              "levelCm": None, "confidence": None}
                jpeg = encode_frame(frame)
                if jpeg is not None:
                    latest.publish(jpeg, ai)
                else:
                    print("Skipping oversized JPEG", flush=True)
        except Exception as exc:
            print("Camera worker error:", exc, "- retrying in 3s", flush=True)
            if stop.wait(3):
                return
        finally:
            if source is not None:
                source.release()
            if session is not None:
                session.close()


def discover_node1():
    if NODE1_URL:
        return NODE1_URL
    try:
        addr = socket.gethostbyname("floodguard-node1.local")
        return f"http://{addr}"
    except OSError:
        pass
    class NodeListener(ServiceListener):
        def __init__(self):
            self.ip = None
        def add_service(self, zc, typ, name):
            info = zc.get_service_info(typ, name, timeout=800)
            if info and (info.server or "").rstrip(".").lower() == "floodguard-node1.local":
                for addr in info.parsed_addresses():
                    try:
                        socket.inet_pton(socket.AF_INET, addr)
                        self.ip = addr
                        return
                    except OSError:
                        continue
        def update_service(self, zc, typ, name):
            self.add_service(zc, typ, name)
        def remove_service(self, zc, typ, name):
            pass
    with Zeroconf() as zc:
        listener = NodeListener()
        browser = ServiceBrowser(zc, "_http._tcp.local.", listener)
        end = time.monotonic() + 3
        while time.monotonic() < end and not listener.ip:
            time.sleep(0.1)
        browser.cancel()
        if listener.ip:
            return f"http://{listener.ip}"
    raise RuntimeError("Node1 not found on LAN; set NODE1_URL to its IP")


def node1_ai_sender(latest, stop):
    if AI_ENGINE == "yolo":
        print("YOLO trial: Node 1 AI upload disabled until cm accuracy is verified", flush=True)
        return
    if not NODE1_AI_KEY or NODE1_AI_KEY == "SET_PRIVATE_LOCAL_AI_KEY":
        print("NODE1_AI_KEY not set; local AI forwarding disabled", flush=True)
        return
    session = requests.Session()
    session.headers.update({"X-Node-Key": NODE1_AI_KEY})
    last_seq = 0
    url = None
    while not stop.is_set():
        item = latest.newer(last_seq, timeout=3)
        if item is None:
            continue
        seq, jpeg, ai = item
        last_seq = seq
        if ai is None:
            continue
        if not url:
            try:
                url = discover_node1() + "/ai"
                print("Node1 AI endpoint:", url, flush=True)
            except Exception as exc:
                print("Node1 discovery:", exc, flush=True)
                stop.wait(2)
                continue
        data = {
            "seq": int(time.time() * 1000) & 0xFFFFFFFF,
            "valid": ai.get("status") == "ok",
            "level_cm": ai.get("levelCm"),
            "confidence": ai.get("confidence")
        }
        try:
            response = session.post(url, json=data, timeout=(2, 3))
            response.raise_for_status()
        except requests.RequestException as exc:
            print("Node1 AI upload:", exc, flush=True)
            url = None
            stop.wait(1)
    session.close()


def http_sender(latest, stop):
    """Send JPEG over HTTPS rather than a long-running WebSocket.

    One-session keep-alive and small POSTs work around unstable WebSockets.
    On failed upload, retry the *next* fresh image, never build a backlog.
    """
    print("HTTPS upload enabled:", HTTP_BASE + "/camera/frame", flush=True)
    session = requests.Session()
    session.headers.update({"X-Camera-Key": STREAM_KEY})
    last_seq = 0
    failures = 0
    uploaded = 0
    try:
        while not stop.is_set():
            item = latest.newer(last_seq, timeout=3)
            if item is None:
                continue
            seq, jpeg, ai = item
            last_seq = seq
            try:
                # AI independent of video frame upload; tiny JSON request.
                if ai is not None:
                    ar = session.post(HTTP_BASE + "/camera/ai",json=ai,
                                      timeout=(5, 8))
                    ar.raise_for_status()
                reply = session.post(
                    HTTP_BASE + "/camera/frame", data=jpeg,
                    headers={"Content-Type": "image/jpeg"},
                    timeout=(5, 10))
                reply.raise_for_status()
                failures = 0
                uploaded += 1
                if uploaded % 5 == 1:
                    print(f"HTTPS camera uploaded frame #{uploaded} "
                          f"({len(jpeg)} bytes)", flush=True)
            except requests.RequestException as exc:
                failures += 1
                status = getattr(getattr(exc,"response",None),"status_code",None)
                print(f"HTTPS upload error (HTTP {status}): {exc}", flush=True)
                if status in (401,403):
                    print("Check CAMERA_STREAM_KEY on laptop and Render",flush=True)
                # Reopen TCP/TLS connections when the underlying connection breaks.
                session.close()
                session = requests.Session()
                session.headers.update({"X-Camera-Key": STREAM_KEY})
                if stop.wait(min(5,1+failures)):
                    return
    finally:
        session.close()


def websocket_sender(latest, stop):
    """Legacy backup sender, enabled by CAMERA_TRANSPORT=websocket."""
    while not stop.is_set():
        ws=None
        try:
            ws=websocket.create_connection(RELAY_URL,timeout=12,
                        header=["X-Camera-Key: "+STREAM_KEY],enable_multithread=True)
            ws.settimeout(8)
            print("WebSocket connected:",RELAY_URL,flush=True)
            with latest.cv:
                last_seq=latest.seq
            while not stop.is_set():
                item=latest.newer(last_seq,timeout=3)
                if item is None:
                    continue
                seq,jpeg,ai=item
                last_seq=seq
                if ai is not None:
                    ws.send(json.dumps(ai,separators=(",",":")),
                            opcode=websocket.ABNF.OPCODE_TEXT)
                ws.send(jpeg,opcode=websocket.ABNF.OPCODE_BINARY)
        except Exception as exc:
            print("WebSocket upload error:",exc,flush=True)
            if stop.wait(3):
                return
        finally:
            if ws is not None:
                try:
                    ws.close(timeout=1)
                except Exception:
                    pass


def run():
    if not STREAM_KEY:
        raise SystemExit("Set CAMERA_STREAM_KEY first; do not put it in public code.")
    if AI_ENGINE not in ("opencv","yolo"):
        raise SystemExit("CAMERA_AI_ENGINE must be opencv or yolo")
    if CAMERA_SOURCE not in ("mjpeg","snapshot"):
        raise SystemExit("CAMERA_SOURCE must be mjpeg or snapshot")
    if TRANSPORT not in ("http","websocket"):
        raise SystemExit("CAMERA_TRANSPORT must be http or websocket")
    print(f"FloodGuard relay v2: {TRANSPORT} upload, independent AI",flush=True)
    latest=LatestFrame()
    stop=threading.Event()
    camera_thread=threading.Thread(target=capture_worker,args=(latest,stop),daemon=True)
    camera_thread.start()
    node_thread=threading.Thread(target=node1_ai_sender,args=(latest,stop),daemon=True)
    node_thread.start()
    try:
        if TRANSPORT=="http":
            http_sender(latest,stop)
        else:
            websocket_sender(latest,stop)
    except KeyboardInterrupt:
        print("Stopped.",flush=True)
    finally:
        stop.set()
        camera_thread.join(timeout=2)
        node_thread.join(timeout=2)


if __name__=="__main__":
    run()
