import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
const exec=promisify(execFile),origin='http://127.0.0.1:8780',compose=['compose','--env-file','.local/compose.env'];
if(process.env.CONTAINER_LIVE_TEST!=='1')throw Error('Set CONTAINER_LIVE_TEST=1: this test restarts the current Android Console container.');
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1919,height:998}}),page=await context.newPage();
const checks=[],record=(name,data={})=>{checks.push({name,...data});console.log('PASS',name,JSON.stringify(data));};
const video=async()=>{await page.waitForFunction(()=>document.querySelector('.page-status')?.textContent==='在线'&&document.querySelector('.phone')?.dataset.videoConnection==='connected'&&Number(document.querySelector('.phone').dataset.videoFramesDecoded)>0,{},{timeout:30000});return page.locator('.phone').evaluate(el=>({...el.dataset,width:el.querySelector('video').videoWidth,height:el.querySelector('video').videoHeight}));};
try{
  await page.goto(origin);await page.locator('[name=password]').fill((await readFile('.local/console-password','utf8')).replace(/\r?\n$/,''));await page.getByRole('button',{name:'登录',exact:true}).click();
  const before=await video();assert.equal(before.videoCodec,'video/H264');record('exact configured password logs in and decodes WebRTC',before);
  const cookie=(await context.cookies()).find(c=>c.httpOnly&&/^(__Secure-)?android_console_v2$/.test(c.name));assert.ok(cookie);assert.equal(cookie.sameSite,'Strict');assert.ok(cookie.expires>Date.now()/1000+89*86400);record('persistent HttpOnly Strict cookie', {rememberDays:90});
  const denied=await page.request.get(origin+'/api/observation');assert.equal(denied.status(),409);record('API still requires independent page token',{status:denied.status()});
  const imageBefore=(await exec('docker',[...compose,'images','-q','console'])).stdout.trim();
  await exec('docker',[...compose,'restart','console'],{timeout:60000});
  for(let i=0;i<60;i++){try{if((await fetch(origin+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
  const auth=await page.request.get(origin+'/api/auth/status');assert.equal(auth.status(),200);assert.equal((await auth.json()).authenticated,true);record('remembered login survives actual container restart');
  await page.reload();assert.equal(await page.locator('#login-form').count(),0);const after=await video();assert.equal(after.videoCodec,'video/H264');assert.equal(after.mediaProtocol,'udp');record('restart reconnects real USB video without login',after);
  assert.equal((await context.cookies()).find(c=>c.name===cookie.name)?.value,cookie.value);
  const imageAfter=(await exec('docker',[...compose,'images','-q','console'])).stdout.trim();assert.equal(imageBefore,imageAfter);
  const raw=JSON.parse((await exec('docker',['inspect','android-console-console-1'])).stdout)[0];
  assert.equal(raw.Config.User,'1000:1000');assert.equal(raw.HostConfig.Privileged,false);assert.equal(raw.HostConfig.ReadonlyRootfs,true);assert.deepEqual(raw.HostConfig.CapDrop,['ALL']);assert.equal(raw.HostConfig.NetworkMode,'host');assert.ok(raw.HostConfig.DeviceCgroupRules.includes('c 189:* rw'));
  assert.ok(raw.Config.Env.includes('HOST=0.0.0.0'));assert.ok(raw.Config.Env.includes('CONSOLE_PASSWORD_FILE=/run/secrets/console-password'));assert.ok(!raw.Config.Env.some(v=>v.startsWith('CONSOLE_PASSWORD=')));record('non-privileged readonly container with external secrets',{uid:1000,network:'host',http:'0.0.0.0:8780',media:'UDP 50000-50031'});
  const devices=(await exec('docker',[...compose,'exec','-T','console','adb','devices'])).stdout;assert.ok(devices.split('\n').some(line=>line.trim().endsWith('\tdevice')));record('container ADB retains USB authorization after restart');
  await page.locator('.logout').click();await page.getByRole('button',{name:'确认执行',exact:true}).click();await page.waitForSelector('#login-form');assert.equal((await page.request.post(origin+'/api/webrtc/offer',{headers:{Origin:origin},data:{type:'offer',sdp:'invalid'}})).status(),401);record('logout revokes remembered session after restart');
  await writeFile('.local/docker-restart-validation.json',JSON.stringify({passed:true,checks},null,2),{mode:0o600});
}catch(error){await writeFile('.local/docker-restart-validation.json',JSON.stringify({passed:false,error:String(error),checks},null,2),{mode:0o600});throw error;}
finally{await browser.close();}
