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


function tideInfluenceAtMinute(tide = null, minuteFromNow = 0) {
    const nextHigh = tide?.next_high;
    if (!nextHigh || tide?.stale) {
        return {
            value: 0,
            levelM: finiteOrNull(nextHigh?.level_m),
            minutesFromHigh: finiteOrNull(nextHigh?.minutes_from_now),
            phase: "NONE"
        };
    }

    const levelM = finiteOrNull(nextHigh.level_m);
    const highMinute = finiteOrNull(nextHigh.minutes_from_now);

    if (levelM == null || highMinute == null) {
        return {
            value: 0,
            levelM,
            minutesFromHigh: highMinute,
            phase: "NONE"
        };
    }

    let levelWeight = 0;
    if (levelM >= 1.60) levelWeight = 1;
    else if (levelM >= 1.50) levelWeight = 2 / 3;
    else if (levelM >= 1.40) levelWeight = 1 / 3;

    if (levelWeight <= 0) {
        return {
            value: 0,
            levelM,
            minutesFromHigh: highMinute - minuteFromNow,
            phase: "LOW_RISK"
        };
    }

    const relative = highMinute - minuteFromNow;
    const timeWeight = clamp(1 - Math.abs(relative) / 180, 0, 1);

    // Trước đỉnh: triều góp phần làm nước tăng.
    // Sau đỉnh: đổi dấu để mô phỏng triều xuống và hỗ trợ nước rút.
    const sign = relative >= 0 ? 1 : -1;
    const value = sign * timeWeight * levelWeight;

    return {
        value,
        levelM,
        minutesFromHigh: relative,
        phase: relative >= 0 ? "RISING_TO_HIGH" : "FALLING_AFTER_HIGH"
    };
}

function weatherStepInput(weather = null, stepIndex = 0) {
    const hourly = Array.isArray(weather?.hourly) ? weather.hourly : [];
    const first = hourly[0] || null;
    const second = hourly[1] || first;

    if (!first) {
        return {
            available: false,
            rainProbability: null,
            rainMmStep: 0,
            rainRateMmHour: 0,
            condition: null
        };
    }

    // Lấy trung điểm của từng khoảng 15 phút và nội suy giữa hai dự báo giờ.
    // Nhờ vậy 4 bước không bắt buộc nhận cùng một cường độ mưa.
    const midpointMinute = stepIndex * 15 + 7.5;
    const alpha = clamp(midpointMinute / 60, 0, 1);

    const rain0 = Math.max(0, finiteOrNull(first.rain_mm) ?? 0);
    const rain1 = Math.max(0, finiteOrNull(second?.rain_mm) ?? rain0);
    const probability0 = finiteOrNull(first.rain_probability);
    const probability1 = finiteOrNull(second?.rain_probability);

    const rainRateMmHour = rain0 + (rain1 - rain0) * alpha;
    const rainMmStep = rainRateMmHour * 0.25;

    let rainProbability = probability0;
    if (probability0 != null && probability1 != null) {
        rainProbability = probability0 + (probability1 - probability0) * alpha;
    } else if (probability1 != null) {
        rainProbability = probability1;
    }

    return {
        available: true,
        rainProbability,
        rainMmStep,
        rainRateMmHour,
        condition: alpha < 0.5
            ? (first.condition || null)
            : (second?.condition || first.condition || null)
    };
}

function tideFactor(tide = null) {
    const influence = tideInfluenceAtMinute(tide, 0);
    return {
        value: Math.max(0, influence.value),
        levelM: influence.levelM,
        minutesFromHigh: influence.minutesFromHigh,
        active: influence.value > 0
    };
}

function buildOneHourWaterForecast({
    sensor = {},
    weather = null,
    tide = null,
    connectionStatus = "ONLINE"
} = {}) {
    const current = trustedCurrentWater(sensor);
    const observedRate = finiteOrNull(sensor.rate_cm_min ?? sensor.rateCmPerMin);
    const rainingNow = Boolean(sensor.raining);

    const modelMinCm = envNumber("WATER_FORECAST_MIN_CM", 0);
    const modelMaxCm = envNumber("WATER_FORECAST_MAX_CM", 15);

    // Bộ hệ số khởi tạo cho mô hình thực nghiệm 0-15 cm.
    // Sau khi có dữ liệu thử nghiệm, các hệ số này sẽ được fit lại.
    const cfg = {
        rateTransfer: envNumber("WATER_FORECAST_RATE_TRANSFER", 0.25),
        rateDecay: envNumber("WATER_FORECAST_RATE_DECAY", 0.55),
        rainCmPerMm: envNumber("WATER_FORECAST_RAIN_CM_PER_MM", 0.30),
        tideCmPerStep: envNumber("WATER_FORECAST_TIDE_CM_PER_STEP", 0.35),
        drainCmPerStep: envNumber("WATER_FORECAST_DRAIN_CM_PER_STEP", 0.25),
        rainRateGain: envNumber("WATER_FORECAST_RAIN_RATE_GAIN", 0.03),
        tideRateGain: envNumber("WATER_FORECAST_TIDE_RATE_GAIN", 0.02),
        drainRateGain: envNumber("WATER_FORECAST_DRAIN_RATE_GAIN", 0.02),
        maxAbsRateCmMin: envNumber("WATER_FORECAST_MAX_ABS_RATE_CM_MIN", 0.50),
        maxStepCm: envNumber("WATER_FORECAST_MAX_STEP_CM", 2.50)
    };

    if (connectionStatus !== "ONLINE") {
        return {
            available: false,
            horizon_minutes: 60,
            model: "EMPIRICAL_STEP15_V2",
            calibration_status: "PROVISIONAL",
            message: "Thiết bị đang mất kết nối nên chưa dự báo mực nước sau 1 giờ."
        };
    }

    if (current.value == null) {
        return {
            available: false,
            horizon_minutes: 60,
            model: "EMPIRICAL_STEP15_V2",
            calibration_status: "PROVISIONAL",
            message: current.reason || "Chưa có mực nước hiện tại đủ tin cậy để dự báo."
        };
    }

    let levelCm = current.value;
    let dynamicRate = clamp(
        observedRate ?? 0,
        -cfg.maxAbsRateCmMin,
        cfg.maxAbsRateCmMin
    );

    const forecastPoints = [];
    let totalRainMm = 0;

    for (let step = 0; step < 4; step++) {
        const startMinute = step * 15;
        const endMinute = startMinute + 15;
        const midpointMinute = startMinute + 7.5;

        const weatherStep = weatherStepInput(weather, step);
        let rainMmStep = weatherStep.rainMmStep;

        // Nếu cảm biến đang ghi nhận mưa nhưng dự báo giờ hiện tại gần như bằng 0,
        // vẫn giữ một tác động mưa nhỏ ở 15 phút đầu, sau đó để dự báo thời tiết chi phối.
        if (step === 0 && rainingNow && rainMmStep < 0.10) {
            rainMmStep = 0.10;
        }

        totalRainMm += rainMmStep;

        const tideStep = tideInfluenceAtMinute(tide, midpointMinute);

        // Thành phần "quán tính" của tốc độ đo được hiện tại.
        // Không dùng rate * toàn bộ thời gian; tốc độ giảm dần sau mỗi bước.
        const rateDeltaCm =
            dynamicRate * 15 * cfg.rateTransfer;

        const rainDeltaCm =
            rainMmStep * cfg.rainCmPerMm;

        const tideDeltaCm =
            tideStep.value * cfg.tideCmPerStep;

        // Thoát nước chỉ phát huy rõ khi mưa yếu và triều không còn đẩy nước lên.
        let dryFactor = 0;
        if (rainMmStep < 0.05) dryFactor = 1;
        else if (rainMmStep < 0.20) dryFactor = 0.5;

        const levelFactor = clamp(levelCm / 3, 0, 1);
        const tideDrainFactor = tideStep.value > 0
            ? clamp(1 - tideStep.value, 0.15, 1)
            : 1 + Math.min(0.5, Math.abs(tideStep.value));

        const drainDeltaCm =
            cfg.drainCmPerStep
            * dryFactor
            * levelFactor
            * tideDrainFactor;

        let netDeltaCm =
            rateDeltaCm
            + rainDeltaCm
            + tideDeltaCm
            - drainDeltaCm;

        netDeltaCm = clamp(
            netDeltaCm,
            -cfg.maxStepCm,
            cfg.maxStepCm
        );

        levelCm = clamp(
            levelCm + netDeltaCm,
            modelMinCm,
            modelMaxCm
        );

        forecastPoints.push({
            minutes: endMinute,
            predicted_water_cm: Number(levelCm.toFixed(2)),
            change_cm: Number(netDeltaCm.toFixed(2)),
            components: {
                rate_cm: Number(rateDeltaCm.toFixed(3)),
                rain_cm: Number(rainDeltaCm.toFixed(3)),
                tide_cm: Number(tideDeltaCm.toFixed(3)),
                drainage_cm: Number(drainDeltaCm.toFixed(3))
            },
            rain: {
                probability: weatherStep.rainProbability == null
                    ? null
                    : Number(weatherStep.rainProbability.toFixed(0)),
                mm_in_step: Number(rainMmStep.toFixed(2)),
                interpolated_mm_per_hour: Number(weatherStep.rainRateMmHour.toFixed(2))
            },
            tide: {
                signed_factor: Number(tideStep.value.toFixed(3)),
                phase: tideStep.phase,
                next_high_level_m: tideStep.levelM,
                minutes_to_high_from_point: tideStep.minutesFromHigh
            }
        });

        // Cập nhật tốc độ nội bộ cho bước sau:
        // quán tính giảm dần; mưa có thể làm tốc độ tăng;
        // triều sau đỉnh có thể kéo tốc độ xuống âm; thoát nước cũng làm giảm.
        dynamicRate =
            dynamicRate * cfg.rateDecay
            + rainMmStep * cfg.rainRateGain
            + tideStep.value * cfg.tideRateGain
            - drainDeltaCm * cfg.drainRateGain;

        dynamicRate = clamp(
            dynamicRate,
            -cfg.maxAbsRateCmMin,
            cfg.maxAbsRateCmMin
        );
    }

    const finalPoint = forecastPoints[forecastPoints.length - 1];

    return {
        available: true,
        horizon_minutes: 60,
        step_minutes: 15,
        forecast_points: forecastPoints,
        model: "EMPIRICAL_STEP15_V2",
        calibration_status: "PROVISIONAL",
        predicted_water_cm: finalPoint.predicted_water_cm,
        current_water_cm: Number(current.value.toFixed(2)),
        delta_cm: Number((finalPoint.predicted_water_cm - current.value).toFixed(2)),
        summary:
            `Mực nước hiện tại ${current.value.toFixed(1)} cm; `
            + `dự báo sau 60 phút khoảng ${finalPoint.predicted_water_cm.toFixed(1)} cm; `
            + `tổng lượng mưa dùng trong 4 bước khoảng ${totalRainMm.toFixed(1)} mm.`,
        inputs: {
            rate_cm_min: observedRate,
            raining_now: rainingNow,
            rain_probability: weather?.hourly?.[0]?.rain_probability ?? null,
            rain_mm_1h: weather?.hourly?.[0]?.rain_mm ?? null,
            next_high_level_m: finiteOrNull(tide?.next_high?.level_m),
            minutes_to_next_high: finiteOrNull(tide?.next_high?.minutes_from_now),
            substituted_current_water: current.substituted
        },
        coefficients: cfg,
        bounds_cm: {
            min: modelMinCm,
            max: modelMaxCm
        },
        note:
            "Mô hình chia 1 giờ thành 4 bước 15 phút. Mỗi bước cập nhật riêng ảnh hưởng của tốc độ, mưa, triều và thoát nước; vì vậy mực nước có thể tăng rồi giảm trong cùng một giờ. Các hệ số hiện là hệ số khởi tạo và cần hiệu chỉnh bằng dữ liệu thử nghiệm."
    };
}

module.exports = {
    buildOneHourWaterForecast,
    trustedCurrentWater,
    tideFactor,
    tideInfluenceAtMinute,
    weatherStepInput
};
