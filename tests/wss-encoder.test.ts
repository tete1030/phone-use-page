import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WssEncoder,wssProfiles} from '../src/wss-encoder.js';

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
