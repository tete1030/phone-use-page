import {WebCodecsVideoDecoder,BitmapVideoFrameRenderer} from '@yume-chan/scrcpy-decoder-webcodecs';
import {ScrcpyVideoCodecId,type ScrcpyMediaStreamPacket} from '@yume-chan/scrcpy';

export function connectWssPlayer(options:{url:string;canvas:HTMLCanvasElement;onOpen:()=>void;onSize:(width:number,height:number)=>void;onFrame:()=>void;onFailure:(reason:string)=>void}){
  let stopped=false,failed=false,decoder:WebCodecsVideoDecoder|undefined,writer:WritableStreamDefaultWriter<ScrcpyMediaStreamPacket>|undefined;
  let tail=Promise.resolve(),queuedBytes=0,bytesReceived=0,packetsReceived=0,drawnFrames=0,lastDrawnPts='0',quality:unknown=null;
  let pingId=0,pendingPing:{id:number;at:number}|null=null,roundTripMs:number|null=null,roundTripAt=0;
  const socket=new WebSocket(options.url);socket.binaryType='arraybuffer';
  const fail=(reason:string)=>{if(stopped||failed)return;failed=true;options.onFailure(reason);};
  class Renderer extends BitmapVideoFrameRenderer {
    override async draw(frame:VideoFrame){await super.draw(frame);if(stopped||failed)return;lastDrawnPts=String(Math.round(frame.timestamp));drawnFrames++;options.onFrame();}
  }
  const feedback=setInterval(()=>{if(!stopped&&socket.readyState===1&&drawnFrames)socket.send(JSON.stringify({type:'feedback',lastDrawnPts}));},2000);
  const ping=()=>{if(stopped||socket.readyState!==1)return;pendingPing={id:++pingId,at:performance.now()};socket.send(JSON.stringify({type:'ping',id:pingId}));};
  const pingTimer=setInterval(ping,5000);
  const close=()=>{if(stopped)return;stopped=true;clearInterval(feedback);clearInterval(pingTimer);socket.close();decoder?.dispose();void writer?.abort().catch(()=>{});};
  socket.onopen=()=>{if(!stopped){ping();options.onOpen();}};
  socket.onerror=()=>fail('WSS 视频连接失败');
  socket.onclose=()=>fail('WSS 视频连接已关闭');
  socket.onmessage=event=>{
    if(stopped||failed)return;
    try{
      if(typeof event.data==='string'){
        const message=JSON.parse(event.data);
        if(message.type==='pong'){if(pendingPing&&message.id===pendingPing.id){roundTripAt=performance.now();roundTripMs=Math.round(roundTripAt-pendingPing.at);pendingPing=null;}return;}
        if(message.type==='quality'){quality=message;return;}
        if(message.type==='offline'){fail('WSS 当前页面已离线');return;}
        if(message.type==='error'){fail('WSS 手机视频暂不可用');return;}
        if(message.type!=='metadata')return;
        if(message.width<=0||message.height<=0)return;
        if(message.codec!==ScrcpyVideoCodecId.H264)throw new Error('Unsupported codec');
        options.onSize(message.width,message.height);
        if(decoder)return;
        if(!WebCodecsVideoDecoder.isSupported)throw new Error('WebCodecs unavailable');
        decoder=new WebCodecsVideoDecoder({codec:message.codec,renderer:new Renderer(options.canvas)});
        writer=decoder.writable.getWriter() as WritableStreamDefaultWriter<ScrcpyMediaStreamPacket>;
        decoder.sizeChanged(size=>{if(!stopped)options.onSize(size.width,size.height);});
        void writer.closed.catch(()=>fail('WSS 视频解码失败'));
        return;
      }
      const buffer=event.data as ArrayBuffer,data=new Uint8Array(buffer);
      if(!writer||data.length<10||data.length>2_000_000||data[0]>1)throw new Error('Invalid video packet');
      bytesReceived+=data.length;packetsReceived++;queuedBytes+=data.length;
      if(queuedBytes>2_000_000)throw new Error('Decoder too slow');
      const packet:ScrcpyMediaStreamPacket=data[0]===0?{type:'configuration',data:data.subarray(10)}:
        {type:'data',keyframe:data[1]===1,pts:new DataView(buffer).getBigUint64(2),data:data.subarray(10)};
      tail=tail.then(async()=>{try{if(!stopped&&!failed)await writer!.write(packet);}finally{queuedBytes-=data.length;}}).catch(()=>fail('WSS 视频解码失败'));
    }catch{fail('WSS 视频格式或解码器不可用');}
  };
  return {close,snapshot:()=>({state:socket.readyState===1?'connected':socket.readyState<2?'connecting':'closed',bytesReceived,packetsReceived,decodedAndDrawnFrames:drawnFrames,framesRendered:decoder?.framesRendered||0,framesSkipped:decoder?.framesSkipped||0,width:options.canvas.width,height:options.canvas.height,quality,roundTripMs:performance.now()-roundTripAt<=10000?roundTripMs:null})};
}
