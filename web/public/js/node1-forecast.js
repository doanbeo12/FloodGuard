(() => {
  "use strict";
  const base=String(window.FLOODGUARD_API_BASE_URL||location.origin).replace(/\/$/,"");
  const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value;};
  let busy=false,timer=null,stopped=false;
  function schedule(ms=3000){if(timer!==null)clearTimeout(timer);if(!stopped)timer=setTimeout(refresh,ms);}
  function rainDecision(d,hours){
    if(d.rain?.rainingNow===true)return true;
    const p=d.model?.probabilities?.["rain"+hours];
    if(typeof p==="number"&&Number.isFinite(p))return p>=0.35;
    // Hour 1 has no trained RF yet. Use existing sensor trend score,
    // not another horizon's RF probability or an invented model output.
    if(hours===1&&typeof d.rain?.score==="number")return d.rain.score>=3;
    return null;
  }
  async function refresh(){
    if(busy||stopped)return;
    if(document.hidden){schedule();return;}
    busy=true;
    const controller=new AbortController();
    const watchdog=setTimeout(()=>controller.abort(),6500);
    try{
      const res=await fetch(base+"/api/node1/forecast?t="+Date.now(),{signal:controller.signal,cache:"no-store"});
      if(!res.ok)throw Error("HTTP "+res.status);
      const d=await res.json();
      const live=d.online===true;
      const rain3=live?rainDecision(d,3):null;
      // Flood conclusion only when a validated model OR current AI measurement
      // supports it. No fabricated negative for unavailable camera measurements.
      const fp=live?d.model?.probabilities?.flood3:null;
      const ai=live?d.water?.currentCm:null;
      const flood=typeof fp==="number"?fp>=0.35:
        typeof ai==="number"&&Number.isFinite(ai)?ai>=7:null;
      set("forecastState",live?"Dự báo":"Ngoại tuyến");
      set("forecastRain3h",rain3===null?"--":rain3?"Có mưa":"Không mưa");
      set("forecastFlood3h",flood===null?"--":flood?"Có ngập":"Không ngập");
      for(const hours of [1,2,3]){
        const result=live?rainDecision(d,hours):null;
        set("forecast"+hours,result===null?"--":result?"Có mưa":"Không mưa");
        set("forecastIcon"+hours,result===null?"☁️":result?"🌧️":"☀️");
      }
    }catch(err){
      set("forecastState","Ngoại tuyến");
      for(const id of ["forecastRain3h","forecastFlood3h","forecast1","forecast2","forecast3"])set(id,"--");
      console.warn("[FloodGuard forecast]",err.message||err);
    }finally{clearTimeout(watchdog);busy=false;schedule();}
  }
  const resume=()=>{stopped=false;if(!busy)schedule(0);};
  window.addEventListener("pageshow",resume);
  window.addEventListener("focus",()=>{if(!document.hidden)resume();});
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)resume();});
  window.addEventListener("pagehide",()=>{stopped=true;if(timer!==null)clearTimeout(timer);timer=null;});
  refresh();
})();