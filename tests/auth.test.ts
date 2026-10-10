import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {AuthStore,configuredPassword} from '../src/auth.js';
import {installAuth} from '../src/auth-http.js';
import {consolePath,normalizeBasePath,internalPath,permittedHost} from '../src/paths.js';
import {render,readAssetVersion} from '../src/ui.js';
import {Device} from '../src/device.js';

const password='test-only-unique-phone-password-2026';
async function fixture(options:{basePath?:string;secure?:boolean;trustProxy?:boolean;publicOrigin?:string;assetVersion?:string;onLogout?:(id:string)=>void}={}){
  const directory=await mkdtemp(join(tmpdir(),'phone-auth-test-')),store=new AuthStore({password,directory});await store.init();
  const app=Fastify({trustProxy:options.trustProxy?['127.0.0.1']:false});await app.register(cookie);
  const endpoint=(path:string)=>consolePath(options.basePath||'/',path);
  const auth=installAuth(app,store,{basePath:options.basePath,secure:!!options.secure,publicOrigin:options.publicOrigin,assetVersion:options.assetVersion,onLogout:s=>options.onLogout?.(s.id)});
  app.setErrorHandler((e:any,_req,reply)=>reply.code(e.status||500).send({error:{code:e.code||'ERROR',message:e.message}}));
  app.get(endpoint('/'),async(req,reply)=>{try{auth.authenticate(req);return {authenticated:true};}catch{return reply.type('text/html').send(auth.loginPage(reply));}});
  app.get(endpoint('/private'),async req=>({id:auth.authenticate(req).id}));
  app.get('/health',()=>({ok:true}));
  await app.ready();return {app,store,auth,directory,endpoint,close:async()=>{await app.close();await store.close();await rm(directory,{recursive:true,force:true});}};
}
async function login(f:Awaited<ReturnType<typeof fixture>>,opts:{remember?:boolean;secure?:boolean;password?:string;origin?:string}={}){
  const headers={'host':'localhost','origin':opts.origin||'http://localhost',...(opts.secure?{'x-forwarded-proto':'https'}:{})};
  const page=await f.app.inject({method:'GET',url:f.endpoint('/'),headers});
  const challenge=/name="loginToken" type="hidden" value="([a-f0-9]+)"/.exec(page.body)?.[1];
  const challengeCookie=page.cookies.find(c=>c.name.includes('login'));
  assert.ok(challenge);assert.ok(challengeCookie);
  return f.app.inject({method:'POST',url:f.endpoint('/api/login'),headers:{...headers,cookie:challengeCookie.name+'='+challengeCookie.value},payload:{password:opts.password??password,remember:opts.remember??true,loginToken:challenge}});
}

test('remembered login survives restart and storage never contains the raw cookie',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'phone-auth-persist-'));let now=Date.now();const first=new AuthStore({password,directory,now:()=>now});
  try{await first.init();const issued=await first.login(password,'test-peer',true);await first.close();const text=await readFile(join(directory,'sessions.json'),'utf8');assert.equal(text.includes(issued.token),false);assert.equal((await stat(directory)).mode&0o777,0o700);assert.equal((await stat(join(directory,'sessions.json'))).mode&0o777,0o600);
    const restarted=new AuthStore({password,directory,now:()=>now});await restarted.init();assert.equal(restarted.get(issued.token)?.id,issued.session.id);now+=91*86400000;assert.equal(restarted.get(issued.token),undefined);await restarted.close();
  }finally{await first.close();await rm(directory,{recursive:true,force:true});}
});
test('password rotation revokes remembered cookies',async()=>{const dir=await mkdtemp(join(tmpdir(),'phone-auth-rotate-'));const first=new AuthStore({password,directory:dir});try{await first.init();const s=await first.login(password,'a');await first.close();const next=new AuthStore({password:password+'-changed',directory:dir});await next.init();assert.equal(next.get(s.token),undefined);await assert.rejects(next.login(password,'b'),/密码不正确/);await next.close();}finally{await rm(dir,{recursive:true,force:true});}});
test('login failure is limited and does not create a session',async()=>{const f=await fixture();try{for(let i=0;i<8;i++)await assert.rejects(f.store.login('incorrect','peer'),/密码不正确/);await assert.rejects(f.store.login(password,'peer'),/尝试次数过多/);const data=JSON.parse(await readFile(join(f.directory,'sessions.json'),'utf8'));assert.equal(data.sessions.length,0);}finally{await f.close();}});
test('login page exposes no device data and unknown tokens cannot authenticate',async()=>{const f=await fixture();try{const page=await f.app.inject('/');assert.match(page.body,/访问密码/);assert.equal(page.body.includes('console-bootstrap'),false);const denied=await f.app.inject({url:'/private',headers:{cookie:f.auth.cookieName+'='+'a'.repeat(43)}});assert.equal(denied.statusCode,401);}finally{await f.close();}});
test('same-origin session discovery restores Strict-cookie visits without revealing device data',async()=>{const f=await fixture();try{assert.deepEqual((await f.app.inject('/api/auth/status')).json(),{authenticated:false});const logged=await login(f),c=logged.cookies.find(c=>c.name===f.auth.cookieName)!;const status=await f.app.inject({url:'/api/auth/status',headers:{cookie:c.name+'='+c.value}});assert.deepEqual(status.json(),{authenticated:true});}finally{await f.close();}});
test('login enforces challenge and origin before password verification',async()=>{const f=await fixture();try{const missing=await f.app.inject({method:'POST',url:'/api/login',headers:{origin:'http://localhost'},payload:{password}});assert.equal(missing.statusCode,403);assert.equal(missing.json().error.code,'LOGIN_CSRF');const foreign=await login(f,{origin:'https://foreign.example'});assert.equal(foreign.statusCode,403);assert.equal(foreign.json().error.code,'ORIGIN_REJECTED');}finally{await f.close();}});
test('persistent cookies are HttpOnly and Strict, and logout needs CSRF and revokes them',async()=>{let revoked='';const f=await fixture({onLogout:id=>{revoked=id;}});try{const logged=await login(f);assert.equal(logged.statusCode,200);const c=logged.cookies.find(c=>c.name===f.auth.cookieName)!;assert.equal(c.httpOnly,true);assert.equal(c.sameSite,'Strict');assert.equal(c.maxAge,90*86400);const headers={origin:'http://localhost',cookie:c.name+'='+c.value};const s=f.store.get(c.value)!;
    const rejected=await f.app.inject({method:'POST',url:'/api/logout',headers});assert.equal(rejected.statusCode,403);assert.ok(f.store.get(c.value));
    const logout=await f.app.inject({method:'POST',url:'/api/logout',headers:{...headers,'x-console-csrf':s.csrf}});assert.equal(logout.statusCode,200);assert.equal(revoked,s.id);assert.equal(f.store.get(c.value),undefined);assert.equal(logout.cookies.find(c=>c.name===f.auth.cookieName)?.maxAge,0);
  }finally{await f.close();}});
test('session-only login has no persistent Max-Age and expires after eight hours',async()=>{const f=await fixture();try{const logged=await login(f,{remember:false});const c=logged.cookies.find(c=>c.name===f.auth.cookieName)!;assert.equal(c.maxAge,undefined);const s=f.store.get(c.value)!;assert.equal(s.expires-s.createdAt,8*3600000);}finally{await f.close();}});
test('production cookies require TLS from an explicitly trusted proxy',async()=>{const f=await fixture({secure:true,trustProxy:true,publicOrigin:'https://localhost'});try{const http=await f.app.inject('/');assert.equal(http.statusCode,403);const logged=await login(f,{secure:true,origin:'https://localhost'});assert.equal(logged.statusCode,200);const c=logged.cookies.find(c=>c.name===f.auth.cookieName)!;assert.equal(c.secure,true);assert.ok(c.name.startsWith('__Secure-'));assert.equal((await f.app.inject('/health')).statusCode,200);}finally{await f.close();}
  const untrusted=await fixture({secure:true});try{assert.equal((await untrusted.app.inject({url:f.endpoint('/'),headers:{'x-forwarded-proto':'https'}})).statusCode,403);}finally{await untrusted.close();}
});
test('missing, weak, and conflicting password configuration fails closed',async()=>{await assert.rejects(configuredPassword({}),/Configure CONSOLE_PASSWORD/);await assert.rejects(configuredPassword({CONSOLE_PASSWORD:password,CONSOLE_PASSWORD_FILE:'/unused'}),/Set only/);assert.throws(()=>new AuthStore({password:'weak',directory:'/unused'}),/12–512/);});

test('a configured 13-character password authenticates through scrypt',async()=>{const directory=await mkdtemp(join(tmpdir(),'phone-auth-fixed-')),fixed='fixture-12345';const store=new AuthStore({password:fixed,directory});try{await store.init();const result=await store.login(fixed,'peer');assert.ok(store.get(result.token));await assert.rejects(store.login(fixed+'x','other-peer'),/密码不正确/);}finally{await store.close();await rm(directory,{recursive:true,force:true});}});

test('HTTPS subpath login uses scoped Secure cookies, assets and logout routes',async()=>{const f=await fixture({basePath:'/phone/',secure:true,trustProxy:true,publicOrigin:'https://localhost'});try{
  const page=await f.app.inject({url:'/phone/',headers:{host:'localhost','x-forwarded-proto':'https'}});assert.equal(page.statusCode,200);assert.ok(page.body.includes('data-console-base="/phone/"'));assert.ok(page.body.includes('/phone/assets/client.js'));assert.ok(page.body.includes('/phone/assets/style.css'));assert.equal(page.cookies[0]!.path,'/phone/');
  const logged=await login(f,{secure:true,origin:'https://localhost'});assert.equal(logged.statusCode,200);const c=logged.cookies.find(c=>c.name===f.auth.cookieName)!;assert.equal(c.path,'/phone/');assert.equal(c.secure,true);assert.equal(c.httpOnly,true);const header={host:'localhost','x-forwarded-proto':'https',origin:'https://localhost',cookie:c.name+'='+c.value};
  const status=await f.app.inject({url:'/phone/api/auth/status',headers:header});assert.equal(status.json().authenticated,true);const s=f.store.get(c.value)!;const out=await f.app.inject({method:'POST',url:'/phone/api/logout',headers:{...header,'x-console-csrf':s.csrf},payload:{}});assert.equal(out.statusCode,200);assert.equal(out.cookies.find(x=>x.name===f.auth.cookieName)?.path,'/phone/');assert.equal(f.store.get(c.value),undefined);
  assert.equal((await f.app.inject({url:'/phone/',headers:{host:'localhost','x-forwarded-proto':'http'}})).statusCode,403);
  assert.equal((await f.app.inject({url:'/api/auth/status',headers:header})).statusCode,404);
}finally{await f.close();}});
test('base paths isolate routes and reject ambiguous URL components',()=>{assert.equal(consolePath('/phone/','/ws/events?x=1'),'/phone/ws/events?x=1');assert.equal(internalPath('/phone/api/logout?x=1','/phone/'),'/api/logout');assert.equal(internalPath('/phone-other/api/logout','/phone/'),'/phone-other/api/logout');for(const value of ['phone/','/phone','//phone/','/../','/phone%2f/','/phone/?q=1'])assert.throws(()=>normalizeBasePath(value));assert.throws(()=>consolePath('/phone/','//evil.example'));
  assert.equal(permittedHost('home.example.com','https://home.example.com:3443'),true);assert.equal(permittedHost('home.example.com:3443','https://home.example.com:3443'),true);assert.equal(permittedHost('home.example.com:9999','https://home.example.com:3443'),false);assert.equal(permittedHost('evil.example','https://home.example.com:3443'),false);
});

test('login and console HTML use the same versioned resources under a subpath',async()=>{
  const version=await readAssetVersion();assert.match(version,/^[a-f0-9]{16}$/);
  const f=await fixture({basePath:'/phone/',assetVersion:version});
  try{
    const loginHtml=(await f.app.inject('/phone/')).body;
    const device=new Device('fixture','unused','unused');
    const consoleHtml=await render(device.state,{basePath:'/phone/',assetVersion:version,tasks:[],sdk:'fixture'});
    for(const html of [loginHtml,consoleHtml])for(const resource of ['client.js','style.css'])assert.ok(html.includes('/phone/assets/'+resource+'?v='+version));
    assert.equal((await f.app.inject('/api/auth/status')).statusCode,404);
  }finally{await f.close();}
});
test('a changed release version changes resource URLs without changing the base path',async()=>{
  const device=new Device('fixture','unused','unused');
  const html=(version:string)=>render(device.state,{basePath:'/',assetVersion:version,tasks:[],sdk:'fixture'});
  const before=await html('0123456789abcdef'),after=await html('fedcba9876543210');
  assert.ok(before.includes('/assets/client.js?v=0123456789abcdef'));assert.ok(after.includes('/assets/client.js?v=fedcba9876543210'));assert.ok(!after.includes('/assets/client.js?v=0123456789abcdef'));
});
