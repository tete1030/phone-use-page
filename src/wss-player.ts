import {ScrcpyVideoCodecId} from '@yume-chan/scrcpy';
import {avcConfiguration,avcFrame} from './h264-avc.js';
import {diagnosticError,type WssFailure} from './wss-diagnostics.js';

export function connectWssPlayer(options:{url:string;canvas:HTMLCanvasElement;onOpen:()=>void;onSize:(width:number,height:number)=>void;onFrame:()=>void;onFailure:(reason:string)=>void;onDiagnostic?:(report:WssFailure)=>void}){
  let stopped=false,failed=false,decoder:VideoDecoder|undefined,context:ImageBitmapRenderingContext|null=null;
  let config:ReturnType<typeof avcConfiguration>|undefined,waitingForKey=true,recoveries=0,skippedFrames=0,decodeEpoch=0;
  let drawing=false,pauseExpected=false,pendingFrame:VideoFrame|undefined,resyncTimer:ReturnType<typeof setTimeout>|undefined,lastKeyRequest=-Infinity;
  let tail=Promise.resolve(),queuedBytes=0,bytesReceived=0,packetsReceived=0,drawnFrames=0,lastDrawnPts='0',quality:unknown=null;
  let pingId=0,pendingPing:{id:number;at:number}|null=null,roundTripMs:number|null=null,roundTripAt=0;
  const started=performance.now(),capabilities={secureContext:globalThis.isSecureContext,videoDecoder:typeof VideoDecoder==='function',createImageBitmap:typeof createImageBitmap==='function',bitmapRenderer:null as boolean|null};
  let metadata={width:0,height:0,codec:null as number|null},avcCodec:string|null=null,lastPacket:WssFailure['lastPacket']=null,lastError:WssFailure|null=null;
  const socket=new WebSocket(options.url);socket.binaryType='arraybuffer';
  const decoderState=()=>({format:'avc' as const,waitingForKey,recoveries,skippedFrames});
  const diagnostic=(stage:WssFailure['stage'],code:string,error:unknown,closeCode:number|null=null):WssFailure=>({provider:'wss',stage,code,error:diagnosticError(error),elapsedMs:Math.round(performance.now()-started),socketState:socket.readyState,closeCode,
    ...metadata,avcCodec,bytesReceived,packetsReceived,drawnFrames,queuedBytes,lastPacket,decoder:decoderState(),capabilities:{...capabilities}});
  const report=(value:WssFailure)=>{try{options.onDiagnostic?.(value);}catch{}};
  const fail=(reason:string,stage:WssFailure['stage'],code:string,error?:unknown,closeCode:number|null=null)=>{if(stopped||failed)return;failed=true;clearTimeout(resyncTimer);
    lastError=diagnostic(stage,code,error||reason,closeCode);report(lastError);options.onFailure(reason);};
  const requestKey=()=>{if(stopped||failed||pauseExpected)return;if(!resyncTimer)resyncTimer=setTimeout(()=>fail('WSS 等待关键帧超时','decode','WSS_KEYFRAME_TIMEOUT'),12000);
    if(socket.readyState===1&&performance.now()-lastKeyRequest>=2000){lastKeyRequest=performance.now();socket.send(JSON.stringify({type:'keyframe'}));}};
  const clearPending=()=>{pendingFrame?.close();pendingFrame=undefined;};
  const draw=async(frame:VideoFrame)=>{
    drawing=true;const epoch=decodeEpoch;
    try{
      const bitmap=await createImageBitmap(frame);
      if(stopped||failed||epoch!==decodeEpoch){bitmap.close();return;}
      try{
        if(options.canvas.width!==frame.displayWidth||options.canvas.height!==frame.displayHeight){options.canvas.width=frame.displayWidth;options.canvas.height=frame.displayHeight;options.onSize(frame.displayWidth,frame.displayHeight);}
        context!.transferFromImageBitmap(bitmap);
      }finally{bitmap.close();}
      lastDrawnPts=String(Math.round(frame.timestamp));drawnFrames++;options.onFrame();
    }catch(error){fail('WSS 视频绘制失败','render','WSS_RENDER_FAILED',error);}
    finally{frame.close();drawing=false;const next=pendingFrame;pendingFrame=undefined;if(next){if(stopped||failed)next.close();else void draw(next);}}
  };
  function createDecoder(){
    const value=new VideoDecoder({output:frame=>{if(stopped||failed||decoder!==value){frame.close();return;}if(drawing){if(pendingFrame){pendingFrame.close();skippedFrames++;}pendingFrame=frame;}else void draw(frame);},
      error:error=>{if(decoder===value)decodeError(error);}});
    return value;
  }
  const resetDecoder=()=>{decodeEpoch++;clearPending();if(decoder?.state==='closed')decoder=createDecoder();else decoder?.reset();waitingForKey=true;};
  const decodeError=(error:DOMException)=>{
    if(stopped||failed)return;
    // Retry one clean keyframe after a decoder reset; never relabel a delta as a keyframe.
    if(error.name==='DataError'&&recoveries<1){recoveries++;resetDecoder();report(diagnostic('decode','WSS_KEYFRAME_RECOVERY',error));requestKey();}
    else fail('WSS 视频解码失败','decode','WSS_DECODE_FAILED',error);
  };
  const feedback=setInterval(()=>{if(!stopped&&socket.readyState===1&&drawnFrames)socket.send(JSON.stringify({type:'feedback',lastDrawnPts}));},2000);
  const ping=()=>{if(stopped||socket.readyState!==1)return;pendingPing={id:++pingId,at:performance.now()};socket.send(JSON.stringify({type:'ping',id:pingId}));};
  const pingTimer=setInterval(ping,5000);
  const close=()=>{if(stopped)return;stopped=true;decodeEpoch++;clearInterval(feedback);clearInterval(pingTimer);clearTimeout(resyncTimer);clearPending();socket.close();if(decoder&&decoder.state!=='closed')decoder.close();};
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
        code='WSS_CODEC_UNSUPPORTED';if(message.codec!==ScrcpyVideoCodecId.H264)throw new Error('Unsupported codec');
        options.onSize(message.width,message.height);if(decoder)return;
        stage='capability';code='WSS_WEB_CODECS_UNAVAILABLE';if(!capabilities.videoDecoder)throw new Error('VideoDecoder unavailable');
        code='WSS_IMAGE_BITMAP_UNAVAILABLE';if(!capabilities.createImageBitmap)throw new Error('createImageBitmap unavailable');
        code='WSS_BITMAP_RENDERER_UNAVAILABLE';context=options.canvas.getContext('bitmaprenderer',{alpha:false});capabilities.bitmapRenderer=!!context;
        if(!context)throw new Error('Canvas bitmaprenderer unavailable');
        stage='decoder-init';code='WSS_DECODER_INIT_FAILED';
        decoder=createDecoder();
        return;
      }
      const buffer=event.data as ArrayBuffer,data=new Uint8Array(buffer);
      stage='packet';code='WSS_PACKET_INVALID';lastPacket={kind:data[0]??null,bytes:data.length};
      if(!decoder||data.length<10||data.length>2_000_000||data[0]>1)throw new Error('Invalid video packet');
      bytesReceived+=data.length;packetsReceived++;queuedBytes+=data.length;
      stage='backpressure';code='WSS_DECODER_BACKPRESSURE';if(queuedBytes>2_000_000)throw new Error('Decoder too slow');
      const packetInfo=lastPacket;
      tail=tail.then(()=>{
        if(stopped||failed)return;
        lastPacket=packetInfo;
        if(data[0]===0){const next=avcConfiguration(data.subarray(10));
          const changed=!config||config.description.length!==next.description.length||config.description.some((n,i)=>n!==next.description[i]);
          config=next;avcCodec=config.codec;if(changed)resetDecoder();return;}
        const frame=avcFrame(data.subarray(10));packetInfo.keyframe=data[1]===1;packetInfo.nalTypes=frame.nalTypes.slice(0,32);
        if(!frame.hasPicture)return;
        if(!config||waitingForKey&&!frame.hasIdr){skippedFrames++;requestKey();return;}
        if(decoder!.decodeQueueSize>12){resetDecoder();if(!frame.hasIdr){skippedFrames++;requestKey();return;}}
        if(waitingForKey){
          // AVC description plus length-prefixed NAL units avoids browser Annex B keyframe sniffing.
          decoder!.configure({codec:config.codec,description:config.description,codedWidth:config.codedWidth,codedHeight:config.codedHeight,optimizeForLatency:true});
          waitingForKey=false;
        }
        decoder!.decode(new EncodedVideoChunk({type:frame.hasIdr?'key':'delta',timestamp:Number(new DataView(buffer).getBigUint64(2)),data:frame.data}));
        if(frame.hasIdr){clearTimeout(resyncTimer);resyncTimer=undefined;}
      }).catch(error=>{if(error?.name==='DataError')decodeError(error);else fail('WSS 视频解码失败','decode','WSS_DECODE_FAILED',error);}).finally(()=>{queuedBytes-=data.length;});
    }catch(error){fail('WSS 视频格式或解码器不可用',stage,code,error);}
  };
  return {close,setPaused:(paused:boolean)=>{if(paused===pauseExpected)return;pauseExpected=paused;if(paused){clearTimeout(resyncTimer);resyncTimer=undefined;}else if(waitingForKey&&config)requestKey();},
    snapshot:()=>({state:socket.readyState===1?'connected':socket.readyState<2?'connecting':'closed',bytesReceived,packetsReceived,decodedAndDrawnFrames:drawnFrames,framesRendered:drawnFrames,framesSkipped:skippedFrames,width:options.canvas.width,height:options.canvas.height,quality,lastError,decoder:decoderState(),roundTripMs:performance.now()-roundTripAt<=10000?roundTripMs:null})};
}
