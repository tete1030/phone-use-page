import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {AuthStore} from '../src/auth.js';
import {installAuth} from '../src/auth-http.js';
import {PageConnections} from '../src/page-connections.js';
import {ConsoleError} from '../src/types.js';
import {installClientVideoLog} from '../src/client-video-log.js';
import {diagnosticError} from '../src/wss-diagnostics.js';

const payload={provider:'wss',stage:'decode',code:'WSS_DECODE_FAILED',error:{name:'NotSupportedError',message:'Unsupported codec avc1.420028'},
  attemptId:randomUUID(),assetVersion:'0123456789abcdef',elapsedMs:20,socketState:1,closeCode:null,width:864,height:1920,codec:0x68323634,avcCodec:'avc1.420028',
  bytesReceived:100,packetsReceived:2,drawnFrames:0,queuedBytes:0,lastPacket:{kind:1,bytes:80},
  capabilities:{secureContext:true,videoDecoder:true,createImageBitmap:true,bitmapRenderer:true}};

async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'phone-video-log-')),store=new AuthStore({password:'fixture-video-log-password',directory});await store.init();
  const app=Fastify(),pages=new PageConnections(),lines:string[]=[];let now=1000;
  await app.register(cookie);const auth=installAuth(app,store,{secure:false,basePath:'/phone/'});
  app.addHook('onRequest',async req=>{if(req.method==='POST'&&req.headers.origin!=='http://localhost')throw new ConsoleError('ORIGIN_REJECTED','Origin rejected',403);});
  app.setErrorHandler((error:any,req,reply)=>reply.code(error instanceof ConsoleError?error.status:error.code==='FST_ERR_CTP_BODY_TOO_LARGE'?413:500).send({error:{code:error.code}}));
  installClientVideoLog(app,p=>'/phone'+p,{write:line=>lines.push(line),now:()=>now,
    session:req=>{const s=auth.authenticate(req,true),c=pages.require(req.headers['x-console-page'],s.id,req.headers['x-console-connection'],true);pages.requireGeneration(c,Number(req.headers['x-console-generation']));return {owner:c.owner};}});
  const logged=await store.login('fixture-video-log-password','fixture'),page=pages.issue(logged.session.id),{connection}=pages.begin(page,logged.session.id);pages.complete(connection);
  const headers={origin:'http://localhost',cookie:auth.cookieName+'='+logged.token,'x-console-csrf':logged.session.csrf,'x-console-page':page,
    'x-console-connection':connection.owner,'x-console-generation':'0','user-agent':'FixtureBrowser/1'};
  const post=(data:unknown=payload,overrides:Record<string,string>={})=>app.inject({method:'POST',url:'/phone/api/video/client-error',headers:{...headers,...overrides,'content-type':'application/json'},payload:JSON.stringify(data)});
  return {app,pages,connection,store,lines,headers,post,setNow:(v:number)=>now=v,close:async()=>{await app.close();await store.close();await rm(directory,{recursive:true,force:true});}};
}

test('authenticated reports produce one structured log with codec, error, counters and browser identity',async()=>{
  const f=await fixture();try{
    const lastActivity=f.connection.lastActivity;
    assert.deepEqual((await f.post()).json(),{ok:true,logged:true});assert.equal(f.lines.length,1);
    const entry=JSON.parse(f.lines[0]!);assert.equal(entry.event,'wss_client_error');assert.equal(entry.level,'warn');assert.equal(entry.client,'FixtureBrowser/1');
    assert.equal(entry.avcCodec,'avc1.420028');assert.equal(entry.error.name,'NotSupportedError');assert.equal(entry.packetsReceived,2);assert.match(entry.clientId,/^[a-f0-9]{12}$/);
    for(const secret of [f.connection.owner,f.headers.cookie,f.headers['x-console-csrf']])assert.ok(!f.lines[0]!.includes(secret));
    assert.equal(f.connection.lastActivity,lastActivity);
  }finally{await f.close();}
});
test('AVC recovery diagnostics contain structure and counters without accepting frame payloads',async()=>{
  const f=await fixture();try{
    const report={...payload,code:'WSS_KEYFRAME_RECOVERY',lastPacket:{kind:1,bytes:42000,keyframe:true,nalTypes:[9,7,8,6,5]},decoder:{format:'avc',waitingForKey:true,recoveries:1,skippedFrames:2}};
    assert.equal((await f.post(report)).statusCode,200);const entry=JSON.parse(f.lines[0]!);
    assert.deepEqual(entry.decoder,report.decoder);assert.deepEqual(entry.lastPacket.nalTypes,[9,7,8,6,5]);
    assert.equal((await f.post({...report,lastPacket:{...report.lastPacket,data:'raw frame'}})).statusCode,400);
  }finally{await f.close();}
});
test('anonymous, foreign-Origin, missing CSRF and stale-page reports never reach the log',async()=>{
  const f=await fixture();try{
    for(const [headers,status]of [[{cookie:''},401],[{origin:'https://evil.example'},403],[{'x-console-csrf':''},403],[{'x-console-connection':randomUUID()},409],[{'x-console-generation':'9'},409]] as const){
      assert.equal((await f.post(payload,headers)).statusCode,status);
    }
    assert.equal(f.lines.length,0);
  }finally{await f.close();}
});
test('recovering original pages can report without reclaiming control or renewing inactivity',async()=>{
  const f=await fixture();try{f.pages.suspend(f.connection);const lastActivity=f.connection.lastActivity;
    assert.equal((await f.post(payload,{'x-console-generation':String(f.connection.generation)})).statusCode,200);assert.equal(f.connection.lastActivity,lastActivity);assert.notEqual(f.connection.recoveringSince,null);
  }finally{await f.close();}
});
test('unknown fields, nonfinite/negative counters and oversized bodies are rejected before logging',async()=>{
  const f=await fixture();try{
    for(const data of [{...payload,frames:'raw bytes'},{...payload,queuedBytes:-1},{...payload,bytesReceived:Infinity},{...payload,error:{name:'Error',message:'x'.repeat(385)}}])assert.equal((await f.post(data)).statusCode,400);
    assert.equal((await f.post({...payload,extra:'x'.repeat(9000)})).statusCode,413);assert.equal(f.lines.length,0);
  }finally{await f.close();}
});
test('per-page rate limiting is bounded, resets and does not depend on attempt IDs',async()=>{
  const f=await fixture();try{
    for(let i=0;i<10;i++)assert.equal((await f.post({...payload,attemptId:randomUUID()})).json().logged,true);
    assert.equal((await f.post()).json().logged,false);assert.equal(f.lines.length,10);
    f.setNow(61000);assert.equal((await f.post()).json().logged,true);assert.equal(f.lines.length,11);
  }finally{await f.close();}
});
test('both error serialization and backend printing suppress URL tokens, secrets and line injection',async()=>{
  const message='failure wss://host.example/ws/video?connection=private-url password=private-pass {"token":"private-token"}\nnext';
  const error=diagnosticError(new DOMException(message,'NotSupportedError'));
  assert.equal(error.name,'NotSupportedError');for(const secret of ['private-url','private-pass','private-token'])assert.ok(!error.message.includes(secret));assert.ok(!error.message.includes('\n'));
  const headerError=diagnosticError(new Error('Cookie: a=private-first; b=private-second\nAuthorization: Bearer private-auth'));
  for(const secret of ['private-first','private-second','private-auth'])assert.ok(!headerError.message.includes(secret));
  const f=await fixture();try{
    assert.equal((await f.post({...payload,error:{name:'Error',message}})).statusCode,200);
    for(const secret of ['private-url','private-pass','private-token'])assert.ok(!f.lines[0]!.includes(secret));assert.equal(f.lines[0]!.split('\n').length,1);
  }finally{await f.close();}
});
