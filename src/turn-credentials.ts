import { randomUUID,createHmac,createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { ConsoleError } from './types.js';

export const TURN_TLS_URL='turns:turn.cloudflare.com:443?transport=tcp';
export interface IceServer {urls:string;username?:string;credential?:string}
export interface TurnConfig {provider:'none'|'cloudflare'|'coturn';mode:'all'|'relay';ttlSeconds:number;keyFile?:string;url?:string;serverUrl?:string;serverName?:string}
interface TurnKey {keyId?:string;apiToken?:string;secret?:string}
interface Credential {urls:string;username:string;credential:string}
interface Bundle {configId:string;expiresAt:number;browser:Credential;server:Credential}
interface Entry {signal:AbortSignal;abort:()=>void;controller:AbortController;bundle?:Bundle;pending?:Promise<Bundle>;retryAt:number}

export function turnConfig(env:NodeJS.ProcessEnv):TurnConfig {
  const provider=env.WEBRTC_TURN_PROVIDER||'none',mode=env.WEBRTC_ICE_MODE||(provider!=='none'?'relay':'all');
  if(provider!=='none'&&provider!=='cloudflare'&&provider!=='coturn')throw new Error('Invalid WEBRTC_TURN_PROVIDER');
  if(mode!=='all'&&mode!=='relay'||provider==='none'&&mode==='relay')throw new Error('Relay mode requires TURN');
  const ttlSeconds=Number(env.WEBRTC_TURN_TTL_SECONDS||14400);
  if(!Number.isInteger(ttlSeconds)||ttlSeconds<600||ttlSeconds>172800)throw new Error('WEBRTC_TURN_TTL_SECONDS must be 600-172800');
  if(provider==='cloudflare'&&!env.CF_TURN_KEY_FILE)throw new Error('Configure CF_TURN_KEY_FILE for Cloudflare TURN');
  if(provider==='coturn'){
    if(!env.COTURN_KEY_FILE)throw new Error('Configure COTURN_KEY_FILE');
    const url=env.COTURN_URL,serverUrl=env.COTURN_SERVER_URL||url;
    const parse=(value:string|undefined)=>{const match=/^turns:([A-Za-z0-9.-]+):(\d+)\?transport=tcp$/.exec(value||'');if(!match||Number(match[2])<1||Number(match[2])>65535)throw new Error('Coturn requires a TLS TURN URL and TCP transport');return match[1]!;};
    const serverName=parse(url);parse(serverUrl);
    return {provider,mode,ttlSeconds,keyFile:env.COTURN_KEY_FILE,url,serverUrl,serverName};
  }
  return {provider,mode,ttlSeconds,keyFile:env.CF_TURN_KEY_FILE};
}

export async function loadTurnKey(config:TurnConfig):Promise<TurnKey|undefined> {
  if(config.provider==='none')return;
  const info=await stat(config.keyFile!);
  if(!info.isFile()||info.size>4096||process.platform!=='win32'&&(info.mode&0o077)!==0)throw new Error('TURN key must be a private file (0600, max 4096 bytes)');
  let key:any;
  try{key=JSON.parse(await readFile(config.keyFile!,'utf8'));}catch{throw new Error('TURN key file must contain valid JSON');}
  if(config.provider==='coturn'){if(!key||typeof key.secret!=='string'||!/^[a-f0-9]{64}$/i.test(key.secret))throw new Error('Invalid coturn key file fields');return {secret:key.secret};}
  if(!key||!/^[a-f0-9]{32}$/i.test(key.keyId)||typeof key.apiToken!=='string'||!/^[A-Za-z0-9_-]{32,512}$/.test(key.apiToken))throw new Error('Invalid TURN key file fields');
  return {keyId:key.keyId,apiToken:key.apiToken};
}

function offline(){return new ConsoleError('PAGE_OFFLINE','页面已离线，视频协商已取消',409);}
function unavailable(){return new ConsoleError('TURN_UNAVAILABLE','中继配置暂不可用，请稍后重试',503);}

export class TurnCredentials {
  private entries=new Map<string,Entry>();
  constructor(readonly config:TurnConfig,private stunUrl:string,private key?:TurnKey,private request:typeof fetch=fetch,private now:()=>number=Date.now){
    if(config.provider!=='none'&&!key)throw new Error('Missing TURN key');
  }
  get tlsServerName(){return this.config.provider==='coturn'?this.config.serverName:'turn.cloudflare.com';}
  async prepare(owner:string,signal:AbortSignal){
    if(signal.aborted)throw offline();
    if(this.config.provider==='none')return {configId:'direct',expiresAt:null,iceServers:this.stunServers(),iceTransportPolicy:'all' as const};
    let entry=this.entries.get(owner);
    if(!entry){
      const controller=new AbortController();
      entry={signal,controller,abort:()=>this.release(owner),retryAt:0};this.entries.set(owner,entry);signal.addEventListener('abort',entry.abort,{once:true});
    }
    const current=entry;
    if(!current.bundle||current.bundle.expiresAt-this.now()<=300000){
      if(!current.pending){
        if(current.retryAt>this.now())throw unavailable();
        const started=this.now();
        current.pending=this.issueBundle(owner,current,started).then(bundle=>{
          if(current.controller.signal.aborted||this.entries.get(owner)!==current){void this.revokeBundle(bundle);throw offline();}
          const old=current.bundle;current.bundle=bundle;if(old)void this.revokeBundle(old);return bundle;
        }).catch(error=>{current.retryAt=this.now()+15000;throw error;}).finally(()=>{current.pending=undefined;});
      }
      await current.pending;
    }
    if(signal.aborted||this.entries.get(owner)!==current)throw offline();
    const bundle=current.bundle!;
    return {configId:bundle.configId,expiresAt:bundle.expiresAt,iceServers:this.servers(bundle.browser),iceTransportPolicy:this.config.mode};
  }
  server(owner:string,configId:string|undefined){
    if(this.config.provider==='none')return this.stunServers();
    const bundle=this.entries.get(owner)?.bundle;
    if(!bundle||bundle.configId!==configId||bundle.expiresAt-this.now()<30000)throw new ConsoleError('ICE_CONFIG_EXPIRED','视频配置已过期，请重新连接视频',409);
    return this.servers(bundle.server);
  }
  private stunServers():IceServer[]{return this.stunUrl?[{urls:this.stunUrl}]:[];}
  private servers(credential:Credential):IceServer[]{return this.config.mode==='relay'?[credential]:[...this.stunServers(),credential];}
  release(owner?:string){
    for(const [id,entry]of this.entries){if(owner&&id!==owner)continue;this.entries.delete(id);entry.signal.removeEventListener('abort',entry.abort);entry.controller.abort();if(entry.bundle)void this.revokeBundle(entry.bundle);}
  }
  private async issueBundle(owner:string,entry:Entry,started:number):Promise<Bundle>{
    if(this.config.provider==='coturn'){
      if(entry.controller.signal.aborted)throw offline();
      const expiresAt=started+this.config.ttlSeconds*1000;
      const credential=(role:string,url:string):Credential=>{const username=`${Math.floor(expiresAt/1000)}:${owner}:${role}:${randomUUID()}`;return {urls:url,username,credential:createHmac('sha1',this.key!.secret!).update(username).digest('base64')};};
      return {configId:randomUUID(),expiresAt,browser:credential('browser',this.config.url!),server:credential('sender',this.config.serverUrl!)};
    }
    const browser=await this.issue(owner,entry.controller.signal);
    try{const server=await this.issue(owner,entry.controller.signal);return {configId:randomUUID(),expiresAt:started+this.config.ttlSeconds*1000,browser,server};}
    catch(error){void this.revoke(browser);throw error;}
  }
  private async issue(owner:string,signal:AbortSignal):Promise<Credential>{
    try{
      const customIdentifier=/^[A-Za-z0-9_-]{1,64}$/.test(owner)?owner:createHash('sha256').update(owner).digest('hex').slice(0,32);
      const response=await this.request(`https://rtc.live.cloudflare.com/v1/turn/keys/${this.key!.keyId}/credentials/generate-ice-servers`,{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),headers:{Authorization:'Bearer '+this.key!.apiToken,'Content-Type':'application/json'},body:JSON.stringify({ttl:this.config.ttlSeconds,customIdentifier})});
      if(response.status!==201){await response.body?.cancel();throw unavailable();}
      const text=await limitedBody(response);let data:any;try{data=JSON.parse(text);}catch{throw unavailable();}
      const server=Array.isArray(data?.iceServers)?data.iceServers.find((s:any)=>(Array.isArray(s.urls)?s.urls:[s.urls]).includes(TURN_TLS_URL)):undefined;
      if(!server||typeof server.username!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(server.username)||typeof server.credential!=='string'||server.credential.length<1||server.credential.length>1024)throw unavailable();
      const credential={urls:TURN_TLS_URL,username:server.username,credential:server.credential};
      if(signal.aborted){void this.revoke(credential);throw offline();}
      return credential;
    }catch{if(signal.aborted)throw offline();throw unavailable();}
  }
  private async revoke(credential:Credential){
    // Coturn REST credentials expire by TTL; closing peers releases allocations.
    if(this.config.provider!=='cloudflare')return;
    try{const response=await this.request(`https://rtc.live.cloudflare.com/v1/turn/keys/${this.key!.keyId}/credentials/${encodeURIComponent(credential.username)}/revoke`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(3000),headers:{Authorization:'Bearer '+this.key!.apiToken}});await response.body?.cancel();}catch{}
  }
  private async revokeBundle(bundle:Bundle){await Promise.all([this.revoke(bundle.browser),this.revoke(bundle.server)]);}
}

async function limitedBody(response:Response){
  if(Number(response.headers.get('content-length'))>32768){await response.body?.cancel();throw unavailable();}
  const reader=response.body?.getReader();if(!reader)throw unavailable();const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768)throw unavailable();chunks.push(value);}return Buffer.concat(chunks).toString('utf8');}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
