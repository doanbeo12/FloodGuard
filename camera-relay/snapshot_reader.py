"""FloodGuard: request individual JPEG snapshots from ESP32-S3-CAM.

Firmware v1.2 exposes :81/capture. Each GET has a timeout and bounded size.
"""
from urllib.request import build_opener, ProxyHandler, Request
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
        data = response.read(MAX_JPEG + 1)
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
