const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { pool, checkDatabase } = require("./db");
const { startMqttCollector } = require("./mqtt-collector");
const { refreshTideData, getHcmcTideSummary, getSiteTideSummary, startTideScheduler } = require("./tide-service");
const { getEarlyWarningSummary } = require("./early-warning");
const { getHcmcWeather, getHourlyWeather } = require("./weather-service");
const { classifyFloodCause } = require("./flood-cause");

const app = express();
const PORT = Number(process.env.PORT || 3001);
const API_VERSION = "1.7.0-flood-cause";
const CENTRAL_TIMEOUT_MS = Number(process.env.CENTRAL_TIMEOUT_MS || 20000);

app.use(cors());
app.use(express.json());

function clampLimit(value, fallback = 300, max = 2000) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

function clampHours(value, fallback = 6, max = 168) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

function parseSiteId(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseDateBoundary(value, endOfDay = false) {
    if (!value) return null;
    const suffix = endOfDay ? "T23:59:59.999" : "T00:00:00.000";
    const date = new Date(value.length === 10 ? `${value}${suffix}` : value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function buildDateWhere(req, column = "recorded_at") {
    const from = parseDateBoundary(req.query.from, false);
    const to = parseDateBoundary(req.query.to, true);
    const conditions = [];
    const values = [];

    if (from) {
        conditions.push(`${column} >= ?`);
        values.push(from);
    }
    if (to) {
        conditions.push(`${column} <= ?`);
        values.push(to);
    }

    return { sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", values };
}

function appendWhere(where, condition, value) {
    where.sql += where.sql ? ` AND ${condition}` : `WHERE ${condition}`;
    where.values.push(value);
    return where;
}

function numberOrNull(value) {
    return value == null ? null : Number(value);
}

function boolOrFalse(value) {
    return Boolean(value);
}

function connectionStatus(recordedAt) {
    if (!recordedAt) return "NOT_DEPLOYED";
    const ageMs = Date.now() - new Date(recordedAt).getTime();
    return ageMs <= CENTRAL_TIMEOUT_MS ? "ONLINE" : "OFFLINE";
}

function formatSiteSummary(row) {
    const deployed = row.reading_id != null;
    return {
        site_id: row.site_id,
        site_name: row.site_name,
        street_name: row.street_name,
        latitude: numberOrNull(row.latitude),
        longitude: numberOrNull(row.longitude),
        description: row.description,
        tide_station: row.tide_station || null,
        status: deployed ? "ACTIVE" : "NOT_DEPLOYED",
        deployment_status: deployed ? "DEPLOYED" : "NOT_DEPLOYED",
        connection_status: deployed ? connectionStatus(row.recorded_at) : "NOT_DEPLOYED",
        latest: deployed ? {
            recorded_at: row.recorded_at,
            node1_water_level: numberOrNull(row.node1_water_level),
            node2_water_level: numberOrNull(row.node2_water_level),
            max_water_level: numberOrNull(row.max_water_level),
            raining: boolOrFalse(row.raining),
            alert_level: row.alert_level == null ? null : Number(row.alert_level),
            scenario: row.scenario || null,
            trend: row.trend || "UNKNOWN",
            rate_cm_min: numberOrNull(row.rate_cm_min),
            early_warning: boolOrFalse(row.early_warning)
        } : null
    };
}

app.get("/api/health", async (req, res) => {
    try {
        await checkDatabase();
        let tide = null;
        try {
            const summary = await getHcmcTideSummary();
            tide = { available: summary.available, stale: summary.stale, bulletinDate: summary.bulletinDate || null };
        } catch (_) {}
        res.json({ ok: true, database: "connected", version: API_VERSION, tide, time: new Date().toISOString() });
    } catch (error) {
        res.status(503).json({ ok: false, database: "disconnected", error: error.message });
    }
});

// =========================
// MULTI-SITE API FOR FLUTTER
// =========================
app.get("/api/sites", async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT ms.site_id, ms.site_name, ms.street_name, ms.latitude, ms.longitude, ms.description, ms.tide_station,
                    sr.id AS reading_id, sr.recorded_at,
                    sr.node1_water_level, sr.node2_water_level, sr.max_water_level,
                    sr.raining, sr.alert_level, sr.scenario, sr.trend, sr.rate_cm_min, sr.early_warning
             FROM monitoring_sites ms
             LEFT JOIN (
                 SELECT s.*
                 FROM sensor_readings s
                 JOIN (
                     SELECT site_id, MAX(id) AS max_id
                     FROM sensor_readings
                     WHERE site_id IS NOT NULL
                     GROUP BY site_id
                 ) latest ON latest.max_id = s.id
             ) sr ON sr.site_id = ms.site_id
             ORDER BY ms.site_id`
        );

        res.json({ count: rows.length, data: rows.map(formatSiteSummary) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/sites/:id/status", async (req, res) => {
    try {
        const siteId = parseSiteId(req.params.id);
        if (!siteId) return res.status(400).json({ error: "site_id không hợp lệ" });

        const [sites] = await pool.execute(
            `SELECT site_id, site_name, street_name, latitude, longitude, description, tide_station
             FROM monitoring_sites
             WHERE site_id = ?
             LIMIT 1`,
            [siteId]
        );

        if (!sites.length) return res.status(404).json({ error: "Không tìm thấy địa điểm" });

        const [rows] = await pool.execute(
            `SELECT id, recorded_at,
                    node1_distance, node2_distance,
                    node1_water_level, node2_water_level, max_water_level,
                    node1_online, node2_online,
                    node1_measurement_valid, node2_measurement_valid, monitoring_degraded,
                    raining, alert_level, scenario,
                    trend, rate_cm_min, next_threshold_cm, eta_seconds,
                    early_warning, early_warning_code, flow_direction,
                    node1_pdr, node2_pdr
             FROM sensor_readings
             WHERE site_id = ?
             ORDER BY recorded_at DESC, id DESC
             LIMIT 1`,
            [siteId]
        );

        const site = sites[0];
        let tide = null;
        try {
            tide = await getSiteTideSummary(site.site_id, site.tide_station);
        } catch (tideError) {
            tide = {
                available: false,
                station: site.tide_station || null,
                error: tideError.message
            };
        }

        if (!rows.length) {
            return res.json({
                site: {
                    site_id: site.site_id,
                    site_name: site.site_name,
                    street_name: site.street_name,
                    latitude: numberOrNull(site.latitude),
                    longitude: numberOrNull(site.longitude),
                    description: site.description,
                    tide_station: site.tide_station || null
                },
                deployed: false,
                tide,
                flood_cause: null,
                flood_cause_label: "Chưa có dữ liệu cảm biến",
                flood_cause_detail: null,
                status: "NOT_DEPLOYED",
                connection_status: "NOT_DEPLOYED",
                data: null
            });
        }

        const row = rows[0];
        const floodCause = classifyFloodCause({ sensor: row, tide });

        res.json({
            site: {
                site_id: site.site_id,
                site_name: site.site_name,
                street_name: site.street_name,
                latitude: numberOrNull(site.latitude),
                longitude: numberOrNull(site.longitude),
                description: site.description,
                tide_station: site.tide_station || null
            },
            deployed: true,
            tide,
            flood_cause: floodCause.code,
            flood_cause_label: floodCause.label,
            flood_cause_detail: floodCause,
            status: "ACTIVE",
            connection_status: connectionStatus(row.recorded_at),
            data: {
                ...row,
                node1_distance: numberOrNull(row.node1_distance),
                node2_distance: numberOrNull(row.node2_distance),
                node1_water_level: numberOrNull(row.node1_water_level),
                node2_water_level: numberOrNull(row.node2_water_level),
                max_water_level: numberOrNull(row.max_water_level),
                rate_cm_min: numberOrNull(row.rate_cm_min),
                next_threshold_cm: numberOrNull(row.next_threshold_cm),
                eta_seconds: row.eta_seconds == null ? null : Number(row.eta_seconds),
                node1_pdr: numberOrNull(row.node1_pdr),
                node2_pdr: numberOrNull(row.node2_pdr),
                node1_online: boolOrFalse(row.node1_online),
                node2_online: boolOrFalse(row.node2_online),
                node1_measurement_valid: boolOrFalse(row.node1_measurement_valid),
                node2_measurement_valid: boolOrFalse(row.node2_measurement_valid),
                monitoring_degraded: boolOrFalse(row.monitoring_degraded),
                raining: boolOrFalse(row.raining),
                early_warning: boolOrFalse(row.early_warning)
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


app.get("/api/sites/:id/tide", async (req, res) => {
    try {
        const siteId = parseSiteId(req.params.id);
        if (!siteId) return res.status(400).json({ error: "site_id không hợp lệ" });

        const [sites] = await pool.execute(
            `SELECT site_id, site_name, tide_station
             FROM monitoring_sites
             WHERE site_id = ?
             LIMIT 1`,
            [siteId]
        );

        if (!sites.length) return res.status(404).json({ error: "Không tìm thấy địa điểm" });

        const site = sites[0];
        const tide = await getSiteTideSummary(site.site_id, site.tide_station);

        res.json({
            site: {
                site_id: site.site_id,
                site_name: site.site_name,
                tide_station: site.tide_station || null
            },
            tide
        });
    } catch (error) {
        res.status(500).json({ available: false, error: error.message });
    }
});

app.get("/api/sites/:id/history", async (req, res) => {
    try {
        const siteId = parseSiteId(req.params.id);
        if (!siteId) return res.status(400).json({ error: "site_id không hợp lệ" });

        const [sites] = await pool.execute(
            "SELECT site_id, site_name FROM monitoring_sites WHERE site_id = ? LIMIT 1",
            [siteId]
        );
        if (!sites.length) return res.status(404).json({ error: "Không tìm thấy địa điểm" });

        const hours = clampHours(req.query.hours, 6, 168);
        const limit = clampLimit(req.query.limit, 500, 5000);
        const from = new Date(Date.now() - hours * 60 * 60 * 1000);

        const [rows] = await pool.execute(
            `SELECT id, recorded_at, site_id,
                    node1_water_level, node2_water_level, max_water_level,
                    node1_online, node2_online,
                    raining, alert_level, scenario,
                    trend, rate_cm_min, next_threshold_cm, eta_seconds,
                    early_warning, early_warning_code,
                    node1_pdr, node2_pdr
             FROM sensor_readings
             WHERE site_id = ? AND recorded_at >= ?
             ORDER BY recorded_at ASC
             LIMIT ?`,
            [siteId, from, limit]
        );

        res.json({
            site: sites[0],
            hours,
            count: rows.length,
            data: rows
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/history/sensors", async (req, res) => {
    try {
        const limit = clampLimit(req.query.limit);
        const date = buildDateWhere(req);
        const siteId = req.query.site_id == null ? null : parseSiteId(req.query.site_id);
        if (req.query.site_id != null && !siteId) return res.status(400).json({ error: "site_id không hợp lệ" });
        if (siteId) appendWhere(date, "site_id = ?", siteId);

        const [rows] = await pool.query(
            `SELECT id, recorded_at, site_id,
                    node1_distance, node2_distance,
                    node1_raw_distance, node2_raw_distance,
                    node1_water_level, node2_water_level, max_water_level,
                    node1_online, node2_online,
                    node1_measurement_valid, node2_measurement_valid, monitoring_degraded,
                    raining, alert_level, scenario,
                    trend, rate_cm_min, next_threshold_cm, eta_seconds,
                    early_warning, early_warning_code, flow_direction,
                    node1_pdr, node2_pdr
             FROM sensor_readings
             ${date.sql}
             ORDER BY recorded_at DESC
             LIMIT ?`,
            [...date.values, limit]
        );
        res.json({ count: rows.length, data: rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/history/events", async (req, res) => {
    try {
        const limit = clampLimit(req.query.limit);
        const date = buildDateWhere(req);
        const [rows] = await pool.query(
            `SELECT id, recorded_at, device, event_type, severity, message
             FROM event_logs
             ${date.sql}
             ORDER BY recorded_at DESC
             LIMIT ?`,
            [...date.values, limit]
        );
        res.json({ count: rows.length, data: rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/history/devices", async (req, res) => {
    try {
        const limit = clampLimit(req.query.limit);
        const date = buildDateWhere(req);
        const [rows] = await pool.query(
            `SELECT id, recorded_at, device, status, note
             FROM device_status_history
             ${date.sql}
             ORDER BY recorded_at DESC
             LIMIT ?`,
            [...date.values, limit]
        );
        res.json({ count: rows.length, data: rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/history/tide", async (req, res) => {
    try {
        const limit = clampLimit(req.query.limit, 300, 2000);
        const date = buildDateWhere(req, "tf.forecast_date");
        const [rows] = await pool.query(
            `SELECT DATE_FORMAT(tf.forecast_date, '%Y-%m-%d') AS forecast_date,
                    'HIGH' AS event_type,
                    1 AS event_index,
                    MAX(tf.level_m) AS level_m,
                    SUBSTRING_INDEX(GROUP_CONCAT(TIME_FORMAT(tf.event_time, '%H:%i:%s') ORDER BY tf.level_m DESC, tf.event_time ASC SEPARATOR ','), ',', 1) AS event_time,
                    DATE_FORMAT(tb.bulletin_date, '%Y-%m-%d') AS bulletin_date, tb.source_url, tb.fetched_at
             FROM tide_forecasts tf
             JOIN tide_bulletins tb ON tb.id = tf.bulletin_id
             ${date.sql}${date.sql ? ' AND' : ' WHERE'} tf.event_type = 'HIGH'
             GROUP BY tf.bulletin_id, tf.forecast_date, tb.bulletin_date, tb.source_url, tb.fetched_at
             ORDER BY tf.forecast_date DESC, tb.bulletin_date DESC
             LIMIT ?`,
            [...date.values, limit]
        );
        res.json({ count: rows.length, data: rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/tide/hcmc", async (req, res) => {
    try {
        res.json(await getHcmcTideSummary());
    } catch (error) {
        res.status(500).json({ available: false, error: error.message });
    }
});

app.post("/api/tide/refresh", async (req, res) => {
    try {
        const result = await refreshTideData({ force: Boolean(req.body?.force) });
        const summary = await getHcmcTideSummary();
        res.json({ ...result, summary });
    } catch (error) {
        res.status(502).json({ ok: false, error: error.message });
    }
});

app.get("/api/weather/hcmc", async (req, res) => {
    try {
        const weather = await getHcmcWeather();
        res.status(weather.available ? 200 : 502).json(weather);
    } catch (error) {
        res.status(502).json({ available: false, error: error.message });
    }
});

app.get("/api/sites/:id/weather/hourly", async (req, res) => {
    try {
        const siteId = parseSiteId(req.params.id);
        if (!siteId) return res.status(400).json({ error: "site_id không hợp lệ" });

        const hours = Math.min(48, Math.max(1, Number.parseInt(req.query.hours, 10) || 24));

        const [sites] = await pool.execute(
            `SELECT site_id, site_name, street_name, latitude, longitude
             FROM monitoring_sites
             WHERE site_id = ?
             LIMIT 1`,
            [siteId]
        );

        if (!sites.length) return res.status(404).json({ error: "Không tìm thấy địa điểm" });

        const site = sites[0];
        const latitude = numberOrNull(site.latitude) ?? Number(process.env.WEATHER_LAT || 10.7769);
        const longitude = numberOrNull(site.longitude) ?? Number(process.env.WEATHER_LON || 106.7009);

        const weather = await getHourlyWeather({
            lat: latitude,
            lon: longitude,
            hours
        });

        res.json({
            site: {
                site_id: site.site_id,
                site_name: site.site_name,
                street_name: site.street_name,
                latitude,
                longitude
            },
            ...weather
        });
    } catch (error) {
        res.status(500).json({ available: false, error: error.message });
    }
});

app.get("/api/early-warning", async (req, res) => {
    try {
        const siteId = req.query.site_id == null ? 1 : parseSiteId(req.query.site_id);
        if (!siteId) return res.status(400).json({ error: "site_id không hợp lệ" });
        res.json(await getEarlyWarningSummary(siteId));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, async () => {
    console.log(`Flood Monitoring API ${API_VERSION}: http://localhost:${PORT}`);
    try {
        await checkDatabase();
        console.log("[DB] MySQL connected");
    } catch (error) {
        console.error("[DB] MySQL connection failed:", error.message);
        console.error("Chạy: npm run db:init sau khi cấu hình file .env");
    }

    const mqttEnabled = String(process.env.MQTT_ENABLED ?? "true").toLowerCase() !== "false";
    if (mqttEnabled) {
        startMqttCollector();
    } else {
        console.log("[MQTT] Collector disabled by MQTT_ENABLED=false");
    }

    startTideScheduler();
});
