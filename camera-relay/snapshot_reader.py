"""JPEG snapshot reader for FloodGuard ESP32-S3-CAM (firmware v1.2).

Reads incrementally rather than waiting for a full Content-Length or EOF.
Distinguishes response-header timeout from partial JPEG transfer timeout.
"""
from urllib.request import build_opener, ProxyHandler, Request
from urllib.error import URLError
import socket
import time

import cv2
import numpy as np

# Bypass environment HTTP proxies for private ESP32 address.
_OPENER = build_opener(ProxyHandler({}))
MAX_JPEG = 512 * 1024


def fetch_snapshot(url, timeout=8):
    request = Request(url, headers={
        "Accept": "image/jpeg",
        "Cache-Control": "no-cache",
        "Connection": "close",
        "User-Agent": "FloodGuard-Snapshot/1.1",
    })
    started = time.monotonic()
    try:
        response = _OPENER.open(request, timeout=timeout)
    except (TimeoutError, socket.timeout, URLError) as exc:
        raise TimeoutError(f"Snapshot connection/headers failed for {url}: {exc}") from exc

    with response:
        if response.status != 200:
            raise RuntimeError(f"Camera HTTP status {response.status}")
        content_type = response.headers.get("Content-Type", "").lower()
        if "image/jpeg" not in content_type:
            raise RuntimeError(f"Camera did not return JPEG: {content_type}")

        header = response.headers.get("Content-Length")
        expected = None
        if header is not None:
            try:
                expected = int(header)
            except ValueError as exc:
                raise RuntimeError("Camera invalid Content-Length") from exc
            if not (4 <= expected <= MAX_JPEG):
                raise RuntimeError(f"Camera invalid Content-Length: {expected}")

        body = bytearray()
        while len(body) <= MAX_JPEG:
            if time.monotonic() - started >= timeout:
                raise TimeoutError(
                    f"Snapshot incomplete after {timeout}s: "
                    f"received {len(body)} / {expected or '?'} JPEG bytes"
                )
            remaining = (expected - len(body)) if expected is not None else (MAX_JPEG + 1 - len(body))
            if remaining <= 0:
                break
            try:
                # read1 returns promptly with available bytes, unlike read(n)
                # which may wait for all n bytes.
                chunk = response.read1(min(2048, remaining))
            except (socket.timeout, TimeoutError) as exc:
                raise TimeoutError(
                    f"Snapshot stalled after {len(body)} / {expected or '?'} "
                    f"bytes from {url}"
                ) from exc
            if not chunk:
                break
            body.extend(chunk)
            if len(body) >= 4 and body[-2:] == b"\xff\xd9":
                break
            if expected is None and len(body) >= 4:
                end = body.find(b"\xff\xd9", 2)
                if end >= 0:
                    del body[end + 2:]
                    break

    data = bytes(body)
    if len(data) > MAX_JPEG:
        raise RuntimeError("Snapshot exceeds 512 KB")
    if len(data) < 4 or data[:2] != b"\xff\xd8" or data[-2:] != b"\xff\xd9":
        raise RuntimeError(
            f"Incomplete JPEG: received {len(data)} / {expected or '?'} bytes"
        )
    frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError(f"JPEG decode failed ({len(data)} bytes)")
    return frame


class SnapshotCamera:
    def __init__(self, url, timeout=8):
        self.url = url
        self.timeout = timeout

    def read(self):
        return True, fetch_snapshot(self.url, self.timeout)

    def release(self):
        pass
