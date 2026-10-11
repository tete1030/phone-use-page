import {Audit} from './audit.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import statics from '@fastify/static';
import { isIP } from 'node:net';
import { access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Device,keyCodes } from './device.js';
import { Tasks } from './tasks.js';
import { ConsoleError } from './types.js';
import { render,readAssetVersion } from './ui.js';
import { apiMethods,SDK_VERSION } from './sdk.js';
import { PageConnections,type PageConnection } from './page-connections.js';
import { AuthStore,configuredPassword } from './auth.js';
import { installAuth } from './auth-http.js';
import { WebRtcVideo,rtcConfig } from './webrtc.js';
import {TurnCredentials,loadTurnKey} from './turn-credentials.js';
import {installWebRtcRoutes} from './webrtc-http.js';
import {installWssVideoRoute} from './wss-http.js';
import {ParallelWebRtcVideo} from './parallel-webrtc.js';
import { normalizeBasePath,consolePath,internalPath,permittedHost } from './paths.js';
import {selectAndroidDevice} from './device-selection.js';

const exec=promisify(execFile),port=Number(process.env.PORT||8780),host=process.env.HOST||'127.0.0.1';
const basePath=normalizeBasePath(process.env.CONSOLE_BASE_PATH),endpoint=(path:string)=>consolePath(basePath,path);
const assetVersion=await readAssetVersion();
const password=await configuredPassword(process.env),publicOrigin=process.env.CONSOLE_PUBLIC_ORIGIN;
if(publicOrigin&&(new URL(publicOrigin).origin!==publicOrigin||!publicOrigin.startsWith('https://')))throw new Error('CONSOLE_PUBLIC_ORIGIN must be an HTTPS origin without a path');
const auth=new AuthStore({password,directory:resolve(process.env.AUTH_DATA_DIR||'.local/auth'),rememberDays:Number(process.env.AUTH_REMEMBER_DAYS||90)});await auth.init();
const trustedProxies=process.env.TRUST_PROXY?.split(',').map(x=>x.trim()).filter(Boolean);
if(trustedProxies?.some(v=>{const [ip,prefix]=v.split('/');return !isIP(ip!)||(prefix!==undefined&&(!/^\d+$/.test(prefix)||Number(prefix)<1||Number(prefix)>(isIP(ip!)===4?32:128)));}))throw new Error('TRUST_PROXY must contain explicit trusted IP addresses or restricted CIDRs');
let adb=process.env.ADB_PATH||'adb';try{await access(adb);}catch{if(process.env.ADB_PATH&&adb!=='adb')throw new Error('Configured ADB_PATH does not exist');adb='adb';}
const python=process.env.PYTHON_PATH||resolve('.venv/bin/python');
await exec(adb,['start-server']);
const list=await exec(adb,['devices']);
const serial=selectAndroidDevice(list.stdout,process.env.ANDROID_SERIAL);
const device=new Device(serial,python,adb),tasks=new Tasks(device);await tasks.init();
const mediaConfig=rtcConfig(process.env);
const rtc=new ParallelWebRtcVideo(device.video,mediaConfig,new TurnCredentials(mediaConfig.turn,mediaConfig.stunUrl,await loadTurnKey(mediaConfig.turn)),mediaConfig.fallbackTurn?new TurnCredentials(mediaConfig.fallbackTurn,mediaConfig.stunUrl,await loadTurnKey(mediaConfig.fallbackTurn)):undefined);
function syncVideoPower(){const state=device.state,reason=state.powerError||!state.powerCollectedAt||Date.now()-state.powerCollectedAt>10000?'power_unknown':!state.screenOn?'screen_off':state.locked!==false?'locked':null;rtc.setVideoPaused(reason!==null,reason);}
device.on('power',syncVideoPower);device.on('observation',syncVideoPower);syncVideoPower();
const app=Fastify({bodyLimit:262144,logger:false,trustProxy:trustedProxies||false});await app.register(cookie);await app.register(websocket,{options:{maxPayload:65536}});await app.register(statics,{root:resolve('dist/web'),prefix:endpoint('/assets/')});
const audit=new Audit(resolve(process.env.AUTH_DATA_DIR||'.local/auth','../audit'));
app.addHook('onResponse',async(req,reply)=>{const logged=auth.get(req.cookies[authHttp.cookieName]);const body=(req.body||{}) as any;audit.record({at:new Date().toISOString(),method:req.method,path:internalPath(req.url.split('?')[0]!,basePath),status:reply.statusCode,ip:req.ip,client:String(req.headers['user-agent']||'').slice(0,300),owner:(req as any).auditOwner,user:logged||req.url===endpoint('/api/login')&&reply.statusCode===200?'console':'anonymous',session:logged?.id,verification:(req as any).auditVerification,requestId:typeof body.requestId==='string'?body.requestId:undefined,action:typeof body.action==='string'?body.action:undefined,target:typeof body.target?.id==='string'?body.target.id:typeof body.packageName==='string'?body.packageName:undefined});});
const controls=new Map<string,unknown>();
const pages=new PageConnections();tasks.onActivity=owner=>{pages.requireOwner(owner);if(pages.idle(owner)){disconnect(pages.active!,'IDLE_TIMEOUT');throw new ConsoleError('PAGE_OFFLINE','5分钟无操作，已断开',409);}pages.activity(owner);};device.authorize=owner=>{pages.requireOwner(owner);if(!auth.getById(pages.active!.page.sessionId))throw new ConsoleError('LOGIN_REQUIRED','登录已失效',401);};
let activationTail:Promise<unknown>=Promise.resolve();
function serialized<T>(work:()=>Promise<T>){const next=activationTail.then(work);activationTail=next.catch(()=>{});return next;}
async function cleanup(connection:PageConnection){tasks.revokeOwner(connection.owner);await rtc.close(connection.owner);await device.drain().catch(()=>{});await device.release(connection.owner).catch(()=>{});await device.setConnected(false);if(device.owner===connection.owner){device.owner=undefined;device.publish();}}
function disconnect(connection:PageConnection,reason:string){if(pages.active!==connection)return;pages.disconnect(connection,reason);tasks.revokeOwner(connection.owner);void serialized(()=>cleanup(connection)).catch(()=>{});}
const pageTimer=setInterval(()=>{const c=pages.active;if(c?.online){syncVideoPower();if(!auth.getById(c.page.sessionId))disconnect(c,'LOGIN_REQUIRED');else if(pages.idle(c.owner))disconnect(c,'IDLE_TIMEOUT');else if(Date.now()-c.lastSeen>45000)disconnect(c,'CONNECTION_TIMEOUT');}},1000);
const originAllowed=(origin:string|undefined,requestHost:string|undefined)=>{
  if(!origin)return false;try{const u=new URL(origin);return publicOrigin?origin===publicOrigin:u.host===requestHost;}catch{return false;}
};
app.addHook('onRequest',async(req,reply)=>{
  const authority=req.headers.host||'';if(!permittedHost(authority,publicOrigin))throw new ConsoleError('HOST_REJECTED','Unrecognized request host',403);
  reply.header('Cache-Control','no-store');reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");reply.header('X-Content-Type-Options','nosniff');reply.header('Referrer-Policy','no-referrer');
  if(req.method!=='GET'&&req.method!=='HEAD'&&!originAllowed(req.headers.origin,authority))throw new ConsoleError('ORIGIN_REJECTED','Request origin does not match console',403);
});
const authHttp=installAuth(app,auth,{secure:!!publicOrigin,cookiePath:process.env.CONSOLE_COOKIE_PATH||basePath,basePath,publicOrigin,assetVersion,onLogout:async s=>{const c=pages.active;if(c?.page.sessionId===s.id){pages.disconnect(c,'LOGGED_OUT');tasks.revokeOwner(c.owner);await serialized(()=>cleanup(c));}}});
const authenticate=authHttp.authenticate;
const session=(req:any,mutating=false)=>{const s=authenticate(req,mutating),id=req.headers['x-console-page']||(req.query as any)?.page;const token=req.headers['x-console-connection']||(req.query as any)?.connection;const connection=pages.require(typeof id==='string'?id:undefined,s.id,typeof token==='string'?token:undefined);if(pages.idle(connection.owner)){disconnect(connection,'IDLE_TIMEOUT');throw new ConsoleError('PAGE_OFFLINE','5分钟无操作，已断开',409);}(req as any).auditOwner=connection.owner;return {...s,owner:connection.owner,connection};};
app.addHook('preSerialization',async(req,reply,payload)=>{if(payload&&typeof payload==='object'&&'verification' in payload)(req as any).auditVerification=(payload as any).verification;const path=internalPath(req.url,basePath);if(reply.statusCode<400&&path.startsWith('/api/')&&!['/api/login','/api/logout','/api/auth/status','/api/connection/connect'].includes(path))session(req);return payload;});
app.setErrorHandler((error:any,_req,reply)=>reply.code(error instanceof ConsoleError?error.status:error instanceof z.ZodError||error.validation?400:500).send({error:{code:error instanceof z.ZodError?'INVALID_REQUEST':error.code||'SERVER_ERROR',message:error.message},...(error.execution?{execution:error.execution,verification:error.verification}:{})}));
app.get('/health',()=>({ok:true,sdk:SDK_VERSION}));
if(basePath!=='/')app.get(endpoint('/health'),()=>({ok:true,sdk:SDK_VERSION}));
app.get(endpoint('/'),async(req,reply)=>{
  const s=auth.get(req.cookies[authHttp.cookieName]);if(!s)return reply.type('text/html').send(authHttp.loginPage(reply));
  const pageId=pages.issue(s.id);return reply.type('text/html').send(await render(device.state,{basePath,assetVersion,webrtc:rtc.browserConfig,csrf:s.csrf,pageId,sdk:SDK_VERSION,apiMethods,tasks:tasks.latest().map(t=>publicTask(t,'')),ownsControl:false}));
});
app.post(endpoint('/api/connection/connect'),async req=>{
  const s=authenticate(req,true),p=z.object({pageId:z.string().uuid(),explicit:z.boolean().default(false)}).parse(req.body);
  return serialized(async()=>{const {connection,previous}=pages.begin(p.pageId,s.id,p.explicit);const stopped=previous?tasks.revokeOwner(previous.owner):0;
    if(previous)await cleanup(previous);pages.complete(connection);try{await device.setConnected(true);}catch(error){disconnect(connection,'INIT_FAILED');throw error;}return {online:true,connectionId:connection.owner,stoppedPreviousTasks:stopped};});
});
app.get(endpoint('/api/observation'),async req=>{session(req);return device.state;});
installWebRtcRoutes(app,endpoint,session,rtc);
app.post(endpoint('/api/video/select'),req=>{const s=session(req,true),p=z.object({attemptId:z.string().uuid()}).strict().parse(req.body);return rtc.select(s.owner,p.attemptId);});
app.post(endpoint('/api/video/cancel'),async req=>{const s=session(req,true),p=z.object({attemptId:z.string().uuid()}).strict().parse(req.body);await rtc.cancel(s.owner,p.attemptId);return {ok:true};});
app.post(endpoint('/api/refresh'),async req=>{session(req,true);return device.collect();});
app.get(endpoint('/api/timeline'),req=>{const s=session(req);return audit.actions(s.owner);});
app.get(endpoint('/api/sdk'),async req=>{session(req);return {version:SDK_VERSION,methods:apiMethods};});
app.get(endpoint('/api/app-state'),async req=>{session(req);const p=z.object({refreshCatalog:z.enum(['0','1']).optional()}).parse(req.query);return device.appState(p.refreshCatalog==='1');});
app.get(endpoint('/api/apps'),async req=>{session(req);return (await device.appState()).catalog;});
app.get(endpoint('/api/android-tasks'),async req=>{session(req);return device.navigation();});
app.get(endpoint('/api/running-apps'),async req=>{session(req);const state=await device.appState();return {userId:state.catalog.userId,collectedAt:state.collectedAt,processScope:state.processScope,apps:state.processes};});
app.get(endpoint('/api/navigation'),async req=>{session(req);return device.navigation();});
app.post(endpoint('/api/activity'),req=>{const s=session(req,true);pages.activity(s.owner);return {ok:true};});
app.get(endpoint('/api/screenshot'),async(req,reply)=>{const s=session(req);const image=await device.bridge.call('screenshot');pages.requireOwner(s.owner);return reply.type(image.mime).header('Content-Disposition','attachment; filename=phone-'+Date.now()+'.'+(image.mime==='image/png'?'png':'jpg')).send(Buffer.from(image.data,'base64'));});
app.post(endpoint('/api/panel'),async req=>{const s=session(req,true),p=z.object({requestId:z.string().uuid(),kind:z.enum(['notifications','settings'])}).parse(req.body);return once(req,()=>device.panel(s.owner,p.kind));});
app.post(endpoint('/api/clipboard'),async req=>{const s=session(req,true),p=z.object({write:z.boolean().default(false),text:z.string().max(32768).optional()}).parse(req.body);pages.activity(s.owner);return device.enqueue(s.owner,async()=>{await device.ensureInteractive();return device.bridge.call('clipboard',p);});});
const targetSchema=z.object({id:z.string().max(200),fingerprint:z.string().max(100),snapshotId:z.string().max(100).optional()});
app.post(endpoint('/api/node/text'),async req=>{const s=session(req,true),p=z.object({target:targetSchema}).strict().parse(req.body);pages.activity(s.owner);return device.readText(s.owner,p.target);});
const clickOptionsSchema=z.object({jitter:z.boolean().optional()}).strict();
const requestCache=new Map<string,{hash:string;work:Promise<unknown>;time:number}>();
async function once(req:any,fn:()=>Promise<unknown>){const s=session(req,true),id=z.string().uuid().parse(req.body.requestId);const key=s.owner+':'+id,hash=JSON.stringify(req.body);const old=requestCache.get(key);if(old){if(old.hash!==hash)throw new ConsoleError('REQUEST_CONFLICT','requestId reused for different action',409);return old.work;}pages.activity(s.owner);const work=fn();requestCache.set(key,{hash,work,time:Date.now()});if(requestCache.size>2000){for(const [k,v]of requestCache)if(v.time<Date.now()-300000)requestCache.delete(k);}return work;}
app.post(endpoint('/api/node'),async req=>{const s=session(req,true);const p=z.object({requestId:z.string().uuid(),target:targetSchema,action:z.enum(['click','longPress','focus','setText','setChecked']),value:z.union([z.string().max(32768),z.boolean(),z.number()]).optional(),clickOptions:clickOptionsSchema.optional()}).parse(req.body);return once(req,()=>device.nodeAction(s.owner,p.target,p.action,p.value,undefined,p.clickOptions));});
app.post(endpoint('/api/press'),async req=>{const s=session(req,true);const p=z.object({requestId:z.string().uuid(),key:z.string(),meta:z.number().int().min(0).max(200000).default(0)}).parse(req.body);const code=keyCodes[p.key];if(code===undefined)throw new ConsoleError('INVALID_KEY','不支持的按键名');return once(req,()=>device.press(s.owner,code,p.meta));});
app.post(endpoint('/api/gesture'),async req=>{const s=session(req,true);const p=z.object({requestId:z.string().uuid(),kind:z.enum(['tap','longPress','doubleTap','swipe','drag','pinch']),x:z.number().optional(),y:z.number().optional(),x1:z.number().optional(),y1:z.number().optional(),x2:z.number().optional(),y2:z.number().optional(),durationMs:z.number().min(100).max(5000).optional(),startDistance:z.number().min(1).max(2000).optional(),endDistance:z.number().min(1).max(2000).optional()}).parse(req.body);return once(req,()=>device.gesture(s.owner,p.kind,p,undefined,s.connection.abort.signal));});
app.post(endpoint('/api/wake'),async req=>{const s=session(req,true);z.object({requestId:z.string().uuid()}).parse(req.body);return once(req,()=>device.wake(s.owner));});
app.post(endpoint('/api/release'),async req=>{const s=session(req,true);await device.release(s.owner);return {ok:true};});
app.post(endpoint('/api/apps/open'),async req=>{const s=session(req,true);const p=z.object({requestId:z.string().uuid(),packageName:z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/).max(255),component:z.string().regex(/^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/).max(500).optional()}).parse(req.body);return once(req,()=>device.openApp(s.owner,p.packageName,p.component));});
app.post(endpoint('/api/android-tasks/switch'),async req=>{const s=session(req,true);const p=z.object({requestId:z.string().uuid(),taskId:z.number().int().min(0),fingerprint:z.string().regex(/^[a-f0-9]{24}$/)}).parse(req.body);return once(req,()=>device.switchTask(s.owner,p.taskId,p.fingerprint));});
app.post(endpoint('/api/navigation/back'),async req=>{const s=session(req,true);const p=z.object({requestId:z.string().uuid(),steps:z.number().int().min(1).max(10).default(1),stopOnTaskChange:z.boolean().default(true),intervalMs:z.number().int().min(100).max(2000).default(350)}).parse(req.body);return once(req,()=>device.back(s.owner,p,undefined,s.connection.abort.signal));});
app.get(endpoint('/api/tasks'),req=>{const s=session(req);return tasks.latest().map(t=>publicTask(t,s.owner));});
app.post(endpoint('/api/tasks'),async req=>{const s=session(req,true);const p=z.object({code:z.string().max(32768),check:z.boolean().optional(),clickOptions:clickOptionsSchema.optional()}).parse(req.body);pages.activity(s.owner);return publicTask(await tasks.start(p.code,s.owner,p.check,p.clickOptions),s.owner);});
app.post(endpoint('/api/tasks/:id/stop'),async req=>{const s=session(req,true);return publicTask(tasks.stop((req.params as any).id,s.owner),s.owner);});
app.get(endpoint('/tasks/:id'),async(req,reply)=>{const s=session(req);const t=tasks.records.get((req.params as any).id);if(!t)throw new ConsoleError('TASK_NOT_FOUND','任务不存在',404);return reply.type('text/html').send('<!doctype html><meta charset="utf-8"><title>脚本任务结果</title><a href="'+endpoint('/')+'">返回控制台</a><pre>'+escape(JSON.stringify(publicTask(t,s.owner),null,2))+'</pre>');});
app.get(endpoint('/observe'),async(req,reply)=>{session(req);return reply.type('text/html').send('<!doctype html><meta charset="utf-8"><title>安卓观察</title><a href="'+endpoint('/')+'">控制台</a><pre>'+escape(JSON.stringify(device.state,null,2))+'</pre>');});
app.get(endpoint('/ws/events'),{websocket:true},(ws,req)=>{
  try{const s=session(req);if(!originAllowed(req.headers.origin,req.headers.host))throw new Error('Origin rejected');
    pages.attach(s.connection,ws);
    const observation=(state:unknown)=>{if(ws.readyState===1){if(ws.bufferedAmount>1_000_000){ws.close(1013);return;}ws.send(JSON.stringify({type:'observation',state,ownsControl:device.owner===s.owner,controlAllowed:device.canClaim(s.owner),taskBusy:!!device.activeTask}));}};
    const task=(t:any)=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'task',task:publicTask(t,s.owner)}));};
    ws.on('message',()=>{try{pages.heartbeat(s.owner);}catch{ws.close(4001,'PAGE_REPLACED');}});
    ws.send(JSON.stringify({type:'tasks',tasks:tasks.latest().map(t=>publicTask(t,s.owner))}));
    const power=(data:unknown)=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'power',...data as object}));};device.on('power',power);
    observation(device.state);device.on('observation',observation);tasks.on('task',task);ws.once('close',()=>{device.off('observation',observation);device.off('power',power);tasks.off('task',task);disconnect(s.connection,'CONNECTION_CLOSED');});
  }catch{ws.close(1008,'Authentication required');}
});
installWssVideoRoute(app,endpoint,{session,originAllowed,pages,rtc,video:device.video,serialize:serialized,parallel:rtc});
app.get(endpoint('/ws/control'),{websocket:true},(ws,req)=>{
  let s:ReturnType<typeof session>;try{s=session(req);if(!originAllowed(req.headers.origin,req.headers.host))throw new Error();pages.attach(s.connection,ws);}catch{ws.close(1008);return;}
  controls.set(s.owner,ws);let tail=Promise.resolve(),inputEpoch=0;
  ws.on('message',data=>{try{pages.requireOwner(s.owner);}catch{ws.close(4001,'PAGE_REPLACED');return;}let p:any;try{p=JSON.parse(String(data));}catch{ws.close(1003,'Invalid JSON');return;}
    if(pages.idle(s.owner)){disconnect(s.connection,'IDLE_TIMEOUT');return;}
    if(p.type==='heartbeat'){pages.heartbeat(s.owner);device.heartbeat(s.owner);return;}
    if(p.type==='release'){inputEpoch++;if(device.owner===s.owner&&!device.activeTask)void device.video.release().catch(()=>{});return;}
    pages.activity(s.owner);const epoch=inputEpoch;tail=tail.then(()=>device.enqueue(s.owner,async()=>{
    if(epoch!==inputEpoch||ws.readyState!==1||controls.get(s.owner)!==ws)throw new ConsoleError('CONTROL_REPLACED','控制连接或输入焦点已更新，旧事件未重放',409);
    if(!device.state.controlAvailable)throw new ConsoleError('NO_CONTROL','设备未允许事件注入',503);
    if(p.type==='touch'){const x=z.object({action:z.number().int().min(0).max(2),id:z.number().int().min(10).max(100),x:z.number(),y:z.number(),width:z.number().int(),height:z.number().int()}).parse(p);if(x.action!==1)await device.ensureInteractive();device.claim(s.owner);await device.video.touch(x.action,BigInt(x.id),x.x,x.y,x.width,x.height);}
    else if(p.type==='key'){const x=z.object({action:z.number().int().min(0).max(1),code:z.number().int().min(0).max(400),meta:z.number().int().min(0).max(200000).default(0),repeat:z.number().int().min(0).max(1000).default(0)}).parse(p);if(x.action===0)await device.ensureInteractive();device.claim(s.owner);await device.video.key(x.action,x.code,x.meta,x.repeat);}
    else throw new ConsoleError('INVALID_CONTROL','不支持的控制消息');
    if(p.kind!=='move')audit.record({at:new Date().toISOString(),method:'EVENT',path:'/ws/control',status:200,ip:req.ip,client:String(req.headers['user-agent']||'').slice(0,300),owner:s.owner,requestId:typeof p.request==='string'?p.request.slice(0,64):undefined,action:p.type,verification:'not_verified'});
    if(ws.readyState===1)ws.send(JSON.stringify({type:'ack',kind:p.kind,request:p.request,execution:'sent',verification:'not_verified',backend:device.video.keyboardBackend}));
  })).catch(error=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'error',message:String(error)}));});});
  ws.once('close',()=>{inputEpoch++;if(controls.get(s.owner)===ws){controls.delete(s.owner);if(!device.activeTask)void device.release(s.owner).catch(()=>{});}});
});
function publicTask(t:any,owner:string){const {owner:taskOwner,code,...rest}=t;return {...rest,canStop:taskOwner===owner,code:taskOwner===owner?code:undefined};}
function escape(s:string){return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');}
void device.start().catch(error=>console.error('Device initialization:',String(error)));
await app.listen({host,port});console.log('Android Console: http://'+host+':'+port+' (device '+serial+')');
async function shutdown(){clearInterval(pageTimer);if(pages.active)pages.disconnect(pages.active,'SERVER_RESTART');await rtc.close();await tasks.close();await device.stop();await app.close();await auth.close();await audit.close();process.exit(0);}
process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
