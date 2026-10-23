require("dotenv").config();

const usePostgres =
  String(process.env.DB_DRIVER || "").toLowerCase() === "postgres" ||
  /^postgres(ql)?:\/\//i.test(String(process.env.DATABASE_URL || ""));

if (!usePostgres) {
  module.exports = require("./db");
} else {
  const { Pool } = require("pg");

  const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_CONNECTION_LIMIT || 10),
    ssl: String(process.env.PGSSL || "").toLowerCase() === "true"
      ? { rejectUnauthorized: false }
      : undefined,
  });

  function translate(sql) {
    let index = 0;
    return String(sql)
      .replace(/\?/g, () => "$" + (++index))
      .replace(/`/g, '"');
  }

  async function run(sql, params = []) {
    const result = await pgPool.query(translate(sql), params);
    return [result.rows, result.fields];
  }

  const pool = {
    query: run,
    execute: run,
    getConnection: async () => ({
      ping: async () => { await pgPool.query("SELECT 1"); },
      release: () => {},
    }),
  };

  async function checkDatabase() {
    await pgPool.query("SELECT 1");
    return true;
  }

  module.exports = { pool, checkDatabase, dialect: "postgres", rawPool: pgPool };
}
