require("dotenv").config();

const CLEAR_CONFIRM_SECONDS = Math.max(
    5,
    Number(process.env.FLOOD_CLEAR_CONFIRM_SECONDS || 30)
);
const CLEAR_CONFIRM_MS = CLEAR_CONFIRM_SECONDS * 1000;

const CLEAR_THRESHOLD_CM = Math.max(
    0,
    Number(process.env.FLOOD_CLEAR_THRESHOLD_CM || 3)
);

const states = new Map();

function normalizeCause(value) {
    const code = typeof value === "string" ? value.trim().toUpperCase() : "";
    return ["RAIN", "RAIN_TIDE", "TIDE", "LOCAL_DRAINAGE"].includes(code)
        ? code
        : null;
}

function causeIncludesRain(code) {
    return code === "RAIN" || code === "RAIN_TIDE";
}

function combineWithTide(code, tideActive) {
    if (!code) return null;

    if (causeIncludesRain(code)) {
        return tideActive ? "RAIN_TIDE" : "RAIN";
    }

    if (code === "TIDE") {
        return tideActive ? "TIDE" : "TIDE";
    }

    return code;
}

function updateFloodState({
    siteId = 1,
    fresh = true,
    rawFlooding = false,
    rawCause = null,
    currentWaterCm = null,
    measurementUncertain = false,
    raining = false,
    tideActive = false,
    now = Date.now()
} = {}) {
    const key = Number(siteId) || 1;

    let state = states.get(key) || {
        floodLatched: false,
        lastCause: null,
        rainCauseLatched: false,
        belowSince: null,
        lastUpdatedAt: now
    };

    if (!fresh) {
        return {
            ...state,
            effectiveFlooding: state.floodLatched,
            effectiveCause: combineWithTide(
                state.rainCauseLatched ? "RAIN" : state.lastCause,
                tideActive
            ),
            clearConfirmSeconds: CLEAR_CONFIRM_SECONDS,
            clearThresholdCm: CLEAR_THRESHOLD_CM
        };
    }

    const normalizedRawCause = normalizeCause(rawCause);

    if (rawFlooding) {
        state.floodLatched = true;
        state.belowSince = null;

        if (normalizedRawCause) {
            state.lastCause = normalizedRawCause;
        }

        if (causeIncludesRain(normalizedRawCause) || raining) {
            state.rainCauseLatched = true;
        }
    } else if (state.floodLatched) {
        const water = Number(currentWaterCm);
        const reliableBelowThreshold =
            Number.isFinite(water)
            && water < CLEAR_THRESHOLD_CM
            && !measurementUncertain;

        if (reliableBelowThreshold) {
            if (state.belowSince == null) {
                state.belowSince = now;
            }

            if (now - state.belowSince >= CLEAR_CONFIRM_MS) {
                state = {
                    floodLatched: false,
                    lastCause: null,
                    rainCauseLatched: false,
                    belowSince: null,
                    lastUpdatedAt: now
                };
            }
        } else {
            // Không xóa trạng thái ngập chỉ vì:
            // - cảm biến mưa vừa chuyển sang khô;
            // - scenario tạm thời thành LEVEL_PENDING/TRANSIENT_ANOMALY;
            // - một lần đo chưa đủ tin cậy.
            state.belowSince = null;
        }
    }

    state.lastUpdatedAt = now;
    states.set(key, state);

    let effectiveCause = null;

    if (state.floodLatched) {
        if (rawFlooding && normalizedRawCause) {
            effectiveCause = normalizedRawCause;

            // Nếu trận ngập ban đầu có mưa, việc cảm biến mưa vừa khô
            // không được đổi ngay nguyên nhân sang LOCAL_DRAINAGE.
            if (state.rainCauseLatched && normalizedRawCause === "LOCAL_DRAINAGE") {
                effectiveCause = tideActive ? "RAIN_TIDE" : "RAIN";
            }
        } else if (state.rainCauseLatched) {
            effectiveCause = tideActive ? "RAIN_TIDE" : "RAIN";
        } else {
            effectiveCause = combineWithTide(state.lastCause, tideActive);
        }
    }

    const clearElapsedSeconds = state.belowSince == null
        ? 0
        : Math.floor((now - state.belowSince) / 1000);

    return {
        ...state,
        effectiveFlooding: state.floodLatched,
        effectiveCause,
        clearElapsedSeconds,
        clearConfirmSeconds: CLEAR_CONFIRM_SECONDS,
        clearThresholdCm: CLEAR_THRESHOLD_CM
    };
}

function getFloodState(siteId = 1) {
    const key = Number(siteId) || 1;
    return states.get(key) || {
        floodLatched: false,
        lastCause: null,
        rainCauseLatched: false,
        belowSince: null,
        lastUpdatedAt: null
    };
}

module.exports = {
    updateFloodState,
    getFloodState,
    CLEAR_CONFIRM_SECONDS,
    CLEAR_THRESHOLD_CM
};
