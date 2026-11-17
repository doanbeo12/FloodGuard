(() => {
  "use strict";
  const base=String(window.FLOODGUARD_API_BASE_URL||location.origin).replace(/\/$/,"");
  const el=id=>document.getElementById(id);
  const write=(id,value)=>{const n=el(id);if(n)n.textContent=value;};
  const val=(v,d=1)=>typeof v==="number"&&Number.isFinite(v)?v.toFixed(d):"--";
  function badge(online){
    const n=el("nodeBadge");n.textContent=online?"Node 1: Trực tuyến":"Node 1: Ngoại tuyến";
    n.className="pill "+(online?"good":"muted");
  }
  let busy=false, timer=null, stopped=false;
  const schedule=(ms=2000)=>{if(timer!==null)clearTimeout(timer);if(!stopped)timer=setTimeout(refresh,ms);};
  async function refresh(){
    if(busy||stopped)return;
    if(document.hidden){schedule(2000);return;}
    busy=true;
    try{
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),7000);
      let response;
      try{response=await fetch(base+"/api/node1/status?t="+Date.now(),{cache:"no-store",signal:controller.signal});}
      finally{clearTimeout(timer);}
      if(!response.ok)throw Error("HTTP "+response.status);
      const data=await response.json();
      badge(data.online);
      if(!data.online || !data.node) {
        for(const id of ["rainState","rainTips","rainTotal","rainPlate","pumpIn","pumpOut","pumpMode","temperature","humidity","pressure","windRpm","jsnLevel","nodeUpdated"])
          write(id,"--");
        write("pumpFault","");
        return;
      }
      const n=data.node;
      write("rainState",n.raining?"Đang mưa":"Không mưa");
      write("rainTips",n.rainTipsInterval??"--");
      write("rainTotal",n.rainTipsTotal??"--");
      write("rainPlate",n.rainPlateWet?"Ướt":"Khô");
      write("pumpIn",n.pumpIn?"BẬT":"TẮT");
      write("pumpOut",n.pumpOut?"BẬT":"TẮT");
      const modes={IDLE:"Chờ",FILL:"Cấp nước",DRAIN:"Hồi nước",WAIT:"Đổi bơm",FAULT:"Lỗi"};
      write("pumpMode",modes[n.mode]||"--");
      write("pumpFault",n.fault?"Cảnh báo: "+n.fault:"");
      write("temperature",val(n.temperatureC)+" °C");
      write("humidity",val(n.humidityPct)+" %");
      write("pressure",val(n.pressureHpa)+" hPa");
      write("windRpm",val(n.windRpm,0)+" RPM");
      write("jsnLevel",val(n.jsnLevelCm)+" cm");
      write("nodeUpdated",n.at?new Date(n.at).toLocaleTimeString("vi-VN",{hour12:false}):"--");
    }catch(e){
      badge(false);
      for(const id of ["rainState","rainTips","rainTotal","rainPlate","pumpIn","pumpOut","pumpMode","temperature","humidity","pressure","windRpm","jsnLevel","nodeUpdated"])write(id,"--");
      write("pumpFault","");
    }finally{busy=false;schedule();}
  }
  const resume=()=>{stopped=false;if(!busy)schedule(0);};
  window.addEventListener("pageshow",resume);
  window.addEventListener("focus",()=>{if(!document.hidden)resume();});
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)resume();});
  window.addEventListener("pagehide",()=>{stopped=true;if(timer!==null)clearTimeout(timer);timer=null;});
  refresh();
})();