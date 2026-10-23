const express = require("express");
const { pool } = require("./db-v2");
const { buildTideForecast } = require("./tide-predictor-v2");
const { buildRainForecast } = require("./rain-predictor-v2");
const { buildFloodForecast } = require("./flood-predictor-v2");
const { getCollectorV2State, publishNode2Command } = require("./mqtt-collector-v2");
require("dotenv").config();

function safeDb(name){return /^[A-Za-z0-9_]+$/.test(String(name||""))?String(name):"floodguard_v2";}
function clamp(v,a,b,fallback){const n=Number(v);return Number.isFinite(n)?Math.min(b,Math.max(a,n)):fallback;}
const DB=safeDb(process.env.V2_DB_NAME||"floodguard_v2");
const SAMPLE_SEC=Math.max(1,Number(process.env.DB_V2_SAMPLE_INTERVAL_MS||5000)/1000);

function createV2Router(){
  const r=express.Router();

  r.get("/health",async(req,res)=>{
    try{
      const [rows]=await pool.query("SELECT CURRENT_TIMESTAMP AS db_time");
      res.json({ok:true,api:"FloodGuard v2",features:["5s-storage","sensor-only-tide-forecast","sensor-trend-rain-forecast","flood-early-warning"],v2_database:DB,database_connection:process.env.DATABASE_URL?"postgres":(process.env.MYSQL_URL?"mysql":null),collector:getCollectorV2State(),time:new Date().toISOString()});
    }catch(e){res.status(503).json({ok:false,error:e.message});}
  });

  r.get("/latest",async(req,res)=>{
    try{
      const [[a],[b]]=await Promise.all([
        pool.query("SELECT * FROM "+DB+".rain_node_readings ORDER BY recorded_at DESC,id DESC LIMIT 1"),
        pool.query("SELECT * FROM "+DB+".tide_node_readings ORDER BY recorded_at DESC,id DESC LIMIT 1")
      ]);
      const node1=a[0]||null;
      if(node1){
        node1.rain_tips_interval=node1.rain_tips_10s;
        node1.rain_mm_interval=node1.rain_mm_10s;
        node1.rain_volume_ml_interval=node1.rain_ml_interval;
        node1.rain_flow_ml_s=node1.rain_flow_ml_s;
        node1.rain_volume_total_ml=node1.rain_ml_total;
        node1.sample_interval_seconds=node1.rain_interval_seconds || SAMPLE_SEC;
        node1.rain_ml_per_tip=Number(process.env.RAIN_ML_PER_TIP || 27.27);
        node1.rain_mm_per_tip=Number(process.env.RAIN_MM_PER_TIP || 4.81);
      }
      res.json({node1,node2:b[0]||null,collector:getCollectorV2State()});
    }catch(e){res.status(500).json({error:e.message});}
  });

  r.get("/tide/history",async(req,res)=>{
    try{
      const hours=clamp(req.query.hours,1,18,6),limit=Math.round(clamp(req.query.limit,1,10000,5000));
      const from=new Date(Date.now()-hours*3600000);
      const [rows]=await pool.execute(
        "SELECT * FROM ("+
        "SELECT id,recorded_at,tide_level_cm,distance_cm,jsn_valid,pump_in,pump_out,scenario,phase FROM "+DB+".tide_node_readings "+
        "WHERE recorded_at>=? ORDER BY recorded_at DESC,id DESC LIMIT ?"+
        ") AS recent ORDER BY recorded_at ASC,id ASC",
        [from,limit]
      );
      res.json({hours,count:rows.length,data:rows});
    }catch(e){res.status(500).json({error:e.message});}
  });

  r.get("/rain/history",async(req,res)=>{
    try{
      const hours=clamp(req.query.hours,1,18,6),limit=Math.round(clamp(req.query.limit,1,10000,5000));
      const from=new Date(Date.now()-hours*3600000);
      const [rows]=await pool.execute(
        "SELECT * FROM ("+
        "SELECT id,recorded_at,temperature_c,humidity_pct,pressure_hpa,dew_point_c,dew_spread_c,wind_rpm,rain_detected,"+
        "rain_tips_10s,rain_tips_10s AS rain_tips_interval,rain_tips_total,rain_mm_10s,rain_mm_10s AS rain_mm_interval,rain_total_mm,"+
        "rain_ml_interval,rain_ml_interval AS rain_volume_ml_interval,rain_flow_ml_s,rain_ml_total,rain_ml_total AS rain_volume_total_ml,rain_interval_seconds,"+
        "distance_cm,water_level_cm,aht_valid,bmp_valid,jsn_valid FROM "+DB+".rain_node_readings "+
        "WHERE recorded_at>=? ORDER BY recorded_at DESC,id DESC LIMIT ?"+
        ") AS recent ORDER BY recorded_at ASC,id ASC",
        [from,limit]
      );
      res.json({
        hours,
        count:rows.length,
        sample_interval_seconds:SAMPLE_SEC,
        calibration:{
          ml_per_tip:Number(process.env.RAIN_ML_PER_TIP || 27.27),
          mm_per_tip:Number(process.env.RAIN_MM_PER_TIP || 4.81)
        },
        data:rows
      });
    }catch(e){res.status(500).json({error:e.message});}
  });

  r.get("/tide/forecast",async(req,res)=>{
    try{
      const result=await buildTideForecast({
        historyHours:clamp(req.query.history_hours,6,18,undefined),
        recentMinutes:clamp(req.query.recent_minutes,5,15,undefined),
        simTimeScale:clamp(req.query.sim_scale,1,3600,undefined)
      });
      res.status(result.available?200:202).json(result);
    }catch(e){console.error("[API v2 tide forecast]",e);res.status(500).json({available:false,error:e.message});}
  });

  r.get("/rain/forecast",async(req,res)=>{
    try{
      const result=await buildRainForecast({
        windowMinutes:clamp(req.query.window_minutes,5,60,undefined),
        simTimeScale:clamp(req.query.sim_scale,1,3600,undefined)
      });
      res.status(result.available?200:202).json(result);
    }catch(e){console.error("[API v2 rain forecast]",e);res.status(500).json({available:false,error:e.message});}
  });

  r.get("/flood/forecast",async(req,res)=>{
    try{
      const result=await buildFloodForecast({
        roadMinutes:clamp(req.query.road_minutes,1,15,undefined),
        simTimeScale:clamp(req.query.sim_scale,1,3600,undefined)
      });
      res.status(result.available?200:202).json(result);
    }catch(e){console.error("[API v2 flood forecast]",e);res.status(500).json({available:false,error:e.message});}
  });

  r.post("/node2/fault/reset",async(req,res)=>{
    try{
      const result=await publishNode2Command("CLEAR_FAULT");
      res.json({ok:true,message:"Da gui lenh xoa FAULT den tram trung tam.",command:result});
    }catch(e){
      res.status(503).json({ok:false,error:e.message});
    }
  });

  r.get("/forecast",async(req,res)=>{
    const scale=clamp(req.query.sim_scale,1,3600,undefined);
    const results=await Promise.allSettled([
      buildRainForecast({simTimeScale:scale}),
      buildTideForecast({simTimeScale:scale}),
      buildFloodForecast({simTimeScale:scale})
    ]);
    const pack=(item,name)=>{
      if(item.status==="fulfilled") return item.value;
      console.error("[API v2 combined forecast] "+name,item.reason);
      return {available:false,error:item.reason?.message||String(item.reason||"UNKNOWN_ERROR")};
    };
    const rain=pack(results[0],"rain");
    const tide=pack(results[1],"tide");
    const flood=pack(results[2],"flood");
    const anyAvailable=Boolean(rain.available||tide.available||flood.available);
    res.status(anyAvailable?200:202).json({
      generated_at:new Date().toISOString(),
      partial:results.some(x=>x.status==="rejected"),
      rain,tide,flood
    });
  });

  return r;
}
module.exports={createV2Router};
