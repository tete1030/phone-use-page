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
  const context=await browser.newContext({viewport:{width:1919,height:998},permissions:['clipboard-read','clipboard-write']});
  await context.addInitScript(()=>{
    window.__messages=[];
    window.__sockets=[];
    window.__offers=0;
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
      constructor(url){this.url=url;window.__sockets.push(this);setTimeout(()=>this.onopen?.({}),0);}
      send(value){if(this.url.includes('/ws/control')){const data=JSON.parse(value);window.__messages.push(data);if(data.gesture&&(data.type==='touch'||data.type==='touch-move')&&!window.__ackDisabled)setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'ack',gesture:data.gesture,seq:data.seq+(data.points?.length||1)-1,samples:data.points?.length||1,queueMs:0})}),0);}}
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
      let data={};
      if(path==='/api/connection/connect')data={connectionId:'fixture'};
      if(path==='/api/app-state')data={collectedAt:Date.now(),catalog:{apps:[]},processes:[],navigation:{locked:false,current:null,tasks:[]}};
      if(path==='/api/webrtc/config')data={provider:'coturn',availableProviders:['coturn'],iceTransportPolicy:'relay',iceServers:[{urls:'turns:fixture.invalid:8443?transport=tcp'}],renewAfterMs:null};
      if(path==='/api/webrtc/config'&&fixtureMode)data={...data,provider:'cloudflare',availableProviders:['cloudflare'],gatherMs:50};
      if(path==='/api/webrtc/offer'){window.__offers++;data={width:864,height:1920,sdp:''};}
      if(path==='/api/webrtc/status')data={state:'connected',fixture:true};
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    };
  });
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(origin);
  await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='在线'&&document.querySelector('.phone').dataset.iceMode==='relay');
  await page.waitForTimeout(100);
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
  for(const viewport of [{width:390,height:844},{width:844,height:390},{width:360,height:640}]){
    await page.setViewportSize(viewport);await page.waitForTimeout(100);await page.evaluate(()=>window.__paintFrame());
    assert.equal(await page.locator('.right-shell').isVisible(),false);assert.equal(await page.locator('.mobile-header').isVisible(),true);
    const box=await page.locator('.phone').boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width&&box.y+box.height<=viewport.height);
    assert.ok(box.width>100&&box.height>200);await page.screenshot({path:'.local/mobile-'+viewport.width+'x'+viewport.height+'.png'});
    await page.locator('.mobile-tools').click();assert.equal(await page.locator('.right-shell').isVisible(),true);assert.equal(await page.locator('.phone-pane').evaluate(n=>n.inert),true);
    await page.locator('.mobile-tools-close').click();assert.equal(await page.locator('.right-shell').isVisible(),false);
  }
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100);await page.evaluate(()=>window.__paintFrame());
  const cdp=await context.newCDPSession(page),box=await page.locator('.video-canvas').boundingBox(),tx=box.x+box.width/2,ty=box.y+box.height/2;
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
  await reset();const immersed=await page.locator('.video-canvas').boundingBox();await page.mouse.move(immersed.x+immersed.width/2,immersed.y+immersed.height/2);await page.mouse.down();await page.mouse.move(immersed.x+immersed.width/2+10,immersed.y+immersed.height/2+10);await page.mouse.up();
  assert.equal((await touches())[0].action,0);assert.equal((await touches()).at(-1).action,1);await page.locator('.close-enlarge').click();
  checks.push({name:'mobile layouts fit portrait/landscape and immersive fallback retains touch layer'});
  await page.setViewportSize({width:1919,height:998});await page.waitForTimeout(100);assert.equal(await page.locator('.right-shell').isVisible(),true);
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
