import {test} from 'node:test';
import assert from 'node:assert/strict';
import {videoFreshness} from '../src/video-freshness.js';

const frame={online:true,connecting:false,pauseReason:null,active:true,lastFrameAt:1000,requiredAfter:0,now:2000};
test('pause and offline remain explicit even if a frame just arrived',()=>{
  assert.equal(videoFreshness({...frame,pauseReason:'locked'}).state,'paused');
  assert.match(videoFreshness({...frame,pauseReason:'screen_off'}).detail,/灭屏/);
  assert.equal(videoFreshness({...frame,online:false}).state,'offline');
});
test('resuming cannot describe a pre-pause frame as current',()=>{
  assert.equal(videoFreshness({...frame,requiredAfter:1500}).state,'waiting');
  assert.equal(videoFreshness({...frame,lastFrameAt:1800,requiredAfter:1500}).state,'current');
  assert.equal(videoFreshness({...frame,lastFrameAt:null}).lastFrameAgeMs,null);
});
test('a still screen is unconfirmed rather than declared offline',()=>{
  const stale=videoFreshness({...frame,now:10000});assert.equal(stale.state,'unconfirmed');
  assert.match(stale.detail,/静止/);assert.equal(stale.lastFrameAgeMs,9000);
});
