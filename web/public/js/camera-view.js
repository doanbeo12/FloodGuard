(() => {
  "use strict";
  const image = document.getElementById("cameraLiveImage");
  const placeholder = document.getElementById("cameraOfflineText");
  const badge = document.getElementById("cameraLiveBadge");
  const updated = document.getElementById("cameraLastFrame");
  if (!image || !placeholder || !badge || !updated) return;

  const base = String(window.FLOODGUARD_API_BASE_URL || location.origin).replace(/\/$/, "");
  let wsURL;
  try {
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/camera/view";
    url.search = "";
    wsURL = url.toString();
  } catch (_) {
    placeholder.textContent = "Chưa có địa chỉ Backend hợp lệ.";
    return;
  }

  let socket = null;
  let latestURL = null;
  let lastFrameAt = 0;
  let reconnectTimer = null;

  function state(online) {
    badge.textContent = online ? "TRỰC TIẾP" : "Camera ngoại tuyến";
    badge.className = "status-pill " + (online ? "good" : "muted");
    image.style.display = online ? "block" : "none";
    placeholder.style.display = online ? "none" : "block";
    if (!online) updated.textContent = "Chưa có khung hình mới";
  }

  function connect() {
    if (document.hidden) return;
    try {
      socket = new WebSocket(wsURL);
      socket.binaryType = "arraybuffer";
      socket.onmessage = event => {
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "status" && !msg.online) state(false);
          } catch (_) {}
          return;
        }
        const blob = new Blob([event.data], { type: "image/jpeg" });
        const url = URL.createObjectURL(blob);
        // Revoke previous JPEG after the next image loads.
        image.onload = () => {
          if (latestURL && latestURL !== url) URL.revokeObjectURL(latestURL);
          latestURL = url;
        };
        image.src = url;
        lastFrameAt = Date.now();
        updated.textContent = "Cập nhật: " + new Date().toLocaleTimeString("vi-VN", { hour12: false });
        state(true);
        updated.textContent = "Cập nhật: " + new Date().toLocaleTimeString("vi-VN", { hour12: false });
      };
      socket.onerror = () => state(false);
      socket.onclose = () => {
        state(false);
        if (!document.hidden) reconnectTimer = setTimeout(connect, 3000);
      };
    } catch (_) {
      state(false);
      reconnectTimer = setTimeout(connect, 3000);
    }
  }

  setInterval(() => {
    if (lastFrameAt && Date.now() - lastFrameAt > 12000) state(false);
  }, 2000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(reconnectTimer);
      if (socket) socket.close();
    } else if (!socket || socket.readyState === WebSocket.CLOSED) {
      clearTimeout(reconnectTimer);
      connect();
    }
  });
  state(false);
  connect();
})();
