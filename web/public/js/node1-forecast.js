(() => {
  "use strict";
  const base=String(window.FLOODGUARD_API_BASE_URL||location.origin).replace(/\/$/,"");
  const el=id=>document.getElementById(id);
  const set=(id,value)=>{const item=el(id);if(item)item.textContent=value;};
  const num=(x,d=1)=>typeof x==="number"&&Number.isFinite(x)?x.toFixed(d):"--";
  const phrases={
    RAINING:"Đang ghi nhận mưa",HIGH:"Dấu hiệu mưa tăng",WATCH:"Cần theo dõi",
    LOW:"Chưa có dấu hiệu mưa rõ",INSUFFICIENT_DATA:"Đang thu dữ liệu"
  };
  const trends={RISING:"Đang tăng",FALLING:"Đang giảm",STABLE:"Ổn định",
    COLLECTING_HISTORY:"Đang thu xu hướng",AI_UNAVAILABLE:"AI chưa có dữ liệu"};
  let timer=null, busy=false, stopped=false;
  async function refresh(){
    if(busy||stopped)return;
    if(document.hidden){queue(3000);return;}
    busy=true;
    const controller=new AbortController();
    const watchdog=setTimeout(()=>controller.abort(),6000);
    try{
      const response=await fetch(base+"/api/node1/forecast?t="+Date.now(),{
        cache:"no-store",signal:controller.signal
      });
      if(!response.ok)throw Error("HTTP "+response.status);
      const data=await response.json();
      const live=data.online===true;
      set("forecastState",!live?"Node 1 ngoại tuyến":
        data.ready?"Đang phân tích cảm biến":"Đang thu dữ liệu");
      set("forecastHistory",num(data.historyMinutes,1)+" phút thực");
      const horizon=data.rain?.byHorizon||[];
      for(const hours of [24,48,72]){
        const item=horizon.find(x=>x.simHours===hours);
        set("forecast"+hours,live&&item?item.outlook:"Chưa có dữ liệu");
      }
      set("forecastRainStatus",live?(phrases[data.rain?.status]||"Đang thu dữ liệu"):"--");
      set("forecastPressure",live&&data.rain?.pressureTrendHpaPerMin!=null?
        num(data.rain.pressureTrendHpaPerMin,3)+" hPa/phút":"--");
      set("forecastHumidity",live&&data.rain?.humidityTrendPctPerMin!=null?
        num(data.rain.humidityTrendPctPerMin,3)+" %/phút":"--");
      set("forecastSignals",live?(data.rain?.signals?.join(" · ")||"Chưa có dấu hiệu rõ"):"--");
      set("forecastWaterLevel",live&&data.water?.currentCm!=null?
        num(data.water.currentCm,2)+" cm":"--");
      set("forecastWaterTrend",live?(trends[data.water?.status]||"--"):"--");
    }catch(err){
      set("forecastState","Mất kết nối dự báo");
      for(const id of ["forecast24","forecast48","forecast72"])set(id,"Không lấy được dữ liệu");
      for(const id of ["forecastRainStatus","forecastPressure","forecastHumidity",
        "forecastSignals","forecastWaterLevel","forecastWaterTrend","forecastHistory"])set(id,"--");
      console.warn("[FloodGuard forecast]",err.message||err);
    }finally{
      clearTimeout(watchdog);busy=false;queue(3000);
    }
  }
  function queue(ms=0){
    if(timer!==null)clearTimeout(timer);
    if(!stopped)timer=setTimeout(refresh,ms);
  }
  const resume=()=>{stopped=false;if(!busy)queue(0);};
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)resume();});
  window.addEventListener("pageshow",resume);
  window.addEventListener("focus",()=>{if(!document.hidden)resume();});
  window.addEventListener("pagehide",()=>{stopped=true;if(timer!==null)clearTimeout(timer);timer=null;});
  refresh();
})();