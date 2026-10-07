require("dotenv").config();

const { pool } = require("./db");

function envNumber(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
}

function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function median(values) {
    const sorted = values
        .filter(Number.isFinite)
        .slice()
        .sort((a, b) => a - b);

    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeScenario(value) {
    return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function trustedWaterFromRow(row = {}) {
    const node1 = finiteOrNull(row.node1_water_level ?? row.node1WaterLevel);
    const node2 = finiteOrNull(row.node2_water_level ?? row.node2WaterLevel);
    const max = finiteOrNull(row.max_water_level ?? row.maxWaterLevel);
    const scenario = normalizeScenario(row.scenario);

    if (scenario === "SENSOR_FAULT" || scenario === "NODES_OFFLINE") {
        return null;
    }

    const hardAnomaly = scenario === "OBSTRUCTION_SUSPECTED"
        || scenario === "TRANSIENT_ANOMALY"
        || scenario === "LOCAL_ANOMALY";

    const nodeDifference = node1 != null && node2 != null
        ? Math.abs(node1 - node2)
        : null;

    const largeSingleNodeSpike = max != null
        && max >= envNumber("WATER_TREND_SPIKE_MIN_CM", 15)
        && nodeDifference != null
        && nodeDifference >= envNumber("WATER_TREND_NODE_DIFF_CM", 5);

    // Khi có dấu hiệu vật cản / spike cục bộ, dùng node thấp hơn thay vì max.
    // LEVEL_PENDING không bị loại vì đó có thể là nước thật vừa vượt ngưỡng.
    if ((hardAnomaly || largeSingleNodeSpike) && node1 != null && node2 != null) {
        return Math.min(node1, node2);
    }

    if (max != null) return max;

    const candidates = [node1, node2].filter(value => value != null);
    return candidates.length ? Math.max(...candidates) : null;
}

function medianFilter3(points) {
    if (points.length < 3) return points;

    return points.map((point, index) => {
        const neighborhood = [];
        for (let i = Math.max(0, index - 1); i <= Math.min(points.length - 1, index + 1); i++) {
            neighborhood.push(points[i].waterCm);
        }

        return {
            ...point,
            waterCm: median(neighborhood)
        };
    });
}

function theilSenRate(points) {
    if (points.length < 2) return null;

    const slopes = [];

    for (let i = 0; i < points.length - 1; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const dtMs = points[j].timeMs - points[i].timeMs;
            if (dtMs < 3000) continue;

            const dtMinutes = dtMs / 60000;
            const slope = (points[j].waterCm - points[i].waterCm) / dtMinutes;
            if (Number.isFinite(slope)) slopes.push(slope);
        }
    }

    return median(slopes);
}

function trendFromRate(rateCmMin) {
    if (rateCmMin == null) return "UPDATING";

    const stableBand = Math.max(
        0,
        envNumber("WATER_TREND_STABLE_BAND_CM_MIN", 0.20)
    );

    if (rateCmMin >= stableBand) return "RISING";
    if (rateCmMin <= -stableBand) return "FALLING";
    return "STABLE";
}

async function getReliableWaterTrend(siteId = 1) {
    const windowSeconds = Math.max(
        15,
        Math.round(envNumber("WATER_TREND_WINDOW_SECONDS", 20))
    );
    const minPoints = Math.max(
        4,
        Math.round(envNumber("WATER_TREND_MIN_POINTS", 4))
    );
    const maxAbsRate = Math.max(
        1,
        envNumber("WATER_TREND_MAX_ABS_RATE_CM_MIN", 30)
    );

    const from = new Date(Date.now() - windowSeconds * 1000);

    const [rows] = await pool.execute(
        `SELECT recorded_at,
                node1_water_level, node2_water_level, max_water_level,
                scenario
         FROM sensor_readings
         WHERE site_id = ? AND recorded_at >= ?
         ORDER BY recorded_at ASC, id ASC
         LIMIT 40`,
        [Number(siteId) || 1, from]
    );

    const points = rows
        .map(row => {
            const waterCm = trustedWaterFromRow(row);
            const timeMs = new Date(row.recorded_at).getTime();

            if (waterCm == null || !Number.isFinite(timeMs)) return null;
            return { timeMs, waterCm };
        })
        .filter(Boolean);

    if (points.length < minPoints) {
        return {
            available: false,
            rateCmPerMin: null,
            trend: "UPDATING",
            source: "BACKEND_ROBUST_TREND",
            pointsUsed: points.length,
            windowSeconds
        };
    }

    // Median 3 điểm loại spike rất ngắn (xe/người đi ngang qua),
    // sau đó Theil-Sen lấy median của các slope để ít bị outlier kéo lệch.
    const filtered = medianFilter3(points);
    let rate = theilSenRate(filtered);

    if (rate == null) {
        return {
            available: false,
            rateCmPerMin: null,
            trend: "UPDATING",
            source: "BACKEND_ROBUST_TREND",
            pointsUsed: filtered.length,
            windowSeconds
        };
    }

    rate = Math.max(-maxAbsRate, Math.min(maxAbsRate, rate));

    const stableBand = Math.max(
        0,
        envNumber("WATER_TREND_STABLE_BAND_CM_MIN", 0.20)
    );

    if (Math.abs(rate) < stableBand) rate = 0;

    const firstWaterCm = filtered[0].waterCm;
    const lastWaterCm = filtered[filtered.length - 1].waterCm;
    const netChangeCm = lastWaterCm - firstWaterCm;
    const netChangeThresholdCm = Math.max(
        0.1,
        envNumber("WATER_TREND_NET_CHANGE_THRESHOLD_CM", 0.5)
    );

    return {
        available: true,
        rateCmPerMin: Number(rate.toFixed(3)),
        trend: trendFromRate(rate),
        source: "BACKEND_ROBUST_TREND",
        pointsUsed: filtered.length,
        windowSeconds,
        firstWaterCm: Number(firstWaterCm.toFixed(2)),
        lastWaterCm: Number(lastWaterCm.toFixed(2)),
        netChangeCm: Number(netChangeCm.toFixed(2)),
        fallingConfirmed: netChangeCm <= -netChangeThresholdCm,
        risingConfirmed: netChangeCm >= netChangeThresholdCm
    };
}

module.exports = {
    getReliableWaterTrend,
    trustedWaterFromRow,
    medianFilter3,
    theilSenRate,
    trendFromRate
};
