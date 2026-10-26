import {h264ParseConfiguration} from '@yume-chan/scrcpy';

export function splitAnnexB(data:Uint8Array){
  const starts:{offset:number;prefix:number}[]=[];
  for(let i=0;i+2<data.length;i++){
    if(data[i]!==0||data[i+1]!==0)continue;
    const prefix=data[i+2]===1?3:data[i+2]===0&&data[i+3]===1?4:0;
    if(prefix){starts.push({offset:i,prefix});i+=prefix-1;}
  }
  if(!starts.length||data.subarray(0,starts[0]!.offset).some(n=>n!==0))throw new Error('Expected Annex B H.264');
  return starts.map((s,i)=>data.subarray(s.offset+s.prefix,starts[i+1]?.offset??data.length)).filter(n=>n.length>0);
}

export function avcConfiguration(data:Uint8Array){
  const parsed=h264ParseConfiguration(data),sps=parsed.sequenceParameterSet,pps=parsed.pictureParameterSet;
  if(sps.length>65535||pps.length>65535)throw new Error('H.264 configuration too large');
  const description=new Uint8Array(11+sps.length+pps.length),view=new DataView(description.buffer);
  description.set([1,parsed.profileIndex,parsed.constraintSet,parsed.levelIndex,255,225]);
  view.setUint16(6,sps.length);description.set(sps,8);description[8+sps.length]=1;
  view.setUint16(9+sps.length,pps.length);description.set(pps,11+sps.length);
  return {codec:'avc1.'+[parsed.profileIndex,parsed.constraintSet,parsed.levelIndex].map(n=>n.toString(16).padStart(2,'0')).join(''),
    description,width:parsed.croppedWidth,height:parsed.croppedHeight,codedWidth:parsed.encodedWidth,codedHeight:parsed.encodedHeight};
}

export function avcFrame(data:Uint8Array){
  const nalus=splitAnnexB(data),nalTypes=nalus.map(n=>n[0]!&31);
  if(nalus.some(n=>(n[0]!&128)!==0))throw new Error('Invalid H.264 NAL header');
  // SPS/PPS live in the AVC description, rather than being duplicated in every sample.
  const samples=nalus.filter(n=>![7,8].includes(n[0]!&31));
  const bytes=new Uint8Array(samples.reduce((size,n)=>size+4+n.length,0)),view=new DataView(bytes.buffer);let offset=0;
  for(const n of samples){view.setUint32(offset,n.length);bytes.set(n,offset+4);offset+=4+n.length;}
  return {data:bytes,nalTypes,hasIdr:nalTypes.includes(5),hasPicture:nalTypes.some(n=>n===1||n===5)};
}
