"use strict";
// FloodGuard independent HTTP camera transport, fallback for unstable WebSockets.
// Each process retains only the latest JPEG and AI metadata. Never store disks/DB.
const crypto = require("crypto");
const express = require("express");
const MAX_FRAME_BYTES = 180 * 1024;
const STALE_MS = 15000;
let jpeg = null;
let jpegAt = 0;
let ai = null;
let aiAt = 0;
let accepted = 0;

function authorized(req) {
  const expectedKey = process.env.CAMERA_STREAM_KEY || "";
  const supplied = req.get("x-camera-key") || "";
  const a = Buffer.from(expectedKey);
  const b = Buffer.from(supplied);
  return !!expectedKey && a.length === b.length && crypto.timingSafeEqual(a,b);
}

function attachCameraHttp(app) {
  app.post("/camera/frame", express.raw({type:["image/jpeg", "application/octet-stream"],limit:"180kb"}), (req,res) => {
    if (!authorized(req)) return res.sendStatus(401);
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length < 4 || data.length > MAX_FRAME_BYTES ||
        data[0] !== 255 || data[1] !== 216 ||
        data[data.length-2] !== 255 || data[data.length-1] !== 217) {
      return res.status(400).json({ok:false,error:"invalid_jpeg"});
    }
    jpeg = Buffer.from(data);
    jpegAt = Date.now();
    accepted++;
    res.set("Cache-Control","no-store").json({ok:true,seq:accepted});
  });
  app.post("/camera/ai", express.json({limit:"2kb"}), (req,res) => {
    if (!authorized(req)) return res.sendStatus(401);
    const v = req.body || {};
    const allowed = new Set(["ok","uncalibrated","not_detected","out_of_range","low_confidence","error"]);
    if (!allowed.has(v.status)) return res.sendStatus(400);
    const valid = v.status === "ok" && Number.isFinite(v.levelCm) &&
       v.levelCm >= 0 && v.levelCm <= 10 && Number.isFinite(v.confidence) &&
       v.confidence >= 0 && v.confidence <= 1;
    ai = {type:"ai",status:valid?"ok":v.status==="ok"?"error":v.status,
          levelCm:valid?Math.round(v.levelCm*100)/100:null,
          confidence:valid?Math.round(v.confidence*100)/100:null,
          at:Date.now()};
    aiAt=Date.now();
    res.set("Cache-Control","no-store").json({ok:true});
  });
  app.get("/camera/latest.jpg",(req,res)=>{
    res.set({"Cache-Control":"no-store, no-cache, must-revalidate",
             "Pragma":"no-cache","Access-Control-Allow-Origin":"*"});
    if (!jpeg || Date.now()-jpegAt>STALE_MS) return res.sendStatus(503);
    res.type("jpeg").send(jpeg);
  });
  app.get("/camera/status",(req,res)=>{
    const now=Date.now(),online=!!jpeg&&now-jpegAt<=STALE_MS;
    res.set({"Cache-Control":"no-store","Access-Control-Allow-Origin":"*"})
       .json({online,lastFrameAt:jpegAt||null,ageMs:jpegAt?now-jpegAt:null,
         transport:"http",seq:accepted,
         ai:online&&ai&&now-aiAt<=STALE_MS?ai:{type:"ai",status:"offline",levelCm:null}});
  });
}
module.exports={attachCameraHttp};
