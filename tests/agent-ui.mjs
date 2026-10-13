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
  await context.addInitScript((initial)=>{
    window.__state=initial;window.__messages=[];window.__phoneText='初始';window.__writes=[];window.__reads=[];window.__presses=[];window.__nodeActions=[];window.__taskRequests=[];
    window.__sockets=[];window.__videoErrors=[];
    window.__offers=0;
    window.__observe=state=>{window.__state=state;for(const socket of window.__sockets)if(socket.url.includes('/ws/events'))socket.onmessage?.({data:JSON.stringify({type:'observation',state,controlAllowed:true,taskBusy:false})});};
    setInterval(()=>{if(window.__powerPaused)return;for(const socket of window.__sockets)if(socket.url.includes('/ws/events'))socket.onmessage?.({data:JSON.stringify({type:'power',screenOn:window.__state.screenOn,locked:window.__state.locked,powerCollectedAt:Date.now()})});},1000);
    window.__clockOffset=0;
    const nativeNow=performance.now.bind(performance);
    performance.now=()=>nativeNow()+window.__clockOffset;
    const frameCallbacks=new Map();let frameId=0;
    delete window.MediaStreamTrackProcessor;
    Object.defineProperty(HTMLVideoElement.prototype,'videoWidth',{get:()=>864});
    Object.defineProperty(HTMLVideoElement.prototype,'videoHeight',{get:()=>1920});
    HTMLVideoElement.prototype.play=async()=>{};
    HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){frameCallbacks.set(this,callback);return ++frameId;};
    window.__paintFrame=()=>{for(const [video,callback]of [...frameCallbacks]){frameCallbacks.delete(video);callback(performance.now(),{});}};
    const fixtureMode=localStorage.getItem('fixture-mode');
    class FixtureSocket {
      readyState=1;
      constructor(url){this.url=url;window.__sockets.push(this);setTimeout(()=>{this.onopen?.({});const u=new URL(url),generation=Number(u.searchParams.get('generation')||0);const peers=window.__sockets.filter(s=>s.readyState===1&&new URL(s.url).searchParams.get('generation')===u.searchParams.get('generation')&&/\/ws\/(events|control)/.test(s.url));if(!window.__blockReady&&peers.some(s=>s.url.includes('/ws/events'))&&peers.some(s=>s.url.includes('/ws/control')))for(const s of peers)s.onmessage?.({data:JSON.stringify({type:'connection-ready',generation})});},0);}
      send(value){if(JSON.parse(value).type==='heartbeat'){setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'heartbeat'})}),0);return;}if(this.url.includes('/ws/control'))window.__messages.push(JSON.parse(value));}
      close(){this.readyState=3;}
    }
    window.WebSocket=FixtureSocket;
    class FixturePeer extends EventTarget {
      constructor(){super();window.__rtcCreated=(window.__rtcCreated||0)+1;}
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
      if(path==='/api/video/client-error'){window.__videoErrors.push({report:JSON.parse(options.body),headers:options.headers});if(window.__rejectDiagnostic)throw new Error('diagnostic transport failed');}
      if(path==='/api/press')window.__presses.push(JSON.parse(options.body));
      if(path==='/api/node'){
        const body=JSON.parse(options.body);window.__nodeActions.push(body);
        if(body.action==='setText'){
          window.__writes.push(body);await new Promise(r=>setTimeout(r,100));
          if(window.__failNextWrite){window.__failNextWrite=false;return new Response(JSON.stringify({error:{code:'STALE_TARGET',message:'目标已改变，未发送'}}),{status:409});}
          window.__phoneText=body.value;
          let nodes=window.__state.nodes.map(n=>n.id===body.target.id?{...n,text:body.value,fingerprint:'write-'+window.__writes.length,
            ...(window.__resizeWrites?{bounds:[n.bounds[0],n.bounds[1],body.value?850:950,n.bounds[3]]}:{})}:n);
          if(window.__advanceFocus){window.__advanceFocus=false;nodes=nodes.map(n=>({...n,focused:false}));}
          if(window.__replaceAfterWrite){window.__replaceAfterWrite=false;nodes=nodes.map(n=>n.id===body.target.id?{...n,id:'replacement-field'}:n);}
          const updated={...window.__state,nodes,focus:nodes.find(n=>n.focused)||null,...(window.__changeWindowAfterWrite?{windowId:'changed-window'}:{})};
          if(window.__deferWriteObservation){const ms=window.__deferWriteObservation;window.__deferWriteObservation=0;setTimeout(()=>window.__observe(updated),ms);}
          else window.__observe(updated);
          data={verification:'verified'};
        }
      }
      if(path==='/api/node/text'){window.__reads.push(JSON.parse(options.body));data={text:window.__phoneText};}
      if(path==='/api/tasks'){window.__taskRequests.push(JSON.parse(options.body));data={id:'fixture-script',startedAt:Date.now(),status:'completed',steps:0,logs:[],result:null};}
      if(path==='/api/connection/connect')data={connectionId:'fixture',generation:0};
      if(path==='/api/connection/resume')data={connectionId:'fixture',generation:(window.__resumeGeneration=(window.__resumeGeneration||0)+1)};
      if(path==='/api/app-state')data={collectedAt:Date.now(),catalog:{apps:[]},processes:[],navigation:{locked:false,current:null,tasks:[]}};
      if(path==='/api/webrtc/config')data={provider:'coturn',availableProviders:['coturn'],iceTransportPolicy:'relay',iceServers:[{urls:'turns:fixture.invalid:8443?transport=tcp'}],renewAfterMs:null};
      if(path==='/api/webrtc/config'&&JSON.parse(options.body).provider==='none')data={provider:'none',availableProviders:['none'],iceTransportPolicy:'all',iceServers:[],renewAfterMs:null};
      if(path==='/api/webrtc/config'&&fixtureMode)data={...data,provider:'cloudflare',availableProviders:['cloudflare'],gatherMs:50};
      if(path==='/api/webrtc/offer'){window.__offers++;data={width:864,height:1920,sdp:''};}
      if(path==='/api/webrtc/status')data={state:'connected',fixture:true};
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    };
  },observation);
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(origin);
  await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='在线'&&document.querySelector('.phone').dataset.iceMode==='relay');
  await page.waitForTimeout(100);await page.evaluate(()=>window.__paintFrame());
  const draft=page.getByRole('textbox',{name:'待填写文字（网页草稿）',exact:true});
  assert.equal(await page.locator('.screen-proxy,.sync-toggle,.rebind').count(),0);
  assert.equal(await draft.inputValue(),'');
  await draft.fill('中文 abc 😀');await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>window.__writes.length),0);
  assert.equal(await page.locator('.run').isEnabled(),true);assert.equal(await page.locator('[data-press=BACK]').isEnabled(),true);
  await page.evaluate(()=>{window.__phoneText='手机改字';window.__observe({...window.__state,nodes:window.__state.nodes.map(n=>({...n,text:'手机改字',fingerprint:'updated'}))});});
  assert.equal(await draft.inputValue(),'中文 abc 😀');
  await draft.press('Enter');assert.equal(await page.evaluate(()=>window.__presses.some(p=>p.key==='ENTER')),false);
  await draft.fill('中文 abc 😀');await page.locator('.text-submit').click();
  await page.waitForFunction(()=>document.querySelector('.text-status').textContent.includes('已填写'));
  assert.equal(await page.evaluate(()=>window.__phoneText),'中文 abc 😀');assert.equal(await page.evaluate(()=>window.__writes.length),1);
  await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>window.__writes.length),1);
  await draft.fill('');await page.locator('.text-submit').click();await page.waitForFunction(()=>window.__phoneText==='');
  await page.waitForFunction(()=>!document.querySelector('.text-submit').disabled);
  await draft.pressSequentially('abc');await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>window.__phoneText),'');
  await page.locator('.text-submit').click();await page.waitForFunction(()=>window.__phoneText==='abc');await page.waitForFunction(()=>!document.querySelector('.text-submit').disabled);
  await draft.fill('next');
  await page.evaluate(()=>{const first={...window.__state.nodes[0],focused:false};const second={...first,id:'field2',resourceId:'fixture:id/other',focused:true};window.__observe({...window.__state,nodes:[first,second],focus:second,focusEpoch:1});});
  assert.equal(await page.locator('.text-submit').isDisabled(),true);assert.equal(await page.locator('.text-target').inputValue(),'');assert.equal(await draft.inputValue(),'next');
  await page.locator('.text-target').selectOption('field2');await page.locator('.text-submit').click();await page.waitForFunction(()=>window.__phoneText==='next');
  await page.waitForFunction(()=>!document.querySelector('.text-submit').disabled);assert.equal(await page.evaluate(()=>window.__writes.at(-1).target.id),'field2');
  await page.evaluate(()=>window.__phoneText='读回😀');await page.locator('.text-read').click();await page.getByRole('button',{name:'确认执行',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.text-input').value==='读回😀');assert.equal(await page.evaluate(()=>window.__writes.length),4);
  await page.evaluate(()=>window.__phoneText='之后手机改字');await page.waitForTimeout(250);assert.equal(await draft.inputValue(),'读回😀');
  await page.evaluate(()=>window.__failNextWrite=true);await page.locator('.text-submit').click();await page.waitForFunction(()=>document.querySelector('.text-status').textContent.includes('STALE_TARGET'));
  await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>window.__writes.length),5);assert.equal(await draft.inputValue(),'读回😀');assert.equal(await page.locator('[data-press=BACK]').isEnabled(),true);
  await page.locator('.text-target').selectOption('field1');await draft.fill('原字段');await page.evaluate(()=>window.__advanceFocus=true);await page.locator('.text-submit').click();
  await page.waitForFunction(()=>document.querySelector('.text-status').textContent.includes('已填写'));
  assert.equal(await page.evaluate(()=>window.__writes.at(-1).target.id),'field1');
  const screenRect=await page.locator('.video-canvas').boundingBox();await page.mouse.click(screenRect.x+screenRect.width/2,screenRect.y+screenRect.height/2);await page.keyboard.press('Escape');
  assert.equal(await draft.evaluate(node=>document.activeElement===node),true);
  await page.evaluate(()=>{window.__powerPaused=true;window.__observe({...window.__state,powerCollectedAt:Date.now()-20000});});
  assert.equal(await page.locator('.device-status').textContent(),'正在读取手机状态');assert.equal(await page.locator('.text-submit').isDisabled(),true);
  await page.evaluate(()=>{window.__powerPaused=false;window.__observe({...window.__state,powerCollectedAt:Date.now()});});
  const jitter=page.getByRole('checkbox',{name:'元素动作与 JS 随机落点'});
  assert.equal(await jitter.isChecked(),true);
  await page.locator('.node-button').first().click();await page.locator('.inspect-click').click();
  await page.waitForFunction(()=>window.__nodeActions.filter(n=>n.action==='click').length===1);
  assert.equal(await page.evaluate(()=>window.__nodeActions.filter(n=>n.action==='click')[0].clickOptions.jitter),true);
  await jitter.uncheck();await page.locator('.inspect-click').click();
  await page.waitForFunction(()=>window.__nodeActions.filter(n=>n.action==='click').length===2);
  assert.equal(await page.evaluate(()=>window.__nodeActions.filter(n=>n.action==='click')[1].clickOptions.jitter),false);
  await page.locator('.code-input').fill('return await device.observe();');await page.locator('.run').click();
  await page.waitForFunction(()=>window.__taskRequests.length===1);
  assert.equal(await page.evaluate(()=>window.__taskRequests[0].clickOptions.jitter),false);
  const writes=await page.evaluate(()=>window.__writes.map(w=>({length:w.value.length,target:w.target.id})));
  await page.reload();await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='在线');
  assert.equal(await jitter.isChecked(),false);await jitter.check();
  for(const viewport of [{width:1600,height:900},{width:1919,height:998}]){await page.setViewportSize(viewport);await page.waitForTimeout(200);const geometry=await page.evaluate(()=>({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight}));assert.ok(geometry.w<=viewport.width&&geometry.h<=viewport.height);await page.screenshot({path:`.local/agent-layout-${viewport.width}.png`});}
  await page.reload();await page.waitForFunction(()=>window.__offers>0&&document.querySelector('.page-status').textContent==='在线');
  await page.evaluate(()=>{window.__paintFrame();window.__resizeWrites=true;});
  await draft.fill('resize-probe');await page.locator('.text-submit').click();
  await page.waitForFunction(()=>window.__phoneText==='resize-probe'&&!document.querySelector('.text-submit').disabled);
  assert.equal(await page.locator('.text-target').inputValue(),'field1');
  await draft.fill('');await page.locator('.text-submit').click();await page.waitForFunction(()=>window.__phoneText===''&&!document.querySelector('.text-submit').disabled);
  assert.equal(await page.locator('.text-target').inputValue(),'field1');
  await page.evaluate(()=>window.__deferWriteObservation=500);await draft.fill('late-snapshot');await page.locator('.text-submit').click();
  await page.waitForFunction(()=>document.querySelector('.text-status').textContent.includes('等待输入框最新快照'));
  assert.equal(await page.locator('.text-submit').isDisabled(),true);
  await page.waitForFunction(()=>!document.querySelector('.text-submit').disabled);
  assert.equal(await draft.inputValue(),'late-snapshot');
  await page.evaluate(()=>window.__observe({...window.__state,nodes:window.__state.nodes.map(n=>({...n,bounds:[60,180,800,300],fingerprint:'external-resize'}))}));
  assert.equal(await page.locator('.text-submit').isDisabled(),true);
  await page.locator('.text-target').selectOption('field1');await page.evaluate(()=>window.__replaceAfterWrite=true);await draft.fill('do-not-follow');await page.locator('.text-submit').click();
  await page.waitForFunction(()=>document.querySelector('.text-status').textContent.includes('已填写'));
  assert.equal(await page.locator('.text-submit').isDisabled(),true);assert.equal(await page.locator('.text-target').inputValue(),'');
  assert.equal(await draft.inputValue(),'do-not-follow');
  await page.reload();await page.waitForFunction(()=>window.__offers>0&&document.querySelector('.page-status').textContent==='在线');
  await page.evaluate(()=>{window.__paintFrame();window.__changeWindowAfterWrite=true;});await draft.fill('new-window');await page.locator('.text-submit').click();
  await page.waitForFunction(()=>document.querySelector('.text-status').textContent.includes('已填写'));
  assert.equal(await page.locator('.text-submit').isDisabled(),true);assert.equal(await page.locator('.text-target').inputValue(),'');
  await page.locator('.video-enlarge').click();assert.equal(await page.locator('.close-enlarge').isVisible(),true);await page.locator('.close-enlarge').click();
  const old=await page.locator('.phone').getAttribute('data-video-freshness');await page.locator('.video-reconnect').click();await page.waitForTimeout(200);assert.equal(await page.locator('.page-status').textContent(),'在线');
  await page.locator('.logout').click();assert.equal(await page.getByRole('dialog',{name:'确认操作'}).isVisible(),true);await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.locator('.page-status').textContent(),'在线');
  let transportHTML=await render(observation,{basePath:'/',assetVersion:await readAssetVersion(),webrtc:{availableProviders:['wss']},tasks:[],apiMethods:[],csrf:'fixture',pageId:'fixture',sdk:'fixture',ownsControl:false});
  await page.route(origin+'/',route=>route.fulfill({status:200,contentType:'text/html',body:transportHTML}));
  await page.evaluate(()=>localStorage.setItem('android-video-mode','coturn'));await page.reload();
  await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='在线'&&document.querySelector('.video-candidate[data-provider=wss]'));
  assert.equal(await page.locator('[data-video-mode][value=auto]').isChecked(),true);
  assert.equal(await page.locator('[data-video-mode][value=wss]').isEnabled(),true);
  for(const provider of ['none','coturn','cloudflare'])assert.equal(await page.locator(`[data-video-mode][value=${provider}]`).isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.__rtcCreated||0),0);assert.equal(await page.evaluate(()=>window.__offers),0);
  assert.equal(await page.evaluate(()=>window.__sockets.filter(ws=>ws.url.includes('/ws/video')).length),1);
  await page.evaluate(()=>{window.__rejectDiagnostic=true;const ws=window.__sockets.find(ws=>ws.url.includes('/ws/video'));ws.onmessage({data:JSON.stringify({type:'metadata',width:864,height:1920,codec:0})});});
  await page.waitForFunction(()=>window.__videoErrors.length===1);
  const diagnostic=await page.evaluate(()=>window.__videoErrors[0]);
  assert.equal(diagnostic.report.provider,'wss');assert.equal(diagnostic.report.stage,'metadata');assert.equal(diagnostic.report.code,'WSS_CODEC_UNSUPPORTED');
  assert.match(diagnostic.report.assetVersion,/^[a-f0-9]{16}$/);assert.match(diagnostic.report.attemptId,/^[a-f0-9-]{36}$/);
  assert.equal(diagnostic.headers['X-Console-CSRF'],'fixture');assert.equal(diagnostic.headers['X-Console-Generation'],'0');
  assert.equal(await page.locator('.page-status').textContent(),'在线');
  transportHTML=await render(observation,{basePath:'/',assetVersion:await readAssetVersion(),webrtc:{availableProviders:['none']},tasks:[],apiMethods:[],csrf:'fixture',pageId:'fixture',sdk:'fixture',ownsControl:false});
  await page.evaluate(()=>localStorage.setItem('android-video-mode','wss'));await page.reload();
  await page.waitForFunction(()=>window.__offers>0);
  assert.equal(await page.locator('[data-video-mode][value=none]').isEnabled(),true);
  assert.equal(await page.locator('[data-video-mode][value=auto]').isChecked(),true);
  assert.equal(await page.locator('[data-video-mode][value=wss]').isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.__sockets.some(ws=>ws.url.includes('/ws/video'))),false);
  assert.deepEqual(errors,[]);const report={passed:true,checks:['one draft textbox without mirror controls','fill/type and Enter never send automatically','draft does not block navigation or JS','explicit Unicode/empty writes','phone changes never overwrite draft','focus change requires target selection','one-shot native read','failure preserves draft without retry','own verified resize and clear retain the same target','delayed observation keeps text actions disabled until the own write is observed','external resize, replacement and new window require target selection','node jitter default and checkbox override','JS captures jitter setting','jitter setting survives reload','two viewport layouts','enlarge exit','video-only reconnect','accessible logout confirmation','WSS-only creates no WebRTC and resets unavailable saved mode','WSS diagnostics include version and auth headers; failed reporting leaves control online','direct-only is selectable without TURN or WSS'],phoneAccessed:false,writes};
  await writeFile('.local/agent-ui-result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
