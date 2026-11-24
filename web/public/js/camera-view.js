(() => {
  "use strict";
  const el = id => document.getElementById(id);
  const image = el("cameraLiveImage"), placeholder = el("cameraOfflineText");
  const badge = el("cameraLiveBadge"), updated = el("cameraLastFrame");
  const aiLevel = el("cameraAiLevel"), aiStatus = el("cameraAiStatus");
  const aiConfidence = el("cameraAiConfidence"), aiUpdated = el("cameraAiUpdated");
  const obstacleStatus = el("cameraObstacleStatus");
  if (!image || !placeholder || !badge || !updated) return;

  const base = String(window.FLOODGUARD_API_BASE_URL || location.origin).replace(/\/$/, "");
  const POLL_MS = 1000;
  const STALE_MS = 15000; // Mirrors backend/camera-http.js
  const labels = {
    ok: "Đã nhận diện (thử nghiệm)",
    uncalibrated: "Chưa hiệu chuẩn",
    not_detected: "Không thấy ranh giới nước",
    out_of_range: "Ngoài phạm vi 0–10 cm",
    low_confidence: "Độ tin cậy thấp",
    offline: "AI ngoại tuyến",
    error: "Lỗi đo mực nước"
  };
  let currentURL = null, lastFrameKey = null, lastFrameAt = 0;
  let working = false, timer = null, stopped = false, forceRefresh = true;

  function cameraState(state) {
    badge.textContent = state === "live" ? "TRỰC TIẾP" :
      state === "retry" ? "Mất kết nối • Đang thử lại" : "Camera ngoại tuyến";
    badge.className = "status-pill " + (state === "live" ? "good" : "muted");
    image.style.display = currentURL ? "block" : "none";
    placeholder.style.display = currentURL ? "none" : "block";
    if (state !== "live" && lastFrameAt) {
      updated.textContent = "Ảnh cuối: " +
        new Date(lastFrameAt).toLocaleTimeString("vi-VN", {hour12:false}) +
        " (không trực tiếp)";
    }
  }

  function showAI(ai) {
    if (!aiLevel) return;
    const fresh = ai && Number.isFinite(Number(ai.at)) &&
      Math.abs(Date.now() - Number(ai.at)) <= STALE_MS;
    const valid = fresh && ai.status === "ok" &&
      typeof ai.levelCm === "number" && Number.isFinite(ai.levelCm) &&
      ai.levelCm >= 0 && ai.levelCm <= 10;
    if (obstacleStatus) {
      const obstacle = fresh && ai.method === "yolo" ? ai.obstacle : "unknown";
      obstacleStatus.textContent = obstacle === "suspected" ? "Có vật cản" : "";
      obstacleStatus.style.color = obstacle === "suspected" ? "#d97706" : "";
      obstacleStatus.style.display = obstacle === "suspected" ? "" : "none";
    }
    aiLevel.textContent = valid ? ai.levelCm.toFixed(1) : "--";
    const method = ai && ai.method === "yolo" ? "YOLO Segmentation" : "OpenCV";
    aiStatus.textContent = fresh ? (method + " • " + (labels[ai.status] || "Chưa có dữ liệu AI")) : labels.offline;
    aiConfidence.textContent = valid && Number.isFinite(ai.confidence) ?
      Math.round(ai.confidence * 100) + "% (ước lượng)" : "--";
    aiUpdated.textContent = valid ? new Date(ai.at).toLocaleTimeString("vi-VN", {hour12:false}) : "--";
  }

  async function fetchTimed(url, timeout) {
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, {signal:controller.signal, cache:"no-store",
        headers:{"Cache-Control":"no-cache"}});
    } finally { clearTimeout(watchdog); }
  }

  function schedule(ms=POLL_MS) {
    if (timer !== null) clearTimeout(timer);
    if (!stopped) timer = setTimeout(update, ms);
  }

  async function showFrame(frameKey, frameAt) {
    const response = await fetchTimed(base + "/camera/latest.jpg?t=" + encodeURIComponent(frameKey), 7000);
    if (!response.ok) throw Error("JPEG HTTP " + response.status);
    const blob = await response.blob();
    if (!blob.size || !blob.type.toLowerCase().includes("jpeg")) throw Error("Invalid JPEG");
    const url = URL.createObjectURL(blob);
    try {
      const decoded = new Image();
      decoded.src = url;
      await decoded.decode();
      image.src = url;
      const previous = currentURL;
      currentURL = url;
      lastFrameKey = frameKey;
      lastFrameAt = frameAt;
      if (previous) URL.revokeObjectURL(previous);
      updated.textContent = "Cập nhật: " +
        new Date(frameAt).toLocaleTimeString("vi-VN", {hour12:false});
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }

  async function update() {
    if (working || stopped) return;
    if (document.hidden) { schedule(1500); return; }
    working = true;
    try {
      const res = await fetchTimed(base + "/camera/status?t=" + Date.now(), 5000);
      if (!res.ok) throw Error("Camera status HTTP " + res.status);
      const data = await res.json();
      const online = data.online === true && Number.isFinite(Number(data.lastFrameAt)) &&
        Date.now() - Number(data.lastFrameAt) < STALE_MS;
      const key = data.seq != null ? String(data.seq) + "-" + String(data.lastFrameAt) :
        String(data.lastFrameAt);
      if (online && (forceRefresh || key !== lastFrameKey || !currentURL)) {
        await showFrame(key, Number(data.lastFrameAt));
        forceRefresh = false;
      }
      cameraState(online && currentURL ? "live" : "offline");
      if (!online && !currentURL) placeholder.textContent = "Camera chưa truyền ảnh lên Backend";
      showAI(data.ai);
    } catch (err) {
      cameraState("retry");
      showAI({status:"offline"});
      if (!currentURL) placeholder.textContent = "Chưa nhận ảnh từ Backend, đang thử lại";
      console.warn("[FloodGuard camera] reconnect:", err);
    } finally {
      working = false;
      schedule();
    }
  }

  function resume() {
    // Browser BFCache restores the page without running scripts again.
    stopped = false;
    forceRefresh = true;
    if (!working) schedule(0);
  }

  window.addEventListener("pageshow", resume);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) resume();
  });
  window.addEventListener("focus", () => { if (!document.hidden) resume(); });
  window.addEventListener("pagehide", () => {
    stopped = true;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    // Keep current image and blob URL for BFCache restores.
  });
  cameraState("offline");
  showAI(null);
  update();
})();