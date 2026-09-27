// ============================================================
// HISTORY / MYSQL API - Dashboard v1.5.0
// ============================================================

const HISTORY_API = {
    baseUrl: `${String(window.FLOODGUARD_API_BASE_URL || "http://localhost:3001").replace(/\/$/, "")}/api`
};

const historyState = {
    activeTab: "sensors",
    sensors: [],
    events: [],
    devices: [],
    tide: []
};

let historyChart = null;

function historyEl(id) {
    return document.getElementById(id);
}

function toLocalDateInput(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function initHistoryDates() {
    const today = new Date();
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(today.getDate() - 7);
    historyEl("historyFrom").value = toLocalDateInput(sevenDaysAgo);
    historyEl("historyTo").value = toLocalDateInput(today);
}

function formatDateTime(value) {
    if (!value) return "--";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("vi-VN");
}

function dbBoolean(value) {
    return value === true || value === 1 || value === "1" || value === "true";
}

function booleanBadge(value) {
    return value
        ? '<span class="badge bg-success">ONLINE</span>'
        : '<span class="badge bg-danger">OFFLINE</span>';
}

function rainBadge(value) {
    return value
        ? '<span class="badge bg-primary">MƯA</span>'
        : '<span class="badge bg-success">KHÔ</span>';
}

function measurementBadge(value) {
    if (value == null) return '<span class="badge bg-secondary">--</span>';
    return dbBoolean(value)
        ? '<span class="badge bg-success">VALID</span>'
        : '<span class="badge bg-danger">INVALID</span>';
}

function alertBadge(level) {
    if (level == null || level === "") return '<span class="badge bg-secondary">--</span>';
    const n = Number(level);
    if (n >= 4) return `<span class="badge bg-danger">L${n}</span>`;
    if (n >= 2) return `<span class="badge bg-warning text-dark">L${n}</span>`;
    return `<span class="badge bg-success">L${n}</span>`;
}

function scenarioBadge(code) {
    if (!code) return '<span class="badge bg-secondary">--</span>';
    const normalized = String(code).toUpperCase();
    let cls = "bg-secondary";
    if (["NORMAL_DRY", "DRAINAGE_RECOVERY"].includes(normalized)) cls = "bg-success";
    else if (["RAIN_NO_FLOOD", "TRANSIENT_ANOMALY", "DRY_WATER_MONITORING"].includes(normalized)) cls = "bg-info text-dark";
    else if (["FLOOD_LEVEL_3", "SENSOR_FAULT", "NODES_OFFLINE"].includes(normalized)) cls = "bg-danger";
    else cls = "bg-warning text-dark";
    return `<span class="badge ${cls} scenario-history-badge">${normalized}</span>`;
}

function setApiStatus(connected, text) {
    const badge = historyEl("apiStatusBadge");
    const textStatus = historyEl("apiTextStatus");
    badge.className = `badge ${connected ? "bg-success" : "bg-danger"}`;
    badge.textContent = `Database API: ${text}`;
    if (textStatus) {
        textStatus.textContent = text;
        textStatus.className = connected ? "text-success" : "text-danger";
    }
}

function setHistoryNotice(message, type = "info") {
    const notice = historyEl("historyNotice");
    notice.className = `history-notice history-notice-${type}`;
    notice.innerHTML = message;
}

async function apiGet(path, params = {}) {
    const url = new URL(`${HISTORY_API.baseUrl}${path}`);
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    });

    const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body}`);
    }
    return response.json();
}

async function checkApiHealth() {
    try {
        const result = await apiGet("/health");
        const ok = result.database === "connected";
        setApiStatus(ok, ok ? "Connected" : "DB lỗi");
        return ok;
    } catch (error) {
        console.warn("History API unavailable:", error);
        setApiStatus(false, "Offline");
        return false;
    }
}

function currentHistoryFilters() {
    return {
        from: historyEl("historyFrom").value,
        to: historyEl("historyTo").value,
        limit: historyEl("historyLimit").value
    };
}

async function loadSensorHistory() {
    const result = await apiGet("/history/sensors", currentHistoryFilters());
    historyState.sensors = result.data || [];
    renderSensorHistory(historyState.sensors);
}

async function loadEventHistory() {
    const result = await apiGet("/history/events", currentHistoryFilters());
    historyState.events = result.data || [];
    renderEventHistory(historyState.events);
}

async function loadDeviceHistory() {
    const result = await apiGet("/history/devices", currentHistoryFilters());
    historyState.devices = result.data || [];
    renderDeviceHistory(historyState.devices);
}

async function loadTideHistory() {
    const result = await apiGet("/history/tide", currentHistoryFilters());
    historyState.tide = result.data || [];
    renderTideHistory(historyState.tide);
}

async function loadHistory() {
    const btn = historyEl("loadHistoryBtn");
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải';
    setHistoryNotice("Đang đọc dữ liệu từ Database...", "info");

    try {
        if (historyState.activeTab === "sensors") {
            await loadSensorHistory();
            setHistoryNotice(`Đã tải <strong>${historyState.sensors.length}</strong> bản ghi cảm biến.`, "success");
        } else if (historyState.activeTab === "events") {
            await loadEventHistory();
            setHistoryNotice(`Đã tải <strong>${historyState.events.length}</strong> Event Log.`, "success");
        } else if (historyState.activeTab === "devices") {
            await loadDeviceHistory();
            setHistoryNotice(`Đã tải <strong>${historyState.devices.length}</strong> bản ghi trạng thái thiết bị.`, "success");
        } else {
            await loadTideHistory();
            setHistoryNotice(`Đã tải <strong>${historyState.tide.length}</strong> mốc dự báo triều TP.HCM.`, "success");
        }
        setApiStatus(true, "Connected");
    } catch (error) {
        console.error("Load history failed:", error);
        setApiStatus(false, "Offline");
        setHistoryNotice(
            "Không đọc được lịch sử. Kiểm tra <strong>npm start</strong>, MySQL service và cấu hình <strong>backend/.env</strong>.",
            "danger"
        );
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Xem lịch sử';
    }
}

function legacyWater(row, nodeNumber) {
    const waterKey = `node${nodeNumber}_water_level`;
    const distanceKey = `node${nodeNumber}_distance`;
    if (row[waterKey] != null) return Number(row[waterKey]);
    if (row[distanceKey] != null) return Math.max(0, 39 - Number(row[distanceKey]));
    return null;
}

function cm(value) {
    return value == null || !Number.isFinite(Number(value)) ? "--" : `${Number(value).toFixed(1)} cm`;
}

function renderSensorHistory(rows) {
    const body = historyEl("sensorHistoryBody");

    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="13" class="text-center text-muted">Không có dữ liệu trong khoảng thời gian đã chọn.</td></tr>';
    } else {
        body.innerHTML = rows.map(row => {
            const n1Water = legacyWater(row, 1);
            const n2Water = legacyWater(row, 2);
            const maxWater = row.max_water_level != null
                ? Number(row.max_water_level)
                : Math.max(n1Water ?? 0, n2Water ?? 0);
            return `
                <tr>
                    <td>${formatDateTime(row.recorded_at)}</td>
                    <td>${cm(n1Water)}</td>
                    <td>${cm(n2Water)}</td>
                    <td><strong>${cm(maxWater)}</strong></td>
                    <td>${row.rate_cm_min == null ? "--" : `${Number(row.rate_cm_min) >= 0 ? "+" : ""}${Number(row.rate_cm_min).toFixed(2)} cm/min`}</td>
                    <td><code>${row.trend || "--"}</code></td>
                    <td>${row.eta_seconds == null || Number(row.eta_seconds) < 0 ? "--" : `${Math.round(Number(row.eta_seconds))} s`}</td>
                    <td>${dbBoolean(row.early_warning) ? '<span class="badge bg-warning text-dark">EARLY</span>' : '<span class="badge bg-success">NO</span>'}</td>
                    <td>${alertBadge(row.alert_level)}</td>
                    <td>${scenarioBadge(row.scenario)}</td>
                    <td>${rainBadge(dbBoolean(row.raining))}</td>
                    <td>${booleanBadge(dbBoolean(row.node1_online))}</td>
                    <td>${booleanBadge(dbBoolean(row.node2_online))}</td>
                </tr>`;
        }).join("");
    }

    renderHistoryChart(rows);
}

function renderHistoryChart(rows) {
    const chronological = [...rows].reverse();
    const labels = chronological.map(row => formatDateTime(row.recorded_at));
    const node1 = chronological.map(row => legacyWater(row, 1));
    const node2 = chronological.map(row => legacyWater(row, 2));

    if (historyChart) historyChart.destroy();

    historyChart = new Chart(historyEl("historyChart"), {
        type: "line",
        data: {
            labels,
            datasets: [
                {
                    label: "Node 1 - Mực nước",
                    data: node1,
                    borderColor: "#1976d2",
                    backgroundColor: "rgba(25,118,210,.10)",
                    borderWidth: 2,
                    tension: .25,
                    spanGaps: true,
                    pointRadius: labels.length > 100 ? 0 : 2
                },
                {
                    label: "Node 2 - Mực nước",
                    data: node2,
                    borderColor: "#f59e0b",
                    backgroundColor: "rgba(245,158,11,.10)",
                    borderWidth: 2,
                    tension: .25,
                    spanGaps: true,
                    pointRadius: labels.length > 100 ? 0 : 2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { intersect: false, mode: "index" },
            plugins: { legend: { position: "top" } },
            scales: {
                y: { beginAtZero: true, suggestedMax: 20, title: { display: true, text: "Mực nước (cm)" } },
                x: { ticks: { maxTicksLimit: 12 } }
            }
        }
    });
}

function severityBadge(severity) {
    const map = {
        INFO: "bg-primary",
        NORMAL: "bg-success",
        WARNING: "bg-warning text-dark",
        DANGER: "bg-danger",
        ERROR: "bg-danger"
    };
    return map[String(severity || "INFO").toUpperCase()] || "bg-secondary";
}

function renderEventHistory(rows) {
    const body = historyEl("eventHistoryBody");
    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Không có Event Log trong khoảng thời gian đã chọn.</td></tr>';
        return;
    }

    body.innerHTML = rows.map(row => `
        <tr>
            <td>${formatDateTime(row.recorded_at)}</td>
            <td>${row.device || "System"}</td>
            <td><code>${row.event_type || "EVENT"}</code></td>
            <td><span class="badge ${severityBadge(row.severity)}">${row.severity || "INFO"}</span></td>
            <td>${row.message || ""}</td>
        </tr>
    `).join("");
}

function renderDeviceHistory(rows) {
    const body = historyEl("deviceHistoryBody");
    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Không có lịch sử thiết bị trong khoảng thời gian đã chọn.</td></tr>';
        return;
    }

    body.innerHTML = rows.map(row => {
        const online = String(row.status).toUpperCase() === "ONLINE";
        return `
            <tr>
                <td>${formatDateTime(row.recorded_at)}</td>
                <td>${row.device}</td>
                <td>${booleanBadge(online)}</td>
                <td>${row.note || "--"}</td>
            </tr>`;
    }).join("");
}

function renderTideHistory(rows) {
    const body = historyEl("tideHistoryBody");
    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Không có dữ liệu triều trong khoảng thời gian đã chọn.</td></tr>';
        return;
    }

    body.innerHTML = rows.map(row => `
        <tr>
            <td>${formatDateOnly(row.forecast_date)}</td>
            <td><span class="badge ${String(row.event_type).toUpperCase() === "HIGH" ? "bg-primary" : "bg-secondary"}">${String(row.event_type).toUpperCase() === "HIGH" ? "ĐỈNH" : "CHÂN"}</span></td>
            <td><strong>${Number(row.level_m).toFixed(2)} m</strong></td>
            <td>${String(row.event_time || "--").slice(0, 5)}</td>
            <td>${formatDateOnly(row.bulletin_date)}</td>
        </tr>`).join("");
}

function formatDateOnly(value) {
    if (!value) return "--";
    const date = String(value).slice(0, 10);
    const parts = date.split("-");
    return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : date;
}

function switchHistoryTab(tab) {
    historyState.activeTab = tab;
    document.querySelectorAll(".history-tab").forEach(button => {
        button.classList.toggle("active", button.dataset.historyTab === tab);
    });

    const panels = {
        sensors: "historySensorsPanel",
        events: "historyEventsPanel",
        devices: "historyDevicesPanel",
        tide: "historyTidePanel"
    };
    Object.entries(panels).forEach(([key, id]) => historyEl(id).classList.toggle("active", key === tab));
    loadHistory();
}

function csvEscape(value) {
    const text = value == null ? "" : String(value);
    return `"${text.replaceAll('"', '""')}"`;
}

function exportCurrentHistoryCsv() {
    let filename;
    let header;
    let rows;

    if (historyState.activeTab === "sensors") {
        filename = "sensor_history_v1.5.0.csv";
        header = [
            "recorded_at",
            "node1_raw_distance", "node2_raw_distance",
            "node1_distance", "node2_distance",
            "node1_water_level", "node2_water_level", "max_water_level",
            "trend", "rate_cm_min", "next_threshold_cm", "eta_seconds",
            "early_warning", "early_warning_code", "flow_direction",
            "node1_pdr", "node2_pdr",
            "node1_online", "node2_online", "node1_measurement_valid", "node2_measurement_valid",
            "monitoring_degraded", "raining", "alert_level", "scenario"
        ];
        rows = historyState.sensors.map(r => header.map(key => r[key]));
    } else if (historyState.activeTab === "events") {
        filename = "event_history_v1.5.0.csv";
        header = ["recorded_at", "device", "event_type", "severity", "message"];
        rows = historyState.events.map(r => [r.recorded_at, r.device, r.event_type, r.severity, r.message]);
    } else if (historyState.activeTab === "devices") {
        filename = "device_history_v1.5.0.csv";
        header = ["recorded_at", "device", "status", "note"];
        rows = historyState.devices.map(r => [r.recorded_at, r.device, r.status, r.note]);
    } else {
        filename = "tide_history_hcmc_v1.5.0.csv";
        header = ["forecast_date", "event_type", "event_index", "level_m", "event_time", "bulletin_date", "source_url", "fetched_at"];
        rows = historyState.tide.map(r => header.map(key => r[key]));
    }

    if (!rows.length) {
        setHistoryNotice("Chưa có dữ liệu để xuất CSV.", "warning");
        return;
    }

    const csv = [header, ...rows].map(row => row.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    URL.revokeObjectURL(link.href);
    link.remove();
}

historyEl("loadHistoryBtn").addEventListener("click", loadHistory);
historyEl("exportHistoryBtn").addEventListener("click", exportCurrentHistoryCsv);
document.querySelectorAll(".history-tab").forEach(button => {
    button.addEventListener("click", () => switchHistoryTab(button.dataset.historyTab));
});

initHistoryDates();
checkApiHealth();