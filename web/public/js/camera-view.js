(() => {
  "use strict";
  // HTTPS polling transport for unreliable websocket networks.
  // Keep last good image visible during brief outages, but never label it live.
  const image = document.getElementById("cameraLiveImage");
  const placeholder = document.getElementById("cameraOfflineText");
  const badge = document.getElementById("cameraLiveBadge");
  const updated = document.getElementById("cameraLastFrame");
  const aiLevel = document.getElementById("cameraAiLevel");
  const aiStatus = document.getElementById("cameraAiStatus");
  const aiConfidence = document.getElementById("cameraAiConfidence");
  const aiUpdated = document.getElementById("cameraAiUpdated");
  if (!image || !placeholder || !badge || !updated) return;

  const base = String(window.FLOODGUARD_API_BASE_URL || location.origin).replace(/\/$/, "");
  const labels = {
    ok: "Đã nhận diện (thử nghiệm)",
    uncalibrated: "Chưa hiệu chuẩn",
    not_detected: "Không thấy ranh giới nước",
    out_of_range: "Ngoài phạm vi 0–10 cm",
    low_confidence: "Độ tin cậy thấp",
    offline: "AI ngoại tuyến",
    error: "Lỗi đo mực nước"
  };
  const INTERVAL_MS = 2000;
  let currentURL = null;
  let lastFrameAt = 0;
  let lastAiAt = 0;
  let ongoing = false;
  let stopped = false;
  let sequence = 0;

  function cameraState(status) {
    badge.textContent = status === "live" ? "TRỰC TIẾP" :
                        status === "waiting" ? "Đang kết nối lại" : "Camera ngoại tuyến";
    badge.className = "status-pill " + (status === "live" ? "good" : "muted");
    // Preserve the last successfully received image, but mark it stale.
    image.style.display = currentURL ? "block" : "none";
    placeholder.style.display = currentURL ? "none" : "block";
    if (status !== "live" && lastFrameAt) {
      updated.textContent = "Ảnh cuối: " + new Date(lastFrameAt).toLocaleTimeString("vi-VN",
                                  {hour12:false}) + " (chưa có ảnh mới)";
    }
  }

  function showAI(data) {
    if (!aiLevel) return;
    const valid = data?.status === "ok" && typeof data.levelCm === "number" &&
      Number.isFinite(data.levelCm) && data.levelCm >= 0 && data.levelCm <= 10;
    aiLevel.textContent = valid ? data.levelCm.toFixed(1) : "--";
    aiStatus.textContent = labels[data?.status] || "Chưa có dữ liệu AI";
    aiConfidence.textContent = valid && Number.isFinite(data.confidence)
      ? Math.round(data.confidence*100) + "% (ước lượng)" : "--";
    aiUpdated.textContent = valid && data.at ?
      new Date(data.at).toLocaleTimeString("vi-VN",{hour12:false}) : "--";
    lastAiAt = valid ? Date.now() : 0;
  }

  async function fetchTimed(url, opts={}, timeout=6000) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    try {
      return await fetch(url, {...opts, signal: abort.signal, cache:"no-store"});
    } finally {
      clearTimeout(timer);
    }
  }

  async function update() {
    if (ongoing || document.hidden || stopped) return;
    ongoing = true;
    try {
      // Independent status JSON; no database query or image decode required.
      const stateResponse = await fetchTimed(base + "/camera/status", {}, 7000);
      if (!stateResponse.ok) throw Error("Camera API HTTP " + stateResponse.status);
      const state = await stateResponse.json();
      if (state.online && state.seq !== sequence) {
        const response = await fetchTimed(base + "/camera/latest.jpg?t=" + Date.now(), {}, 8000);
        if (!response.ok) throw Error("Image HTTP " + response.status);
        const blob = await response.blob();
        if (!blob.size || !blob.type.includes("jpeg")) throw Error("Invalid JPEG response");
        const url = URL.createObjectURL(blob);
        // Decode before replacing old image so broken JPEG cannot blank the view.
        const testImage = new Image();
        try {
          testImage.src = url;
          await testImage.decode();
        } catch (err) {
          URL.revokeObjectURL(url);
          throw err;
        }
        const old = currentURL;
        currentURL = url;
        image.src = url;
        if (old) URL.revokeObjectURL(old);
        sequence = state.seq;
        lastFrameAt = Date.now();
        updated.textContent = "Cập nhật: " + new Date(lastFrameAt).toLocaleTimeString("vi-VN",{hour12:false});
      }
      if (state.online && currentURL) {
        cameraState("live");
      } else {
        cameraState("waiting");
      }
      showAI(state.ai || {status:"offline"});
    } catch (err) {
      cameraState("waiting");
      if (lastAiAt && Date.now()-lastAiAt>15000) showAI({status:"offline"});
      if (!lastFrameAt) placeholder.textContent =
        "Chưa nhận ảnh từ Backend (" + String(err.message || err) + "). Đang thử lại.";
      console.warn("[FloodGuard camera] retry:", err.message || err);
    } finally {
      ongoing = false;
    }
  }

  cameraState("waiting");
  showAI({status:"offline"});
  setInterval(update, INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) update();
  });
  window.addEventListener("pagehide", () => {
    stopped = true;
    if (currentURL) URL.revokeObjectURL(currentURL);
  });
  update();
})();