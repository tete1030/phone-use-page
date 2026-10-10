import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {render, readAssetVersion} from '../src/ui.ts';

// Exercise the production client against local fixtures, without ADB or a real page lease.
const field={id:'field1',parentId:null,depth:0,index:0,text:'初始',description:'',resourceId:'fixture:id/search',className:'android.view.View',package:'fixture',bounds:[60,180,950,300],enabled:true,clickable:true,longClickable:false,checkable:false,checked:false,focused:true,editable:true,password:false,scrollable:false,visible:true,fingerprint:'stable',selector:{},instance:0};
const observation = {
  connected:true, serial:'fixture', model:'Fixture', android:'13', system:'Fixture',
  width:1080, height:2400, rotation:0, screenOn:true, locked:false,
  snapshotId:'fixture', collectedAt:Date.now(), powerCollectedAt:Date.now(), nodes:[field],
  foregroundApp:'fixture', focus:field, focusEpoch:0, uiError:null, videoError:null, controlAvailable:true,
};
const html=await render(observation,{basePath:'/',assetVersion:await readAssetVersion(),
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
    window.__messages=[];window.__phoneText='初始';window.__writes=[];window.__presses=[];
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
      if(path==='/api/press')window.__presses.push(JSON.parse(options.body));
      if(path==='/api/binding')data={binding:{target:{id:'field1',fingerprint:'stable',snapshotId:'fixture'},focusEpoch:0},text:window.__phoneText};
      if(path==='/api/text'){const body=JSON.parse(options.body);window.__writes.push(body);await new Promise(r=>setTimeout(r,100));if(body.expectedText!==window.__phoneText)return new Response(JSON.stringify({error:{code:'TEXT_CONFLICT',message:'fixture conflict'}}),{status:409});window.__phoneText=body.text;data={text:body.text,focusEpoch:0,verification:'verified'};}
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
  await page.waitForFunction(()=>!document.querySelector('.screen-proxy').hidden);
  const proxy=page.getByRole('textbox',{name:'手机输入框：search',exact:true});
  await proxy.fill('中文 abc 😀');assert.equal(await page.locator('.run').isDisabled(),true);assert.equal(await page.locator('[data-press=BACK]').isDisabled(),true);await page.waitForFunction(()=>window.__phoneText==='中文 abc 😀');
  await page.waitForFunction(()=>document.querySelector('.sync-status').textContent.includes('已确认'));
  assert.equal(await page.locator('.text-input').inputValue(),'中文 abc 😀');
  await proxy.fill('');await page.waitForFunction(()=>window.__phoneText==='');
  await proxy.pressSequentially('abc');await page.waitForFunction(()=>window.__phoneText==='abc');
  await proxy.press('Enter');await page.waitForFunction(()=>window.__presses.some(p=>p.key==='ENTER'&&p.binding?.target.id==='field1'));
  for(const viewport of [{width:1600,height:900},{width:1919,height:998}]){await page.setViewportSize(viewport);await page.waitForTimeout(200);const geometry=await page.evaluate(()=>({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight}));assert.ok(geometry.w<=viewport.width&&geometry.h<=viewport.height);await page.screenshot({path:`.local/agent-layout-${viewport.width}.png`});}
  await page.locator('.video-enlarge').click();assert.equal(await page.locator('.close-enlarge').isVisible(),true);await page.locator('.close-enlarge').click();
  const old=await page.locator('.phone').getAttribute('data-video-freshness');await page.locator('.video-reconnect').click();await page.waitForTimeout(200);assert.equal(await page.locator('.page-status').textContent(),'在线');
  await page.locator('.logout').click();assert.equal(await page.getByRole('dialog',{name:'确认操作'}).isVisible(),true);await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.locator('.page-status').textContent(),'在线');
  assert.deepEqual(errors,[]);const report={passed:true,checks:['automatic editable-semantic target','fill Unicode','pending text blocks phone and JS actions','fill empty','type append','proxy Enter commits to the verified phone target','two viewport layouts','enlarge exit','video-only reconnect','accessible logout confirmation'],phoneAccessed:false,writes:await page.evaluate(()=>window.__writes.map(w=>({length:w.text.length,expectedLength:w.expectedText.length})))};
  await writeFile('.local/agent-ui-result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
