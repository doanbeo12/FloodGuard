const { pool } = require("./db");
const { buildRainForecast } = require("./rain-predictor-v2");
const { buildTideForecast } = require("./tide-predictor-v2");
require("dotenv").config();

function safeDb(name) { return /^[A-Za-z0-9_]+$/.test(String(name || "")) ? String(name) : "floodguard_v2"; }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function mean(a) { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }
function round(v, n = 2) { return Number.isFinite(v) ? Number(v.toFixed(n)) : null; }
function num(v) { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

const DB = safeDb(process.env.V2_DB_NAME || "floodguard_v2");
const SCALE = Math.max(1, Number(process.env.FORECAST_SIM_TIME_SCALE || process.env.TIDE_SIM_TIME_SCALE || 60));
const ROAD_WINDOW_MIN = clamp(Number(process.env.FLOOD_ROAD_TREND_MINUTES || 5), 1, 15);
const WATCH_CM = Number(process.env.FLOOD_V2_WATCH_CM || 4);
const WARNING_CM = Number(process.env.FLOOD_V2_WARNING_CM || 8);
const DANGER_CM = Number(process.env.FLOOD_V2_DANGER_CM || 12);
const TIDE_HIGH_CM = Number(process.env.FLOOD_V2_TIDE_HIGH_CM || 12);
const TIDE_COUPLING = clamp(Number(process.env.FLOOD_V2_TIDE_ROAD_COUPLING || 0.35), 0, 2);
const RAIN_GAIN = clamp(Number(process.env.FLOOD_V2_RAIN_CM_PER_SIM_H || 1.5), 0, 10);
const ABNORMAL_JUMP_CM = Math.max(1, Number(process.env.FLOOD_V2_ABNORMAL_JUMP_CM || 5));
const ABNORMAL_WINDOW_SEC = Math.max(10, Number(process.env.FLOOD_V2_ABNORMAL_WINDOW_SECONDS || 30));

function regression(rows) {
  const pts = rows.map(r => ({ t: new Date(r.recorded_at).getTime(), v: num(r.water_level_cm) }))
    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v));
  if (pts.length < 3) return 0;
  const t0 = pts[0].t;
  const xs = pts.map(p => (p.t - t0) / 60000);
  const ys = pts.map(p => p.v);
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); }
  return den > 0 ? num / den : 0;
}

async function loadRoadHistory(minutes = ROAD_WINDOW_MIN) {
  const from = new Date(Date.now() - minutes * 60000);
  const [rows] = await pool.execute(
    "SELECT id,recorded_at,water_level_cm,jsn_valid,rain_detected,rain_tips_10s FROM " + DB +
    ".rain_node_readings WHERE recorded_at>=? ORDER BY recorded_at ASC,id ASC",
    [from]
  );
  return rows;
}

function rainStrength(rain) {
  if (!rain?.available) return 0;
  if (rain.rain_active) return 1;
  const s = Number(rain.rain_risk_score) || 0;
  return clamp((s - 25) / 75, 0, 1);
}

function onsetFactor(rain, horizon) {
  if (!rain?.available || rain.rain_active) return 1;
  const onset = rain.expected_onset;
  if (!onset) return 0;
  const start = Number(onset.min_sim_hours) || 0;
  if (horizon <= start) return 0.15;
  return clamp((horizon - start) / Math.max(1, horizon), 0.15, 1);
}

function alertFromLevel(v) {
  if (v >= DANGER_CM) return "DANGER";
  if (v >= WARNING_CM) return "WARNING";
  if (v >= WATCH_CM) return "WATCH";
  return "NORMAL";
}

function maxAlert(a, b) {
  const rank = { NORMAL: 0, WATCH: 1, WARNING: 2, DANGER: 3 };
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

function classifyCause({ rainRelevant, tideRelevant, abnormal }) {
  if (abnormal && !rainRelevant && !tideRelevant) return { code: "ABNORMAL", label: "Bất thường / cần kiểm tra" };
  if (rainRelevant && tideRelevant) return { code: "RAIN_TIDE", label: "Mưa + triều" };
  if (rainRelevant) return { code: "RAIN", label: "Mưa" };
  if (tideRelevant) return { code: "TIDE", label: "Triều" };
  return { code: "NONE", label: "Chưa xác định nguy cơ rõ ràng" };
}

function detectAbnormal(rows, rainRelevant, tideRelevant) {
  if (rainRelevant || tideRelevant || rows.length < 2) return { suspected: false, confirmed: false, max_jump_cm: 0, baseline_cm: null, age_seconds: null };
  let maxJump = 0, jumpAt = null, baseline = null;
  for (let i = 1; i < rows.length; i++) {
    const a = num(rows[i - 1].water_level_cm), b = num(rows[i].water_level_cm);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const jump = b - a;
    if (jump >= ABNORMAL_JUMP_CM && jump >= maxJump) {
      maxJump = jump;
      jumpAt = new Date(rows[i].recorded_at).getTime();
      baseline = a;
    }
  }
  const current = num(rows[rows.length - 1].water_level_cm);
  const stillElevated = Number.isFinite(current) && Number.isFinite(baseline) && current >= baseline + ABNORMAL_JUMP_CM * 0.6;
  const suspected = Number.isFinite(jumpAt) && stillElevated;
  const age = suspected ? Math.max(0, (Date.now() - jumpAt) / 1000) : null;
  return {
    suspected,
    confirmed: suspected && age >= ABNORMAL_WINDOW_SEC,
    max_jump_cm: round(maxJump),
    baseline_cm: suspected ? round(baseline) : null,
    age_seconds: round(age, 1)
  };
}

async function buildFloodForecast(options = {}) {
  const scale = Math.max(1, Number(options.simTimeScale || SCALE));
  const roadMinutes = clamp(Number(options.roadMinutes || ROAD_WINDOW_MIN), 1, 15);
  const [rows, rain, tide] = await Promise.all([
    loadRoadHistory(roadMinutes),
    buildRainForecast({ simTimeScale: scale }),
    buildTideForecast({ simTimeScale: scale })
  ]);

  const valid = rows.filter(r => Number(r.jsn_valid) === 1 && Number.isFinite(num(r.water_level_cm)));
  if (valid.length < 2) {
    return { available: false, reason: "NO_VALID_ROAD_LEVEL", message: "Chua du du lieu muc nuoc duong Node 1 de du bao ngap.", rain_forecast: rain, tide_forecast: tide };
  }

  const latest = valid[valid.length - 1];
  const current = num(latest.water_level_cm);
  const roadSlope = regression(valid);
  const currentTide = tide?.available ? num(tide.current?.tide_level_cm) : null;
  const tideForecastMap = new Map((tide?.forecast || []).map(x => [Number(x.horizon_sim_hours), num(x.level_cm)]));
  const maxTideForecast = tide?.available ? Math.max(Number.isFinite(currentTide) ? currentTide : -Infinity, ...(tide.forecast || []).map(x => num(x.level_cm)).filter(Number.isFinite)) : null;
  const rainRelevant = Boolean(rain?.rain_active || (Number(rain?.rain_risk_score) || 0) >= 56);
  const tideRelevant = Boolean(tide?.available && Number.isFinite(maxTideForecast) && maxTideForecast >= TIDE_HIGH_CM);
  const abnormal = detectAbnormal(valid, rainRelevant, tideRelevant);
  const rStrength = rainStrength(rain);

  const forecastBase = abnormal.suspected && Number.isFinite(abnormal.baseline_cm) ? abnormal.baseline_cm : current;

  const forecast = [1, 2, 3].map(h => {
    const realMin = h * 60 / scale;
    const trendDamp = 1 / (1 + realMin / 4);
    const trendContribution = clamp(roadSlope * realMin * trendDamp, -3, 5);
    const rainContribution = RAIN_GAIN * rStrength * onsetFactor(rain, h) * h;
    const tf = tideForecastMap.get(h);
    const tideRise = Number.isFinite(tf) && Number.isFinite(currentTide) ? Math.max(0, tf - currentTide) : 0;
    const tideHighExtra = Number.isFinite(tf) ? Math.max(0, tf - TIDE_HIGH_CM) * 0.10 : 0;
    const tideContribution = tideRise * TIDE_COUPLING + tideHighExtra;
    let level = Math.max(0, forecastBase + trendContribution + rainContribution + tideContribution);

    if (abnormal.suspected && !rainRelevant && !tideRelevant) {
      level = Math.min(level, forecastBase + 0.5);
    }

    return {
      horizon_sim_hours: h,
      horizon_real_seconds: Math.round(h * 3600 / scale),
      road_level_cm: round(level),
      alert_level: alertFromLevel(level),
      contributions_cm: {
        road_trend: round(trendContribution),
        rain: round(rainContribution),
        tide: round(tideContribution)
      }
    };
  });

  const currentAlert = abnormal.suspected && !rainRelevant && !tideRelevant ? "WATCH" : alertFromLevel(current);
  let overall = currentAlert;
  for (const f of forecast) overall = maxAlert(overall, f.alert_level);
  const firstWarning = forecast.find(f => ["WARNING", "DANGER"].includes(f.alert_level)) || null;
  const earlyWarning = current < WARNING_CM && Boolean(firstWarning);
  const cause = classifyCause({ rainRelevant, tideRelevant, abnormal: abnormal.suspected });

  const dataQuality = clamp(valid.length / Math.max(6, roadMinutes * 6), 0, 1);
  const rainConf = rain?.available ? Number(rain.confidence) || 0.3 : 0.2;
  const tideConf = tide?.available ? Number(tide.confidence) || 0.3 : 0.2;
  let confidence = clamp(0.45 * dataQuality + 0.30 * rainConf + 0.25 * tideConf, 0.05, 0.95);
  if (abnormal.suspected) confidence *= 0.55;

  return {
    available: true,
    model: "FLOOD_FUSION_RULE_V1",
    generated_at: new Date().toISOString(),
    current: {
      recorded_at: latest.recorded_at,
      road_level_cm: round(current),
      road_trend: roadSlope >= 0.08 ? "RISING" : roadSlope <= -0.08 ? "FALLING" : "STABLE",
      road_slope_cm_per_real_min: round(roadSlope, 3),
      alert_level: currentAlert
    },
    forecast,
    overall_alert_level: overall,
    early_warning: earlyWarning,
    warning_horizon: firstWarning ? { sim_hours: firstWarning.horizon_sim_hours, real_seconds: firstWarning.horizon_real_seconds, predicted_road_level_cm: firstWarning.road_level_cm } : null,
    predicted_cause: cause,
    evidence: {
      rain_relevant: rainRelevant,
      tide_relevant: tideRelevant,
      sensor_abnormal_suspected: abnormal.suspected,
      sensor_abnormal_confirmed: abnormal.confirmed,
      abnormal_age_seconds: abnormal.age_seconds,
      abnormal_baseline_cm: abnormal.baseline_cm,
      max_recent_jump_cm: abnormal.max_jump_cm
    },
    thresholds_cm: { watch: WATCH_CM, warning: WARNING_CM, danger: DANGER_CM, tide_high: TIDE_HIGH_CM },
    confidence: round(confidence, 3),
    confidence_label: confidence >= 0.75 ? "HIGH" : confidence >= 0.5 ? "MEDIUM" : "LOW",
    time_model: { simulation_scale: scale, one_sim_hour_real_seconds: round(3600 / scale, 2) },
    inputs: { rain_forecast: rain, tide_forecast: tide },
    predictor_rules: {
      principle: "Forecast road level before threshold crossing by combining current road level/trend with rain forecast and tide forecast.",
      anti_false_alarm: "Unsupported abrupt road-level jumps are flagged as abnormal instead of automatically classified as flooding.",
      note: "This is a configurable rule-based demo model. Coefficients and thresholds should be calibrated from FloodGuard model runs before reporting them as physical flood-depth predictions."
    }
  };
}

module.exports = { buildFloodForecast, loadRoadHistory };
