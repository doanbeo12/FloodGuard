"use strict";
const express = require("express");
const crypto = require("crypto");

function attachNode1Api(app) {
  const key = process.env.NODE1_UPLOAD_KEY || "";
  let latest = null;
  let lastAt = 0;
  let seq = 0;
  const num = (x, lo, hi) => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? x : null;
  const authorized = req => {
    const candidate = req.get("x-node-key") || "";
    const a = Buffer.from(key), b = Buffer.from(candidate);
    return !!key && a.length === b.length && crypto.timingSafeEqual(a,b);
  };
  app.post("/api/node1/telemetry", express.json({limit:"3kb"}), (req,res) => {
    if (!authorized(req)) return res.sendStatus(401);
    const d = req.body || {};
    if (d.nodeId !== 1 || typeof d.seq !== "number" || !Number.isSafeInteger(d.seq) || d.seq < 0) {
      return res.status(400).json({error:"invalid_node"});
    }
    const out = {
      nodeId:1, seq:d.seq, uptimeMs:num(d.uptimeMs,0,4294967295),
      temperatureC:num(d.temperatureC,-40,100),humidityPct:num(d.humidityPct,0,100),
      pressureHpa:num(d.pressureHpa,300,1200),windRpm:num(d.windRpm,0,10000),
      rainTipsTotal:num(d.rainTipsTotal,0,1e10), rainTipsInterval:num(d.rainTipsInterval,0,1e7),
      raining: d.raining === true, rainPlateWet:d.rainPlateWet === true,
      jsnLevelCm:num(d.jsnLevelCm,0,40), aiLevelCm:num(d.aiLevelCm,0,10),
      aiValid:d.aiValid===true, pumpIn:d.pumpIn===true,
      pumpOut:d.pumpOut===true, mode:["IDLE","FILL","DRAIN","FAULT","WAIT"].includes(d.mode)?d.mode:"FAULT",
      fault:typeof d.fault==="string"?d.fault.slice(0,64):"",
      wifiConnected:d.wifiConnected===true,
      at:new Date().toISOString()
    };
    latest=out;lastAt=Date.now();seq++;
    res.set("Cache-Control","no-store").json({ok:true,seq});
  });
  app.get("/api/node1/status",(_req,res)=>{
    const online=!!latest && Date.now()-lastAt<=30000;
    res.set({"Cache-Control":"no-store","Access-Control-Allow-Origin":"*"})
       .json({online,ageMs:latest?Date.now()-lastAt:null,node:online?latest:null});
  });
  console.log("[NODE1] HTTP 4G telemetry ready:",key?"secured":"disabled: NODE1_UPLOAD_KEY missing");
}
module.exports={attachNode1Api};
