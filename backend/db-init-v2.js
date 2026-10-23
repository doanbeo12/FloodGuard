const mysql = require("mysql2/promise");
require("dotenv").config();

function safeName(value, fallback) {
  const name = String(value || fallback || "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error("Tên database không hợp lệ: " + name);
  }
  return name;
}

function connectionOptions() {
  if (process.env.MYSQL_URL && !process.env.DB_HOST) {
    return {
      uri: process.env.MYSQL_URL,
      multipleStatements: true,
    };
  }

  return {
    host: process.env.DB_HOST || process.env.MYSQLHOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
    user: process.env.DB_USER || process.env.MYSQLUSER || "root",
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || "",
    multipleStatements: true,
  };
}

async function main() {
  const dbName = safeName(
    process.env.V2_DB_NAME || process.env.DB_NAME || process.env.MYSQLDATABASE,
    "floodguard_v2"
  );

  const connection = await mysql.createConnection(connectionOptions());

  try {
    const [schemas] = await connection.execute(
      "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ? LIMIT 1",
      [dbName]
    );

    if (!schemas.length) {
      await connection.query(
        "CREATE DATABASE \`" + dbName + "\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
      );
      console.log("[DB v2] Created database " + dbName);
    }

    await connection.query("USE \`" + dbName + "\`");

    await connection.query(`
      CREATE TABLE IF NOT EXISTS rain_node_readings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        node_id TINYINT UNSIGNED NOT NULL DEFAULT 1,
        seq BIGINT UNSIGNED NULL,
        node_uptime_ms BIGINT UNSIGNED NULL,
        temperature_c DOUBLE NULL,
        humidity_pct DOUBLE NULL,
        pressure_hpa DOUBLE NULL,
        dew_point_c DOUBLE NULL,
        dew_spread_c DOUBLE NULL,
        hall_frequency_hz DOUBLE NULL,
        rotation_hz DOUBLE NULL,
        wind_rpm DOUBLE NULL,
        rain_detected BOOLEAN NOT NULL DEFAULT FALSE,
        rain_tips_10s BIGINT UNSIGNED NOT NULL DEFAULT 0,
        rain_tips_total BIGINT UNSIGNED NOT NULL DEFAULT 0,
        rain_mm_10s DOUBLE NULL,
        rain_total_mm DOUBLE NULL,
        distance_cm DOUBLE NULL,
        water_level_cm DOUBLE NULL,
        aht_valid BOOLEAN NOT NULL DEFAULT FALSE,
        bmp_valid BOOLEAN NOT NULL DEFAULT FALSE,
        jsn_valid BOOLEAN NOT NULL DEFAULT FALSE,
        mqtt_received_at DATETIME(3) NULL,
        recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        INDEX idx_rain_recorded_at (recorded_at),
        INDEX idx_rain_seq (seq)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      CREATE TABLE IF NOT EXISTS tide_node_readings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        node_id TINYINT UNSIGNED NOT NULL DEFAULT 2,
        seq BIGINT UNSIGNED NULL,
        node_uptime_ms BIGINT UNSIGNED NULL,
        distance_cm DOUBLE NULL,
        tide_level_cm DOUBLE NULL,
        jsn_valid BOOLEAN NOT NULL DEFAULT FALSE,
        pump_in BOOLEAN NOT NULL DEFAULT FALSE,
        pump_out BOOLEAN NOT NULL DEFAULT FALSE,
        scenario VARCHAR(32) NULL,
        phase VARCHAR(32) NULL,
        mqtt_received_at DATETIME(3) NULL,
        recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        INDEX idx_tide_recorded_at (recorded_at),
        INDEX idx_tide_seq (seq)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    console.log("[DB v2] Ready: " + dbName);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error("[DB v2] Init failed:", error.message);
  process.exit(1);
});
