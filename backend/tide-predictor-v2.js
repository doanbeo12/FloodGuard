const { pool } = require("./db-v2");
require("dotenv").config();

function safeDb(name) {
  return /^[A-Za-z0-9_]+$/.test(String(name || "")) ? String(name) : "floodguard_v2";
}
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function mean(a) { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s,x)=>s+x,0)/v.length : null; }
function median(a) { const v=a.filter(Number.isFinite).slice().sort((x,y)=>x-y); if(!v.length)return null; const m=Math.floor(v.length/2); return v.length%2?v[m]:(v[m-1]+v[m])/2; }
function std(a) { const v=a.filter(Number.isFinite); if(v.length<2)return 0; const m=mean(v); return Math.sqrt(v.reduce((s,x)=>s+(x-m)*(x-m),0)/v.length); }
function pct(a,p) { const v=a.filter(Number.isFinite).slice().sort((x,y)=>x-y); if(!v.length)return null; const q=(v.length-1)*p,i=Math.floor(q),r=q-i; return v[i+1]==null?v[i]:v[i]+r*(v[i+1]-v[i]); }

const DB = safeDb(process.env.V2_DB_NAME || "floodguard_v2");
const DEF_HOURS = clamp(Number(process.env.TIDE_HISTORY_HOURS || 12), 6, 18);
const HORIZONS=[1,2,3,6,9];
const MODELS=["PERSISTENCE","DAMPED_TREND","SEASONAL_HISTORY","ANALOG_PATTERN"];
const CM_BOUNDS={min:0,max:16};
const DEF_RECENT = clamp(Number(process.env.TIDE_RECENT_MINUTES || 10), 5, 15);
const DEF_SCALE = Math.max(1, Number(process.env.TIDE_SIM_TIME_SCALE || 60));
const STEP_SEC = Math.max(5, Number(process.env.TIDE_PREDICTOR_SAMPLE_SECONDS || 10));
const MIN_PERIOD_SEC = Math.max(60, Number(process.env.TIDE_MIN_PERIOD_SECONDS || 90));
const MAX_PERIOD_SEC = Math.max(MIN_PERIOD_SEC + 60, Number(process.env.TIDE_MAX_PERIOD_SECONDS || 3600));
const MIN_LEVEL = Number(process.env.TIDE_MODEL_MIN_LEVEL_CM || 0);
const MAX_LEVEL = Number(process.env.TIDE_MODEL_MAX_LEVEL_CM || 16);

function regression(points) {
  if (points.length < 2) return 0;
  const t0 = points[0].t;
  const xs = points.map(p => (p.t - t0) / 60000);
  const ys = points.map(p => p.v);
  const mx=mean(xs), my=mean(ys);
  let n=0,d=0;
  for(let i=0;i<xs.length;i++){n+=(xs[i]-mx)*(ys[i]-my);d+=(xs[i]-mx)*(xs[i]-mx);}
  return d>0?n/d:0;
}

function normalize(rows) {
  return rows.map(r=>({t:new Date(r.recorded_at).getTime(),v:Number(r.tide_level_cm)}))
    .filter(p=>Number.isFinite(p.t)&&Number.isFinite(p.v)).sort((a,b)=>a.t-b.t);
}

function resample(points, stepMs) {
  if(points.length<2)return null;
  const start=Math.ceil(points[0].t/stepMs)*stepMs;
  const end=Math.floor(points[points.length-1].t/stepMs)*stepMs;
  const out=[]; let j=0;
  for(let t=start;t<=end;t+=stepMs){
    while(j+1<points.length&&points[j+1].t<t)j++;
    const a=points[j],b=points[j+1];
    if(!a){out.push(null);continue;}
    if(Math.abs(a.t-t)<=stepMs*0.55){out.push(a.v);continue;}
    if(!b||b.t-a.t>stepMs*3.2||t<a.t||t>b.t){out.push(null);continue;}
    const r=(t-a.t)/(b.t-a.t); out.push(a.v+r*(b.v-a.v));
  }
  return {start,values:out};
}

function smooth(values) {
  return values.map((v,i)=>{
    if(!Number.isFinite(v))return null;
    return median(values.slice(Math.max(0,i-1),Math.min(values.length,i+2)));
  });
}

function diff(values) {
  const d=new Array(values.length).fill(null);
  for(let i=1;i<values.length;i++) if(Number.isFinite(values[i])&&Number.isFinite(values[i-1])) d[i]=values[i]-values[i-1];
  return d;
}

function corrAt(values, lag) {
  const a=[],b=[];
  for(let i=lag;i<values.length;i++) if(Number.isFinite(values[i])&&Number.isFinite(values[i-lag])){a.push(values[i]);b.push(values[i-lag]);}
  if(a.length<Math.max(30,lag))return null;
  const ma=mean(a),mb=mean(b); let n=0,da=0,db=0;
  for(let i=0;i<a.length;i++){const x=a[i]-ma,y=b[i]-mb;n+=x*y;da+=x*x;db+=y*y;}
  return da>0&&db>0?n/Math.sqrt(da*db):null;
}

function estimatePeriod(values) {
  const d=diff(values);
  const minLag=Math.max(2,Math.round(MIN_PERIOD_SEC/STEP_SEC));
  const maxLag=Math.min(Math.round(MAX_PERIOD_SEC/STEP_SEC),Math.floor(d.length/2));
  const s=[];
  for(let lag=minLag;lag<=maxLag;lag++){const c=corrAt(d,lag);if(Number.isFinite(c))s.push({lag,c});}
  if(!s.length)return null;
  const peaks=s.filter((x,i)=>x.c>=(s[i-1]?.c??-Infinity)&&x.c>=(s[i+1]?.c??-Infinity));
  const list=(peaks.length?peaks:s).sort((a,b)=>b.c-a.c);
  const best=list[0];
  return best&&best.c>=0.18?{samples:best.lag,seconds:best.lag*STEP_SEC,correlation:best.c}:null;
}

function phaseValues(values, index, period, maxCycles=5) {
  const out=[];
  for(let k=0;k<maxCycles;k++){const i=index-k*period;if(i<0)break;if(Number.isFinite(values[i]))out.push(values[i]);}
  return out;
}

function seasonal(values, period, horizonSamples) {
  const last=values.length-1;
  let idx=last+horizonSamples;
  while(idx>last)idx-=period;
  if(idx<0)return null;
  const vals=phaseValues(values,idx,period,5);
  if(vals.length<2)return null;
  const base=mean(vals);
  const oldCurrent=phaseValues(values,last-period,period,5);
  const normalNow=mean(oldCurrent);
  const deviation=Number.isFinite(normalNow)?values[last]-normalNow:0;
  const damping=Math.exp(-horizonSamples/Math.max(1,period));
  return {value:base+deviation*damping,spread:std(vals),matches:vals.length};
}

function fallback(current,slope,hRealMin,bounds) {
  const damp=1/(1+hRealMin/2);
  return clamp(current+slope*hRealMin*damp,bounds.min,bounds.max);
}

function labelTrend(slope) {
  if(slope>=0.08)return "RISING";
  if(slope<=-0.08)return "FALLING";
  return "STABLE";
}

function confidence(spanHours,period,cycles,spreads,range) {
  const h=clamp(spanHours/6,0,1);
  const p=period?clamp((period.correlation-0.18)/0.62,0,1):0;
  const c=clamp(cycles/4,0,1);
  const sp=median(spreads)??range;
  const v=range>0?clamp(1-sp/Math.max(0.8,range*0.35),0,1):0;
  return clamp(0.2*h+0.35*p+0.25*c+0.2*v,0.05,0.98);
}


function valid(v){return Number.isFinite(v);}
function trueRecent(values,index,count=4){
  if(index<0||!valid(values[index]))return false;
  let good=0;
  for(let j=Math.max(0,index-count+1);j<=index;j++)if(valid(values[j]))good++;
  return good>=Math.min(2,count);
}
function localTrend(values,index,stepSec){
  const begin=Math.max(0,index-Math.ceil(120/stepSec));
  const pts=[];
  for(let j=begin;j<=index;j++)if(valid(values[j]))pts.push({t:j*stepSec*1000,v:values[j]});
  if(pts.length<4)return 0;
  const s=regression(pts);
  return clamp(s,-4,4);
}
function analogPrediction(values,index,hSteps,stepSec){
  const window=Math.max(5,Math.round(60/stepSec));
  if(index<window||!trueRecent(values,index,window))return null;
  const present=values.slice(index-window+1,index+1);
  if(present.filter(valid).length<window-1)return null;
  const matches=[];
  const low=Math.max(window, index-Math.round(6*3600/stepSec));
  const high=index-hSteps-2;
  for(let j=low;j<=high;j+=2){
    if(!valid(values[j])||!valid(values[j+hSteps]))continue;
    const prior=values.slice(j-window+1,j+1);
    if(prior.filter(valid).length<window-1)continue;
    let sq=0,count=0;
    for(let k=0;k<window;k++){
      if(!valid(prior[k])||!valid(present[k]))continue;
      const err=(present[k]-present[window-1])-(prior[k]-prior[window-1]);
      sq+=err*err;count++;
    }
    if(count<window-2)continue;
    const shape=Math.sqrt(sq/count);
    const levelPenalty=Math.abs(present[window-1]-prior[window-1])*0.1;
    matches.push({score:shape+levelPenalty,delta:values[j+hSteps]-values[j]});
  }
  matches.sort((a,b)=>a.score-b.score);
  if(matches.length<3)return null;
  const best=matches.slice(0,Math.min(5,matches.length));
  if(best[0].score>2.5)return null;
  let wsum=0,total=0;
  for(const m of best){const w=1/(0.15+m.score);total+=w*m.delta;wsum+=w;}
  return clamp(values[index]+total/wsum,CM_BOUNDS.min,CM_BOUNDS.max);
}
function predictMethods(values,index,hSteps,stepSec,period){
  const current=values[index];
  const horizonMin=hSteps*stepSec/60;
  const slope=localTrend(values,index,stepSec);
  const output={
    PERSISTENCE:current,
    DAMPED_TREND:fallback(current,slope,horizonMin,CM_BOUNDS),
    SEASONAL_HISTORY:null,
    ANALOG_PATTERN:analogPrediction(values,index,hSteps,stepSec)
  };
  if(period){
    const prediction=seasonal(values.slice(0,index+1),period.samples,hSteps);
    if(prediction&&valid(prediction.value))output.SEASONAL_HISTORY=clamp(prediction.value,CM_BOUNDS.min,CM_BOUNDS.max);
  }
  return output;
}
function scoreModels(values,last,stepSec,scale){
  const metrics={},origins={};
  for(const h of HORIZONS){
    const offset=Math.max(1,Math.round(h*3600/scale/stepSec));
    const earliest=Math.max(Math.ceil(10*60/stepSec),Math.round((last+1)*0.3));
    const latest=last-offset;
    const originsForH=[];
    if(latest>=earliest){
      const stride=Math.max(1,Math.floor((latest-earliest)/23));
      for(let i=earliest;i<=latest;i+=stride)if(trueRecent(values,i)&&valid(values[i+offset]))originsForH.push(i);
    }
    const picked=originsForH.slice(-24);
    const sums=Object.fromEntries(MODELS.map(m=>[m,{abs:0,sq:0,n:0}]));
    // No future timestamps/measurements are given to any candidate at each origin.
    for(const origin of picked){
      const training=values.slice(0,origin+1);
      const learned=estimatePeriod(training);
      const predictions=predictMethods(training,origin,offset,stepSec,learned);
      const truth=values[origin+offset];
      for(const name of MODELS){
        const p=predictions[name];
        if(!valid(p))continue;
        const e=p-truth;
        sums[name].abs+=Math.abs(e);sums[name].sq+=e*e;sums[name].n++;
      }
    }
    const methods={};
    for(const name of MODELS){
      const x=sums[name];
      methods[name]={samples:x.n,mae_cm:x.n?Number((x.abs/x.n).toFixed(3)):null,rmse_cm:x.n?Number(Math.sqrt(x.sq/x.n).toFixed(3)):null};
    }
    metrics[h]=methods;
    origins[h]=picked.length;
  }
  return {metrics,origins};
}
function choosePrediction(predictions,metrics){
  const ranked=MODELS.filter(m=>valid(predictions[m])&&(metrics[m]?.samples||0)>=6)
    .sort((a,b)=>metrics[a].mae_cm-metrics[b].mae_cm);
  if(ranked.length){
    const best=ranked[0];
    // Prefer one validated model; avoid unjustified averaging.
    return {method:best,value:predictions[best],mae:metrics[best].mae_cm,samples:metrics[best].samples,validated:true};
  }
  for(const m of ["SEASONAL_HISTORY","ANALOG_PATTERN","DAMPED_TREND","PERSISTENCE"]){
    if(valid(predictions[m]))return {method:m,value:predictions[m],mae:null,samples:0,validated:false};
  }
  return null;
}

async function loadHistory(hours) {
  const from=new Date(Date.now()-hours*3600000);
  const [rows]=await pool.execute(
    "SELECT recorded_at,tide_level_cm FROM "+DB+".tide_node_readings "+
    "WHERE jsn_valid=1 AND tide_level_cm IS NOT NULL AND recorded_at>=? ORDER BY recorded_at ASC,id ASC",
    [from]
  );
  return rows;
}

async function buildTideForecast(options={}) {
  const hours=clamp(Number(options.historyHours||DEF_HOURS),6,18);
  const recent=clamp(Number(options.recentMinutes||DEF_RECENT),5,15);
  const scale=Math.max(1,Number(options.simTimeScale||DEF_SCALE));
  const points=normalize(await loadHistory(hours));

  if(points.length<6) return {available:false,reason:"NOT_ENOUGH_DATA",message:"Chua du du lieu muc trieu de du bao.",predictor_rules:{input_fields:["recorded_at","tide_level_cm"],excluded_fields:["scenario","pump_in","pump_out","phase"]}};

  const grid=resample(points,STEP_SEC*1000);
  if(!grid||grid.values.length<6)return {available:false,reason:"RESAMPLE_FAILED"};
  const values=smooth(grid.values);
  let last=values.length-1; while(last>=0&&!Number.isFinite(values[last]))last--;
  if(last<1)return {available:false,reason:"NO_RECENT_VALID_LEVEL"};

  const current=values[last];
  const currentMs=grid.start+last*STEP_SEC*1000;
  if(Date.now()-currentMs>30000)return {available:false,reason:"STALE_TIDE_SAMPLE",message:"Mau JSN hop le cuoi cung qua 30 giay; khong du bao thoi gian thuc."};
  const spanHours=(points[points.length-1].t-points[0].t)/3600000;
  const recentFrom=currentMs-recent*60000;
  const slope=regression(points.filter(p=>p.t>=recentFrom&&p.t<=currentMs));
  const period=estimatePeriod(values.slice(0,last+1));
  const used=values.slice(0,last+1),valid=used.filter(Number.isFinite);
  const p05=pct(valid,0.05)??MIN_LEVEL,p95=pct(valid,0.95)??MAX_LEVEL;
  const bounds={min:clamp(p05-0.5,MIN_LEVEL,MAX_LEVEL),max:clamp(p95+0.5,MIN_LEVEL,MAX_LEVEL)};
  if(bounds.max<=bounds.min){bounds.min=MIN_LEVEL;bounds.max=MAX_LEVEL;}

  const training=used;
  const backtest=scoreModels(training,training.length-1,STEP_SEC,scale);
  const spreads=[];
  const forecast=HORIZONS.map(h=>{
    const realSec=h*3600/scale;
    const hs=Math.max(1,Math.round(realSec/STEP_SEC));
    const predictions=predictMethods(training,training.length-1,hs,STEP_SEC,period);
    const selected=choosePrediction(predictions,backtest.metrics[h]);
    if(!selected)return {horizon_sim_hours:h,horizon_real_seconds:Math.round(realSec),level_cm:null,method:"UNAVAILABLE",backtest_mae_cm:null,backtest_samples:0};
    const levels=Object.fromEntries(MODELS.map(name=>[name,Number.isFinite(predictions[name])?Number(predictions[name].toFixed(2)):null]));
    const uncertainty=selected.mae!=null?Number((1.5*selected.mae).toFixed(2)):null;
    if(selected.mae!=null)spreads.push(selected.mae);
    return {
      horizon_sim_hours:h,horizon_real_seconds:Math.round(realSec),
      level_cm:Number(selected.value.toFixed(2)),method:selected.method,
      historical_matches:0,historical_spread_cm:uncertainty,
      backtest_mae_cm:selected.mae,backtest_samples:selected.samples,validated:selected.validated,
      method_predictions_cm:levels
    };
  });

  let nextPeak=null,nextLow=null,cycles=0;
  if(period){
    cycles=Math.floor(used.length/period.samples);
    const curve=[];
    for(let o=1;o<=period.samples;o++){const s=seasonal(used,period.samples,o);curve.push(s?s.value:null);}
    let max=-Infinity,min=Infinity,mi=null,ni=null;
    curve.forEach((v,i)=>{if(!Number.isFinite(v))return;if(v>max){max=v;mi=i+1;}if(v<min){min=v;ni=i+1;}});
    if(mi!=null){const sec=mi*STEP_SEC;nextPeak={level_cm:Number(clamp(max,bounds.min,bounds.max).toFixed(2)),in_real_seconds:sec,in_sim_hours:Number((sec*scale/3600).toFixed(2))};}
    if(ni!=null){const sec=ni*STEP_SEC;nextLow={level_cm:Number(clamp(min,bounds.min,bounds.max).toFixed(2)),in_real_seconds:sec,in_sim_hours:Number((sec*scale/3600).toFixed(2))};}
  }

  const range=Math.max(0.1,p95-p05);
  const conf=confidence(spanHours,period,cycles,spreads,range);
  return {
    available:true,model:"SENSOR_ONLY_ROLLING_BACKTEST_V3",training_status:backtest.origins[9]>=6?"VALIDATED":"WARMING_UP",generated_at:new Date().toISOString(),
    current:{recorded_at:new Date(currentMs).toISOString(),tide_level_cm:Number(current.toFixed(2)),trend:labelTrend(slope),slope_cm_per_real_min:Number(slope.toFixed(4)),slope_cm_per_sim_hour:Number((slope*60/scale).toFixed(3))},
    time_model:{simulation_scale:scale,one_sim_hour_real_seconds:Number((3600/scale).toFixed(2))},
    history:{requested_hours:hours,span_hours:Number(spanHours.toFixed(2)),raw_points:points.length,sample_seconds:STEP_SEC,recent_window_minutes:recent},
    learned_cycle:period?{period_real_seconds:period.seconds,period_sim_hours:Number((period.seconds*scale/3600).toFixed(2)),correlation:Number(period.correlation.toFixed(3)),approximate_cycles_in_history:cycles}:null,
    forecast,backtest:{method:"ROLLING_ORIGIN_NO_LOOKAHEAD",metric:"MAE_CM",by_horizon:backtest.metrics,origin_counts:backtest.origins},
    next_peak:nextPeak,next_low:nextLow,confidence:Number(conf.toFixed(3)),confidence_label:conf>=0.75?"HIGH":conf>=0.5?"MEDIUM":"LOW",
    predictor_rules:{input_fields:["recorded_at","tide_level_cm"],excluded_fields:["scenario","pump_in","pump_out","phase"],note:"Only historical JSN readings are inputs; model choice uses rolling-origin backtesting without future leakage."}
  };
}

module.exports={buildTideForecast,loadHistory};
