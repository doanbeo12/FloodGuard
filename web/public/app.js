const API = String(window.FLOODGUARD_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const $ = (id) => document.getElementById(id);

const state = {
  sites: [],
  siteId: null,
  status: null,
  history: [],
  weather: [],
  timers: [],
};

function fmtNumber(v, digits = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '--';
}
function fmtDateTime(value) {
  if (!value) return '--';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('vi-VN', { hour12: false });
}
function fmtEvent(e) {
  if (!e) return '--';
  const type = e.type === 'HIGH' ? 'Đỉnh' : e.type === 'LOW' ? 'Chân' : (e.type || 'Mốc');
  const level = Number(e.level_m);
  const levelText = Number.isFinite(level) ? `${level.toFixed(2)} m` : '--';
  const time = e.event_time || e.time || '--';
  const date = e.effective_date || e.forecast_date || '';
  return `${type} ${time.slice(0,5)} ${date} • ${levelText}`.trim();
}
function alertLabel(level) {
  const n = Number(level || 0);
  if (n >= 3) return 'Cảnh báo ngập';
  if (n >= 2) return 'Nguy cơ cao';
  if (n >= 1) return 'Cảnh báo';
  return 'Bình thường';
}
function trendLabel(v) {
  return ({RISING:'Đang tăng', FALLING:'Đang giảm', STABLE:'Ổn định'})[v] || 'Chưa xác định';
}
function showError(message) {
  const el = $('errorBox');
  if (!message) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = message;
  el.classList.remove('hidden');
}
async function getJson(path) {
  const res = await fetch(`${API}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} khi gọi ${path}`);
  return res.json();
}

async function loadSites() {
  const result = await getJson('/api/sites');
  state.sites = Array.isArray(result.data) ? result.data : [];
  if (!state.siteId && state.sites.length) state.siteId = Number(state.sites[0].site_id);
  renderSiteSelect();
  renderSystemPill();
}

function renderSiteSelect() {
  const select = $('siteSelect');
  const current = String(state.siteId ?? '');
  select.replaceChildren();
  for (const site of state.sites) {
    const opt = document.createElement('option');
    opt.value = String(site.site_id);
    opt.textContent = `${site.site_name || `Site ${site.site_id}`}${site.street_name ? ` • ${site.street_name}` : ''}`;
    select.appendChild(opt);
  }
  if (current) select.value = current;
}

function renderSystemPill() {
  const pill = $('systemPill');
  const online = state.sites.filter(s => s.connection_status === 'ONLINE').length;
  if (!state.sites.length) {
    pill.className = 'pill neutral'; pill.textContent = 'Chưa có dữ liệu'; return;
  }
  if (online > 0) {
    pill.className = 'pill ok'; pill.textContent = `${online}/${state.sites.length} khu vực online`;
  } else {
    pill.className = 'pill danger'; pill.textContent = 'Hệ thống offline';
  }
}

async function loadStatus() {
  if (!state.siteId) return;
  const result = await getJson(`/api/sites/${state.siteId}/status`);
  state.status = result;
  renderStatus();
}

function renderStatus() {
  const s = state.status || {};
  const d = s.data || {};
  $('maxWater').textContent = fmtNumber(d.max_water_level, 1);
  $('alertText').textContent = alertLabel(d.alert_level);
  $('scenarioText').textContent = d.scenario || '--';
  $('causeText').textContent = s.flood_cause_label || '--';
  $('rainText').textContent = d.raining === true ? 'Đang có mưa' : d.raining === false ? 'Không có mưa' : '--';
  $('connectionText').textContent = s.connection_status || '--';
  $('recordedAtText').textContent = fmtDateTime(d.recorded_at);

  $('node1Water').textContent = fmtNumber(d.node1_water_level, 1);
  $('node2Water').textContent = fmtNumber(d.node2_water_level, 1);
  $('node1Online').textContent = d.node1_online ? 'ONLINE' : 'OFFLINE';
  $('node2Online').textContent = d.node2_online ? 'ONLINE' : 'OFFLINE';
  $('node1Online').className = `dot-label ${d.node1_online ? 'online' : 'offline'}`;
  $('node2Online').className = `dot-label ${d.node2_online ? 'online' : 'offline'}`;
  $('node1Pdr').textContent = `PDR: ${fmtNumber(d.node1_pdr, 1)}%`;
  $('node2Pdr').textContent = `PDR: ${fmtNumber(d.node2_pdr, 1)}%`;
  $('trendText').textContent = trendLabel(d.trend);
  $('rateText').textContent = Number.isFinite(Number(d.rate_cm_min)) ? `${Number(d.rate_cm_min).toFixed(3)} cm/phút` : '--';
  $('earlyText').textContent = d.early_warning ? 'Có cảnh báo sớm' : 'Không';
  $('flowText').textContent = d.flow_direction || '--';

  const tide = s.tide || {};
  $('tideStation').textContent = `Trạm: ${tide.station || s.site?.tide_station || '--'}`;
  $('tidePhase').textContent = tide.phase_label || '--';
  $('tideNext').textContent = fmtEvent(tide.next_event);
  $('tideHigh').textContent = fmtEvent(tide.next_high);
  $('tideBulletin').textContent = tide.bulletin_date || '--';
  const fresh = $('tideFresh');
  if (!tide.available) { fresh.className = 'pill neutral'; fresh.textContent = 'Không có dữ liệu'; }
  else if (tide.stale) { fresh.className = 'pill warn'; fresh.textContent = 'Dữ liệu cũ'; }
  else { fresh.className = 'pill ok'; fresh.textContent = 'Cập nhật'; }
}

async function loadHistory() {
  if (!state.siteId) return;
  const result = await getJson(`/api/sites/${state.siteId}/history?hours=6&limit=500`);
  state.history = Array.isArray(result.data) ? result.data : [];
  drawChart();
}

async function loadWeather() {
  if (!state.siteId) return;
  const result = await getJson(`/api/sites/${state.siteId}/weather/hourly?hours=24`);
  state.weather = Array.isArray(result.hourly) ? result.hourly : [];
  renderWeather();
}

function renderWeather() {
  const strip = $('weatherStrip');
  strip.replaceChildren();
  if (!state.weather.length) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Chưa có dữ liệu dự báo.'; strip.appendChild(empty); return;
  }
  for (const item of state.weather) {
    const d = new Date(item.time);
    const card = document.createElement('div'); card.className = 'weather-card';
    const time = document.createElement('div'); time.className = 'time'; time.textContent = Number.isNaN(d.getTime()) ? '--:--' : d.toLocaleTimeString('vi-VN', {hour:'2-digit', minute:'2-digit', hour12:false});
    const temp = document.createElement('div'); temp.className = 'temp'; temp.textContent = `${fmtNumber(item.temperature_c, 0)}°`;
    const cond = document.createElement('div'); cond.className = 'condition'; cond.textContent = item.condition_label || item.condition || '--';
    const rain = document.createElement('div'); rain.className = 'rain'; rain.textContent = `Mưa ${fmtNumber(item.rain_probability, 0)}% • ${fmtNumber(item.rain_mm, 1)} mm`;
    card.append(time, temp, cond, rain); strip.appendChild(card);
  }
}

function drawChart() {
  const canvas = $('historyChart');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(600, Math.round(rect.width * dpr));
  canvas.height = Math.max(260, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.clearRect(0,0,w,h);

  const rows = state.history.filter(r => r.recorded_at);
  if (rows.length < 2) {
    ctx.fillStyle = '#6b7a90'; ctx.font = '14px sans-serif'; ctx.fillText('Chưa đủ dữ liệu lịch sử để vẽ biểu đồ.', 24, 40); return;
  }
  const values = [];
  for (const r of rows) for (const k of ['node1_water_level','node2_water_level','max_water_level']) {
    const v = Number(r[k]); if (Number.isFinite(v)) values.push(v);
  }
  if (!values.length) return;
  const min = Math.min(0, ...values);
  const max = Math.max(...values, 3);
  const pad = {l:48,r:18,t:18,b:34};
  const x0=pad.l, y0=pad.t, cw=w-pad.l-pad.r, ch=h-pad.t-pad.b;
  const x = i => x0 + (i/(rows.length-1))*cw;
  const y = v => y0 + ch - ((v-min)/(max-min || 1))*ch;

  ctx.strokeStyle = '#e6edf4'; ctx.lineWidth = 1;
  ctx.fillStyle = '#7a899d'; ctx.font = '11px sans-serif';
  for (let i=0;i<=4;i++) {
    const v = min + (max-min)*i/4; const yy=y(v);
    ctx.beginPath(); ctx.moveTo(x0,yy); ctx.lineTo(x0+cw,yy); ctx.stroke();
    ctx.fillText(v.toFixed(1), 7, yy+4);
  }
  const series = [
    ['node1_water_level','#2563eb'],
    ['node2_water_level','#7c3aed'],
    ['max_water_level','#ef4444'],
  ];
  for (const [key,color] of series) {
    ctx.strokeStyle=color; ctx.lineWidth=2; ctx.beginPath(); let started=false;
    rows.forEach((r,i)=>{ const v=Number(r[key]); if(!Number.isFinite(v)) return; const xx=x(i), yy=y(v); if(!started){ctx.moveTo(xx,yy);started=true;}else ctx.lineTo(xx,yy); });
    ctx.stroke();
  }
  ctx.fillStyle='#7a899d'; ctx.font='11px sans-serif';
  [0, Math.floor((rows.length-1)/2), rows.length-1].forEach(i=>{
    const d=new Date(rows[i].recorded_at); if(Number.isNaN(d.getTime())) return;
    const label=d.toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',hour12:false});
    ctx.fillText(label, Math.max(x0, Math.min(x(i)-16,w-50)), h-9);
  });
}

async function refreshRealtime() {
  try {
    await Promise.all([loadSites(), loadStatus()]);
    showError('');
  } catch (e) {
    showError(`Không thể cập nhật dữ liệu realtime: ${e.message}`);
  }
}
async function refreshSlow() {
  try { await loadHistory(); } catch (_) {}
}
async function refreshWeather() {
  try { await loadWeather(); } catch (_) {}
}
async function refreshAll() {
  await refreshRealtime();
  await Promise.allSettled([refreshSlow(), refreshWeather()]);
}
function resetTimers() {
  state.timers.forEach(clearInterval);
  state.timers = [
    setInterval(refreshRealtime, 5000),
    setInterval(refreshSlow, 15000),
    setInterval(refreshWeather, 10 * 60 * 1000),
  ];
}
function tickClock() {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString('vi-VN', {hour12:false});
  $('dateText').textContent = d.toLocaleDateString('vi-VN', {weekday:'long', day:'2-digit', month:'2-digit', year:'numeric'});
}

$('siteSelect').addEventListener('change', async (e) => {
  state.siteId = Number(e.target.value);
  state.status = null; state.history = []; state.weather = [];
  await refreshAll();
});
$('refreshBtn').addEventListener('click', refreshAll);
window.addEventListener('resize', () => requestAnimationFrame(drawChart));

(async function init() {
  tickClock(); setInterval(tickClock, 1000);
  try {
    await loadSites();
    await refreshAll();
    resetTimers();
  } catch (e) {
    showError(`Không thể kết nối FloodGuard API (${API}): ${e.message}`);
  }
})();
