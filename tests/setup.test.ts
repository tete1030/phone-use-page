import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rtcConfig} from '../src/webrtc.js';
import {TurnCredentials,loadTurnKey} from '../src/turn-credentials.js';
import {ParallelWebRtcVideo} from '../src/parallel-webrtc.js';
import {Video,videoEncodingConfig} from '../src/video.js';
import {selectAndroidDevice} from '../src/device-selection.js';

test('WSS-only ignores inactive relay configuration and cannot create RTC attempts',async()=>{
  const config=rtcConfig({WEBRTC_ENABLED:'0',VIDEO_WSS_FALLBACK:'1',WEBRTC_TURN_PROVIDER:'cloudflare',CF_TURN_KEY_FILE:'/missing/private/key',WEBRTC_TURN_FALLBACK:'cloudflare',WEBRTC_STUN_URL:'unreachable',WEBRTC_PORT_MIN:'bad'});
  assert.equal(config.stunUrl,'');assert.equal(config.fallbackTurn,undefined);
  assert.equal(await loadTurnKey(config.turn),undefined);
  const video=new Video('fixture');video.start=async()=>assert.fail('must not open device for disabled RTC');
  const broker=new TurnCredentials(config.turn,config.stunUrl,undefined,async()=>assert.fail('no credential network calls'));
  const rtc=new ParallelWebRtcVideo(video,config,broker);
  try{
    assert.deepEqual(rtc.browserConfig.availableProviders,['wss']);
    for(const provider of ['none','coturn','cloudflare'] as const)await assert.rejects(rtc.prepare('owner',new AbortController().signal,provider),/未配置/);
    assert.equal((await rtc.diagnostics('owner')).attempts.length,0);
  }finally{await rtc.close();}
});
test('media matrix exposes only enabled channels and rejects an empty or invalid configuration',()=>{
  const coturn={WEBRTC_TURN_PROVIDER:'coturn',COTURN_KEY_FILE:'fixture',COTURN_URL:'turns:turn.example.com:5349?transport=tcp'};
  const cloudflare={WEBRTC_TURN_PROVIDER:'cloudflare',CF_TURN_KEY_FILE:'fixture'};
  for(const [env,expected]of [
    [{},['none']],
    [{VIDEO_WSS_FALLBACK:'1'},['none','wss']],
    [coturn,['coturn']],
    [cloudflare,['cloudflare']],
    [{...coturn,VIDEO_WSS_FALLBACK:'1'},['coturn','wss']],
    [{...cloudflare,VIDEO_WSS_FALLBACK:'1'},['cloudflare','wss']],
    [{...coturn,WEBRTC_TURN_FALLBACK:'cloudflare',CF_TURN_KEY_FILE:'fixture'},['coturn','cloudflare']],
    [{...coturn,WEBRTC_TURN_FALLBACK:'cloudflare',CF_TURN_KEY_FILE:'fixture',VIDEO_WSS_FALLBACK:'1'},['coturn','cloudflare','wss']],
  ] as [NodeJS.ProcessEnv,string[]][]){
    const config=rtcConfig(env),key=config.turn.provider==='coturn'?{secret:'a'.repeat(64)}:config.turn.provider==='cloudflare'?{keyId:'b'.repeat(32),apiToken:'c'.repeat(64)}:undefined;
    const rtc=new ParallelWebRtcVideo(new Video('fixture'),config,new TurnCredentials(config.turn,config.stunUrl,key),config.fallbackTurn?new TurnCredentials(config.fallbackTurn,config.stunUrl,{keyId:'b'.repeat(32),apiToken:'c'.repeat(64)}):undefined);
    assert.deepEqual(rtc.browserConfig.availableProviders,expected);
    if(!config.wssFallback)assert.throws(()=>rtc.registerWss('owner','fixture',new AbortController().signal,{} as any),/未启用/);
  }
  for(const env of [{WEBRTC_ENABLED:'0'},{WEBRTC_ENABLED:'false'},{VIDEO_WSS_FALLBACK:'yes'}])assert.throws(()=>rtcConfig(env));
});
test('empty STUN supports offline LAN WebRTC without an external discovery service',async()=>{
  const config=rtcConfig({WEBRTC_STUN_URL:''}),broker=new TurnCredentials(config.turn,config.stunUrl,undefined,async()=>assert.fail('must not fetch'));
  assert.deepEqual((await broker.prepare('owner',new AbortController().signal)).iceServers,[]);
  assert.deepEqual(broker.server('owner',undefined),[]);
});
test('device selection handles USB, wireless, offline and multiple devices without a bundled identity',()=>{
  assert.equal(selectAndroidDevice('List of devices attached\nUSB_FIXTURE\tdevice\n'),'USB_FIXTURE');
  assert.equal(selectAndroidDevice('wifi.example.test:5555\tdevice\n'),'wifi.example.test:5555');
  assert.equal(selectAndroidDevice('other\toffline\nselected\tdevice\n'),'selected');
  assert.equal(selectAndroidDevice('fixture\tunauthorized\n'),'fixture');
  assert.equal(selectAndroidDevice('', 'explicit-fixture'),'explicit-fixture');
  for(const list of ['', 'one\tdevice\ntwo\tdevice\n', 'one\toffline\ntwo\tunauthorized\n'])assert.throws(()=>selectAndroidDevice(list));
  assert.throws(()=>selectAndroidDevice('', 'two devices'));
});
test('encoding settings are configurable and reject unsafe ranges before encoder use',()=>{
  assert.deepEqual(videoEncodingConfig({VIDEO_MAX_SIZE:'1280',VIDEO_MAX_FPS:'12',VIDEO_BIT_RATE:'1200000'}),{maxSize:1280,maxFps:12,videoBitRate:1200000});
  assert.equal(videoEncodingConfig({VIDEO_MAX_SIZE:'0'}).maxSize,0);
  for(const env of [{VIDEO_MAX_SIZE:'-1'},{VIDEO_MAX_FPS:'0'},{VIDEO_MAX_FPS:'61'},{VIDEO_BIT_RATE:'NaN'},{VIDEO_BIT_RATE:'100'}])assert.throws(()=>videoEncodingConfig(env));
});
