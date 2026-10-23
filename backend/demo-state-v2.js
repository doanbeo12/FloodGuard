function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

const DURATION_SECONDS = Math.max(
  30,
  Number(process.env.RAIN_FAVORABLE_DEMO_DURATION_SECONDS || 180)
);

const state = {
  enabled: false,
  activatedAt: null
};

function setRainFavorableDemo(enabled) {
  const next = Boolean(enabled);
  if (next && !state.enabled) state.activatedAt = new Date();
  if (!next) state.activatedAt = null;
  state.enabled = next;
  return getRainFavorableDemo();
}

function getRainFavorableDemo() {
  const elapsed = state.enabled && state.activatedAt
    ? Math.max(0, (Date.now() - state.activatedAt.getTime()) / 1000)
    : 0;
  return {
    enabled: state.enabled,
    activated_at: state.activatedAt,
    elapsed_real_seconds: Number(elapsed.toFixed(1)),
    duration_real_seconds: DURATION_SECONDS,
    progress: state.enabled ? Number(clamp(elapsed / DURATION_SECONDS, 0, 1).toFixed(3)) : 0
  };
}

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function applyRainFavorableEnvironment(row) {
  if (!row) return row;
  const demo = getRainFavorableDemo();
  if (!demo.enabled) return row;

  const p = demo.progress;
  const out = { ...row };
  const temp = finite(row.temperature_c);
  const humidity = finite(row.humidity_pct);
  const pressure = finite(row.pressure_hpa);
  const dew = finite(row.dew_spread_c);
  const wind = finite(row.wind_rpm);

  if (temp != null) out.temperature_c = Number((temp - 1.2 * p).toFixed(2));
  if (humidity != null) out.humidity_pct = Number(clamp(humidity + 12 * p, 0, 100).toFixed(2));
  if (pressure != null) out.pressure_hpa = Number((pressure - 1.5 * p).toFixed(2));
  if (dew != null) out.dew_spread_c = Number(Math.max(0.3, dew - 3.2 * p).toFixed(2));
  if (wind != null) out.wind_rpm = Number((wind * (1 + 1.0 * p) + 20 * p).toFixed(1));

  out.demo_environment_simulated = 1;
  out.demo_environment_progress = p;
  return out;
}

module.exports = {
  setRainFavorableDemo,
  getRainFavorableDemo,
  applyRainFavorableEnvironment
};
