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
test('late power status does not claim that freshly received video has paused',()=>{
  const result=videoFreshness({...frame,pauseReason:'power_unknown',lastFrameAt:1999});
  assert.equal(result.state,'uncertain');assert.match(result.title,/状态待确认/);
  assert.doesNotMatch(result.title,/画面已暂停/);assert.match(result.ageText,/刚收到/);
  assert.doesNotMatch(result.ageText,/0 秒/);
});
