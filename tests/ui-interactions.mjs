import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {render, readAssetVersion} from '../src/ui.ts';

// Exercise the production client against local fixtures, without ADB or a real page lease.
const observation = {
  connected:true, serial:'fixture', model:'Fixture', android:'13', system:'Fixture',
  width:1080, height:2400, rotation:0, screenOn:true, locked:false,
  snapshotId:'fixture', collectedAt:Date.now(), powerCollectedAt:Date.now(), nodes:[],
  foregroundApp:'fixture', focus:null, focusEpoch:0, uiError:null, videoError:null, controlAvailable:true,
};
const html=await render(observation,{basePath:'/',assetVersion:await readAssetVersion(),webrtc:{availableProviders:['coturn']},
  tasks:[], apiMethods:[], csrf:'fixture', pageId:'fixture', sdk:'fixture', ownsControl:false});
const assets={
  '/':{type:'text/html',body:html},
  '/assets/client.js':{type:'text/javascript',body:await readFile('dist/web/client.js')},
  '/assets/style.css':{type:'text/css',body:await readFile('dist/web/style.css')},
};
const server=createServer((req,res)=>{
  const asset=assets[new URL(req.url,'http://localhost').pathname];
  res.writeHead(asset?200:404,{'Content-Type':asset?.type||'text/plain'});
  res.end(asset?.body||'Not found');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
const checks=[];
try {
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1919,height:998},hasTouch:true,permissions:['clipboard-read','clipboard-write']});
  await context.addInitScript(()=>{
    const nativeTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,window.__fastRecovery&&ms===60000?50:ms,...args);
    window.__messages=[];
    window.__sockets=[];
    window.__offers=0;
    window.__videoSelections=0;
    window.__requests=[];
    setInterval(()=>{for(const socket of window.__sockets)if(socket.url.includes('/ws/events'))socket.onmessage?.({data:JSON.stringify({type:'power',screenOn:true,locked:false,powerCollectedAt:Date.now()})});},1000);
    window.__clockOffset=0;
    const nativeNow=performance.now.bind(performance);
    performance.now=()=>nativeNow()+window.__clockOffset;
    const frameCallbacks=new Map();let frameId=0;
    HTMLVideoElement.prototype.play=async()=>{};
    HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){frameCallbacks.set(this,callback);return ++frameId;};
    window.__paintFrame=()=>{for(const [video,callback]of [...frameCallbacks]){frameCallbacks.delete(video);callback(performance.now(),{});}};
    const fixtureMode=localStorage.getItem('fixture-mode');
    class FixtureSocket {
      readyState=1;
      constructor(url){this.url=url;window.__sockets.push(this);setTimeout(()=>{this.onopen?.({});const u=new URL(url),generation=Number(u.searchParams.get('generation')||0);const peers=window.__sockets.filter(s=>s.readyState===1&&new URL(s.url).searchParams.get('generation')===u.searchParams.get('generation')&&/\/ws\/(events|control)/.test(s.url));if(!window.__blockReady&&peers.some(s=>s.url.includes('/ws/events'))&&peers.some(s=>s.url.includes('/ws/control')))for(const s of peers)s.onmessage?.({data:JSON.stringify({type:'connection-ready',generation})});},0);}
      send(value){if(JSON.parse(value).type==='heartbeat'){setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'heartbeat'})}),0);return;}if(this.url.includes('/ws/control')){const data=JSON.parse(value);window.__messages.push(data);if(data.gesture&&(data.type==='touch'||data.type==='touch-move')&&!window.__ackDisabled)setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'ack',gesture:data.gesture,seq:data.seq+(data.points?.length||1)-1,samples:data.points?.length||1,queueMs:0})}),0);}}
      close(){this.readyState=3;}
    }
    window.WebSocket=FixtureSocket;
    class FixturePeer extends EventTarget {
      connectionState='connected';iceGatheringState=fixtureMode==='gather-timeout'?'gathering':'complete';
      addTransceiver(){}
      async createOffer(){return {type:'offer',sdp:fixtureMode?'':'a=candidate:fixture 1 udp 100 203.0.113.1 50000 typ relay\r\n'};}
      async setLocalDescription(value){this.localDescription=value;}
      async setRemoteDescription(value){this.remoteDescription=value;const track=document.createElement('canvas').captureStream().getVideoTracks()[0];this.ontrack?.({track});}
      async getStats(){return new Map();}
      close(){this.connectionState='closed';}
    }
    window.RTCPeerConnection=FixturePeer;
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(url,options)=>{
      const path=new URL(url,location.href).pathname;
      if(!path.startsWith('/api/'))return originalFetch(url,options);
      window.__requests.push({path,body:options?.body?JSON.parse(options.body):null});
      let data={};
      if(path==='/api/connection/connect')data={connectionId:'fixture',generation:0};
      if(path==='/api/connection/resume'){if(window.__resumeStatus)return new Response(JSON.stringify({error:{code:window.__resumeCode||'SERVER_ERROR',message:'原连接已失效或被其他页面接管'}}),{status:window.__resumeStatus});data={connectionId:'fixture',generation:(window.__resumeGeneration=(window.__resumeGeneration||0)+1)};}
      if(path==='/api/app-state')data={collectedAt:Date.now(),catalog:{apps:[]},processes:[],navigation:{locked:false,current:null,tasks:[]}};
      if(path==='/api/webrtc/config')data={provider:'coturn',availableProviders:['coturn'],iceTransportPolicy:'relay',iceServers:[{urls:'turns:fixture.invalid:8443?transport=tcp'}],renewAfterMs:null};
      if(path==='/api/webrtc/config'&&fixtureMode)data={...data,provider:'cloudflare',availableProviders:['cloudflare'],gatherMs:50};
      if(path==='/api/webrtc/offer'){window.__offers++;data={width:864,height:1920,sdp:''};}
      if(path==='/api/webrtc/status')data={state:'connected',fixture:true};
      if(path==='/api/video/select')window.__videoSelections++;
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    };
  });
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(origin);
  await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='在线'&&document.querySelector('.phone').dataset.iceMode==='relay');
  await page.waitForTimeout(100);
  // A connection can be selected while locked, before any decoded frame arrives.
  await page.evaluate(()=>{for(const s of window.__sockets)if(s.url.includes('/ws/events'))s.onmessage?.({data:JSON.stringify({type:'power',screenOn:false,locked:true,powerCollectedAt:Date.now()})});});
  await page.waitForFunction(()=>document.querySelector('.phone').dataset.videoConnection==='connected');
  await page.evaluate(()=>{for(const s of window.__sockets)if(s.url.includes('/ws/events'))s.onmessage?.({data:JSON.stringify({type:'power',screenOn:true,locked:false,powerCollectedAt:Date.now()})});window.__messages=[];});
  assert.equal(await page.locator('.phone').getAttribute('data-video-freshness'),'waiting');
  await page.locator('.phone').click();await page.waitForTimeout(40);
  assert.deepEqual(await page.evaluate(()=>window.__messages.filter(m=>m.type==='touch').map(m=>m.action)),[0,1],'unlocked phone receives touch before a new video frame');
  checks.push({name:'unlock permits touch while waiting for the first video frame'});
  await page.evaluate(()=>window.__paintFrame());await page.waitForFunction(()=>document.querySelector('.phone').dataset.videoFreshness==='current');
  const rectangle=await page.locator('.video-canvas').boundingBox();
  const center={x:rectangle.x+rectangle.width/2,y:rectangle.y+rectangle.height/2};
  const reset=()=>page.evaluate(()=>window.__messages=[]);
  const touches=()=>page.evaluate(()=>window.__messages.flatMap(x=>x.type==='touch-move'?x.points.map((p,i)=>({...x,...p,action:2,seq:x.seq+i})):x.type==='touch'?[x]:[]));
  async function drag(name,end){
    await reset();await page.mouse.move(center.x,center.y);await page.mouse.down();
    await page.mouse.move(end.x,end.y,{steps:3});await page.mouse.up();
    await page.waitForTimeout(40);
    const trace=await touches();
    assert.equal(trace[0]?.action,0,name+' DOWN');
    assert.ok(trace.some(x=>x.action===2),name+' MOVE');
    assert.equal(trace.at(-1)?.action,1,name+' UP');
    assert.equal(trace.filter(x=>x.action===1).length,1,name+' exactly one UP');
    for(const p of trace){assert.ok(p.x>=0&&p.x<864&&p.y>=0&&p.y<1920,name+' bounded coordinates');}
    checks.push({name,end:lastPoint(trace),actions:trace.map(x=>x.action)});
    return trace;
  }
  function lastPoint(trace){return {x:trace.at(-1).x,y:trace.at(-1).y};}
  const right={x:rectangle.x+rectangle.width+140,y:center.y};
  const selectionsBeforeTouch=await page.evaluate(()=>window.__videoSelections);
  await page.mouse.move(center.x,center.y);await page.mouse.down();
  assert.equal(await page.locator('.phone').evaluate(p=>getComputedStyle(p).opacity),'1');
  assert.equal(await page.locator('.screen-shield').isVisible(),false);
  await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.__videoSelections),selectionsBeforeTouch);
  assert.equal(await page.locator('.phone').evaluate(p=>getComputedStyle(p).webkitTapHighlightColor),'rgba(0, 0, 0, 0)');
  const disabledOpacity=await page.locator('.phone').evaluate(p=>{p.disabled=true;const opacity=getComputedStyle(p).opacity;p.disabled=false;return opacity;});
  assert.equal(disabledOpacity,'1');checks.push({name:'touch preserves video selection and screen brightness, including disabled state'});
  const phoneBox=await page.locator('.phone').boundingBox();
  const bufferStarts={bottom:{x:center.x,y:phoneBox.y+phoneBox.height+1},top:{x:center.x,y:phoneBox.y-1},left:{x:phoneBox.x-3,y:center.y},right:{x:phoneBox.x+phoneBox.width+3,y:center.y}};
  for(const [edge,start]of Object.entries(bufferStarts)){
    await reset();await page.mouse.move(start.x,start.y);await page.mouse.down();
    assert.equal((await touches()).length,0,edge+' buffer waits before sending DOWN');
    await page.mouse.move(center.x,center.y,{steps:3});await page.mouse.up();await page.waitForTimeout(40);
    const trace=await touches();assert.equal(trace[0]?.action,0,edge+' entry DOWN');assert.equal(trace.at(-1)?.action,1,edge+' entry UP');
    assert.equal(edge==='bottom'?trace[0].y:edge==='top'?trace[0].y:trace[0].x,edge==='bottom'?1919:edge==='right'?863:0,edge+' starts at phone boundary');
    assert.ok(trace.some(p=>p.action===2),edge+' keeps inward MOVE');
  }
  assert.deepEqual(await page.locator('.phone').boundingBox(),phoneBox);checks.push({name:'all four existing blank margins accept inward drag without changing layout'});
  await reset();await page.mouse.click(bufferStarts.left.x,bufferStarts.left.y);assert.equal((await touches()).length,0);
  await page.mouse.move(bufferStarts.left.x,bufferStarts.left.y);await page.mouse.down();await page.mouse.move(rectangle.x+1,center.y);await page.mouse.up();assert.equal((await touches()).length,0);
  await page.mouse.move(bufferStarts.left.x,bufferStarts.left.y);await page.mouse.down();await page.mouse.move(bufferStarts.left.x,center.y+30);await page.mouse.up();assert.equal((await touches()).length,0);
  checks.push({name:'buffer tap, tiny motion and parallel motion send no phone events'});
  await reset();await page.mouse.move(bufferStarts.bottom.x,bufferStarts.bottom.y);await page.mouse.down();await page.waitForTimeout(750);
  assert.equal((await touches()).length,0);await page.mouse.move(center.x,center.y);await page.mouse.up();
  assert.equal((await touches())[0]?.t,0);checks.push({name:'waiting outside the screen never becomes a phone long press'});
  await reset();await page.mouse.move(bufferStarts.left.x,bufferStarts.left.y);await page.mouse.down();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await page.mouse.move(center.x,center.y);await page.mouse.up();assert.equal((await touches()).length,0);checks.push({name:'blur cancels a pending entry without sending or replaying it'});
  const home=page.locator('.nav [data-press="HOME"]'),homeBox=await home.boundingBox();await reset();await page.evaluate(()=>window.__requests=[]);
  await home.click();assert.equal((await touches()).length,0);assert.ok(await page.evaluate(()=>window.__requests.some(r=>r.path==='/api/press'&&r.body?.key==='HOME')));
  await reset();await page.mouse.move(homeBox.x+homeBox.width/2,homeBox.y+2);await page.mouse.down();await page.mouse.move(center.x,center.y);await page.mouse.up();assert.equal((await touches()).length,0);
  checks.push({name:'nearby navigation clicks work and drags starting on controls are never stolen'});
  await reset();await page.evaluate(({x,y})=>{
    const pane=document.querySelector('.phone-pane');pane.dispatchEvent(new PointerEvent('pointerdown',{pointerId:780,button:0,clientX:x-40,clientY:y,bubbles:true}));
    document.dispatchEvent(new PointerEvent('pointermove',{pointerId:780,clientX:x+30,clientY:y,bubbles:true}));document.dispatchEvent(new PointerEvent('pointerup',{pointerId:780,clientX:x+30,clientY:y,bubbles:true}));
  },{x:rectangle.x,y:center.y});assert.equal((await touches()).length,0);checks.push({name:'drags starting beyond the buffer cannot become phone gestures'});
  await reset();await page.mouse.move(bufferStarts.left.x,bufferStarts.left.y);await page.mouse.down();await page.mouse.move(rectangle.x-25,center.y);await page.mouse.move(center.x,center.y);await page.mouse.up();
  assert.equal((await touches()).length,0);checks.push({name:'leaving the buffer before entry permanently abandons that pointer'});
  await reset();await page.evaluate(({x,y})=>{
    document.querySelector('.phone-pane').dispatchEvent(new PointerEvent('pointerdown',{pointerId:781,button:0,clientX:x-3,clientY:y,bubbles:true}));
    document.dispatchEvent(new PointerEvent('pointerup',{pointerId:781,clientX:x+30,clientY:y,bubbles:true}));
  },{x:rectangle.x,y:center.y});assert.deepEqual((await touches()).map(p=>p.action),[0,2,1]);checks.push({name:'fast buffer entry at release keeps boundary DOWN, final MOVE and UP'});
  await reset();await page.mouse.move(phoneBox.x-3,phoneBox.y-1);await page.mouse.down();await page.mouse.move(rectangle.x+40,rectangle.y+40);await page.mouse.up();
  const corner=(await touches())[0];assert.equal(corner?.action,0);assert.ok(corner.x<1e-6||corner.y<1e-6);checks.push({name:'diagonal entry starts at the first crossed edge'});
  const controlPoint={x:bufferStarts.left.x,y:center.y};
  await page.evaluate(({x,y})=>{const b=document.createElement('button');b.type='button';b.className='buffer-test-control';b.textContent='控件';b.style.cssText=`position:fixed;left:${x-3}px;top:${y-6}px;width:6px;height:12px;min-height:0;padding:0;z-index:30`;window.__bufferControlClicks=0;b.onclick=()=>window.__bufferControlClicks++;document.querySelector('.phone-pane').append(b);},controlPoint);
  await reset();await page.mouse.click(controlPoint.x,controlPoint.y);assert.equal(await page.evaluate(()=>window.__bufferControlClicks),1);
  await page.mouse.move(controlPoint.x,controlPoint.y);await page.mouse.down();await page.mouse.move(center.x,center.y);await page.mouse.up();assert.equal((await touches()).length,0);
  await page.evaluate(()=>document.querySelector('.buffer-test-control').remove());checks.push({name:'a real control within the geometric buffer keeps its own clicks and drags'});
  assert.equal((await drag('outside right',right)).at(-1).x,863);
  assert.equal((await drag('outside left',{x:Math.max(1,rectangle.x-15),y:center.y})).at(-1).x,0);
  assert.equal((await drag('outside top',{x:center.x,y:rectangle.y-15})).at(-1).y,0);
  assert.equal((await drag('outside bottom',{x:center.x,y:Math.min(997,rectangle.y+rectangle.height+15)})).at(-1).y,1919);

  await page.evaluate(()=>{const phone=document.querySelector('.phone');window.__restoreCapture=()=>delete phone.setPointerCapture;phone.setPointerCapture=()=>{throw Error('No capture');};});
  await drag('outside without pointer capture',right);
  await page.evaluate(()=>window.__restoreCapture());

  await reset();await page.mouse.move(center.x,center.y);await page.mouse.down();
  await page.evaluate(()=>document.querySelector('.phone').releasePointerCapture(1));
  await page.mouse.move(right.x,right.y);await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.__messages.filter(x=>x.type==='touch-cancel'||x.type==='touch'&&x.action===1).length),1);
  checks.push({name:'capture loss finishes or cancels exactly once'});

  await reset();await page.mouse.move(center.x,center.y);await page.mouse.down();
  await page.evaluate(()=>document.dispatchEvent(new PointerEvent('pointerup',{pointerId:999,clientX:0,clientY:0,bubbles:true})));
  assert.equal((await touches()).filter(x=>x.action===1).length,0);
  await page.mouse.up();assert.equal((await touches()).at(-1).action,1);
  checks.push({name:'unrelated pointer cannot finish gesture'});

  await reset();await page.mouse.down();
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await page.mouse.up();await page.waitForTimeout(40);
  assert.equal(await page.evaluate(()=>window.__messages.filter(x=>x.type==='touch-cancel').length),1);
  assert.ok(await page.evaluate(()=>window.__messages.some(x=>x.type==='keys-release')));
  checks.push({name:'window blur releases touch exactly once'});

  await reset();await page.mouse.move(center.x,center.y);await page.mouse.down();
  assert.equal((await touches())[0].action,0);await page.waitForTimeout(750);assert.equal((await touches()).at(-1).action,0);
  await page.mouse.up();assert.equal((await touches()).at(-1).action,1);
  checks.push({name:'real long press follows physical down/up without a mode'});
  await reset();await page.mouse.move(center.x,center.y);await page.mouse.down();
  await page.evaluate(()=>document.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true})));
  await page.mouse.up();assert.equal(await page.evaluate(()=>window.__messages.filter(x=>x.type==='touch-cancel').length),1);
  checks.push({name:'pointer cancellation cancels gesture'});

  await drag('next gesture after cancellation',right);

  await page.locator('.code-input').focus();await reset();await page.mouse.move(center.x,center.y);await page.mouse.down();
  assert.equal((await touches())[0].action,0);await page.locator('.code-input').focus();await page.waitForTimeout(20);
  assert.equal(await page.evaluate(()=>window.__messages.some(m=>m.type==='touch-cancel')),false);
  await page.mouse.move(center.x+25,center.y+25);await page.mouse.up();assert.equal((await touches()).at(-1).action,1);
  checks.push({name:'first DOWN is immediate and editor focus cannot cancel a drag'});
  await reset();await page.evaluate(({x,y})=>{
    document.querySelector('.phone').dispatchEvent(new PointerEvent('pointerdown',{pointerId:777,pointerType:'mouse',button:0,clientX:x,clientY:y,bubbles:true}));
    for(const [dx,dy]of [[30,0],[30,30],[0,30]])document.dispatchEvent(new PointerEvent('pointermove',{pointerId:777,pointerType:'mouse',clientX:x+dx,clientY:y+dy,bubbles:true}));
    document.dispatchEvent(new PointerEvent('pointerup',{pointerId:777,pointerType:'mouse',clientX:x,clientY:y+30,bubbles:true}));
  },{x:center.x,y:center.y});
  const curve=await touches();assert.deepEqual(curve.map(m=>m.action),[0,2,2,2,1]);assert.ok(curve[1].x>curve[0].x);assert.equal(curve[2].x,curve[1].x);assert.equal(curve[3].x,curve[0].x);
  assert.deepEqual(curve.map(m=>m.seq),[0,1,2,3,4]);checks.push({name:'same-frame curve preserves every corner and ordered sequence'});
  await reset();await page.evaluate(({x,y})=>{
    const phone=document.querySelector('.phone');phone.dispatchEvent(new PointerEvent('pointerdown',{pointerId:778,pointerType:'mouse',button:0,clientX:x,clientY:y,bubbles:true}));
    document.dispatchEvent(new PointerEvent('pointerup',{pointerId:778,pointerType:'mouse',clientX:x+1,clientY:y,bubbles:true}));
  },{x:center.x,y:center.y});assert.deepEqual((await touches()).map(m=>m.action),[0,2,1]);checks.push({name:'one-pixel rapid drag preserves final MOVE before UP'});

  await reset();await page.evaluate(({x,y})=>{
    document.querySelector('.phone').dispatchEvent(new PointerEvent('pointerdown',{pointerId:779,pointerType:'mouse',button:0,clientX:x,clientY:y,bubbles:true}));
    const samples=[new PointerEvent('pointermove',{clientX:x+10,clientY:y}),new PointerEvent('pointermove',{clientX:x+10,clientY:y+10}),new PointerEvent('pointermove',{clientX:x,clientY:y+10})];
    const event=new PointerEvent('pointermove',{pointerId:779,clientX:x,clientY:y+10,bubbles:true});Object.defineProperty(event,'getCoalescedEvents',{value:()=>samples});document.dispatchEvent(event);
    document.dispatchEvent(new PointerEvent('pointerup',{pointerId:779,clientX:x,clientY:y+10,bubbles:true}));
  },{x:center.x,y:center.y});assert.equal((await touches()).filter(m=>m.action===2).length,3);checks.push({name:'browser-coalesced history keeps all available samples'});
  await reset();await page.evaluate(()=>window.__ackDisabled=true);await page.mouse.move(center.x,center.y);await page.mouse.down();await page.waitForTimeout(2300);
  assert.equal(await page.evaluate(()=>window.__messages.filter(m=>m.type==='touch-cancel').length),1);await page.mouse.up();await page.evaluate(()=>window.__ackDisabled=false);
  checks.push({name:'missing acknowledgements cancel gesture without replay'});

  await reset();await page.mouse.move(center.x,center.y);await page.mouse.down();await page.evaluate(()=>window.dispatchEvent(new Event('orientationchange')));await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.__messages.filter(m=>m.type==='touch-cancel').length),1);checks.push({name:'client orientation change cancels old coordinate mapping'});

  await page.locator('.video-network summary').click();
  await page.waitForFunction(()=>document.querySelector('.video-network-data').textContent.includes('"fixture": true'));
  const diagnosis=await page.locator('.video-network-data').textContent();
  await page.getByRole('button',{name:'复制诊断',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.video-network-copy-status').textContent==='已复制');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),diagnosis);
  checks.push({name:'copy button writes displayed JSON to clipboard'});

  await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw Error('Denied');};window.__copyFallback=null;document.execCommand=command=>{window.__copyFallback=document.activeElement.value;return command==='copy';};});
  await page.getByRole('button',{name:'复制诊断',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.video-network-copy-status').textContent==='已复制');
  assert.equal(await page.evaluate(()=>window.__copyFallback),await page.locator('.video-network-data').textContent());
  checks.push({name:'clipboard denial uses selectable-text fallback'});
  await page.evaluate(()=>document.execCommand=()=>false);
  await page.getByRole('button',{name:'复制诊断',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.video-network-copy-status').textContent.startsWith('复制失败'));
  assert.equal(await page.locator('.video-network-copy').isEnabled(),true);
  checks.push({name:'clipboard failure is reported and button recovers'});
  await page.evaluate(()=>window.__paintFrame());
  await page.waitForFunction(()=>document.querySelector('.phone').dataset.videoFreshness==='current');
  assert.equal(await page.locator('.video-freshness-banner').isVisible(),false);
  await page.evaluate(()=>window.__clockOffset=7000);
  await page.waitForFunction(()=>document.querySelector('.phone').dataset.videoFreshness==='unconfirmed');
  assert.match(await page.locator('.video-freshness-status').textContent(),/可能画面静止或传输停滞/);
  assert.equal(await page.locator('.video-freshness-banner').isVisible(),true);
  await drag('freshness warning does not block touch',right);
  checks.push({name:'frame silence is visible and does not falsely declare disconnection'});
  async function power(screenOn,locked){await page.evaluate(({screenOn,locked})=>{for(const s of window.__sockets)if(s.url.includes('/ws/events'))s.onmessage?.({data:JSON.stringify({type:'power',screenOn,locked,powerCollectedAt:Date.now()})});},{screenOn,locked});}
  await power(false,true);
  assert.match(await page.locator('.video-freshness-status').textContent(),/暂停.*非实时.*灭屏/);
  await page.locator('.video-network summary').click();
  await page.screenshot({path:'.local/freshness-paused.png'});
  await page.locator('.video-network summary').click();
  await power(true,false);
  assert.equal(await page.locator('.phone').getAttribute('data-video-freshness'),'waiting');
  await drag('resume permits touch while the displayed frame is old',right);
  assert.equal(await page.locator('.phone').getAttribute('data-video-freshness'),'waiting');
  await page.evaluate(()=>window.__paintFrame());
  assert.equal(await page.locator('.phone').getAttribute('data-video-freshness'),'current');
  checks.push({name:'pause and resume require a new frame before declaring current'});
  await page.evaluate(()=>{for(const s of window.__sockets)if(s.url.includes('/ws/events'))s.onmessage?.({data:JSON.stringify({type:'offline',reason:'PAGE_REPLACED'})});});
  assert.equal(await page.locator('.workspace').getAttribute('inert'),'');
  assert.match(await page.locator('.video-freshness-status').textContent(),/已离线.*非实时/);
  assert.match(await page.locator('.video-freshness-status').ariaSnapshot(),/已离线.*非实时/);
  checks.push({name:'offline freshness remains accessible outside the inert workspace'});
  await page.locator('.page-reconnect').click();
  await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='在线');
  const panel=await page.locator('.video-network-panel').boundingBox();
  assert.ok(panel.height<=300&&panel.x>=0&&panel.y>=0&&panel.x+panel.width<=1919);
  assert.deepEqual(errors,[]);
  await page.locator('.video-network').evaluate(n=>n.open=false);
  for(const viewport of [{width:390,height:844},{width:844,height:390},{width:360,height:640},{width:1024,height:600},{width:1280,height:600},{width:1600,height:900}]){
    await page.setViewportSize(viewport);await page.waitForTimeout(100);await page.evaluate(()=>window.__paintFrame());
    const narrow=viewport.width<=600;assert.equal(await page.locator('.right-shell').isVisible(),!narrow);assert.equal(await page.locator('.mobile-header').isVisible(),narrow);
    const box=await page.locator('.phone').boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width&&box.y+box.height<=viewport.height);
    await page.locator('.workspace').evaluate(n=>n.scrollTop=0);
    assert.ok(box.width>100&&box.height>200);await page.screenshot({path:'.local/mobile-'+viewport.width+'x'+viewport.height+'.png'});
    if(narrow){assert.ok(box.height>viewport.height-80);await page.locator('.mobile-tools').click();assert.equal(await page.locator('.right-shell').isVisible(),true);assert.equal(await page.locator('.phone-pane').evaluate(n=>n.inert),true);
      await page.locator('.mobile-tools-close').click();assert.equal(await page.locator('.right-shell').isVisible(),false);
    }else{
      assert.equal(await page.evaluate(()=>matchMedia('(pointer: coarse)').matches),true);assert.equal(await page.locator('.right-shell').evaluate(n=>n.inert),false);
      const toolsBox=await page.locator('.right-shell').boundingBox();assert.ok(toolsBox.x>=box.x+box.width&&toolsBox.x+toolsBox.width<=viewport.width);
      for(const name of ['.applications-panel','.nodes-pane','.commands'])assert.equal(await page.locator(name).isVisible(),true);
      if(viewport.height<=720){assert.equal(await page.locator('.workspace').evaluate(n=>n.scrollHeight>n.clientHeight),true);await page.locator('.run').scrollIntoViewIfNeeded();assert.equal(await page.locator('.run').isVisible(),true);}
    }
  }
  checks.push({name:'coarse pointer car and phone landscape keep tools visible; Muse-sized workbench stays complete'});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100);await page.evaluate(()=>window.__paintFrame());
  const cdp=await context.newCDPSession(page),box=await page.locator('.video-canvas').boundingBox(),tx=box.x+box.width/2,ty=box.y+box.height/2;
  const mobilePhoneBox=await page.locator('.phone').boundingBox(),bufferY=mobilePhoneBox.y+mobilePhoneBox.height+1;
  await reset();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx,y:bufferY,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.equal((await touches()).length,0);
  checks.push({name:'native tap retargeted near the screen remains a buffer tap without phone input'});
  await reset();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx,y:bufferY,id:1}]});assert.equal((await touches()).length,0);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tx,y:box.y+box.height-35,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const entryFinger=await touches();assert.equal(entryFinger[0]?.action,0);assert.equal(entryFinger[0]?.y,1919);assert.ok(entryFinger.some(p=>p.action===2));assert.equal(entryFinger.at(-1)?.action,1);
  assert.equal(await page.evaluate(()=>scrollY),0);checks.push({name:'native finger drag from the bottom margin enters at the remote screen edge'});
  await reset();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx,y:ty,id:1}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tx+20,y:ty+30,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const finger=await touches();assert.equal(finger[0].action,0);assert.ok(finger.some(m=>m.action===2));assert.equal(finger.at(-1).action,1);
  assert.equal(await page.evaluate(()=>scrollY),0);checks.push({name:'native touch drag operates remote screen without scrolling mobile page'});
  await reset();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx-20,y:ty,id:1}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx-20,y:ty,id:1},{x:tx+20,y:ty,id:2}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tx-35,y:ty,id:1},{x:tx+35,y:ty,id:2}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});const pinch=await touches();
  assert.deepEqual([...new Set(pinch.filter(p=>p.action===0).map(p=>p.id))].sort(),[10,11]);assert.equal(pinch.filter(p=>p.action===1).length,2);
  checks.push({name:'native two-finger pinch keeps independent DOWN and UP events'});
  await page.evaluate(()=>{document.querySelector('.phone-pane').requestFullscreen=async()=>{throw Error('Fullscreen unavailable');};});
  await page.locator('.mobile-immersive').click();assert.equal(await page.locator('.close-enlarge').isVisible(),true);await page.evaluate(()=>window.__paintFrame());
  const immersiveBox=await page.locator('.phone').boundingBox();assert.ok(immersiveBox.height>844-80);
  assert.ok((await page.locator('.close-enlarge').boundingBox()).height<=28);assert.ok((await page.locator('.nav [data-press="HOME"]').boundingBox()).height<=32);
  await reset();const immersed=await page.locator('.video-canvas').boundingBox();await page.mouse.move(immersed.x+immersed.width/2,immersed.y+immersed.height/2);await page.mouse.down();await page.mouse.move(immersed.x+immersed.width/2+10,immersed.y+immersed.height/2+10);await page.mouse.up();
  assert.equal((await touches())[0].action,0);assert.equal((await touches()).at(-1).action,1);await page.locator('.close-enlarge').click();
  checks.push({name:'mobile layouts fit portrait/landscape and immersive fallback retains touch layer'});
  await page.setViewportSize({width:1919,height:998});await page.waitForTimeout(100);assert.equal(await page.locator('.right-shell').isVisible(),true);
  const drop=channel=>page.evaluate(channel=>{const socket=window.__sockets.filter(s=>s.readyState===1&&s.url.includes('/ws/'+channel)).at(-1);window.__droppedSocket=socket;socket.readyState=3;socket.onclose?.({code:1006,reason:''});},channel);
  await page.locator('.text-input').fill('断线时保留的草稿');const offersBeforeRecovery=await page.evaluate(()=>window.__offers);
  await page.evaluate(()=>{window.__blockReady=true;window.__requests=[];window.__messages=[];});await drop('control');
  await page.waitForFunction(()=>document.querySelector('.page-status').dataset.state==='recovering');assert.equal(await page.locator('.run').isDisabled(),true);
  await page.mouse.click(center.x,center.y);assert.equal((await touches()).length,0);assert.equal(await page.locator('.screen-shield').isVisible(),false);
  await page.waitForFunction(()=>window.__requests.some(r=>r.path==='/api/connection/resume'));
  await page.waitForTimeout(40);
  await page.evaluate(()=>{const peers=window.__sockets.filter(s=>s.readyState===1&&/\/ws\/(control|events)/.test(s.url)),control=peers.find(s=>s.url.includes('/ws/control')),events=peers.find(s=>s.url.includes('/ws/events'));control.readyState=0;events.onmessage?.({data:JSON.stringify({type:'connection-ready',generation:Number(new URL(events.url).searchParams.get('generation'))})});});
  assert.equal(await page.locator('.page-status').getAttribute('data-state'),'recovering');
  await page.evaluate(()=>{window.__blockReady=false;const control=window.__sockets.filter(s=>s.url.includes('/ws/control')).at(-1);control.readyState=1;control.onopen?.({});});
  await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='在线');
  assert.equal(await page.evaluate(()=>window.__offers),offersBeforeRecovery);assert.equal(await page.locator('.text-input').inputValue(),'断线时保留的草稿');
  assert.equal(await page.evaluate(()=>window.__requests.filter(r=>r.path==='/api/connection/connect').length),0);assert.equal(await page.evaluate(()=>window.__requests.find(r=>r.path==='/api/connection/resume').body.connectionId),'fixture');
  await page.evaluate(()=>window.__droppedSocket.onclose?.({code:4001,reason:'PAGE_REPLACED'}));assert.equal(await page.locator('.page-status').textContent(),'在线');
  checks.push({name:'control loss preserves video and draft, blocks input, waits for both channels and ignores late old closes'});
  await drop('events');await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='在线');checks.push({name:'observation socket loss also resumes the original session automatically'});
  await page.evaluate(()=>{window.__requests=[];window.__resumeStatus=409;window.__resumeCode='PAGE_OFFLINE';});await drop('control');
  await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='已离线');await page.waitForTimeout(500);
  assert.equal(await page.evaluate(()=>window.__requests.filter(r=>r.path==='/api/connection/connect').length),0);assert.equal(await page.locator('.text-input').inputValue(),'断线时保留的草稿');
  checks.push({name:'lost ownership stops automatic recovery without taking over a different page'});
  await page.evaluate(()=>{window.__resumeStatus=0;});await page.locator('.page-reconnect').click();await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='在线');
  await page.evaluate(()=>{window.__requests=[];window.__resumeStatus=503;window.__fastRecovery=true;});await drop('events');
  await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='已离线');assert.match(await page.locator('.connection-note').textContent(),/恢复连接超时/);
  assert.equal(await page.evaluate(()=>window.__requests.filter(r=>r.path==='/api/connection/connect').length),0);checks.push({name:'bounded recovery timeout leaves manual reconnect available without replay'});
  await page.evaluate(()=>{window.__resumeStatus=0;window.__fastRecovery=false;});await page.locator('.page-reconnect').click();await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='在线');await page.evaluate(()=>window.__paintFrame());
  await mkdir('.local/ui-interactions',{recursive:true});
  await page.screenshot({path:'.local/ui-interactions/layout.png'});
  for(const [mode,timedOut]of [['gather-timeout',true],['gather-empty',false]]){
    await page.evaluate(mode=>localStorage.setItem('fixture-mode',mode),mode);await page.reload();
    await page.locator('.video-network summary').click();
    await page.waitForFunction(()=>{try{return JSON.parse(document.querySelector('.video-network-data').textContent).browser.attempts.length>0;}catch{return false;}});
    const attempt=JSON.parse(await page.locator('.video-network-data').textContent()).browser.attempts[0];
    assert.equal(attempt.gatherTimedOut,timedOut);assert.equal(attempt.gathering,timedOut?'gathering':'complete');
    assert.ok(attempt.reason.includes(timedOut?'超时':'已完成'));assert.equal(await page.evaluate(()=>window.__offers),0);
    checks.push({name:timedOut?'gather timeout is distinguished from complete':'complete with no relay is distinguished from timeout'});
  }
  assert.deepEqual(errors,[]);
  await writeFile('.local/ui-interactions/result.json',JSON.stringify({passed:checks.length,checks,pageErrors:errors,panel},null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,pageErrors:errors,panel}));
} finally {
  await browser?.close();await new Promise(resolve=>server.close(resolve));
}
