const API_BASE = String(window.FLOODGUARD_API_BASE_URL || "").replace(/\/$/, "");

function cleanupLegacyUi(){
  const removeAll = selector => document.querySelectorAll(selector).forEach(node => node.remove());

  // The live JS also cleans cached legacy HTML so the UI stays consistent
  // immediately after a deployment, even if an old index.html is still cached.
  removeAll(".alert-title");
  removeAll(".alert-message");
  removeAll(".scenario-code");
  removeAll(".mini-label");
  removeAll(".node-label");
  removeAll(".nav-hint");
  removeAll(".history-note");

  const headerSubtitle = document.querySelector(".dashboard-header > div:first-child > p");
  if(headerSubtitle) headerSubtitle.remove();

  document.querySelectorAll(".sensor-metric small:not([id])").forEach(node => node.remove());
  document.querySelectorAll(".history-control-card p").forEach(node => node.remove());

  const statusTable = document.querySelector(".status-table");
  if(statusTable){
    const headCells = statusTable.querySelectorAll("thead th");
    if(headCells.length >= 3) headCells[2].remove();
    statusTable.querySelectorAll("tbody tr").forEach(row => {
      const cells = row.querySelectorAll("td");
      if(cells.length >= 3) cells[2].remove();
    });
  }

  const footer = document.querySelector(".dashboard-footer");
  if(footer) footer.textContent = "FloodGuard";
}

cleanupLegacyUi();
const el = id => document.getElementById(id);
const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) ? null : Number(v);
const fmt = (v,d=1) => num(v) === null ? "--" : num(v).toFixed(d);
const timeText = v => {
  if(!v) return "--";
  const d=new Date(v); if(Number.isNaN(d.getTime())) return "--";
  return d.toLocaleString("vi-VN",{hour12:false});
};
const ageSec = v => v ? (Date.now()-new Date(v).getTime())/1000 : Infinity;
const label = {
  NORMAL:"BÌNH THƯỜNG",WATCH:"THEO DÕI",WARNING:"CẢNH BÁO",DANGER:"NGUY HIỂM",
  LOW:"THẤP",MEDIUM:"TRUNG BÌNH",HIGH:"CAO",VERY_HIGH:"RẤT CAO",RAIN_ACTIVE:"ĐANG MƯA",
  RISING:"Đang tăng",FALLING:"Đang giảm",STABLE:"Ổn định"
};
const onsetLabel = x => {
  if(!x) return "--";
  const map={NOW:"Đang mưa",WITHIN_1H:"Trong 1 giờ tới",WITHIN_1_TO_2H:"Trong 1–2 giờ tới",WITHIN_2_TO_3H:"Trong 2–3 giờ tới"};
  return map[x.label] || x.label || "--";
};
const badgeClass = code => {
  if(["NORMAL","LOW","HIGH_CONF"].includes(code)) return "good";
  if(["WATCH","MEDIUM"].includes(code)) return "watch";
  if(["WARNING","HIGH"].includes(code)) return "warn";
  if(["DANGER","VERY_HIGH","RAIN_ACTIVE"].includes(code)) return "danger";
  return "muted";
};
function setBadge(node, text, code){
  if(!node) return;
  node.textContent=text; node.className="status-pill "+badgeClass(code);
}
async function getJson(path){
  const r=await fetch(API_BASE+path,{cache:"no-store"});
  let data={}; try{data=await r.json();}catch(_){}
  if(!r.ok && r.status!==202) throw new Error(data.error || ("HTTP "+r.status));
  return data;
}
async function postJson(path,body){
  const r=await fetch(API_BASE+path,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(body||{}),
    cache:"no-store"
  });
  let data={}; try{data=await r.json();}catch(_){}
  if(!r.ok) throw new Error(data.error || ("HTTP "+r.status));
  return data;
}
let rainDemoEnabled=false;
function renderRainDemo(state){
  rainDemoEnabled=Boolean(state?.enabled);
  const btn=el("rainDemoBtn");
  if(!btn) return;
  btn.className="btn w-100 "+(rainDemoEnabled?"btn-warning":"btn-outline-primary");
  btn.innerHTML='<i class="fa-solid fa-cloud-rain"></i> Điều kiện có lợi cho mưa: '+(rainDemoEnabled?"BẬT":"TẮT");
}
let chart=null;
let liveNodes={node1:false,node2:false};
function ensureChart(){
  if(chart) return chart;
  chart=new Chart(el("waterChart"),{
    type:"line",
    data:{labels:[],datasets:[
      {label:"Mực nước đường (cm)",data:[],borderWidth:2,tension:.25,pointRadius:0},
      {label:"Mực triều (cm)",data:[],borderWidth:2,tension:.25,pointRadius:0}
    ]},
    options:{responsive:true,maintainAspectRatio:false,animation:false,plugins:{legend:{position:"top"}},scales:{x:{ticks:{maxTicksLimit:10}},y:{beginAtZero:true,title:{display:true,text:"cm"}}}}
  });
  return chart;
}
function renderLatest(d){
  const n1=d.node1||{},n2=d.node2||{},c=d.collector||{};
  const t1=c.node1LastReceivedAt || n1.mqtt_received_at || n1.recorded_at;
  const t2=c.node2LastReceivedAt || n2.mqtt_received_at || n2.recorded_at;
  const node1Fresh=d.live?.node1===false?false:ageSec(t1)>=-5 && ageSec(t1)<=30;
  const node2Fresh=d.live?.node2===false?false:ageSec(t2)>=-5 && ageSec(t2)<=30;
  liveNodes={node1:node1Fresh,node2:node2Fresh};
  const centralReported=String(c.centralStatus||"").trim().toLowerCase();
  const centralHeartbeatFresh=ageSec(c.lastCentralStatusAt)<=45 && ["online","connected","1","true"].includes(centralReported);
  const centralFresh=centralHeartbeatFresh || node1Fresh || node2Fresh;

  el("roadLevel").textContent=node1Fresh?fmt(n1.water_level_cm):"--";
  el("roadUpdated").textContent=timeText(t1);
  el("tideLevel").textContent=node2Fresh?fmt(n2.tide_level_cm):"--";
  el("tideUpdated").textContent=timeText(t2);

  const road=node1Fresh?num(n1.water_level_cm):null;
  const tide=node2Fresh?num(n2.tide_level_cm):null;
  if(el("roadMarker")) el("roadMarker").style.left=Math.max(0,Math.min(100,(road||0)/16*100))+"%";
  if(el("tideMarker")) el("tideMarker").style.left=Math.max(0,Math.min(100,(tide||0)/16*100))+"%";

  const raining=node1Fresh && Number(n1.rain_detected)===1;
  el("rainState").textContent=node1Fresh?(raining?"ĐANG MƯA":"KHÔ"):"MẤT KẾT NỐI";
  el("rainState").style.color=!node1Fresh?"#6b7280":(raining?"#1769aa":"#159447");
  setBadge(el("rainStateBadge"),node1Fresh?(raining?"MƯA":"KHÔ"):"MẤT KẾT NỐI",node1Fresh?(raining?"RAIN_ACTIVE":"NORMAL"):"WARNING");
  el("rainFlow").textContent=node1Fresh?fmt(n1.rain_flow_ml_s,2)+" ml/s":"--";
  el("rainVolume").textContent=node1Fresh?fmt(n1.rain_volume_ml_interval ?? n1.rain_ml_interval,1)+" ml":"--";
  el("tipsInterval").textContent=node1Fresh?(n1.rain_tips_interval ?? n1.rain_tips_10s ?? "--"):"--";
  el("tipsTotal").textContent=node1Fresh?(n1.rain_tips_total ?? "--"):"--";

  el("temperature").textContent=node1Fresh?fmt(n1.temperature_c)+" °C":"--";
  el("humidity").textContent=node1Fresh?fmt(n1.humidity_pct)+" %":"--";
  el("pressure").textContent=node1Fresh?fmt(n1.pressure_hpa)+" hPa":"--";
  el("dewSpread").textContent=node1Fresh?fmt(n1.dew_spread_c)+" °C":"--";
  el("windRpm").textContent=node1Fresh?fmt(n1.wind_rpm,0)+" RPM":"--";
  el("rainSensor").textContent=node1Fresh?(raining?"ƯỚT":"KHÔ"):"--";

  setBadge(el("station1Badge"),"Trạm mưa: "+(node1Fresh?"trực tuyến":"mất kết nối"),node1Fresh?"NORMAL":"WARNING");
  setBadge(el("station2Badge"),"Trạm triều: "+(node2Fresh?"trực tuyến":"mất kết nối"),node2Fresh?"NORMAL":"WARNING");
  setBadge(el("centralBadge"),"Trạm trung tâm: "+(centralFresh?"trực tuyến":"mất kết nối"),centralFresh?"NORMAL":"WARNING");

  el("station1Time").textContent=timeText(t1);
  el("station2Time").textContent=timeText(t2);
  el("centralStatus").textContent=centralFresh?"TRỰC TUYẾN":"MẤT KẾT NỐI";
  el("lastSave").textContent=timeText(c.lastSaveAt);

  if(el("station1StatusTable")) el("station1StatusTable").textContent=(node1Fresh?"Trực tuyến • ":"Mất kết nối • ")+timeText(t1);
  if(el("station2StatusTable")) el("station2StatusTable").textContent=(node2Fresh?"Trực tuyến • ":"Mất kết nối • ")+timeText(t2);
  if(el("centralStatusTable")) el("centralStatusTable").textContent=centralFresh?"Trực tuyến":"Mất kết nối";
  if(el("serverStatusTable")) el("serverStatusTable").textContent="API hoạt động • lưu gần nhất "+timeText(c.lastSaveAt);
}
function trendText(v,unit){
  const n=num(v); if(n===null) return "Xu hướng: --";
  const arrow=n>0?"↑":n<0?"↓":"→";
  return "Xu hướng: "+arrow+" "+(n>0?"+":"")+n.toFixed(3)+" "+unit;
}
function renderForecast(d){
  const rain=d.rain||{},tide=d.tide||{},flood=d.flood||{};
  if(rain.available){
    el("rainNoData").classList.add("d-none");
    el("rainScore").textContent=fmt(rain.rain_risk_score,0);
    const rr=rain.rain_risk_label || "--";
    setBadge(el("rainRiskBadge"),label[rr]||rr,rr);
    el("rainOnset").textContent=onsetLabel(rain.expected_onset);
    el("rainConfidence").textContent=(label[rain.confidence_label]||rain.confidence_label||"--")+" ("+fmt((num(rain.confidence)||0)*100,0)+"%)";
    el("rainForecastStatus").textContent=rain.rain_active?"Mưa đã được xác nhận":"Đang dự báo";
    const tr=rain.trends_per_real_minute||{};
    el("temperatureTrend").textContent=trendText(tr.temperature_c,"°C/phút");
    el("humidityTrend").textContent=trendText(tr.humidity_pct,"%/phút");
    el("pressureTrend").textContent=trendText(tr.pressure_hpa,"hPa/phút");
    el("dewTrend").textContent=trendText(tr.dew_spread_c,"°C/phút");
    el("windTrend").textContent=trendText(tr.wind_rpm,"RPM/phút");
  }else{
    el("rainNoData").classList.remove("d-none");
    el("rainNoData").textContent=rain.message||"Chưa đủ dữ liệu môi trường để dự báo mưa.";
    el("rainScore").textContent="--"; setBadge(el("rainRiskBadge"),"CHỜ DỮ LIỆU","UNKNOWN");
    el("rainOnset").textContent="--";
    el("rainConfidence").textContent="--";
    el("rainForecastStatus").textContent="Tạm dừng";
    ["temperatureTrend","humidityTrend","pressureTrend","dewTrend","windTrend"].forEach(id=>el(id).textContent="Xu hướng: --");
  }

  // Tide forecast card displays only horizon and predicted water level.
  ["tideConfidenceBadge","tideCycleInfo"].forEach(id=>{const node=el(id);if(node)node.style.display="none";});
  if(tide.available){
    el("tideNoData").classList.add("d-none");
    el("tideTrend").textContent=tide.current?.trend==="UNKNOWN"?"Chưa đủ dữ liệu":(label[tide.current?.trend]||tide.current?.trend||"--");
    el("tideForecastRows").innerHTML=(tide.forecast||[]).filter(x=>x.horizon_sim_hours<=3).map(x=>
      '<div class="forecast-row"><span>'+x.horizon_sim_hours+' giờ</span><strong>'+fmt(x.level_cm)+' cm</strong></div>'
    ).join("") + (tide.training_status==="WARMING_UP"
      ? '<div class="empty-note">Ước tính sơ bộ • Độ tin cậy thấp (đang thu thập dữ liệu chu kỳ)</div>' : '')
      + (tide.stale_data
      ? '<div class="empty-note">Dự báo từ dữ liệu lịch sử • Chưa có mẫu triều mới</div>' : '');
  }else{
    el("tideNoData").classList.remove("d-none");
    el("tideNoData").textContent=tide.message||"Chưa đủ dữ liệu mực triều để dự báo.";
    el("tideTrend").textContent="--";
    el("tideForecastRows").innerHTML='<div class="empty-note">Tạm dừng dự báo triều.</div>';
  }

  if(flood.available){
    el("floodNoData").classList.add("d-none");
    const lvl=flood.overall_alert_level||"NORMAL";
    setBadge(el("floodBadge"),label[lvl]||lvl,lvl);
    const cur=flood.current||{};
    el("roadTrend").textContent=(label[cur.road_trend]||cur.road_trend||"--")+" • "+fmt(cur.road_slope_cm_per_real_min,3)+" cm/phút";
    el("floodForecastRows").innerHTML=(flood.forecast||[]).map(x=>'<div class="forecast-row"><span>'+x.horizon_sim_hours+' giờ</span><strong>'+fmt(x.road_level_cm)+' cm</strong><em>'+(label[x.alert_level]||x.alert_level)+'</em></div>').join("");
    const rawCause=flood.predicted_cause?.label;
    const cause=(lvl==="NORMAL" || !rawCause || /^(không rõ|không xác định|chưa xác định|unknown|none|normal)$/i.test(String(rawCause).trim()))?"--":rawCause;
    const wc=el("warningCard"); wc.className="dashboard-card warning-card "+(lvl==="WATCH"?"watch":lvl==="WARNING"?"warning":lvl==="DANGER"?"danger":"normal");
    setBadge(el("floodTopBadge"),label[lvl]||lvl,lvl);
    el("warningLevel").textContent=label[lvl]||lvl;
    el("warningCause").textContent="Nguyên nhân: "+cause;
    el("warningConfidence").style.display="none";
    const wh=flood.warning_horizon;
    if(flood.early_warning && wh){
      el("warningMessage").style.display="";
      el("warningMessage").textContent="Cảnh báo sớm: dự báo mực nước đường có thể đạt "+fmt(wh.predicted_road_level_cm)+" cm sau khoảng "+wh.sim_hours+" giờ mô phỏng.";
      el("earlyWarningText").textContent="Cảnh báo sớm đang hoạt động • Nguyên nhân dự kiến: "+cause;
      el("earlyWarningText").classList.add("active");
    }else{
      el("warningMessage").textContent="";
      el("warningMessage").style.display="none";
      el("earlyWarningText").textContent="Cảnh báo sớm: chưa kích hoạt • Nguyên nhân dự kiến: "+cause;
      el("earlyWarningText").classList.remove("active");
    }
  }else{
    el("floodNoData").classList.remove("d-none");
    el("floodNoData").textContent=flood.message||"Chưa đủ dữ liệu để dự báo ngập.";
    setBadge(el("floodBadge"),"CHỜ DỮ LIỆU","UNKNOWN");
    setBadge(el("floodTopBadge"),"CHỜ DỮ LIỆU","UNKNOWN");
    el("roadTrend").textContent="--";
    el("floodForecastRows").innerHTML='<div class="empty-note">Tạm dừng dự báo ngập.</div>';
    el("warningCard").className="dashboard-card warning-card normal";
    el("warningLevel").textContent="CHỜ DỮ LIỆU";
    el("warningCause").textContent="Nguyên nhân: --";
    el("warningConfidence").style.display="none";
    el("earlyWarningText").textContent="Cảnh báo sớm: tạm dừng do thiếu dữ liệu trực tiếp.";
    el("earlyWarningText").classList.remove("active");
    el("warningMessage").style.display="";
    el("warningMessage").textContent=flood.message||"Chưa đủ dữ liệu để dự báo ngập.";
  }
}
function renderHistory(rain,tide){
  const r=(rain?.data||[]).slice(-120),t=(tide?.data||[]).slice(-120);
  const times=[...new Set([...r.map(x=>new Date(x.recorded_at).getTime()),...t.map(x=>new Date(x.recorded_at).getTime())])].sort((a,b)=>a-b);
  const roadMap=new Map(r.map(x=>[new Date(x.recorded_at).getTime(),num(x.water_level_cm)]));
  const tideMap=new Map(t.map(x=>[new Date(x.recorded_at).getTime(),num(x.tide_level_cm)]));
  const c=ensureChart();
  c.data.labels=times.map(ms=>new Date(ms).toLocaleTimeString("vi-VN",{hour12:false}));
  c.data.datasets[0].data=times.map(ms=>roadMap.get(ms)??null);
  c.data.datasets[1].data=times.map(ms=>tideMap.get(ms)??null);
  c.update();
}
async function refreshMain(){
  let latestOk=false;
  try{
    const latest=await getJson("/api/v2/latest");
    renderLatest(latest);
    renderRainDemo(latest.demo?.rain_favorable);
    latestOk=true;
    setBadge(el("apiBadge"),"Máy chủ: hoạt động","NORMAL");
  }catch(e){
    console.error("latest",e);
    renderLatest({});
    setBadge(el("apiBadge"),"Máy chủ: lỗi dữ liệu hiện tại","DANGER");
    if(el("serverStatusTable")) el("serverStatusTable").textContent="Không lấy được dữ liệu hiện tại";
  }

  const results=await Promise.allSettled([
    getJson("/api/v2/rain/forecast?sim_scale=60"),
    getJson("/api/v2/tide/forecast?sim_scale=60"),
    getJson("/api/v2/flood/forecast?sim_scale=60")
  ]);
  const rain=results[0].status==="fulfilled"?results[0].value:{available:false,message:"Dự báo mưa đang tạm lỗi hoặc chưa đủ dữ liệu."};
  const tide=results[1].status==="fulfilled"?results[1].value:{available:false,message:"Dự báo triều đang tạm lỗi hoặc chưa đủ dữ liệu."};
  const flood=results[2].status==="fulfilled"?results[2].value:{available:false,message:"Dự báo ngập đang tạm lỗi hoặc chưa đủ dữ liệu."};
  renderForecast({
    rain:liveNodes.node1?rain:{available:false,message:"Trạm mưa mất kết nối; tạm dừng dự báo."},
    tide:liveNodes.node2?tide:{available:false,message:"Trạm triều mất kết nối; tạm dừng dự báo."},
    flood:liveNodes.node1&&liveNodes.node2?flood:{available:false,message:"Thiếu dữ liệu trực tiếp từ Node 1 hoặc Node 2; tạm dừng dự báo ngập."}
  });

  if(latestOk && results.some(x=>x.status==="rejected")){
    setBadge(el("apiBadge"),"Máy chủ: hoạt động • một phần dự báo lỗi","WARNING");
  }
}
function renderDeviceEvents(rows){
  const root=el("deviceHistoryList");
  if(!root) return;
  root.replaceChildren();
  if(!Array.isArray(rows)||!rows.length){
    const info=document.createElement("div");
    info.className="small text-muted";
    info.textContent="Chưa ghi nhận lần kết nối hoặc mất kết nối nào.";
    root.appendChild(info);
    return;
  }
  for(const item of rows){
    const online=String(item.event_type).toUpperCase()==="ONLINE";
    const card=document.createElement("div");
    card.className="py-2 border-bottom";
    const head=document.createElement("div");
    head.className="d-flex justify-content-between align-items-start gap-2";
    const name=document.createElement("span");
    name.className="small fw-semibold";
    name.textContent=item.device_name || ("Thiết bị "+item.device_id);
    const badge=document.createElement("span");
    badge.className="badge "+(online?"bg-success":"bg-danger");
    badge.textContent=online?"Đã kết nối":"Mất kết nối";
    head.append(name,badge);
    const time=document.createElement("div");
    time.className="small text-muted mt-1";
    time.textContent=item.occurred_at?new Date(item.occurred_at).toLocaleString("vi-VN",{timeZone:"Asia/Ho_Chi_Minh",hour12:false}):"--";
    card.append(head,time);
    root.appendChild(card);
  }
}
async function refreshDeviceEvents(){
  try{
    const result=await getJson("/api/v2/device/history?limit=30");
    renderDeviceEvents(result.data);
  }catch(e){
    console.error("device history",e);
    const root=el("deviceHistoryList");
    if(root) root.textContent="Không tải được lịch sử thiết bị.";
  }
}
async function refreshHistory(){
  try{
    const [rain,tide]=await Promise.all([getJson("/api/v2/rain/history?hours=1&limit=1000"),getJson("/api/v2/tide/history?hours=1&limit=1000")]);
    renderHistory(rain,tide);
  }catch(e){console.error("history",e);}
}
function tick(){el("clock").textContent=new Date().toLocaleTimeString("vi-VN",{hour12:false});}
el("refreshBtn").addEventListener("click",()=>{refreshMain();refreshHistory();refreshDeviceEvents();});
if(el("rainDemoBtn")) el("rainDemoBtn").addEventListener("click",async()=>{
  const btn=el("rainDemoBtn");
  btn.disabled=true;
  try{
    const result=await postJson("/api/v2/demo/rain-favorable",{enabled:!rainDemoEnabled});
    renderRainDemo(result.rain_favorable);
    await refreshMain();
  }catch(e){
    console.error("rain demo",e);
  }finally{
    btn.disabled=false;
  }
});
document.querySelectorAll(".dashboard-nav-link").forEach(a=>a.addEventListener("click",()=>{
  document.querySelectorAll(".dashboard-nav-link").forEach(x=>x.classList.remove("active"));
  a.classList.add("active");
}));
tick();setInterval(tick,1000);
refreshMain();refreshHistory();refreshDeviceEvents();
setInterval(refreshMain,5000);
setInterval(refreshHistory,30000);
setInterval(refreshDeviceEvents,30000);