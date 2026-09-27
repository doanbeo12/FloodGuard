const mysql = require("mysql2/promise");
require("dotenv").config();

async function columnExists(connection, dbName, tableName, columnName) {
    const [rows] = await connection.execute(
        `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
        [dbName, tableName, columnName]
    );
    return rows.length > 0;
}

async function ensureColumn(connection, dbName, tableName, columnName, definition) {
    if (await columnExists(connection, dbName, tableName, columnName)) return;
    await connection.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
    console.log(`[DB] Added column ${tableName}.${columnName}`);
}

async function indexExists(connection, dbName, tableName, indexName) {
    const [rows] = await connection.execute(
        `SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
        [dbName, tableName, indexName]
    );
    return rows.length > 0;
}

async function ensureIndex(connection, dbName, tableName, indexName, columnsSql) {
    if (await indexExists(connection, dbName, tableName, indexName)) return;
    await connection.query(`ALTER TABLE \`${tableName}\` ADD INDEX \`${indexName}\` (${columnsSql})`);
    console.log(`[DB] Added index ${tableName}.${indexName}`);
}

async function foreignKeyExists(connection, dbName, tableName, constraintName) {
    const [rows] = await connection.execute(
        `SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?
           AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'
         LIMIT 1`,
        [dbName, tableName, constraintName]
    );
    return rows.length > 0;
}

async function ensureForeignKey(connection, dbName, tableName, constraintName, sql) {
    if (await foreignKeyExists(connection, dbName, tableName, constraintName)) return;
    await connection.query(sql);
    console.log(`[DB] Added foreign key ${constraintName}`);
}

async function main() {
    const dbName = process.env.DB_NAME || process.env.MYSQLDATABASE || "flood_monitoring_v151";
    if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error("DB_NAME chỉ được chứa chữ, số và dấu gạch dưới.");

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || process.env.MYSQLHOST || "127.0.0.1",
        port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
        user: process.env.DB_USER || process.env.MYSQLUSER || "root",
        password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || "",
        multipleStatements: true
    });

    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.query(`USE \`${dbName}\``);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS monitoring_sites (
            site_id INT NOT NULL AUTO_INCREMENT,
            site_name VARCHAR(100) NOT NULL,
            street_name VARCHAR(150) NULL,
            latitude DECIMAL(10,7) NULL,
            longitude DECIMAL(10,7) NULL,
            description VARCHAR(255) NULL,
            tide_station VARCHAR(50) NULL,
            PRIMARY KEY (site_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        CREATE TABLE IF NOT EXISTS sensor_readings (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            node1_distance DECIMAL(8,2) NULL,
            node2_distance DECIMAL(8,2) NULL,
            node1_raw_distance DECIMAL(8,2) NULL,
            node2_raw_distance DECIMAL(8,2) NULL,
            node1_water_level DECIMAL(8,2) NULL,
            node2_water_level DECIMAL(8,2) NULL,
            max_water_level DECIMAL(8,2) NULL,
            node1_online BOOLEAN NOT NULL DEFAULT FALSE,
            node2_online BOOLEAN NOT NULL DEFAULT FALSE,
            node1_measurement_valid BOOLEAN NULL,
            node2_measurement_valid BOOLEAN NULL,
            monitoring_degraded BOOLEAN NULL,
            raining BOOLEAN NOT NULL DEFAULT FALSE,
            alert_level TINYINT UNSIGNED NULL,
            scenario VARCHAR(64) NULL,
            trend VARCHAR(24) NULL,
            rate_cm_min DECIMAL(10,3) NULL,
            next_threshold_cm DECIMAL(8,2) NULL,
            eta_seconds INT NULL,
            early_warning BOOLEAN NOT NULL DEFAULT FALSE,
            early_warning_code VARCHAR(32) NULL,
            flow_direction VARCHAR(32) NULL,
            node1_pdr DECIMAL(6,2) NULL,
            node2_pdr DECIMAL(6,2) NULL,
            site_id INT NOT NULL DEFAULT 1,
            PRIMARY KEY (id),
            INDEX idx_sensor_recorded_at (recorded_at),
            INDEX idx_sensor_scenario (scenario),
            INDEX idx_sensor_site (site_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        CREATE TABLE IF NOT EXISTS device_status_history (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            device VARCHAR(32) NOT NULL,
            status VARCHAR(16) NOT NULL,
            note VARCHAR(255) NULL,
            PRIMARY KEY (id),
            INDEX idx_device_recorded_at (recorded_at),
            INDEX idx_device_name (device)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        CREATE TABLE IF NOT EXISTS event_logs (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            device VARCHAR(32) NOT NULL DEFAULT 'System',
            event_type VARCHAR(64) NOT NULL,
            severity VARCHAR(16) NOT NULL DEFAULT 'INFO',
            message VARCHAR(500) NOT NULL,
            PRIMARY KEY (id),
            INDEX idx_event_recorded_at (recorded_at),
            INDEX idx_event_type (event_type),
            INDEX idx_event_severity (severity)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        CREATE TABLE IF NOT EXISTS tide_bulletins (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            bulletin_date DATE NULL,
            source_url VARCHAR(1000) NOT NULL,
            fetched_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            parse_status VARCHAR(16) NOT NULL DEFAULT 'OK',
            parse_message VARCHAR(500) NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_tide_source_url (source_url(255)),
            INDEX idx_tide_bulletin_date (bulletin_date),
            INDEX idx_tide_parse_status (parse_status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        CREATE TABLE IF NOT EXISTS tide_forecasts (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            bulletin_id BIGINT UNSIGNED NOT NULL,
            station VARCHAR(32) NOT NULL,
            forecast_date DATE NOT NULL,
            event_type VARCHAR(8) NOT NULL,
            event_index TINYINT UNSIGNED NOT NULL,
            level_m DECIMAL(6,2) NOT NULL,
            event_time TIME NOT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_tide_event (bulletin_id, station, forecast_date, event_type, event_index),
            INDEX idx_tide_forecast_date (forecast_date),
            CONSTRAINT fk_tide_forecast_bulletin FOREIGN KEY (bulletin_id)
                REFERENCES tide_bulletins(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Seed 3 địa điểm. Chỉ Đường số 1 có dữ liệu thật ở giai đoạn hiện tại.
    await connection.query(`
        INSERT INTO monitoring_sites
            (site_id, site_name, street_name, latitude, longitude, description, tide_station)
        VALUES
            (1, 'Đường số 1', 'Đường số 1', NULL, NULL, 'Điểm giám sát thực nghiệm - gồm Node 1 và Node 2', 'THU_DAU_MOT'),
            (2, 'Đường số 2', 'Đường số 2', NULL, NULL, 'Chưa triển khai cảm biến', NULL),
            (3, 'Đường số 3', 'Đường số 3', NULL, NULL, 'Chưa triển khai cảm biến', NULL)
        ON DUPLICATE KEY UPDATE
            site_name = VALUES(site_name),
            street_name = VALUES(street_name),
            description = VALUES(description),
            tide_station = VALUES(tide_station)
    `);

    // Tương thích khi bảng đã tồn tại: tự bổ sung cột còn thiếu, không xóa dữ liệu.
    await ensureColumn(connection, dbName, "monitoring_sites", "tide_station", "VARCHAR(50) NULL AFTER description");

    // site 1 dùng trạm THU_DAU_MOT theo cấu hình mô hình hiện tại.
    await connection.query("UPDATE monitoring_sites SET tide_station = 'THU_DAU_MOT' WHERE site_id = 1");

    const sensorColumns = [
        ["node1_raw_distance", "DECIMAL(8,2) NULL AFTER node2_distance"],
        ["node2_raw_distance", "DECIMAL(8,2) NULL AFTER node1_raw_distance"],
        ["node1_water_level", "DECIMAL(8,2) NULL AFTER node2_raw_distance"],
        ["node2_water_level", "DECIMAL(8,2) NULL AFTER node1_water_level"],
        ["max_water_level", "DECIMAL(8,2) NULL AFTER node2_water_level"],
        ["node1_measurement_valid", "BOOLEAN NULL AFTER node2_online"],
        ["node2_measurement_valid", "BOOLEAN NULL AFTER node1_measurement_valid"],
        ["monitoring_degraded", "BOOLEAN NULL AFTER node2_measurement_valid"],
        ["alert_level", "TINYINT UNSIGNED NULL AFTER raining"],
        ["scenario", "VARCHAR(64) NULL AFTER alert_level"],
        ["trend", "VARCHAR(24) NULL AFTER scenario"],
        ["rate_cm_min", "DECIMAL(10,3) NULL AFTER trend"],
        ["next_threshold_cm", "DECIMAL(8,2) NULL AFTER rate_cm_min"],
        ["eta_seconds", "INT NULL AFTER next_threshold_cm"],
        ["early_warning", "BOOLEAN NOT NULL DEFAULT FALSE AFTER eta_seconds"],
        ["early_warning_code", "VARCHAR(32) NULL AFTER early_warning"],
        ["flow_direction", "VARCHAR(32) NULL AFTER early_warning_code"],
        ["node1_pdr", "DECIMAL(6,2) NULL AFTER flow_direction"],
        ["node2_pdr", "DECIMAL(6,2) NULL AFTER node1_pdr"],
        ["site_id", "INT NULL AFTER node2_pdr"]
    ];
    for (const [name, definition] of sensorColumns) {
        await ensureColumn(connection, dbName, "sensor_readings", name, definition);
    }

    // Dữ liệu cũ của mô hình hiện tại đều thuộc Đường số 1.
    await connection.query("UPDATE sensor_readings SET site_id = 1 WHERE site_id IS NULL");

    await ensureIndex(connection, dbName, "sensor_readings", "idx_sensor_scenario", "scenario");
    await ensureIndex(connection, dbName, "sensor_readings", "idx_sensor_site", "site_id");
    await ensureForeignKey(
        connection,
        dbName,
        "sensor_readings",
        "fk_sensor_site",
        `ALTER TABLE sensor_readings
         ADD CONSTRAINT fk_sensor_site
         FOREIGN KEY (site_id) REFERENCES monitoring_sites(site_id)`
    );

    console.log(`Database '${dbName}' đã sẵn sàng cho Backend v1.7.0 Multi-Site + Flood Cause.`);
    console.log("Đường số 1 = dữ liệu thật; Đường số 2 và 3 = vị trí mở rộng chưa triển khai.");
    console.log("Dữ liệu cũ được giữ nguyên và được gán site_id = 1 nếu trước đó chưa có site_id.");
    await connection.end();
}

main().catch(error => {
    console.error("DB init failed:", error.message);
    process.exit(1);
});
