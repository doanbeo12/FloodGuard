(() => {
  "use strict";
  const base=String(window.FLOODGUARD_API_BASE_URL||location.origin).replace(/\/$/,"");
  const svg=document.getElementById("levelHistoryChart");
  const note=document.getElementById("levelChartStatus");
  const buttons=[...document.querySelectorAll("[data-level-minutes]")];
  if(!svg||!note)return;
  const NS="http://www.w3.org/2000/svg", W=1000,H=280;
  const plot={left:52,right:982,top:20,bottom:238};
  let minutes=60, timer=null, busy=false, inactive=false;
  const create=(type,attrs={})=>{
    const node=document.createElementNS(NS,type);
    for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));
    svg.appendChild(node);
    return node;
  };
  const text=(x,y,value,anchor="start")=>{
    const n=create("text",{x,y,"text-anchor":anchor,fill:"#64748b","font-size":12,"font-family":"system-ui, sans-serif"});
    n.textContent=value;
  };
  const timeLabel=(t)=>new Date(t).toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit",hour12:false});
  function draw(points){
    svg.setAttribute("viewBox",`0 0 ${W} ${H}`);
    svg.replaceChildren();
    const now=Date.now(),start=now-minutes*60000;
    const rows=points.map(p=>({time:Date.parse(p.at),jsn:p.jsnCm,ai:p.aiCm}))
      .filter(p=>Number.isFinite(p.time)&&p.time>=start-15000&&p.time<=now+15000)
      .sort((a,b)=>a.time-b.time);
    const numbers=rows.flatMap(p=>[p.jsn,p.ai]).filter(v=>typeof v==="number"&&Number.isFinite(v)&&v>=0);
    const max=Math.max(10,Math.ceil(Math.max(0,...numbers)/2)*2);
    const x=t=>plot.left+(t-start)/(minutes*60000)*(plot.right-plot.left);
    const y=v=>plot.bottom-v/max*(plot.bottom-plot.top);
    for(let i=0;i<=5;i++){
      const v=max*i/5,py=y(v);
      create("line",{x1:plot.left,y1:py,x2:plot.right,y2:py,stroke:"#e4eaf3","stroke-width":1});
      text(plot.left-10,py+4,v.toFixed(v%1?1:0),"end");
    }
    for(let i=0;i<=4;i++){
      const ts=start+(now-start)*i/4,px=x(ts);
      text(px,plot.bottom+22,timeLabel(ts),i===0?"start":i===4?"end":"middle");
    }
    const series=[
      {key:"jsn",color:"#0b7198"},
      {key:"ai",color:"#ed9140"}
    ];
    for(const item of series){
      let current=[],segments=[];
      const flush=()=>{if(current.length)segments.push(current);current=[];};
      let prev=null;
      for(const row of rows){
        const value=row[item.key];
        if(typeof value!=="number"||!Number.isFinite(value)||value<0){flush();prev=null;continue;}
        if(prev!==null&&row.time-prev>45000)flush();
        current.push([x(row.time),y(value)]);
        prev=row.time;
      }
      flush();
      for(const seg of segments){
        if(seg.length===1){
          create("circle",{cx:seg[0][0],cy:seg[0][1],r:3.5,fill:item.color});
        }else{
          create("polyline",{points:seg.map(p=>p.join(",")).join(" "),fill:"none",stroke:item.color,"stroke-width":2.8,"stroke-linecap":"round","stroke-linejoin":"round"});
        }
      }
    }
    if(!numbers.length)text(W/2,H/2,"Chưa có số đo trong khoảng thời gian này","middle");
    return numbers.length;
  }
  async function refresh(){
    if(busy||inactive||document.hidden)return;
    busy=true;
    const abort=new AbortController(),watch=setTimeout(()=>abort.abort(),8500);
    try{
      const res=await fetch(base+"/api/node1/level-history?minutes="+minutes+"&t="+Date.now(),{signal:abort.signal,cache:"no-store"});
      if(!res.ok)throw Error("HTTP "+res.status);
      const data=await res.json();
      const count=draw(Array.isArray(data.points)?data.points:[]);
      note.textContent=count?"Lịch sử số đo thực tế từ Node 1":"Chưa có dữ liệu mực nước trong khoảng đã chọn";
    }catch(err){
      note.textContent="Chưa tải được lịch sử mực nước";
      console.warn("[FloodGuard chart]",err);
    }finally{clearTimeout(watch);busy=false;}
  }
  buttons.forEach(btn=>btn.addEventListener("click",()=>{
    minutes=Number(btn.dataset.levelMinutes);
    buttons.forEach(b=>b.classList.toggle("selected",b===btn));
    refresh();
  }));
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)refresh();});
  window.addEventListener("pageshow",()=>{inactive=false;refresh();});
  window.addEventListener("pagehide",()=>{inactive=true;});
  draw([]);
  refresh();
  timer=setInterval(()=>{if(!inactive)refresh();},15000);
})();
