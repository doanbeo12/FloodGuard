"""Bounded HTTP MJPEG reader for ESP32-S3-CAM.

Reads frames directly from HTTP instead of OpenCV/FFmpeg VideoCapture.
Uses JPEG SOI/EOI markers to cope with ESP32 multipart streams and
reconnects on timeout/EOF. It does not fix a camera firmware hard lock.
"""
from urllib.request import Request, urlopen

import cv2
import numpy as np


class MjpegCamera:
    MAX_JPEG_BYTES = 512 * 1024
    MAX_BUFFER_BYTES = 1024 * 1024

    def __init__(self, url, timeout=8):
        request = Request(url, headers={
            "Accept": "multipart/x-mixed-replace",
            "User-Agent": "FloodGuard-Relay/2.0",
            "Connection": "close",
        })
        self.response = urlopen(request, timeout=timeout)
        content_type = self.response.headers.get("Content-Type", "").lower()
        if "multipart/" not in content_type:
            self.release()
            raise RuntimeError("ESP32 did not return multipart MJPEG")
        self.buffer = bytearray()
        self.bad_frames = 0

    def read(self):
        """Return (True, decoded_bgr) or raise on stalled/broken stream."""
        while True:
            start = self.buffer.find(b"\xff\xd8")
            if start >= 0:
                if start:
                    del self.buffer[:start]
                end = self.buffer.find(b"\xff\xd9", 2)
                if end >= 0:
                    jpeg = bytes(self.buffer[:end + 2])
                    del self.buffer[:end + 2]
                    if len(jpeg) <= self.MAX_JPEG_BYTES:
                        frame = cv2.imdecode(
                            np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR
                        )
                        if frame is not None:
                            self.bad_frames = 0
                            return True, frame
                    self.bad_frames += 1
                    if self.bad_frames >= 10:
                        raise RuntimeError("Too many malformed MJPEG frames")
                    continue
                if len(self.buffer) > self.MAX_JPEG_BYTES:
                    self.buffer.clear()
                    self.bad_frames += 1
            else:
                # Keep a final FF in case JPEG SOI crosses a chunk boundary.
                self.buffer = (bytearray(b"\xff")
                               if self.buffer.endswith(b"\xff") else bytearray())
            if self.bad_frames >= 10:
                raise RuntimeError("Too many malformed MJPEG frames")
            chunk = self.response.read1(4096)
            if not chunk:
                raise ConnectionError("ESP32 MJPEG stream ended (EOF)")
            self.buffer.extend(chunk)
            if len(self.buffer) > self.MAX_BUFFER_BYTES:
                self.buffer.clear()
                self.bad_frames += 1

    def release(self):
        response = getattr(self, "response", None)
        self.response = None
        if response is not None:
            response.close()
