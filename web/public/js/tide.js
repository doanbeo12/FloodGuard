// ============================================================
// TIDE + WEATHER REFERENCE DATA - Dashboard v1.5.1
// Hai nguon nay CHI DE HIEN THI THAM KHAO.
// Early Warning chinh duoc xu ly tu du lieu cam bien o dashboard.js / Central.
// ============================================================

const REF_API_BASE = `${String(window.FLOODGUARD_API_BASE_URL || "http://localhost:3001").replace(/\/$/, "")}/api`;
const REFRESH_UI_MS = 60 * 1000;

function refEl(id) { return document.getElementById(id); }

async function apiGet(path) {
    const response = await fetch(`${REF_API_BASE}${path}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return response.json();
}

async function apiPost(path, body = {}) {
    const response = await fetch(`${REF_API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return response.json();
}

function viDate(value) {
    if (!value) return "--";
    const parts = String(value).slice(0, 10).split("-");
    return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : String(value);
}

function viTime(value) { return value ? String(value).slice(0, 5) : "--"; }

function countdownText(minutes) {
    if (!Number.isFinite(Number(minutes))) return "--";
    const m = Math.max(0, Math.round(Number(minutes)));
    if (m < 60) return `${m} phút`;
    const h = Math.floor(m / 60), rem = m % 60;
    return rem ? `${h} giờ ${rem} phút` : `${h} giờ`;
}

function renderTide(summary) {
    const badge = refEl("tideStatusBadge");
    const notice = refEl("tideFreshnessNotice");
    const source = refEl("tideSourceLink");

    if (!summary?.available) {
        badge.className = "badge bg-secondary";
        badge.textContent = "CHƯA CÓ DỮ LIỆU";
        refEl("tidePeakLevel").textContent = "-- m";
        refEl("tidePeakTime").textContent = "--";
        refEl("tidePeakDate").textContent = "--";
        refEl("tideCountdown").textContent = "--";
        refEl("tideRiskBand").textContent = "--";
        refEl("tideBulletinDate").textContent = "--";
        notice.className = "tide-notice tide-notice-warning mt-3";
        notice.textContent = summary?.message || "Backend chưa tải được bản tin triều TP.HCM.";
        source.classList.add("disabled");
        source.href = "#";
        refEl("tideForecastBody").innerHTML = '<tr><td colspan="3" class="text-muted text-center">Chưa có dữ liệu dự báo.</td></tr>';
        return;
    }

    badge.className = summary.stale ? "badge bg-warning text-dark" : "badge bg-success";
    badge.textContent = summary.stale ? "DỮ LIỆU CŨ" : "TỰ ĐỘNG • MỚI";
    notice.className = `tide-notice ${summary.stale ? "tide-notice-warning" : "tide-notice-success"} mt-3`;
    notice.textContent = summary.message || "--";

    const peak = summary.nextPeak || summary.highestForecast;
    const level = peak?.levelM ?? peak?.peakLevelM;
    refEl("tidePeakLevel").textContent = level == null ? "-- m" : `${Number(level).toFixed(2)} m`;
    refEl("tidePeakTime").textContent = viTime(peak?.time ?? peak?.peakTime);
    refEl("tidePeakDate").textContent = viDate(peak?.date);
    refEl("tideCountdown").textContent = summary.nextPeak ? countdownText(summary.nextPeak.minutesFromNow) : "Ngoài cửa sổ dự báo";
    refEl("tideRiskBand").textContent = summary.riskBand?.label || "--";
    refEl("tideBulletinDate").textContent = viDate(summary.bulletinDate);

    if (summary.sourceUrl) {
        source.classList.remove("disabled");
        source.href = summary.sourceUrl;
    } else {
        source.classList.add("disabled");
        source.href = "#";
    }

    const daily = Array.isArray(summary.daily) ? summary.daily.slice(0, 5) : [];
    refEl("tideForecastBody").innerHTML = daily.length
        ? daily.map(day => `<tr><td>${viDate(day.date)}</td><td><strong>${Number(day.peakLevelM).toFixed(2)} m</strong></td><td>${viTime(day.peakTime)}</td></tr>`).join("")
        : '<tr><td colspan="3" class="text-muted text-center">Không có dữ liệu 5 ngày.</td></tr>';
}

function openWeatherCodeText(code) {
    const c = Number(code);
    if (!Number.isFinite(c)) return "Dữ liệu thời tiết";
    if (c >= 200 && c < 300) return "Dông";
    if (c >= 300 && c < 400) return "Mưa phùn";
    if (c >= 500 && c < 600) return "Mưa";
    if (c >= 600 && c < 700) return "Tuyết";
    if (c >= 700 && c < 800) return "Sương / bụi";
    if (c === 800) return "Trời quang";
    if (c > 800 && c < 900) return "Có mây";
    return "Dữ liệu thời tiết";
}

function viDateTime(value) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit"
    });
}

function renderWeather(data) {
    const badge = refEl("weatherStatusBadge");
    if (!data?.available) {
        badge.className = "badge bg-secondary";
        badge.textContent = "API OFFLINE";
        refEl("weatherTemp").textContent = "-- °C";
        refEl("weatherRainProb").textContent = "-- %";
        refEl("weatherHumidity").textContent = "-- %";
        refEl("weatherPrecip").textContent = "-- mm";
        refEl("weatherForecastRain").textContent = "-- mm";
        refEl("weatherSummary").textContent = data?.message || "Không có dữ liệu";
        refEl("weatherProvider").textContent = data?.provider || "OpenWeather";
        refEl("weatherUpdated").textContent = "--";
        return;
    }

    badge.className = "badge bg-success";
    badge.textContent = "OPENWEATHER";
    refEl("weatherTemp").textContent = data.current?.temperatureC == null ? "-- °C" : `${Number(data.current.temperatureC).toFixed(1)} °C`;
    refEl("weatherRainProb").textContent = data.next3h?.precipitationProbability == null
        ? (data.next3h?.maxPrecipitationProbability == null ? "-- %" : `${Math.round(Number(data.next3h.maxPrecipitationProbability))} %`)
        : `${Math.round(Number(data.next3h.precipitationProbability))} %`;
    refEl("weatherHumidity").textContent = data.current?.humidityPercent == null ? "-- %" : `${Math.round(Number(data.current.humidityPercent))} %`;
    refEl("weatherPrecip").textContent = data.current?.precipitationMm == null ? "-- mm" : `${Number(data.current.precipitationMm).toFixed(1)} mm`;
    refEl("weatherForecastRain").textContent = data.next3h?.totalPrecipitationMm == null ? "-- mm" : `${Number(data.next3h.totalPrecipitationMm).toFixed(1)} mm`;
    refEl("weatherSummary").textContent = data.current?.description || openWeatherCodeText(data.current?.weatherCode);
    refEl("weatherProvider").textContent = data.provider || "OpenWeather";
    refEl("weatherUpdated").textContent = viDateTime(data.current?.time || data.fetchedAt);
}

async function loadReferenceData() {
    const [tideResult, weatherResult] = await Promise.allSettled([
        apiGet("/tide/hcmc"),
        apiGet("/weather/hcmc")
    ]);

    if (tideResult.status === "fulfilled") renderTide(tideResult.value);
    else renderTide({ available: false, message: "Không kết nối được API triều." });

    if (weatherResult.status === "fulfilled") renderWeather(weatherResult.value);
    else renderWeather({ available: false, message: "Không kết nối được API thời tiết." });
}

async function manualRefreshTide() {
    const btn = refEl("refreshTideBtn");
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải';
    try {
        const result = await apiPost("/tide/refresh", { force: true });
        renderTide(result.summary);
    } catch (error) {
        const notice = refEl("tideFreshnessNotice");
        notice.className = "tide-notice tide-notice-warning mt-3";
        notice.textContent = `Không cập nhật được dữ liệu triều: ${error.message}`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = old;
    }
}

refEl("refreshTideBtn")?.addEventListener("click", manualRefreshTide);
loadReferenceData();
setInterval(loadReferenceData, REFRESH_UI_MS);