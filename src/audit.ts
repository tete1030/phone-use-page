import {appendFile,mkdir,rename,stat} from 'node:fs/promises';
import {join} from 'node:path';
export interface AuditEntry {at:string;method:string;path:string;status:number;ip:string;client:string;owner?:string;user?:string;session?:string;requestId?:string;action?:string;target?:string;verification?:string}
export class Audit {
  private tail:Promise<unknown>=Promise.resolve();private entries:AuditEntry[]=[];
  constructor(private directory:string){}
  record(entry:AuditEntry){this.entries.push(entry);if(this.entries.length>2000)this.entries.shift();
    this.tail=this.tail.then(async()=>{await mkdir(this.directory,{recursive:true,mode:0o700});const file=join(this.directory,'requests.jsonl');
      if(await stat(file).then(s=>s.size>5_000_000).catch(()=>false))await rename(file,join(this.directory,'requests.previous.jsonl'));
      await appendFile(file,JSON.stringify(entry)+'\n',{mode:0o600});}).catch(error=>console.error('Audit write failed:',String(error)));
  }
  actions(owner:string){return this.entries.filter(e=>e.owner===owner&&['POST','EVENT'].includes(e.method)&&!/\/api\/(?:webrtc|video|activity|app-state|binding)/.test(e.path)).slice(-100);}
  async close(){await this.tail;}
}
