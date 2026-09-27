const mysql = require("mysql2/promise");
require("dotenv").config();

const config = {
    host: process.env.DB_HOST || process.env.MYSQLHOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
    user: process.env.DB_USER || process.env.MYSQLUSER || "root",
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || "",
    database: process.env.DB_NAME || process.env.MYSQLDATABASE || "flood_monitoring_v151",
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    queueLimit: 0,
    dateStrings: false,
};

// Railway also exposes MYSQL_URL. mysql2 can consume it directly.
const pool = process.env.MYSQL_URL && !process.env.DB_HOST
    ? mysql.createPool({
        uri: process.env.MYSQL_URL,
        waitForConnections: true,
        connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
        queueLimit: 0,
        dateStrings: false,
    })
    : mysql.createPool(config);

async function checkDatabase() {
    const connection = await pool.getConnection();
    try {
        await connection.ping();
        return true;
    } finally {
        connection.release();
    }
}

module.exports = { pool, checkDatabase };
