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
      send(value){if(this.url.includes('/ws/control'))window.__messages.push(JSON.parse(value));}
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
  const rectangle=await page.locator('.video-canvas').boundingBox();
  const center={x:rectangle.x+rectangle.width/2,y:rectangle.y+rectangle.height/2};
  const reset=()=>page.evaluate(()=>window.__messages=[]);
  const touches=()=>page.evaluate(()=>window.__messages.filter(x=>x.type==='touch'));
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
  assert.equal((await touches()).filter(x=>x.action===1).length,1);
  checks.push({name:'unexpected capture loss releases touch'});

  await reset();await page.mouse.move(center.x,center.y);await page.mouse.down();
  await page.evaluate(()=>document.dispatchEvent(new PointerEvent('pointerup',{pointerId:999,clientX:0,clientY:0,bubbles:true})));
  assert.equal((await touches()).filter(x=>x.action===1).length,0);
  await page.mouse.up();assert.equal((await touches()).at(-1).action,1);
  checks.push({name:'unrelated pointer cannot finish gesture'});

  await reset();await page.mouse.down();
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await page.mouse.up();await page.waitForTimeout(40);
  assert.equal((await touches()).filter(x=>x.action===1).length,1);
  assert.ok(await page.evaluate(()=>window.__messages.some(x=>x.type==='release')));
  checks.push({name:'window blur releases touch exactly once'});

  await page.locator('.advanced-input summary').click();
  await page.locator('[data-mode=hold]').click();
  await reset();await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.up();
  assert.equal((await touches()).at(-1).action,0);
  await page.waitForTimeout(750);assert.equal((await touches()).at(-1).action,1);
  checks.push({name:'short click in long-press mode retains hold duration'});

  await page.locator('[data-mode=click]').click();await reset();
  await page.mouse.move(center.x,center.y);await page.mouse.down();
  await page.evaluate(()=>document.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true})));
  await page.mouse.up();assert.equal((await touches()).filter(x=>x.action===1).length,1);
  checks.push({name:'pointer cancellation releases touch'});

  await drag('next gesture after cancellation',right);

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
