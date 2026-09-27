const { pool } = require("./db");

// Endpoint này chỉ phản ánh kết quả phân tích CẢM BIẾN do Central gửi lên.
// Không kết hợp triều / weather vào quyết định Early Warning hiện tại.
async function getEarlyWarningSummary(siteId = 1) {
    const [rows] = await pool.execute(
        `SELECT recorded_at, site_id, max_water_level, alert_level, scenario,
                trend, rate_cm_min, next_threshold_cm, eta_seconds,
                early_warning, early_warning_code, flow_direction,
                monitoring_degraded
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
            methodology: "Median N=5 + hysteresis + trend/rate + ETA"
        };
    }

    const row = rows[0];
    return {
        available: true,
        siteId: Number(row.site_id),
        source: "ESP32 Central sensor analysis",
        water: {
            currentWaterCm: row.max_water_level == null ? null : Number(row.max_water_level),
            rateCmPerMin: row.rate_cm_min == null ? null : Number(row.rate_cm_min),
            trend: row.trend || "UNKNOWN",
            nextThresholdCm: row.next_threshold_cm == null ? null : Number(row.next_threshold_cm),
            etaSeconds: row.eta_seconds == null || Number(row.eta_seconds) < 0 ? null : Number(row.eta_seconds),
            flowDirection: row.flow_direction || "UNDETERMINED"
        },
        earlyWarning: {
            active: Boolean(row.early_warning),
            code: row.early_warning_code || "NONE",
            monitoringDegraded: Boolean(row.monitoring_degraded)
        },
        alertLevel: row.alert_level == null ? null : Number(row.alert_level),
        scenario: row.scenario || null,
        recordedAt: row.recorded_at,
        methodology: "Sensor-only: Median N=5 -> hysteresis -> trend/rate -> ETA. Tide/weather are reference display only."
    };
}

module.exports = { getEarlyWarningSummary };
