const API_BASE = String(window.FLOODGUARD_API_BASE_URL || "").replace(/\/$/, "");
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
let chart=null;
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
  const node1Fresh=ageSec(t1)<=30;
  const node2Fresh=ageSec(t2)<=30;
  const centralReported=String(c.centralStatus||"").trim().toLowerCase();
  const centralHeartbeatFresh=ageSec(c.lastCentralStatusAt)<=45 && ["online","connected","1","true"].includes(centralReported);
  const centralFresh=centralHeartbeatFresh || node1Fresh || node2Fresh;

  el("roadLevel").textContent=fmt(n1.water_level_cm);
  el("roadUpdated").textContent=timeText(t1);
  el("tideLevel").textContent=fmt(n2.tide_level_cm);
  el("tideUpdated").textContent=timeText(t2);

  const road=num(n1.water_level_cm);
  const tide=num(n2.tide_level_cm);
  if(el("roadMarker")) el("roadMarker").style.left=Math.max(0,Math.min(100,(road||0)/16*100))+"%";
  if(el("tideMarker")) el("tideMarker").style.left=Math.max(0,Math.min(100,(tide||0)/16*100))+"%";

  const raining=Number(n1.rain_detected)===1;
  el("rainState").textContent=raining?"ĐANG MƯA":"KHÔ";
  el("rainState").style.color=raining?"#1769aa":"#159447";
  setBadge(el("rainStateBadge"),raining?"MƯA":"KHÔ",raining?"RAIN_ACTIVE":"NORMAL");
  el("tipsInterval").textContent=(n1.rain_tips_interval ?? n1.rain_tips_10s ?? "--");
  el("tipsTotal").textContent=(n1.rain_tips_total ?? "--");

  el("temperature").textContent=fmt(n1.temperature_c)+" °C";
  el("humidity").textContent=fmt(n1.humidity_pct)+" %";
  el("pressure").textContent=fmt(n1.pressure_hpa)+" hPa";
  el("dewSpread").textContent=fmt(n1.dew_spread_c)+" °C";
  el("windRpm").textContent=fmt(n1.wind_rpm,0)+" RPM";
  el("rainSensor").textContent=raining?"ƯỚT":"KHÔ";

  setBadge(el("station1Badge"),"Trạm mưa: "+(node1Fresh?"trực tuyến":"quá hạn"),node1Fresh?"NORMAL":"WARNING");
  setBadge(el("station2Badge"),"Trạm triều: "+(node2Fresh?"trực tuyến":"quá hạn"),node2Fresh?"NORMAL":"WARNING");
  setBadge(el("centralBadge"),"Trạm trung tâm: "+(centralFresh?"trực tuyến":"quá hạn"),centralFresh?"NORMAL":"WARNING");

  el("station1Time").textContent=timeText(t1);
  el("station2Time").textContent=timeText(t2);
  el("centralStatus").textContent=centralFresh?"TRỰC TUYẾN":"QUÁ HẠN";
  el("lastSave").textContent=timeText(c.lastSaveAt);

  if(el("station1StatusTable")) el("station1StatusTable").textContent=(node1Fresh?"Trực tuyến • ":"Quá hạn • ")+timeText(t1);
  if(el("station2StatusTable")) el("station2StatusTable").textContent=(node2Fresh?"Trực tuyến • ":"Quá hạn • ")+timeText(t2);
  if(el("centralStatusTable")) el("centralStatusTable").textContent=centralFresh?"Trực tuyến":"Quá hạn / chưa có heartbeat mới";
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
    el("rainScore").textContent="--"; setBadge(el("rainRiskBadge"),"CHƯA ĐỦ DỮ LIỆU","UNKNOWN");
  }

  if(tide.available){
    el("tideNoData").classList.add("d-none");
    el("tideTrend").textContent=label[tide.current?.trend]||tide.current?.trend||"--";
    setBadge(el("tideConfidenceBadge"),"Tin cậy "+(label[tide.confidence_label]||tide.confidence_label||"--"),tide.confidence_label==="HIGH"?"NORMAL":tide.confidence_label==="MEDIUM"?"WATCH":"UNKNOWN");
    el("tideForecastRows").innerHTML=(tide.forecast||[]).map(x=>'<div class="forecast-row"><span>+'+x.horizon_sim_hours+' giờ</span><strong>'+fmt(x.level_cm)+' cm</strong><em>'+((x.method==="SEASONAL_HISTORY")?"Theo chu kỳ":"Theo xu hướng")+'</em></div>').join("") || '<div class="empty-note">Chưa có điểm dự báo.</div>';
    const cyc=tide.learned_cycle;
    el("tideCycleInfo").textContent=cyc?"Chu kỳ học được: khoảng "+fmt(cyc.period_sim_hours,2)+" giờ mô phỏng • "+cyc.approximate_cycles_in_history+" chu kỳ":"Chưa nhận dạng được chu kỳ rõ.";
  }else{
    el("tideNoData").classList.remove("d-none"); setBadge(el("tideConfidenceBadge"),"CHƯA ĐỦ DỮ LIỆU","UNKNOWN");
  }

  if(flood.available){
    el("floodNoData").classList.add("d-none");
    const lvl=flood.overall_alert_level||"NORMAL";
    setBadge(el("floodBadge"),label[lvl]||lvl,lvl);
    const cur=flood.current||{};
    el("roadTrend").textContent=(label[cur.road_trend]||cur.road_trend||"--")+" • "+fmt(cur.road_slope_cm_per_real_min,3)+" cm/phút";
    el("floodForecastRows").innerHTML=(flood.forecast||[]).map(x=>'<div class="forecast-row"><span>+'+x.horizon_sim_hours+' giờ</span><strong>'+fmt(x.road_level_cm)+' cm</strong><em>'+(label[x.alert_level]||x.alert_level)+'</em></div>').join("");
    const cause=flood.predicted_cause?.label || "--";
    const wc=el("warningCard"); wc.className="dashboard-card warning-card "+(lvl==="WATCH"?"watch":lvl==="WARNING"?"warning":lvl==="DANGER"?"danger":"normal");
    setBadge(el("floodTopBadge"),label[lvl]||lvl,lvl);
    el("warningLevel").textContent=label[lvl]||lvl;
    el("warningCause").textContent="Nguyên nhân: "+cause;
    el("warningConfidence").textContent="Tin cậy: "+(label[flood.confidence_label]||flood.confidence_label||"--")+" ("+fmt((num(flood.confidence)||0)*100,0)+"%)";
    const wh=flood.warning_horizon;
    if(flood.early_warning && wh){
      el("warningMessage").textContent="Cảnh báo sớm: dự báo mực nước đường có thể đạt "+fmt(wh.predicted_road_level_cm)+" cm sau khoảng "+wh.sim_hours+" giờ mô phỏng.";
      el("earlyWarningText").textContent="Cảnh báo sớm đang hoạt động • Nguyên nhân dự kiến: "+cause;
      el("earlyWarningText").classList.add("active");
    }else{
      el("warningMessage").textContent="Chưa phát hiện nguy cơ vượt ngưỡng cảnh báo trong 3 giờ mô phỏng tới.";
      el("earlyWarningText").textContent="Cảnh báo sớm: chưa kích hoạt • Nguyên nhân dự kiến: "+cause;
      el("earlyWarningText").classList.remove("active");
    }
  }else{
    el("floodNoData").classList.remove("d-none"); setBadge(el("floodBadge"),"CHƯA ĐỦ DỮ LIỆU","UNKNOWN");
    setBadge(el("floodTopBadge"),"CHỜ DỮ LIỆU","UNKNOWN");
    el("warningLevel").textContent="CHỜ DỮ LIỆU"; el("warningMessage").textContent=flood.message || "Chưa đủ dữ liệu để dự báo ngập.";
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
    latestOk=true;
    setBadge(el("apiBadge"),"Máy chủ: hoạt động","NORMAL");
  }catch(e){
    console.error("latest",e);
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
  renderForecast({rain,tide,flood});

  if(latestOk && results.some(x=>x.status==="rejected")){
    setBadge(el("apiBadge"),"Máy chủ: hoạt động • một phần dự báo lỗi","WARNING");
  }
}
async function refreshHistory(){
  try{
    const [rain,tide]=await Promise.all([getJson("/api/v2/rain/history?hours=1&limit=1000"),getJson("/api/v2/tide/history?hours=1&limit=1000")]);
    renderHistory(rain,tide);
  }catch(e){console.error("history",e);}
}
function tick(){el("clock").textContent=new Date().toLocaleTimeString("vi-VN",{hour12:false});}
el("refreshBtn").addEventListener("click",()=>{refreshMain();refreshHistory();});
document.querySelectorAll(".dashboard-nav-link").forEach(a=>a.addEventListener("click",()=>{
  document.querySelectorAll(".dashboard-nav-link").forEach(x=>x.classList.remove("active"));
  a.classList.add("active");
}));
tick();setInterval(tick,1000);
refreshMain();refreshHistory();
setInterval(refreshMain,5000);
setInterval(refreshHistory,30000);