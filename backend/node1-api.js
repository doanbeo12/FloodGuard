"use strict";
const express = require("express");
const crypto = require("crypto");
const { pool } = require("./db");

const SAVE_MYSQL = String(process.env.NODE1_STORE_MYSQL || "false").toLowerCase() === "true";
let tableReady = false;

async function storeTelemetry(d) {
  if (!tableReady) {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS node1_telemetry (" +
      "id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY," +
      "received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
      "node_id TINYINT UNSIGNED NOT NULL," +
      "seq BIGINT UNSIGNED NOT NULL," +
      "uptime_ms BIGINT UNSIGNED NULL," +
      "temperature_c DOUBLE NULL,humidity_pct DOUBLE NULL,pressure_hpa DOUBLE NULL,wind_rpm DOUBLE NULL," +
      "rain_tips_total BIGINT UNSIGNED NULL,rain_tips_interval BIGINT UNSIGNED NULL," +
      "raining TINYINT(1) NOT NULL,rain_plate_wet TINYINT(1) NOT NULL," +
      "jsn_level_cm DOUBLE NULL,ai_level_cm DOUBLE NULL,ai_valid TINYINT(1) NOT NULL," +
      "pump_in TINYINT(1) NOT NULL,pump_out TINYINT(1) NOT NULL," +
      "mode VARCHAR(16) NOT NULL,fault VARCHAR(64) NULL,wifi_connected TINYINT(1) NOT NULL," +
      "INDEX idx_node1_received (received_at)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
    );
    tableReady = true;
  }
  await pool.execute(
    "INSERT INTO node1_telemetry (node_id,seq,uptime_ms,temperature_c,humidity_pct,pressure_hpa,wind_rpm," +
    "rain_tips_total,rain_tips_interval,raining,rain_plate_wet,jsn_level_cm,ai_level_cm,ai_valid,pump_in,pump_out,mode,fault,wifi_connected)" +
    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [1,d.seq,d.uptimeMs,d.temperatureC,d.humidityPct,d.pressureHpa,d.windRpm,
     d.rainTipsTotal,d.rainTipsInterval,Number(d.raining),Number(d.rainPlateWet),
     d.jsnLevelCm,d.aiLevelCm,Number(d.aiValid),Number(d.pumpIn),Number(d.pumpOut),
     d.mode,d.fault,Number(d.wifiConnected)]
  );
}

function attachNode1Api(app) {
  const key = process.env.NODE1_UPLOAD_KEY || "";
  let latest = null, lastAt = 0, accepted = 0;
  const num = (x,lo,hi) => typeof x==="number" && Number.isFinite(x) && x>=lo && x<=hi ? x : null;
  const authorized = req => {
    const supplied=req.get("x-node-key") || "";
    const a=Buffer.from(key), b=Buffer.from(supplied);
    return !!key && a.length===b.length && crypto.timingSafeEqual(a,b);
  };

  app.post("/api/node1/telemetry", express.json({limit:"3kb"}), async (req,res) => {
    if (!authorized(req)) return res.sendStatus(401);
    const d=req.body || {};
    if (d.nodeId!==1 || !Number.isSafeInteger(d.seq) || d.seq<0) {
      return res.status(400).json({error:"invalid_node_or_seq"});
    }
    const out={
      nodeId:1,seq:d.seq,uptimeMs:num(d.uptimeMs,0,4294967295),
      temperatureC:num(d.temperatureC,-40,100),humidityPct:num(d.humidityPct,0,100),
      pressureHpa:num(d.pressureHpa,300,1200),windRpm:num(d.windRpm,0,10000),
      rainTipsTotal:num(d.rainTipsTotal,0,1e10),rainTipsInterval:num(d.rainTipsInterval,0,1e7),
      raining:d.raining===true,rainPlateWet:d.rainPlateWet===true,
      jsnLevelCm:num(d.jsnLevelCm,0,40),aiLevelCm:num(d.aiLevelCm,0,10),
      aiValid:d.aiValid===true,pumpIn:d.pumpIn===true,pumpOut:d.pumpOut===true,
      mode:["IDLE","FILL","DRAIN","FAULT","WAIT"].includes(d.mode)?d.mode:"FAULT",
      fault:typeof d.fault==="string"?d.fault.slice(0,64):"",
      wifiConnected:d.wifiConnected===true,at:new Date().toISOString()
    };
    if(SAVE_MYSQL){
      try {
        await storeTelemetry(out);
      }catch(err){
        tableReady=false;
        console.error("[NODE1] MySQL save failed:",err.message);
        return res.status(503).json({ok:false,error:"database_unavailable"});
      }
    }
    latest=out;lastAt=Date.now();accepted++;
    res.set("Cache-Control","no-store").json({ok:true,seq:accepted,stored:SAVE_MYSQL});
  });

  app.get("/api/node1/status",(_req,res)=>{
    const online=!!latest && Date.now()-lastAt<=30000;
    res.set({"Cache-Control":"no-store","Access-Control-Allow-Origin":"*"})
      .json({online,ageMs:latest?Date.now()-lastAt:null,node:online?latest:null,storage:SAVE_MYSQL?"mysql":"memory"});
  });
  console.log("[NODE1] LTE telemetry:",key?"secured":"NODE1_UPLOAD_KEY MISSING",
    "storage:",SAVE_MYSQL?"mysql":"memory");
}
module.exports={attachNode1Api};
