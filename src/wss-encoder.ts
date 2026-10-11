import {EventEmitter} from 'node:events';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createSocket,type Socket} from 'node:dgram';
import type {ScrcpyMediaStreamPacket} from '@yume-chan/scrcpy';

export const wssProfiles={
  low:{fps:4,bitRate:600000,crf:24,keyframeIntervalSeconds:3},
  balanced:{fps:8,bitRate:1200000,crf:24,keyframeIntervalSeconds:2},
  high:{fps:12,bitRate:1800000,crf:23,keyframeIntervalSeconds:2},
} as const;
export type WssProfile=keyof typeof wssProfiles;
const bufferSeconds=2;
export function wssEncodingArgs(profile:WssProfile,port:number) {
  const p=wssProfiles[profile];
  return ['-hide_banner','-loglevel','error','-probesize','32','-analyzeduration','0',
    '-use_wallclock_as_timestamps','1','-fflags','+genpts+discardcorrupt','-flags','low_delay','-f','h264','-i','pipe:0',
    '-an','-vf',`select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,${1/p.fps}),setpts=PTS-STARTPTS`,
    '-fps_mode','vfr','-c:v','libx264','-preset','veryfast','-tune','zerolatency','-threads','2','-crf',String(p.crf),
    '-maxrate',String(p.bitRate),'-bufsize',String(p.bitRate*bufferSeconds),'-pix_fmt','yuv420p',
    '-g',String(p.fps*p.keyframeIntervalSeconds),'-keyint_min',String(p.fps*p.keyframeIntervalSeconds),'-sc_threshold','0','-bf','0',
    // Match rate control to sampled FPS; leave VFR intact for sparse screen updates.
    '-x264-params',`aud=1:repeat-headers=1:fps=${p.fps}/1`,
    '-f','rtp','-payload_type','96',`rtp://127.0.0.1:${port}?pkt_size=1200`];
}
const annex=(nalus:Uint8Array[])=>Buffer.concat(nalus.flatMap(n=>[Buffer.from([0,0,0,1]),Buffer.from(n)]));

export class WssEncoder extends EventEmitter {
  private child?:ChildProcessWithoutNullStreams;
  private socket?:Socket;private starting=false;
  private inputConfig?:Uint8Array;
  private paused=false;
  private needsKey=true;
  private outputNeedsKey=true;private droppedRtpFrames=0;private receiveBufferBytes:number|null=null;
  private generation=0;
  profile:WssProfile='balanced';
  private lastChange=0;private bad=0;private good=0;
  constructor(private requestKey:()=>void,private executable=process.env.FFMPEG_PATH||'ffmpeg',private now:()=>number=Date.now){super();}
  start(){if(this.child||this.starting||this.paused)return;this.starting=true;const generation=++this.generation,socket=createSocket('udp4');this.socket=socket;
    let frame:Uint8Array[]=[],frameBytes=0,fragment:Buffer|undefined,sps:Uint8Array|undefined,pps:Uint8Array|undefined,lastSequence:number|undefined,damaged=false;
    socket.on('message',data=>{if(generation!==this.generation||data.length<12)return;const sequence=data.readUInt16BE(2);
      if(lastSequence!==undefined&&sequence!==((lastSequence+1)&65535))damaged=true;lastSequence=sequence;
      const offset=12+(data[0]!&15)*4,payload=data.subarray(offset);if(!payload.length)return;
      const nal=(value:Uint8Array)=>{if(damaged)return;const type=value[0]!&31;if(type===7)sps=value;if(type===8)pps=value;frameBytes+=value.length;if(frameBytes>2_000_000){damaged=true;frame=[];return;}frame.push(value);};
      const type=payload[0]!&31;
      if(type<24)nal(payload);
      else if(type===24){let i=1;while(i+2<=payload.length){const length=payload.readUInt16BE(i);i+=2;if(i+length>payload.length){damaged=true;break;}nal(payload.subarray(i,i+length));i+=length;}}
      else if(type===28&&payload.length>=2&&!damaged){if(payload[1]!&128)fragment=Buffer.from([(payload[0]!&224)|(payload[1]!&31)]);if(fragment){fragment=Buffer.concat([fragment,payload.subarray(2)]);if(fragment.length>2_000_000){damaged=true;fragment=undefined;}else if(payload[1]!&64){nal(fragment);fragment=undefined;}}else damaged=true;}
      if(data[1]!&128){const keyframe=frame.some(n=>(n[0]!&31)===5);
        if(damaged){this.droppedRtpFrames++;this.outputNeedsKey=true;}
        else if(frame.length){
          if(keyframe&&sps&&pps){this.outputNeedsKey=false;this.emit('packet',{type:'configuration',data:annex([sps,pps])} satisfies ScrcpyMediaStreamPacket);}
          // Predictive frames after local packet loss need a new intact reference.
          if(!this.outputNeedsKey)this.emit('packet',{type:'data',data:annex(frame),keyframe,pts:BigInt(Date.now())*1000n} satisfies ScrcpyMediaStreamPacket);
        }
        frame=[];frameBytes=0;fragment=undefined;damaged=false;
      }
    });
    socket.on('error',()=>this.fail(generation));socket.bind(0,'127.0.0.1',()=>{if(generation!==this.generation){try{socket.close();}catch{}return;}this.starting=false;
    // A detailed keyframe can arrive as a burst of hundreds of RTP datagrams.
    try{socket.setRecvBufferSize(4*1024*1024);}catch{}
    this.receiveBufferBytes=socket.getRecvBufferSize();
    const address=socket.address();const child=spawn(this.executable,wssEncodingArgs(this.profile,address.port),{stdio:['pipe','pipe','pipe']});
    this.child=child;this.needsKey=true;this.outputNeedsKey=true;
    child.stdout.on('data',()=>{});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>this.fail(generation));
    child.on('error',()=>this.fail(generation));child.on('exit',()=>this.fail(generation));
    this.requestKey();
    });
  }
  private fail(generation:number){if(generation!==this.generation)return;this.stop();this.emit('failure','WSS 视频编码暂不可用');}
  write(packet:ScrcpyMediaStreamPacket){if(packet.type==='configuration'){this.inputConfig=packet.data;return;}
    if(this.paused)return;this.start();const child=this.child;if(!child)return;
    if(this.needsKey){if(!packet.keyframe)return;this.needsKey=false;if(this.inputConfig)child.stdin.write(this.inputConfig);}
    if(child.stdin.writableLength>2_000_000){if(this.profile!=='low')this.change('low');else{this.stop();this.start();}return;}child.stdin.write(packet.data);
  }
  setPaused(paused:boolean){if(this.paused===paused)return;this.paused=paused;if(paused)this.stop();else this.start();}
  feedback(lagMs:number,bufferedBytes:number){if(!Number.isFinite(lagMs)||lagMs<0||lagMs>15000)return;
    const bad=lagMs>600||bufferedBytes>96000,good=lagMs<180&&bufferedBytes<16000;
    this.bad=bad?this.bad+1:0;this.good=good?this.good+1:0;if(this.now()-this.lastChange<10000)return;
    const profiles:WssProfile[]=['low','balanced','high'],index=profiles.indexOf(this.profile);
    if(this.bad>=3&&index>0)this.change(profiles[index-1]!);else if(this.good>=10&&index<2)this.change(profiles[index+1]!);
  }
  private change(profile:WssProfile){if(this.profile===profile)return;this.profile=profile;this.lastChange=this.now();this.bad=0;this.good=0;this.stop();this.start();this.emit('profile',profile);}
  stop(){this.generation++;this.starting=false;const child=this.child;this.child=undefined;if(child){child.stdin.destroy();child.kill('SIGKILL');}const socket=this.socket;this.socket=undefined;try{socket?.close();}catch{}}
  snapshot(){return {profile:this.profile,...wssProfiles[this.profile],bufferBits:wssProfiles[this.profile].bitRate*bufferSeconds,receiveBufferBytes:this.receiveBufferBytes,droppedRtpFrames:this.droppedRtpFrames,waitingForOutputKeyframe:this.outputNeedsKey,resolution:'preserved',running:!!this.child};}
}
