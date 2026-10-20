const express = require("express");
const { pool } = require("./db");
const { buildTideForecast } = require("./tide-predictor-v2");
const { getCollectorV2State } = require("./mqtt-collector-v2");
require("dotenv").config();

function safeDb(name){return /^[A-Za-z0-9_]+$/.test(String(name||""))?String(name):"floodguard_v2";}
function clamp(v,a,b,fallback){const n=Number(v);return Number.isFinite(n)?Math.min(b,Math.max(a,n)):fallback;}
const DB=safeDb(process.env.V2_DB_NAME||"floodguard_v2");

function createV2Router(){
  const r=express.Router();

  r.get("/health",async(req,res)=>{
    try{
      const [rows]=await pool.query("SELECT DATABASE() AS connection_database,NOW(3) AS db_time");
      res.json({ok:true,api:"FloodGuard v2",v2_database:DB,mysql_connection_database:rows[0]?.connection_database||null,collector:getCollectorV2State(),time:new Date().toISOString()});
    }catch(e){res.status(503).json({ok:false,error:e.message});}
  });

  r.get("/latest",async(req,res)=>{
    try{
      const [[a],[b]]=await Promise.all([
        pool.query("SELECT * FROM "+DB+".rain_node_readings ORDER BY recorded_at DESC,id DESC LIMIT 1"),
        pool.query("SELECT * FROM "+DB+".tide_node_readings ORDER BY recorded_at DESC,id DESC LIMIT 1")
      ]);
      res.json({node1:a[0]||null,node2:b[0]||null,collector:getCollectorV2State()});
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
        "SELECT id,recorded_at,temperature_c,humidity_pct,pressure_hpa,dew_point_c,dew_spread_c,wind_rpm,rain_detected,rain_tips_10s,rain_tips_total,distance_cm,water_level_cm,aht_valid,bmp_valid,jsn_valid FROM "+DB+".rain_node_readings WHERE recorded_at>=? ORDER BY recorded_at ASC,id ASC LIMIT ?",
        [from,limit]
      );
      res.json({hours,count:rows.length,data:rows});
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

  return r;
}
module.exports={createV2Router};
