import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
if(process.env.PUBLIC_LIVE_TEST!=='1'||!process.env.PHONE_PUBLIC_URL)throw Error('Set PUBLIC_LIVE_TEST=1 and PHONE_PUBLIC_URL; this test takes control of your console');
const exec=promisify(execFile),base=process.env.PHONE_PUBLIC_URL,origin=new URL(base).origin,basePath=new URL(base).pathname,prefix=basePath==='/'?'':basePath.slice(0,-1);
if(!['/','/phone/'].includes(basePath)||!origin.startsWith('https://'))throw Error('Use the configured HTTPS /phone/ origin');
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1919,height:998}}),page=await context.newPage(),checks=[],errors=[],badPaths=[];
const record=(name,data={})=>{checks.push({name,...data});console.log('PASS',name,JSON.stringify(data));};
page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{const u=new URL(r.url());if(u.origin===origin&&(!u.pathname.startsWith(basePath)||(basePath==='/'&&u.pathname.startsWith('/phone/'))))badPaths.push(u.pathname);});
let websocketPaths=[];page.on('websocket',ws=>websocketPaths.push(new URL(ws.url()).pathname));
const api=(p,path,body)=>p.evaluate(async({path,body,prefix})=>{const boot=JSON.parse(document.querySelector('#console-bootstrap').textContent),u=new URL(document.querySelector('.task-link').href);const r=await fetch(prefix+path,{method:body===undefined?'GET':'POST',headers:{'X-Console-Page':boot.pageId,'X-Console-Connection':u.searchParams.get('connection'),...(body===undefined?{}:{'Content-Type':'application/json','X-Console-CSRF':boot.csrf})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};},{path,body,prefix});
const online=p=>p.waitForFunction(()=>document.querySelector('.page-status')?.textContent==='在线',{},{timeout:25000});
const video=p=>p.waitForFunction(()=>document.querySelector('.phone')?.dataset.videoConnection==='connected'&&Number(document.querySelector('.phone').dataset.videoFramesDecoded)>0,{},{timeout:30000});
try{
  if(basePath!=='/'){const redirect=await page.request.get(origin+'/phone',{maxRedirects:0});assert.equal(redirect.status(),308);assert.equal(redirect.headers().location,base);record('canonical /phone redirect');}
  await page.goto(base);await page.waitForSelector('#login-form');assert.equal(await page.locator('#console-bootstrap').count(),0);assert.equal(await page.locator('.device-model').count(),0);assert.equal(await page.locator('[name=password]').count(),1);
  const denied=await page.request.get(base+'api/observation');assert.equal(denied.status(),401);record('unauthenticated public entry reveals login only',{status:denied.status()});
  await page.locator('[name=password]').fill((await readFile('.local/console-password','utf8')).replace(/\r?\n$/,''));await page.getByRole('button',{name:'登录',exact:true}).click();await online(page);
  const cookie=(await context.cookies()).find(c=>c.name==='__Secure-android_console_v2');assert.ok(cookie);assert.equal(cookie.secure,true);assert.equal(cookie.httpOnly,true);assert.equal(cookie.sameSite,'Strict');assert.equal(cookie.path,basePath);assert.ok(cookie.expires>Date.now()/1000+89*86400);record('HTTPS login uses scoped Secure HttpOnly Strict cookie',{rememberDays:90,path:cookie.path});
  await page.waitForFunction(()=>document.querySelectorAll('.apps-list li').length>0,{},{timeout:20000});const state=await api(page,'/api/observation');assert.equal(state.status,200);assert.ok(state.body.serial);if(process.env.ANDROID_SERIAL)assert.equal(state.body.serial,process.env.ANDROID_SERIAL);record('authenticated phone observation and application lists');
  assert.ok(websocketPaths.includes(prefix+'/ws/events'));assert.ok(websocketPaths.includes(prefix+'/ws/control'));record('event and control WebSockets through HTTPS proxy');
  const sdk=await api(page,'/api/sdk');assert.equal(sdk.status,200);assert.ok(sdk.body.methods.length>0);record('SDK and result-page links remain in subpath');
  const observe=await page.request.get(await page.locator('.task-link').evaluate(el=>el.href));assert.equal(observe.status(),200);assert.ok((await observe.text()).includes('href="'+basePath+'"'));
  await video(page);const stats=await page.locator('.phone').evaluate(el=>({...el.dataset}));assert.equal(stats.videoCodec,'video/H264');assert.equal(stats.mediaProtocol,'udp');record('real WebRTC via public signaling from LAN client',stats);
  await page.reload();await online(page);assert.equal(await page.locator('#login-form').count(),0);await video(page);record('remembered HTTPS login survives page reload');
  if(process.env.PUBLIC_RESTART_TEST==='1'){
    await exec('docker',['compose','--env-file','.local/compose.env','restart','console'],{timeout:60000});for(let i=0;i<80;i++){try{const r=await page.request.get(base+'health');if(r.ok())break;}catch{}await new Promise(r=>setTimeout(r,250));}
    await page.reload();await online(page);assert.equal(await page.locator('#login-form').count(),0);await video(page);record('Secure cookie and USB video survive container restart');
  }
  const other=await context.newPage();await other.goto(base);await online(other);await page.waitForFunction(()=>document.querySelector('.page-status').textContent==='已离线');const stale=await api(page,'/api/observation');assert.equal(stale.status,409);record('second public page replaces old page',{status:stale.status});
  await page.locator('.page-reconnect').click();await online(page);await video(page);await other.waitForFunction(()=>document.querySelector('.page-status').textContent==='已离线');await other.close();record('public page explicit reconnect');
  const wrongOrigin=await page.request.post(base+'api/login',{headers:{Origin:'https://wrong.example'},data:{}});assert.equal(wrongOrigin.status(),403);record('wrong Origin rejected');
  assert.deepEqual(badPaths,[]);assert.deepEqual(errors,[]);await page.screenshot({path:'.local/public-phone-validation.png'});record('all browser requests stay at the configured base without page errors');
  await page.locator('.logout').click();await page.getByRole('button',{name:'确认执行',exact:true}).click();await page.waitForSelector('#login-form');assert.equal((await page.request.get(base+'api/observation')).status(),401);assert.equal((await context.cookies()).some(c=>c.name==='__Secure-android_console_v2'),false);record('logout revokes and clears scoped public cookie');
  await writeFile('.local/public-phone-validation.json',JSON.stringify({passed:true,base,checks},null,2),{mode:0o600});
}catch(error){await writeFile('.local/public-phone-validation.json',JSON.stringify({passed:false,error:String(error),base,checks},null,2),{mode:0o600});throw error;}
finally{await browser.close();}
