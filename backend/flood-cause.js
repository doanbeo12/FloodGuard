require("dotenv").config();

function envNumber(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
}

const DEFAULT_FLOOD_WATER_THRESHOLD_CM = 3;
const DEFAULT_TIDE_HIGH_WINDOW_MINUTES = 180;
const DEFAULT_TIDE_MIN_LEVEL_M = 1.40;

function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function boolValue(value) {
    return value === true || value === 1 || value === "1" || value === "true";
}

function normalizeScenario(value) {
    return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function tideRiskBandForLevel(level) {
    const value = finiteOrNull(level);
    if (value == null) {
        return { code: "UNKNOWN", label: "Chưa xác định", severity: 0 };
    }
    if (value >= 1.60) {
        return { code: "BD3", label: "Rất cao (≥ BĐ III)", severity: 3 };
    }
    if (value >= 1.50) {
        return { code: "BD2", label: "Cao (≥ BĐ II)", severity: 2 };
    }
    if (value >= 1.40) {
        return { code: "BD1", label: "Theo dõi (≥ BĐ I)", severity: 1 };
    }
    return { code: "BELOW_BD1", label: "Dưới BĐ I", severity: 0 };
}

function detectFlooding(sensor = {}) {
    const scenario = normalizeScenario(sensor.scenario);
    const currentWaterCm = finiteOrNull(sensor.max_water_level ?? sensor.maxWaterLevel);
    const thresholdCm = Math.max(
        0,
        envNumber("FLOOD_CAUSE_WATER_THRESHOLD_CM", DEFAULT_FLOOD_WATER_THRESHOLD_CM)
    );

    // Khi Central xác định lỗi cảm biến hoàn toàn / cả hai Node offline,
    // không dùng giá trị nước còn sót lại để kết luận đang ngập.
    if (scenario === "SENSOR_FAULT" || scenario === "NODES_OFFLINE") {
        return {
            active: false,
            currentWaterCm,
            thresholdCm,
            basis: `Không phân loại nguyên nhân khi scenario=${scenario}.`
        };
    }

    if (scenario.startsWith("FLOOD_")) {
        return {
            active: true,
            currentWaterCm,
            thresholdCm,
            basis: `Central đang ở scenario ${scenario}.`
        };
    }

    if (currentWaterCm != null && currentWaterCm >= thresholdCm) {
        return {
            active: true,
            currentWaterCm,
            thresholdCm,
            basis: `Mực nước ${currentWaterCm.toFixed(2)} cm >= ngưỡng ${thresholdCm.toFixed(2)} cm.`
        };
    }

    return {
        active: false,
        currentWaterCm,
        thresholdCm,
        basis: currentWaterCm == null
            ? "Chưa có mực nước hợp lệ để xác nhận ngập."
            : `Mực nước ${currentWaterCm.toFixed(2)} cm < ngưỡng ${thresholdCm.toFixed(2)} cm.`
    };
}

function getTideHighEvidence(tide = null) {
    const windowMinutes = Math.max(
        1,
        Math.round(envNumber("FLOOD_CAUSE_TIDE_WINDOW_MINUTES", DEFAULT_TIDE_HIGH_WINDOW_MINUTES))
    );

    const minLevelM = Math.max(
        0,
        envNumber("FLOOD_CAUSE_TIDE_MIN_LEVEL_M", DEFAULT_TIDE_MIN_LEVEL_M)
    );

    const base = {
        active: false,
        withinWindow: false,
        levelQualified: false,
        windowMinutes,
        minLevelM,
        station: tide?.station || null,
        available: Boolean(tide?.available),
        stale: Boolean(tide?.stale),
        event: null,
        minutesFromHigh: null,
        riskBand: tideRiskBandForLevel(null),
        basis: null
    };

    if (!tide || !tide.available) {
        return {
            ...base,
            basis: "Không có dữ liệu triều hợp lệ cho địa điểm."
        };
    }

    if (tide.stale) {
        return {
            ...base,
            basis: "Dữ liệu triều đã stale nên không dùng để quy nguyên nhân."
        };
    }

    const candidates = [];

    // Mốc HIGH kế tiếp.
    if (tide.next_high?.type === "HIGH") {
        const minutes = finiteOrNull(tide.next_high.minutes_from_now);
        if (minutes != null) {
            candidates.push({
                direction: "NEXT",
                minutesFromHigh: minutes,
                absoluteMinutes: Math.abs(minutes),
                event: tide.next_high
            });
        }
    }

    // Nếu mốc ngay trước hiện tại là HIGH thì đây là mốc HIGH gần nhất phía sau.
    if (tide.previous_event?.type === "HIGH") {
        const minutes = finiteOrNull(tide.previous_event.minutes_from_now);
        if (minutes != null) {
            candidates.push({
                direction: "PREVIOUS",
                minutesFromHigh: minutes,
                absoluteMinutes: Math.abs(minutes),
                event: tide.previous_event
            });
        }
    }

    if (!candidates.length) {
        return {
            ...base,
            basis: "Không tìm được mốc HIGH gần hiện tại trong cửa sổ dự báo."
        };
    }

    candidates.sort((a, b) => a.absoluteMinutes - b.absoluteMinutes);
    const nearest = candidates[0];
    const levelM = finiteOrNull(nearest.event.level_m);
    const riskBand = tideRiskBandForLevel(levelM);
    const withinWindow = nearest.absoluteMinutes <= windowMinutes;
    const levelQualified = levelM != null && levelM >= minLevelM;
    const active = withinWindow && levelQualified;

    let basis;
    if (!withinWindow) {
        basis = `Mốc triều HIGH gần nhất cách ${nearest.absoluteMinutes} phút, ngoài cửa sổ ±${windowMinutes} phút.`;
    } else if (!levelQualified) {
        basis = levelM == null
            ? "Mốc triều HIGH gần hiện tại nhưng không có mức triều hợp lệ."
            : `Mốc triều HIGH gần hiện tại có mức ${levelM.toFixed(2)} m, thấp hơn ngưỡng đóng góp ${minLevelM.toFixed(2)} m.`;
    } else {
        basis = `Mốc triều HIGH gần hiện tại có mức ${levelM.toFixed(2)} m (${riskBand.label}) và nằm trong cửa sổ ±${windowMinutes} phút.`;
    }

    return {
        ...base,
        active,
        withinWindow,
        levelQualified,
        event: {
            direction: nearest.direction,
            date: nearest.event.date || null,
            time: nearest.event.time || null,
            level_m: levelM
        },
        minutesFromHigh: nearest.minutesFromHigh,
        riskBand,
        basis
    };
}

function classifyFloodCause({ sensor = {}, tide = null } = {}) {
    const flood = detectFlooding(sensor);
    const raining = boolValue(sensor.raining);
    const tideHigh = getTideHighEvidence(tide);

    let code = "NONE";
    let label = "Chưa ghi nhận ngập";
    let basis = flood.basis;

    if (flood.active) {
        if (raining && tideHigh.active) {
            code = "RAIN_TIDE";
            label = "Mưa + triều";
            basis = "Đang có ngập, cảm biến phát hiện mưa và thời điểm nằm gần mốc triều HIGH.";
        } else if (raining) {
            code = "RAIN";
            label = "Mưa";
            basis = "Đang có ngập và cảm biến phát hiện mưa; chưa có bằng chứng triều HIGH trong cửa sổ cấu hình.";
        } else if (tideHigh.active) {
            code = "TIDE";
            label = "Triều";
            basis = "Đang có ngập, không phát hiện mưa và thời điểm nằm gần mốc triều HIGH.";
        } else {
            // Fallback an toàn: không ép một trận ngập vào mưa hoặc triều khi cả hai
            // tín hiệu đều không đủ. Frontend có thể hiển thị "Chưa xác định".
            code = "UNKNOWN";
            label = "Chưa xác định";
            basis = "Đang có ngập nhưng chưa đủ bằng chứng để quy về mưa hoặc triều.";
        }
    }

    return {
        code,
        label,
        flooding_detected: flood.active,
        basis,
        methodology: "Rule-based attribution: flood state + rain sensor + HIGH-tide timing + forecast tide level.",
        note: "Đây là phân loại nguyên nhân có khả năng đóng góp, không phải chứng minh thủy động lực học.",
        evidence: {
            scenario: normalizeScenario(sensor.scenario) || null,
            current_water_cm: flood.currentWaterCm,
            flood_threshold_cm: flood.thresholdCm,
            raining,
            tide_high_window: tideHigh.active,
            tide_within_time_window: tideHigh.withinWindow,
            tide_level_qualified: tideHigh.levelQualified,
            tide_level_m: tideHigh.event?.level_m ?? null,
            tide_risk_band: tideHigh.riskBand,
            tide_min_contribution_level_m: tideHigh.minLevelM,
            tide_window_minutes: tideHigh.windowMinutes,
            tide_station: tideHigh.station,
            tide_available: tideHigh.available,
            tide_stale: tideHigh.stale,
            minutes_from_nearest_high: tideHigh.minutesFromHigh,
            nearest_high: tideHigh.event,
            tide_basis: tideHigh.basis
        }
    };
}

module.exports = {
    classifyFloodCause,
    detectFlooding,
    getTideHighEvidence,
    tideRiskBandForLevel
};
