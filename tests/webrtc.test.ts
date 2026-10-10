import {test} from 'node:test';
import assert from 'node:assert/strict';
import {annexBNalus,H264Packetizer} from '../src/h264-rtp.js';
import {advertisePublicAddress,rtcConfig,WebRtcVideo} from '../src/webrtc.js';
import {Video} from '../src/video.js';
import {sdpCandidates,selectedIcePair,iceCandidateFailure} from '../src/ice-diagnostics.js';

test('Annex B accepts mixed three/four-byte boundaries and preserves SPS/PPS/IDR',()=>{
  assert.deepEqual(annexBNalus(Buffer.from([0,0,0,1,0x67,1,2,0,0,1,0x68,3,0,0,0,1,0x65,4])).map(n=>[...n]),[[0x67,1,2],[0x68,3],[0x65,4]]);
  assert.throws(()=>annexBNalus(Buffer.from([1,2,3])),/Annex B/);
});
test('FU-A fragmentation reconstructs a large IDR byte-for-byte within the MTU',()=>{
  const nal=Buffer.alloc(10000,0xff);nal[0]=0x65;
  const packets=new H264Packetizer(123).packets([Buffer.from([0x67,1]),Buffer.from([0x68,2]),nal],5000000n);
  assert.ok(packets.every(p=>p.payload.length<=1100&&p.header.ssrc===123));
  assert.ok(packets.slice(0,-1).every(p=>!p.header.marker));assert.ok(packets.at(-1)!.header.marker);
  assert.ok(packets.every(p=>p.header.timestamp===packets[0]!.header.timestamp));
  const fragments=packets.slice(2);assert.equal(fragments[0]!.payload[1]!&0x80,0x80);assert.equal(fragments.at(-1)!.payload[1]!&0x40,0x40);
  const rebuilt=Buffer.concat([Buffer.from([(fragments[0]!.payload[0]!&0xe0)|(fragments[0]!.payload[1]!&0x1f)]),...fragments.map(p=>p.payload.subarray(2))]);
  assert.deepEqual(rebuilt,nal);for(let i=1;i<packets.length;i++)assert.equal((packets[i]!.header.sequenceNumber-packets[i-1]!.header.sequenceNumber)&0xffff,1);
});
test('RTP timestamps convert scrcpy microseconds to 90 kHz and wrap at 32 bits',()=>{
  const p=new H264Packetizer(1),a=p.packets([Buffer.from([0x61,1])],1000n)[0]!,b=p.packets([Buffer.from([0x61,2])],1001000n)[0]!;
  assert.equal((b.header.timestamp-a.header.timestamp)>>>0,90000);
  const c=p.packets([Buffer.from([0x61,3])],1000n+0x100000000n*1000n)[0]!;assert.equal(c.header.timestamp,a.header.timestamp);
});
test('media configuration rejects invalid ranges and non-IP advertised addresses',()=>{
  assert.deepEqual(rtcConfig({}).portRange,[50000,50031]);
  for(const env of [{WEBRTC_PORT_MIN:'80'},{WEBRTC_PORT_MIN:'50000',WEBRTC_PORT_MAX:'50000'},{WEBRTC_PORT_MAX:'65536'},{WEBRTC_PUBLIC_IP:'example.org'}])assert.throws(()=>rtcConfig(env));
});
test('public ICE address preserves every bound UDP port and existing SDP',()=>{
  const sdp='m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=candidate:abc 1 udp 123 192.168.1.1 50002 typ host\r\na=end-of-candidates\r\n';
  const result=advertisePublicAddress(sdp,'203.0.113.5');assert.ok(result.includes('a=candidate:public0 1 udp 123 203.0.113.5 50002 typ host\r\n'));assert.ok(result.startsWith('m=video'));assert.ok(result.endsWith('a=end-of-candidates\r\n'));
});
test('revoked and non-video offers cannot open the device or a media socket',async()=>{
  const v=new Video('not-a-device');let started=false;v.start=async()=>{started=true;};const rtc=new WebRtcVideo(v),abort=new AbortController();abort.abort();
  await assert.rejects(rtc.offer('old','',abort.signal),/离线/);await assert.rejects(rtc.offer('new','m=audio 9\r\n',new AbortController().signal),/视频/);assert.equal(started,false);await rtc.close();
});

test('STUN configuration stays discovery-only and validates endpoints/timeouts',()=>{const c=rtcConfig({});assert.equal(c.stunUrl,'stun:stun.cloudflare.com:3478');assert.equal(c.gatherMs,8000);for(const env of [{WEBRTC_STUN_URL:'turn:example.com:3478'},{WEBRTC_STUN_URL:'stun:x:70000'},{WEBRTC_STUN_URL:'https://example.com'},{WEBRTC_ICE_GATHER_MS:'1'}])assert.throws(()=>rtcConfig(env));});

test('ICE diagnostics select the nominated transport path without exposing SDP secrets',()=>{const sdp='a=ice-pwd:secret-do-not-expose\r\na=candidate:a 1 udp 100 203.0.113.5 51000 typ srflx raddr 192.168.1.2 rport 50000\r\n';assert.deepEqual(sdpCandidates(sdp),[{type:'srflx',protocol:'udp',address:'203.0.113.5',port:51000}]);const stats=new Map([['transport',{type:'transport',selectedCandidatePairId:'pair'}],['pair',{type:'candidate-pair',state:'succeeded',localCandidateId:'local',remoteCandidateId:'remote',currentRoundTripTime:.05}],['local',{candidateType:'srflx',protocol:'udp',address:'203.0.113.5',port:51000,usernameFragment:'secret'}],['remote',{candidateType:'prflx',protocol:'udp',address:'198.51.100.2',port:42000}]]);const result=selectedIcePair(stats)!;assert.equal(result.roundTripMs,50);assert.equal(result.local?.type,'srflx');assert.ok(!JSON.stringify(result).includes('secret'));});

test('ICE failure diagnostics preserve endpoint/code but remove reflected credentials',()=>{
  const server={urls:'turns:home.example.com:8443?transport=tcp',username:'fixture-user',credential:'fixture-password/+='};
  const result=iceCandidateFailure({url:server.urls,errorCode:701,errorText:`Connection failed for ${server.username}, ${server.credential}`,address:'203.0.113.1',port:12345,target:{password:'hidden'}},[server]);
  assert.equal(result.url,server.urls);assert.equal(result.errorCode,701);assert.equal(result.address,'203.0.113.1');assert.equal(result.port,12345);
  assert.equal(JSON.stringify(result).includes(server.username),false);assert.equal(JSON.stringify(result).includes(server.credential),false);assert.equal(JSON.stringify(result).includes('hidden'),false);
});
test('ICE failure diagnostics bound text and suppress unexpected credential-bearing URLs',()=>{
  const result=iceCandidateFailure({url:'turns:secret@evil.example:443',errorCode:'701',errorText:'x'.repeat(1000),address:null,port:99999},[{urls:'turns:home.example.com:8443?transport=tcp'}]);
  assert.equal(result.url,'');assert.equal(result.errorCode,0);assert.equal(result.errorText.length,320);assert.equal(result.port,null);
});
