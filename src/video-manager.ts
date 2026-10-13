import {VideoRace,type VideoTransport,type VideoMode,type RaceSlot,type RaceHandle} from './video-race.js';
import {connectWssPlayer} from './wss-player.js';
import {sdpCandidates,selectedIcePair,iceCandidateFailure} from './ice-diagnostics.js';
import {createWebRtcRenderer,VideoPresentationHealth} from './webrtc-renderer.js';

export interface VideoHandle extends RaceHandle {surface:HTMLVideoElement|HTMLCanvasElement;size:()=>{width:number;height:number}}
export function createVideoManager(options:{providers:VideoTransport[];container:HTMLElement;paused:()=>boolean;
  request:(path:string,body?:any)=>Promise<any>;url:(path:string,id:string)=>string;
  selected:(slot:RaceSlot<VideoHandle>|undefined)=>void;frame:(slot:RaceSlot<VideoHandle>)=>void;changed:()=>void}){
  const history:any[]=[];let race:VideoRace<VideoHandle>;
  const factory=(slot:RaceSlot<VideoHandle>,events:{ready:()=>void;failed:(reason:string)=>void}):VideoHandle=>{
    const provider=slot.provider;
    let closed=false,notified=false,connected=false,width=0,height=0,painted=0,lastFrameAt:number|null=null,pc:RTCPeerConnection|null=null,wss:ReturnType<typeof connectWssPlayer>|null=null;
    let snapshot:any={state:'connecting',gathering:'not-started',framesRendered:0},servers:any[]=[],gatherMs=provider==='cloudflare'?45000:12000;
    const errors:any[]=[],start=Date.now(),timers=new Set<ReturnType<typeof setTimeout>>();let frameTimer:ReturnType<typeof setTimeout>|undefined;
    let wasPaused=options.paused(),requiredAfter=performance.now();const presentationHealth=new VideoPresentationHealth();
    const delay=(fn:()=>void,ms:number)=>{const t=setTimeout(()=>{timers.delete(t);fn();},ms);timers.add(t);return t;};
    const record=(result:string,reason:string)=>{history.push({attemptId:slot.id,provider,result,reason,elapsedMs:Date.now()-start,startedAt:new Date(start).toISOString(),gathering:snapshot.gathering,gatherLimitMs:gatherMs,gatherTimedOut:!!snapshot.gatherTimedOut,iceErrors:[...errors],localCandidates:sdpCandidates(pc?.localDescription?.sdp||'')});if(history.length>24)history.shift();};
    const fail=(reason:string)=>{if(closed)return;record('failed',reason);events.failed(reason);};
    const paintedFrame=()=>{if(closed)return;painted++;lastFrameAt=performance.now();snapshot.framesRendered=painted;if(frameTimer){clearTimeout(frameTimer);timers.delete(frameTimer);frameTimer=undefined;}
      if(!notified){notified=true;record('ready','实际视频帧已就绪');events.ready();}options.frame(slot);};
    const renderer=provider==='wss'?null:createWebRtcRenderer({onFrame:(w,h)=>{width=w;height=h;paintedFrame();},onFailure:fail});
    const surface=renderer?.surface||document.createElement('canvas');
    surface.className='video-candidate';surface.dataset.provider=provider;surface.setAttribute('aria-hidden','true');options.container.append(surface);
    const pauseChanged=()=>{if(closed)return;const paused=options.paused();if(paused){if(frameTimer){clearTimeout(frameTimer);timers.delete(frameTimer);frameTimer=undefined;}if(connected&&!notified){notified=true;record('ready','设备暂停，连接已就绪');events.ready();}}
      else {if(wasPaused){requiredAfter=performance.now();renderer?.resume();}if(connected&&(lastFrameAt===null||lastFrameAt<requiredAfter)&&!frameTimer&&!document.hidden)frameTimer=delay(()=>{frameTimer=undefined;if(!options.paused()&&!document.hidden)fail('连接已建立但画面未恢复');},30000);}wasPaused=paused;};
    const visible=()=>{if(closed)return;if(document.hidden){if(frameTimer){clearTimeout(frameTimer);timers.delete(frameTimer);frameTimer=undefined;}}else{requiredAfter=performance.now();pauseChanged();}};
    document.addEventListener('visibilitychange',visible);
    const connectDeadline=delay(()=>fail('连接建立超时'),provider==='cloudflare'?120000:60000);
    const onConnected=()=>{if(closed)return;connected=true;snapshot.state='connected';clearTimeout(connectDeadline);timers.delete(connectDeadline);pauseChanged();options.changed();};
    const handle:VideoHandle={get surface(){return renderer?.surface||surface;},pauseChanged,size:()=>({width,height}),snapshot:()=>({...snapshot,...(renderer?.snapshot()||{renderer:'webcodecs-bitmap-canvas'}),attemptId:slot.id,width,height,framesRendered:painted,lastFrameAt,paused:options.paused(),media:wss?{...wss.snapshot(),framesRendered:painted,codec:'video/H264'}:snapshot.media,iceErrors:[...errors]}),
      close:()=>{if(closed)return;closed=true;document.removeEventListener('visibilitychange',visible);for(const t of timers)clearTimeout(t);timers.clear();renderer?.close();pc?.close();wss?.close();handle.surface.remove();void options.request('/api/video/cancel',{attemptId:slot.id}).catch(()=>{});}};
    void (async()=>{
      try{
        if(provider==='wss'){
          snapshot={state:'connecting',gathering:'not-applicable',path:'wss',provider:'wss'};
          wss=connectWssPlayer({url:options.url('/ws/video',slot.id),canvas:surface as HTMLCanvasElement,onOpen:onConnected,onSize:(w,h)=>{width=w;height=h;options.changed();},onFrame:paintedFrame,onFailure:fail});return;
        }
        const config=await options.request('/api/webrtc/config',{provider,attemptId:slot.id});if(closed)return;
        servers=config.iceServers;gatherMs=config.gatherMs||gatherMs;snapshot.mode=config.iceTransportPolicy;
        pc=new RTCPeerConnection({iceServers:servers,iceTransportPolicy:config.iceTransportPolicy,bundlePolicy:'max-bundle'});
        const peer=pc;
        peer.addTransceiver('video',{direction:'recvonly'});
        peer.onicecandidateerror=event=>{if(!closed&&errors.length<8)errors.push(iceCandidateFailure(event,servers));};
        peer.ontrack=event=>{if(closed)return;try{renderer!.start(event.track);}catch{fail('WebRTC 视频呈现不可用');}};
        let disconnectTimer:ReturnType<typeof setTimeout>|undefined;
        peer.onconnectionstatechange=()=>{if(closed)return;snapshot.state=peer.connectionState;if(peer.connectionState==='connected'){if(disconnectTimer)clearTimeout(disconnectTimer);onConnected();}
          else if(peer.connectionState==='failed'||peer.connectionState==='closed')fail('ICE/DTLS连接失败');else if(peer.connectionState==='disconnected')disconnectTimer=delay(()=>fail('连接中断超过5秒'),5000);};
        await peer.setLocalDescription(await peer.createOffer());if(closed)return;
        await new Promise<void>(resolve=>{if(peer.iceGatheringState==='complete')return resolve();const t=delay(()=>{snapshot.gatherTimedOut=true;peer.removeEventListener('icegatheringstatechange',check);resolve();},gatherMs);
          const check=()=>{if(peer.iceGatheringState==='complete'||peer.connectionState==='closed'){clearTimeout(t);timers.delete(t);peer.removeEventListener('icegatheringstatechange',check);resolve();}};peer.addEventListener('icegatheringstatechange',check);});
        if(closed)return;snapshot.gathering=peer.iceGatheringState;
        if(config.iceTransportPolicy==='relay'&&!sdpCandidates(peer.localDescription?.sdp||'').some(x=>x.type==='relay')){fail(snapshot.gatherTimedOut?`候选等待${gatherMs/1000}秒超时`:'候选采集已完成，但未取得 TURN relay');return;}
        const answer=await options.request('/api/webrtc/offer',{type:'offer',sdp:peer.localDescription!.sdp,configId:config.configId,attemptId:slot.id});if(closed)return;
        width=answer.width;height=answer.height;options.changed();await peer.setRemoteDescription({type:'answer',sdp:answer.sdp});if(peer.connectionState==='connected')onConnected();
        const sample=async()=>{if(closed)return;try{const stats=await peer.getStats();if(closed)return;const inbound=[...stats.values()].find(s=>s.type==='inbound-rtp'&&s.kind==='video'),pair=selectedIcePair(stats),decoded=inbound?.framesDecoded??null;
          if(connected&&presentationHealth.check({paused:options.paused(),hidden:document.hidden,now:performance.now(),lastFrameAt,requiredAfter,decoded})){fail('视频持续解码但画面停止绘制，重新建立视频');return;}
          snapshot={...snapshot,state:peer.connectionState,gathering:peer.iceGatheringState,provider,path:pair?(pair.local?.type==='relay'||pair.remote?.type==='relay'?'relay':'direct'):'',iceServers:servers.map(s=>s.urls),localCandidates:sdpCandidates(peer.localDescription?.sdp||''),remoteCandidates:sdpCandidates(peer.remoteDescription?.sdp||''),selectedPair:pair,media:{framesDecoded:decoded,bytesReceived:inbound?.bytesReceived??null,packetsReceived:inbound?.packetsReceived??null,videoWidth:width,videoHeight:height,codec:inbound?stats.get(inbound.codecId)?.mimeType??null:null}};}catch{}if(!closed)delay(()=>void sample(),1000);};void sample();
        if(config.renewAfterMs!==null)delay(()=>{if(!closed)race.refresh(provider);},config.renewAfterMs);
      }catch(error){if(!closed)fail(iceCandidateFailure({errorText:String(error)},servers).errorText);}
    })();return handle;
  };
  race=new VideoRace(options.providers,{create:factory,selected:slot=>{for(const element of options.container.querySelectorAll<HTMLElement>('.video-candidate'))element.style.zIndex='0';if(slot?.handle){slot.handle.surface.style.zIndex='1';void options.request('/api/video/select',{attemptId:slot.id}).catch(()=>{});}options.selected(slot);},changed:options.changed});
  return {start:(mode:VideoMode)=>race.start(mode),stop:()=>race.stop(),holdSelection:(held:boolean)=>race.holdSelection(held),pauseChanged:()=>race.pauseChanged(),active:()=>race.active,
    snapshot:()=>({...race.snapshot(),history:[...history],current:race.active?.handle?.snapshot()||null})};
}
