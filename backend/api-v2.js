const express = require("express");
const { pool } = require("./db");
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
      const [rows]=await pool.query("SELECT DATABASE() AS connection_database,NOW(3) AS db_time");
      res.json({ok:true,api:"FloodGuard v2",features:["5s-storage","sensor-only-tide-forecast","sensor-trend-rain-forecast","flood-early-warning"],v2_database:DB,mysql_connection_database:rows[0]?.connection_database||null,collector:getCollectorV2State(),time:new Date().toISOString()});
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
        node1.sample_interval_seconds=SAMPLE_SEC;
      }
      res.json({node1,node2:b[0]||null,collector:getCollectorV2State()});
    }catch(e){res.status(500).json({error:e.message});}
  });

  r.get("/tide/history",async(req,res)=>{
    try{
      const hours=clamp(req.query.hours,1,18,6),limit=Math.round(clamp(req.query.limit,1,10000,5000));
      const from=new Date(Date.now()-hours*3600000);
      const [rows]=await pool.execute(
        "SELECT id,recorded_at,tide_level_cm,distance_cm,jsn_valid,pump_in,pump_out,scenario,phase FROM "+DB+".tide_node_readings WHERE recorded_at>=? ORDER BY recorded_at ASC,id ASC LIMIT ?",
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
        "SELECT id,recorded_at,temperature_c,humidity_pct,pressure_hpa,dew_point_c,dew_spread_c,wind_rpm,rain_detected,"+
        "rain_tips_10s,rain_tips_10s AS rain_tips_interval,rain_tips_total,rain_mm_10s,rain_mm_10s AS rain_mm_interval,rain_total_mm,"+
        "distance_cm,water_level_cm,aht_valid,bmp_valid,jsn_valid FROM "+DB+".rain_node_readings WHERE recorded_at>=? ORDER BY recorded_at ASC,id ASC LIMIT ?",
        [from,limit]
      );
      res.json({hours,count:rows.length,sample_interval_seconds:SAMPLE_SEC,data:rows});
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
    }catch(e){res.status(500).json({available:false,error:e.message});}
  });

  r.get("/rain/forecast",async(req,res)=>{
    try{
      const result=await buildRainForecast({
        windowMinutes:clamp(req.query.window_minutes,5,60,undefined),
        simTimeScale:clamp(req.query.sim_scale,1,3600,undefined)
      });
      res.status(result.available?200:202).json(result);
    }catch(e){res.status(500).json({available:false,error:e.message});}
  });

  r.get("/flood/forecast",async(req,res)=>{
    try{
      const result=await buildFloodForecast({
        roadMinutes:clamp(req.query.road_minutes,1,15,undefined),
        simTimeScale:clamp(req.query.sim_scale,1,3600,undefined)
      });
      res.status(result.available?200:202).json(result);
    }catch(e){res.status(500).json({available:false,error:e.message});}
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
    try{
      const scale=clamp(req.query.sim_scale,1,3600,undefined);
      const result=await buildFloodForecast({simTimeScale:scale});
      res.status(result.available?200:202).json({
        generated_at:new Date().toISOString(),
        rain:result.inputs?.rain_forecast||null,
        tide:result.inputs?.tide_forecast||null,
        flood:result
      });
    }catch(e){res.status(500).json({available:false,error:e.message});}
  });

  return r;
}
module.exports={createV2Router};
