import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VideoPresentationHealth} from '../src/webrtc-renderer.js';

const state = {paused:false,hidden:false,now:1000,lastFrameAt:1000,requiredAfter:0,decoded:10};
test('sustained decoded progress without presentation triggers recovery',()=>{
  const health=new VideoPresentationHealth();
  assert.equal(health.check(state),false);
  assert.equal(health.check({...state,now:2000,decoded:20}),false);
  assert.equal(health.check({...state,now:9999,decoded:30}),false);
  assert.equal(health.check({...state,now:10000,decoded:40}),true);
});
test('a long still screen and the first new decoded frame do not cause an immediate failure',()=>{
  const health=new VideoPresentationHealth();health.check(state);
  assert.equal(health.check({...state,now:60000}),false);
  assert.equal(health.check({...state,now:61000,decoded:20}),false);
  assert.equal(health.check({...state,now:62000,decoded:30,lastFrameAt:61500}),false);
});
test('pausing or hiding clears stalled progress and resumption gets a new grace period',()=>{
  for(const status of [{paused:true},{hidden:true}]){
    const health=new VideoPresentationHealth();health.check(state);
    health.check({...state,now:2000,decoded:20});
    assert.equal(health.check({...state,now:10000,decoded:30,...status}),false);
    assert.equal(health.check({...state,now:20000,requiredAfter:19900,decoded:40}),false);
    assert.equal(health.check({...state,now:28000,requiredAfter:19900,decoded:50}),true);
  }
});
test('missing/reset decode counts and streams without a first frame are not presentation stalls',()=>{
  const health=new VideoPresentationHealth();health.check(state);health.check({...state,now:2000,decoded:20});
  assert.equal(health.check({...state,now:10000,decoded:null}),false);
  assert.equal(health.check({...state,now:11000,decoded:30}),false);
  assert.equal(health.check({...state,now:20000,decoded:0}),false);
  assert.equal(health.check({...state,now:30000,decoded:40,lastFrameAt:null}),false);
});
