const axios = require("axios");

// OpenWeather is kept for the existing current-weather endpoint.
// Weather data is reference information only and is NOT used by the
// sensor-based Early Warning algorithm.
const CURRENT_URL = "https://api.openweathermap.org/data/2.5/weather";
const FORECAST_URL = "https://api.openweathermap.org/data/2.5/forecast";

// Open-Meteo provides true hourly forecast data without requiring an API key.
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

let currentCache = { at: 0, data: null };
const hourlyCache = new Map();

function envNumber(name, fallback) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) ? n : fallback;
}

function finiteOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function epochToIso(seconds) {
    const n = Number(seconds);
    return Number.isFinite(n) ? new Date(n * 1000).toISOString() : null;
}

function clampInteger(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isInteger(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function openWeatherError(error) {
    const status = error?.response?.status;
    const providerMessage = error?.response?.data?.message;

    if (status === 401) {
        return "OpenWeather từ chối API key (401). Kiểm tra OPENWEATHER_API_KEY hoặc chờ key được kích hoạt.";
    }
    if (status === 429) {
        return "OpenWeather giới hạn số lượt gọi API (429). Hãy thử lại sau.";
    }
    if (providerMessage) return `OpenWeather: ${providerMessage}`;
    return error?.message || "Không lấy được dữ liệu OpenWeather.";
}

function openMeteoError(error) {
    const reason = error?.response?.data?.reason;
    if (reason) return `Open-Meteo: ${reason}`;
    return error?.message || "Không lấy được dữ liệu dự báo theo giờ.";
}

function weatherCodeInfo(value) {
    const code = Number(value);

    if (code === 0) {
        return { condition: "CLEAR", label: "Trời quang" };
    }
    if (code === 1 || code === 2) {
        return { condition: "PARTLY_CLOUDY", label: "Ít mây" };
    }
    if (code === 3) {
        return { condition: "CLOUDY", label: "Nhiều mây" };
    }
    if (code === 45 || code === 48) {
        return { condition: "FOG", label: "Sương mù" };
    }
    if ([51, 53, 55, 56, 57].includes(code)) {
        return { condition: "DRIZZLE", label: "Mưa phùn" };
    }
    if ([61, 63, 66, 80, 81].includes(code)) {
        return { condition: "RAIN", label: "Mưa" };
    }
    if ([65, 67, 82].includes(code)) {
        return { condition: "HEAVY_RAIN", label: "Mưa lớn" };
    }
    if ([71, 73, 75, 77, 85, 86].includes(code)) {
        return { condition: "OTHER", label: "Thời tiết lạnh" };
    }
    if ([95, 96, 99].includes(code)) {
        return { condition: "THUNDERSTORM", label: "Dông" };
    }

    return { condition: "UNKNOWN", label: "Chưa xác định" };
}

async function getHcmcWeather() {
    const apiKey = String(process.env.OPENWEATHER_API_KEY || "").trim();
    const lat = envNumber("WEATHER_LAT", 10.7769);
    const lon = envNumber("WEATHER_LON", 106.7009);
    const cacheMinutes = Math.max(1, envNumber("WEATHER_CACHE_MINUTES", 10));
    const timeoutMs = Math.max(3000, envNumber("WEATHER_HTTP_TIMEOUT_MS", 15000));
    const cacheMs = cacheMinutes * 60 * 1000;

    if (!apiKey || apiKey === "YOUR_OPENWEATHER_API_KEY") {
        return {
            available: false,
            provider: "OpenWeather",
            message: "Chưa cấu hình OPENWEATHER_API_KEY trong backend/.env.",
            fetchedAt: new Date().toISOString()
        };
    }

    if (currentCache.data && Date.now() - currentCache.at < cacheMs) {
        return currentCache.data;
    }

    try {
        const commonParams = {
            lat,
            lon,
            appid: apiKey,
            units: "metric",
            lang: "vi"
        };

        const [currentResponse, forecastResponse] = await Promise.all([
            axios.get(CURRENT_URL, { timeout: timeoutMs, params: commonParams }),
            axios.get(FORECAST_URL, { timeout: timeoutMs, params: commonParams })
        ]);

        const current = currentResponse.data || {};
        const forecast = forecastResponse.data || {};
        const forecastList = Array.isArray(forecast.list) ? forecast.list : [];
        const nowSec = Math.floor(Date.now() / 1000);
        const nextBlock = forecastList.find(item => Number(item?.dt) >= nowSec) || forecastList[0] || null;

        const currentRain1h = finiteOrNull(current?.rain?.["1h"]);
        const currentRain3h = finiteOrNull(current?.rain?.["3h"]);
        const currentPrecip = currentRain1h ?? currentRain3h ?? 0;

        const nextPop = finiteOrNull(nextBlock?.pop);
        const nextRain3h = finiteOrNull(nextBlock?.rain?.["3h"]) ?? 0;
        const weather = Array.isArray(current.weather) ? current.weather[0] : null;

        const data = {
            available: true,
            provider: "OpenWeather",
            location: current.name || "TP.HCM",
            coordinates: { lat, lon },
            note: "Thông tin tham khảo, không tham gia thuật toán Early Warning.",
            current: {
                time: epochToIso(current.dt),
                temperatureC: finiteOrNull(current?.main?.temp),
                feelsLikeC: finiteOrNull(current?.main?.feels_like),
                humidityPercent: finiteOrNull(current?.main?.humidity),
                precipitationMm: currentPrecip,
                precipitationPeriod: currentRain1h != null ? "1h" : (currentRain3h != null ? "3h" : "none"),
                weatherCode: finiteOrNull(weather?.id),
                weatherMain: weather?.main || null,
                description: weather?.description || null,
                windSpeedMps: finiteOrNull(current?.wind?.speed)
            },
            next3h: {
                forecastTime: epochToIso(nextBlock?.dt),
                precipitationProbability: nextPop == null ? null : Number((nextPop * 100).toFixed(0)),
                // Compatibility with Dashboard v1.5.0 field name.
                maxPrecipitationProbability: nextPop == null ? null : Number((nextPop * 100).toFixed(0)),
                totalPrecipitationMm: nextRain3h,
                description: Array.isArray(nextBlock?.weather) ? (nextBlock.weather[0]?.description || null) : null
            },
            fetchedAt: new Date().toISOString()
        };

        currentCache = { at: Date.now(), data };
        return data;
    } catch (error) {
        return {
            available: false,
            provider: "OpenWeather",
            message: openWeatherError(error),
            fetchedAt: new Date().toISOString()
        };
    }
}

async function getHourlyWeather({ lat, lon, hours = 24 } = {}) {
    const latitude = finiteOrNull(lat);
    const longitude = finiteOrNull(lon);
    const requestedHours = clampInteger(hours, 24, 1, 48);
    const timeoutMs = Math.max(3000, envNumber("WEATHER_HTTP_TIMEOUT_MS", 15000));
    const cacheMinutes = Math.max(1, envNumber("WEATHER_HOURLY_CACHE_MINUTES", 10));
    const cacheMs = cacheMinutes * 60 * 1000;

    if (latitude == null || longitude == null) {
        return {
            available: false,
            provider: "Open-Meteo",
            message: "Địa điểm chưa có latitude/longitude để lấy dự báo thời tiết.",
            fetchedAt: new Date().toISOString()
        };
    }

    const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const cached = hourlyCache.get(cacheKey);

    if (cached?.data && Date.now() - cached.at < cacheMs) {
        return {
            ...cached.data,
            hours: requestedHours,
            hourly: cached.data.hourly.slice(0, requestedHours)
        };
    }

    try {
        const response = await axios.get(OPEN_METEO_URL, {
            timeout: timeoutMs,
            params: {
                latitude,
                longitude,
                hourly: [
                    "temperature_2m",
                    "relative_humidity_2m",
                    "precipitation_probability",
                    "precipitation",
                    "weather_code",
                    "wind_speed_10m"
                ].join(","),
                timezone: "Asia/Ho_Chi_Minh",
                timeformat: "unixtime",
                forecast_days: 2
            }
        });

        const body = response.data || {};
        const hourly = body.hourly || {};
        const times = Array.isArray(hourly.time) ? hourly.time : [];
        const temperatures = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
        const humidity = Array.isArray(hourly.relative_humidity_2m) ? hourly.relative_humidity_2m : [];
        const rainProbability = Array.isArray(hourly.precipitation_probability) ? hourly.precipitation_probability : [];
        const precipitation = Array.isArray(hourly.precipitation) ? hourly.precipitation : [];
        const weatherCodes = Array.isArray(hourly.weather_code) ? hourly.weather_code : [];
        const windSpeed = Array.isArray(hourly.wind_speed_10m) ? hourly.wind_speed_10m : [];

        // Include the current clock hour, then the following hours.
        const currentHourMs = Math.floor(Date.now() / 3600000) * 3600000;
        const allHours = [];

        for (let i = 0; i < times.length; i++) {
            const epochSeconds = Number(times[i]);
            if (!Number.isFinite(epochSeconds)) continue;
            if (epochSeconds * 1000 < currentHourMs) continue;

            const code = finiteOrNull(weatherCodes[i]);
            const info = weatherCodeInfo(code);
            const rainMm = finiteOrNull(precipitation[i]) ?? 0;
            const rainChance = finiteOrNull(rainProbability[i]);

            allHours.push({
                time: epochToIso(epochSeconds),
                temperature_c: finiteOrNull(temperatures[i]),
                rain_probability: rainChance,
                rain_mm: rainMm,
                humidity_percent: finiteOrNull(humidity[i]),
                wind_kmh: finiteOrNull(windSpeed[i]),
                weather_code: code,
                condition: info.condition,
                condition_label: info.label,
                is_rain_expected: rainMm > 0 || (rainChance != null && rainChance >= 50)
            });
        }

        const fullData = {
            available: allHours.length > 0,
            provider: "Open-Meteo",
            coordinates: { lat: latitude, lon: longitude },
            timezone: body.timezone || "Asia/Ho_Chi_Minh",
            timezone_abbreviation: body.timezone_abbreviation || "GMT+7",
            utc_offset_seconds: finiteOrNull(body.utc_offset_seconds),
            note: "Dự báo thời tiết theo giờ chỉ mang tính tham khảo.",
            hours: allHours.length,
            hourly: allHours,
            fetchedAt: new Date().toISOString()
        };

        hourlyCache.set(cacheKey, { at: Date.now(), data: fullData });

        return {
            ...fullData,
            hours: requestedHours,
            hourly: allHours.slice(0, requestedHours)
        };
    } catch (error) {
        return {
            available: false,
            provider: "Open-Meteo",
            coordinates: { lat: latitude, lon: longitude },
            message: openMeteoError(error),
            hours: requestedHours,
            hourly: [],
            fetchedAt: new Date().toISOString()
        };
    }
}

module.exports = { getHcmcWeather, getHourlyWeather };
