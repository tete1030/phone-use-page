export interface TouchGeometry {width:number;height:number;left:number;top:number;displayWidth:number;displayHeight:number}
interface Point {id:number;x:number;y:number;t:number}
interface Gesture {id:string;seq:number;ack:number;geometry:TouchGeometry;pointers:Map<number,Point>;pending:Point[];started:number}
type Position=Pick<PointerEvent,'clientX'|'clientY'|'timeStamp'>;
interface PendingEntry {pointerId:number;geometry:TouchGeometry;start:Position;previous:Position;entry?:Position}

export function installTouch(options:{
  element:HTMLElement;bufferElement?:HTMLElement;bufferMargin?:number;geometry:()=>TouchGeometry;canStart:()=>boolean;canContinue:()=>boolean;
  send:(message:unknown)=>boolean;unavailable:()=>void;changed:(active:boolean)=>void;
  point:(x:number,y:number)=>void;error:(message:string)=>void;
}){
  let gesture:Gesture|null=null,last:Gesture|null=null,timer:ReturnType<typeof setTimeout>|undefined,watchdog:ReturnType<typeof setInterval>|undefined,lastProgressAt=0,lastKeepalive=0;
  let pendingEntry:PendingEntry|null=null;
  const margin=options.bufferMargin??20;
  const validGeometry=(g:TouchGeometry)=>Object.values(g).every(Number.isFinite)&&g.width>0&&g.height>0&&g.displayWidth>0&&g.displayHeight>0;
  const inside=(p:Position,g:TouchGeometry,padding=0)=>p.clientX>=g.left-padding&&p.clientX<=g.left+g.displayWidth+padding&&p.clientY>=g.top-padding&&p.clientY<=g.top+g.displayHeight+padding;
  const sameGeometry=(a:TouchGeometry,b:TouchGeometry)=>Object.keys(a).every(k=>a[k as keyof TouchGeometry]===b[k as keyof TouchGeometry]);
  const isControl=(target:EventTarget|null)=>target instanceof Element&&!!target.closest('button,a,input,select,textarea,summary,label,[contenteditable],[role="button"],[role="link"],[draggable="true"]');
  function entryPoint(from:Position,to:Position,g:TouchGeometry):Position{
    let fraction=0;
    if(from.clientX<g.left)fraction=Math.max(fraction,(g.left-from.clientX)/(to.clientX-from.clientX));
    if(from.clientX>g.left+g.displayWidth)fraction=Math.max(fraction,(g.left+g.displayWidth-from.clientX)/(to.clientX-from.clientX));
    if(from.clientY<g.top)fraction=Math.max(fraction,(g.top-from.clientY)/(to.clientY-from.clientY));
    if(from.clientY>g.top+g.displayHeight)fraction=Math.max(fraction,(g.top+g.displayHeight-from.clientY)/(to.clientY-from.clientY));
    return {clientX:from.clientX+(to.clientX-from.clientX)*fraction,clientY:from.clientY+(to.clientY-from.clientY)*fraction,timeStamp:to.timeStamp};
  }
  const diagnostics={receivedSamples:0,sentSamples:0,processedSamples:0,queueMs:0,cancellations:0,lastError:null as string|null};
  const clearTimer=()=>{clearTimeout(timer);timer=undefined;};
  const point=(event:Position,id:number,g:Gesture):Point=>({id,
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
  function cancel(message?:string,notify=true){pendingEntry=null;const g=gesture;if(!g)return;last=g;diagnostics.cancellations++;if(message){diagnostics.lastError=message;options.error(message);}
    if(notify)options.send({type:'touch-cancel',gesture:g.id});finish();
  }
  options.element.addEventListener('dragstart',event=>event.preventDefault());
  options.element.addEventListener('contextmenu',event=>event.preventDefault());
  function beginPointer(event:PointerEvent,geometry=options.geometry(),start:Position=event){
    if(!gesture&&!options.canStart()){event.preventDefault();options.unavailable();return;}
    if(gesture&&!options.canContinue()){cancel('手机当前不可操作，手势已取消');return;}
    if(gesture?.pointers.size===2||gesture?.pointers.has(event.pointerId))return;
    event.preventDefault();
    if(gesture){const previous=gesture;flush();if(gesture!==previous)return;}
    if(!gesture){if(!validGeometry(geometry))return;
      gesture={id:crypto.randomUUID(),seq:0,ack:-1,geometry,pointers:new Map(),pending:[],started:start.timeStamp};last=gesture;
      diagnostics.receivedSamples=diagnostics.sentSamples=diagnostics.processedSamples=0;
      options.changed(true);
      if(!gesture)return;
      lastKeepalive=performance.now();watchdog=setInterval(()=>{
        if(gesture&&gesture.seq>gesture.ack+1&&performance.now()-lastProgressAt>2000){cancel('控制响应超时，手势已取消；不会重放');return;}
        if(gesture&&performance.now()-lastKeepalive>=1000){lastKeepalive=performance.now();if(!options.send({type:'touch-keepalive',gesture:gesture.id}))cancel('控制通道中断，手势已取消');}
      },250);
    }
    const g=gesture;if(!g)return;const ids=new Set([...g.pointers.values()].map(p=>p.id)),id=ids.has(10)?11:10,p=point(start,id,g);
    g.pointers.set(event.pointerId,p);diagnostics.receivedSamples++;
    if(!send(g,{type:'touch',action:0,...p},1))return;
    try{options.element.setPointerCapture(event.pointerId);}catch{}
    options.point(p.x,p.y);
    // Keyboard focus is optional and must never gate touch forwarding.
    if(event.pointerType==='mouse')options.element.focus({preventScroll:true});
  }
  function waitForEntry(event:PointerEvent,geometry=options.geometry()){
    if(gesture||pendingEntry||!options.canStart()||!validGeometry(geometry)||inside(event,geometry)||!inside(event,geometry,margin))return;
    // No device DOWN, focus or capture until an actual inward drag is established.
    pendingEntry={pointerId:event.pointerId,geometry,start:event,previous:event};
  }
  options.element.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;const geometry=options.geometry();
    // Touch browsers may retarget a near-edge contact to the screen button.
    if(options.bufferElement&&validGeometry(geometry)&&!inside(event,geometry)){event.preventDefault();waitForEntry(event,geometry);return;}
    pendingEntry=null;beginPointer(event,geometry);
  });
  options.element.addEventListener('click',event=>{
    if(options.bufferElement&&event.detail!==0&&validGeometry(options.geometry())&&!inside(event,options.geometry())){event.preventDefault();event.stopImmediatePropagation();}
  });
  options.bufferElement?.addEventListener('pointerdown',event=>{
    if(event.button!==0||gesture||pendingEntry||options.element.contains(event.target as Node)||isControl(event.target)||!options.canStart())return;
    waitForEntry(event);
  });
  options.bufferElement?.addEventListener('contextmenu',event=>{if(!isControl(event.target))event.preventDefault();});
  function enterFromBuffer(event:PointerEvent,sample:Position=event){const pending=pendingEntry;if(!pending||pending.pointerId!==event.pointerId)return;
    if(!options.canStart()||!sameGeometry(pending.geometry,options.geometry())||!inside(sample,pending.geometry,margin)){pendingEntry=null;return;}
    if(!inside(sample,pending.geometry)){pending.previous=sample;pending.entry=undefined;return;}
    pending.entry??=entryPoint(pending.previous,sample,pending.geometry);
    if(Math.hypot(sample.clientX-pending.start.clientX,sample.clientY-pending.start.clientY)<8)return;
    pendingEntry=null;beginPointer(event,pending.geometry,{...pending.entry,timeStamp:sample.timeStamp});
  }
  document.addEventListener('pointermove',event=>{
    let samples:PointerEvent[]=[];try{samples=event.getCoalescedEvents?.()||[];}catch{}const events=samples.length?samples:[event];
    for(const sample of events){if(!gesture)enterFromBuffer(event,sample);const g=gesture,p=g?.pointers.get(event.pointerId);if(!g||!p)continue;
      if(!options.canContinue()){cancel('手机当前不可操作，手势已取消');return;}
      if(event.cancelable)event.preventDefault();
      const next=point(sample,p.id,g);g.pointers.set(event.pointerId,next);g.pending.push(next);diagnostics.receivedSamples++;
      if(g.pending.length>=64){flush();if(gesture!==g)return;}}
    if(gesture?.pending.length&&!timer)timer=setTimeout(flush,8);
  },{capture:true,passive:false});
  document.addEventListener('pointerup',event=>{if(!gesture)enterFromBuffer(event);if(pendingEntry?.pointerId===event.pointerId)pendingEntry=null;const g=gesture,p=g?.pointers.get(event.pointerId);if(!g||!p)return;if(event.cancelable)event.preventDefault();
    const end=point(event,p.id,g);if(end.x!==p.x||end.y!==p.y){g.pending.push(end);diagnostics.receivedSamples++;}flush();if(gesture!==g)return;
    if(!send(g,{type:'touch',action:1,...end},1))return;g.pointers.delete(event.pointerId);
    try{if(options.element.hasPointerCapture(event.pointerId))options.element.releasePointerCapture(event.pointerId);}catch{}
    if(!g.pointers.size)finish();
  },{capture:true,passive:false});
  document.addEventListener('pointercancel',event=>{if(pendingEntry?.pointerId===event.pointerId)pendingEntry=null;if(gesture?.pointers.has(event.pointerId))cancel('浏览器取消了触摸，手势已释放');},true);
  options.element.addEventListener('lostpointercapture',event=>{if(gesture?.pointers.has(event.pointerId)&&!options.element.hasPointerCapture(event.pointerId))cancel('触摸捕获中断，手势已释放');});
  return {active:()=>!!gesture,cancel,validateGeometry:()=>{if(!gesture)return;const size=options.geometry();if(size.width!==gesture.geometry.width||size.height!==gesture.geometry.height)cancel('手机显示尺寸已变化，手势已释放');},
    acknowledgement:(data:any)=>{if(data.type==='error'&&data.cancelled&&gesture){cancel(data.message||'控制手势已取消');return;}const g=last;if(!g||data.gesture!==g.id)return;
      if(data.type==='error'){if(gesture===g)cancel(data.message||'控制手势失败');else{diagnostics.lastError=data.message;options.error(data.message);}return;}
      if(Number.isInteger(data.seq)&&data.seq>g.ack){diagnostics.processedSamples+=data.seq-g.ack;g.ack=data.seq;lastProgressAt=performance.now();diagnostics.queueMs=data.queueMs||0;}
    },snapshot:()=>({...diagnostics,active:!!gesture,waitingForEntry:!!pendingEntry,lastGesture:last?.id,lastSentSequence:last?last.seq-1:null,lastProcessedSequence:last?.ack??null})};
}
