// Additive forecast/device audit. Never changes existing sensor tables or predictors.
const {pool,dialect}=require("./db-v2");
const {buildRainForecast}=require("./rain-predictor-v2");
const {buildTideForecast}=require("./tide-predictor-v2");
const {buildFloodForecast}=require("./flood-predictor-v2");
const {getCollectorV2State}=require("./mqtt-collector-v2");
const DB=/^[A-Za-z0-9_]+$/.test(process.env.V2_DB_NAME||"")?process.env.V2_DB_NAME:"floodguard_v2";
const PG=dialect==="postgres";
const tbl=n=>PG?'"'+DB+'"."'+n+'"':"`"+DB+"`.`"+n+"`";
const enabled=String(process.env.FORECAST_HISTORY_ENABLED??"true").toLowerCase()!=="false";
const interval=Math.max(30000,Number(process.env.FORECAST_HISTORY_INTERVAL_MS)||60000);
const num=x=>x==null||x===""||!Number.isFinite(Number(x))?null:Number(x);
const bool=x=>x==null?null:(x?1:0);
const dt=x=>x?new Date(x):new Date();
let previous={},busy=false,ready=false;
async function query(sql,params=[]){return pool.execute(sql,params);}
function currentStatus(){
 const s=getCollectorV2State(),now=Date.now();
 const fresh=t=>t&&Number.isFinite(new Date(t).getTime())&&Math.abs(now-new Date(t).getTime())<=30000;
 return {NODE1:fresh(s.node1LastReceivedAt)?"ONLINE":"OFFLINE",
 NODE2:fresh(s.node2LastReceivedAt)?"ONLINE":"OFFLINE",
 CENTRAL:fresh(s.lastCentralStatusAt)?"ONLINE":"OFFLINE"};
}
async function initialize(){
 // MySQL relational tables were already created with the reviewed DBeaver migration.
 if(PG){
  const prefix='"'+DB+'"';
  await query('CREATE SCHEMA IF NOT EXISTS '+prefix);
  const statements=[
   'CREATE TABLE IF NOT EXISTS '+tbl("devices")+' (device_id BIGSERIAL PRIMARY KEY,device_code VARCHAR(32) NOT NULL UNIQUE,device_name VARCHAR(120) NOT NULL,device_type VARCHAR(40) NOT NULL,status VARCHAR(24) NOT NULL DEFAULT \'UNKNOWN\',description TEXT,created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)',
   'CREATE TABLE IF NOT EXISTS '+tbl("sensors")+' (sensor_id BIGSERIAL PRIMARY KEY,device_id BIGINT NOT NULL REFERENCES '+tbl("devices")+'(device_id),sensor_code VARCHAR(48) NOT NULL UNIQUE,sensor_name VARCHAR(120) NOT NULL,sensor_type VARCHAR(48) NOT NULL,status VARCHAR(24) NOT NULL DEFAULT \'ACTIVE\')',
   'CREATE TABLE IF NOT EXISTS '+tbl("sensor_channels")+' (channel_id BIGSERIAL PRIMARY KEY,sensor_id BIGINT NOT NULL REFERENCES '+tbl("sensors")+'(sensor_id),channel_code VARCHAR(64) NOT NULL UNIQUE,source_table VARCHAR(64) NOT NULL,source_column VARCHAR(64) NOT NULL,unit VARCHAR(24),UNIQUE(source_table,source_column))',
   'CREATE TABLE IF NOT EXISTS '+tbl("forecast_runs")+' (run_id BIGSERIAL PRIMARY KEY,generated_at TIMESTAMPTZ(3) NOT NULL,simulation_scale DOUBLE PRECISION NOT NULL DEFAULT 60,rain_model VARCHAR(100),tide_model VARCHAR(100),flood_model VARCHAR(100),rain_available SMALLINT NOT NULL DEFAULT 0,tide_available SMALLINT NOT NULL DEFAULT 0,flood_available SMALLINT NOT NULL DEFAULT 0,is_demo SMALLINT NOT NULL DEFAULT 0,status VARCHAR(24) NOT NULL DEFAULT \'CREATED\',error_message TEXT)',
   'CREATE TABLE IF NOT EXISTS '+tbl("forecast_inputs")+' (input_id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL REFERENCES '+tbl("forecast_runs")+'(run_id) ON DELETE CASCADE,channel_id BIGINT NOT NULL REFERENCES '+tbl("sensor_channels")+'(channel_id),source_reading_id BIGINT NOT NULL,sample_recorded_at TIMESTAMPTZ(3),UNIQUE(run_id,channel_id,source_reading_id))',
   'CREATE TABLE IF NOT EXISTS '+tbl("rain_forecasts")+' (forecast_id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL UNIQUE REFERENCES '+tbl("forecast_runs")+'(run_id) ON DELETE CASCADE,rain_risk_score DOUBLE PRECISION,rain_risk_label VARCHAR(32),rain_active SMALLINT,rain_sensor_wet SMALLINT,tips_recent BIGINT,expected_onset_label VARCHAR(40),onset_min_sim_hours DOUBLE PRECISION,onset_max_sim_hours DOUBLE PRECISION,confidence DOUBLE PRECISION,confidence_label VARCHAR(16))',
   'CREATE TABLE IF NOT EXISTS '+tbl("tide_forecasts")+' (forecast_id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL REFERENCES '+tbl("forecast_runs")+'(run_id) ON DELETE CASCADE,horizon_sim_hours INTEGER NOT NULL,horizon_real_seconds INTEGER,target_at TIMESTAMPTZ(3),current_level_cm DOUBLE PRECISION,predicted_level_cm DOUBLE PRECISION,method VARCHAR(100),backtest_mae_cm DOUBLE PRECISION,backtest_samples INTEGER,validated SMALLINT,UNIQUE(run_id,horizon_sim_hours))',
   'CREATE TABLE IF NOT EXISTS '+tbl("flood_forecasts")+' (forecast_id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL REFERENCES '+tbl("forecast_runs")+'(run_id) ON DELETE CASCADE,horizon_sim_hours INTEGER NOT NULL,horizon_real_seconds INTEGER,target_at TIMESTAMPTZ(3),predicted_road_level_cm DOUBLE PRECISION,alert_level VARCHAR(24),predicted_cause_code VARCHAR(32),overall_alert_level VARCHAR(24),early_warning SMALLINT,road_trend_cm DOUBLE PRECISION,rain_contribution_cm DOUBLE PRECISION,tide_contribution_cm DOUBLE PRECISION,UNIQUE(run_id,horizon_sim_hours))',
   'CREATE TABLE IF NOT EXISTS '+tbl("system_history")+' (history_id BIGSERIAL PRIMARY KEY,device_id BIGINT REFERENCES '+tbl("devices")+'(device_id) ON DELETE SET NULL,run_id BIGINT REFERENCES '+tbl("forecast_runs")+'(run_id) ON DELETE SET NULL,event_type VARCHAR(48) NOT NULL,event_source VARCHAR(64) NOT NULL,event_message TEXT,occurred_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)'
  ];
  for(const sql of statements)await query(sql);
  const devices=[["NODE1","Trạm mưa và ngập đường"],["NODE2","Trạm triều"],["CENTRAL","Trạm trung tâm"]];
  for(const [code,name] of devices)await query('INSERT INTO '+tbl("devices")+' (device_code,device_name,device_type) VALUES (?,?,?) ON CONFLICT (device_code) DO NOTHING',[code,name,"ESP32"]);
  const sensors=[
   ["NODE1","N1_AHT20","AHT20","TEMPERATURE_HUMIDITY"],
   ["NODE1","N1_BMP180","BMP180","PRESSURE"],
   ["NODE1","N1_HALL","Hall - cốc gió","WIND_ROTATION"],
   ["NODE1","N1_BUCKET","Gàu lật","RAIN_VOLUME"],
   ["NODE1","N1_RAIN","Cảm biến mưa","RAIN_DETECTION"],
   ["NODE1","N1_JSN","JSN-SR04T đường","ROAD_WATER_LEVEL"],
   ["NODE2","N2_JSN","JSN-SR04T triều","TIDE_WATER_LEVEL"]
  ];
  for(const [dev,code,name,type] of sensors)
   await query('INSERT INTO '+tbl("sensors")+' (device_id,sensor_code,sensor_name,sensor_type) SELECT device_id,?,?,? FROM '+tbl("devices")+' WHERE device_code=? ON CONFLICT (sensor_code) DO NOTHING',[code,name,type,dev]);
  const channels=[
   ["N1_AHT20","N1_TEMPERATURE","rain_node_readings","temperature_c","C"],
   ["N1_AHT20","N1_HUMIDITY","rain_node_readings","humidity_pct","%"],
   ["N1_BMP180","N1_PRESSURE","rain_node_readings","pressure_hpa","hPa"],
   ["N1_HALL","N1_WIND_RPM","rain_node_readings","wind_rpm","RPM"],
   ["N1_BUCKET","N1_RAIN_TIPS","rain_node_readings","rain_tips_total","tips"],
   ["N1_RAIN","N1_RAIN_DETECTED","rain_node_readings","rain_detected","0/1"],
   ["N1_JSN","N1_WATER_LEVEL","rain_node_readings","water_level_cm","cm"],
   ["N2_JSN","N2_TIDE_LEVEL","tide_node_readings","tide_level_cm","cm"]
  ];
  for(const [sensor,code,source,col,unit] of channels)
   await query('INSERT INTO '+tbl("sensor_channels")+' (sensor_id,channel_code,source_table,source_column,unit) SELECT sensor_id,?,?,?,? FROM '+tbl("sensors")+' WHERE sensor_code=? ON CONFLICT (channel_code) DO NOTHING',[code,source,col,unit,sensor]);
 } 
 const [r]=await query('SELECT device_id,device_code FROM '+tbl("devices"));
 if(!r.length)throw new Error("devices is empty: run the FloodGuard SQL seed first");
 const [f]=await query('SELECT run_id FROM '+tbl("forecast_runs")+' LIMIT 1');
 ready=true;
 console.log("[Forecast journal] ready, "+DB+" ("+(PG?"postgres":"mysql")+")");
}
async function saveEvent(code,event,message){
 const [r]=await query('SELECT device_id FROM '+tbl("devices")+' WHERE device_code=? LIMIT 1',[code]);
 if(!r.length)return;
 await query('INSERT INTO '+tbl("system_history")+' (device_id,event_type,event_source,event_message,occurred_at) VALUES (?,?,?,?,?)',
 [r[0].device_id,event,"MQTT_V2",message,new Date()]);
}
async function trackDevices(){
 const statuses=currentStatus();
 for(const [code,status] of Object.entries(statuses)){
  if(previous[code]===undefined){previous[code]=status;try{await saveEvent(code,"DEVICE_SNAPSHOT","Trạng thái ban đầu: "+status);}catch(e){console.warn("[Device journal]",e.message);}continue;}
  if(previous[code]===status)continue;
  const old=previous[code];previous[code]=status;
  try {await saveEvent(code,"DEVICE_"+status,old+" → "+status);}catch(e){console.warn("[Device journal]",e.message);}
 }
}
async function storeForecast(){
 const state=currentStatus();
 if(state.NODE1!=="ONLINE"&&state.NODE2!=="ONLINE")return;
 // Read algorithms as-is. Flood predictor currently invokes rain/tide again internally.
 const [a,b,c]=await Promise.allSettled([
  state.NODE1==="ONLINE"?buildRainForecast():Promise.resolve(null),
  state.NODE2==="ONLINE"?buildTideForecast():Promise.resolve(null),
  state.NODE1==="ONLINE"&&state.NODE2==="ONLINE"?buildFloodForecast():Promise.resolve(null)
 ]);
 const rain=a.status==="fulfilled"?a.value:null,tide=b.status==="fulfilled"?b.value:null,flood=c.status==="fulfilled"?c.value:null;
 if(!rain?.available&&!tide?.available&&!flood?.available)return;
 const scale=num(rain?.time_model?.simulation_scale)||num(tide?.time_model?.simulation_scale)||num(flood?.time_model?.simulation_scale)||60;
 const fields=["generated_at","simulation_scale","rain_model","tide_model","flood_model","rain_available","tide_available","flood_available","is_demo","status"];
 const values=[new Date(),scale,rain?.model||null,tide?.model||null,flood?.model||null,bool(rain?.available)||0,bool(tide?.available)||0,bool(flood?.available)||0,bool(rain?.demo_environment?.enabled)||0,"COMPLETED"];
 const suffix=PG?" RETURNING run_id":"";
 const [rr]=await query('INSERT INTO '+tbl("forecast_runs")+' ('+fields.join(",") +') VALUES ('+fields.map(()=>"?").join(",")+')'+suffix,values);
 const id=PG?rr[0]?.run_id:rr.insertId;
 if(!id)throw new Error("Could not get forecast run ID");
 if(rain?.available){
  const o=rain.expected_onset||{};
  await query('INSERT INTO '+tbl("rain_forecasts")+' (run_id,rain_risk_score,rain_risk_label,rain_active,rain_sensor_wet,tips_recent,expected_onset_label,onset_min_sim_hours,onset_max_sim_hours,confidence,confidence_label) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  [id,num(rain.rain_risk_score),rain.rain_risk_label||null,bool(rain.rain_active),bool(rain.rain_sensor_wet),num(rain.tips_recent),o.label||null,num(o.min_sim_hours),num(o.max_sim_hours),num(rain.confidence),rain.confidence_label||null]);
 }
 for(const t of tide?.available?(tide.forecast||[]):[]){
  await query('INSERT INTO '+tbl("tide_forecasts")+' (run_id,horizon_sim_hours,horizon_real_seconds,target_at,current_level_cm,predicted_level_cm,method,backtest_mae_cm,backtest_samples,validated) VALUES (?,?,?,?,?,?,?,?,?,?)',
  [id,num(t.horizon_sim_hours),num(t.horizon_real_seconds),new Date(Date.now()+(num(t.horizon_real_seconds)||0)*1000),num(tide.current?.tide_level_cm),num(t.level_cm),t.method||null,num(t.backtest_mae_cm),num(t.backtest_samples),bool(t.validated)]);
 }
 for(const f of flood?.available?(flood.forecast||[]):[]){
  const causes=flood.predicted_cause;
  await query('INSERT INTO '+tbl("flood_forecasts")+' (run_id,horizon_sim_hours,horizon_real_seconds,target_at,predicted_road_level_cm,alert_level,predicted_cause_code,overall_alert_level,early_warning,road_trend_cm,rain_contribution_cm,tide_contribution_cm) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  [id,num(f.horizon_sim_hours),num(f.horizon_real_seconds),new Date(Date.now()+(num(f.horizon_real_seconds)||0)*1000),num(f.road_level_cm),f.alert_level||null,causes?.code||null,flood.overall_alert_level||null,bool(flood.early_warning),num(f.contributions_cm?.road_trend),num(f.contributions_cm?.rain),num(f.contributions_cm?.tide)]);
 }
 // Deliberately do not fabricate forecast_inputs: predictors use broad history windows.
}
async function cycle(){
 if(busy||!ready)return;busy=true;
 try{await trackDevices();await storeForecast();}
 catch(e){console.warn("[Forecast journal] nonfatal:",e.message);}
 finally{busy=false;}
}
async function deviceHistory(limit=30){
 const n=Math.max(1,Math.min(200,Number(limit)||30));
 const [rows]=await query('SELECT h.history_id,h.event_type,h.event_message,h.occurred_at,d.device_code,d.device_name FROM '+tbl("system_history")+' h LEFT JOIN '+tbl("devices")+' d ON h.device_id=d.device_id WHERE h.event_type IN (\'DEVICE_ONLINE\',\'DEVICE_OFFLINE\',\'DEVICE_SNAPSHOT\') ORDER BY h.occurred_at DESC,h.history_id DESC LIMIT '+n);
 return rows;
}
async function forecastHistory(limit=15){
 const n=Math.max(1,Math.min(100,Number(limit)||15));
 const [rows]=await query('SELECT run_id,generated_at,rain_available,tide_available,flood_available,status FROM '+tbl("forecast_runs")+' ORDER BY run_id DESC LIMIT '+n);
 return rows;
}
function startJournal(){
 if(!enabled){console.log("[Forecast journal] disabled");return;}
 initialize().then(()=>{
  setTimeout(cycle,10000);
  const h=setInterval(cycle,interval);h.unref?.();
 }).catch(e=>console.warn("[Forecast journal] unavailable, core remains running:",e.message));
}
module.exports={startJournal,deviceHistory,forecastHistory};
