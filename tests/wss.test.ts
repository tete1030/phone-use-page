import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import {WebSocket} from 'ws';
import {Video} from '../src/video.js';
import {AuthStore} from '../src/auth.js';
import {installAuth} from '../src/auth-http.js';
import {PageConnections} from '../src/page-connections.js';
import {installWssVideoRoute} from '../src/wss-http.js';

function videoFixture(){
  const video=new Video('fixture');let resets=0;video.start=async()=>{};video.width=864;video.height=1920;
  video.client={controller:{resetVideo:async()=>{resets++;}}} as any;
  const events=new EventEmitter(),ws=Object.assign(events,{readyState:1,bufferedAmount:0,sent:[] as any[],send(value:any){this.sent.push(value);},close(code:number){this.readyState=3;events.emit('close',code);}});
  return {video,ws,resets:()=>resets};
}
const config={type:'configuration' as const,data:Uint8Array.of(0,0,0,1,0x67)},frame=(keyframe:boolean)=>({type:'data' as const,data:Uint8Array.of(0,0,0,1,keyframe?0x65:0x41),keyframe,pts:100n});
test('WSS holds frames while paused and resumes only from a new keyframe',async()=>{
  const f=videoFixture();try{await f.video.view(f.ws as any);f.video.publishPacket(config);f.video.publishPacket(frame(true));
    const before=f.video.wssDiagnostics();f.video.setVideoPaused(true,'locked');
    f.video.publishPacket(frame(true));f.video.publishPacket(frame(false));
    assert.equal(f.video.wssDiagnostics().videoPayloadBytes,before.videoPayloadBytes);assert.equal(f.ws.readyState,1);
    f.video.setVideoPaused(false,null);f.video.publishPacket(frame(false));assert.equal(f.video.wssDiagnostics().videoPayloadBytes,before.videoPayloadBytes);
    f.video.publishPacket(config);f.video.publishPacket(frame(true));assert.ok(f.video.wssDiagnostics().videoPayloadBytes>before.videoPayloadBytes);assert.equal(f.resets(),2);
  }finally{f.video.closeViewers();}
});
test('initially paused WSS can attach without requesting or leaking video frames',async()=>{
  const f=videoFixture();f.video.setVideoPaused(true,'screen_off');
  try{f.video.publishPacket(config);await f.video.view(f.ws as any);f.video.publishPacket(frame(true));assert.equal(f.resets(),0);
    assert.equal(f.video.wssDiagnostics().videoPayloadBytes,0);assert.equal(f.ws.readyState,1);
    f.video.setVideoPaused(false,null);f.video.publishPacket(frame(true));assert.equal(f.resets(),1);assert.ok(f.video.wssDiagnostics().videoPayloadBytes>0);
  }finally{f.video.closeViewers();}
});
test('WSS latency probe works during pause without sending or counting video frames',async()=>{
  const f=videoFixture();f.video.setVideoPaused(true,'locked');
  try{await f.video.view(f.ws as any);f.ws.emit('message',Buffer.from('{"type":"ping","id":7}'));
    assert.deepEqual(JSON.parse(f.ws.sent.at(-1)),{type:'pong',id:7});assert.equal(f.video.wssDiagnostics().videoPayloadBytes,0);
    const count=f.ws.sent.length;f.ws.emit('message',Buffer.from('{"type":"ping","id":-1}'));assert.equal(f.ws.sent.length,count);
  }finally{f.video.closeViewers();}
});
test('keyframe resync is throttled, preserves the socket and suppresses delta frames',async()=>{
  const f=videoFixture();try{await f.video.view(f.ws as any);f.video.publishPacket(config);f.video.publishPacket(frame(true));const initial=f.resets();
    f.ws.emit('message',Buffer.from('{"type":"keyframe"}'));f.ws.emit('message',Buffer.from('{"type":"keyframe"}'));assert.equal(f.resets(),initial+1);
    const before=f.video.wssDiagnostics().videoFrameMessagesSent;f.video.publishPacket(frame(false));assert.equal(f.video.wssDiagnostics().videoFrameMessagesSent,before);
    f.video.publishPacket(frame(true));assert.equal(f.video.wssDiagnostics().videoFrameMessagesSent,before+1);assert.equal(f.ws.readyState,1);
    f.video.setVideoPaused(true,'locked');f.ws.emit('message',Buffer.from('{"type":"keyframe"}'));assert.equal(f.resets(),initial+1);
  }finally{f.video.closeViewers();}
});
test('slow and disconnected WSS viewers cannot build unbounded server output',async()=>{
  const f=videoFixture();await f.video.view(f.ws as any);f.ws.bufferedAmount=2_000_001;
  f.video.publishPacket(frame(true));assert.equal(f.ws.readyState,3);assert.equal(f.video.viewers.size,0);
  assert.equal(f.video.wssDiagnostics().videoPayloadBytes,0);
});

test('real WSS handshake requires login, correct Origin and the current page token',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'phone-wss-auth-')),store=new AuthStore({password:'fixture-wss-password-only',directory}),app=Fastify(),pages=new PageConnections();
  await store.init();await app.register(cookie);await app.register(websocket);const auth=installAuth(app,store,{secure:false});
  let origin='',views=0,closes=0;
  installWssVideoRoute(app,p=>p,{session:req=>{const s=auth.authenticate(req);const c=pages.require(req.query.page,s.id,req.query.connection);return {owner:c.owner,connection:c};},
    originAllowed:value=>value===origin,pages,rtc:{close:async()=>{closes++;}},video:{closeViewers:()=>{},view:async ws=>{views++;ws.send('metadata-fixture');}},serialize:work=>work()});
  origin=await app.listen({host:'127.0.0.1',port:0});const sockets:WebSocket[]=[];
  async function connect(path:string,cookieValue?:string,requestOrigin=origin){const ws=new WebSocket(origin.replace('http','ws')+path,{headers:{Origin:requestOrigin,...(cookieValue?{Cookie:cookieValue}:{})}});sockets.push(ws);return ws;}
  try{
    let ws=await connect('/ws/video');assert.equal((await once(ws,'close'))[0],1008);assert.equal(views,0);
    const logged=await store.login('fixture-wss-password-only','fixture'),cookieValue=auth.cookieName+'='+logged.token;
    const page=pages.issue(logged.session.id),{connection}=pages.begin(page,logged.session.id);pages.complete(connection);
    const path='/ws/video?page='+page+'&connection='+connection.owner;
    ws=await connect(path,cookieValue,'https://evil.example');assert.equal((await once(ws,'close'))[0],1008);assert.equal(views,0);
    ws=await connect('/ws/video?page='+page+'&connection=stale',cookieValue);assert.equal((await once(ws,'close'))[0],1008);assert.equal(views,0);
    ws=await connect(path,cookieValue);assert.equal(String((await once(ws,'message'))[0]),'metadata-fixture');assert.equal(views,1);assert.equal(closes,1);
    const later=pages.issue(logged.session.id),next=pages.begin(later,logged.session.id);pages.complete(next.connection);
    assert.equal((await once(ws,'close'))[0],4001);
  }finally{for(const ws of sockets)ws.terminate();await app.close();await store.close();await rm(directory,{recursive:true,force:true});}
});
test('a page replaced during activation receives no video metadata',async()=>{
  const app=Fastify(),pages=new PageConnections();await app.register(websocket);let release!:()=>void,entered!:()=>void,views=0;
  const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r),page=pages.issue('session'),{connection}=pages.begin(page,'session');pages.complete(connection);
  installWssVideoRoute(app,p=>p,{session:()=>({owner:connection.owner,connection}),originAllowed:()=>true,pages,
    rtc:{close:async()=>{entered();await gate;}},video:{closeViewers:()=>{},view:async()=>{views++;}},serialize:work=>work()});
  const origin=await app.listen({host:'127.0.0.1',port:0}),ws=new WebSocket(origin.replace('http','ws')+'/ws/video');
  try{await ready;const closed=once(ws,'close');pages.disconnect(connection);release();await closed;assert.equal(views,0);}
  finally{release();ws.terminate();await app.close();}
});
