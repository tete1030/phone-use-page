export interface IceAddress {type:string;protocol:string;address:string;port:number}
interface IceServerSecrets {urls:string|string[];username?:string;credential?:string}
export function iceCandidateFailure(event:any,servers:IceServerSecrets[]){
  const urls=servers.flatMap(s=>typeof s.urls==='string'?[s.urls]:s.urls);
  let message=String(event.errorText||'');
  for(const server of servers)for(const secret of [server.username,server.credential])if(secret)message=message.replaceAll(secret,'[redacted]');
  return {url:urls.includes(event.url)?event.url:'',errorCode:Number.isInteger(event.errorCode)?event.errorCode:0,errorText:message.slice(0,320),address:typeof event.address==='string'?event.address.slice(0,80):null,port:Number.isInteger(event.port)&&event.port>=0&&event.port<=65535?event.port:null};
}
export function sdpCandidates(sdp:string):IceAddress[]{
  return [...sdp.matchAll(/^a=candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (host|srflx|prflx|relay)(?:\s|$)/gm)]
    .map(m=>({type:m[4]!,protocol:m[1]!.toLowerCase(),address:m[2]!,port:Number(m[3])}));
}
export function candidateStats(value:any){
  return value?{type:value.candidateType,protocol:value.protocol,address:value.address||value.ip||'',port:value.port,...(value.relayProtocol?{relayProtocol:value.relayProtocol}:{})}:null;
}
export function selectedIcePair(stats:Pick<Map<string,any>,'get'|'values'>){
  const transport=[...stats.values()].find(s=>s.type==='transport'&&s.selectedCandidatePairId);
  const pair=transport?stats.get(transport.selectedCandidatePairId):[...stats.values()].find(s=>s.type==='candidate-pair'&&s.nominated&&s.state==='succeeded');
  if(!pair)return null;
  return {state:pair.state,local:candidateStats(stats.get(pair.localCandidateId)),remote:candidateStats(stats.get(pair.remoteCandidateId)),roundTripMs:pair.currentRoundTripTime===undefined?null:Math.round(pair.currentRoundTripTime*1000)};
}
