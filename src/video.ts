import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from '@yume-chan/adb-scrcpy';
import { ReadableStream } from '@yume-chan/stream-extra';
import type { ScrcpyMediaStreamPacket, AndroidKeyCode, AndroidKeyEventAction, AndroidKeyEventMeta } from '@yume-chan/scrcpy';
import type { WebSocket } from 'ws';
import { ConsoleError } from './types.js';
import {HardwareKeyboard} from './hardware-keyboard.js';
import {WssEncoder} from './wss-encoder.js';

export function videoEncodingConfig(env:NodeJS.ProcessEnv){
  const maxSize=Number(env.VIDEO_MAX_SIZE||1920),maxFps=Number(env.VIDEO_MAX_FPS||30),videoBitRate=Number(env.VIDEO_BIT_RATE||4_000_000);
  if(!Number.isInteger(maxSize)||(maxSize!==0&&(maxSize<256||maxSize>4096)))throw new Error('VIDEO_MAX_SIZE must be 0 (uncapped) or 256-4096');
  if(!Number.isInteger(maxFps)||maxFps<1||maxFps>60)throw new Error('VIDEO_MAX_FPS must be 1-60');
  if(!Number.isInteger(videoBitRate)||videoBitRate<128000||videoBitRate>20000000)throw new Error('VIDEO_BIT_RATE must be 128000-20000000');
  return {maxSize,maxFps,videoBitRate};
}

export class Video extends EventEmitter {
  client?: AdbScrcpyClient<AdbScrcpyOptions3_3_3<true>>;
  width = 0; height = 0; codec = 0; frames = 0; bytes = 0;
  viewers = new Set<WebSocket>();
  private starting?: Promise<void>; private hardware?:HardwareKeyboard; keyboardBackend='initializing';
  private config?: Buffer;
  private awaitingKey = new Set<WebSocket>();
  private touchPoints = new Map<bigint, {x:number; y:number}>();
  private pressed = new Set<number>();
  private writeTail: Promise<unknown> = Promise.resolve();
  private paused=false;
  private pauseReason:string|null=null;
  private wssBytes=0;private wssPackets=0;
  private wssEncoder?:WssEncoder;private wssConfig?:Buffer;private encoderUnavailable=false;
  constructor(readonly serial: string,private options:{wssOptimized?:boolean}={wssOptimized:process.env.WSS_ADAPTIVE_ENCODER==='1'}) { super(); }
  async start() {
    if (this.client) return;
    if (this.starting) return this.starting;
    this.starting = this.open().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async open() {
    const server = new AdbServerClient(new AdbServerNodeTcpConnector({host:'127.0.0.1',port:5037}));
    const adb = await server.createAdb({serial:this.serial});
    const binary = await readFile('vendor/scrcpy-server-v3.3.3');
    if(createHash('sha256').update(binary).digest('hex')!=='7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0')throw new Error('Vendored scrcpy server checksum mismatch');
    await AdbScrcpyClient.pushServer(adb, new ReadableStream({start(c){c.enqueue(new Uint8Array(binary));c.close();}}), '/data/local/tmp/android-console-scrcpy.jar');
    const options = new AdbScrcpyOptions3_3_3({video:true,audio:false,control:true,videoCodec:'h264',videoCodecOptions:'profile=1,level=4096,i-frame-interval=2,max-bframes=0',...videoEncodingConfig(process.env),tunnelForward:true,powerOn:process.env.KEEP_SCREEN_ON==='1',stayAwake:process.env.KEEP_SCREEN_ON==='1',clipboardAutosync:false,logLevel:'warn'});
    const client = await AdbScrcpyClient.start(adb, '/data/local/tmp/android-console-scrcpy.jar', options);
    this.client = client;
    try{const hardware=new HardwareKeyboard(client.controller!);await hardware.create();this.hardware=hardware;this.keyboardBackend='uhid_pending';}catch{this.keyboardBackend='keycode';}

    void (async () => {
      const reader = client.output.getReader();
      try { while (true) { const {done,value}=await reader.read();if(done)break;this.emit('diagnostic',value); } } catch {}
    })();
    client.exited.then(() => {if(this.client===client){this.client=undefined;this.hardware=undefined;this.keyboardBackend='unavailable';this.config=undefined;this.emit('status','scrcpy connection closed');for(const ws of this.viewers)ws.close(1012,'Device stream closed');}}).catch(()=>{});
    const video = await client.videoStream;
    this.width=video.width;this.height=video.height;this.codec=video.metadata.codec;
    video.sizeChanged(size=>this.updateDimensions(size.width,size.height));
    this.sendMetadata();this.emit('status',null);
    void this.consume(video.stream);
  }
  private async consume(stream: ReadableStream<ScrcpyMediaStreamPacket>) {
    const reader=stream.getReader();
    try { while(true){const {done,value}=await reader.read();if(done)break;
      this.publishPacket(value);
    }} catch(error){this.emit('status',String(error));await this.close();}
  }
  private updateDimensions(width:number,height:number){const changed=width!==this.width||height!==this.height;this.width=width;this.height=height;
    if(changed)void this.releaseTouches().catch(()=>{});this.sendMetadata();
  }
  get configuration(){return this.config?.subarray(10);}
  publishPacket(value:ScrcpyMediaStreamPacket){
    const bytes=Buffer.allocUnsafe(10+value.data.byteLength);bytes[0]=value.type==='configuration'?0:1;
    bytes[1]=value.type==='data'&&value.keyframe?1:0;bytes.writeBigUInt64BE(value.type==='data'?value.pts??0n:0n,2);bytes.set(value.data,10);
    if(value.type==='configuration')this.config=bytes;else this.frames++;
    this.emit('packet',value);this.bytes+=bytes.length;
    if(this.wssEncoder){this.wssEncoder.write(value);return;}
    this.sendWss(value,bytes);
  }
  private sendWss(value:ScrcpyMediaStreamPacket,bytes?:Buffer){
    bytes??=this.wirePacket(value);if(value.type==='configuration'&&this.wssEncoder)this.wssConfig=bytes;
    for(const ws of this.viewers){if(ws.readyState!==1)continue;if(value.type==='configuration')this.awaitingKey.add(ws);else{if(this.paused)continue;if(this.awaitingKey.has(ws)){if(!value.keyframe)continue;this.awaitingKey.delete(ws);}}if(ws.bufferedAmount>2_000_000){ws.close(1013,'Video viewer is too slow');continue;}ws.send(bytes);if(value.type==='data'){this.wssBytes+=value.data.byteLength;this.wssPackets++;}}
  }
  private wirePacket(value:ScrcpyMediaStreamPacket){const bytes=Buffer.alloc(10+value.data.byteLength);bytes[0]=value.type==='configuration'?0:1;bytes[1]=value.type==='data'&&value.keyframe?1:0;bytes.writeBigUInt64BE(value.type==='data'?value.pts??0n:0n,2);bytes.set(value.data,10);return bytes;}
  setVideoPaused(paused:boolean,reason:string|null){const changed=this.paused!==paused;this.paused=paused;this.pauseReason=paused?reason:null;if(!changed)return;for(const ws of this.viewers)this.awaitingKey.add(ws);if(this.wssEncoder)this.wssEncoder.setPaused(paused);else if(!paused&&this.viewers.size)void this.client?.controller?.resetVideo().catch(()=>{});}
  closeViewers(reason='Video transport changed'){for(const ws of this.viewers)ws.close(1012,reason);this.viewers.clear();this.awaitingKey.clear();this.wssEncoder?.stop();this.wssEncoder=undefined;this.wssConfig=undefined;}
  wssDiagnostics(){return {state:this.viewers.size?'connected':'idle',provider:'wss',paused:this.paused,pauseReason:this.pauseReason,videoPayloadBytes:this.wssBytes,videoFrameMessagesSent:this.wssPackets,width:this.width,height:this.height,quality:this.wssEncoder?.snapshot()||{optimized:false,reason:this.encoderUnavailable?'encoder_unavailable':'disabled'}};}
  private sendMetadata() {for(const ws of this.viewers)if(ws.readyState===1)ws.send(JSON.stringify({type:'metadata',codec:this.codec,width:this.width,height:this.height}));}
  async view(ws: WebSocket) {
    await this.start();if(ws.readyState!==1)return;if(!this.viewers.size){this.wssBytes=0;this.wssPackets=0;}this.viewers.add(ws);this.awaitingKey.add(ws);
    ws.send(JSON.stringify({type:'metadata',codec:this.codec,width:this.width,height:this.height}));
    if(this.options.wssOptimized&&!this.wssEncoder&&!this.encoderUnavailable){const encoder=new WssEncoder(()=>{void this.client?.controller?.resetVideo().catch(()=>{});});this.wssEncoder=encoder;
      encoder.on('packet',(packet:ScrcpyMediaStreamPacket)=>this.sendWss(packet));encoder.on('profile',()=>{for(const viewer of this.viewers){this.awaitingKey.add(viewer);if(viewer.readyState===1)viewer.send(JSON.stringify({type:'quality',...encoder.snapshot()}));}});
      encoder.on('failure',()=>{this.encoderUnavailable=true;this.wssEncoder=undefined;for(const viewer of this.viewers){this.awaitingKey.add(viewer);if(this.config&&viewer.readyState===1)viewer.send(this.config);}void this.client?.controller?.resetVideo().catch(()=>{});});
      if(this.configuration)encoder.write({type:'configuration',data:this.configuration});encoder.setPaused(this.paused);encoder.start();
    }
    if(this.wssEncoder){if(this.wssConfig)ws.send(this.wssConfig);ws.send(JSON.stringify({type:'quality',...this.wssEncoder.snapshot()}));}else if(this.config)ws.send(this.config);
    ws.on('message',data=>{const size=Array.isArray(data)?data.reduce((n,b)=>n+b.length,0):data instanceof ArrayBuffer?data.byteLength:data.length;if(size>2048||ws.readyState!==1)return;try{const message=JSON.parse(String(data));if(message.type==='ping'&&Number.isSafeInteger(message.id)&&message.id>0){ws.send(JSON.stringify({type:'pong',id:message.id}));return;}if(!this.wssEncoder||this.paused)return;if(message.type!=='feedback'||typeof message.lastDrawnPts!=='string'||!/^\d{1,20}$/.test(message.lastDrawnPts))return;const lag=Date.now()-Number(BigInt(message.lastDrawnPts))/1000;this.wssEncoder.feedback(lag,ws.bufferedAmount);}catch{}});
    ws.once('close',()=>{this.viewers.delete(ws);this.awaitingKey.delete(ws);if(!this.viewers.size){this.wssEncoder?.stop();this.wssEncoder=undefined;this.wssConfig=undefined;}});
    // New viewers must begin at a keyframe, not an arbitrary inter-frame packet.
    if(!this.paused&&!this.wssEncoder)await this.client?.controller?.resetVideo();
  }
  private write(fn:()=>Promise<void>) {const work=this.writeTail.then(fn,fn);this.writeTail=work.catch(()=>{});return work;}
  async touch(action:number,id:bigint,x:number,y:number,width=this.width,height=this.height,beforeSend?:()=>void) {
    if(![0,1,2].includes(action)||!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=width||y>=height)throw new ConsoleError('INVALID_TOUCH','触摸坐标或动作无效');
    await this.write(async()=>{
      beforeSend?.();
      if(width!==this.width||height!==this.height){await this.releaseTouchesNow();throw new ConsoleError('STALE_FRAME','视频尺寸已变化，触摸已释放，请重新观察');}
      const controller=this.client?.controller;if(!controller)throw new ConsoleError('NO_CONTROL','设备控制通道不可用',503);
      if(action===0&&this.touchPoints.size>=2&&!this.touchPoints.has(id))throw new ConsoleError('TOUCH_LIMIT','最多同时支持两指');
      if(action!==0&&!this.touchPoints.has(id))return;
      await controller.injectTouch({action:action as 0,pointerId:id,pointerX:Math.round(x),pointerY:Math.round(y),videoWidth:width,videoHeight:height,pressure:action===1?0:1,actionButton:0,buttons:0});
      if(action===1)this.touchPoints.delete(id);else this.touchPoints.set(id,{x,y});
    });
  }
  async key(action:number,keyCode:number,metaState=0,repeat=0) {
    if(![0,1].includes(action)||!Number.isInteger(keyCode)||keyCode<0||keyCode>400)throw new ConsoleError('INVALID_KEY','不支持的按键');
    await this.write(async()=>{const controller=this.client?.controller;if(!controller)throw new ConsoleError('NO_CONTROL','设备按键通道不可用',503);if(this.hardware&&this.keyboardBackend==='uhid'&&await this.hardware.key(action,keyCode,metaState))return;await controller.injectKeyCode({action:action as AndroidKeyEventAction,keyCode:keyCode as AndroidKeyCode,metaState:metaState as AndroidKeyEventMeta,repeat});if(action===0)this.pressed.add(keyCode);else this.pressed.delete(keyCode);});
  }
  async confirmKeyboard(present:boolean){if(this.keyboardBackend==='uhid_pending'){this.keyboardBackend=present?'uhid':'keycode';if(!present){await this.hardware?.close().catch(()=>{});this.hardware=undefined;}}}
  async panel(kind:'notifications'|'settings'){const controller=this.client?.controller;if(!controller)throw new ConsoleError('NO_CONTROL','控制通道不可用',503);await this.write(()=>kind==='notifications'?controller.expandNotificationPanel():controller.expandSettingPanel());}
  async press(keyCode:number,metaState=0){await this.key(0,keyCode,metaState);await this.key(1,keyCode,metaState);}
  async text(text:string){if(!this.client?.controller)throw new ConsoleError('NO_CONTROL','设备文字通道不可用',503);await this.write(()=>this.client!.controller!.injectText(text));}
  private async releaseTouchesNow(){const controller=this.client?.controller;
    try{if(controller)for(const [id,p]of this.touchPoints)await controller.injectTouch({action:1,pointerId:id,pointerX:Math.max(0,Math.min(this.width-1,Math.round(p.x))),pointerY:Math.max(0,Math.min(this.height-1,Math.round(p.y))),videoWidth:this.width,videoHeight:this.height,pressure:0,actionButton:0,buttons:0});}
    finally{this.touchPoints.clear();}
  }
  async releaseTouches(){await this.write(()=>this.releaseTouchesNow());}
  async releaseKeys(){await this.write(async()=>{try{await this.hardware?.release();const controller=this.client?.controller;if(controller)for(const code of this.pressed)await controller.injectKeyCode({action:1,keyCode:code as AndroidKeyCode,metaState:0,repeat:0});}finally{this.pressed.clear();}});}
  async release() {
    await this.releaseTouches();await this.releaseKeys();
  }
  async close(){await this.release().catch(()=>{});await this.hardware?.close().catch(()=>{});this.hardware=undefined;const old=this.client;this.client=undefined;try{await old?.close();}catch{}this.closeViewers('Device disconnected');}
}
