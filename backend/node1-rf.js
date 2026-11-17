"use strict";
// Pure JS inference of sklearn RandomForestClassifier exported by train.py.
// The Backend needs no Python process. Missing trained models => no prediction.
const fs = require("fs");
const path = require("path");
const MODEL_PATH=path.join(__dirname,"models","node1-rf.json");
const FEATURES=[
  "temperatureC","humidityPct","pressureHpa","windRpm","rainTipsInterval",
  "aiLevelCm","pressureSlope2m","humiditySlope2m","temperatureSlope2m",
  "windMean2m","rainTips2m","waterSlope2m","rainingNow","rainPlateWet",
];
const MISSING=-999.0;
let trained=null;
try{
  const content=JSON.parse(fs.readFileSync(MODEL_PATH,"utf8"));
  if(content.format!=="FloodGuard-RF-v1" ||
    JSON.stringify(content.featureNames)!==JSON.stringify(FEATURES) ||
    content.missingValue!==MISSING)
    throw Error("Unexpected Random Forest feature schema");
  trained=content;
  console.log("[RF] loaded model(s):",Object.keys(content.models||{}).join(", "));
}catch(err){
  console.log("[RF] model unavailable; predictions disabled:",err.code==="ENOENT"?"not trained":err.message);
}
const isnum=x=>typeof x==="number"&&Number.isFinite(x);
const value=x=>isnum(x)?x:MISSING;
function slope(rows,key){
  const valid=rows.filter(r=>isnum(r[key]));
  if(valid.length<3 || valid.at(-1).at-valid[0].at<90000)return MISSING;
  const mid=Math.floor(valid.length/2),a=valid.slice(0,mid),b=valid.slice(mid);
  const avg=(xs,k)=>xs.reduce((sum,r)=>sum+r[k],0)/xs.length;
  const dt=(avg(b,"at")-avg(a,"at"))/60000;
  return dt>0.1?(avg(b,key)-avg(a,key))/dt:MISSING;
}
function extract(rows){
  if(!rows.length)return null;
  const now=rows.at(-1).at;
  const w=rows.filter(r=>r.at>=now-120000 && r.at<=now);
  if(w.length<8 || now-w[0].at<90000)return null;
  for(let i=1;i<w.length;i++)if(w[i].at-w[i-1].at>45000)return null;
  const last=w.at(-1);
  const avg=(list)=>list.reduce((a,b)=>a+b,0)/list.length;
  const validWind=w.map(r=>r.windRpm).filter(isnum);
  const rainTotal=w.reduce((a,r)=>a+(isnum(r.rainTipsInterval)?
    Math.min(10000,Math.max(0,r.rainTipsInterval)):0),0);
  const f={
    temperatureC:value(last.temperatureC),
    humidityPct:value(last.humidityPct),
    pressureHpa:value(last.pressureHpa),
    windRpm:value(last.windRpm),
    rainTipsInterval:value(last.rainTipsInterval),
    aiLevelCm:value(last.aiLevelCm),
    pressureSlope2m:slope(w,"pressureHpa"),
    humiditySlope2m:slope(w,"humidityPct"),
    temperatureSlope2m:slope(w,"temperatureC"),
    windMean2m:validWind.length?avg(validWind):MISSING,
    rainTips2m:rainTotal,
    waterSlope2m:slope(w,"aiLevelCm"),
    rainingNow:last.raining?1:0,
    rainPlateWet:last.rainPlateWet?1:0,
  };
  return FEATURES.map(k=>f[k]);
}
function probability(model,features){
  if(!model||!Array.isArray(model.trees)||!model.trees.length)return null;
  let total=0;
  for(const t of model.trees){
    let idx=0,safety=0;
    while(t.feature[idx]>=0 && safety++<50){
      const featureNo=t.feature[idx];
      if(featureNo>=features.length)return null;
      idx=features[featureNo]<=t.threshold[idx]?t.left[idx]:t.right[idx];
      if(!Number.isSafeInteger(idx)||idx<0||idx>=t.feature.length)return null;
    }
    if(safety>=50 || !isnum(t.p1[idx]))return null;
    total+=t.p1[idx];
  }
  return Math.max(0,Math.min(1,total/model.trees.length));
}
function predict(rows){
  const modelNames=Object.keys(trained?.models||{});
  const out={ready:!!trained,modelsAvailable:modelNames,
    trainedOn:trained?.trainedOn||null,probabilities:{},metrics:{}};
  if(!trained)return out;
  const features=extract(rows);
  if(!features){out.ready=false;out.reason="COLLECTING_FEATURE_HISTORY";return out;}
  for(const [name,model] of Object.entries(trained.models)){
    const rain=name.startsWith("rain");
    if(rain && (features[1]===MISSING||features[2]===MISSING))continue;
    if(name==="flood3" && features[5]===MISSING)continue;
    if(name==="rain3" && (features[12]===1||features[13]===1))continue;
    const p=probability(model,features);
    if(p!==null){
      out.probabilities[name]=Math.round(p*1000)/1000;
      out.metrics[name]=model.metrics||null;
    }
  }
  return out;
}
module.exports={predict};
