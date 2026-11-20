"use strict";
const express = require("express");
const crypto = require("crypto");
const { pool } = require("./db");
const mqtt = require("mqtt");
const sensorForecast = require("./node1-forecast");

const SAVE_MYSQL = String(process.env.NODE1_STORE_MYSQL || "false").toLowerCase() === "true";
let tableReady = false;
const MAX_DB_BUFFER = 360; // limit memory (~60 minutes at 10 s telemetry)
const DB_RETRY_MS = 30000;
const storeStatus = { enabled:SAVE_MYSQL, saved:0, failed:0, dropped:0,
  buffered:0, lastSavedAt:null, lastError:null, lastErrorCode:null, lastAttemptAt:null };

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
  const key=process.env.NODE1_UPLOAD_KEY||"";
  const topic=process.env.MQTT_NODE1_TOPIC||"flood-monitoring/floodguard-doanbeo12/node1-telemetry-v3";
  const broker=process.env.MQTT_NODE1_URL||"mqtt://broker.hivemq.com:1883";
  const enabled=process.env.MQTT_NODE1_ENABLED==="true";
  let latest=null, lastAt=0, accepted=0;
  const pending=[];
  let flushing=false;
  let nextRetryAt=0;
  async function flushTelemetry(){
    if(!SAVE_MYSQL || flushing || pending.length===0 || Date.now()<nextRetryAt)return;
    flushing=true;
    try{
      // Keep the event loop and Web responsive. Bound each attempt to 20 inserts.
      for(let count=0;count<20 && pending.length;count++){
        storeStatus.lastAttemptAt=new Date().toISOString();
        await storeTelemetry(pending[0]);
        pending.shift();
        storeStatus.saved++;
        storeStatus.lastSavedAt=new Date().toISOString();
        if(storeStatus.saved===1 || storeStatus.saved%20===0)
          console.log("[NODE1 DB] saved",storeStatus.saved,"telemetry rows; pending",pending.length);
        storeStatus.lastError=null;
        storeStatus.lastErrorCode=null;
      }
      storeStatus.buffered=pending.length;
      nextRetryAt=0;
    }catch(err){
      tableReady=false;
      storeStatus.failed++;
      storeStatus.lastError=String(err.message||"Unknown database error").slice(0,220);
      storeStatus.lastErrorCode=err.code||null;
      storeStatus.buffered=pending.length;
      nextRetryAt=Date.now()+DB_RETRY_MS;
      console.error("[NODE1 DB] save failed (retry in 30s):",err.code||"",err.message);
    }finally{flushing=false;}
  }
  if(SAVE_MYSQL){
    const worker=setInterval(()=>void flushTelemetry(),1000);
    if(typeof worker.unref==="function")worker.unref();
  }

  const num=(x,lo,hi)=>typeof x==="number"&&Number.isFinite(x)&&x>=lo&&x<=hi?x:null;

  function normalize(d) {
    if(!d || d.nodeId!==1 || !Number.isSafeInteger(d.seq) || d.seq<0)return null;
    return {
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
  }
  function receive(d, source) {
    const out=normalize(d);
    if(!out)return false;
    latest=out;lastAt=Date.now();accepted++;
    sensorForecast.observe(out);
    if(SAVE_MYSQL){
      pending.push(out);
      if(pending.length>MAX_DB_BUFFER){pending.shift();storeStatus.dropped++;}
      storeStatus.buffered=pending.length;
      void flushTelemetry();
    }
    if(accepted===1 || accepted%10===0)
      console.log("[NODE1] received",source,"seq:",out.seq,"count:",accepted);
    return true;
  }
  const authorized=req=>{
    const supplied=req.get("x-node-key")||"";
    const a=Buffer.from(key),b=Buffer.from(supplied);
    return !!key&&a.length===b.length&&crypto.timingSafeEqual(a,b);
  };
  // Retain legacy HTTPS ingest endpoint for diagnostics, disabled without key.
  app.post("/api/node1/telemetry",express.json({limit:"3kb"}),(req,res)=>{
    if(!authorized(req))return res.sendStatus(401);
    if(!receive(req.body,"https"))return res.status(400).json({error:"invalid_telemetry"});
    res.set("Cache-Control","no-store").json({ok:true,seq:accepted,storage:SAVE_MYSQL?"mysql":"memory"});
  });
  app.get("/api/node1/status",(_req,res)=>{
    const online=!!latest&&Date.now()-lastAt<=30000;
    res.set({"Cache-Control":"no-store","Access-Control-Allow-Origin":"*"})
      .json({online,ageMs:latest?Date.now()-lastAt:null,node:online?latest:null,
        storage:SAVE_MYSQL?"mysql":"memory",transport:enabled?"mqtt":"https"});
  });
  // Read-only telemetry history for the dashboard water-level chart.
  app.get("/api/node1/level-history", async (req, res) => {
    res.set({"Cache-Control":"no-store","Access-Control-Allow-Origin":"*"});
    if (!SAVE_MYSQL) return res.json({minutes:60,points:[],available:false});
    const allowed=[30,60,120];
    const minutes=allowed.includes(Number(req.query.minutes))?Number(req.query.minutes):60;
    try {
      const [rows]=await pool.execute(
        "SELECT received_at, jsn_level_cm, ai_level_cm, ai_valid " +
        "FROM node1_telemetry " +
        "WHERE received_at >= DATE_SUB(NOW(3), INTERVAL ? MINUTE) " +
        "ORDER BY received_at DESC LIMIT 800", [minutes]
      );
      const points=rows.reverse().map(row=>({
        at:row.received_at instanceof Date?row.received_at.toISOString():String(row.received_at),
        jsnCm:Number.isFinite(Number(row.jsn_level_cm))&&row.jsn_level_cm!==null?Number(row.jsn_level_cm):null,
        aiCm:row.ai_valid===1 || row.ai_valid===true ?
          (row.ai_level_cm!==null&&Number.isFinite(Number(row.ai_level_cm))?Number(row.ai_level_cm):null):null
      }));
      res.json({minutes,available:true,points});
    } catch(err) {
      console.error("[NODE1] level-history:",err.code||"",err.message);
      res.status(503).json({error:"history_unavailable"});
    }
  });
  // Operational status only: no credentials, host or database name in response.
  app.get("/api/node1/storage-status",(_req,res)=>{
    res.set({"Cache-Control":"no-store","Access-Control-Allow-Origin":"*"})
      .json({enabled:storeStatus.enabled,saved:storeStatus.saved,
        failed:storeStatus.failed,dropped:storeStatus.dropped,
        buffered:pending.length,lastSavedAt:storeStatus.lastSavedAt,
        lastErrorCode:storeStatus.lastErrorCode,
        nextRetryInMs:Math.max(0,nextRetryAt-Date.now()),
        status:!SAVE_MYSQL?"DISABLED":storeStatus.saved>0 && !storeStatus.lastErrorCode?"WRITING":
          storeStatus.lastErrorCode?"DB_ERROR":"WAITING_FOR_FIRST_WRITE"});
  });
  app.get("/api/node1/forecast",(_req,res)=>{
    res.set({"Cache-Control":"no-store","Access-Control-Allow-Origin":"*"})
      .json(sensorForecast.forecast());
  });
  if(enabled){
    // MQTT public broker: topic isolation is NOT authentication. Telemetry only.
    const client=mqtt.connect(broker,{
      clientId:"FGNode1Backend_"+require("crypto").randomBytes(6).toString("hex"),
      clean:true,reconnectPeriod:5000,connectTimeout:12000,
      resubscribe:true
    });
    client.on("connect",()=>{
      console.log("[NODE1 MQTT] Connected",broker);
      client.subscribe(topic,{qos:0},err=>{
        if(err)console.error("[NODE1 MQTT] subscribe error:",err.message);
        else console.log("[NODE1 MQTT] Listening:",topic);
      });
    });
    client.on("message",(recvTopic,buf)=>{
      if(recvTopic!==topic||buf.length>3072)return;
      try{
        const data=JSON.parse(buf.toString("utf8"));
        if(!receive(data,"mqtt"))console.warn("[NODE1 MQTT] Invalid payload");
      }catch(err){console.warn("[NODE1 MQTT] Invalid JSON:",err.message);}
    });
    client.on("error",err=>console.error("[NODE1 MQTT]",err.message));
  }else console.log("[NODE1 MQTT] disabled (MQTT_NODE1_ENABLED=false)");
  console.log("[NODE1] telemetry storage:",SAVE_MYSQL?"mysql":"memory");
}
module.exports={attachNode1Api};
