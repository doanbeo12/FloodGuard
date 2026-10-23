const { rawPool } = require("./db-v2");
require("dotenv").config();

function safeName(value, fallback) {
  const name = String(value || fallback || "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Tên schema không hợp lệ: " + name);
  return name;
}

async function main() {
  if (!rawPool) throw new Error("DB_DRIVER=postgres và DATABASE_URL là bắt buộc.");

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

  console.log("[DB v2/Postgres] Ready schema: " + schema);
}

main()
  .then(() => rawPool.end())
  .catch(async (error) => {
    console.error("[DB v2/Postgres] Init failed:", error.message);
    try { await rawPool.end(); } catch (_) {}
    process.exit(1);
  });
