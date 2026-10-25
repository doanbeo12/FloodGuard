// FloodGuard v2: isolated, transition-only connectivity audit.
// Does not subscribe to MQTT, write sensor readings or compute forecasts.
const { pool } = require("./db-v2");
const { getCollectorV2State } = require("./mqtt-collector-v2");
const DB = /^[A-Za-z0-9_]+$/.test(process.env.V2_DB_NAME || "") ? process.env.V2_DB_NAME : "floodguard_v2";
const LIMIT_MS = Math.max(10000, Number(process.env.DEVICE_HISTORY_TIMEOUT_MS || 30000));
const CHECK_MS = 5000;
const state = new Map();
let busy = false;
let schema = null;

const pick = (columns, choices) => choices.find(c => columns.includes(c)) || null;
async function discover() {
  const [rows] = await pool.execute(
    "SELECT TABLE_NAME,COLUMN_NAME,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME IN ('system_history','devices')",
    [DB]
  );
  const hist = rows.filter(x => x.TABLE_NAME === "system_history");
  const devices = rows.filter(x => x.TABLE_NAME === "devices");
  const h = hist.map(x => x.COLUMN_NAME);
  const d = devices.map(x => x.COLUMN_NAME);
  const fields = {
    device: pick(h, ["device_id"]),
    kind: pick(h, ["event_type","event","status","event_code","action","event_name"]),
    time: pick(h, ["recorded_at","event_at","created_at","occurred_at","timestamp","event_time"]),
    detail: pick(h, ["description","message","details","note","event_detail"]),
    deviceId: pick(d, ["device_id"]),
    deviceName: pick(d, ["device_code","code","device_name","name"]),
  };
  const optional = new Set(Object.values(fields).filter(Boolean));
  // Fail closed if there are mandatory fields we cannot supply safely.
  const blocked = hist.filter(x => !optional.has(x.COLUMN_NAME) && x.IS_NULLABLE === "NO" &&
    x.COLUMN_DEFAULT == null && !/auto_increment/i.test(x.EXTRA || ""));
  if (!hist.length || !devices.length || !fields.device || !fields.kind ||
      !fields.deviceId || !fields.deviceName || blocked.length) {
    const problem = !hist.length ? "system_history not found" :
      !devices.length ? "devices not found" :
      "unknown required schema fields: " + blocked.map(x => x.COLUMN_NAME).join(",");
    throw new Error("[DEVICE HISTORY] Incompatible schema; writes disabled (" + problem + ")");
  }
  schema = fields;
  console.log("[DEVICE HISTORY] Schema verified; transition-only recording ready");
}

function online(at, now) {
  const t = at && new Date(at).getTime();
  return Number.isFinite(t) && now >= t && now - t <= LIMIT_MS;
}

async function writeTransition(code, next, now) {
  if (!schema) return;
  const s = schema;
  const [rows] = await pool.execute(
    "SELECT `" + s.deviceId + "` AS id FROM " + DB + ".devices WHERE UPPER(`" + s.deviceName + "`)=? LIMIT 1",
    [code]
  );
  if (!rows.length) {
    console.warn("[DEVICE HISTORY] No matching device row:", code);
    return;
  }
  const cols = [s.device, s.kind];
  const vals = [rows[0].id, next ? "ONLINE" : "OFFLINE"];
  if (s.time) { cols.push(s.time); vals.push(new Date(now)); }
  if (s.detail) {
    cols.push(s.detail); vals.push(code + (next ? " connected" : " disconnected"));
  }
  await pool.execute(
    "INSERT INTO " + DB + ".system_history (" + cols.map(x => "`" + x + "`").join(",") +
    ") VALUES (" + cols.map(() => "?").join(",") + ")",
    vals
  );
}

async function tick() {
  if (busy || !schema) return;
  busy = true;
  try {
    const c = getCollectorV2State();
    const now = Date.now();
    const centralText = String(c.centralStatus || "").toLowerCase();
    const centralState = /offline|disconnected|lost/.test(centralText) ? false :
      /online|connected|ready/.test(centralText) ? online(c.lastCentralStatusAt, now) :
      c.lastCentralStatusAt ? online(c.lastCentralStatusAt, now) : null;
    const next = {
      NODE1: c.node1LastReceivedAt ? online(c.node1LastReceivedAt, now) : null,
      NODE2: c.node2LastReceivedAt ? online(c.node2LastReceivedAt, now) : null,
      CENTRAL: centralState
    };
    for (const [code, value] of Object.entries(next)) {
      if (value == null) continue;
      const previous = state.get(code);
      if (previous === value) continue;
      try {
        await writeTransition(code, value, now);
        state.set(code, value);
        console.log("[DEVICE HISTORY] " + code + " " + (value ? "ONLINE" : "OFFLINE"));
      } catch (e) {
        console.error("[DEVICE HISTORY] " + code + ": " + e.message);
      }
    }
  } catch (e) {
    console.error("[DEVICE HISTORY] polling:", e.message);
  } finally { busy = false; }
}

async function startConnectionHistoryV2() {
  try {
    await discover();
    // Initial observation is a state snapshot; record only later transitions.
    const c = getCollectorV2State();
    const now = Date.now();
    if (c.node1LastReceivedAt) state.set("NODE1", online(c.node1LastReceivedAt, now));
    if (c.node2LastReceivedAt) state.set("NODE2", online(c.node2LastReceivedAt, now));
    if (c.lastCentralStatusAt) state.set("CENTRAL", online(c.lastCentralStatusAt, now));
    const t = setInterval(tick, CHECK_MS);
    t.unref?.();
  } catch (e) {
    console.error(e.message);
  }
}
module.exports = { startConnectionHistoryV2 };
