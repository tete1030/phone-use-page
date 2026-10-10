import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConsoleError } from './types.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export interface AuthSession {id:string;csrf:string;createdAt:number;expires:number}
interface StoredAuth {version:1;salt:string;passwordHash:string;sessions:AuthSession[]}
export interface AuthOptions {password:string;directory:string;rememberDays?:number;now?:()=>number}

export class AuthStore {
  private sessions=new Map<string,AuthSession>();private salt='';private passwordHash='';
  private writes:Promise<void>=Promise.resolve();private verifying=0;private now:()=>number;
  private attempts=new Map<string,{count:number;until:number}>();
  readonly rememberSeconds:number;
  constructor(private options:AuthOptions){
    if(options.password.length<12||options.password.length>512)throw new Error('CONSOLE_PASSWORD must contain 12–512 characters; use a strong, unique password');
    const days=options.rememberDays??90;if(!Number.isInteger(days)||days<1||days>180)throw new Error('AUTH_REMEMBER_DAYS must be between 1 and 180');
    this.rememberSeconds=days*86400;this.now=options.now??Date.now;
  }
  private verifier(password:string,salt=this.salt){return new Promise<string>((resolve,reject)=>scrypt(password,Buffer.from(salt,'hex'),64,{N:32768,r:8,p:3,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key.toString('hex'))));}
  async init(){
    await mkdir(this.options.directory,{recursive:true,mode:0o700});await chmod(this.options.directory,0o700);
    let stored:StoredAuth|undefined;
    try{const raw=await readFile(resolve(this.options.directory,'sessions.json'),'utf8');stored=JSON.parse(raw);
      if(!stored||stored.version!==1||!/^[a-f0-9]{32}$/.test(stored.salt)||!/^[a-f0-9]{128}$/.test(stored.passwordHash)||!Array.isArray(stored.sessions))throw new Error('invalid auth state');
    }catch(error:any){if(error.code!=='ENOENT')throw new Error('Cannot load authentication state; inspect private auth storage');}
    this.salt=stored?.salt??randomBytes(16).toString('hex');this.passwordHash=await this.verifier(this.options.password);
    if(stored&&timingSafeEqual(Buffer.from(stored.passwordHash,'hex'),Buffer.from(this.passwordHash,'hex'))){
      for(const s of stored.sessions){if(!s||!/^[a-f0-9]{64}$/.test(s.id)||!/^[a-f0-9]{64}$/.test(s.csrf)||!Number.isSafeInteger(s.createdAt)||!Number.isSafeInteger(s.expires))throw new Error('Invalid authentication session record');
        if(s.expires>this.now()&&s.createdAt<=this.now()+60000)this.sessions.set(s.id,s);}
    }else if(stored){this.salt=randomBytes(16).toString('hex');this.passwordHash=await this.verifier(this.options.password);}
    await this.save();
  }
  private save(){
    const text=JSON.stringify({version:1,salt:this.salt,passwordHash:this.passwordHash,sessions:[...this.sessions.values()]} satisfies StoredAuth);
    const path=resolve(this.options.directory,'sessions.json');
    const next=this.writes.catch(()=>{}).then(async()=>{const file=await open(path+'.tmp','w',0o600);try{await file.chmod(0o600);await file.writeFile(text);await file.sync();}finally{await file.close();}await rename(path+'.tmp',path);await chmod(path,0o600);});
    this.writes=next;return next;
  }
  get(token:string|undefined){if(!token||!(/^[A-Za-z0-9_-]{43}$/).test(token))return undefined;return this.getById(hash(token));}
  getById(id:string){const s=this.sessions.get(id);if(!s)return undefined;if(s.expires<=this.now()){this.sessions.delete(id);void this.save().catch(()=>{});return undefined;}return s;}
  checkCsrf(session:AuthSession,token:unknown){if(typeof token!=='string'||!(/^[a-f0-9]{64}$/).test(token)||!timingSafeEqual(Buffer.from(session.csrf,'hex'),Buffer.from(token,'hex')))throw new ConsoleError('CSRF_REJECTED','请求已失效，请刷新页面',403);}
  private takeAttempt(ip:string){const now=this.now();let a=this.attempts.get(ip);if(!a||a.until<=now){a={count:0,until:now+600000};this.attempts.set(ip,a);}if(a.count>=8)throw new ConsoleError('LOGIN_RATE_LIMIT','尝试次数过多，请稍后再试',429);a.count++;
    if(this.attempts.size>10000)for(const [key,value]of this.attempts)if(value.until<=now)this.attempts.delete(key);
  }
  async login(password:string,ip:string,remember=true){
    this.takeAttempt(ip);if(this.verifying>=2)throw new ConsoleError('LOGIN_BUSY','登录验证繁忙，请稍后重试',429);
    if(typeof password!=='string'||password.length>512)throw new ConsoleError('LOGIN_FAILED','密码不正确',401);
    this.verifying++;let actual:string;try{actual=await this.verifier(password);}finally{this.verifying--;}
    if(!timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(this.passwordHash,'hex')))throw new ConsoleError('LOGIN_FAILED','密码不正确',401);
    this.attempts.delete(ip);for(const [id,s]of this.sessions)if(s.expires<=this.now())this.sessions.delete(id);
    if(this.sessions.size>=256)throw new ConsoleError('SESSION_LIMIT','登录设备数量达到上限，请先退出其他设备',429);
    const token=randomBytes(32).toString('base64url'),seconds=remember?this.rememberSeconds:8*3600;
    const session={id:hash(token),csrf:randomBytes(32).toString('hex'),createdAt:this.now(),expires:this.now()+seconds*1000};this.sessions.set(session.id,session);
    try{await this.save();}catch(error){this.sessions.delete(session.id);throw error;}return {token,session,seconds};
  }
  async revoke(id:string){this.sessions.delete(id);await this.save();}
  async close(){await this.writes;}
}

export async function configuredPassword(env:NodeJS.ProcessEnv){
  if(env.CONSOLE_PASSWORD&&env.CONSOLE_PASSWORD_FILE)throw new Error('Set only CONSOLE_PASSWORD or CONSOLE_PASSWORD_FILE');
  if(env.CONSOLE_PASSWORD_FILE){const info=await stat(env.CONSOLE_PASSWORD_FILE);if(info.mode&0o077)throw new Error('CONSOLE_PASSWORD_FILE must be private (chmod 600)');const content=await readFile(env.CONSOLE_PASSWORD_FILE,'utf8');return content.replace(/\r?\n$/,'');}
  if(!env.CONSOLE_PASSWORD)throw new Error('Configure CONSOLE_PASSWORD or CONSOLE_PASSWORD_FILE before starting the console');
  return env.CONSOLE_PASSWORD;
}
