"use strict";
const { WebSocketServer, WebSocket } = require("ws");
const crypto = require("crypto");

function attachCameraRelay(server) {
  const sourceKey = process.env.CAMERA_STREAM_KEY || "";
  const MAX_FRAME_BYTES = 180 * 1024;
  const MAX_BUFFER_BYTES = 512 * 1024;
  const STALE_MS = 12000;
  const viewerServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const uplinkServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const viewers = new Set();
  let publisher = null;
  let lastFrameAt = 0;
  let lastFrame = null;
  let lastAi = null;
  let lastAiAt = 0;

  function active() {
    return !!publisher && publisher.readyState === WebSocket.OPEN &&
      Date.now() - lastFrameAt < STALE_MS;
  }
  function notifyViewers(message) {
    for (const viewer of viewers) {
      if (viewer.readyState === WebSocket.OPEN) viewer.send(JSON.stringify(message));
    }
  }

  server.on("upgrade", (req, socket, head) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); }
    catch (_) { socket.destroy(); return; }
    if (url.pathname !== "/camera/view" && url.pathname !== "/camera/uplink") return;
    const isSource = url.pathname === "/camera/uplink";
    if (isSource) {
      const candidate = req.headers["x-camera-key"];
      const expected = Buffer.from(sourceKey);
      const actual = Buffer.from(typeof candidate === "string" ? candidate : "");
      if (!sourceKey || actual.length !== expected.length ||
          !crypto.timingSafeEqual(actual, expected)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const wss = isSource ? uplinkServer : viewerServer;
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });

  uplinkServer.on("connection", ws => {
    if (publisher && publisher.readyState === WebSocket.OPEN) publisher.close(1000, "new publisher");
    publisher = ws;
    lastFrameAt = 0;
    lastFrame = null;
    lastAi = null;
    lastAiAt = 0;
    notifyViewers({ type: "status", online: false });
    notifyViewers({ type: "ai", status: "offline", levelCm: null });
    ws.on("message", (payload, isBinary) => {
      if (publisher !== ws) return;
      if (!isBinary) {
        if (payload.length > 1024) return;
        let msg;
        try { msg = JSON.parse(payload.toString("utf8")); }
        catch (_) { return; }
        if (msg.type !== "ai") return;
        const allowed = new Set(["ok", "uncalibrated", "not_detected", "out_of_range", "low_confidence", "error"]);
        if (!allowed.has(msg.status)) return;
        const valid = msg.status === "ok" && typeof msg.levelCm === "number" &&
          Number.isFinite(msg.levelCm) && msg.levelCm >= 0 && msg.levelCm <= 10 &&
          typeof msg.confidence === "number" && Number.isFinite(msg.confidence) &&
          msg.confidence >= 0 && msg.confidence <= 1;
        const ai = {
          type: "ai", status: valid ? "ok" : (msg.status === "ok" ? "error" : msg.status),
          levelCm: valid ? Math.round(msg.levelCm * 100) / 100 : null,
          confidence: valid ? Math.round(msg.confidence * 100) / 100 : null,
          at: Date.now()
        };
        lastAi = ai;
        lastAiAt = Date.now();
        notifyViewers(ai);
        return;
      }
      if (payload.length < 4 || payload.length > MAX_FRAME_BYTES) return;
      // Basic JPEG markers; malformed frames are discarded.
      if (payload[0] !== 0xFF || payload[1] !== 0xD8 ||
          payload[payload.length - 2] !== 0xFF || payload[payload.length - 1] !== 0xD9) return;
      lastFrame = Buffer.from(payload);
      lastFrameAt = Date.now();
      for (const viewer of viewers) {
        if (viewer.readyState === WebSocket.OPEN && viewer.bufferedAmount < MAX_BUFFER_BYTES) {
          viewer.send(lastFrame, { binary: true });
        }
      }
    });
    ws.on("close", () => {
      if (publisher !== ws) return;
      publisher = null;
      lastFrame = null;
      lastFrameAt = 0;
      lastAi = null;
      lastAiAt = 0;
      notifyViewers({ type: "status", online: false });
      notifyViewers({ type: "ai", status: "offline", levelCm: null });
    });
    ws.on("error", e => console.warn("[CAMERA] uplink:", e.message));
  });

  viewerServer.on("connection", ws => {
    viewers.add(ws);
    ws.send(JSON.stringify({ type: "status", online: active() }));
    if (active() && lastFrame) ws.send(lastFrame, { binary: true });
    if (active() && lastAi && Date.now() - lastAiAt < STALE_MS) ws.send(JSON.stringify(lastAi));
    ws.on("close", () => viewers.delete(ws));
    ws.on("error", () => viewers.delete(ws));
  });

  const watchdog = setInterval(() => {
    if (publisher && !active()) {
      notifyViewers({ type: "status", online: false });
      if (Date.now() - lastFrameAt > 60000) publisher.terminate();
    }
  }, 12000);
  watchdog.unref?.();
  console.log("[CAMERA] websocket relay ready; publisher " + (sourceKey ? "enabled" : "disabled (set CAMERA_STREAM_KEY)"));
}

module.exports = { attachCameraRelay };
