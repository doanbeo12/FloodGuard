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
    const scenario = sensor.scenario;

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

function nextHourWeatherInput(weather = null) {
    const hourly = Array.isArray(weather?.hourly) ? weather.hourly : [];
    const first = hourly[0] || null;

    if (!first) {
        return {
            available: false,
            rainProbability: null,
            rainMm: 0,
            condition: null,
            source: weather?.provider || null
        };
    }

    return {
        available: true,
        rainProbability: finiteOrNull(first.rain_probability),
        rainMm: Math.max(0, finiteOrNull(first.rain_mm) ?? 0),
        condition: first.condition || null,
        time: first.time || null,
        source: weather?.provider || null
    };
}

function tideFactorAtHorizon(tide = null, horizonMinutes = 0) {
    const nextHigh = tide?.next_high;
    if (!nextHigh || tide?.stale) {
        return {
            value: 0,
            levelM: finiteOrNull(nextHigh?.level_m),
            minutesFromHigh: finiteOrNull(nextHigh?.minutes_from_now),
            active: false
        };
    }

    const levelM = finiteOrNull(nextHigh.level_m);
    const minutesFromHighNow = finiteOrNull(nextHigh.minutes_from_now);

    if (levelM == null || minutesFromHighNow == null || minutesFromHighNow < 0) {
        return {
            value: 0,
            levelM,
            minutesFromHigh: minutesFromHighNow,
            active: false
        };
    }

    const minutesFromHigh = minutesFromHighNow - Math.max(0, horizonMinutes);

    // Chỉ xét ảnh hưởng quanh đỉnh triều trong cửa sổ ±180 phút.
    const timeWeight = clamp(1 - Math.abs(minutesFromHigh) / 180, 0, 1);

    let levelWeight = 0;
    if (levelM >= 1.60) levelWeight = 1;
    else if (levelM >= 1.50) levelWeight = 2 / 3;
    else if (levelM >= 1.40) levelWeight = 1 / 3;

    const value = clamp(timeWeight * levelWeight, 0, 1);

    return {
        value,
        levelM,
        minutesFromHigh,
        active: value > 0
    };
}

function tideFactor(tide = null) {
    return tideFactorAtHorizon(tide, 0);
}


function buildOneHourWaterForecast({
    sensor = {},
    weather = null,
    tide = null,
    connectionStatus = "ONLINE"
} = {}) {
    const current = trustedCurrentWater(sensor);
    const rateCmMin = finiteOrNull(sensor.rate_cm_min ?? sensor.rateCmPerMin);
    const weatherInput = nextHourWeatherInput(weather);
    const tideInput = tideFactor(tide);

    const coefficients = {
        beta0: envNumber("WATER_FORECAST_B0_CM", 0.0),
        betaCurrent: envNumber("WATER_FORECAST_B_CURRENT", 1.0),
        betaRate: envNumber("WATER_FORECAST_B_RATE", 6.0),
        betaRain: envNumber("WATER_FORECAST_B_RAIN", 0.30),
        betaTide: envNumber("WATER_FORECAST_B_TIDE", 0.80)
    };

    const modelMinCm = envNumber("WATER_FORECAST_MIN_CM", 0);
    const modelMaxCm = envNumber("WATER_FORECAST_MAX_CM", 15);

    if (connectionStatus !== "ONLINE") {
        return {
            available: false,
            horizon_minutes: 60,
            model: "EMPIRICAL_MULTI_HORIZON_V1",
            calibration_status: "PROVISIONAL",
            message: "Thiết bị đang mất kết nối nên chưa dự báo mực nước sau 1 giờ."
        };
    }

    if (current.value == null) {
        return {
            available: false,
            horizon_minutes: 60,
            model: "EMPIRICAL_MULTI_HORIZON_V1",
            calibration_status: "PROVISIONAL",
            message: current.reason || "Chưa có mực nước hiện tại đủ tin cậy để dự báo."
        };
    }

    // Dự báo 4 mốc 15/30/45/60 phút bằng cùng mô hình thực nghiệm.
    // Không dùng H = H0 + R*t. Ảnh hưởng tốc độ được làm suy giảm theo căn bậc hai
    // của thời gian, lượng mưa tích lũy theo phần giờ, và triều được tính lại
    // theo khoảng cách tới đỉnh triều tại từng mốc.
    const horizons = [15, 30, 45, 60];

    const forecastPoints = horizons.map(minutes => {
        const fraction = minutes / 60;
        const rateWeight = Math.sqrt(fraction);
        const rainAccumulatedMm = weatherInput.rainMm * fraction;
        const tideAtHorizon = tideFactorAtHorizon(tide, minutes);

        const currentComponent =
            current.value * (1 + (coefficients.betaCurrent - 1) * fraction);

        const rawLevel =
            currentComponent
            + coefficients.beta0 * fraction
            + coefficients.betaRate * (rateCmMin ?? 0) * rateWeight
            + coefficients.betaRain * rainAccumulatedMm
            + coefficients.betaTide * tideAtHorizon.value * fraction;

        const levelCm = clamp(rawLevel, modelMinCm, modelMaxCm);

        return {
            minutes,
            predicted_water_cm: Number(levelCm.toFixed(2)),
            rain_mm_used: Number(rainAccumulatedMm.toFixed(2)),
            tide_factor: Number(tideAtHorizon.value.toFixed(3))
        };
    });

    const finalPoint = forecastPoints[forecastPoints.length - 1];
    const predictedCm = finalPoint.predicted_water_cm;
    const deltaCm = predictedCm - current.value;

    const summaryParts = [
        `Mực nước hiện tại ${current.value.toFixed(1)} cm`,
        `dự báo sau 60 phút khoảng ${predictedCm.toFixed(1)} cm`
    ];

    if (weatherInput.available) {
        summaryParts.push(
            `mưa dự báo trong giờ tới ${weatherInput.rainMm.toFixed(1)} mm`
        );
    }

    if (tideInput.levelM != null && tideInput.minutesFromHigh != null) {
        summaryParts.push(
            `đỉnh triều kế tiếp ${tideInput.levelM.toFixed(2)} m trong khoảng ${Math.max(0, Math.round(tideInput.minutesFromHigh))} phút`
        );
    }

    return {
        available: true,
        horizon_minutes: 60,
        forecast_points: forecastPoints,
        model: "EMPIRICAL_MULTI_HORIZON_V1",
        calibration_status: "PROVISIONAL",
        predicted_water_cm: Number(predictedCm.toFixed(2)),
        current_water_cm: Number(current.value.toFixed(2)),
        delta_cm: Number(deltaCm.toFixed(2)),
        summary: summaryParts.join("; ") + ".",
        inputs: {
            rate_cm_min: rateCmMin,
            rain_probability: weatherInput.rainProbability,
            rain_mm_1h: weatherInput.rainMm,
            weather_condition: weatherInput.condition,
            tide_factor: Number(tideInput.value.toFixed(3)),
            next_high_level_m: tideInput.levelM,
            minutes_to_next_high: tideInput.minutesFromHigh,
            substituted_current_water: current.substituted
        },
        coefficients,
        bounds_cm: {
            min: modelMinCm,
            max: modelMaxCm
        },
        note: "Các hệ số hiện là bộ khởi tạo cho mô hình thực nghiệm 0-15 cm và cần được hiệu chỉnh lại bằng dữ liệu thử nghiệm thực tế."
    };
}

module.exports = {
    buildOneHourWaterForecast,
    trustedCurrentWater,
    tideFactor,
    tideFactorAtHorizon
};
