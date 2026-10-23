const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { checkDatabase, rawPool } = require("./db-v2");
const { startMqttCollectorV2 } = require("./mqtt-collector-v2");
const { createV2Router } = require("./api-v2");

const app = express();
const PORT = Number(process.env.PORT || 3001);

function safeName(value, fallback) {
  const name = String(value || fallback || "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Tên schema không hợp lệ: " + name);
  return name;
}

async function ensurePostgresSchema() {
  if (!rawPool) return;
  const schema = safeName(process.env.V2_DB_NAME, "floodguard_v2");

  await rawPool.query('CREATE SCHEMA IF NOT EXISTS "' + schema + '"');
  await rawPool.query(`
    CREATE TABLE IF NOT EXISTS "${schema}".rain_node_readings (
      id BIGSERIAL PRIMARY KEY,
      node_id SMALLINT NOT NULL DEFAULT 1,
      seq BIGINT,
      node_uptime_ms BIGINT,
      temperature_c DOUBLE PRECISION,
      humidity_pct DOUBLE PRECISION,
      pressure_hpa DOUBLE PRECISION,
      dew_point_c DOUBLE PRECISION,
      dew_spread_c DOUBLE PRECISION,
      hall_frequency_hz DOUBLE PRECISION,
      rotation_hz DOUBLE PRECISION,
      wind_rpm DOUBLE PRECISION,
      rain_detected SMALLINT NOT NULL DEFAULT 0,
      rain_tips_10s BIGINT NOT NULL DEFAULT 0,
      rain_tips_total BIGINT NOT NULL DEFAULT 0,
      rain_mm_10s DOUBLE PRECISION,
      rain_total_mm DOUBLE PRECISION,
      distance_cm DOUBLE PRECISION,
      water_level_cm DOUBLE PRECISION,
      aht_valid SMALLINT NOT NULL DEFAULT 0,
      bmp_valid SMALLINT NOT NULL DEFAULT 0,
      jsn_valid SMALLINT NOT NULL DEFAULT 0,
      mqtt_received_at TIMESTAMPTZ(3),
      recorded_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_rain_recorded_at
      ON "${schema}".rain_node_readings(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_rain_seq
      ON "${schema}".rain_node_readings(seq);

    CREATE TABLE IF NOT EXISTS "${schema}".tide_node_readings (
      id BIGSERIAL PRIMARY KEY,
      node_id SMALLINT NOT NULL DEFAULT 2,
      seq BIGINT,
      node_uptime_ms BIGINT,
      distance_cm DOUBLE PRECISION,
      tide_level_cm DOUBLE PRECISION,
      jsn_valid SMALLINT NOT NULL DEFAULT 0,
      pump_in SMALLINT NOT NULL DEFAULT 0,
      pump_out SMALLINT NOT NULL DEFAULT 0,
      scenario VARCHAR(32),
      phase VARCHAR(32),
      mqtt_received_at TIMESTAMPTZ(3),
      recorded_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tide_recorded_at
      ON "${schema}".tide_node_readings(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_tide_seq
      ON "${schema}".tide_node_readings(seq);
  `);

  console.log("[DB v2/Postgres] Schema ready: " + schema);
}

app.use(cors());
app.use(express.json());
app.use("/api/v2", createV2Router());

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "FloodGuard Backend v2", api: "/api/v2" });
});

async function start() {
  try {
    await ensurePostgresSchema();
    await checkDatabase();
    console.log("[DB v2] Connected");
  } catch (error) {
    console.error("[DB v2] Startup failed:", error.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log("FloodGuard v2 Render API listening on port " + PORT);

    const mqttEnabled =
      String(process.env.MQTT_V2_ENABLED ?? "true").toLowerCase() !== "false";

    if (mqttEnabled) startMqttCollectorV2();
    else console.log("[MQTT v2] Collector disabled");
  });
}

start();
