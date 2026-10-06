require("dotenv").config();

const CONFIRM_SECONDS = Math.max(
    5,
    Number(process.env.OBSTRUCTION_CONFIRM_SECONDS || 30)
);
const CONFIRM_MS = CONFIRM_SECONDS * 1000;
const MIN_HIGH_CM = Number(process.env.OBSTRUCTION_MIN_HIGH_CM || 15);
const MIN_NODE_DIFF_CM = Number(process.env.OBSTRUCTION_MIN_NODE_DIFF_CM || 5);

const states = new Map();

function finiteOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function normalizeScenario(value) {
    return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function candidateFromValues({
    scenario,
    node1WaterLevel,
    node2WaterLevel,
    maxWaterLevel
} = {}) {
    const normalizedScenario = normalizeScenario(scenario);

    if (normalizedScenario === "OBSTRUCTION_SUSPECTED"
        || normalizedScenario === "LOCAL_ANOMALY") {
        return true;
    }

    const n1 = finiteOrNull(node1WaterLevel);
    const n2 = finiteOrNull(node2WaterLevel);
    const max = finiteOrNull(maxWaterLevel);

    return max != null
        && max >= MIN_HIGH_CM
        && n1 != null
        && n2 != null
        && Math.abs(n1 - n2) >= MIN_NODE_DIFF_CM;
}

function observeObstructionCandidate({
    siteId = 1,
    scenario,
    node1WaterLevel,
    node2WaterLevel,
    maxWaterLevel,
    observedAt = Date.now()
} = {}) {
    const key = Number(siteId) || 1;
    const candidate = candidateFromValues({
        scenario,
        node1WaterLevel,
        node2WaterLevel,
        maxWaterLevel
    });

    if (!candidate) {
        states.delete(key);
        return {
            candidate: false,
            confirmed: false,
            elapsed_seconds: 0,
            confirm_seconds: CONFIRM_SECONDS
        };
    }

    const existing = states.get(key);
    const startedAt = existing?.startedAt ?? observedAt;
    const elapsedMs = Math.max(0, observedAt - startedAt);

    const value = {
        startedAt,
        lastSeenAt: observedAt
    };
    states.set(key, value);

    return {
        candidate: true,
        confirmed: elapsedMs >= CONFIRM_MS,
        elapsed_seconds: Math.floor(elapsedMs / 1000),
        confirm_seconds: CONFIRM_SECONDS
    };
}

function getObstructionState(siteId = 1) {
    const key = Number(siteId) || 1;
    const state = states.get(key);

    if (!state) {
        return {
            candidate: false,
            confirmed: false,
            elapsed_seconds: 0,
            confirm_seconds: CONFIRM_SECONDS
        };
    }

    const now = Date.now();

    // Nếu Backend không còn nhận cập nhật candidate quá lâu thì reset.
    if (now - state.lastSeenAt > 15000) {
        states.delete(key);
        return {
            candidate: false,
            confirmed: false,
            elapsed_seconds: 0,
            confirm_seconds: CONFIRM_SECONDS
        };
    }

    const elapsedMs = Math.max(0, now - state.startedAt);

    return {
        candidate: true,
        confirmed: elapsedMs >= CONFIRM_MS,
        elapsed_seconds: Math.floor(elapsedMs / 1000),
        confirm_seconds: CONFIRM_SECONDS
    };
}

module.exports = {
    observeObstructionCandidate,
    getObstructionState,
    candidateFromValues,
    CONFIRM_SECONDS
};
