import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ConsoleError } from './types.js';

export class Bridge {
  private child?: ChildProcessWithoutNullStreams;
  private calls = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; child:ChildProcessWithoutNullStreams }>();
  private sequence = 0;
  private tail:Promise<unknown>=Promise.resolve();private closed=false;
  constructor(private serial: string, private python: string, private adb: string,private worker='bridge/worker.py') {}
  private start() {
    if (this.child) return;
    const child = spawn(this.python, ['-u', this.worker, this.serial], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, ADBUTILS_ADB_PATH: this.adb, PYTHONUNBUFFERED: '1', CONSOLE_AWAKE_STATE:process.env.CONSOLE_AWAKE_STATE||'.local/awake-state.json' },
    });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', line => {
      let data: any; try { data = JSON.parse(line); } catch { return; }
      const call = this.calls.get(data.id); if (!call) return;
      clearTimeout(call.timer); this.calls.delete(data.id);
      if (data.ok) call.resolve(data.result); else call.reject(new ConsoleError(data.code||'BRIDGE_ERROR', data.error, data.status||503));
    });
    child.stderr.on('data', bytes => process.stderr.write('[uiautomator] ' + bytes));
    child.on('exit', () => {
      if(this.child===child)this.child = undefined;
      this.rejectChild(child,new ConsoleError('BRIDGE_EXIT', 'UI bridge stopped', 503));
    });
    child.on('error', error => {if(this.child===child)this.child=undefined;this.rejectChild(child,error);});
  }
  private rejectChild(child:ChildProcessWithoutNullStreams,error:Error){for(const [id,call]of this.calls)if(call.child===child){clearTimeout(call.timer);this.calls.delete(id);call.reject(error);}}
  call<T = any>(method: string, params: unknown = {}, timeout = 15000,beforeSend?:()=>void): Promise<T> {
    // The Python worker is serial: queued requests must not consume their deadline.
    const work=this.tail.then(()=>{if(this.closed)throw new ConsoleError('BRIDGE_CLOSED','UI bridge closed',503);beforeSend?.();return this.send<T>(method,params,timeout);});
    this.tail=work.catch(()=>{});return work;
  }
  private send<T>(method:string,params:unknown,timeout:number):Promise<T> {
    this.start(); const id = ++this.sequence,child=this.child!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.calls.delete(id);if(this.child===child)this.child=undefined;child.kill();reject(new ConsoleError('BRIDGE_TIMEOUT','UI bridge did not respond',504));}, timeout);
      this.calls.set(id, { resolve, reject, timer,child });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  close() {this.closed=true;const child=this.child;this.child=undefined;if(child){this.rejectChild(child,new ConsoleError('BRIDGE_CLOSED','UI bridge closed',503));child.kill();}}
}
