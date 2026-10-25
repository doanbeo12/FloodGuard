const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { checkDatabase, rawPool } = require("./db-v2");
const { startMqttCollectorV2 } = require("./mqtt-collector-v2");
const { createV2Router } = require("./api-v2");
const { startJournal } = require("./forecast-journal-v2");

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
      rain_ml_interval DOUBLE PRECISION,
      rain_flow_ml_s DOUBLE PRECISION,
      rain_ml_total DOUBLE PRECISION,
      rain_interval_seconds DOUBLE PRECISION,
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

    ALTER TABLE "${schema}".rain_node_readings
      ADD COLUMN IF NOT EXISTS rain_ml_interval DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS rain_flow_ml_s DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS rain_ml_total DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS rain_interval_seconds DOUBLE PRECISION;

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
    // Single startup audit against real stored samples; never modifies the DB.
    setTimeout(async () => {
      try {
        const { buildTideForecast } = require("./tide-predictor-v2");
        const result = await buildTideForecast({simTimeScale:60});
        console.log("[TIDE FORECAST AUDIT]", JSON.stringify({
          available:result.available, reason:result.reason||null,
          history:result.history||null,
          cycle:result.learned_cycle||null,
          current:result.current||null,
          forecast:(result.forecast||[]).map(x=>({
            h:x.horizon_sim_hours,cm:x.level_cm,model:x.method,
            mae_cm:x.backtest_mae_cm,samples:x.backtest_samples,validated:x.validated
          }))
        }));
      } catch (err) { console.error("[TIDE FORECAST AUDIT]",err.message); }
    }, 15000);
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
    startJournal();
  });
}

start();
