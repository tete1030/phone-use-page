import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';

if(process.env.PHONE_LIVE_TEST!=='1')throw Error('Set PHONE_LIVE_TEST=1: this test wakes the phone, opens Settings, then restores the foreground and power state.');
if(!process.env.ANDROID_SERIAL)throw Error('Set ANDROID_SERIAL before running a real-phone test');
const exec=promisify(execFile),adb=process.env.ADB_PATH||'adb',serial=process.env.ANDROID_SERIAL;
const shell=async(...args)=>(await exec(adb,['-s',serial,'shell',...args])).stdout.trim();
const activities=await shell('dumpsys','activity','activities'),original=activities.match(/ResumedActivity: ActivityRecord\{[^\n]*?u\d+ ([^ ]+) t\d+/)?.[1];
assert.ok(original,'Cannot safely identify original foreground');
const initialPower=await shell('dumpsys','power'),wasOff=/mWakefulness=(?:Asleep|Dozing)|Display Power: state=(?:OFF|DOZE)/.test(initialPower),stayOn=await shell('settings','get','global','stay_on_while_plugged_in');
await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/webrtc-live-'));
const externalOrigin=process.env.PHONE_TEST_ORIGIN;
if(externalOrigin&&!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(externalOrigin))throw Error('External phone tests require a loopback HTTP origin');
const password=externalOrigin?(await readFile(process.env.PHONE_TEST_PASSWORD_FILE||'.local/console-password','utf8')).replace(/\r?\n$/,''):randomBytes(32).toString('base64url');if(!externalOrigin)await writeFile(dir+'/password',password,{mode:0o600});
const port=Number(process.env.PHONE_TEST_PORT||8792),origin=externalOrigin||'http://127.0.0.1:'+port;
const env={...process.env,HOST:'127.0.0.1',PORT:String(port),ANDROID_SERIAL:serial,CONSOLE_PASSWORD:'',CONSOLE_PASSWORD_FILE:dir+'/password',AUTH_DATA_DIR:dir+'/auth',CONSOLE_PUBLIC_ORIGIN:'',TRUST_PROXY:'',CONSOLE_COOKIE_PATH:'/',KEEP_SCREEN_ON:'1',WEBRTC_PORT_MIN:'50000',WEBRTC_PORT_MAX:'50031',WEBRTC_PUBLIC_IP:''};
let serverLog='',browser,server;const evidence={device:serial,originalForeground:original,originalScreenOff:wasOff,checks:[]};
const record=(name,data={})=>{evidence.checks.push({name,...data});console.log('PASS',name,JSON.stringify(data));};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const api=(page,path,body,headers={})=>page.evaluate(async({path,body,headers})=>{
  const boot=JSON.parse(document.querySelector('#console-bootstrap').textContent),u=new URL(document.querySelector('.task-link').href);
  const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'X-Console-Page':boot.pageId,'X-Console-Connection':u.searchParams.get('connection'),...(body===undefined?{}:{'Content-Type':'application/json','X-Console-CSRF':boot.csrf}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};
},{path,body,headers});
const observation=async page=>(await api(page,'/api/observation')).body;
const frames=page=>page.locator('.phone').evaluate(el=>({...el.dataset,width:el.querySelector('video').videoWidth,height:el.querySelector('video').videoHeight}));
const videoReady=async page=>{await page.waitForFunction(()=>{const p=document.querySelector('.phone');return document.querySelector('.page-status').textContent==='在线'&&p?.dataset.videoConnection==='connected'&&Number(p.dataset.videoFramesDecoded)>0;},{},{timeout:25000});const data=await frames(page);assert.equal(data.videoCodec,'video/H264');assert.equal(data.mediaProtocol,'udp');assert.ok(Number(data.mediaPort)>=50000&&Number(data.mediaPort)<=50031);return data;};
const waitState=async(page,predicate,timeout=20000)=>{const end=Date.now()+timeout;while(Date.now()<end){const s=await observation(page);if(predicate(s))return s;await wait(500);}throw Error('Phone state did not reach expected condition');};
const screenClick=async(page,bounds)=>{const r=await page.locator('video').boundingBox(),s=await observation(page);await page.mouse.click(r.x+(bounds[0]+bounds[2])/2/s.width*r.width,r.y+(bounds[1]+bounds[3])/2/s.height*r.height);};
try{
  if(externalOrigin)await shell('settings','put','global','stay_on_while_plugged_in','3');
  if(!externalOrigin){server=spawn(process.execPath,['dist/server.js'],{env,stdio:['ignore','pipe','pipe']});for(const stream of [server.stdout,server.stderr])stream.on('data',v=>{serverLog=(serverLog+v.toString()).slice(-8000);});}
  for(let i=0;i<80;i++){if(server&&server.exitCode!==null)throw Error('Test server failed: '+serverLog);try{if((await fetch(origin+'/health')).ok)break;}catch{}await wait(250);}
  const denied=await fetch(origin+'/api/webrtc/offer',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({type:'offer',sdp:'unauthorized'})});assert.equal(denied.status,401);record('unauthenticated signaling denied',{status:denied.status});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1919,height:998}}),page=await context.newPage();
  const pageErrors=[],controlErrors=[],touchTrace=[];let inputPending=0;page.on('pageerror',e=>pageErrors.push(String(e)));
  page.on('websocket',ws=>{if(!ws.url().includes('/ws/control'))return;ws.on('framesent',frame=>{try{const p=JSON.parse(String(frame.payload));if(['touch','key'].includes(p.type))inputPending++;if(p.type==='touch')touchTrace.push(p.action);}catch{}});ws.on('framereceived',frame=>{try{const p=JSON.parse(String(frame.payload));if(['ack','error'].includes(p.type))inputPending--;if(p.type==='error')controlErrors.push(p.message);}catch{}});});
  const drainInput=async()=>{for(let i=0;i<750&&inputPending>0;i++)await wait(20);assert.equal(inputPending,0,'control messages did not drain');};
  await page.goto(origin);await page.locator('[name=password]').fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForSelector('.phone');
  record('first WebRTC video',await videoReady(page));
  const csrf=await api(page,'/api/webrtc/offer',{type:'offer',sdp:'invalid'},{'X-Console-CSRF':'invalid'});assert.equal(csrf.status,403);record('signaling requires CSRF',{status:csrf.status});
  await shell('input','keyevent','223');await waitState(page,s=>!s.screenOn);
  await page.locator('.phone').click();await waitState(page,s=>s.screenOn&&s.locked===false);record('clicking video wakes and unlocks');
  await page.locator('.application-search').fill('com.android.settings');
  const open=page.locator('.apps-list').getByRole('button',{name:/^打开 com\.android\.settings(?: |$)/}).first();await open.click();await waitState(page,s=>s.foregroundApp==='com.android.settings');await page.waitForFunction(()=>!document.querySelector('[data-press=BACK]').disabled,{},{timeout:25000});await wait(800);record('app list opens Settings');await page.screenshot({path:dir+'/settings-before.png'});
  const before=await observation(page),r=await page.locator('video').boundingBox(),oldFrames=Number((await frames(page)).videoFramesDecoded);
  await page.mouse.move(r.x+r.width*.5,r.y+r.height*.75);await page.mouse.down();for(let i=1;i<=24;i++){await page.mouse.move(r.x+r.width*.5,r.y+r.height*(.75-.45*i/24));await wait(20);}await page.mouse.up();await drainInput();await wait(900);
  await waitState(page,s=>s.foregroundApp==='com.android.settings'&&s.snapshotId!==before.snapshotId);await page.waitForFunction(old=>Number(document.querySelector('.phone').dataset.videoFramesDecoded)>old,oldFrames);record('drag on live video changes UI and decoded frames');
  await page.locator('[data-gesture=down]').click();await wait(1600);
  const traceStart=touchTrace.length,fastRect=await page.locator('video').boundingBox();
  await page.mouse.move(fastRect.x+fastRect.width*.5,fastRect.y+fastRect.height*.10);await page.mouse.down();await page.mouse.move(fastRect.x+fastRect.width*.5,fastRect.y+fastRect.height*.12);await page.mouse.up();await drainInput();await wait(1200);
  const trace=touchTrace.slice(traceStart);assert.equal(trace[0],0);assert.equal(trace.at(-1),1);assert.ok(trace.slice(1,-1).includes(2));record('fast drag flushes MOVE before UP',{touchActions:trace});
  await page.locator('[data-gesture=down]').click();await wait(1600);await page.screenshot({path:dir+'/settings-after.png'});
  let s,search;
  for(let attempt=0;attempt<6;attempt++){
    s=await observation(page);search=s.nodes.find(n=>n.visible&&(n.editable||/search/i.test(n.resourceId)||/搜索/.test(n.text+' '+n.description)));
    if(search)break;
    const settingsRoot=s.foregroundApp==='com.android.settings'&&s.nodes.some(n=>n.text==='设置');
    const response=settingsRoot?await api(page,'/api/gesture',{requestId:randomUUID(),kind:'swipe',x1:s.width*.15,y1:s.height*.3,x2:s.width*.15,y2:s.height*.8,durationMs:800}):await api(page,'/api/press',{requestId:randomUUID(),key:'BACK'});
    assert.equal(response.status,200);await wait(1000);
  }
  await writeFile(dir+'/search-observation.json',JSON.stringify(s,null,2),{mode:0o600});assert.ok(search,'Settings search node unavailable');await screenClick(page,search.bounds);await drainInput();
  await waitState(page,s=>s.focus?.editable);await page.locator('.phone').focus();await page.keyboard.type('7391',{delay:120});await drainInput();await waitState(page,s=>s.focus?.text==='7391');record('keyboard on video reaches native Android search');
  await page.keyboard.press('Control+a');await page.keyboard.press('Backspace');await drainInput();await wait(500);
  await page.locator('[data-keys=numbers]').click();await page.locator('.keys button').filter({hasText:/^2$/}).click();await waitState(page,s=>s.focus?.text==='2');await page.locator('.keys button').filter({hasText:/^⌫$/}).click();record('screen keyboard reaches native Android search');
  await page.locator('[data-press=BACK]').click();await page.locator('[data-press=BACK]').click();await wait(600);
  await shell('input','keyevent','223');await waitState(page,s=>!s.screenOn);await page.locator('.wake').click();await waitState(page,s=>s.screenOn&&s.locked===false);record('wake button unlocks after screen-off');
  if(externalOrigin){
    const script=await api(page,'/api/tasks',{code:'const state = await device.observe(); return { nodes: state.nodes.length, app: state.foregroundApp };'});assert.equal(script.status,200);
    let task;for(let i=0;i<60;i++){const result=await api(page,'/api/tasks');task=result.body.find(t=>t.id===script.body.id);if(task?.status!=='running')break;await wait(200);}assert.equal(task.status,'completed');assert.ok(task.result.nodes>0);record('container QuickJS SDK executes real observe',{nodes:task.result.nodes});
  }
  const tab=await context.newPage();await tab.goto(origin);record('second page WebRTC video',await videoReady(tab));
  await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='已离线');const paused=await frames(page);await wait(1500);assert.deepEqual(await frames(page),paused);
  const stale=await api(page,'/api/webrtc/offer',{type:'offer',sdp:'invalid'});assert.equal(stale.status,409);record('takeover freezes old page and denies old signaling',{status:stale.status});
  await page.locator('.page-reconnect').click();record('explicit reconnect receives fresh WebRTC video',await videoReady(page));await tab.waitForFunction(()=>document.querySelector('.page-status').textContent==='已离线');
  const size=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,width:innerWidth,height:innerHeight}));assert.ok(size.scrollWidth<=size.width&&size.scrollHeight<=size.height);record('layout fits 1919x998 without document scrolling',size);
  await page.locator('.application-search').fill('');
  const layout=await page.evaluate(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};return {applications:rect('.applications-panel'),nodes:rect('.nodes-pane'),commands:rect('.commands'),phone:rect('.phone-pane'),columns:[...document.querySelectorAll('.application-column')].map(el=>({label:el.getAttribute('aria-label'),visible:el.getBoundingClientRect().height>0})),nested:document.querySelector('.nodes-pane').contains(document.querySelector('.applications-panel')),tabs:document.querySelectorAll('[data-app-mode],.applications-toggle').length};});
  assert.equal(layout.nested,false);assert.equal(layout.tabs,0);assert.equal(layout.columns.length,4);assert.ok(layout.columns.every(c=>c.visible));assert.equal(layout.applications.x,layout.nodes.x);assert.equal(layout.applications.width,layout.nodes.width);assert.ok(layout.applications.bottom<layout.nodes.y);assert.ok(layout.applications.right<layout.commands.x);assert.equal(layout.phone.y,layout.commands.y);assert.equal(layout.phone.height,layout.commands.height);record('independent four-column module above central UI tree',layout);
  await page.waitForFunction(()=>document.querySelectorAll('.apps-list li').length>1);assert.equal(await page.locator('.application-actions button').filter({hasText:'undefined'}).count(),0);await writeFile(dir+'/accessibility.yml',await page.locator('.applications-panel').ariaSnapshot(),{mode:0o600});
  await page.screenshot({path:dir+'/validated.png'});assert.deepEqual(pageErrors,[]);assert.deepEqual(controlErrors,[]);record('no uncaught browser or control errors');
  await page.locator('.logout').click();await page.waitForSelector('#login-form');const revoked=await page.request.post(origin+'/api/webrtc/offer',{headers:{Origin:origin},data:{type:'offer',sdp:'invalid'}});assert.equal(revoked.status(),401);
  assert.ok(server?.pid||process.env.PHONE_TEST_SERVER_PID,'Specify PHONE_TEST_SERVER_PID for external media cleanup verification');await wait(1000);const sockets=(await exec('ss',['-lunp'])).stdout.split('\n').filter(l=>l.includes('pid='+(server?.pid||process.env.PHONE_TEST_SERVER_PID)+',')&&/:500(?:0\d|[12]\d|3[01])\b/.test(l));assert.equal(sockets.length,0);record('logout revokes signaling and releases all media sockets');
  evidence.passed=true;
}catch(error){evidence.passed=false;evidence.error=String(error);console.error('FAIL',String(error));if(browser){try{await browser.contexts()[0]?.pages()[0]?.screenshot({path:dir+'/failure.png'});}catch{}}process.exitCode=1;}
finally{
  if(browser)await browser.close();if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),wait(10000)]);if(server.exitCode===null)throw Error('Test server failed to stop safely');}
  try{if(original.startsWith('com.miui.home/'))await shell('input','keyevent','3');else await shell('am','start','-n',original);if(wasOff)await shell('input','keyevent','223');const actual=await shell('settings','get','global','stay_on_while_plugged_in');if(actual!==stayOn)await shell('settings','put','global','stay_on_while_plugged_in',stayOn);evidence.restored={foreground:original,screenOff:wasOff,stayOn};}catch(error){evidence.restoreError=String(error);process.exitCode=1;}
  await writeFile(dir+'/result.json',JSON.stringify(evidence,null,2),{mode:0o600});await writeFile('.local/webrtc-last-validation',dir+'\n',{mode:0o600});console.log('Evidence directory:',dir);
}
