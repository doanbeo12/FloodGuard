"use strict";
// FloodGuard sensor-only, experimental DEMO forecast.
// 1 real minute = 1 simulated hour; 24/48/64h => 24/48/64 real minutes.
// No external weather API, tidal data or forecast services.
const SAMPLE_MAX = 540; // 90 min @ 10s
const MAX_AGE_MS = 30000;
const MIN_HISTORY_MS = 120000;
const SIM_HOURS_PER_REAL_MINUTE = 1;
const records = [];

const finite = x => typeof x==="number" && Number.isFinite(x);
const clamp = (x,min,max)=>Math.min(max,Math.max(min,x));
const round = (x,n=1)=>Math.round(x*10**n)/10**n;
function observe(d) {
  const now=Date.now();
  const p={
    at:now, seq:d.seq, temperatureC:finite(d.temperatureC)?d.temperatureC:null,
    humidityPct:finite(d.humidityPct)?d.humidityPct:null,
    pressureHpa:finite(d.pressureHpa)?d.pressureHpa:null,
    windRpm:finite(d.windRpm)?d.windRpm:null,
    rainTipsTotal:finite(d.rainTipsTotal)?d.rainTipsTotal:null,
    rainTipsInterval:finite(d.rainTipsInterval)?d.rainTipsInterval:null,
    raining:d.raining===true, rainPlateWet:d.rainPlateWet===true,
    aiLevelCm:d.aiValid===true && finite(d.aiLevelCm)?d.aiLevelCm:null,
    jsnLevelCm:finite(d.jsnLevelCm)?d.jsnLevelCm:null,
  };
  // Replace only actual telemetry; no synthetic timestamps or interpolation.
  records.push(p);
  while(records.length>SAMPLE_MAX || (records.length && now-records[0].at>90*60000))
    records.shift();
}
const mean=a=>a.reduce((sum,x)=>sum+x,0)/a.length;
function trend(key, windowMs=5*60000) {
  if(records.length<2)return null;
  const now=records[records.length-1].at;
  const valid=records.filter(r=>now-r.at<=windowMs && finite(r[key]));
  if(valid.length<2 || valid.at(-1).at-valid[0].at<MIN_HISTORY_MS)return null;
  // Slope per actual minute using two halves; robust against near-duplicate samples.
  const half=Math.floor(valid.length/2);
  const first=valid.slice(0,half), second=valid.slice(half);
  const a=mean(first.map(x=>x[key])), b=mean(second.map(x=>x[key]));
  const ta=mean(first.map(x=>x.at)),tb=mean(second.map(x=>x.at));
  if(tb-ta<30000)return null;
  return {perMinute:(b-a)/((tb-ta)/60000),spanMinutes:round((valid.at(-1).at-valid[0].at)/60000,2),first:a,last:b};
}
function dewpointC(t,rh) {
  if(!finite(t)||!finite(rh)||rh<=0||rh>100)return null;
  const a=17.62,b=243.12,g=Math.log(rh/100)+a*t/(b+t);
  return b*g/(a-g);
}
function forecast() {
  const now=Date.now();
  const last=records.at(-1);
  const fresh=!!last && now-last.at<=MAX_AGE_MS;
  const first=records[0];
  const historyMinutes=first?round((last.at-first.at)/60000,2):0;
  const base={experimental:true,source:"node1-sensors",
    timeScale:{realMinutesPerSimHour:1},
    horizons:[24,48,64],
    at:new Date(now).toISOString(),
    lastSensorAt:last?new Date(last.at).toISOString():null,
    historyMinutes, online:fresh,
    limitations:["Chỉ dự báo mô phỏng dựa trên cảm biến, không phải dự báo thời tiết/triều thực tế",
      "Chưa có Node triều; không dự báo biên độ hoặc đỉnh triều"]};
  if(!fresh)return {...base,ready:false,reason:"NODE_OFFLINE",rain:null,water:null};
  const p=trend("pressureHpa"),h=trend("humidityPct");
  const waterTrend=trend("aiLevelCm",5*60000);
  const rh=last.humidityPct, temp=last.temperatureC, dp=dewpointC(temp,rh);
  const spread=dp===null?null:temp-dp;
  const enough=historyMinutes>=2 && finite(rh) && finite(last.pressureHpa) && p && h;
  // Heuristic risk signals, NOT calibrated probability:
  // humid air, small dew-point depression, falling pressure, rising humidity.
  const rainNow=last.raining||last.rainPlateWet;
  let score=null,signals=[];
  if(enough){
    score=0;
    if(rh>=85){score+=2;signals.push("Độ ẩm cao");}
    else if(rh>=75){score+=1;signals.push("Độ ẩm tăng tiệm cận bão hòa");}
    if(spread!==null && spread<=3){score+=2;signals.push("Nhiệt độ gần điểm sương");}
    if(p.perMinute<=-0.08){score+=2;signals.push("Áp suất giảm");}
    else if(p.perMinute<=-0.025){score+=1;signals.push("Áp suất có xu hướng giảm");}
    if(h.perMinute>=0.2){score+=1;signals.push("Độ ẩm tăng");}
  }
  const rain={
    status:rainNow?"RAINING":enough?(score>=5?"HIGH":score>=3?"WATCH":"LOW"):"INSUFFICIENT_DATA",
    rainingNow:rainNow,
    score:enough?score:null,
    signals:rainNow?["Cảm biến đang ghi nhận mưa",...signals]:signals,
    pressureTrendHpaPerMin:p?round(p.perMinute,3):null,
    humidityTrendPctPerMin:h?round(h.perMinute,3):null,
    dewPointC:dp===null?null:round(dp),
    // A model without validated onset labels cannot claim exact rain start time.
    predictedRainStart:null,
    onsetNote:"Chưa đủ cơ sở xác định chính xác thời điểm bắt đầu mưa",
    byHorizon:base.horizons.map(hours=>({
      simHours:hours,realMinutes:hours,
      outlook:rainNow?"Đang có mưa":!enough?"Chưa đủ dữ liệu":
        score>=5?"Tín hiệu thuận lợi cho mưa":
        score>=3?"Có dấu hiệu cần theo dõi":"Chưa thấy dấu hiệu mưa rõ"
    }))
  };
  // Short-term AI level tendency only. Long horizon extrapolation is intentionally
  // prohibited: extending 3-minute trends 24–64 simulated hours invents precision.
  const waterValue=last.aiLevelCm;
  const water={
    currentCm:finite(waterValue)?round(waterValue,2):null,
    status:!finite(waterValue)?"AI_UNAVAILABLE":waterTrend?
      waterTrend.perMinute>0.03?"RISING":waterTrend.perMinute< -0.03?"FALLING":"STABLE":"COLLECTING_HISTORY",
    trendCmPerRealMin:waterTrend?round(waterTrend.perMinute,3):null,
    predictions:base.horizons.map(hours=>({simHours:hours,realMinutes:hours,
      estimatedCm:null,status:"NOT_AVAILABLE",
      note:"Chưa có mô hình chu kỳ được kiểm định cho chân trời dài"}))
  };
  // Three-hour simulated window (3 real minutes). Values are risk categories,
  // not calibrated probabilities or an unsupported centimeter extrapolation.
  const rain3h=rainNow?"RAINING":!enough?"INSUFFICIENT_DATA":
    score>=5?"HIGH":score>=3?"WATCH":"LOW";
  const waterReliable=finite(waterValue)&&waterTrend;
  const flood3h=!finite(waterValue)?"INSUFFICIENT_DATA":
    waterValue>=9?"HIGH":waterValue>=7?"WATCH":
    !waterReliable?"INSUFFICIENT_DATA":
    waterTrend.perMinute>0.08 && (rainNow||score>=3)?"WATCH":"LOW";
  const nearTerm={simHours:3,realMinutes:3,rainRisk:rain3h,
    floodRisk:flood3h,waterCm:finite(waterValue)?round(waterValue,2):null,
    waterTrend:water.status};
  return {...base,ready:!!enough,reason:enough?null:"COLLECTING_HISTORY",
    rain,water,nearTerm, tide:{available:false,reason:"NO_TIDE_SENSOR"}};
}
module.exports={observe,forecast};
