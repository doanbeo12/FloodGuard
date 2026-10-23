const { pool } = require("./db-v2");
require("dotenv").config();

function safeDb(name) {
  return /^[A-Za-z0-9_]+$/.test(String(name || "")) ? String(name) : "floodguard_v2";
}
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function mean(a) { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }
function median(a) { const v = a.filter(Number.isFinite).slice().sort((x, y) => x - y); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }
function round(v, n = 2) { return Number.isFinite(v) ? Number(v.toFixed(n)) : null; }
function num(v) { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

const DB = safeDb(process.env.V2_DB_NAME || "floodguard_v2");
const WINDOW_MIN = clamp(Number(process.env.RAIN_PREDICTOR_WINDOW_MINUTES || 15), 5, 60);
const SCALE = Math.max(1, Number(process.env.FORECAST_SIM_TIME_SCALE || process.env.TIDE_SIM_TIME_SCALE || 60));
const SAMPLE_SEC = Math.max(1, Number(process.env.DB_V2_SAMPLE_INTERVAL_MS || 5000) / 1000);
const ACTIVE_LOOKBACK_SEC = Math.max(30, Number(process.env.RAIN_ACTIVE_LOOKBACK_SECONDS || 90));

function regression(rows, field) {
  const pts = rows
    .map(r => ({ t: new Date(r.recorded_at).getTime(), v: num(r[field]) }))
    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v));
  if (pts.length < 3) return 0;
  const t0 = pts[0].t;
  const xs = pts.map(p => (p.t - t0) / 60000);
  const ys = pts.map(p => p.v);
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  return den > 0 ? num / den : 0;
}

function scoreHumidity(current, slope) {
  let s = 0;
  if (current >= 90) s += 16;
  else if (current >= 85) s += 12;
  else if (current >= 78) s += 8;
  else if (current >= 70) s += 4;
  if (slope >= 0.6) s += 14;
  else if (slope >= 0.3) s += 10;
  else if (slope >= 0.12) s += 6;
  else if (slope > 0) s += 2;
  return clamp(s, 0, 30);
}

function scorePressure(slope) {
  const fall = -slope;
  if (fall >= 0.30) return 30;
  if (fall >= 0.18) return 25;
  if (fall >= 0.10) return 20;
  if (fall >= 0.05) return 12;
  if (fall > 0) return 5;
  return 0;
}

function scoreDewSpread(current, slope) {
  let s = 0;
  if (Number.isFinite(current)) {
    if (current <= 1.0) s += 16;
    else if (current <= 2.0) s += 13;
    else if (current <= 3.0) s += 9;
    else if (current <= 4.5) s += 5;
  }
  const closing = -slope;
  if (closing >= 0.25) s += 9;
  else if (closing >= 0.12) s += 6;
  else if (closing > 0.03) s += 3;
  return clamp(s, 0, 25);
}

function scoreWind(current, slope, baseline) {
  if (!Number.isFinite(current)) return 0;
  let s = 0;
  const ratio = Number.isFinite(baseline) && baseline > 10 ? current / baseline : null;
  if (Number.isFinite(ratio)) {
    if (ratio >= 2.0) s += 8;
    else if (ratio >= 1.5) s += 6;
    else if (ratio >= 1.2) s += 3;
  }
  if (slope >= 20) s += 7;
  else if (slope >= 10) s += 5;
  else if (slope >= 3) s += 2;
  return clamp(s, 0, 15);
}

function riskLabel(score) {
  if (score >= 76) return "VERY_HIGH";
  if (score >= 56) return "HIGH";
  if (score >= 31) return "MEDIUM";
  return "LOW";
}

function onsetFromScore(score) {
  if (score >= 76) return { min_sim_hours: 0, max_sim_hours: 1, label: "WITHIN_1H" };
  if (score >= 56) return { min_sim_hours: 1, max_sim_hours: 2, label: "WITHIN_1_TO_2H" };
  if (score >= 40) return { min_sim_hours: 2, max_sim_hours: 3, label: "WITHIN_2_TO_3H" };
  return null;
}

async function loadRainHistory(minutes = WINDOW_MIN) {
  const from = new Date(Date.now() - minutes * 60000);
  const [rows] = await pool.execute(
    "SELECT id,recorded_at,temperature_c,humidity_pct,pressure_hpa,dew_point_c,dew_spread_c,wind_rpm," +
    "rain_detected,rain_tips_10s,rain_tips_total,aht_valid,bmp_valid,jsn_valid,water_level_cm " +
    "FROM " + DB + ".rain_node_readings WHERE recorded_at>=? ORDER BY recorded_at ASC,id ASC",
    [from]
  );
  return rows;
}

async function buildRainForecast(options = {}) {
  const minutes = clamp(Number(options.windowMinutes || WINDOW_MIN), 5, 60);
  const scale = Math.max(1, Number(options.simTimeScale || SCALE));
  const rows = await loadRainHistory(minutes);
  if (rows.length < 4) {
    return {
      available: false,
      reason: "NOT_ENOUGH_DATA",
      message: "Chua du du lieu moi truong de du bao mua.",
      required_inputs: ["humidity_pct", "pressure_hpa", "dew_spread_c", "wind_rpm"],
      confirmation_inputs: ["rain_detected", "rain_tips_interval"]
    };
  }

  const latest = rows[rows.length - 1];
  const nowMs = new Date(latest.recorded_at).getTime();
  const activeFrom = nowMs - ACTIVE_LOOKBACK_SEC * 1000;
  const recent = rows.filter(r => new Date(r.recorded_at).getTime() >= activeFrom);
  const recentTips = recent.reduce((s, r) => s + Math.max(0, Number(r.rain_tips_10s) || 0), 0);
  const rainSensorWet = recent.some(r => Number(r.rain_detected) === 1);
  const rainActive = rainSensorWet || recentTips > 0;

  const temp = num(latest.temperature_c);
  const humidity = num(latest.humidity_pct);
  const pressure = num(latest.pressure_hpa);
  const dewSpread = num(latest.dew_spread_c);
  const wind = num(latest.wind_rpm);

  const humiditySlope = regression(rows, "humidity_pct");
  const pressureSlope = regression(rows, "pressure_hpa");
  const tempSlope = regression(rows, "temperature_c");
  const dewSlope = regression(rows, "dew_spread_c");
  const windSlope = regression(rows, "wind_rpm");
  const firstHalfWind = median(rows.slice(0, Math.max(1, Math.floor(rows.length / 2))).map(r => num(r.wind_rpm)));

  const components = {
    humidity: scoreHumidity(humidity, humiditySlope),
    pressure: scorePressure(pressureSlope),
    dew_spread: scoreDewSpread(dewSpread, dewSlope),
    wind: scoreWind(wind, windSlope, firstHalfWind)
  };
  let score = components.humidity + components.pressure + components.dew_spread + components.wind;

  const temperatureSupport = tempSlope <= -0.15 ? 5 : tempSlope <= -0.05 ? 2 : 0;
  score = clamp(score + temperatureSupport, 0, 100);

  const validAht = rows.filter(r => Number(r.aht_valid) === 1).length / rows.length;
  const validBmp = rows.filter(r => Number(r.bmp_valid) === 1).length / rows.length;
  const hasWind = rows.filter(r => Number.isFinite(num(r.wind_rpm))).length / rows.length;
  const spanMin = (new Date(rows[rows.length - 1].recorded_at) - new Date(rows[0].recorded_at)) / 60000;
  const completeness = clamp(rows.length / Math.max(6, Math.floor(minutes * 60 / SAMPLE_SEC * 0.5)), 0, 1);
  const confidence = clamp(0.30 * validAht + 0.30 * validBmp + 0.15 * hasWind + 0.15 * clamp(spanMin / minutes, 0, 1) + 0.10 * completeness, 0.05, 0.98);

  const label = rainActive ? "RAIN_ACTIVE" : riskLabel(score);
  const onset = rainActive ? { min_sim_hours: 0, max_sim_hours: 0, label: "NOW" } : onsetFromScore(score);

  return {
    available: true,
    model: "SENSOR_TREND_RULE_V1",
    generated_at: new Date().toISOString(),
    status: rainActive ? "RAIN_CONFIRMED" : "FORECAST",
    rain_active: rainActive,
    rain_sensor_wet: rainSensorWet,
    tips_recent: recentTips,
    tips_window_seconds: ACTIVE_LOOKBACK_SEC,
    sample_interval_seconds: SAMPLE_SEC,
    current: {
      temperature_c: round(temp),
      humidity_pct: round(humidity),
      pressure_hpa: round(pressure),
      dew_spread_c: round(dewSpread),
      wind_rpm: round(wind)
    },
    trends_per_real_minute: {
      temperature_c: round(tempSlope, 3),
      humidity_pct: round(humiditySlope, 3),
      pressure_hpa: round(pressureSlope, 3),
      dew_spread_c: round(dewSlope, 3),
      wind_rpm: round(windSlope, 2)
    },
    score_components: { ...components, temperature_support: temperatureSupport },
    rain_risk_score: round(score, 1),
    rain_risk_label: label,
    expected_onset: onset,
    confidence: round(confidence, 3),
    confidence_label: confidence >= 0.75 ? "HIGH" : confidence >= 0.5 ? "MEDIUM" : "LOW",
    time_model: {
      simulation_scale: scale,
      one_sim_hour_real_seconds: round(3600 / scale, 2)
    },
    history: { window_minutes: minutes, span_minutes: round(spanMin, 2), points: rows.length },
    predictor_rules: {
      forecast_inputs: ["humidity_pct", "pressure_hpa", "dew_spread_c", "temperature_c", "wind_rpm"],
      confirmation_inputs: ["rain_detected", "rain_tips_interval"],
      note: "Rain sensor and tipping bucket confirm rain after onset; they do not create the pre-rain score. Score is a demo rule index, not a calibrated meteorological probability."
    }
  };
}

module.exports = { buildRainForecast, loadRainHistory };
