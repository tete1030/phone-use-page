import { RtpHeader, RtpPacket } from 'werift';
import { randomBytes } from 'node:crypto';

export function annexBNalus(data:Uint8Array):Buffer[] {
  const bytes=Buffer.from(data.buffer,data.byteOffset,data.byteLength),starts:{offset:number;length:number}[]=[];
  for(let i=0;i+2<bytes.length;i++)if(bytes[i]===0&&bytes[i+1]===0){
    const length=bytes[i+2]===1?3:bytes[i+2]===0&&bytes[i+3]===1?4:0;
    if(length){starts.push({offset:i,length});i+=length-1;}
  }
  if(!starts.length)throw new Error('Expected Annex B H.264 stream');
  return starts.map((s,i)=>bytes.subarray(s.offset+s.length,starts[i+1]?.offset??bytes.length)).filter(n=>n.length>0);
}

// RFC 6184: one access unit shares a 90 kHz timestamp; only its last packet has M=1.
export class H264Packetizer {
  private sequence=randomBytes(2).readUInt16BE();
  private baseTimestamp=randomBytes(4).readUInt32BE();
  private firstPts?:bigint;
  constructor(readonly ssrc:number,readonly payloadType=96,readonly mtu=1100){}
  packets(nalus:Buffer[],pts:bigint){
    this.firstPts??=pts;
    const timestamp=Number((BigInt(this.baseTimestamp)+(pts-this.firstPts)*90n/1000n)&0xffffffffn);
    const payloads:Buffer[]=[];
    for(const nal of nalus){
      if(nal.length<=this.mtu){payloads.push(nal);continue;}
      const indicator=(nal[0]!&0xe0)|28,type=nal[0]!&0x1f;
      for(let offset=1;offset<nal.length;offset+=this.mtu-2){
        const end=Math.min(offset+this.mtu-2,nal.length);
        payloads.push(Buffer.concat([Buffer.from([indicator,type|(offset===1?0x80:0)|(end===nal.length?0x40:0)]),nal.subarray(offset,end)]));
      }
    }
    return payloads.map((payload,index)=>new RtpPacket(new RtpHeader({ssrc:this.ssrc,payloadType:this.payloadType,sequenceNumber:this.sequence++&0xffff,timestamp,marker:index===payloads.length-1}),payload));
  }
}
