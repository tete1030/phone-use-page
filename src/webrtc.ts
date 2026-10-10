import { isIP } from 'node:net';
import { RTCPeerConnection, MediaStreamTrack, useH264, PictureLossIndication } from 'werift';
import type { ScrcpyMediaStreamPacket } from '@yume-chan/scrcpy';
import { annexBNalus,H264Packetizer } from './h264-rtp.js';
import { Video } from './video.js';
import { ConsoleError } from './types.js';
import {sdpCandidates,selectedIcePair} from './ice-diagnostics.js';
import {turnConfig,TurnCredentials} from './turn-credentials.js';
import {TurnFallback,type TurnProvider} from './turn-fallback.js';

export function rtcConfig(env:NodeJS.ProcessEnv){
  const min=Number(env.WEBRTC_PORT_MIN||50000),max=Number(env.WEBRTC_PORT_MAX||50031);
  if(!Number.isInteger(min)||!Number.isInteger(max)||min<1024||max>65535||max<=min||max-min>255)throw new Error('Invalid WEBRTC_PORT_MIN/MAX (2-256 UDP ports, 1024-65535)');
  const publicIp=env.WEBRTC_PUBLIC_IP;
  if(publicIp&&isIP(publicIp)!==4)throw new Error('WEBRTC_PUBLIC_IP must be an IPv4 address');
  const stunUrl=env.WEBRTC_STUN_URL??'stun:stun.cloudflare.com:3478';
  const match=/^stun:([A-Za-z0-9.-]+):(\d+)$/.exec(stunUrl);
  if(!match||Number(match[2])<1||Number(match[2])>65535)throw new Error('WEBRTC_STUN_URL must be a STUN hostname and UDP port; TURN is not enabled');
  const gatherMs=Number(env.WEBRTC_ICE_GATHER_MS||8000);
  if(!Number.isInteger(gatherMs)||gatherMs<3000||gatherMs>20000)throw new Error('WEBRTC_ICE_GATHER_MS must be 3000-20000');
  const turn=turnConfig(env),fallbackProvider=env.WEBRTC_TURN_FALLBACK;
  if(fallbackProvider&&(fallbackProvider!=='cloudflare'||turn.provider!=='coturn'||turn.mode!=='relay'))throw new Error('Cloudflare fallback requires primary coturn relay mode');
  const fallbackTurn=fallbackProvider?turnConfig({...env,WEBRTC_TURN_PROVIDER:'cloudflare'}):undefined;
  if(env.VIDEO_WSS_FALLBACK&&!['0','1'].includes(env.VIDEO_WSS_FALLBACK))throw new Error('VIDEO_WSS_FALLBACK must be 0 or 1');
  return {portRange:[min,max] as [number,number],publicIp,stunUrl,gatherMs,turn,fallbackTurn,wssFallback:env.VIDEO_WSS_FALLBACK==='1'};
}

export function advertisePublicAddress(sdp:string,ip:string){
  let index=0;
  return sdp.replace(/^a=candidate:(\S+) 1 udp (\d+) (\S+) (\d+) typ host[^\r\n]*/gmi,(line,_foundation,priority,_address,port)=>`${line}\r\na=candidate:public${index++} 1 udp ${priority} ${ip} ${port} typ host`);
}

export class WebRtcVideo {
  private active?:{owner:string;close:()=>Promise<void>;diagnostics:()=>Promise<unknown>;powerChanged:()=>void};
  private tail:Promise<unknown>=Promise.resolve();
  private credentials:TurnFallback;
  private paused=false;
  private pauseReason:string|null=null;
  constructor(private video:Video,readonly config=rtcConfig(process.env),primary=new TurnCredentials(config.turn,config.stunUrl),fallback?:TurnCredentials){this.credentials=new TurnFallback(primary,fallback);if(!!config.fallbackTurn!==!!fallback)throw new Error('TURN fallback broker configuration mismatch');}
  private get transports(){return [...this.credentials.providers,...(this.config.wssFallback?['wss' as const]:[])];}
  get browserConfig(){return {dynamic:true,gatherMs:this.config.gatherMs+4000,provider:this.config.turn.provider,availableProviders:this.transports};}
  setVideoPaused(paused:boolean,reason:string|null=null){this.video.setVideoPaused(paused,reason);const changed=this.paused!==paused;this.paused=paused;this.pauseReason=paused?reason:null;if(changed)this.active?.powerChanged();}
  async prepare(owner:string,signal:AbortSignal,provider?:TurnProvider){const requested=provider??this.config.turn.provider;if(!this.credentials.providers.includes(requested))throw new ConsoleError('TURN_PROVIDER_DISABLED','该中继服务未启用',400);this.video.closeViewers();if(requested!==this.credentials.provider(owner))await this.closeActive(owner);const prepared=await this.credentials.prepare(owner,signal,requested);return {...prepared,availableProviders:this.transports,renewAfterMs:prepared.expiresAt===null?null:Math.max(30000,prepared.expiresAt-Date.now()-300000),gatherMs:requested==='cloudflare'?Math.max(45000,this.config.gatherMs+4000):this.config.gatherMs+4000};}
  async diagnostics(owner:string){if(this.video.viewers.size)return {...this.video.wssDiagnostics(),availableProviders:this.transports};const active=this.active;if(!active||active.owner!==owner)return {state:'idle',stun:this.config.stunUrl,turn:this.config.turn.provider!=='none',mode:this.config.turn.mode,provider:this.credentials.provider(owner),availableProviders:this.transports,paused:this.paused,pauseReason:this.pauseReason};return active.diagnostics();}
  async close(owner?:string){this.credentials.release(owner);await this.closeActive(owner);}
  private async closeActive(owner?:string){const active=this.active;if(active&&(!owner||active.owner===owner)){this.active=undefined;await active.close();}}
  offer(owner:string,sdp:string,signal:AbortSignal,configId?:string){
    const work=this.tail.then(()=>this.negotiate(owner,sdp,signal,configId));this.tail=work.catch(()=>{});return work;
  }
  private async negotiate(owner:string,sdp:string,signal:AbortSignal,configId?:string){
    if(signal.aborted)throw new ConsoleError('PAGE_OFFLINE','页面已离线',409);
    if((sdp.match(/^m=/gm)||[]).length!==1||!/^m=video /m.test(sdp))throw new ConsoleError('INVALID_SDP','仅支持一个视频接收通道');
    const iceServers=this.credentials.server(owner,configId);
    const provider=this.credentials.provider(owner),tlsServerName=this.credentials.tlsServerName(owner);
    await this.closeActive();await this.video.start();
    if(signal.aborted)throw new ConsoleError('PAGE_OFFLINE','页面已离线',409);
    this.credentials.server(owner,configId);
    const pc=new RTCPeerConnection({codecs:{video:[useH264({parameters:'profile-level-id=42e029;packetization-mode=1;level-asymmetry-allowed=1'})]},iceServers,iceTransportPolicy:this.config.turn.mode,iceStunGatherTimeout:this.config.gatherMs/1000,iceTurnConnectTimeout:10,turnTlsOptions:{servername:tlsServerName,minVersion:'TLSv1.2',rejectUnauthorized:true},icePortRange:this.config.portRange,iceAdditionalHostAddresses:['127.0.0.1'],iceUseIpv6:false,iceUseTcp:false,bundlePolicy:'max-bundle'});
    const track=new MediaStreamTrack({kind:'video'}),transceiver=pc.addTransceiver(track,{direction:'sendonly'}),sender=transceiver.sender;
    const packetizer=new H264Packetizer(sender.ssrc);
    let closed=false,ready=false,awaitingKey=true,sending=false,queueBytes=0,lastReset=0,mediaGeneration=0,videoPayloadBytes=0,videoPacketsSent=0,closing:Promise<void>|undefined;
    let config:Buffer[]=this.video.configuration?annexBNalus(this.video.configuration):[];
    const queue:{nalus:Buffer[];pts:bigint;bytes:number}[]=[];
    const requestKey=()=>{if(closed||this.paused||Date.now()-lastReset<1000)return;lastReset=Date.now();void this.video.client?.controller?.resetVideo().catch(()=>{});};
    const send=async()=>{
      if(sending)return;sending=true;
      try{while(queue.length&&!closed&&ready&&!this.paused){const frame=queue.shift()!,generation=mediaGeneration;queueBytes-=frame.bytes;for(const packet of packetizer.packets(frame.nalus,frame.pts)){if(closed||signal.aborted||this.paused||generation!==mediaGeneration)break;await sender.sendRtp(packet);videoPayloadBytes+=packet.payload.length;videoPacketsSent++;}}}
      catch{void close();}finally{sending=false;}
    };
    const packet=(value:ScrcpyMediaStreamPacket)=>{
      if(closed||signal.aborted)return;
      try{
        if(value.type==='configuration'){config=annexBNalus(value.data);queue.length=0;queueBytes=0;awaitingKey=true;return;}
        if(!ready||this.paused)return;
        if(awaitingKey&&!value.keyframe)return;
        if(queue.length>=8||queueBytes+value.data.length>2_000_000){queue.length=0;queueBytes=0;awaitingKey=true;requestKey();return;}
        const nalus=annexBNalus(value.data);
        if(value.keyframe){nalus.unshift(...config);awaitingKey=false;}
        queue.push({nalus,pts:value.pts??0n,bytes:value.data.length});queueBytes+=value.data.length;void send();
      }catch{void close();}
    };
    const close=()=>{if(closing)return closing;closed=true;ready=false;clearTimeout(timeout);signal.removeEventListener('abort',aborted);this.video.off('packet',packet);this.video.off('status',status);queue.length=0;queueBytes=0;track.stop();closing=pc.close();return closing;};
    const aborted=()=>void close(),status=(error:unknown)=>{if(error)void close();};
    const timeout=setTimeout(()=>{if(!ready)void close();},45000);
    const powerChanged=()=>{mediaGeneration++;queue.length=0;queueBytes=0;awaitingKey=true;if(!this.paused&&ready){lastReset=0;requestKey();}};
    this.active={owner,close,powerChanged,diagnostics:async()=>({state:pc.connectionState,gathering:pc.iceGatheringState,stun:this.config.stunUrl,turn:this.config.turn.provider!=='none',mode:this.config.turn.mode,provider,availableProviders:this.transports,paused:this.paused,pauseReason:this.pauseReason,videoPayloadBytes,videoPacketsSent,localCandidates:sdpCandidates(pc.localDescription?.sdp||''),remoteCandidates:sdpCandidates(pc.remoteDescription?.sdp||''),selectedPair:selectedIcePair(await pc.getStats()),width:this.video.width,height:this.video.height})};signal.addEventListener('abort',aborted,{once:true});this.video.on('packet',packet);this.video.on('status',status);
    pc.connectionStateChange.subscribe(state=>{if(state==='connected'){clearTimeout(timeout);ready=true;awaitingKey=true;requestKey();}else if(state==='closed'||state==='failed')void close();});
    sender.onRtcp.subscribe(p=>{if('feedback' in p&&(p.feedback instanceof PictureLossIndication||p.feedback.count===4)){awaitingKey=true;requestKey();}});
    try{
      await pc.setRemoteDescription({type:'offer',sdp});
      const codec=sender.codec;
      if(!codec||codec.mimeType.toLowerCase()!=='video/h264')throw new ConsoleError('UNSUPPORTED_CODEC','浏览器未协商 H.264',400);
      let gatherTimer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([pc.setLocalDescription(await pc.createAnswer()),new Promise<never>((_,reject)=>{gatherTimer=setTimeout(()=>reject(new ConsoleError('ICE_TIMEOUT','视频网络协商超时',504)),25000);})]);}finally{clearTimeout(gatherTimer);}
      if(closed||signal.aborted)throw new ConsoleError('PAGE_OFFLINE','视频连接已取消',409);
      let answer=pc.localDescription!.sdp;
      if(this.config.publicIp&&this.config.turn.mode!=='relay'){
        // Preserve the bound UDP port when advertising the router's one-to-one NAT mapping.
        answer=advertisePublicAddress(answer,this.config.publicIp);
      }
      return {type:'answer' as const,sdp:answer,width:this.video.width,height:this.video.height};
    }catch(error){await close();throw error;}
  }
}
