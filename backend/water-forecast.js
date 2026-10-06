require("dotenv").config();

const { isMeasurementAnomalyScenario } = require("./flood-cause");

function envNumber(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
}

function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function trustedCurrentWater(sensor = {}) {
    const max = finiteOrNull(sensor.max_water_level ?? sensor.maxWaterLevel);
    const node1 = finiteOrNull(sensor.node1_water_level ?? sensor.node1WaterLevel);
    const node2 = finiteOrNull(sensor.node2_water_level ?? sensor.node2WaterLevel);
    const scenario = typeof sensor.scenario === "string"
        ? sensor.scenario.trim().toUpperCase()
        : "";

    const largeNodeMismatch = max != null
        && max >= 15
        && node1 != null
        && node2 != null
        && Math.abs(node1 - node2) >= 5;

    if (isMeasurementAnomalyScenario(scenario) || largeNodeMismatch) {
        if (node1 != null && node2 != null) {
            return {
                value: Math.min(node1, node2),
                substituted: true,
                reason: "Đã loại giá trị cao bất thường bằng cách đối chiếu hai node."
            };
        }

        return {
            value: null,
            substituted: true,
            reason: "Số đo đang được xác minh nên chưa có mực nước đầu vào tin cậy."
        };
    }

    return {
        value: max,
        substituted: false,
        reason: null
    };
}

function nextHourRainProbability(weather = null) {
    const hourly = Array.isArray(weather?.hourly) ? weather.hourly : [];
    if (!hourly.length) return null;

    // Một giờ tới có thể đi qua ranh giới hai giờ đồng hồ,
    // nên dùng xác suất lớn nhất của hai block dự báo đầu tiên.
    const values = hourly
        .slice(0, 2)
        .map(item => finiteOrNull(item?.rain_probability))
        .filter(value => value != null);

    if (!values.length) return null;
    return Math.max(...values);
}

function tidePeakForForecast(tide = null) {
    // Dự báo chỉ xét đỉnh triều TƯƠNG LAI. display_high chỉ dùng để hiển thị,
    // không được dùng để cộng mức nước nếu đó là đỉnh đã qua.
    const raw = tide?.next_high || null;

    if (!raw) {
        return {
            levelM: null,
            minutesFromNow: null,
            withinThreeHours: false,
            riskBand: "UNKNOWN",
            riskLabel: "Không có đỉnh triều tương lai"
        };
    }

    const levelM = finiteOrNull(raw.level_m);
    const minutesFromNow = finiteOrNull(raw.minutes_from_now);

    if (levelM == null) {
        return {
            levelM: null,
            minutesFromNow,
            withinThreeHours: false,
            riskBand: "UNKNOWN",
            riskLabel: "Không có số liệu"
        };
    }

    const withinThreeHours = minutesFromNow != null
        && minutesFromNow >= 0
        && minutesFromNow <= 180;

    if (levelM >= 1.60) {
        return { levelM, minutesFromNow, withinThreeHours, riskBand: "BD3", riskLabel: "BĐ III" };
    }
    if (levelM >= 1.50) {
        return { levelM, minutesFromNow, withinThreeHours, riskBand: "BD2", riskLabel: "BĐ II" };
    }
    if (levelM >= 1.40) {
        return { levelM, minutesFromNow, withinThreeHours, riskBand: "BD1", riskLabel: "BĐ I" };
    }

    return { levelM, minutesFromNow, withinThreeHours, riskBand: "BELOW_BD1", riskLabel: "Dưới BĐ I" };
}

function buildOneHourWaterForecast({
    sensor = {},
    weather = null,
    tide = null,
    connectionStatus = "ONLINE"
} = {}) {
    const current = trustedCurrentWater(sensor);

    const zeroBandCm = Math.max(
        0,
        envNumber("WATER_FORECAST_SENSOR_ZERO_BAND_CM", 1.0)
    );
    const rainThresholdPercent = envNumber(
        "WATER_FORECAST_RAIN_THRESHOLD_PERCENT",
        70
    );
    const rainAddCm = Math.max(
        0,
        envNumber("WATER_FORECAST_RAIN_ADD_CM", 3)
    );
    const tideAddCm = Math.max(
        0,
        envNumber("WATER_FORECAST_TIDE_ADD_CM", 3)
    );
    const modelMaxCm = Math.max(
        0,
        envNumber("WATER_FORECAST_MAX_CM", 15)
    );

    if (connectionStatus !== "ONLINE") {
        return {
            available: false,
            horizon_minutes: 60,
            model: "RULE_BASED_1H_V1",
            message: "Thiết bị đang mất kết nối nên chưa dự báo mực nước sau 1 giờ."
        };
    }

    if (current.value == null) {
        return {
            available: false,
            horizon_minutes: 60,
            model: "RULE_BASED_1H_V1",
            message: current.reason || "Chưa có mực nước hiện tại đủ tin cậy để dự báo."
        };
    }

    // Sai số nhỏ khi mô hình đang khô không được xem là nước thật.
    // Ví dụ Node 1 = 0.3 cm, Node 2 = 0.1 cm -> nền dự báo = 0 cm.
    const baseWaterCm = current.value <= zeroBandCm
        ? 0
        : current.value;

    const rainProbability = nextHourRainProbability(weather);
    const rainTriggered = rainProbability != null
        && rainProbability > rainThresholdPercent;

    const tidePeak = tidePeakForForecast(tide);
    const tideTriggered = tidePeak.withinThreeHours
        && (tidePeak.riskBand === "BD2"
            || tidePeak.riskBand === "BD3");

    const rainContributionCm = rainTriggered ? rainAddCm : 0;
    const tideContributionCm = tideTriggered ? tideAddCm : 0;

    const predictedWaterCm = clamp(
        baseWaterCm + rainContributionCm + tideContributionCm,
        0,
        modelMaxCm
    );

    return {
        available: true,
        horizon_minutes: 60,
        model: "RULE_BASED_1H_V1",
        predicted_water_cm: Number(predictedWaterCm.toFixed(2)),
        current_water_cm: Number(current.value.toFixed(2)),
        base_water_cm: Number(baseWaterCm.toFixed(2)),
        summary: `Dự báo sau 1 giờ: ${predictedWaterCm.toFixed(1)} cm.`,
        inputs: {
            sensor_zero_band_cm: zeroBandCm,
            sensor_zeroed: current.value <= zeroBandCm,
            rain_probability: rainProbability,
            rain_threshold_percent: rainThresholdPercent,
            rain_triggered: rainTriggered,
            rain_contribution_cm: rainContributionCm,
            tide_level_m: tidePeak.levelM,
            minutes_to_next_high: tidePeak.minutesFromNow,
            tide_within_3h: tidePeak.withinThreeHours,
            tide_risk_band: tidePeak.riskBand,
            tide_risk_label: tidePeak.riskLabel,
            tide_triggered: tideTriggered,
            tide_contribution_cm: tideContributionCm,
            substituted_current_water: current.substituted
        },
        rule:
            "Nền mực nước sau khi loại sai số nhỏ; mưa >70% cộng 3 cm; triều cường từ BĐ II chỉ cộng 3 cm khi còn cách đỉnh triều không quá 3 giờ."
    };
}

module.exports = {
    buildOneHourWaterForecast,
    trustedCurrentWater,
    nextHourRainProbability,
    tidePeakForForecast
};
