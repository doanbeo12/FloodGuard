const mqtt = require("mqtt");
const { pool } = require("./db");
require("dotenv").config();

function safeDb(name) {
  return /^[A-Za-z0-9_]+$/.test(String(name || "")) ? String(name) : "floodguard_v2";
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function int(v) { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : null; }
function bit(v) { return v === true || v === 1 || v === "1" || v === "true" ? 1 : 0; }
function txt(v) { return typeof v === "string" && v.trim() ? v.trim().slice(0, 32) : null; }

const DB = safeDb(process.env.V2_DB_NAME || "floodguard_v2");
const URL = process.env.MQTT_V2_URL || process.env.MQTT_URL || "mqtt://broker.hivemq.com:1883";
const T1 = process.env.MQTT_V2_TOPIC_NODE1 || "floodguard/v2/node1/realtime";
const T2 = process.env.MQTT_V2_TOPIC_NODE2 || "floodguard/v2/node2/realtime";
const TS = process.env.MQTT_V2_TOPIC_STATUS || "floodguard/v2/central/status";
const SAVE_MS = Math.max(1000, Number(process.env.DB_V2_SAMPLE_INTERVAL_MS || 5000));
const FRESH_MS = Math.max(SAVE_MS * 2, Number(process.env.MQTT_V2_FRESHNESS_MS || 30000));
const MM_PER_TIP = Number(process.env.RAIN_MM_PER_TIP || 0);

const state = {
  n1: null, n2: null, last1: null, last2: null, lastTips: null,
  central: "unknown", centralAt: null, lastSave: null, busy: false, timer: null
};

async function saveNode1(s, at) {
  const d = s.data;
  const seq = int(d.seq);
  if (seq != null && seq === state.last1) return false;

  const tips = int(d.rainTipsTotal);
  let tips10s = 0;
  if (tips != null && state.lastTips != null && tips >= state.lastTips) tips10s = tips - state.lastTips;
  const mm10s = MM_PER_TIP > 0 ? tips10s * MM_PER_TIP : null;
  const mmTotal = MM_PER_TIP > 0 && tips != null ? tips * MM_PER_TIP : null;

  const sql = "INSERT INTO " + DB + ".rain_node_readings " +
    "(node_id,seq,node_uptime_ms,temperature_c,humidity_pct,pressure_hpa,dew_point_c,dew_spread_c," +
    "hall_frequency_hz,rotation_hz,wind_rpm,rain_detected,rain_tips_10s,rain_tips_total,rain_mm_10s,rain_total_mm," +
    "distance_cm,water_level_cm,aht_valid,bmp_valid,jsn_valid,mqtt_received_at,recorded_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

  await pool.execute(sql, [
    int(d.nodeId) || 1, seq, int(d.uptimeMs), num(d.temperatureC), num(d.humidityPct), num(d.pressureHpa),
    num(d.dewPointC), num(d.dewSpreadC), num(d.hallFrequencyHz), num(d.rotationHz), num(d.windRpm),
    bit(d.rainDetected), tips10s, tips || 0, mm10s, mmTotal, num(d.distanceCm), num(d.waterLevelCm),
    bit(d.ahtValid), bit(d.bmpValid), bit(d.jsnValid), s.receivedAt, at
  ]);

  state.last1 = seq;
  if (tips != null) state.lastTips = tips;
  return true;
}

async function saveNode2(s, at) {
  const d = s.data;
  const seq = int(d.seq);
  if (seq != null && seq === state.last2) return false;

  const sql = "INSERT INTO " + DB + ".tide_node_readings " +
    "(node_id,seq,node_uptime_ms,distance_cm,tide_level_cm,jsn_valid,pump_in,pump_out,scenario,phase,mqtt_received_at,recorded_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)";

  await pool.execute(sql, [
    int(d.nodeId) || 2, seq, int(d.uptimeMs), num(d.distanceCm), num(d.tideLevelCm), bit(d.jsnValid),
    bit(d.pumpIn), bit(d.pumpOut), txt(d.scenario), txt(d.phase), s.receivedAt, at
  ]);
  state.last2 = seq;
  return true;
}

async function saveLatest() {
  if (state.busy) return;
  state.busy = true;
  try {
    const now = Date.now();
    const at = new Date(now);
    let a = false, b = false;
    if (state.n1 && now - state.n1.receivedAt.getTime() <= FRESH_MS) a = await saveNode1(state.n1, at);
    if (state.n2 && now - state.n2.receivedAt.getTime() <= FRESH_MS) b = await saveNode2(state.n2, at);
    state.lastSave = at;
    if (a || b) console.log("[MQTT v2 -> DB] " + at.toISOString() + " | N1=" + (a ? "saved" : "skip") + " N2=" + (b ? "saved" : "skip"));
  } catch (e) {
    console.error("[MQTT v2 -> DB]", e.message);
  } finally {
    state.busy = false;
  }
}

function startSaver() {
  const delay = SAVE_MS - (Date.now() % SAVE_MS);
  setTimeout(() => {
    saveLatest();
    state.timer = setInterval(saveLatest, SAVE_MS);
  }, delay);
}

function startMqttCollectorV2() {
  const client = mqtt.connect(URL, {
    clientId: "FloodBackendV2_" + Math.random().toString(16).slice(2, 10),
    clean: true, reconnectPeriod: 5000, connectTimeout: 15000
  });

  client.on("connect", () => {
    console.log("[MQTT v2] Connected: " + URL);
    client.subscribe([T1, T2, TS], { qos: 0 }, e => {
      if (e) console.error("[MQTT v2] Subscribe failed:", e.message);
      else console.log("[MQTT v2] Listening Node1 + Node2");
    });
  });

  client.on("message", (topic, payload) => {
    const receivedAt = new Date();
    if (topic === TS) {
      state.central = payload.toString().trim() || "unknown";
      state.centralAt = receivedAt;
      return;
    }
    try {
      const data = JSON.parse(payload.toString());
      if (topic === T1) state.n1 = { data, receivedAt };
      if (topic === T2) state.n2 = { data, receivedAt };
    } catch (e) {
      console.error("[MQTT v2] Invalid JSON:", e.message);
    }
  });

  client.on("error", e => console.error("[MQTT v2]", e.message));
  if (!state.timer) startSaver();
  return client;
}

function getCollectorV2State() {
  return {
    database: DB,
    sampleIntervalMs: SAVE_MS,
    centralStatus: state.central,
    lastCentralStatusAt: state.centralAt,
    node1LastReceivedAt: state.n1 ? state.n1.receivedAt : null,
    node2LastReceivedAt: state.n2 ? state.n2.receivedAt : null,
    lastSaveAt: state.lastSave
  };
}

module.exports = { startMqttCollectorV2, getCollectorV2State };
