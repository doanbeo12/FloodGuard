// FloodGuard v2 / MySQL-only forecast journal. Independent from MQTT ingestion.
// Writes one consistent forecast run + input references + outputs per interval.
const { pool } = require("./db-v2");
const { buildRainForecast } = require("./rain-predictor-v2");
const { buildTideForecast } = require("./tide-predictor-v2");
const { buildFloodForecast } = require("./flood-predictor-v2");
const { getCollectorV2State } = require("./mqtt-collector-v2");
const { getRainFavorableDemo } = require("./demo-state-v2");
const DB = /^[A-Za-z0-9_]+$/.test(process.env.V2_DB_NAME || "") ? process.env.V2_DB_NAME : "floodguard_v2";
const EVERY_MS = Math.max(60000,Number(process.env.FORECAST_JOURNAL_INTERVAL_MS || 60000));
const SCALE = Math.max(1,Number(process.env.FORECAST_SIM_TIME_SCALE || process.env.TIDE_SIM_TIME_SCALE || 60));
let busy=false, timer=null;
const validNum = v => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const flag = v => v ? 1 : 0;
const dt = v => v ? new Date(v) : null;
function sourceFresh(v){ const t=new Date(v||0).getTime();return Number.isFinite(t)&&Date.now()-t>=-5000&&Date.now()-t<=30000; }
async function validate(){
 const required={
  forecast_runs:["run_id","generated_at","simulation_scale","rain_model","tide_model","flood_model","rain_available","tide_available","flood_available","is_demo","status","error_message"],
  forecast_inputs:["run_id","channel_id","source_reading_id","sample_recorded_at"],
  rain_forecasts:["run_id","rain_risk_score","rain_risk_label","rain_active","rain_sensor_wet","tips_recent","expected_onset_label","onset_min_sim_hours","onset_max_sim_hours","confidence","confidence_label"],
  tide_forecasts:["run_id","horizon_sim_hours","horizon_real_seconds","target_at","current_level_cm","predicted_level_cm","method","backtest_mae_cm","backtest_samples","validated"],
  flood_forecasts:["run_id","horizon_sim_hours","horizon_real_seconds","target_at","predicted_road_level_cm","alert_level","predicted_cause_code","overall_alert_level","early_warning","road_trend_cm","rain_contribution_cm","tide_contribution_cm"],
  sensor_channels:["channel_id","source_table","source_column"]
 };
 const [rows]=await pool.execute("SELECT TABLE_NAME,COLUMN_NAME,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=?",[DB]);
 for(const [table,cols] of Object.entries(required)){
  const seen=new Set(rows.filter(r=>r.TABLE_NAME===table).map(r=>r.COLUMN_NAME));
  for(const c of cols) if(!seen.has(c)) throw new Error("Missing "+table+"."+c);
 }
 for(const table of ["forecast_runs","rain_forecasts","tide_forecasts","flood_forecasts"]){
  const pk=table==="forecast_runs"?"run_id":"forecast_id";
  const field=rows.find(r=>r.TABLE_NAME===table&&r.COLUMN_NAME===pk);
  if(!field||!String(field.EXTRA).includes("auto_increment")) throw new Error(table+"."+pk+" must be AUTO_INCREMENT");
 }
 const [c]=await pool.query("SELECT COUNT(*) AS n FROM "+DB+".sensor_channels");
 if(!Number(c[0]?.n)) throw new Error("sensor_channels is empty");
}
async function latestPair(){
 const [[a],[b]]=await Promise.all([
  pool.query("SELECT * FROM "+DB+".rain_node_readings ORDER BY id DESC LIMIT 1"),
  pool.query("SELECT * FROM "+DB+".tide_node_readings ORDER BY id DESC LIMIT 1")
 ]);
 return {rain:a[0]||null,tide:b[0]||null};
}
async function buildAll(){
 const live=getCollectorV2State();
 const online1=sourceFresh(live.node1LastReceivedAt),online2=sourceFresh(live.node2LastReceivedAt);
 const tasks=[
  online1?buildRainForecast({simTimeScale:SCALE}):Promise.resolve({available:false,reason:"NODE_OFFLINE"}),
  online2?buildTideForecast({simTimeScale:SCALE}):Promise.resolve({available:false,reason:"NODE_OFFLINE"}),
  online1&&online2?buildFloodForecast({simTimeScale:SCALE}):Promise.resolve({available:false,reason:"NODE_OFFLINE"})
 ];
 const responses=await Promise.allSettled(tasks);
 return responses.map(x=>x.status==="fulfilled"?x.value:{available:false,reason:String(x.reason?.message||x.reason)});
}
async function journal(){
 if(busy)return;busy=true;
 try{
  const [{rain:reading1,tide:reading2}, results]=await Promise.all([latestPair(),buildAll()]);
  const [rain,tide,flood]=results;
  const conn=await pool.getConnection();
  try{
   await conn.beginTransaction();
   const generated=new Date();
   const [run]=await conn.execute("INSERT INTO "+DB+".forecast_runs (generated_at,simulation_scale,rain_model,tide_model,flood_model,rain_available,tide_available,flood_available,is_demo,status,error_message) VALUES (?,?,?,?,?,?,?,?,?,?,?)",[
    generated,SCALE,rain.model||null,tide.model||null,flood.model||null,flag(rain.available),flag(tide.available),flag(flood.available),flag(getRainFavorableDemo()?.enabled),"COMPLETED",
    results.every(x=>x.available)?null:results.filter(x=>!x.available).map(x=>x.reason||x.error||"UNAVAILABLE").join("; ").slice(0,500)
   ]);
   const runId=run.insertId;
   // Record one real source sample per available channel. Never synthesize readings.
   const [channels]=await conn.query("SELECT channel_id,source_table,source_column FROM "+DB+".sensor_channels");
   for(const ch of channels){
    const table=String(ch.source_table||"").split(".").pop().toLowerCase();
    const src=table==="rain_node_readings"?reading1:table==="tide_node_readings"?reading2:null;
    if(!src||!Object.prototype.hasOwnProperty.call(src,ch.source_column))continue;
    await conn.execute("INSERT INTO "+DB+".forecast_inputs (run_id,channel_id,source_reading_id,sample_recorded_at) VALUES (?,?,?,?)",
     [runId,ch.channel_id,src.id,dt(src.recorded_at)]);
   }
   if(rain.available){
    await conn.execute("INSERT INTO "+DB+".rain_forecasts (run_id,rain_risk_score,rain_risk_label,rain_active,rain_sensor_wet,tips_recent,expected_onset_label,onset_min_sim_hours,onset_max_sim_hours,confidence,confidence_label) VALUES (?,?,?,?,?,?,?,?,?,?,?)",[
     runId,validNum(rain.rain_risk_score),rain.rain_risk_label||null,flag(rain.rain_active),flag(rain.rain_sensor_wet),validNum(rain.tips_recent),
     rain.expected_onset?.label||null,validNum(rain.expected_onset?.min_sim_hours),validNum(rain.expected_onset?.max_sim_hours),validNum(rain.confidence),rain.confidence_label||null
    ]);
   }
   if(tide.available)for(const f of tide.forecast||[]){
    const sec=validNum(f.horizon_real_seconds);
    await conn.execute("INSERT INTO "+DB+".tide_forecasts (run_id,horizon_sim_hours,horizon_real_seconds,target_at,current_level_cm,predicted_level_cm,method,backtest_mae_cm,backtest_samples,validated) VALUES (?,?,?,?,?,?,?,?,?,?)",[
     runId,f.horizon_sim_hours,sec,sec===null?null:new Date(generated.getTime()+sec*1000),validNum(tide.current?.tide_level_cm),validNum(f.level_cm),f.method||null,
     validNum(f.backtest_mae_cm),validNum(f.backtest_samples),flag(f.validated)
    ]);
   }
   if(flood.available)for(const f of flood.forecast||[]){
    const sec=validNum(f.horizon_real_seconds);
    await conn.execute("INSERT INTO "+DB+".flood_forecasts (run_id,horizon_sim_hours,horizon_real_seconds,target_at,predicted_road_level_cm,alert_level,predicted_cause_code,overall_alert_level,early_warning,road_trend_cm,rain_contribution_cm,tide_contribution_cm) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",[
     runId,f.horizon_sim_hours,sec,sec===null?null:new Date(generated.getTime()+sec*1000),validNum(f.road_level_cm),f.alert_level||null,
     f.predicted_cause_code||flood.predicted_cause?.code||null,flood.overall_alert_level||null,flag(flood.early_warning),
     validNum(f.contributions_cm?.road_trend),validNum(f.contributions_cm?.rain),validNum(f.contributions_cm?.tide)
    ]);
   }
   await conn.commit();
   console.log("[FORECAST JOURNAL] run="+runId+" rain="+flag(rain.available)+" tide="+flag(tide.available)+" flood="+flag(flood.available));
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
 }catch(e){console.error("[FORECAST JOURNAL] "+e.message);}finally{busy=false;}
}
async function startForecastJournalV2(){
 if(timer)return;
 try{
  if(String(process.env.DB_DRIVER||"").toLowerCase()==="postgres")throw new Error("MySQL-only journal");
  await validate();
  console.log("[FORECAST JOURNAL] Ready, interval="+EVERY_MS+"ms");
  timer=setInterval(()=>{void journal();},EVERY_MS);
  timer.unref?.();
 }catch(e){console.error("[FORECAST JOURNAL] Disabled: "+e.message);}
}
module.exports={startForecastJournalV2};
