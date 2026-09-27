require("dotenv").config();
const { refreshTideData, getHcmcTideSummary } = require("./tide-service");
const { pool } = require("./db");

(async () => {
    try {
        const result = await refreshTideData({ force: process.argv.includes("--force") });
        console.log(JSON.stringify(result, null, 2));
        const summary = await getHcmcTideSummary();
        console.log(JSON.stringify(summary, null, 2));
    } catch (error) {
        console.error("Tide refresh failed:", error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
