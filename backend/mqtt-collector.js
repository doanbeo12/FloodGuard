const mqtt = require("mqtt");
const { pool } = require("./db");
const { observeObstructionCandidate } = require("./obstruction-state");
require("dotenv").config();

const MQTT_URL = "mqtt://broker.hivemq.com:1883"; // TEST: co dinh HiveMQ de khong bi .env cu ghi de
const MQTT_TOPIC = process.env.MQTT_TOPIC || "flood-monitoring/a8f3c2/data";
const DB_SAMPLE_INTERVAL_MS = Number(process.env.DB_SAMPLE_INTERVAL_MS || 5000);
const CENTRAL_TIMEOUT_MS = Number(process.env.CENTRAL_TIMEOUT_MS || 20000);
const DEFAULT_SITE_ID = Number(process.env.DEFAULT_SITE_ID || 1);

const collectorState = {
    lastMessageAt: 0,
    lastSensorSavedAt: 0,
    centralOnline: null,
    node1Online: null,
    node2Online: null,
    raining: null,
    scenario: null,
    alertLevel: null,
    earlyWarning: null,
    earlyWarningCode: null
};

const SCENARIO_INFO = {
    WAITING: ["INFO", "Đang chờ đủ dữ liệu để phân tích"],
    NORMAL_DRY: ["NORMAL", "Trạng thái bình thường"],
    RAIN_NO_FLOOD: ["INFO", "Có mưa nhưng mực nước vẫn dưới ngưỡng cảnh báo"],
    EARLY_WARNING: ["WARNING", "Cảnh báo sớm từ xu hướng mực nước và ETA"],
    FLOOD_LEVEL_1: ["WARNING", "Cảnh báo mức 1: mực nước đạt khoảng 3 cm"],
    FLOOD_LEVEL_1_RISK_2: ["WARNING", "Mức 1, nguy cơ mức 2: mực nước đạt từ 7 cm"],
    FLOOD_LEVEL_2: ["WARNING", "Cảnh báo mức 2: mực nước đạt từ 10 cm"],
    FLOOD_LEVEL_3: ["DANGER", "Cảnh báo mức 3: mực nước đạt từ 15 cm"],
    NODE_DEGRADED: ["WARNING", "Một Node offline hoặc phép đo không hợp lệ"],
    SENSOR_FAULT: ["DANGER", "Không còn phép đo mực nước hợp lệ"],
    NODES_OFFLINE: ["DANGER", "Cả hai Node mất kết nối"]
};

function validNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function boolValue(value) {
    return value === true || value === 1 || value === "1" || value === "true";
}

function normalizeCode(value, fallback = null) {
    if (typeof value !== "string") return fallback;
    const code = value.trim().toUpperCase();
    if (!code || !/^[A-Z0-9_]{1,64}$/.test(code)) return fallback;
    return code;
}

async function insertDeviceStatus(device, online, note = null) {
    await pool.execute(
        "INSERT INTO device_status_history (device, status, note) VALUES (?, ?, ?)",
        [device, online ? "ONLINE" : "OFFLINE", note]
    );
}

async function insertEvent(device, eventType, severity, message) {
    await pool.execute(
        "INSERT INTO event_logs (device, event_type, severity, message) VALUES (?, ?, ?, ?)",
        [device, eventType, severity, message]
    );
}

async function setCentralOnline(online) {
    if (collectorState.centralOnline === online) return;
    collectorState.centralOnline = online;
    await insertDeviceStatus("Central", online, online ? "Nhận MQTT từ Central" : "Central MQTT timeout");
    await insertEvent(
        "Central",
        online ? "CENTRAL_ONLINE" : "CENTRAL_OFFLINE",
        online ? "NORMAL" : "DANGER",
        online ? "ESP32 Central có dữ liệu" : "Mất dữ liệu từ ESP32 Central"
    );
}

async function trackNodeStatus(device, key, online) {
    if (collectorState[key] === online) return;
    collectorState[key] = online;
    await insertDeviceStatus(device, online, online ? "Đang gửi ESP-NOW" : "Central báo Node timeout");
    await insertEvent(device, online ? "NODE_ONLINE" : "NODE_OFFLINE", online ? "NORMAL" : "WARNING", `${device} ${online ? "đã kết nối" : "mất kết nối"}`);
}

async function trackRain(raining) {
    if (collectorState.raining === raining) return;
    collectorState.raining = raining;
    await insertEvent("Central", raining ? "RAIN_START" : "RAIN_STOP", raining ? "INFO" : "NORMAL", raining ? "Cảm biến mưa phát hiện mưa" : "Cảm biến mưa trở về khô");
}

async function trackScenario(scenario) {
    if (!scenario || collectorState.scenario === scenario) return;
    collectorState.scenario = scenario;
    const [severity, message] = SCENARIO_INFO[scenario] || ["INFO", `Central chuyển scenario ${scenario}`];
    await insertEvent("Analysis", scenario, severity, message);
}

async function trackAlertLevel(level) {
    if (level == null || collectorState.alertLevel === level) return;
    const old = collectorState.alertLevel;
    collectorState.alertLevel = level;
    const severity = level >= 4 ? "DANGER" : level >= 2 ? "WARNING" : level === 0 ? "NORMAL" : "INFO";
    await insertEvent("Analysis", "ALERT_LEVEL_CHANGE", severity, `Mức cảnh báo ${old == null ? "khởi tạo" : `từ ${old}`} -> ${level}`);
}

async function trackEarlyWarning(data) {
    const active = boolValue(data.earlyWarning);
    const code = normalizeCode(data.earlyWarningCode, "NONE");
    if (collectorState.earlyWarning === active && collectorState.earlyWarningCode === code) return;

    collectorState.earlyWarning = active;
    collectorState.earlyWarningCode = code;

    const rate = validNumber(data.rateCmPerMin);
    const threshold = validNumber(data.nextThresholdCm);
    const eta = validNumber(data.etaSeconds);

    if (active) {
        await insertEvent(
            "Analysis",
            code || "EARLY_WARNING",
            "WARNING",
            `Cảnh báo sớm: rate=${rate == null ? "--" : rate.toFixed(2)} cm/phút, ngưỡng=${threshold ?? "--"} cm, ETA=${eta ?? "--"} s`
        );
    } else {
        await insertEvent("Analysis", "EARLY_WARNING_CLEAR", "NORMAL", "Cảnh báo sớm đã kết thúc / không còn đủ điều kiện");
    }
}

async function saveSensorReading(data) {
    const now = Date.now();
    if (now - collectorState.lastSensorSavedAt < DB_SAMPLE_INTERVAL_MS) return;
    collectorState.lastSensorSavedAt = now;

    const alertRaw = Number(data.alertLevel);
    const alertLevel = Number.isInteger(alertRaw) && alertRaw >= 0 && alertRaw <= 4 ? alertRaw : null;
    const scenario = normalizeCode(data.scenario);

    await pool.execute(
        `INSERT INTO sensor_readings
         (site_id,
          node1_distance, node2_distance, node1_raw_distance, node2_raw_distance,
          node1_water_level, node2_water_level, max_water_level,
          node1_online, node2_online,
          node1_measurement_valid, node2_measurement_valid, monitoring_degraded,
          raining, alert_level, scenario,
          trend, rate_cm_min, next_threshold_cm, eta_seconds,
          early_warning, early_warning_code, flow_direction,
          node1_pdr, node2_pdr)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            DEFAULT_SITE_ID,
            validNumber(data.node1Distance),
            validNumber(data.node2Distance),
            validNumber(data.node1RawDistance),
            validNumber(data.node2RawDistance),
            validNumber(data.node1WaterLevel),
            validNumber(data.node2WaterLevel),
            validNumber(data.maxWaterLevel),
            boolValue(data.node1Online),
            boolValue(data.node2Online),
            boolValue(data.node1MeasurementValid),
            boolValue(data.node2MeasurementValid),
            boolValue(data.monitoringDegraded),
            boolValue(data.raining),
            alertLevel,
            scenario,
            normalizeCode(data.trend, "UNKNOWN"),
            validNumber(data.rateCmPerMin),
            validNumber(data.nextThresholdCm),
            validNumber(data.etaSeconds),
            boolValue(data.earlyWarning),
            normalizeCode(data.earlyWarningCode, "NONE"),
            normalizeCode(data.flowDirection, "UNDETERMINED"),
            validNumber(data.node1Pdr),
            validNumber(data.node2Pdr)
        ]
    );
}

function startMqttCollector() {
    const client = mqtt.connect(MQTT_URL, {
        clientId: `FloodBackend_${Math.random().toString(16).slice(2, 10)}`,
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: 15000
    });

    client.on("connect", () => {
        console.log(`[MQTT] Connected: ${MQTT_URL}`);
        client.subscribe(MQTT_TOPIC, { qos: 0 }, error => {
            if (error) console.error("[MQTT] Subscribe failed:", error.message);
            else console.log(`[MQTT] Subscribed: ${MQTT_TOPIC}`);
        });
    });

    client.on("message", async (topic, payload) => {
        if (topic !== MQTT_TOPIC) return;
        try {
            const data = JSON.parse(payload.toString());
            collectorState.lastMessageAt = Date.now();

            const scenario = normalizeCode(data.scenario);
            const alertRaw = Number(data.alertLevel);
            const alertLevel = Number.isInteger(alertRaw) && alertRaw >= 0 && alertRaw <= 4 ? alertRaw : null;

            observeObstructionCandidate({
                siteId: DEFAULT_SITE_ID,
                scenario,
                node1WaterLevel: data.node1WaterLevel,
                node2WaterLevel: data.node2WaterLevel,
                maxWaterLevel: data.maxWaterLevel
            });

            await setCentralOnline(true);
            await trackNodeStatus("Node 1", "node1Online", boolValue(data.node1Online));
            await trackNodeStatus("Node 2", "node2Online", boolValue(data.node2Online));
            await trackRain(boolValue(data.raining));
            await trackScenario(scenario);
            await trackAlertLevel(alertLevel);
            await trackEarlyWarning(data);
            await saveSensorReading(data);
        } catch (error) {
            console.error("[MQTT] Invalid payload / DB error:", error.message);
        }
    });

    client.on("error", error => console.error("[MQTT] Error:", error.message));

    setInterval(async () => {
        if (collectorState.lastMessageAt > 0 && Date.now() - collectorState.lastMessageAt > CENTRAL_TIMEOUT_MS) {
            try { await setCentralOnline(false); }
            catch (error) { console.error("[DB] Central timeout log failed:", error.message); }
        }
    }, 2000);

    return client;
}

module.exports = { startMqttCollector };
