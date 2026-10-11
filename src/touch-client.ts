export interface TouchGeometry {width:number;height:number;left:number;top:number;displayWidth:number;displayHeight:number}
interface Point {id:number;x:number;y:number;t:number}
interface Gesture {id:string;seq:number;ack:number;geometry:TouchGeometry;pointers:Map<number,Point>;pending:Point[];started:number}

export function installTouch(options:{
  element:HTMLElement;geometry:()=>TouchGeometry;canStart:()=>boolean;canContinue:()=>boolean;
  send:(message:unknown)=>boolean;unavailable:()=>void;changed:(active:boolean)=>void;
  point:(x:number,y:number)=>void;error:(message:string)=>void;
}){
  let gesture:Gesture|null=null,last:Gesture|null=null,timer:ReturnType<typeof setTimeout>|undefined,watchdog:ReturnType<typeof setInterval>|undefined,lastProgressAt=0,lastKeepalive=0;
  const diagnostics={receivedSamples:0,sentSamples:0,processedSamples:0,queueMs:0,cancellations:0,lastError:null as string|null};
  const clearTimer=()=>{clearTimeout(timer);timer=undefined;};
  const point=(event:PointerEvent,id:number,g:Gesture):Point=>({id,
    x:Math.max(0,Math.min(g.geometry.width-1,(event.clientX-g.geometry.left)/g.geometry.displayWidth*g.geometry.width)),
    y:Math.max(0,Math.min(g.geometry.height-1,(event.clientY-g.geometry.top)/g.geometry.displayHeight*g.geometry.height)),t:Math.max(0,event.timeStamp-g.started)});
  function send(g:Gesture,message:object,count:number){
    if(!g.seq)lastProgressAt=performance.now();
    if(g.seq-g.ack>512||!options.send({...message,gesture:g.id,seq:g.seq,width:g.geometry.width,height:g.geometry.height})){cancel('控制通道拥堵或已断开，手势已取消');return false;}
    g.seq+=count;diagnostics.sentSamples+=count;return true;
  }
  function flush(){clearTimer();const g=gesture;if(!g||!g.pending.length)return;const points=g.pending.splice(0).sort((a,b)=>a.t-b.t);send(g,{type:'touch-move',points},points.length);}
  function finish(){const old=gesture;gesture=null;clearTimer();clearInterval(watchdog);watchdog=undefined;
    if(old)for(const id of old.pointers.keys())try{if(options.element.hasPointerCapture(id))options.element.releasePointerCapture(id);}catch{}
    options.changed(false);
  }
  function cancel(message?:string,notify=true){const g=gesture;if(!g)return;last=g;diagnostics.cancellations++;if(message){diagnostics.lastError=message;options.error(message);}
    if(notify)options.send({type:'touch-cancel',gesture:g.id});finish();
  }
  options.element.addEventListener('dragstart',event=>event.preventDefault());
  options.element.addEventListener('contextmenu',event=>event.preventDefault());
  options.element.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    if(!gesture&&!options.canStart()){event.preventDefault();options.unavailable();return;}
    if(gesture&&!options.canContinue()){cancel('手机当前不可操作，手势已取消');return;}
    if(gesture?.pointers.size===2||gesture?.pointers.has(event.pointerId))return;
    event.preventDefault();
    if(gesture){const previous=gesture;flush();if(gesture!==previous)return;}
    if(!gesture){const geometry=options.geometry();if(!geometry.width||!geometry.height||geometry.displayWidth<=0||geometry.displayHeight<=0)return;
      gesture={id:crypto.randomUUID(),seq:0,ack:-1,geometry,pointers:new Map(),pending:[],started:event.timeStamp};last=gesture;
      diagnostics.receivedSamples=diagnostics.sentSamples=diagnostics.processedSamples=0;
      options.changed(true);
      lastKeepalive=performance.now();watchdog=setInterval(()=>{
        if(gesture&&gesture.seq>gesture.ack+1&&performance.now()-lastProgressAt>2000){cancel('控制响应超时，手势已取消；不会重放');return;}
        if(gesture&&performance.now()-lastKeepalive>=1000){lastKeepalive=performance.now();if(!options.send({type:'touch-keepalive',gesture:gesture.id}))cancel('控制通道中断，手势已取消');}
      },250);
    }
    const g=gesture,ids=new Set([...g.pointers.values()].map(p=>p.id)),id=ids.has(10)?11:10,p=point(event,id,g);
    g.pointers.set(event.pointerId,p);diagnostics.receivedSamples++;
    if(!send(g,{type:'touch',action:0,...p},1))return;
    try{options.element.setPointerCapture(event.pointerId);}catch{}
    options.point(p.x,p.y);
    // Keyboard focus is optional and must never gate touch forwarding.
    if(event.pointerType==='mouse')options.element.focus({preventScroll:true});
  });
  document.addEventListener('pointermove',event=>{const g=gesture,p=g?.pointers.get(event.pointerId);if(!g||!p)return;
    if(!options.canContinue()){cancel('手机当前不可操作，手势已取消');return;}
    if(event.cancelable)event.preventDefault();
    let samples:PointerEvent[]=[];try{samples=event.getCoalescedEvents?.()||[];}catch{}const events=samples.length?samples:[event];
    for(const sample of events){const next=point(sample,p.id,g);g.pointers.set(event.pointerId,next);g.pending.push(next);diagnostics.receivedSamples++;
      if(g.pending.length>=64){flush();if(gesture!==g)return;}}
    if(!timer)timer=setTimeout(flush,8);
  },{capture:true,passive:false});
  document.addEventListener('pointerup',event=>{const g=gesture,p=g?.pointers.get(event.pointerId);if(!g||!p)return;if(event.cancelable)event.preventDefault();
    const end=point(event,p.id,g);if(end.x!==p.x||end.y!==p.y){g.pending.push(end);diagnostics.receivedSamples++;}flush();if(gesture!==g)return;
    if(!send(g,{type:'touch',action:1,...end},1))return;g.pointers.delete(event.pointerId);
    try{if(options.element.hasPointerCapture(event.pointerId))options.element.releasePointerCapture(event.pointerId);}catch{}
    if(!g.pointers.size)finish();
  },{capture:true,passive:false});
  document.addEventListener('pointercancel',event=>{if(gesture?.pointers.has(event.pointerId))cancel('浏览器取消了触摸，手势已释放');},true);
  options.element.addEventListener('lostpointercapture',event=>{if(gesture?.pointers.has(event.pointerId)&&!options.element.hasPointerCapture(event.pointerId))cancel('触摸捕获中断，手势已释放');});
  return {active:()=>!!gesture,cancel,validateGeometry:()=>{if(!gesture)return;const size=options.geometry();if(size.width!==gesture.geometry.width||size.height!==gesture.geometry.height)cancel('手机显示尺寸已变化，手势已释放');},
    acknowledgement:(data:any)=>{if(data.type==='error'&&data.cancelled&&gesture){cancel(data.message||'控制手势已取消');return;}const g=last;if(!g||data.gesture!==g.id)return;
      if(data.type==='error'){if(gesture===g)cancel(data.message||'控制手势失败');else{diagnostics.lastError=data.message;options.error(data.message);}return;}
      if(Number.isInteger(data.seq)&&data.seq>g.ack){diagnostics.processedSamples+=data.seq-g.ack;g.ack=data.seq;lastProgressAt=performance.now();diagnostics.queueMs=data.queueMs||0;}
    },snapshot:()=>({...diagnostics,active:!!gesture,lastGesture:last?.id,lastSentSequence:last?last.seq-1:null,lastProcessedSequence:last?.ack??null})};
}
