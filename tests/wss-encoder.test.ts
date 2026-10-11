import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import type {ScrcpyMediaStreamPacket} from '@yume-chan/scrcpy';
import {WssEncoder,wssProfiles,wssEncodingArgs,type WssProfile} from '../src/wss-encoder.js';

test('local RTP loss suppresses predictive frames until a complete keyframe, including sequence wrap',async()=>{
  const packets:ScrcpyMediaStreamPacket[]=[],encoder=new WssEncoder(()=>{},resolve('tests/fake_wss_encoder.py'));
  let timer:ReturnType<typeof setTimeout>|undefined;
  const ready=new Promise<void>((done,reject)=>{timer=setTimeout(()=>reject(Error('RTP fixture timed out')),4000);encoder.on('failure',reject);encoder.on('packet',p=>{packets.push(p);if(packets.filter(p=>p.type==='data').length===4)done();});});
  try{encoder.start();await ready;assert.deepEqual(packets.filter(p=>p.type==='data').map(p=>p.type==='data'&&p.keyframe),[true,false,true,false]);assert.equal(packets.filter(p=>p.type==='configuration').length,2);assert.equal(encoder.snapshot().droppedRtpFrames,1);assert.equal(encoder.snapshot().waitingForOutputKeyframe,false);assert.ok(encoder.snapshot().receiveBufferBytes!>0);}
  finally{clearTimeout(timer);encoder.stop();}
});

test('rate-control FPS matches every output profile and full keyframes have room to retain text',()=>{
  for(const profile of Object.keys(wssProfiles) as WssProfile[]){const p=wssProfiles[profile],args=wssEncodingArgs(profile,12345),value=(flag:string)=>args[args.indexOf(flag)+1];
    assert.equal(value('-x264-params'),`aud=1:repeat-headers=1:fps=${p.fps}/1`);assert.equal(value('-fps_mode'),'vfr');assert.equal(args.includes('-r'),false);
    assert.equal(Number(value('-g'))/p.fps,profile==='low'?3:2);assert.equal(Number(value('-bufsize'))/p.bitRate,2);assert.equal(value('-maxrate'),String(p.bitRate));assert.equal(value('-bf'),'0');assert.equal(args.includes('-s'),false);
    const encoder=new WssEncoder(()=>{});encoder.profile=profile;assert.equal(encoder.snapshot().keyframeIntervalSeconds,p.keyframeIntervalSeconds);assert.equal(encoder.snapshot().bufferBits,p.bitRate*2);
  }
});

test('WSS quality reduces fps before sacrificing per-frame text bitrate or resolution',()=>{
  assert.ok(wssProfiles.low.fps<wssProfiles.balanced.fps);assert.ok(wssProfiles.low.bitRate<wssProfiles.balanced.bitRate);
  assert.ok(wssProfiles.low.bitRate/wssProfiles.low.fps>=wssProfiles.balanced.bitRate/wssProfiles.balanced.fps);
  assert.equal(wssProfiles.low.crf,wssProfiles.balanced.crf);
});
test('sustained congestion downgrades and sustained recovery upgrades with hysteresis',()=>{
  let now=100000;const encoder=new WssEncoder(()=>{},'unused',()=>now);encoder.start=()=>{};encoder.stop=()=>{};
  encoder.feedback(900,120000);encoder.feedback(900,120000);assert.equal(encoder.profile,'balanced');encoder.feedback(900,120000);assert.equal(encoder.profile,'low');
  for(let i=0;i<10;i++)encoder.feedback(100,0);assert.equal(encoder.profile,'low');now+=11000;encoder.feedback(100,0);assert.equal(encoder.profile,'balanced');
  now+=11000;for(let i=0;i<10;i++)encoder.feedback(100,0);assert.equal(encoder.profile,'high');assert.equal(encoder.snapshot().resolution,'preserved');
});
test('invalid feedback cannot change the encoding profile',()=>{
  const encoder=new WssEncoder(()=>{});for(const delay of [NaN,-100,Infinity,20000])for(let i=0;i<20;i++)encoder.feedback(delay,1000000);assert.equal(encoder.profile,'balanced');encoder.stop();
});
