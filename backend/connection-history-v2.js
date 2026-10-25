// Non-invasive online/offline event journal for the existing FloodGuard MQTT v2 collector.
// It reads collector state only: never changes subscriptions, samples, or predictors.
const { pool } = require("./db-v2");
const { getCollectorV2State } = require("./mqtt-collector-v2");
const DB = /^[A-Za-z0-9_]+$/.test(process.env.V2_DB_NAME || "")
  ? process.env.V2_DB_NAME : "floodguard_v2";
const TIMEOUT_MS = Math.max(10000, Number(process.env.DEVICE_HISTORY_TIMEOUT_MS || 30000));
const CHECK_MS = 5000;
const ID = { NODE1: 1, NODE2: 2, CENTRAL: 3 };
const previous = new Map();
let checking = false;

async function checkSchema() {
  const [rows] = await pool.execute(
    "SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS " +
    "WHERE TABLE_SCHEMA=? AND TABLE_NAME IN ('system_history','devices')",
    [DB]
  );
  const cols = name => new Set(rows.filter(r => r.TABLE_NAME === name).map(r => r.COLUMN_NAME));
  const hist = cols("system_history"), devices = cols("devices");
  for (const key of ["device_id", "event_type", "event_source", "event_message", "occurred_at"]) {
    if (!hist.has(key)) throw new Error("Missing system_history." + key);
  }
  if (!devices.has("device_id")) throw new Error("Missing devices.device_id");
  const [present] = await pool.query("SELECT device_id FROM " + DB + ".devices WHERE device_id IN (1,2,3)");
  const found = new Set(present.map(r => Number(r.device_id)));
  for (const id of Object.values(ID)) if (!found.has(id)) throw new Error("Device id missing: " + id);
}

function fresh(timestamp, now) {
  if (!timestamp) return false;
  const at = new Date(timestamp).getTime();
  return Number.isFinite(at) && at <= now + 5000 && now - at <= TIMEOUT_MS;
}
function centralOnline(collector, now) {
  const raw = String(collector.centralStatus || "").trim().toUpperCase();
  if (!collector.lastCentralStatusAt) return null;
  if (/OFFLINE|DISCONNECTED|LOST/.test(raw)) return false;
  if (/ONLINE|CONNECTED|READY/.test(raw)) return fresh(collector.lastCentralStatusAt, now);
  // Unknown payload is not proof that the central device is online.
  return null;
}
function observed(collector, now) {
  return {
    NODE1: collector.node1LastReceivedAt ? fresh(collector.node1LastReceivedAt, now) : null,
    NODE2: collector.node2LastReceivedAt ? fresh(collector.node2LastReceivedAt, now) : null,
    CENTRAL: centralOnline(collector, now)
  };
}
async function writeEvent(code, online, at) {
  const event = online ? "ONLINE" : "OFFLINE";
  const msg = code + (online ? " connected" : " disconnected");
  await pool.execute(
    "INSERT INTO " + DB + ".system_history " +
    "(device_id,run_id,event_type,event_source,event_message,occurred_at) VALUES (?,NULL,?,?,?,?)",
    [ID[code], event, "MQTT_V2_CONNECTION_MONITOR", msg, new Date(at)]
  );
}
async function poll() {
  if (checking) return;
  checking = true;
  try {
    const now = Date.now();
    const states = observed(getCollectorV2State(), now);
    for (const [code, online] of Object.entries(states)) {
      if (online === null) continue;
      if (!previous.has(code)) {
        previous.set(code, online); // Boot snapshot is not an actual transition.
        continue;
      }
      if (previous.get(code) === online) continue;
      try {
        await writeEvent(code, online, now);
        previous.set(code, online); // Update only after confirmed INSERT.
        console.log("[DEVICE HISTORY] " + code + " " + (online ? "ONLINE" : "OFFLINE"));
      } catch (e) {
        console.error("[DEVICE HISTORY] Failed to write " + code + ": " + e.message);
      }
    }
  } catch (e) {
    console.error("[DEVICE HISTORY] Poll failed:", e.message);
  } finally {
    checking = false;
  }
}
async function startConnectionHistoryV2() {
  try {
    await checkSchema();
    console.log("[DEVICE HISTORY] Ready; only transitions are recorded");
    // Preserve the first observed state as baseline, not an invented event.
    const timer = setInterval(() => { void poll(); }, CHECK_MS);
    timer.unref?.();
  } catch (e) {
    console.error("[DEVICE HISTORY] Disabled:", e.message);
  }
}
module.exports = { startConnectionHistoryV2 };
