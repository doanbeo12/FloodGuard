(() => {
  "use strict";
  const base=String(window.FLOODGUARD_API_BASE_URL||location.origin).replace(/\/$/,"");
  const el=id=>document.getElementById(id);
  const set=(id,value)=>{const node=el(id);if(node)node.textContent=value;};
  const rainLabel={
    RAINING:"Đang mưa",HIGH:"Nguy cơ cao",WATCH:"Có khả năng mưa",
    LOW:"Nguy cơ thấp",INSUFFICIENT_DATA:"Đang thu dữ liệu"
  };
  const floodLabel={
    HIGH:"Nguy cơ cao",WATCH:"Cần theo dõi",LOW:"Nguy cơ thấp",
    INSUFFICIENT_DATA:"Đang thu dữ liệu"
  };
  const iconFor=code=>code==="RAINING"?"🌧️":code==="HIGH"?"🌦️":
    code==="WATCH"?"🌥️":code==="LOW"?"⛅":"☁️";
  let busy=false,timer=null,stopped=false;
  function schedule(ms=3000){if(timer!==null)clearTimeout(timer);if(!stopped)timer=setTimeout(refresh,ms);}
  async function refresh(){
    if(busy||stopped)return;
    if(document.hidden){schedule();return;}
    busy=true;
    const controller=new AbortController();
    const watchdog=setTimeout(()=>controller.abort(),6500);
    try{
      const response=await fetch(base+"/api/node1/forecast?t="+Date.now(),
        {signal:controller.signal,cache:"no-store"});
      if(!response.ok)throw Error("HTTP "+response.status);
      const d=await response.json();
      const live=d.online===true;
      const n=live?d.nearTerm:null;
      const rainCode=n?.rainRisk||"INSUFFICIENT_DATA";
      const floodCode=n?.floodRisk||"INSUFFICIENT_DATA";
      set("forecastState",!live?"Ngoại tuyến":d.reason==="MODEL_NOT_TRAINED"?"Chưa huấn luyện RF":d.ready?"Random Forest":"Đang thu dữ liệu");
      set("forecastRain3h",live?rainLabel[rainCode]:"Chưa có dữ liệu");
      set("forecastFlood3h",live?floodLabel[floodCode]:"Chưa có dữ liệu");
      for(const hours of [24,48,64]){
        const item=live?d.rain?.byHorizon?.find(x=>x.simHours===hours):null;
        set("forecast"+hours,item?.outlook||"Chưa có dữ liệu");
        set("forecastIcon"+hours,item?iconFor(item.status):"☁️");
        // Do not invent future temperature or humidity forecasts.
        set("forecastTemp"+hours,"Nhiệt độ: --");
        set("forecastHumidity"+hours,"Độ ẩm: --");
      }
    }catch(err){
      set("forecastState","Mất kết nối");
      for(const id of ["forecastRain3h","forecastFlood3h","forecast24","forecast48","forecast64"])
        set(id,"Chưa có dữ liệu");
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