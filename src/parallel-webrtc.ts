import {RTCPeerConnection,MediaStreamTrack,useH264,PictureLossIndication} from 'werift';
import type {WebSocket} from 'ws';
import type {ScrcpyMediaStreamPacket} from '@yume-chan/scrcpy';
import {Video} from './video.js';
import {rtcConfig,advertisePublicAddress} from './webrtc.js';
import {TurnCredentials} from './turn-credentials.js';
import {TurnFallback,type TurnProvider} from './turn-fallback.js';
import {ConsoleError} from './types.js';
import {annexBNalus,H264Packetizer} from './h264-rtp.js';
import {sdpCandidates,selectedIcePair} from './ice-diagnostics.js';

interface Attempt {owner:string;id:string;key:string;provider:TurnProvider|'wss';parent:AbortSignal;abort:AbortController;unlink:()=>void;close?:()=>Promise<void>;diagnostics?:()=>Promise<any>;activate?:()=>void;ws?:WebSocket}
export class ParallelWebRtcVideo {
  private attempts=new Map<string,Attempt>();private cancelled=new Map<string,number>();private selected=new Map<string,string>();
  private credentials:TurnFallback;private paused=false;private pauseReason:string|null=null;
  constructor(private video:Video,readonly config=rtcConfig(process.env),primary=new TurnCredentials(config.turn,config.stunUrl),fallback?:TurnCredentials){this.credentials=new TurnFallback(primary,fallback);}
  private key(owner:string,id:string){return owner+':'+id;}
  private get providers(){return [...(this.config.enabled?this.credentials.providers:[]),...(this.config.wssFallback?['wss' as const]:[])];}
  get browserConfig(){return {dynamic:true,parallel:true,provider:this.config.turn.provider,availableProviders:this.providers};}
  setVideoPaused(paused:boolean,reason:string|null=null){const changed=this.paused!==paused;this.paused=paused;this.pauseReason=paused?reason:null;this.video.setVideoPaused(paused,reason);if(changed)for(const a of this.attempts.values())a.activate?.();}
  private create(owner:string,id:string,provider:Attempt['provider'],parent:AbortSignal){
    const key=this.key(owner,id);if(parent.aborted)throw new ConsoleError('PAGE_OFFLINE','当前页面已离线',409);
    if(this.cancelled.has(key))throw new ConsoleError('ICE_CONFIG_EXPIRED','视频探测已取消',409);
    const existing=this.attempts.get(key);if(existing){if(existing.provider!==provider)throw new ConsoleError('INVALID_REQUEST','探测编号不能更换通道',400);return existing;}
    if([...this.attempts.values()].filter(a=>a.owner===owner).length>=6)throw new ConsoleError('VIDEO_LIMIT','视频探测过多',429);
    const abort=new AbortController(),unlink=()=>parent.removeEventListener('abort',cancel),cancel=()=>{void this.cancel(owner,id);};
    const a:Attempt={owner,id,key,provider,parent,abort,unlink};this.attempts.set(key,a);parent.addEventListener('abort',cancel,{once:true});return a;
  }
  async prepare(owner:string,signal:AbortSignal,provider?:TurnProvider,attemptId='legacy'){
    const chosen=provider??this.config.turn.provider;if(!this.config.enabled||!this.credentials.providers.includes(chosen))throw new ConsoleError('TURN_PROVIDER_DISABLED','通道未配置',400);
    const key=this.key(owner,attemptId),previous=this.attempts.get(key);if(previous&&previous.provider!==chosen&&attemptId==='legacy'){await this.cancel(owner,attemptId);this.cancelled.delete(key);}
    const a=this.create(owner,attemptId,chosen,signal);
    try{const prepared=await this.credentials.prepare(a.key,a.abort.signal,chosen);if(this.attempts.get(a.key)!==a)throw new Error('cancelled');
      return {...prepared,attemptId,parallel:true,availableProviders:this.providers,gatherMs:chosen==='cloudflare'?45000:this.config.gatherMs+4000,renewAfterMs:prepared.expiresAt===null?null:Math.max(30000,prepared.expiresAt-Date.now()-300000)};
    }catch(error){if(signal.aborted)throw new ConsoleError('PAGE_OFFLINE','当前页面已离线',409);if(a.abort.signal.aborted||this.attempts.get(a.key)!==a)throw new ConsoleError('ICE_CONFIG_EXPIRED','视频探测已取消',409);throw error;}
  }
  async cancel(owner:string,id:string){const key=this.key(owner,id);this.cancelled.set(key,Date.now());for(const [k,t]of this.cancelled)if(Date.now()-t>600000||this.cancelled.size>5000)this.cancelled.delete(k);
    const a=this.attempts.get(key);if(!a)return;this.attempts.delete(key);a.unlink();a.abort.abort();this.credentials.release(a.key);if(this.selected.get(owner)===id)this.selected.delete(owner);a.ws?.close();await a.close?.();}
  async close(owner?:string){await Promise.all([...this.attempts.values()].filter(a=>!owner||a.owner===owner).map(a=>this.cancel(a.owner,a.id)));}
  registerWss(owner:string,id:string,parent:AbortSignal,ws:WebSocket){if(!this.config.wssFallback)throw new ConsoleError('VIDEO_TRANSPORT_DISABLED','WSS 未启用',400);const a=this.create(owner,id,'wss',parent);a.ws=ws;ws.once('close',()=>{void this.cancel(owner,id);});}
  select(owner:string,id:string){const a=this.attempts.get(this.key(owner,id));if(!a)throw new ConsoleError('ICE_CONFIG_EXPIRED','视频探测已取消',409);
    if(this.selected.get(owner)!==id){this.selected.set(owner,id);for(const candidate of this.attempts.values())if(candidate.owner===owner)candidate.activate?.();}return {provider:a.provider,attemptId:id};}
  async diagnostics(owner:string){const a=this.attempts.get(this.key(owner,this.selected.get(owner)||''));
    const current=a?.provider==='wss'?this.video.wssDiagnostics():await a?.diagnostics?.();
    const attempts=await Promise.all([...this.attempts.values()].filter(x=>x.owner===owner).map(async x=>({attemptId:x.id,provider:x.provider,...(x.provider==='wss'?this.video.wssDiagnostics():await x.diagnostics?.()||{state:'preparing'})})));
    return {...(current||{state:'idle'}),attemptId:a?.id||null,provider:a?.provider||null,availableProviders:this.providers,paused:this.paused,pauseReason:this.pauseReason,attempts};
  }
  async offer(owner:string,sdp:string,signal:AbortSignal,configId?:string,attemptId='legacy'){
    const a=this.attempts.get(this.key(owner,attemptId));if(!a||a.provider==='wss')throw new ConsoleError('ICE_CONFIG_EXPIRED','视频配置已取消',409);
    if((sdp.match(/^m=/gm)||[]).length!==1||!/^m=video /m.test(sdp))throw new ConsoleError('INVALID_SDP','只接受单路视频',400);
    const servers=this.credentials.server(a.key,configId);if(a.close)throw new ConsoleError('VIDEO_CONFLICT','同一探测不能重复协商',409);
    await this.video.start();if(signal.aborted||a.abort.signal.aborted)throw new ConsoleError('ICE_CONFIG_EXPIRED','探测已取消',409);
    const pc=new RTCPeerConnection({codecs:{video:[useH264({parameters:'profile-level-id=42e029;packetization-mode=1;level-asymmetry-allowed=1'})]},iceServers:servers,iceTransportPolicy:this.config.turn.mode,
      iceStunGatherTimeout:this.config.gatherMs/1000,iceTurnConnectTimeout:10,turnTlsOptions:{servername:this.credentials.tlsServerName(a.key),minVersion:'TLSv1.2',rejectUnauthorized:true},
      icePortRange:this.config.portRange,iceUseIpv6:false,iceUseTcp:false,bundlePolicy:'max-bundle'});
    const track=new MediaStreamTrack({kind:'video'}),sender=pc.addTransceiver(track,{direction:'sendonly'}).sender,packetizer=new H264Packetizer(sender.ssrc);
    let ready=false,closed=false,sending=false,awaitingKey=true,bytes=0,lastReset=0,generation=0,payloadBytes=0,packets=0;
    let params=this.video.configuration?annexBNalus(this.video.configuration):[];
    const queue:{nalus:Buffer[];pts:bigint;bytes:number}[]=[];
    const requestKey=()=>{if(closed||this.paused||Date.now()-lastReset<500)return;lastReset=Date.now();void this.video.client?.controller?.resetVideo().catch(()=>{});};
    const send=async()=>{if(sending)return;sending=true;try{while(queue.length&&ready&&!closed&&!this.paused){const frame=queue.shift()!,epoch=generation;bytes-=frame.bytes;
      for(const packet of packetizer.packets(frame.nalus,frame.pts)){if(closed||this.paused||epoch!==generation)break;await sender.sendRtp(packet);payloadBytes+=packet.payload.length;packets++;}}}catch{void a.close?.();}finally{sending=false;}};
    const packet=(p:ScrcpyMediaStreamPacket)=>{if(closed)return;if(p.type==='configuration'){params=annexBNalus(p.data);queue.length=0;bytes=0;awaitingKey=true;return;}
      if(!ready||this.paused||awaitingKey&&!p.keyframe||this.selected.get(owner)!==attemptId&&!p.keyframe)return;
      if(queue.length>=8||bytes+p.data.length>2_000_000){queue.length=0;bytes=0;awaitingKey=true;requestKey();return;}
      const nalus=annexBNalus(p.data);if(p.keyframe){nalus.unshift(...params);awaitingKey=false;}queue.push({nalus,pts:p.pts??0n,bytes:p.data.length});bytes+=p.data.length;void send();};
    const timer=setTimeout(()=>{if(!ready)void a.close?.();},45000),aborted=()=>{void a.close?.();},status=(error:unknown)=>{if(error)void a.close?.();};
    a.close=async()=>{if(closed)return;closed=true;clearTimeout(timer);a.abort.signal.removeEventListener('abort',aborted);this.video.off('packet',packet);this.video.off('status',status);queue.length=0;track.stop();await pc.close();};
    a.activate=()=>{generation++;queue.length=0;bytes=0;awaitingKey=true;if(ready&&!this.paused){lastReset=0;requestKey();}};
    a.diagnostics=async()=>({state:pc.connectionState,gathering:pc.iceGatheringState,provider:a.provider,videoPayloadBytes:payloadBytes,videoPacketsSent:packets,localCandidates:sdpCandidates(pc.localDescription?.sdp||''),remoteCandidates:sdpCandidates(pc.remoteDescription?.sdp||''),selectedPair:selectedIcePair(await pc.getStats().catch(()=>new Map())),width:this.video.width,height:this.video.height});
    a.abort.signal.addEventListener('abort',aborted,{once:true});this.video.on('packet',packet);this.video.on('status',status);
    pc.connectionStateChange.subscribe(state=>{if(state==='connected'){ready=true;clearTimeout(timer);requestKey();}else if(state==='failed'||state==='closed')void a.close?.();});
    sender.onRtcp.subscribe(p=>{if('feedback' in p&&(p.feedback instanceof PictureLossIndication||p.feedback.count===4)){awaitingKey=true;requestKey();}});
    try{await pc.setRemoteDescription({type:'offer',sdp});if(sender.codec?.mimeType.toLowerCase()!=='video/h264')throw new ConsoleError('UNSUPPORTED_CODEC','需要H.264',400);
      await Promise.race([pc.setLocalDescription(await pc.createAnswer()),new Promise((_,reject)=>{const timeout=setTimeout(()=>reject(new Error('gather timeout')),25000);timeout.unref();})]);
      if(closed||a.abort.signal.aborted||this.attempts.get(a.key)!==a)throw new ConsoleError('ICE_CONFIG_EXPIRED','视频探测已取消',409);
      if(attemptId==='legacy')this.select(owner,attemptId);
      let answer=pc.localDescription!.sdp;if(this.config.publicIp&&this.config.turn.mode!=='relay')answer=advertisePublicAddress(answer,this.config.publicIp);
      return {type:'answer' as const,sdp:answer,width:this.video.width,height:this.video.height};
    }catch(error){await a.close();if(signal.aborted)throw new ConsoleError('PAGE_OFFLINE','页面已离线',409);if(a.abort.signal.aborted)throw new ConsoleError('ICE_CONFIG_EXPIRED','视频探测已取消',409);throw error;}
  }
}
