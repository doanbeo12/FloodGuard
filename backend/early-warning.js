const { pool } = require("./db");
const { getSiteTideSummary } = require("./tide-service");
const {
    classifyFloodCause,
    getTideHighEvidence,
    isMeasurementAnomalyScenario
} = require("./flood-cause");

const CENTRAL_TIMEOUT_MS = Number(process.env.CENTRAL_TIMEOUT_MS || 20000);

function boolValue(value) {
    return value === true || value === 1 || value === "1" || value === "true";
}

function finiteOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function connectionStatus(recordedAt) {
    if (!recordedAt) return "NOT_DEPLOYED";
    const ageMs = Date.now() - new Date(recordedAt).getTime();
    return ageMs <= CENTRAL_TIMEOUT_MS ? "ONLINE" : "OFFLINE";
}

function sensorWarningLevel(sensor, fresh) {
    if (!fresh) return 0;
    if (isMeasurementAnomalyScenario(sensor.scenario)) return 0;

    const alert = Number(sensor.alert_level || 0);
    let level = 0;

    if (alert >= 4) level = 3;
    else if (alert >= 3) level = 2;
    else if (alert >= 1) level = 1;

    if (boolValue(sensor.early_warning)) {
        level = Math.max(level, 1);
    }

    return level;
}

function severityMeta(level) {
    if (level >= 3) return { code: "DANGER", label: "Nguy cơ rất cao" };
    if (level >= 2) return { code: "WARNING", label: "Nguy cơ cao" };
    if (level >= 1) return { code: "WATCH", label: "Cần theo dõi" };
    return { code: "NORMAL", label: "Bình thường" };
}

function tideDescription(tideEvidence) {
    const level = tideEvidence?.event?.level_m;
    const band = tideEvidence?.riskBand?.label || "Chưa xác định";
    const minutes = tideEvidence?.minutesFromHigh;

    if (level == null) return "Chưa có mức triều hợp lệ.";

    const timing = Number.isFinite(Number(minutes))
        ? (Number(minutes) >= 0
            ? `còn khoảng ${Math.abs(Number(minutes))} phút tới đỉnh`
            : `đã qua đỉnh khoảng ${Math.abs(Number(minutes))} phút`)
        : "không xác định được khoảng cách thời gian tới đỉnh";

    return `Triều HIGH ${Number(level).toFixed(2)} m (${band}), ${timing}.`;
}

function buildCombinedWarning({ sensor = {}, tide = null, connection_status = null } = {}) {
    const status = connection_status || connectionStatus(sensor.recorded_at);
    const fresh = status === "ONLINE";
    const floodCause = classifyFloodCause({ sensor, tide });
    const tideEvidence = getTideHighEvidence(tide);

    const sensorLevel = sensorWarningLevel(sensor, fresh);
    const tideLevel = tideEvidence.active
        ? Number(tideEvidence.riskBand?.severity || 0)
        : 0;

    const raining = fresh && boolValue(sensor.raining);
    const earlyWarning = fresh && boolValue(sensor.early_warning);
    const rateCmMin = fresh ? finiteOrNull(sensor.rate_cm_min) : null;
    const trend = !fresh
        ? "OFFLINE"
        : rateCmMin == null
            ? "UPDATING"
            : rateCmMin >= 0.20
                ? "RISING"
                : rateCmMin <= -0.20
                    ? "FALLING"
                    : "STABLE";
    const rising = trend === "RISING";
    const monitoringDegraded = fresh && boolValue(sensor.monitoring_degraded);
    const measurementUncertain = fresh && isMeasurementAnomalyScenario(sensor.scenario);

    const factors = [];
    if (!fresh) factors.push("CENTRAL_OFFLINE");
    if (floodCause.flooding_detected && fresh) factors.push("FLOOD_DETECTED");
    if (raining) factors.push("RAIN");
    if (rising) factors.push("WATER_RISING");
    if (earlyWarning) factors.push("SENSOR_EARLY_WARNING");
    if (monitoringDegraded) factors.push("MONITORING_DEGRADED");
    if (measurementUncertain) factors.push("MEASUREMENT_RECHECK");
    if (tideEvidence.active) factors.push("TIDE_HIGH");

    let level = Math.max(sensorLevel, tideLevel);
    let code = "NORMAL";
    let label = "Hiện chưa có dấu hiệu ngập";
    let message = "Mực nước và triều chưa tạo điều kiện cảnh báo tổng hợp.";

    if (!fresh) {
        level = Math.max(level, 1);
        code = tideLevel > 0 ? "CENTRAL_OFFLINE_TIDE_RISK" : "CENTRAL_OFFLINE";
        label = tideLevel > 0
            ? "Thiết bị mất kết nối, triều vẫn đang cao"
            : "Thiết bị đang mất kết nối";
        message = tideLevel > 0
            ? `Không có dữ liệu cảm biến realtime. ${tideDescription(tideEvidence)}`
            : "Không có dữ liệu mới từ Central nên không thể đánh giá mực nước hiện tại.";
    } else if (measurementUncertain) {
        level = Math.max(tideLevel, 1);
        code = tideLevel > 0 ? "MEASUREMENT_RECHECK_TIDE" : "MEASUREMENT_RECHECK";
        label = tideLevel > 0
            ? "Đang kiểm tra số đo, đồng thời triều đang cao"
            : "Đang kiểm tra số đo bất thường";
        message = "Số đo cao chưa được xác nhận là mực nước thực tế; hệ thống tiếp tục đối chiếu hai node và xu hướng dâng.";
    } else if (floodCause.flooding_detected) {
        if (floodCause.code === "RAIN_TIDE") {
            code = "FLOOD_RAIN_TIDE";
            label = "Đang ngập, mưa và triều đều có ảnh hưởng";
            message = `Đang ghi nhận ngập, có mưa và triều cao gần đỉnh. ${tideDescription(tideEvidence)}`;
        } else if (floodCause.code === "TIDE") {
            code = "FLOOD_TIDE";
            label = "Đang ngập, khả năng chủ yếu do triều";
            message = `Đang ghi nhận ngập và triều cao gần đỉnh. ${tideDescription(tideEvidence)}`;
        } else if (floodCause.code === "RAIN") {
            code = "FLOOD_RAIN";
            label = "Đang ngập, khả năng chủ yếu do mưa";
            message = "Đang ghi nhận ngập và cảm biến mưa đang hoạt động; mức triều chưa đủ điều kiện đóng góp theo cấu hình.";
        } else {
            code = "FLOOD_LOCAL_DRAINAGE";
            label = "Đang ngập, có thể do nước thoát chậm";
            message = "Không ghi nhận mưa tại cảm biến và triều chưa ở vùng đóng góp; nguyên nhân sơ bộ có thể là thoát nước chậm hoặc ứ đọng cục bộ.";
        }
    } else if (tideLevel > 0 && raining && (rising || earlyWarning)) {
        code = "RAIN_TIDE_EARLY_WARNING";
        label = "Mực nước có nguy cơ tăng do mưa và triều";
        message = `Mực nước chưa xác nhận ngập nhưng đang có tín hiệu tăng/cảnh báo sớm, đồng thời có mưa và triều cao. ${tideDescription(tideEvidence)}`;
    } else if (tideLevel > 0 && (rising || earlyWarning)) {
        code = "TIDE_EARLY_WARNING";
        label = "Mực nước có nguy cơ tăng khi triều đang cao";
        message = `Mực nước đang có xu hướng tăng hoặc cảnh báo sớm và triều đang ở vùng đáng chú ý. ${tideDescription(tideEvidence)}`;
    } else if (tideLevel > 0) {
        code = "TIDE_WATCH";
        label = "Triều sắp cao, nên theo dõi";
        message = `Chưa ghi nhận ngập nhưng triều dự báo đang ở mức cần theo dõi. ${tideDescription(tideEvidence)}`;
    } else if (earlyWarning) {
        code = "SENSOR_EARLY_WARNING";
        label = "Mực nước đang tăng, cần theo dõi";
        message = "Central phát hiện xu hướng mực nước có nguy cơ đạt ngưỡng tiếp theo.";
    } else if (sensorLevel > 0) {
        code = "SENSOR_ALERT";
        label = "Mực nước đang cao, cần theo dõi";
        message = "Mực nước đã đi vào vùng cảnh báo của thuật toán tại Central.";
    }

    const severity = severityMeta(level);

    return {
        active: level > 0,
        level,
        severity: severity.code,
        severity_label: severity.label,
        code,
        label,
        message,
        factors,
        methodology: "Combined warning: sensor alert/trend/ETA + rain + forecast HIGH-tide timing + forecast tide level.",
        note: "Cảnh báo tổng hợp ở Backend bổ sung dữ liệu triều; cảnh báo LED/buzzer tại Central vẫn dựa trên cảm biến để tiếp tục hoạt động khi mất Internet.",
        sensor: {
            fresh,
            connection_status: status,
            alert_level: sensor.alert_level == null ? null : Number(sensor.alert_level),
            early_warning: earlyWarning,
            trend,
            rate_cm_min: rateCmMin,
            monitoring_degraded: monitoringDegraded,
            measurement_uncertain: measurementUncertain,
            raining
        },
        tide: {
            contributing: tideEvidence.active,
            available: tideEvidence.available,
            stale: tideEvidence.stale,
            station: tideEvidence.station,
            level_m: tideEvidence.event?.level_m ?? null,
            risk_band: tideEvidence.riskBand,
            minutes_from_high: tideEvidence.minutesFromHigh,
            within_time_window: tideEvidence.withinWindow,
            level_qualified: tideEvidence.levelQualified,
            min_contribution_level_m: tideEvidence.minLevelM,
            phase: tide?.phase || "UNKNOWN",
            phase_label: tide?.phase_label || "Chưa xác định",
            basis: tideEvidence.basis
        },
        flood_cause: floodCause
    };
}

async function getEarlyWarningSummary(siteId = 1) {
    const [rows] = await pool.execute(
        `SELECT recorded_at, site_id, max_water_level, alert_level, scenario,
                trend, rate_cm_min, next_threshold_cm, eta_seconds,
                early_warning, early_warning_code, flow_direction,
                monitoring_degraded, raining
         FROM sensor_readings
         WHERE site_id = ?
         ORDER BY recorded_at DESC, id DESC
         LIMIT 1`,
        [siteId]
    );

    if (!rows.length) {
        return {
            available: false,
            siteId,
            message: "Chưa có dữ liệu cảm biến cho địa điểm này trong MySQL.",
            methodology: "Median N=5 + hysteresis + trend/rate + ETA + tide-aware backend warning"
        };
    }

    const row = rows[0];
    let tide = null;
    try {
        tide = await getSiteTideSummary(siteId);
    } catch (error) {
        tide = { available: false, stale: true, error: error.message };
    }

    const status = connectionStatus(row.recorded_at);
    const combinedWarning = buildCombinedWarning({
        sensor: row,
        tide,
        connection_status: status
    });

    return {
        available: true,
        siteId: Number(row.site_id),
        source: "ESP32 Central sensor analysis + Backend tide-aware analysis",
        connectionStatus: status,
        water: {
            currentWaterCm: row.max_water_level == null ? null : Number(row.max_water_level),
            rateCmPerMin: row.rate_cm_min == null ? null : Number(row.rate_cm_min),
            trend: row.trend || "UNKNOWN",
            nextThresholdCm: row.next_threshold_cm == null ? null : Number(row.next_threshold_cm),
            etaSeconds: row.eta_seconds == null || Number(row.eta_seconds) < 0 ? null : Number(row.eta_seconds),
            flowDirection: row.flow_direction || "UNDETERMINED"
        },
        sensorEarlyWarning: {
            active: Boolean(row.early_warning),
            code: row.early_warning_code || "NONE",
            monitoringDegraded: Boolean(row.monitoring_degraded)
        },
        combinedWarning,
        tide,
        floodCause: combinedWarning.flood_cause,
        alertLevel: row.alert_level == null ? null : Number(row.alert_level),
        scenario: row.scenario || null,
        recordedAt: row.recorded_at,
        methodology: "Central sensor warning remains independent; Backend combines sensor state with forecast tide level/timing for user-facing warning."
    };
}

module.exports = {
    getEarlyWarningSummary,
    buildCombinedWarning,
    connectionStatus
};
