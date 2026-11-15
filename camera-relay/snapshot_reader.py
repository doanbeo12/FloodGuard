"""FloodGuard: request individual JPEG snapshots from ESP32-S3-CAM.

Firmware v1.2 exposes :81/capture. Each GET has a timeout and bounded size.
"""
from urllib.request import build_opener, ProxyHandler, Request
import time
import cv2
import numpy as np

_OPENER = build_opener(ProxyHandler({}))
MAX_JPEG = 512 * 1024


def fetch_snapshot(url, timeout=4):
    req = Request(url, headers={
        "Accept": "image/jpeg",
        "Cache-Control": "no-cache",
        "Connection": "close",
        "User-Agent": "FloodGuard-Snapshot/1.0",
    })
    with _OPENER.open(req, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"Camera HTTP status {response.status}")
        content_type = response.headers.get("Content-Type", "").lower()
        if "image/jpeg" not in content_type:
            raise RuntimeError(f"Camera did not return JPEG: {content_type}")
        length_header = response.headers.get("Content-Length")
        if length_header is not None:
            try:
                content_length = int(length_header)
            except ValueError as exc:
                raise RuntimeError("Invalid camera Content-Length") from exc
            if not (4 <= content_length <= MAX_JPEG):
                raise RuntimeError(f"Invalid snapshot size: {content_length}")
            # Read only the announced JPEG size; never wait for HTTP EOF.
            data = response.read(content_length)
        else:
            # Some ESP32 handlers keep the connection open without Content-Length.
            # Stop at JPEG EOI instead of waiting for EOF or 512 KB.
            buf = bytearray()
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline and len(buf) <= MAX_JPEG:
                chunk = response.read1(min(4096, MAX_JPEG + 1 - len(buf)))
                if not chunk:
                    break
                buf.extend(chunk)
                if len(buf) >= 4:
                    if buf[:2] != b"\xff\xd8":
                        raise RuntimeError("Snapshot missing JPEG start marker")
                    end = buf.find(b"\xff\xd9", 2)
                    if end >= 0:
                        buf = buf[:end + 2]
                        break
            else:
                raise TimeoutError("Camera did not complete JPEG within timeout")
            data = bytes(buf)
    if len(data) > MAX_JPEG:
        raise RuntimeError("Snapshot exceeds 512 KB")
    if len(data) < 4 or data[:2] != b"\xff\xd8" or data[-2:] != b"\xff\xd9":
        raise RuntimeError("Incomplete JPEG snapshot")
    frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError("Cannot decode camera JPEG")
    return frame


class SnapshotCamera:
    def __init__(self, url, timeout=4):
        self.url = url
        self.timeout = timeout

    def read(self):
        return True, fetch_snapshot(self.url, self.timeout)

    def release(self):
        pass
