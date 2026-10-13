import {WebCodecsVideoDecoder,BitmapVideoFrameRenderer} from '@yume-chan/scrcpy-decoder-webcodecs';
import {ScrcpyVideoCodecId,h264ParseConfiguration,type ScrcpyMediaStreamPacket} from '@yume-chan/scrcpy';
import {diagnosticError,type WssFailure} from './wss-diagnostics.js';

export function connectWssPlayer(options:{url:string;canvas:HTMLCanvasElement;onOpen:()=>void;onSize:(width:number,height:number)=>void;onFrame:()=>void;onFailure:(reason:string)=>void;onDiagnostic?:(report:WssFailure)=>void}){
  let stopped=false,failed=false,decoder:WebCodecsVideoDecoder|undefined,writer:WritableStreamDefaultWriter<ScrcpyMediaStreamPacket>|undefined;
  let tail=Promise.resolve(),queuedBytes=0,bytesReceived=0,packetsReceived=0,drawnFrames=0,lastDrawnPts='0',quality:unknown=null;
  let pingId=0,pendingPing:{id:number;at:number}|null=null,roundTripMs:number|null=null,roundTripAt=0;
  const started=performance.now(),capabilities={secureContext:globalThis.isSecureContext,videoDecoder:typeof VideoDecoder==='function',createImageBitmap:typeof createImageBitmap==='function',bitmapRenderer:null as boolean|null};
  let metadata={width:0,height:0,codec:null as number|null},avcCodec:string|null=null,lastPacket:WssFailure['lastPacket']=null,lastError:WssFailure|null=null;
  const socket=new WebSocket(options.url);socket.binaryType='arraybuffer';
  const fail=(reason:string,stage:WssFailure['stage'],code:string,error?:unknown,closeCode:number|null=null)=>{if(stopped||failed)return;failed=true;
    lastError={provider:'wss',stage,code,error:diagnosticError(error||reason),elapsedMs:Math.round(performance.now()-started),socketState:socket.readyState,closeCode,
      ...metadata,avcCodec,bytesReceived,packetsReceived,drawnFrames,queuedBytes,lastPacket,capabilities:{...capabilities}};
    try{options.onDiagnostic?.(lastError);}catch{}options.onFailure(reason);};
  class Renderer extends BitmapVideoFrameRenderer {
    override async draw(frame:VideoFrame){try{await super.draw(frame);}catch(error){frame.close();fail('WSS 视频绘制失败','render','WSS_RENDER_FAILED',error);throw error;}if(stopped||failed)return;lastDrawnPts=String(Math.round(frame.timestamp));drawnFrames++;options.onFrame();}
  }
  const feedback=setInterval(()=>{if(!stopped&&socket.readyState===1&&drawnFrames)socket.send(JSON.stringify({type:'feedback',lastDrawnPts}));},2000);
  const ping=()=>{if(stopped||socket.readyState!==1)return;pendingPing={id:++pingId,at:performance.now()};socket.send(JSON.stringify({type:'ping',id:pingId}));};
  const pingTimer=setInterval(ping,5000);
  const close=()=>{if(stopped)return;stopped=true;clearInterval(feedback);clearInterval(pingTimer);socket.close();decoder?.dispose();void writer?.abort().catch(()=>{});};
  socket.onopen=()=>{if(!stopped){ping();options.onOpen();}};
  socket.onerror=()=>fail('WSS 视频连接失败','socket','WSS_SOCKET_ERROR');
  socket.onclose=event=>fail('WSS 视频连接已关闭','socket','WSS_SOCKET_CLOSED',new Error('WebSocket closed: '+event.reason),event.code);
  socket.onmessage=event=>{
    if(stopped||failed)return;
    let stage:WssFailure['stage']='metadata',code='WSS_METADATA_INVALID';
    try{
      if(typeof event.data==='string'){
        const message=JSON.parse(event.data);
        if(message.type==='pong'){if(pendingPing&&message.id===pendingPing.id){roundTripAt=performance.now();roundTripMs=Math.round(roundTripAt-pendingPing.at);pendingPing=null;}return;}
        if(message.type==='quality'){quality=message;return;}
        if(message.type==='offline'){fail('WSS 当前页面已离线','socket','WSS_PAGE_OFFLINE');return;}
        if(message.type==='error'){fail('WSS 手机视频暂不可用','socket','WSS_SERVER_ERROR');return;}
        if(message.type!=='metadata')return;
        metadata={width:message.width,height:message.height,codec:message.codec};
        if(message.width<=0||message.height<=0)return;
        code='WSS_CODEC_UNSUPPORTED';
        if(message.codec!==ScrcpyVideoCodecId.H264)throw new Error('Unsupported codec');
        options.onSize(message.width,message.height);
        if(decoder)return;
        stage='capability';code='WSS_WEB_CODECS_UNAVAILABLE';
        if(!WebCodecsVideoDecoder.isSupported)throw new Error('VideoDecoder unavailable');
        code='WSS_IMAGE_BITMAP_UNAVAILABLE';if(!capabilities.createImageBitmap)throw new Error('createImageBitmap unavailable');
        code='WSS_BITMAP_RENDERER_UNAVAILABLE';capabilities.bitmapRenderer=!!options.canvas.getContext('bitmaprenderer',{alpha:false});
        if(!capabilities.bitmapRenderer)throw new Error('Canvas bitmaprenderer unavailable');
        stage='decoder-init';code='WSS_DECODER_INIT_FAILED';
        decoder=new WebCodecsVideoDecoder({codec:message.codec,renderer:new Renderer(options.canvas)});
        writer=decoder.writable.getWriter() as WritableStreamDefaultWriter<ScrcpyMediaStreamPacket>;
        decoder.sizeChanged(size=>{if(!stopped){metadata.width=size.width;metadata.height=size.height;options.onSize(size.width,size.height);}});
        void writer.closed.catch(error=>fail('WSS 视频解码失败','decode','WSS_DECODE_FAILED',error));
        return;
      }
      const buffer=event.data as ArrayBuffer,data=new Uint8Array(buffer);
      stage='packet';code='WSS_PACKET_INVALID';lastPacket={kind:data[0]??null,bytes:data.length};
      if(!writer||data.length<10||data.length>2_000_000||data[0]>1)throw new Error('Invalid video packet');
      bytesReceived+=data.length;packetsReceived++;queuedBytes+=data.length;
      stage='backpressure';code='WSS_DECODER_BACKPRESSURE';
      if(queuedBytes>2_000_000)throw new Error('Decoder too slow');
      const packet:ScrcpyMediaStreamPacket=data[0]===0?{type:'configuration',data:data.subarray(10)}:
        {type:'data',keyframe:data[1]===1,pts:new DataView(buffer).getBigUint64(2),data:data.subarray(10)};
      if(packet.type==='configuration')try{const parsed=h264ParseConfiguration(packet.data);avcCodec='avc1.'+[parsed.profileIndex,parsed.constraintSet,parsed.levelIndex].map(n=>n.toString(16).padStart(2,'0')).join('');}catch{avcCodec=null;}
      tail=tail.then(async()=>{try{if(!stopped&&!failed)await writer!.write(packet);}finally{queuedBytes-=data.length;}}).catch(error=>fail('WSS 视频解码失败','decode','WSS_DECODE_FAILED',error));
    }catch(error){fail('WSS 视频格式或解码器不可用',stage,code,error);}
  };
  return {close,snapshot:()=>({state:socket.readyState===1?'connected':socket.readyState<2?'connecting':'closed',bytesReceived,packetsReceived,decodedAndDrawnFrames:drawnFrames,framesRendered:decoder?.framesRendered||0,framesSkipped:decoder?.framesSkipped||0,width:options.canvas.width,height:options.canvas.height,quality,lastError,roundTripMs:performance.now()-roundTripAt<=10000?roundTripMs:null})};
}
